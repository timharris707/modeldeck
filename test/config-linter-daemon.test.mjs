import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { CONFIG_LINT_INTERVAL_MS, ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/config-linter/fire.json', import.meta.url));
const firingSnapshot = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const MUTATION_TOKEN = 'config-lint-mutation-token-placeholder';

function serviceFixture(options = {}) {
  const store = new Store(':memory:');
  const service = new ModelDeckService(store, {
    platform: 'linux',
    listProviderProcesses: async () => [],
    configLintEnabled: true,
    ...options,
  });
  return { store, service, close() { store.close(); } };
}

async function directRequest(app, route, { method = 'GET', authenticated = true } = {}) {
  const req = Object.assign(Readable.from([]), {
    method,
    url: route,
    headers: {
      host: 'localhost:0',
      ...(authenticated ? {
        'x-modeldeck-token': MUTATION_TOKEN,
        cookie: `modeldeck_session=${MUTATION_TOKEN}`,
      } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let payload = '';
  const finished = new Promise((resolve) => {
    req.res = {
      writeHead(nextStatus) { status = nextStatus; },
      end(chunk = '') { payload += chunk; resolve(); },
    };
  });
  await Promise.all([app.server.listeners('request')[0](req, req.res), finished]);
  return { status, body: JSON.parse(payload) };
}

test('on-demand daemon runs replace and serve the latest in-memory report', async (t) => {
  let collections = 0;
  const data = serviceFixture({
    now: () => Date.parse('2026-08-25T12:00:00Z'),
    configLintSnapshotCollector: async () => { collections += 1; return firingSnapshot; },
  });
  t.after(() => data.close());

  assert.deepEqual(data.service.configLintStatus(), { generatedAt: null, findings: [] });
  const report = await data.service.runConfigLint();
  assert.equal(collections, 1);
  assert.equal(report.generatedAt, '2026-08-25T12:00:00.000Z');
  assert.ok(report.findings.some((finding) => finding.ruleId === 'MD-L04'));
  assert.deepEqual(data.service.configLintStatus(), report);
});

test('daemon config lint passes its launchctl override through the shared snapshot options', async (t) => {
  const launchctlPath = '/fixture/bin/launchctl';
  let collectorOptions;
  const data = serviceFixture({
    launchctlPath,
    configLintSnapshotCollector: async (options) => {
      collectorOptions = options;
      return firingSnapshot;
    },
  });
  t.after(() => data.close());

  await data.service.runConfigLint();
  assert.equal(collectorOptions.launchctlPath, launchctlPath);
});

test('collector failure becomes could-not-evaluate findings and never rejects the daemon run', async (t) => {
  const data = serviceFixture({
    configLintSnapshotCollector: async () => { throw new Error('fixture input unreadable'); },
  });
  t.after(() => data.close());
  const report = await data.service.runConfigLint();
  assert.equal(report.findings.length, 16);
  assert.ok(report.findings.every((finding) => /could not evaluate/i.test(finding.message)));
  assert.ok(report.findings.every((finding) => finding.severity !== 'error'));
});

test('scheduler runs immediately, then once per 24 hours, and stops cleanly', async (t) => {
  const timers = [];
  const cleared = [];
  let collections = 0;
  const data = serviceFixture({
    configLintSnapshotCollector: async () => { collections += 1; return { ...firingSnapshot, accounts: [] }; },
    configLintSetTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    configLintClearTimeout: (timer) => { cleared.push(timer); },
  });
  t.after(() => data.close());

  await data.service.startConfigLint();
  assert.equal(collections, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, CONFIG_LINT_INTERVAL_MS);
  await timers[0].callback();
  assert.equal(collections, 2);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, CONFIG_LINT_INTERVAL_MS);
  await data.service.stopConfigLint();
  assert.deepEqual(cleared, [timers[1]]);
});

test('cold daemon lint uses stored duplicate fingerprints before any refresh', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-lint-cold-daemon-'));
  const profiles = path.join(root, 'claude-profiles');
  const firstHome = path.join(profiles, 'first');
  const secondHome = path.join(profiles, 'second');
  for (const home of [firstHome, secondHome]) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'settings.json'), '{}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(home, '.claude.json'), '{}\n', { mode: 0o600 });
  }
  const store = new Store(':memory:');
  const first = store.saveAccount({
    provider: 'claude', label: 'First', identity: 'first@example.invalid', profileRef: firstHome,
  });
  const second = store.saveAccount({
    provider: 'claude', label: 'Second', identity: 'second@example.invalid', profileRef: secondHome,
  });
  store.saveConfigLintFacts({
    installedCliVersions: { claude: '2.1.223' },
    claudeWeeklyFingerprints: { [first.id]: 1_000, [second.id]: 1_000 },
  });
  const timers = [];
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profiles,
    claudeActiveLink: path.join(root, 'missing-active-claude'),
    claudeShellEnvFile: path.join(root, 'missing-claude-env.sh'),
    zshenvPath: path.join(root, 'missing-zshenv'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    codexActiveLink: path.join(root, 'missing-active-codex'),
    cliproxyConfigDir: path.join(root, 'proxy'),
    cliproxyAuthDir: path.join(root, 'proxy', 'auth'),
    cliproxyManagementKeyPath: path.join(root, 'proxy', '.mgmt-key'),
    dataDir: root,
    childEnv: { PATH: path.join(root, 'bin') },
    exec: async () => ({ exitCode: 3, output: '' }),
    platform: 'linux',
    listProviderProcesses: async () => [],
    configLintEnabled: true,
    configLintSetTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
  });
  t.after(async () => {
    await service.stopConfigLint();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const report = await service.startConfigLint();
  const duplicates = report.findings.filter((finding) => (
    finding.ruleId === 'MD-L07' && finding.evidence.some((entry) => entry.source === 'daemon weekly-reset fingerprints')
  ));
  assert.deepEqual(duplicates.map((finding) => finding.scope).sort(), [
    `profile:${first.id}`,
    `profile:${second.id}`,
  ].sort());
  assert.ok(duplicates.every((finding) => finding.severity === 'error'));
  assert.equal(timers[0].delay, CONFIG_LINT_INTERVAL_MS);
});

test('daemon computations persist the exact version and duplicate facts used by one-shot lint', async (t) => {
  const store = new Store(':memory:');
  const first = store.saveAccount({
    provider: 'claude', label: 'First', identity: 'first@example.invalid', profileRef: '/fixture/claude/first',
  });
  const second = store.saveAccount({
    provider: 'claude', label: 'Second', identity: 'second@example.invalid', profileRef: '/fixture/claude/second',
  });
  const service = new ModelDeckService(store, {
    claudePath: '/fixture/bin/claude',
    codexPath: '/fixture/bin/codex',
    platform: 'linux',
    listProviderProcesses: async () => [],
  });
  t.after(() => store.close());
  service.installedToolVersion = async (binary) => (
    binary.endsWith('/claude') ? '2.1.223' : '0.87.0'
  );
  service.latestToolVersion = async () => null;
  service.claudeAuthState = async () => ({ authState: 'unknown', error: null });
  service.codexAuthState = async () => ({ authState: 'unknown', error: null });

  await service.probeTools({ refresh: true });
  service.updateClaudeWeeklyFingerprints([first, second], new Map([
    [first.id, [{ scope: 'weekly', resetsAt: '2026-08-30T12:00:00.000Z', stale: false }]],
    [second.id, [{ scope: 'weekly', resetsAt: '2026-08-30T12:00:00.000Z', stale: false }]],
  ]));

  const facts = store.getConfigLintFacts();
  assert.deepEqual(facts.installedCliVersions, { claude: '2.1.223', codex: '0.87.0' });
  assert.deepEqual(Object.keys(facts.claudeWeeklyFingerprints).sort(), [first.id, second.id].sort());
  assert.equal(new Set(Object.values(facts.claudeWeeklyFingerprints)).size, 1);
});

test('daemon endpoints serve latest findings and guard the on-demand trigger', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let latest = { generatedAt: null, findings: [] };
  let runs = 0;
  const service = {
    projectsRoot: '/fixture/projects',
    configLintStatus: () => latest,
    runConfigLint: async () => {
      runs += 1;
      latest = { generatedAt: '2026-08-25T12:00:00.000Z', findings: [{ ruleId: 'MD-L04' }] };
      return latest;
    },
  };
  const app = createApp({ store, service, host: '127.0.0.1', port: 0, mutationToken: MUTATION_TOKEN });

  assert.deepEqual(await directRequest(app, '/api/config-lint'), { status: 200, body: latest });
  assert.equal((await directRequest(app, '/api/config-lint/run', { method: 'POST', authenticated: false })).status, 403);
  assert.deepEqual(await directRequest(app, '/api/config-lint/run', { method: 'POST' }), { status: 200, body: {
    generatedAt: '2026-08-25T12:00:00.000Z', findings: [{ ruleId: 'MD-L04' }],
  } });
  assert.equal(runs, 1);
  assert.deepEqual((await directRequest(app, '/api/config-lint')).body, latest);
});
