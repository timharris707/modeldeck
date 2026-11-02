import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { DEFAULT_SETTINGS, Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';
import { USAGE_QUEUE_CONSUMER_INTERVAL_MS } from '../src/usage-queue-consumer.mjs';
import { collectConfigLintSnapshot, configLintSnapshotOptions } from '../src/config-linter-snapshot.mjs';
import { evaluateConfigLint } from '../src/config-linter.mjs';

const REMOTE_REASON = 'This Mac uses the proxy pool on another machine; manage it there.';
const TOKEN = 'proxy-role-placeholder';

async function flush() {
  for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-proxy-role-'));
  const claudeHome = path.join(root, 'claude-profiles', 'probe');
  const codexHome = path.join(root, 'codex-profiles', 'probe');
  const cliproxyConfigDir = path.join(root, 'proxy');
  const cliproxyAuthDir = path.join(cliproxyConfigDir, 'auth');
  for (const directory of [claudeHome, codexHome, cliproxyAuthDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const managementKeyPath = path.join(cliproxyConfigDir, '.mgmt-key');
  fs.writeFileSync(managementKeyPath, 'placeholder-management-key', { mode: 0o600 });
  fs.writeFileSync(path.join(cliproxyAuthDir, 'claude.json'), JSON.stringify({
    type: 'claude', email: 'probe@example.invalid', weight: 5,
    access_token: 'placeholder-not-a-credential', excluded_models: ['*fable*'],
  }));
  fs.writeFileSync(path.join(cliproxyAuthDir, 'codex.json'), JSON.stringify({
    type: 'codex', account_id: 'probe-account', weight: 3,
    access_token: 'placeholder-not-a-credential',
  }));
  const store = new Store(':memory:');
  store.saveSettings({ autoRenewEnabled: false, claudeManaged: true, codexManaged: true });
  const claude = store.saveAccount({
    provider: 'claude', label: 'Probe', identity: 'probe@example.invalid',
    profileRef: claudeHome, isDefault: true,
  });
  const codex = store.saveAccount({
    provider: 'codex', label: 'Probe Codex', profileRef: codexHome, isDefault: true,
  });
  const requests = [];
  const managementReads = [];
  const providerReads = [];
  const spawns = [];
  const fetcher = async (url) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    const payload = pathname.endsWith('/auth-files')
      ? { files: [{ type: 'claude', email: 'probe@example.invalid', status: 'active' }] }
      : { usage: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  let now = Date.parse('2026-10-30T12:00:00Z');
  let nextTimer = 0;
  const timers = new Map();
  const service = new ModelDeckService(store, {
    dataDir: root,
    claudeProfilesDir: path.dirname(claudeHome),
    codexProfilesDir: path.dirname(codexHome),
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    claudeShellEnvFile: path.join(root, 'claude-env.sh'),
    cliproxyConfigDir, cliproxyAuthDir, cliproxyManagementKeyPath: managementKeyPath,
    cliproxyBaseUrl: 'http://127.0.0.1:43279',
    platform: 'linux',
    childEnv: { PATH: '/fixture/bin' },
    claudeCredentialsPresent: async () => true,
    listProviderProcesses: async () => [],
    detectForeignUsageConsumers: async () => ({ checked: true, consumers: [], probe: 'ok' }),
    logUsageQueueGuard: () => {},
    logUsageQueue: () => {},
    warnUsageQueue: () => {},
    exec: async () => { throw new Error('unexpected fixture exec'); },
    spawn: (...args) => { spawns.push(args); throw new Error('unexpected fixture spawn'); },
    fetchClaude: async () => { providerReads.push('claude'); return []; },
    fetchCodex: async () => { providerReads.push('codex'); return []; },
    fetchGrok: async () => { providerReads.push('grok'); return []; },
    fetcher, registryFetch: fetcher, usageQueueFetch: fetcher, proxyReloginFetch: fetcher,
    usageQueueReadFile: (...args) => { managementReads.push('queue'); return fs.promises.readFile(...args); },
    proxyReloginReadFile: (...args) => { managementReads.push('repair'); return fs.promises.readFile(...args); },
    proxyAuthOpen: (...args) => fs.promises.open(...args),
    now: () => now,
    proxyReloginNow: () => now,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    ...options,
  });
  service.codexAccountIdentifiers.set(codex.id, 'probe-account');
  const app = createApp({ store, service, host: '127.0.0.1', port: 0, mutationToken: TOKEN });
  t.after(async () => {
    await service.stopAutoRefresh();
    await service.stopUsageQueueConsumer();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const advance = async () => {
    now += USAGE_QUEUE_CONSUMER_INTERVAL_MS;
    for (const [id, timer] of [...timers]) {
      if (timer.due > now) continue;
      timers.delete(id);
      timer.callback();
    }
    await flush();
    await service.usageQueueConsumerPromise;
    await Promise.all([...service.autoRefreshTickTasks]);
    await flush();
  };
  return { root, store, service, app, claude, codex, cliproxyAuthDir, managementKeyPath,
    timers, advance, requests, managementReads, providerReads, spawns };
}

async function request(data, route, { method = 'GET', body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Object.assign(Readable.from(payload ? [Buffer.from(payload)] : []), {
    method, url: route,
    headers: { host: 'localhost:0', 'content-type': 'application/json',
      'x-modeldeck-token': TOKEN, cookie: `modeldeck_session=${TOKEN}` },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let result;
  await data.app.server.listeners('request')[0](req, {
    writeHead: (value) => { status = value; },
    end: (value) => { result = JSON.parse(String(value)); },
  });
  return { status, body: result };
}

test('proxyRole defaults to host, validates, and round-trips through settings and state', async (t) => {
  const data = fixture(t);
  assert.equal(DEFAULT_SETTINGS.proxyRole, 'host');
  data.store.db.prepare('UPDATE settings SET value_json = ? WHERE id = 1')
    .run(JSON.stringify({ autoRenewEnabled: false, claudeManaged: true, codexManaged: true }));
  assert.equal(data.store.getSettings().proxyRole, 'host', 'an older stored settings document has no role');
  assert.deepEqual((await request(data, '/api/state')).body.proxy, { role: 'host' });
  for (const value of ['remote', 'host']) {
    const updated = await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: value } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.proxyRole, value);
    assert.equal((await request(data, '/api/settings')).body.proxyRole, value);
    const state = (await request(data, '/api/state')).body;
    assert.deepEqual(state.proxy, { role: value });
    assert.ok(state.managedProxy, 'the existing proxy status block stays intact');
  }
  for (const value of ['client', '', null, true, 1, {}, []]) {
    const rejected = await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: value } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /proxyRole must be host or remote/);
    assert.equal(data.store.getSettings().proxyRole, 'host');
  }
});

test('TRIPWIRE remote role never calls management or reads auth files across queue and refresh intervals', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ proxyRole: 'remote', usageQueueConsumerEnabled: true });
  const authReads = [];
  for (const [target, methods] of [[fs.promises, ['readdir', 'open', 'readFile', 'lstat']], [fs, ['existsSync']]]) {
    for (const method of methods) {
      const original = target[method];
      t.mock.method(target, method, function (file, ...args) {
        if (String(file) === data.cliproxyAuthDir || String(file).startsWith(`${data.cliproxyAuthDir}${path.sep}`)) {
          authReads.push(method);
        }
        return original.call(this, file, ...args);
      });
    }
  }
  await data.service.startUsageQueueConsumer();
  data.service.startAutoRefresh();
  for (let cycle = 0; cycle < 4; cycle += 1) {
    await data.advance();
    await data.service.state();
    await data.service.proxyCredentialHealth({ force: true });
    await data.service.readProxyWeights({ includeEmpty: true });
  }
  assert.deepEqual(data.requests.filter((pathname) => pathname.startsWith('/v0/management/')), [],
    'remote management requests must stay at ZERO even with the consumer enabled and a readable key');
  assert.deepEqual(authReads, [], 'leftover local auth files must never be inspected');
  assert.deepEqual(data.managementReads, [], 'remote role never reads the local management key');
  assert.equal(data.providerReads.filter((provider) => provider === 'claude').length, 4);
  assert.equal(data.providerReads.filter((provider) => provider === 'codex').length, 4);
  assert.deepEqual(data.spawns, []);
  const status = data.service.usageQueueStatus();
  assert.equal(status.configured, true);
  assert.equal(status.running, false);
  assert.equal(status.code, 'proxy-role-remote');
  assert.equal(status.reason, REMOTE_REASON);
  assert.equal(data.service.usageQueueConsumerTimer, null);
});

test('remote state omits local pool, weight, credential and repair fields even with cached host health', async (t) => {
  const data = fixture(t);
  const host = await data.service.state();
  assert.equal(host.accounts.find((account) => account.id === data.claude.id).proxyPool, 'member');
  assert.equal(host.accounts.find((account) => account.id === data.claude.id).proxyCredential, 'ok');
  data.store.saveSettings({ proxyRole: 'remote' });
  data.requests.length = 0;
  const state = await data.service.state();
  assert.equal(state.codexProfilesDir, data.service.codexProfilesDir, '#791 keys tool needs the daemon root for path validation');
  assert.deepEqual(state.proxy, { role: 'remote' });
  for (const account of state.accounts) {
    for (const key of ['proxyPool', 'proxyWeight', 'proxyFableExcluded', 'proxyCredential', 'proxyCredentialDetail', 'proxyRelogin']) {
      assert.equal(Object.hasOwn(account, key), false, `${key} must be absent`);
    }
  }
  assert.equal(state.accounts.find((account) => account.id === data.claude.id).proxyRouted, false,
    'client routing remains observable');
  assert.deepEqual(data.requests, []);
});

test('remote join and repair endpoints refuse with 409 and the role code without spawning or fetching', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ proxyRole: 'remote' });
  for (const account of [data.claude, data.codex]) {
    assert.deepEqual(data.service.proxyReloginAvailabilityFor(account, true), {
      available: false, code: 'proxy-role-remote', reason: REMOTE_REASON,
    });
    for (const action of ['proxy-pool/join', 'proxy-relogin', 'proxy-relogin/cancel']) {
      const result = await request(data, `/api/accounts/${account.id}/${action}`, { method: 'POST' });
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { error: REMOTE_REASON, code: 'proxy-role-remote' });
    }
  }
  assert.deepEqual(data.requests, []);
  assert.deepEqual(data.spawns, []);
  assert.deepEqual(data.managementReads, []);
});

