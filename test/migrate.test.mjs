import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';
import { migrateDatabase } from '../scripts/migrate-db.mjs';

function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-migrate-')));
  const stageRoot = path.join(root, 'modeldeck-identity-stage');
  const stageProject = path.join(stageRoot, 'projects', 'staging-app');
  const realProject = path.join(root, 'projects', 'real-app');
  fs.mkdirSync(stageProject, { recursive: true });
  fs.mkdirSync(realProject, { recursive: true });

  const sourcePath = path.join(root, 'source.sqlite');
  const store = new Store(sourcePath);
  const claude = store.saveAccount({ provider: 'claude', label: 'Slot One', identity: 'claude-one@example.invalid', profileRef: 'slot-1', isDefault: true });
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(codexHome, 0o700);
  const codex = store.saveAccount({ provider: 'codex', label: 'Slot Two', identity: 'codex-two@example.invalid', profileRef: codexHome, isDefault: true });
  const staging = store.saveProject({ name: 'staging-app', path: stageProject });
  const real = store.saveProject({ name: 'real-app', path: realProject });
  store.mapProject(staging.id, { claudeAccountId: claude.id });
  store.mapProject(real.id, { claudeAccountId: claude.id, codexAccountId: codex.id });
  store.recordUsage(claude.id, { scope: 'weekly', usedPercent: 40, source: 'fixture' });
  store.recordUsage(codex.id, { scope: 'weekly', usedPercent: 10, source: 'fixture' });
  store.recordLaunch({ accountId: claude.id, projectId: staging.id, provider: 'claude', commandPreview: 'claude' });
  store.recordLaunch({ accountId: codex.id, projectId: real.id, provider: 'codex', commandPreview: 'codex' });
  store.close();

  return { root, sourcePath, stageRoot, stagingProjectId: staging.id, realProjectPath: realProject };
}

test('migration copies with backup semantics, strips staging mappings, and verifies integrity', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = path.join(fixture.root, 'deep', 'nested', 'modeldeck.sqlite');

  const summary = migrateDatabase({
    source: fixture.sourcePath,
    target,
    stripPrefixes: [fixture.stageRoot],
  });

  assert.equal(summary.integrity, 'ok');
  assert.equal(summary.strippedProjects, 1);
  assert.deepEqual(summary.counts, { accounts: 2, projects: 1, usage_snapshots: 2, launch_events: 2 });

  // Permissions: dir 0700, file 0600.
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);

  const db = new DatabaseSync(target);
  t.after(() => db.close());
  const projects = db.prepare('SELECT * FROM projects').all();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].path, fixture.realProjectPath);
  assert.ok(!projects.some((row) => row.path.startsWith(fixture.stageRoot)));
  // Accounts, mappings, and usage history preserved.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2);
  assert.equal(projects[0].claude_account_id !== null, true);
  assert.equal(projects[0].codex_account_id !== null, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_snapshots').get().n, 2);
  // Launch events survive, but references to stripped projects are cleared.
  const launches = db.prepare('SELECT project_id FROM launch_events ORDER BY id').all();
  assert.equal(launches.length, 2);
  assert.equal(launches[0].project_id, null);
  assert.notEqual(launches[1].project_id, null);
  // WAL journal mode preserved on the migrated database.
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
});

test('migration refuses to overwrite an existing target without --force', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = path.join(fixture.root, 'target.sqlite');
  fs.writeFileSync(target, 'existing');

  assert.throws(
    () => migrateDatabase({ source: fixture.sourcePath, target, stripPrefixes: [fixture.stageRoot] }),
    /already exists.*--force/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing');

  const summary = migrateDatabase({ source: fixture.sourcePath, target, force: true, stripPrefixes: [fixture.stageRoot] });
  assert.equal(summary.integrity, 'ok');
  assert.equal(summary.counts.accounts, 2);
});

test('migration rejects a missing source and identical source/target', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(() => migrateDatabase({ source: path.join(fixture.root, 'missing.sqlite'), target: path.join(fixture.root, 'out.sqlite') }), /does not exist/);
  assert.throws(() => migrateDatabase({ source: fixture.sourcePath, target: fixture.sourcePath, force: true }), /same file/);
});

test('migration works against a live WAL database with an open writer', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  // Keep a live connection with uncheckpointed WAL frames while migrating.
  const live = new Store(fixture.sourcePath);
  t.after(() => live.close());
  live.recordUsage(live.listAccounts()[0].id, { scope: '5h', usedPercent: 5, source: 'live' });

  const target = path.join(fixture.root, 'live-target.sqlite');
  const summary = migrateDatabase({ source: fixture.sourcePath, target, stripPrefixes: [fixture.stageRoot] });
  assert.equal(summary.integrity, 'ok');
  assert.equal(summary.counts.usage_snapshots, 3);
});
