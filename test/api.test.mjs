import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';

async function startFixture(serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-api-'));
  const projectsRoot = path.join(root, 'projects');
  const codexHome = path.join(root, 'profiles', 'work');
  const claudeHome = path.join(root, 'claude-profiles', 'work');
  const codexActiveLink = path.join(root, 'active', '.codex');
  const claudeActiveLink = path.join(root, 'active', '.claude');
  fs.mkdirSync(path.join(projectsRoot, 'loanmeld'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(codexHome, 0o700);
  fs.chmodSync(path.dirname(codexHome), 0o700);
  fs.writeFileSync(path.join(projectsRoot, 'loanmeld', 'package.json'), JSON.stringify({ name: 'loanmeld' }));
  const store = new Store(':memory:');
  store.saveAccount({ provider: 'claude', label: 'Business', profileRef: claudeHome, isDefault: true });
  const service = new ModelDeckService(store, {
    projectsRoot,
    codexActiveLink,
    claudeActiveLink,
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    codexProfilesDir: path.join(root, 'profiles'),
    fetchClaude: async () => [{ scope: 'Fable weekly', usedPercent: 20, source: 'fixture' }],
    fetchCodex: async () => [],
    // Inert timer: listen() must never arm a real auto-refresh in the API
    // fixture (scheduler behavior is covered by test/auto-refresh.test.mjs
    // with an injected clock); stored settings stay at their defaults.
    setTimeout: () => 0,
    clearTimeout: () => {},
    platform: 'linux',
    // Deterministic: never let the fixture shell out to /bin/ps for the
    // issue #66 pre-flip running-session warning.
    listProviderProcesses: async () => [],
    ...serviceOptions,
  });
  const app = createApp({ store, service, host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => app.listen(resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(`${base}/api/session`);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  return { root, claudeHome, claudeActiveLink, codexHome, codexActiveLink, store, service, app, base, token: session.token, cookie };
}

async function request(fixture, route, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(`${fixture.base}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-ModelDeck-Token': fixture.token, Cookie: fixture.cookie } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

function requestWithHost(fixture, host) {
  const url = new URL(fixture.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: '/api/health', headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('retired dashboard paths return JSON 404 responses', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  for (const route of ['/', '/app.js']) {
    const result = await request(fixture, route);
    assert.equal(result.response.status, 404);
    assert.match(result.response.headers.get('content-type'), /^application\/json\b/);
    assert.deepEqual(result.body, { error: 'not found' });
  }
});

test('health, scan, account, mapping, launch, and refresh APIs work together', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  let result = await request(fixture, '/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.name, 'ModelDeck');

  result = await request(fixture, '/api/scan', { method: 'POST', body: '{}' });
  assert.equal(result.body.projects.length, 1);
  const project = result.body.projects[0];

  result = await request(fixture, '/api/accounts', { method: 'POST', body: JSON.stringify({ provider: 'codex', label: 'Business Codex', identity: 'business@example.com', profileRef: fixture.codexHome, isDefault: true }) });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.account.identity, 'business@example.com');
  const codex = result.body.account;

  result = await request(fixture, '/api/refresh', { method: 'POST', body: '{}' });
  assert.equal(result.body.claude.ok, true);

  const state = (await request(fixture, '/api/state')).body;
  const claude = state.accounts.find((account) => account.provider === 'claude');
  assert.equal(state.usage[0].scope, 'Fable weekly');

  result = await request(fixture, `/api/projects/${project.id}`, { method: 'PUT', body: JSON.stringify({ purpose: 'Business', claudeAccountId: claude.id, codexAccountId: codex.id }) });
  assert.equal(result.body.project.purpose, 'Business');

  result = await request(fixture, `/api/launch?provider=codex&project=${encodeURIComponent(path.join(project.path, 'apps', 'web'))}`);
  assert.equal(result.body.account.profileRef, fs.realpathSync(fixture.codexHome));
  assert.ok(result.body.command.includes(`CODEX_HOME='${fs.realpathSync(fixture.codexHome)}'`));
});

test('rejects missing mutation token, cross-origin mutations, and hostile Host headers', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  let response = await fetch(`${fixture.base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);

  response = await fetch(`${fixture.base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example', 'X-ModelDeck-Token': fixture.token, Cookie: fixture.cookie },
    body: '{}',
  });
  assert.equal(response.status, 403);

  assert.equal(await requestWithHost(fixture, 'attacker.example'), 403);
});

test('Claude identity reset clears provenance and can re-seed; other providers and unauthenticated calls are rejected', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(fixture.claudeHome, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'fresh@example.invalid', accountUuid: 'uuid-fresh' },
  }));
  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  fixture.store.saveAccount({
    ...claude,
    identity: 'stale@example.invalid',
    metadata: { claudeAccountUuid: 'uuid-stale', identitySource: 'seed' },
  });

  let response = await fetch(`${fixture.base}/api/accounts/${claude.id}/reset-identity`, { method: 'POST' });
  assert.equal(response.status, 403);
  assert.equal(fixture.store.getAccount(claude.id).identity, 'stale@example.invalid');

  let result = await request(fixture, `/api/accounts/${claude.id}/reset-identity`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.account.identity, '');
  assert.equal(result.body.account.metadata.claudeAccountUuid, undefined);
  assert.equal(result.body.account.metadata.identitySource, undefined);

  await fixture.service.backfillClaudeIdentities();
  const reseeded = fixture.store.getAccount(claude.id);
  assert.equal(reseeded.identity, 'fresh@example.invalid');
  assert.equal(reseeded.metadata.claudeAccountUuid, 'uuid-fresh');
  assert.equal(reseeded.metadata.identitySource, 'seed');

  const codex = fixture.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: fixture.codexHome });
  result = await request(fixture, `/api/accounts/${codex.id}/reset-identity`, { method: 'POST' });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /only supported for claude/);
});

test('activates Claude and Codex accounts without changing defaults when provider switching fails', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const secondClaudeHome = path.join(fixture.root, 'claude-profiles', 'second');
  fs.mkdirSync(secondClaudeHome, { recursive: true, mode: 0o700 });
  const firstClaude = fixture.store.saveAccount({ provider: 'claude', label: 'Claude One', profileRef: fixture.claudeHome, isDefault: true });
  const secondClaude = fixture.store.saveAccount({ provider: 'claude', label: 'Claude Two', profileRef: secondClaudeHome });
  let result = await request(fixture, `/api/accounts/${secondClaude.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.account.isDefault, true);
  assert.deepEqual(result.body.warnings, []);
  assert.equal(result.body.activation.state, 'identity-unverified');
  assert.equal(result.body.claudeSecureStorage.value, fs.realpathSync(secondClaudeHome));
  assert.equal(result.body.claudeSecureStorage.status, 'not-applicable');
  assert.equal(fs.readlinkSync(fixture.claudeActiveLink), fs.realpathSync(secondClaudeHome));

  fs.unlinkSync(fixture.claudeActiveLink);
  fs.mkdirSync(fixture.claudeActiveLink, { recursive: true });
  result = await request(fixture, `/api/accounts/${firstClaude.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'active-link-blocked');
  assert.match(result.body.error, /one-time migration/);
  assert.match(result.body.error, /move the existing directory aside at a quiet moment/);
  assert.equal(fixture.store.getAccount(secondClaude.id).isDefault, true);

  const secondHome = path.join(fixture.root, 'profiles', 'second');
  fs.mkdirSync(secondHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(secondHome, 0o700);
  const firstCodex = fixture.store.saveAccount({ provider: 'codex', label: 'Codex One', profileRef: fixture.codexHome, isDefault: true });
  const secondCodex = fixture.store.saveAccount({ provider: 'codex', label: 'Codex Two', profileRef: secondHome });
  result = await request(fixture, `/api/accounts/${firstCodex.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(fs.readlinkSync(fixture.codexActiveLink), fs.realpathSync(fixture.codexHome));
  result = await request(fixture, `/api/accounts/${secondCodex.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(fs.readlinkSync(fixture.codexActiveLink), fs.realpathSync(secondHome));

  fs.unlinkSync(fixture.codexActiveLink);
  fs.mkdirSync(fixture.codexActiveLink, { recursive: true });
  result = await request(fixture, `/api/accounts/${firstCodex.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'active-link-blocked');
  assert.match(result.body.error, /one-time migration/);
  assert.match(result.body.error, /move the existing directory aside at a quiet moment/);
  assert.equal(fixture.store.getAccount(secondCodex.id).isDefault, true);

  result = await request(fixture, '/api/accounts/missing/activate', { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 404);
  assert.deepEqual(result.body, { error: 'account not found' });
  const disabled = fixture.store.saveAccount({ provider: 'claude', label: 'Disabled', profileRef: 'disabled', enabled: false });
  result = await request(fixture, `/api/accounts/${disabled.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 400);
  assert.deepEqual(result.body, { error: 'account is disabled' });

  const response = await fetch(`${fixture.base}/api/accounts/${secondClaude.id}/activate`, { method: 'POST' });
  assert.equal(response.status, 403);
});

test('Claude activation response warns about running unpinned sessions (issue #66)', async (t) => {
  const fixture = await startFixture({ listProviderProcesses: async () => ['claude'] });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const claude = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  const result = await request(fixture, `/api/accounts/${claude.id}/activate`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.warnings.length, 1);
  assert.match(result.body.warnings[0], /^1 running Claude session may lose session storage/);
});

test('tool probes compare versions, cache results, force refresh, and contain registry failures', async (t) => {
  let execCalls = 0;
  let registryCalls = 0;
  let failCodexRegistry = false;
  const fixture = await startFixture({
    claudePath: 'claude-fixture',
    codexPath: 'codex-fixture',
    exec: async (binary, args) => {
      execCalls += 1;
      assert.deepEqual(args, ['--version']);
      return { stdout: binary === 'claude-fixture' ? 'Claude Code 1.2.3' : 'codex-cli 2.0.0' };
    },
    registryFetch: async (url) => {
      registryCalls += 1;
      if (failCodexRegistry && url.includes('@openai')) throw new Error('registry unavailable');
      return { ok: true, json: async () => ({ version: url.includes('@anthropic-ai') ? '1.3.0' : '2.0.0' }) };
    },
    toolProbeTtlMs: 60_000,
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(fixture.codexHome, 'auth.json'), '{}');
  fixture.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: fixture.codexHome, isDefault: true });

  let result = await request(fixture, '/api/tools');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.tools.claude.version, '1.2.3');
  assert.equal(result.body.tools.claude.latestVersion, '1.3.0');
  assert.equal(result.body.tools.claude.updateAvailable, true);
  assert.equal(result.body.tools.codex.updateAvailable, false);
  assert.equal(result.body.tools.codex.authState, 'ok');
  assert.equal(execCalls, 2);
  assert.equal(registryCalls, 2);

  await request(fixture, '/api/tools');
  assert.equal(execCalls, 2);
  assert.equal(registryCalls, 2);

  failCodexRegistry = true;
  const unauthorized = await request(fixture, '/api/tools?refresh=1');
  assert.equal(unauthorized.response.status, 403);
  assert.equal(execCalls, 2);

  result = await request(fixture, '/api/tools?refresh=1', {
    headers: { 'X-ModelDeck-Token': fixture.token, Cookie: fixture.cookie },
  });
  assert.equal(execCalls, 4);
  assert.equal(registryCalls, 4);
  assert.equal(result.body.tools.codex.latestVersion, null);
  assert.equal(result.body.tools.codex.updateAvailable, null);
  assert.match(result.body.tools.codex.error, /registry unavailable/);
});

test('state exposes per-account auth and update endpoint returns 409 for an unsupported install method', async (t) => {
  const fixture = await startFixture({
    claudePath: 'claude-fixture',
    claudeCredentialsPresent: async ({ claudeConfigDir }) => claudeConfigDir === fixture.claudeHome,
    migrateClaude: async () => [{
      label: 'Imported', profileRef: path.join(fixture.root, 'claude-profiles', 'imported'),
    }],
    realpath: async () => '/Users/fixture/.local/bin/claude',
    exec: async (command, args) => {
      if (command === '/usr/bin/which') return { stdout: '/Users/fixture/.local/bin/claude\n' };
      if (args[0] === '--version') return { stdout: 'Claude Code 1.0.0' };
      return { stdout: 'codex 1.0.0' };
    },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const state = await request(fixture, '/api/state');
  assert.equal(state.body.accounts[0].authState, 'ok');

  const migrated = await request(fixture, '/api/claude/migrate-cswap', {
    method: 'POST', body: JSON.stringify({ selections: [{ label: 'Imported' }] }),
  });
  assert.equal(migrated.response.status, 201);
  assert.equal(migrated.body.accounts[0].authState, 'signin-required');

  const result = await request(fixture, '/api/tools/claude/update', { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /unsupported direct\/native install method/);
});

// Issue #89: /api/state carries each account's last refresh failure
// ({message, at}) and flips authState to signin-required when the failure
// means the stored credentials are unusable — even though the presence
// probe still sees the (expired) credentials.
test('state surfaces per-account refresh errors and flips authState on expired stored OAuth', async (t) => {
  const fixture = await startFixture({
    claudeCredentialsPresent: async () => true,
    fetchClaude: async () => {
      throw new Error('Claude usage refresh failed: stored OAuth credentials have expired; sign in explicitly before refreshing');
    },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // Before any refresh: no error field at all, presence says healthy.
  let state = (await request(fixture, '/api/state')).body;
  assert.equal(state.accounts[0].authState, 'ok');
  assert.equal(state.accounts[0].lastRefreshError, undefined);

  const refresh = await request(fixture, '/api/refresh', { method: 'POST', body: '{}' });
  assert.equal(refresh.body.claude.ok, false);

  state = (await request(fixture, '/api/state')).body;
  const account = state.accounts[0];
  assert.equal(account.authState, 'signin-required');
  assert.match(account.lastRefreshError.message, /sign in explicitly before refreshing/);
  assert.ok(!Number.isNaN(Date.parse(account.lastRefreshError.at)));
});

test('settings API validates partial updates and drives worst-capacity thresholds', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
  const reschedules = [];
  const rescheduleAutoRefresh = fixture.service.rescheduleAutoRefresh.bind(fixture.service);
  fixture.service.rescheduleAutoRefresh = (settings) => {
    reschedules.push(settings);
    return rescheduleAutoRefresh(settings);
  };

  let result = await request(fixture, '/api/settings');
  assert.deepEqual(result.body, {
    autoRefreshEnabled: true,
    autoRefreshIntervalSeconds: 300,
    autoRefreshIntervalCustomized: false,
    pauseWhileActive: true,
    layout: 'two-column',
    defaultSort: 'next-reset',
    notificationThresholdPercent: 25,
    menuBarStyle: 'icon-only',
  });
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ layout: 'single-column', notificationThresholdPercent: 30 }) });
  assert.equal(result.body.layout, 'single-column');
  assert.equal(result.body.autoRefreshEnabled, true);
  assert.equal(reschedules.length, 1);
  assert.equal(reschedules[0].notificationThresholdPercent, 30);

  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ autoRefreshIntervalSeconds: 30 }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /60 to 3600/);
  result = await request(fixture, '/api/settings', { method: 'PUT', body: JSON.stringify({ surprise: true }) });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /unknown setting: surprise/);
  assert.equal(reschedules.length, 1);

  const first = fixture.store.saveAccount({ provider: 'claude', label: 'First', profileRef: 'first' });
  const second = fixture.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: 'second' });
  const disabled = fixture.store.saveAccount({ provider: 'claude', label: 'Disabled', profileRef: 'third', enabled: false });
  fixture.store.recordUsage(first.id, { scope: 'weekly', usedPercent: 60, resetsAt: '2026-07-25T20:00:00Z', observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });
  fixture.store.recordUsage(first.id, { scope: '5-hour', usedPercent: null, observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });
  fixture.store.recordUsage(second.id, { scope: 'weekly', usedPercent: 80, observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });
  fixture.store.recordUsage(disabled.id, { scope: 'weekly', usedPercent: 95, observedAt: '2026-07-19T18:00:00Z', source: 'fixture' });

  result = await request(fixture, '/api/capacity/worst');
  assert.equal(result.body.status, 'warn');
  assert.equal(result.body.iconState, 'gold');
  assert.equal(result.body.worst.accountId, second.id);
  assert.equal(result.body.worst.remainingPercent, 20);
  assert.equal(result.body.thresholdPercent, 30);
  assert.equal(result.body.accountsEvaluated, 2);
  assert.equal(result.body.windowsEvaluated, 2);
  assert.deepEqual(result.body.excluded.map((row) => row.reason).sort(), ['account disabled', 'usage unavailable']);
});

test('add-account flow: create, login spec, verify, and reference-only delete', async (t) => {
  const readCalls = { claude: 0, codex: 0 };
  const fixture = await startFixture({
    // Issue #99: pin the detected CLI below the resolved-home floor so the
    // login spec deterministically exercises the legacy env-scoped flow
    // (never the machine's real `claude --version`).
    exec: async (_binary, args) => {
      if (args?.[0] === '--version') return { stdout: 'Claude Code 2.1.215' };
      return { stdout: '' };
    },
    readClaudeAuth: async ({ claudeConfigDir }) => {
      readCalls.claude += 1;
      readCalls.claudeConfigDir = claudeConfigDir;
      return {
        authenticated: true,
        identity: 'user@example.invalid',
        plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
      };
    },
    readCodexAuth: async ({ codexHome }) => {
      readCalls.codex += 1;
      readCalls.codexHome = codexHome;
      return { authenticated: true, identity: 'dev@example.com', plan: { planType: 'plus' } };
    },
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // Step 1 (codex): no profileRef → the daemon creates the owner-only home.
  let result = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'codex', label: 'Deck Codex', purpose: 'testing', color: '#48a868' }),
  });
  assert.equal(result.response.status, 201);
  const codexAccount = result.body.account;
  assert.ok(codexAccount.profileRef.startsWith(fs.realpathSync(fixture.service.codexProfilesDir)));
  assert.equal(fs.statSync(codexAccount.profileRef).mode & 0o777, 0o700);

  // Step 1 (claude): the #17 seam creates the managed profile home.
  result = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'claude', label: 'Deck Claude', purpose: 'testing', color: '#d97757' }),
  });
  assert.equal(result.response.status, 201);
  const claudeAccount = result.body.account;

  // Step 2: login specs are provider-owned commands, never logouts. On a
  // pre-2.1.216 CLI the Claude spec stays env-scoped (issue #99).
  result = await request(fixture, `/api/accounts/${claudeAccount.id}/login`);
  assert.equal(result.response.status, 200);
  assert.match(result.body.command, /CLAUDE_CONFIG_DIR=.*claude.* auth login$/);
  assert.ok(!result.body.command.includes('logout'));
  assert.equal(result.body.flow, 'config-dir');
  assert.equal(result.body.requiresActivation, false);
  result = await request(fixture, `/api/accounts/${codexAccount.id}/login`);
  assert.match(result.body.command, /CODEX_HOME=.*codex.* login$/);
  assert.ok(!result.body.command.includes('logout'));
  // Codex steering is unaffected by #99 — no flow marker.
  assert.equal('flow' in result.body, false);
  assert.equal('requiresActivation' in result.body, false);
  result = await request(fixture, '/api/accounts/nope/login');
  assert.equal(result.response.status, 404);

  // Step 3: verify reads back the identity and persists it on the account.
  result = await request(fixture, `/api/accounts/${claudeAccount.id}/verify`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.authenticated, true);
  assert.equal(result.body.identity, 'user@example.invalid');
  assert.equal(result.body.account.identity, 'user@example.invalid');
  assert.equal(result.body.account.purpose, 'testing');
  assert.equal(result.body.account.color, '#d97757');
  assert.equal(readCalls.claudeConfigDir, claudeAccount.profileRef);
  assert.equal(fixture.store.getAccount(claudeAccount.id).identity, 'user@example.invalid');
  // Issue #26 (Claude half): the same status read persists the plan facts.
  assert.deepEqual(fixture.store.getAccount(claudeAccount.id).metadata.claudePlan, {
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  });
  assert.deepEqual(result.body.account.metadata.claudePlan, {
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  });

  // Codex verify surfaces display-ready plan metadata while retaining the raw
  // JWT claim for future UI mapping changes.
  result = await request(fixture, `/api/accounts/${codexAccount.id}/verify`, { method: 'POST' });
  assert.equal(result.body.authenticated, true);
  assert.equal(result.body.identity, 'dev@example.com');
  assert.deepEqual(result.body.account.metadata.codexPlan, {
    planType: 'plus',
    displayName: 'Plus',
  });
  assert.deepEqual(fixture.store.getAccount(codexAccount.id).metadata.codexPlan, {
    planType: 'plus',
    displayName: 'Plus',
  });
  assert.equal(readCalls.codexHome, codexAccount.profileRef);

  // Verify is a mutation: it must be token-gated.
  const bare = await fetch(`${fixture.base}/api/accounts/${claudeAccount.id}/verify`, { method: 'POST' });
  assert.equal(bare.status, 403);

  // Remove account: reference-only — the profile home stays on disk.
  result = await request(fixture, `/api/accounts/${codexAccount.id}`, { method: 'DELETE' });
  assert.equal(result.body.deleted, true);
  assert.ok(fs.existsSync(codexAccount.profileRef));
});

// Issue #99: on Claude Code >= 2.1.216 credentials key off the resolved
// ~/.claude, so the login spec must be activation-driven (plain
// `claude /login`, no env override) and verify must refuse a read-back
// identity that contradicts the intended account instead of laundering it.
test('resolved-home CLI: activation-driven login spec and identity-mismatch refusal', async (t) => {
  const fixture = await startFixture({
    exec: async (_binary, args) => {
      if (args?.[0] === '--version') return { stdout: 'Claude Code 2.1.216' };
      return { stdout: '' };
    },
    readClaudeAuth: async () => ({
      authenticated: true,
      identity: 'other@example.invalid',
      plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    }),
  });
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  const seeded = fixture.store.listAccounts().find((account) => account.provider === 'claude');
  fixture.store.saveAccount({ ...seeded, identity: 'intended@example.invalid' });

  // The spec drives sign-in through activation, never through env scoping.
  let result = await request(fixture, `/api/accounts/${seeded.id}/login`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.flow, 'activation');
  assert.equal(result.body.requiresActivation, true);
  assert.match(result.body.command, /claude.* \/login$/);
  assert.ok(!result.body.command.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(!result.body.command.includes('logout'));

  // Post-login read-back disagrees with the intended account: the response
  // names the mismatch, reports no bare success, and records nothing.
  result = await request(fixture, `/api/accounts/${seeded.id}/verify`, { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.authenticated, true);
  assert.deepEqual(result.body.identityMismatch, {
    expected: 'intended@example.invalid',
    actual: 'other@example.invalid',
  });
  const stored = fixture.store.getAccount(seeded.id);
  assert.equal(stored.identity, 'intended@example.invalid');
  assert.equal(stored.metadata.claudePlan, undefined);
});

test('codex profile homes outside the managed directory are rejected end to end', async (t) => {
  const fixture = await startFixture();
  t.after(async () => { await fixture.app.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

  // Caller-supplied out-of-tree CODEX_HOME: refused by the service upsert
  // (PR #20 CodeRabbit review — parity with the Claude containment check).
  const outside = path.join(fixture.root, 'outside-codex');
  fs.mkdirSync(outside, { mode: 0o700 });
  const rejected = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'codex', label: 'Stray Codex', profileRef: outside }),
  });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.error, /must be inside ModelDeck's profiles directory/);

  // An in-tree home passes through the same path unchanged.
  const accepted = await request(fixture, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'codex', label: 'Managed Codex', profileRef: fixture.codexHome }),
  });
  assert.equal(accepted.response.status, 201);

  // Legacy/out-of-tree rows (inserted below the service seam) can never leak
  // into a login command either.
  const stray = fixture.store.saveAccount({ provider: 'codex', label: 'Stray Row', profileRef: outside });
  const login = await request(fixture, `/api/accounts/${stray.id}/login`);
  assert.equal(login.response.status, 400);
  assert.match(login.body.error, /must be inside ModelDeck's profiles directory/);
});