test('remote repair polling suppresses an existing host session and makes no management call', async (t) => {
  const data = fixture(t);
  data.service.proxyReloginSessions.set(data.claude.id, {
    accountId: data.claude.id, provider: 'claude', state: 'placeholder-state',
    phase: 'awaiting-browser', startedAt: data.service.proxyReloginNow(),
  });
  data.store.saveSettings({ proxyRole: 'remote' });
  const result = await request(data, `/api/accounts/${data.claude.id}/proxy-relogin`);
  assert.equal(result.status, 200);
  assert.equal(result.body.available, false);
  assert.equal(result.body.code, 'proxy-role-remote');
  assert.equal(result.body.reason, REMOTE_REASON);
  assert.deepEqual(data.requests, []);
});

test('settings PUT host to remote disarms the queue and remote to host respects both existing gates', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  await data.service.startUsageQueueConsumer();
  await data.service.usageQueueConsumerPromise;
  await flush();
  assert.equal(data.requests.length, 1);
  const oldTimer = data.timers.get(data.service.usageQueueConsumerTimer);
  assert.ok(oldTimer);
  let result = await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'remote' } });
  assert.equal(result.status, 200);
  assert.equal(data.timers.size, 0);
  oldTimer.callback();
  await data.advance();
  assert.equal(data.requests.length, 1, 'a stale callback cannot consume after the PUT');
  result = await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'host' } });
  assert.equal(result.status, 200);
  await data.service.usageQueueConsumerPromise;
  await flush();
  assert.equal(data.requests.length, 2);
  assert.equal(data.timers.size, 1);
  await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'remote', usageQueueConsumerEnabled: false } });
  await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'host' } });
  assert.equal(data.timers.size, 0);
  assert.equal(data.requests.length, 2, 'host alone never opts into consumption');
  await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'remote', usageQueueConsumerEnabled: true } });
  data.service.detectForeignUsageConsumers = async () => ({ checked: true, consumers: ['placeholder-poller'], probe: 'ok' });
  await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'host' } });
  assert.equal(data.requests.length, 2);
  assert.equal(data.service.usageQueueStatus().guard.status, 'blocked');
  assert.equal(data.timers.size, 0);
});

