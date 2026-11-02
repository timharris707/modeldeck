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

const LEGACY_SESSION_ID = 'session-legacy-subagents-placeholder';
const LEGACY_PROFILE_SLUG = 'profile-legacy-subagents-placeholder';
const LEGACY_AGENT_COUNT = 52;
const LEGACY_ALIAS_COUNT = 22;

function legacyCanonicalAgentId(index) {
  return `placeholder-subagent-${String(index + 1).padStart(2, '0')}`;
}

function buildLegacySubagentFixture() {
  const fixture = buildFixture();
  const store = new Store(fixture.sourcePath);
  const canonicalSubagents = [];
  const legacyAliases = [];
  const requests = [];

  for (let index = 0; index < LEGACY_AGENT_COUNT; index += 1) {
    const agentId = legacyCanonicalAgentId(index);
    const observedAt = `2026-08-02T12:${String(index).padStart(2, '0')}:00.000Z`;
    const canonical = {
      agentId,
      sessionId: LEGACY_SESSION_ID,
      profileSlug: LEGACY_PROFILE_SLUG,
      agentType: `placeholder-agent-type-${String(index + 1).padStart(2, '0')}`,
      resolvedModel: 'claude-placeholder-canonical',
      totalTokens: 100 + index,
      toolStatsJson: JSON.stringify({ totalToolUseCount: index + 1 }),
      durationMs: 1_000 + index,
      observedAt,
    };
    if (index === 0 || index === 2) {
      Object.assign(canonical, {
        agentType: null,
        resolvedModel: null,
        totalTokens: null,
        toolStatsJson: null,
        durationMs: null,
      });
    } else if (index === 3) {
      canonical.agentType = 'prompt: placeholder stored prompt fallback';
    }
    canonicalSubagents.push(canonical);

    if (index < LEGACY_ALIAS_COUNT) {
      const alias = {
        agentId: `agent-${agentId}`,
        sessionId: LEGACY_SESSION_ID,
        profileSlug: LEGACY_PROFILE_SLUG,
        observedAt: `2026-08-02T13:${String(index).padStart(2, '0')}:00.000Z`,
      };
      if (index === 0) {
        Object.assign(alias, {
          agentType: 'description: placeholder stored description fallback',
          resolvedModel: 'claude-placeholder-legacy-richer',
          totalTokens: 900,
          toolStatsJson: JSON.stringify({ totalToolUseCount: 90 }),
          durationMs: 9_000,
        });
      } else if (index === 1) {
        alias.agentType = 'placeholder-conflicting-legacy-type';
      }
      legacyAliases.push(alias);
    }

    requests.push({
      dedupeKey: `message:${LEGACY_SESSION_ID}:placeholder-message-${index + 1}`,
      requestId: null,
      sessionId: LEGACY_SESSION_ID,
      profileSlug: LEGACY_PROFILE_SLUG,
      messageId: `placeholder-message-${index + 1}`,
      recordUuid: `placeholder-record-${index + 1}`,
      model: 'claude-placeholder-request',
      effort: null,
      observedAt,
      inputTokens: 5,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 3,
      outputTokens: 1,
      cacheCreationEphemeral5mInputTokens: 1,
      cacheCreationEphemeral1hInputTokens: 0,
      isSidechain: true,
      agentId: index < LEGACY_ALIAS_COUNT ? `agent-${agentId}` : agentId,
    });
  }

  store.ingestTranscriptBatch({
    sessions: [
      {
        sessionId: LEGACY_SESSION_ID,
        profileSlug: LEGACY_PROFILE_SLUG,
        machine: 'placeholder-machine',
        cwd: '/placeholder/workspace',
        firstAt: '2026-08-02T12:00:00.000Z',
        lastAt: '2026-08-02T13:59:00.000Z',
      },
      {
        sessionId: 'session-unpaired-prefix-placeholder',
        profileSlug: LEGACY_PROFILE_SLUG,
        machine: 'placeholder-machine',
        cwd: '/placeholder/workspace',
        firstAt: '2026-08-02T14:00:00.000Z',
        lastAt: '2026-08-02T14:00:00.000Z',
      },
    ],
    requests: [
      ...requests,
      {
        dedupeKey: 'message:session-unpaired-prefix-placeholder:placeholder-message',
        requestId: null,
        sessionId: 'session-unpaired-prefix-placeholder',
        profileSlug: LEGACY_PROFILE_SLUG,
        messageId: 'placeholder-unpaired-message',
        recordUuid: 'placeholder-unpaired-record',
        model: 'claude-placeholder-request',
        effort: null,
        observedAt: '2026-08-02T14:00:00.000Z',
        inputTokens: 5,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 3,
        outputTokens: 1,
        cacheCreationEphemeral5mInputTokens: 1,
        cacheCreationEphemeral1hInputTokens: 0,
        isSidechain: true,
        agentId: 'agent-placeholder-unpaired',
      },
    ],
    subagents: [
      ...canonicalSubagents,
      ...legacyAliases,
      {
        agentId: 'agent-placeholder-unpaired',
        sessionId: 'session-unpaired-prefix-placeholder',
        profileSlug: LEGACY_PROFILE_SLUG,
        agentType: 'placeholder-legitimate-prefixed-type',
        observedAt: '2026-08-02T14:00:00.000Z',
      },
    ],
  });
  store.close();
  return fixture;
}

