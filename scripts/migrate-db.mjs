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
 *   - Collapses proven legacy `agent-<canonical>` transcript subagent aliases
 *     and rekeys their request rows without changing the source database.
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

const COUNT_QUERIES = {
  accounts: 'SELECT COUNT(*) AS n FROM accounts',
  projects: 'SELECT COUNT(*) AS n FROM projects',
  usage_snapshots: 'SELECT COUNT(*) AS n FROM usage_snapshots',
  launch_events: 'SELECT COUNT(*) AS n FROM launch_events',
  transcript_subagents: 'SELECT COUNT(*) AS n FROM transcript_subagents',
  transcript_requests: 'SELECT COUNT(*) AS n FROM transcript_requests',
};

function count(db, table) {
  const sql = COUNT_QUERIES[table];
  if (!sql) throw new Error(`invalid table name: ${table}`);
  return Number(db.prepare(sql).get().n);
}

function hasTable(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

const SUBAGENT_DATA_FIELDS = [
  'agent_type',
  'resolved_model',
  'total_tokens',
  'tool_stats_json',
  'duration_ms',
  'observed_at',
];

function populatedSubagentFields(row) {
  return SUBAGENT_DATA_FIELDS.reduce(
    (total, field) => total + (row[field] == null ? 0 : 1),
    0,
  );
}

function mergeSubagentRows(canonical, legacy) {
  // Keep conflicting values together from the richer source row. Fill only
  // its gaps from the other row so non-conflicting stored data is not lost.
  // agent_type is the only stored label material: invocation descriptions
  // and prompts stay in source JSONL and cannot be reconstructed here.
  const preferred = populatedSubagentFields(legacy) > populatedSubagentFields(canonical)
    ? legacy
    : canonical;
  const fallback = preferred === canonical ? legacy : canonical;
  return Object.fromEntries(SUBAGENT_DATA_FIELDS.map((field) => [
    field,
    preferred[field] ?? fallback[field],
  ]));
}

function backfillLegacyPrefixedSubagents(db) {
  if (!hasTable(db, 'transcript_subagents')) {
    return {
      rowsDeduplicated: 0,
      requestsRekeyed: 0,
      labelsFilled: 0,
      remainingNullLabels: 0,
    };
  }

  // A leading "agent-" is not enough evidence by itself: older transcripts
  // can legitimately lack record.agentId. Only rekey when the unprefixed ID
  // already exists in the same session/profile, proving the legacy alias.
  const aliases = db.prepare(`
    SELECT legacy.agent_id AS legacy_agent_id,
           canonical.agent_id AS canonical_agent_id,
           legacy.session_id AS session_id,
           legacy.profile_slug AS profile_slug
    FROM transcript_subagents legacy
    JOIN transcript_subagents canonical
      ON canonical.agent_id = substr(legacy.agent_id, 7)
     AND canonical.session_id = legacy.session_id
     AND canonical.profile_slug = legacy.profile_slug
    WHERE substr(legacy.agent_id, 1, 6) = 'agent-'
    ORDER BY length(legacy.agent_id) DESC,
             legacy.profile_slug, legacy.session_id, legacy.agent_id
  `).all();
  const beforeRows = count(db, 'transcript_subagents');
  const hasRequests = hasTable(db, 'transcript_requests');
  const beforeRequests = hasRequests ? count(db, 'transcript_requests') : 0;
  const readRow = db.prepare(`
    SELECT * FROM transcript_subagents
    WHERE agent_id = ? AND session_id = ? AND profile_slug = ?
  `);
  const updateCanonical = db.prepare(`
    UPDATE transcript_subagents SET
      agent_type = ?,
      resolved_model = ?,
      total_tokens = ?,
      tool_stats_json = ?,
      duration_ms = ?,
      observed_at = ?
    WHERE agent_id = ? AND session_id = ? AND profile_slug = ?
  `);
  const rekeyRequests = hasRequests ? db.prepare(`
    UPDATE transcript_requests SET agent_id = ?
    WHERE agent_id = ? AND session_id = ? AND profile_slug = ?
  `) : null;
  const deleteLegacy = db.prepare(`
    DELETE FROM transcript_subagents
    WHERE agent_id = ? AND session_id = ? AND profile_slug = ?
  `);
  let requestsRekeyed = 0;
  let labelsFilled = 0;
  let rowsDeduplicated = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const alias of aliases) {
      const canonical = readRow.get(
        alias.canonical_agent_id,
        alias.session_id,
        alias.profile_slug,
      );
      const legacy = readRow.get(
        alias.legacy_agent_id,
        alias.session_id,
        alias.profile_slug,
      );
      if (!canonical || !legacy) continue;

      const merged = mergeSubagentRows(canonical, legacy);
      if (canonical.agent_type == null && merged.agent_type != null) labelsFilled += 1;
      updateCanonical.run(
        merged.agent_type,
        merged.resolved_model,
        merged.total_tokens,
        merged.tool_stats_json,
        merged.duration_ms,
        merged.observed_at,
        alias.canonical_agent_id,
        alias.session_id,
        alias.profile_slug,
      );
      if (rekeyRequests) {
        requestsRekeyed += Number(rekeyRequests.run(
          alias.canonical_agent_id,
          alias.legacy_agent_id,
          alias.session_id,
          alias.profile_slug,
        ).changes);
      }
      rowsDeduplicated += Number(deleteLegacy.run(
        alias.legacy_agent_id,
        alias.session_id,
        alias.profile_slug,
      ).changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const afterRows = count(db, 'transcript_subagents');
  if (afterRows !== beforeRows - rowsDeduplicated) {
    throw new Error(`legacy subagent row count mismatch: expected ${beforeRows - rowsDeduplicated}, got ${afterRows}`);
  }
  if (hasRequests && count(db, 'transcript_requests') !== beforeRequests) {
    throw new Error('legacy subagent cleanup changed the transcript request row count');
  }
  return {
    rowsDeduplicated,
    requestsRekeyed,
    labelsFilled,
    remainingNullLabels: Number(db.prepare(`
      SELECT COUNT(*) AS n FROM transcript_subagents WHERE agent_type IS NULL
    `).get().n),
  };
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
      const subagentBackfill = backfillLegacyPrefixedSubagents(db);
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
        subagentBackfill,
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
    console.log(`Legacy subagents: deduped=${summary.subagentBackfill.rowsDeduplicated} requests_rekeyed=${summary.subagentBackfill.requestsRekeyed} labels_filled=${summary.subagentBackfill.labelsFilled} remaining_null_labels=${summary.subagentBackfill.remainingNullLabels}`);
    console.log('Integrity: ok');
  } catch (error) {
    console.error(`migrate-db: ${error.message}`);
    process.exit(1);
  }
}