test('host to remote PUT waits for an already destructive pull to finish without rearming', async (t) => {
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const data = fixture(t, { usageQueueFetch: async () => { entered.resolve(); return response.promise; } });
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  await data.service.startUsageQueueConsumer();
  await entered.promise;
  let finished = false;
  const updating = request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'remote' } })
    .then((result) => { finished = true; return result; });
  try {
    await flush();
    assert.equal(finished, false);
    assert.equal(data.service.usageQueueStatus().inFlight, true);
  } finally {
    response.resolve({ ok: true, status: 200, text: async () => '{"usage":[]}' });
  }
  assert.equal((await updating).status, 200);
  assert.equal(data.service.usageQueueStatus().inFlight, false);
  assert.equal(data.timers.size, 0);
});

test('queue pulls recheck a stored remote role after the foreign-consumer guard awaits', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  await data.service.startUsageQueueConsumer();
  await data.service.usageQueueConsumerPromise;
  await flush();
  data.requests.length = 0;
  data.service.detectForeignUsageConsumers = async () => {
    data.store.saveSettings({ proxyRole: 'remote' });
    return { checked: true, consumers: [], probe: 'ok' };
  };
  await data.advance();
  assert.deepEqual(data.requests, []);
  assert.equal(data.timers.size, 0);
  assert.equal(data.service.usageQueueStatus().running, false);
});