function readLegacySubagentState(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const store = Object.create(Store.prototype);
  store.db = db;
  try {
    return {
      rows: store.db.prepare(`
        SELECT * FROM transcript_subagents
        WHERE session_id = ? AND profile_slug = ?
        ORDER BY agent_id
      `).all(LEGACY_SESSION_ID, LEGACY_PROFILE_SLUG),
      requestAgentIds: store.db.prepare(`
        SELECT agent_id FROM transcript_requests
        WHERE session_id = ? AND profile_slug = ?
        ORDER BY agent_id
      `).all(LEGACY_SESSION_ID, LEGACY_PROFILE_SLUG).map((row) => row.agent_id),
      detail: store.usageSessionDetail({
        sessionId: LEGACY_SESSION_ID,
        profile: LEGACY_PROFILE_SLUG,
      }),
      unpairedPrefix: store.db.prepare(`
        SELECT sa.agent_id, sa.agent_type, COUNT(r.id) AS requests
        FROM transcript_subagents sa
        LEFT JOIN transcript_requests r
          ON r.session_id = sa.session_id
         AND r.profile_slug = sa.profile_slug
         AND r.agent_id = sa.agent_id
        WHERE sa.session_id = 'session-unpaired-prefix-placeholder'
          AND sa.profile_slug = ?
        GROUP BY sa.agent_id, sa.profile_slug
      `).get(LEGACY_PROFILE_SLUG),
    };
  } finally {
    db.close();
  }
}

function assertLegacySubagentsBackfilled(state) {
  assert.equal(state.rows.length, LEGACY_AGENT_COUNT);
  assert.equal(state.detail.subagents.length, LEGACY_AGENT_COUNT);
  assert.equal(state.rows.some((row) => row.agent_id.startsWith('agent-')), false);
  assert.deepEqual(
    [...new Set(state.requestAgentIds)],
    Array.from({ length: LEGACY_AGENT_COUNT }, (_, index) => legacyCanonicalAgentId(index)),
  );

  const richerLegacy = state.rows.find((row) => row.agent_id === legacyCanonicalAgentId(0));
  assert.equal(richerLegacy.agent_type, 'description: placeholder stored description fallback');
  assert.equal(richerLegacy.resolved_model, 'claude-placeholder-legacy-richer');
  assert.equal(richerLegacy.total_tokens, 900);
  assert.equal(richerLegacy.duration_ms, 9_000);
  assert.deepEqual(JSON.parse(richerLegacy.tool_stats_json), { totalToolUseCount: 90 });

  const richerCanonical = state.rows.find((row) => row.agent_id === legacyCanonicalAgentId(1));
  assert.equal(richerCanonical.agent_type, 'placeholder-agent-type-02');
  assert.equal(richerCanonical.resolved_model, 'claude-placeholder-canonical');
  assert.equal(richerCanonical.total_tokens, 101);

  const unrecoverable = state.rows.find((row) => row.agent_id === legacyCanonicalAgentId(2));
  assert.equal(unrecoverable.agent_type, null);
  const storedFallback = state.rows.find((row) => row.agent_id === legacyCanonicalAgentId(3));
  assert.equal(storedFallback.agent_type, 'prompt: placeholder stored prompt fallback');

  const firstDetail = state.detail.subagents.find(
    (row) => row.agentId === legacyCanonicalAgentId(0),
  );
  assert.equal(firstDetail.agentType, 'description: placeholder stored description fallback');
  assert.equal(firstDetail.requests, 1);
  assert.equal(state.detail.subagents.reduce((total, row) => total + row.requests, 0), LEGACY_AGENT_COUNT);
  assert.equal(state.unpairedPrefix.agent_id, 'agent-placeholder-unpaired');
  assert.equal(state.unpairedPrefix.agent_type, 'placeholder-legitimate-prefixed-type');
  assert.equal(state.unpairedPrefix.requests, 1);
}

