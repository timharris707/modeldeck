#!/usr/bin/env node
/**
 * Migrate a ModelDeck SQLite database into the persistent location using
 * SQLite backup semantics (VACUUM INTO — never a plain file copy of a live
 * WAL database).
 *
 * Usage:
 *   node scripts/migrate-db.mjs --source <path> [--target <path>] [--force] [--strip-prefix <path>]
 *
 * Defaults:
 *   --target        ~/Library/Application Support/ModelDeck/modeldeck.sqlite
 *                   (or $MODELDECK_DB_PATH)
 *   --strip-prefix  /tmp/modeldeck-identity-stage
 *                   (staging project mappings must not migrate; repeatable)
 *
 * Behavior:
 *   - Copies via `VACUUM INTO` so WAL state is captured consistently.
 *   - Strips project rows whose path is at/under any strip prefix, and clears
 *     launch-event references to them (accounts + usage history are preserved).
 *   - Verifies `PRAGMA integrity_check` and row counts before installing.
 *   - Refuses to overwrite an existing target unless --force is given.
 *   - Target directory is created 0700; the database file is chmod 0600.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_STRIP_PREFIX = '/tmp/modeldeck-identity-stage';

function defaultTarget() {
  return process.env.MODELDECK_DB_PATH
    || path.join(os.homedir(), 'Library', 'Application Support', 'ModelDeck', 'modeldeck.sqlite');
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

function underPrefix(rowPath, prefix) {
  return rowPath === prefix || rowPath.startsWith(`${prefix}${path.sep}`);
}

export function migrateDatabase({
  source,
  target = defaultTarget(),
  force = false,
  stripPrefixes = [DEFAULT_STRIP_PREFIX],
  log = () => {},
} = {}) {
  if (!source) throw new Error('source database path is required (--source)');
  source = path.resolve(source);
  target = path.resolve(target);
  if (!fs.existsSync(source)) throw new Error(`source database does not exist: ${source}`);
  if (source === target) throw new Error('source and target are the same file');
  if (fs.existsSync(target) && !force) {
    throw new Error(`target already exists: ${target} (pass --force to overwrite)`);
  }

  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(targetDir, 0o700);

  const staging = path.join(targetDir, `.migrate-${process.pid}-${Date.now()}.sqlite`);
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  let sourceCounts;
  let stagingProjects;
  try {
    sourceCounts = {
      accounts: count(sourceDb, 'accounts'),
      projects: count(sourceDb, 'projects'),
      usage_snapshots: count(sourceDb, 'usage_snapshots'),
      launch_events: count(sourceDb, 'launch_events'),
    };
    stagingProjects = sourceDb.prepare('SELECT id, path FROM projects').all()
      .filter((row) => stripPrefixes.some((prefix) => underPrefix(row.path, prefix)));
    // SQLite backup semantics: VACUUM INTO writes a consistent snapshot even
    // while the source is a live WAL database.
    sourceDb.prepare('VACUUM INTO ?').run(staging);
  } finally {
    sourceDb.close();
  }

  try {
    const db = new DatabaseSync(staging);
    let installed = false;
    try {
      // Set WAL before preparing any statements (an exclusive lock is needed).
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      const strip = db.prepare('DELETE FROM projects WHERE id = ?');
      const clearLaunch = db.prepare('UPDATE launch_events SET project_id = NULL WHERE project_id = ?');
      for (const row of stagingProjects) {
        clearLaunch.run(row.id);
        strip.run(row.id);
      }

      const integrity = db.prepare('PRAGMA integrity_check').get();
      const verdict = String(Object.values(integrity)[0]);
      if (verdict !== 'ok') throw new Error(`integrity_check failed: ${verdict}`);

      const migratedCounts = {
        accounts: count(db, 'accounts'),
        projects: count(db, 'projects'),
        usage_snapshots: count(db, 'usage_snapshots'),
        launch_events: count(db, 'launch_events'),
      };
      for (const table of ['accounts', 'usage_snapshots', 'launch_events']) {
        if (migratedCounts[table] !== sourceCounts[table]) {
          throw new Error(`row count mismatch in ${table}: source ${sourceCounts[table]} vs migrated ${migratedCounts[table]}`);
        }
      }
      const expectedProjects = sourceCounts.projects - stagingProjects.length;
      if (migratedCounts.projects !== expectedProjects) {
        throw new Error(`row count mismatch in projects: expected ${expectedProjects}, got ${migratedCounts.projects}`);
      }
      const leftover = db.prepare('SELECT path FROM projects').all()
        .filter((row) => stripPrefixes.some((prefix) => underPrefix(row.path, prefix)));
      if (leftover.length) throw new Error('staging project mappings survived the strip step');

      const summary = {
        source,
        target,
        counts: migratedCounts,
        strippedProjects: stagingProjects.length,
        integrity: 'ok',
      };
      db.close();

      // Fold WAL frames back into the main file, then install atomically.
      const finalize = new DatabaseSync(staging);
      finalize.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      finalize.close();

      fs.chmodSync(staging, 0o600);
      fs.renameSync(staging, target);
      fs.chmodSync(target, 0o600);
      installed = true;

      log(summary);
      return summary;
    } finally {
      if (!installed) {
        try { db.close(); } catch { /* already closed */ }
      }
    }
  } finally {
    fs.rmSync(staging, { force: true });
    fs.rmSync(`${staging}-wal`, { force: true });
    fs.rmSync(`${staging}-shm`, { force: true });
  }
}

function parseArgs(argv) {
  const options = { stripPrefixes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') options.source = argv[++i];
    else if (arg === '--target') options.target = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--strip-prefix') options.stripPrefixes.push(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.stripPrefixes.length) options.stripPrefixes = [DEFAULT_STRIP_PREFIX];
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const summary = migrateDatabase({ ...parseArgs(process.argv.slice(2)), log: () => {} });
    console.log(`Migrated ${summary.source}`);
    console.log(`      -> ${summary.target}`);
    console.log(`Rows: accounts=${summary.counts.accounts} projects=${summary.counts.projects} usage=${summary.counts.usage_snapshots} launches=${summary.counts.launch_events}`);
    console.log(`Stripped staging project mappings: ${summary.strippedProjects}`);
    console.log('Integrity: ok');
  } catch (error) {
    console.error(`migrate-db: ${error.message}`);
    process.exit(1);
  }
}