test('direct queue pulls recheck the persisted role in their deferred callback', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  const pending = data.service.pullUsageQueue();
  data.store.saveSettings({ proxyRole: 'remote' });
  await pending;
  assert.deepEqual(data.requests, []);
  await data.service.pullUsageQueue();
  assert.deepEqual(data.requests, []);
});

test('queue pulls recheck the persisted role after reading the management key', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const data = fixture(t, { usageQueueReadFile: async () => {
    entered.resolve();
    await release.promise;
    return 'placeholder-management-key';
  } });
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  const pending = data.service.pullUsageQueue();
  await entered.promise;
  data.store.saveSettings({ proxyRole: 'remote' });
  release.resolve();
  await pending;
  assert.deepEqual(data.requests, []);
});

test('remote configuration snapshots do not inspect leftover auth files or the management key', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ proxyRole: 'remote' });
  const reads = [];
  const io = {};
  for (const method of ['open', 'lstat', 'readFile', 'readdir', 'access', 'realpath']) {
    io[method] = async (file, ...args) => {
      if (String(file).startsWith(data.cliproxyAuthDir) || file === data.managementKeyPath) reads.push(method);
      return fs.promises[method](file, ...args);
    };
  }
  const snapshot = await collectConfigLintSnapshot({
    ...configLintSnapshotOptions(data.service),
    zshenvPath: path.join(data.root, '.zshenv'),
    runtimeEnv: { MODELDECK_CLIPROXY_CONFIG_DIR: path.dirname(data.cliproxyAuthDir) },
    readLaunchd: async () => ({ status: 'not-installed' }),
    ...io,
  });
  assert.deepEqual(reads, []);
  assert.equal(snapshot.proxy.code, 'proxy-role-remote');
  assert.equal(snapshot.proxy.reason, REMOTE_REASON);
});

test('a role change during state assembly cannot publish stale host pool fields', async (t) => {
  const data = fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  data.service.accountSharedTranscriptState = async () => {
    entered.resolve();
    await release.promise;
    return {};
  };
  const pending = data.service.state();
  await entered.promise;
  data.store.saveSettings({ proxyRole: 'remote' });
  release.resolve();
  const state = await pending;
  assert.deepEqual(state.proxy, { role: 'remote' });
  for (const account of state.accounts) {
    for (const key of ['proxyPool', 'proxyWeight', 'proxyFableExcluded', 'proxyCredential', 'proxyCredentialDetail', 'proxyRelogin']) {
      assert.equal(Object.hasOwn(account, key), false, `${key} must not survive a role change`);
    }
  }
});

test('a failed combined settings PUT restores the proxy role along with the consumer gate', async (t) => {
  const data = fixture(t);
  data.store.saveSettings({ usageQueueConsumerEnabled: true });
  await data.service.startUsageQueueConsumer();
  await data.service.usageQueueConsumerPromise;
  await flush();
  data.service.applySharedScopeSettings = async () => {
    throw Object.assign(new Error('placeholder shared-scope conflict'), { statusCode: 409 });
  };
  const rejected = await request(data, '/api/settings', { method: 'PUT', body: {
    proxyRole: 'remote', sharedUserScopeEnabled: true,
  } });
  assert.equal(rejected.status, 409);
  assert.equal(data.store.getSettings().proxyRole, 'host');
  assert.equal(data.service.usageQueueStatus().running, true);
});