function transcriptIdentitySnapshot(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return {
      subagents: db.prepare(`
        SELECT * FROM transcript_subagents ORDER BY profile_slug, session_id, agent_id
      `).all(),
      requests: db.prepare(`
        SELECT * FROM transcript_requests ORDER BY id
      `).all(),
    };
  } finally {
    db.close();
  }
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

test('TRIPWIRE: legacy-seeded warehouse reads back deduped and labeled after migration', (t) => {
  const fixture = buildLegacySubagentFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = path.join(fixture.root, 'legacy-subagents-target.sqlite');

  const legacy = readLegacySubagentState(fixture.sourcePath);
  assert.equal(legacy.rows.length, 74, 'fixture mirrors a 74-row split for 52 canonical agents');
  assert.throws(
    () => assertLegacySubagentsBackfilled(legacy),
    { name: 'AssertionError' },
    'the clean-readback assertion must trip before migrateDatabase runs',
  );

  const summary = migrateDatabase({
    source: fixture.sourcePath,
    target,
    stripPrefixes: [fixture.stageRoot],
  });
  assert.deepEqual(summary.subagentBackfill, {
    rowsDeduplicated: 22,
    requestsRekeyed: 22,
    labelsFilled: 1,
    remainingNullLabels: 1,
  });
  assertLegacySubagentsBackfilled(readLegacySubagentState(target));
  assert.equal(
    readLegacySubagentState(fixture.sourcePath).rows.length,
    74,
    'the reversible backup migration leaves its source warehouse untouched',
  );
});

test('legacy subagent backfill is idempotent on its migrated output', (t) => {
  const fixture = buildLegacySubagentFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const firstTarget = path.join(fixture.root, 'legacy-subagents-first.sqlite');
  const secondTarget = path.join(fixture.root, 'legacy-subagents-second.sqlite');

  migrateDatabase({
    source: fixture.sourcePath,
    target: firstTarget,
    stripPrefixes: [fixture.stageRoot],
  });
  const afterFirstRun = transcriptIdentitySnapshot(firstTarget);
  const second = migrateDatabase({
    source: firstTarget,
    target: secondTarget,
    stripPrefixes: [fixture.stageRoot],
  });

  assert.deepEqual(second.subagentBackfill, {
    rowsDeduplicated: 0,
    requestsRekeyed: 0,
    labelsFilled: 0,
    remainingNullLabels: 1,
  });
  assert.deepEqual(transcriptIdentitySnapshot(secondTarget), afterFirstRun);
  assertLegacySubagentsBackfilled(readLegacySubagentState(secondTarget));
});

// CodeRabbit on #812: with only MODELDECK_DATA_DIR set, the default target is
// the database the daemon opens there, not the platform default folder.
test('the default target follows MODELDECK_DATA_DIR', async () => {
  const { spawnSync } = await import('node:child_process');
  const fixture = buildFixture();
  const dataDir = path.join(fixture.root, 'custom-data');
  const env = { PATH: process.env.PATH, HOME: fixture.root, MODELDECK_DATA_DIR: dataDir };
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/migrate-db.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--source', fixture.sourcePath], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(dataDir, 'modeldeck.sqlite')));
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
