import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-store-'));
  const projectPath = path.join(root, 'projects', 'loanmeld');
  const codexHome = path.join(root, 'profiles', 'codex-business');
  const claudeProfilesDir = path.join(root, 'claude-profiles');
  const claudeBusinessHome = path.join(claudeProfilesDir, 'business');
  const claudePersonalHome = path.join(claudeProfilesDir, 'personal');
  fs.mkdirSync(path.join(projectPath, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeBusinessHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudePersonalHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(claudeProfilesDir, 0o700);
  fs.chmodSync(claudeBusinessHome, 0o700);
  fs.chmodSync(claudePersonalHome, 0o700);
  fs.chmodSync(codexHome, 0o700);
  const store = new Store(':memory:');
  const claudeBusiness = store.saveAccount({ provider: 'claude', label: 'Business Claude', identity: 'business@example.invalid', profileRef: claudeBusinessHome, purpose: 'LoanMeld', isDefault: true });
  const claudePersonal = store.saveAccount({ provider: 'claude', label: 'Personal Claude', profileRef: claudePersonalHome });
  const codexBusiness = store.saveAccount({ provider: 'codex', label: 'Business Codex', profileRef: codexHome, isDefault: true });
  const project = store.saveProject({ name: 'LoanMeld', path: projectPath });
  store.mapProject(project.id, { purpose: 'Business', claudeAccountId: claudeBusiness.id, codexAccountId: codexBusiness.id });
  return {
    root, projectPath: fs.realpathSync(projectPath), claudeProfilesDir: fs.realpathSync(claudeProfilesDir),
    claudeBusinessHome: fs.realpathSync(claudeBusinessHome), codexHome: fs.realpathSync(codexHome), store, claudeBusiness, claudePersonal, codexBusiness,
    project: store.getProject(project.id),
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('stores project mappings and resolves nearest mapped ancestor', () => {
  const data = fixture();
  try {
    const resolved = data.store.resolveProject(path.join(data.projectPath, 'apps', 'web'));
    assert.equal(resolved.id, data.project.id);
    assert.equal(resolved.claudeAccountId, data.claudeBusiness.id);
  } finally { data.close(); }
});

test('launch specs preserve project identity with process-scoped profile homes', () => {
  const data = fixture();
  try {
    const service = new ModelDeckService(data.store, { projectsRoot: path.dirname(data.projectPath), claudeProfilesDir: data.claudeProfilesDir, claudePath: 'claude', codexPath: 'codex' });
    const claude = service.launchSpec('claude', path.join(data.projectPath, 'apps', 'web'), ['--resume']);
    assert.deepEqual(claude.args, ['--resume']);
    assert.equal(claude.env.CLAUDE_CONFIG_DIR, data.claudeBusinessHome);
    assert.match(claude.preview, /CLAUDE_CONFIG_DIR='.*\/claude-profiles\/business' 'claude' '--resume'/);
    const codex = service.launchSpec('codex', data.projectPath, ['--full-auto']);
    assert.equal(codex.env.CODEX_HOME, data.codexHome);
    assert.deepEqual(codex.args, ['--full-auto']);
  } finally { data.close(); }
});

test('usage snapshots expose remaining percent and latest scope value', () => {
  const data = fixture();
  try {
    data.store.recordUsage(data.claudeBusiness.id, { scope: 'Fable weekly', usedPercent: 51, source: 'test' });
    data.store.recordUsage(data.claudeBusiness.id, { scope: 'Fable weekly', usedPercent: 62, source: 'test' });
    const usage = data.store.latestUsage();
    assert.equal(usage.length, 1);
    assert.equal(usage[0].usedPercent, 62);
    assert.equal(usage[0].remainingPercent, 38);
  } finally { data.close(); }
});

test('preserves a manually assigned identity when a refresh omits email', () => {
  const data = fixture();
  try {
    const refreshed = data.store.saveAccount({ provider: 'claude', label: 'Business Claude', profileRef: data.claudeBusiness.profileRef });
    assert.equal(refreshed.identity, 'business@example.invalid');
  } finally { data.close(); }
});

test('Claude refresh records native usage without rewriting ModelDeck presentation fields', async () => {
  const data = fixture();
  try {
    const original = data.store.saveAccount({
      id: data.claudeBusiness.id,
      provider: 'claude',
      label: 'Studio Max',
      identity: 'studio@example.com',
      purpose: 'Studio projects',
      profileRef: '1',
      color: '#123456',
      enabled: true,
    });
    const service = new ModelDeckService(data.store, {
      fetchClaude: async () => [{ scope: 'weekly', usedPercent: 12, resetsAt: '2026-07-25T20:00:00Z', source: 'claude-oauth-api', detail: {} }],
    });
    const [result] = await service.refreshClaude();
    assert.equal(result.accountId, original.id);
    assert.equal(result.ok, true);
    assert.equal(result.snapshotCount, 1);
    assert.equal(data.store.getAccount(original.id).label, 'Studio Max');
    assert.equal(data.store.getAccount(original.id).purpose, 'Studio projects');
    assert.equal(data.store.getAccount(original.id).color, '#123456');
    assert.equal(data.store.getAccount(original.id).enabled, true);
    assert.equal(data.store.latestUsage()[0].usedPercent, 12);
  } finally { data.close(); }
});

test('Claude refresh sets and clears duplicate-token account health', async () => {
  const data = fixture();
  try {
    let duplicate = true;
    const service = new ModelDeckService(data.store, {
      fetchClaude: async ({ claudeConfigDir }) => [{
        scope: 'weekly',
        usedPercent: 25,
        resetsAt: duplicate || path.basename(claudeConfigDir) === 'business'
          ? '2026-07-25T20:00:00.100Z'
          : '2026-07-26T20:00:00.100Z',
        source: 'fixture',
      }],
      claudeCredentialsPresent: async () => true,
    });

    await service.refreshClaude();
    let accounts = (await service.state()).accounts.filter((account) => account.provider === 'claude');
    assert.deepEqual(accounts.map((account) => account.authState), ['duplicate-token', 'duplicate-token']);

    duplicate = false;
    await service.refreshClaude();
    accounts = (await service.state()).accounts.filter((account) => account.provider === 'claude');
    assert.deepEqual(accounts.map((account) => account.authState), ['ok', 'ok']);
  } finally { data.close(); }
});

test('duplicate-token flag survives incomplete refreshes and invalidates the tool probe on transitions', async () => {
  const data = fixture();
  try {
    let mode = 'duplicate';
    const service = new ModelDeckService(data.store, {
      fetchClaude: async ({ claudeConfigDir }) => {
        const profile = path.basename(claudeConfigDir);
        if (mode === 'partial' && profile === 'personal') throw new Error('transient probe failure');
        return [{
          scope: 'weekly',
          usedPercent: 25,
          resetsAt: mode === 'separated' && profile === 'personal'
            ? '2026-07-26T20:00:00.000Z'
            : '2026-07-25T20:00:00.000Z',
          source: 'fixture',
        }];
      },
      claudeCredentialsPresent: async () => true,
    });
    let invalidations = 0;
    const originalInvalidate = service.invalidateToolProbe.bind(service);
    service.invalidateToolProbe = () => { invalidations += 1; originalInvalidate(); };
    const claudeAuthStates = async () => (await service.state()).accounts
      .filter((account) => account.provider === 'claude')
      .map((account) => account.authState);

    await service.refreshClaude();
    assert.deepEqual(await claudeAuthStates(), ['duplicate-token', 'duplicate-token']);
    assert.equal(invalidations, 1);

    // A refresh where one flagged account fails to fetch is not evidence the
    // fingerprints separated — flags must persist, and no probe churn.
    mode = 'partial';
    await service.refreshClaude();
    assert.deepEqual(await claudeAuthStates(), ['duplicate-token', 'duplicate-token']);
    assert.equal(invalidations, 1);

    // Steady state with unchanged duplicate evidence: no probe churn either.
    mode = 'duplicate';
    await service.refreshClaude();
    assert.equal(invalidations, 1);

    // Real divergence (re-login separated the fingerprints) clears both flags
    // and invalidates the cached provider authState.
    mode = 'separated';
    await service.refreshClaude();
    assert.deepEqual(await claudeAuthStates(), ['ok', 'ok']);
    assert.equal(invalidations, 2);
  } finally { data.close(); }
});

// Issue #26 (Claude half): the refresh pass keeps the plan tier fresh from
// the profile's local .claude.json — no extra provider calls, persisted only
// on change.
test('Claude refresh captures the plan tier from the profile home', async () => {
  const data = fixture();
  try {
    let tierReads = 0;
    const service = new ModelDeckService(data.store, {
      fetchClaude: async () => [{ scope: 'weekly', usedPercent: 12, resetsAt: '2026-07-25T20:00:00Z', source: 'claude-oauth-api', detail: {} }],
      readClaudeTier: async ({ claudeConfigDir }) => {
        tierReads += 1;
        return path.basename(claudeConfigDir) === 'business' ? 'default_claude_max_20x' : null;
      },
    });
    await service.refreshClaude();
    const saved = data.store.getAccount(data.claudeBusiness.id);
    assert.deepEqual(saved.metadata.claudePlan, { subscriptionType: null, rateLimitTier: 'default_claude_max_20x' });
    assert.equal(saved.identity, 'business@example.invalid', 'presentation fields untouched');
    // No tier → no metadata invented.
    assert.deepEqual(data.store.getAccount(data.claudePersonal.id).metadata, {});
    // Unchanged tier on the next pass → no rewrite.
    const updatedAt = saved.updatedAt;
    await service.refreshClaude();
    assert.equal(data.store.getAccount(data.claudeBusiness.id).updatedAt, updatedAt);
    assert.ok(tierReads >= 2);
  } finally { data.close(); }
});

test('Codex refresh surfaces raw and display-ready plan metadata', async () => {
  const data = fixture();
  try {
    let planType = null;
    const service = new ModelDeckService(data.store, {
      fetchCodex: async () => [],
      readCodexPlan: async () => ({ planType }),
    });
    for (const [raw, displayName] of [
      ['pro', 'Pro'],
      ['plus', 'Plus'],
      ['team', 'Team'],
      ['free', 'Free'],
      ['enterprise', 'Enterprise'],
    ]) {
      planType = raw;
      await service.refreshCodex();
      assert.deepEqual(data.store.getAccount(data.codexBusiness.id).metadata.codexPlan, { planType: raw, displayName });
    }
  } finally { data.close(); }
});

// Both absent-claim tests seed stale plan metadata first so they exercise the
// removal path, not just the never-present path (CodeRabbit, PR #34).
test('Codex refresh removes stale plan metadata when the claim is absent', async () => {
  const data = fixture();
  try {
    const account = data.store.getAccount(data.codexBusiness.id);
    data.store.saveAccount({
      ...account,
      metadata: { ...account.metadata, codexPlan: { planType: 'pro', displayName: 'Pro' } },
    });
    const service = new ModelDeckService(data.store, {
      fetchCodex: async () => [],
      readCodexPlan: async () => ({ planType: null }),
    });
    await service.refreshCodex();
    assert.equal(Object.hasOwn(data.store.getAccount(data.codexBusiness.id).metadata, 'codexPlan'), false);
  } finally { data.close(); }
});

test('Codex verify removes stale plan metadata when the claim is absent', async () => {
  const data = fixture();
  try {
    const account = data.store.getAccount(data.codexBusiness.id);
    data.store.saveAccount({
      ...account,
      metadata: { ...account.metadata, codexPlan: { planType: 'pro', displayName: 'Pro' } },
    });
    const service = new ModelDeckService(data.store, {
      codexProfilesDir: path.dirname(data.codexHome),
      readCodexAuth: async () => ({ authenticated: true, identity: 'dev@example.com', plan: { planType: null } }),
    });
    const result = await service.verifyAccount(data.codexBusiness.id);
    assert.equal(result.authenticated, true);
    assert.equal(Object.hasOwn(result.account.metadata, 'codexPlan'), false);
  } finally { data.close(); }
});

test('account edits cannot clobber daemon-owned metadata with a stale object', async () => {
  const data = fixture();
  try {
    const service = new ModelDeckService(data.store, { claudeProfilesDir: data.claudeProfilesDir });
    const account = data.store.getAccount(data.claudeBusiness.id);
    data.store.saveAccount({
      ...account,
      metadata: {
        ...account.metadata,
        claudePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
        codexPlan: { planType: 'pro', displayName: 'Pro' },
      },
    });
    // An API-style edit re-sending a stale metadata object (e.g. captured
    // before verify populated the plan) must not wipe daemon-owned keys.
    const edited = await service.saveAccount({
      id: account.id,
      provider: account.provider,
      label: 'Business Renamed',
      profileRef: account.profileRef,
      metadata: { userNote: 'kept' },
    });
    assert.equal(edited.label, 'Business Renamed');
    assert.equal(edited.metadata.userNote, 'kept');
    assert.deepEqual(edited.metadata.claudePlan, { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' });
    assert.deepEqual(edited.metadata.codexPlan, { planType: 'pro', displayName: 'Pro' });
  } finally { data.close(); }
});

test('migrates a pre-identity account database without data loss', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-migration-'));
  const dbPath = path.join(root, 'modeldeck.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    profile_ref TEXT NOT NULL,
    color TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, profile_ref)
  )`);
  legacy.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy', 'claude', 'Legacy Max', 'Business', 'legacy-profile', '#fff', 1, 1, '{}', '2026-01-01', '2026-01-01');
  legacy.close();
  const store = new Store(dbPath);
  try {
    assert.equal(store.getAccount('legacy').label, 'Legacy Max');
    assert.equal(store.getAccount('legacy').identity, '');
    assert.ok(store.db.prepare('PRAGMA table_info(accounts)').all().some((column) => column.name === 'identity'));
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing, permissive, and nested CODEX_HOME directories', () => {
  const data = fixture();
  try {
    assert.throws(() => data.store.saveAccount({ provider: 'codex', label: 'Missing', profileRef: path.join(data.root, 'missing') }), /does not exist/);
    const permissive = path.join(data.root, 'permissive');
    fs.mkdirSync(permissive, { mode: 0o755 });
    fs.chmodSync(permissive, 0o755);
    assert.throws(() => data.store.saveAccount({ provider: 'codex', label: 'Permissive', profileRef: permissive }), /owner-only permissions/);
    const nested = path.join(data.codexHome, 'nested');
    fs.mkdirSync(nested, { mode: 0o700 });
    assert.throws(() => data.store.saveAccount({ provider: 'codex', label: 'Nested', profileRef: nested }), /cannot be nested/);
  } finally { data.close(); }
});

test('settings persist across Store instances and partial updates retain defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-settings-'));
  const dbPath = path.join(root, 'modeldeck.sqlite');
  let store = new Store(dbPath);
  try {
    assert.equal(store.getSettings().autoRefreshEnabled, true);
    const updated = store.saveSettings({ layout: 'single-column', notificationThresholdPercent: 42 });
    assert.equal(updated.autoRefreshIntervalSeconds, 300);
    assert.equal(updated.layout, 'single-column');
  } finally { store.close(); }

  store = new Store(dbPath);
  try {
    assert.equal(store.getSettings().layout, 'single-column');
    assert.equal(store.getSettings().notificationThresholdPercent, 42);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settings reject inherited object names as unknown keys', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.saveSettings({ constructor: 'unexpected' }), /unknown setting: constructor/);
  } finally { store.close(); }
});

test('menuBarAccountId accepts short strings and rejects everything else', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.getSettings().menuBarAccountId, '');
    assert.equal(store.saveSettings({ menuBarAccountId: 'acc-1' }).menuBarAccountId, 'acc-1');
    assert.equal(store.saveSettings({ menuBarAccountId: '' }).menuBarAccountId, '');
    assert.throws(() => store.saveSettings({ menuBarAccountId: 42 }), /menuBarAccountId/);
    assert.throws(() => store.saveSettings({ menuBarAccountId: null }), /menuBarAccountId/);
    assert.throws(() => store.saveSettings({ menuBarAccountId: 'x'.repeat(129) }), /menuBarAccountId/);
  } finally { store.close(); }
});