test('a role change during a repair key read prevents the management request', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0;
  const data = fixture(t, { proxyReloginReadFile: async () => {
    if (++reads === 2) {
      entered.resolve();
      await release.promise;
    }
    return 'placeholder-management-key';
  } });
  const pending = request(data, `/api/accounts/${data.claude.id}/proxy-relogin`, { method: 'POST' });
  await entered.promise;
  data.store.saveSettings({ proxyRole: 'remote' });
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'proxy-role-remote');
  assert.deepEqual(data.requests, []);
});

test('TRIPWIRE a role change to remote during a pool join stops the login helper', async (t) => {
  const kills = [];
  let child;
  let data;
  data = fixture(t, {
    cliproxyPath: '/fixture/bin/cliproxyapi',
    spawn: (_bin, args) => {
      child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, args, kill: (signal) => kills.push(signal) });
      return child;
    },
    // The first wait in the join loop is where the operator's PUT lands.
    proxyJoinWait: async () => { data.store.saveSettings({ proxyRole: 'remote' }); return false; },
  });
  fs.writeFileSync(path.join(path.dirname(data.cliproxyAuthDir), 'config.yaml'), 'port: 1\n');
  const other = data.store.saveAccount({ provider: 'claude', label: 'Other', identity: 'other@example.invalid',
    profileRef: path.join(data.root, 'claude-profiles', 'other') });
  await assert.rejects(data.service.joinProxyPool(other.id), (error) => error.code === 'proxy-role-remote');
  assert.ok(child, 'the login helper was spawned while the role was host');
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
});

test('a role change during a repair status poll reports the role, not a failed sign-in', async (t) => {
  let gate = null;
  const data = fixture(t, { proxyReloginReadFile: async () => {
    if (gate) {
      const held = gate;
      gate = null;
      held.entered.resolve();
      await held.release.promise;
    }
    return 'placeholder-management-key';
  } });
  data.service.proxyReloginSessions.set(data.claude.id, {
    accountId: data.claude.id, provider: 'claude', state: 'placeholderstate123',
    phase: 'awaiting-browser', startedAt: data.service.proxyReloginNow(), detail: null,
  });
  const held = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  gate = held;
  const pending = data.service.proxyReloginState(data.claude.id);
  await held.entered.promise;
  data.store.saveSettings({ proxyRole: 'remote' });
  held.release.resolve();
  const during = await pending;
  assert.equal(during.phase, 'idle');
  assert.equal(during.code, 'proxy-role-remote');
  assert.equal(data.service.proxyReloginSessions.get(data.claude.id).phase, 'awaiting-browser');
  assert.deepEqual(data.requests, []);
});

test('remote role raises no pool lint findings for a profile routed through the forwarder', async (t) => {
  const data = fixture(t);
  fs.writeFileSync(path.join(data.root, 'claude-profiles', 'probe', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: data.service.cliproxyBaseUrl } }));
  data.store.saveSettings({ proxyRole: 'remote' });
  const findings = evaluateConfigLint(await collectConfigLintSnapshot({
    ...configLintSnapshotOptions(data.service), zshenvPath: path.join(data.root, '.zshenv'),
    runtimeEnv: {}, readLaunchd: async () => ({ status: 'not-installed' }),
  }));
  const list = Array.isArray(findings) ? findings : findings.findings || [];
  assert.deepEqual(list.filter((finding) => /MD-L(03|13|14)/.test(finding.ruleId || finding.rule || '')), []);
});

test('a lint report taken as host is not served after the role becomes remote', async (t) => {
  const data = fixture(t);
  fs.writeFileSync(path.join(data.cliproxyAuthDir, 'stray.json'),
    JSON.stringify({ type: 'claude', email: 'stray@example.invalid', weight: 7 }));
  await data.service.runConfigLint();
  assert.match(JSON.stringify(data.service.configLintStatus()), /stray@example\.invalid/);
  const put = await request(data, '/api/settings', { method: 'PUT', body: { proxyRole: 'remote' } });
  assert.equal(put.status, 200);
  const lint = await request(data, '/api/config-lint');
  assert.equal(lint.body.generatedAt, null);
  assert.doesNotMatch(JSON.stringify(lint.body), /stray@example\.invalid|auth/);
});
