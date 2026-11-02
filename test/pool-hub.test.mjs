import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DEFAULT_SETTINGS, Store } from '../src/db.mjs';
import { ModelDeckService, POOL_HUB_POLL_MS } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';

const INTERVAL = POOL_HUB_POLL_MS;
const HUB = 'http://studio:3871';
const TOKEN = 'hub-placeholder';
const status = (sources = [{ name: 'studio', reachable: true, readAt: '2026-10-30T00:00:00Z', ok: true }]) => ({
  generatedAt: '2026-10-30T00:00:00Z', sources,
});
const answer = (value = status()) => new Response(JSON.stringify(value));
const flush = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve(); };

function fixture(t, fetcher = async () => answer(), { start = true, demoFixtures = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-hub-'));
  const store = new Store(':memory:');
  store.saveSettings({ autoRenewEnabled: false, autoRefreshEnabled: false });
  let now = Date.parse('2026-10-30T01:00:00Z');
  const timers = new Map();
  const requests = [];
  const logs = [];
  const unexpected = async () => { throw new Error('unexpected fixture IO'); };
  const service = new ModelDeckService(store, {
    dataDir: root, claudeProfilesDir: path.join(root, 'claude'), codexProfilesDir: path.join(root, 'codex'),
    claudeActiveLink: path.join(root, 'active-claude'), codexActiveLink: path.join(root, 'active-codex'),
    claudeShellEnvFile: path.join(root, 'env.sh'), zshenvPath: path.join(root, '.zshenv'),
    platform: 'linux', demoFixtures, exec: unexpected, spawn: unexpected,
    fetchClaude: unexpected, fetchCodex: unexpected, fetchGrok: unexpected,
    fetcher: unexpected, registryFetch: unexpected, usageQueueFetch: unexpected, proxyReloginFetch: unexpected,
    poolHubFetch: async (...args) => { requests.push(args); return fetcher(...args); },
    logPoolHub: (line) => logs.push(line),
    listProviderProcesses: async () => [],
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { callback, due: now + delay, unref() { this.unrefed = true; } };
      timers.set(timer, timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const app = createApp({ store, service, host: '127.0.0.1', port: 0, mutationToken: TOKEN });
  if (start) service.startAutoRefresh();
  t.after(async () => { await service.stopAutoRefresh(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(route, method = 'GET', body) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method, url: route, headers: { host: 'localhost:0', 'content-type': 'application/json',
        'x-modeldeck-token': TOKEN, cookie: `modeldeck_session=${TOKEN}` }, socket: { remoteAddress: '127.0.0.1' },
    });
    let code, result;
    await app.server.listeners('request')[0](req, {
      writeHead: (value) => { code = value; }, end: (value) => { result = JSON.parse(String(value)); },
    });
    await flush();
    return { code, body: result };
  }
  const put = (body) => request('/api/settings', 'PUT', body);
  const proxy = async () => (await request('/api/state')).body.proxy;
  async function advance(ms = INTERVAL) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due > now) continue;
      timers.delete(id);
      timer.callback();
    }
    await flush();
  }
  return { store, service, requests, logs, timers, request, put, proxy, advance,
    jump: (ms) => { now += ms; }, now: () => new Date(now).toISOString() };
}

test('hub lastFailedAt records failure completion and survives recovery', async (t) => {
  for (const [name, failure] of [
    ['network', () => { throw new Error('private network detail'); }],
    ['HTTP', () => new Response('private body', { status: 503 })],
    ['oversized', () => new Response('x'.repeat(64 * 1024 + 1))],
    ['JSON', () => new Response('private invalid JSON')],
    ['shape', () => answer({ private: 'invalid shape' })],
    ['timeout', () => new Promise(() => {})],
  ]) await t.test(name, async (t) => {
    let response = () => answer();
    const d = fixture(t, () => response());
    await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
    const first = d.now();
    assert.equal((await d.proxy()).hub.lastFailedAt, null);
    const held = Promise.withResolvers();
    response = () => held.promise.then(failure);
    await d.advance();
    const attempted = d.now();
    d.jump(1234);
    assert.equal((await d.proxy()).hub.lastFailedAt, null, 'an unfinished read is not a failure');
    held.resolve();
    await flush();
    if (name === 'timeout') await d.advance(10_000 - 1234);
    const failed = d.now();
    assert.deepEqual((await d.proxy()).hub, {
      url: HUB, lastAttemptAt: attempted, lastAnsweredAt: first, lastFailedAt: failed, lastReadOk: true,
    });
    response = () => answer(status([]));
    await d.advance();
    assert.deepEqual((await d.proxy()).hub, {
      url: HUB, lastAttemptAt: d.now(), lastAnsweredAt: d.now(), lastFailedAt: failed, lastReadOk: false,
    }, 'a valid page with unhealthy sources is still an answer');
    response = () => answer();
    await d.advance();
    assert.equal((await d.proxy()).hub.lastFailedAt, failed, 'recovery retains the failure history');
    assert.equal((await d.proxy()).hub.lastReadOk, true);
    assert.deepEqual(d.logs, ['[modeldeck] pool hub status read failed']);
  });
});

test('state catches up after sleep once per interval without awaiting or overlapping hub reads', async (t) => {
  let response = () => answer();
  const d = fixture(t, () => response());
  await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  const oldTimer = [...d.timers.values()][0];
  const held = Promise.withResolvers();
  response = () => held.promise;
  d.jump(10 * INTERVAL); // Sleep advances wall time without dispatching Node timers.
  const state = await d.proxy();
  assert.equal(d.requests.length, 2, 'the first state read must start one catch-up');
  assert.equal(state.hub.lastAttemptAt, d.now(), 'state responds while the fetch is still pending');
  assert.equal(d.timers.has(oldTimer), false, 'catch-up retires the pre-sleep timer');
  for (let read = 0; read < 3; read++) await d.proxy();
  oldTimer.callback();
  await flush();
  assert.equal(d.requests.length, 2, 'pending reads and stale timers cannot overlap');
  held.resolve(answer());
  await flush();
  assert.equal(d.timers.size, 1);
  assert.equal([...d.timers.values()][0].due, Date.parse(d.now()) + INTERVAL);
  d.jump(INTERVAL - 1);
  for (let read = 0; read < 3; read++) await d.proxy();
  assert.equal(d.requests.length, 2, 'completed catch-up must not poll on every state read');
  response = () => { throw new Error('private failure'); };
  d.jump(2);
  await d.proxy();
  assert.equal(d.requests.length, 3);
  for (let read = 0; read < 3; read++) await d.proxy();
  assert.equal(d.requests.length, 3, 'failed catch-up also waits a full interval');
});

test('state starts the first hub read when a running service has never attempted one', async (t) => {
  const d = fixture(t);
  d.store.saveSettings({ proxyRole: 'remote', poolHubUrl: HUB });
  await d.proxy();
  assert.equal(d.requests.length, 1);
  await d.proxy();
  assert.equal(d.requests.length, 1);
});

test('poolHubUrl refuses local host aliases', async (t) => {
  for (const host of ['localhost', 'ip6-localhost', 'other-localhost', 'broadcasthost',
    'localhost.ts.net', 'localhost.tail1234.ts.net', 'LOCALHOST']) {
    await t.test(host, async (t) => {
      const d = fixture(t);
      const result = await d.put({ poolHubUrl: `http://${host}:3871` });
      assert.equal(result.code, 400);
      assert.match(result.body.error, /poolHubUrl/);
      assert.equal(d.store.getSettings().poolHubUrl, '');
      d.store.db.prepare('UPDATE settings SET value_json = ? WHERE id = 1')
        .run(JSON.stringify({ poolHubUrl: `http://${host}:3871` }));
      assert.equal(d.store.getSettings().poolHubUrl, '', 'persisted aliases also fail closed');
    });
  }
});

test('hub reads stay disabled before service startup and throughout demo mode', async (t) => {
  for (const demoFixtures of [false, true]) await t.test(demoFixtures ? 'demo' : 'before startup', async (t) => {
    const d = fixture(t, undefined, { start: false, demoFixtures });
    await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
    assert.deepEqual((await d.proxy()).hub, {
      url: HUB, lastAttemptAt: null, lastAnsweredAt: null, lastFailedAt: null, lastReadOk: null,
    });
    assert.equal(d.requests.length, 0, 'settings PUT and state must not read before startup');
    d.service.reschedulePoolHub();
    await d.service.readPoolHub();
    await d.advance(10 * INTERVAL);
    await d.proxy();
    assert.equal(d.requests.length, 0);
    assert.equal(d.timers.size, 0);
    d.service.startAutoRefresh();
    await flush();
    if (demoFixtures) {
      await d.put({ poolHubUrl: 'http://other-studio:3871' });
      d.service.reschedulePoolHub();
      await d.service.readPoolHub();
      await d.advance(10 * INTERVAL);
      await d.proxy();
      assert.equal(d.requests.length, 0, 'demo startup, settings and state never arm hub reads');
      assert.equal(d.timers.size, 0);
    } else {
      assert.equal(d.requests.length, 1, 'normal startup starts the first read');
    }
  });
});

test('poolHubUrl validates, normalizes and round-trips settings and remote state', async (t) => {
  const d = fixture(t);
  assert.equal(DEFAULT_SETTINGS.poolHubUrl, '');
  assert.deepEqual(await d.proxy(), { role: 'host' });
  for (const url of [HUB, 'https://studio.tail1234.ts.net', 'http://100.101.102.103:3871', 'http://100.64.0.0', 'http://100.127.255.255']) {
    assert.equal((await d.put({ poolHubUrl: url })).code, 200);
    assert.equal(d.store.getSettings().poolHubUrl, url);
  }
  assert.equal((await d.put({ poolHubUrl: 'HTTP://STUDIO:3871/usage///', proxyRole: 'remote' })).code, 200);
  assert.equal(d.store.getSettings().poolHubUrl, `${HUB}/usage`);
  assert.deepEqual(await d.proxy(), { role: 'remote', hub: {
    url: `${HUB}/usage`, lastAttemptAt: d.now(), lastAnsweredAt: d.now(), lastFailedAt: null, lastReadOk: true,
  } });
  assert.equal((await d.put({ poolHubUrl: '' })).code, 200);
  assert.deepEqual(await d.proxy(), { role: 'remote' });
  for (const url of ['http://127.0.0.1', 'http://192.168.1.5', 'https://example.com', 'http://user:pass@studio',
    'http://studio?q=x', 'http://studio?', 'http://studio#', 'ftp://studio', 'javascript:studio',
    'http://100.63.255.255', 'http://100.128.0.0', 'http://[::1]', '//studio', 'http:studio',
    'http://studio/\n', `http://studio/${'a'.repeat(256)}`, null, 1, {}]) {
    const rejected = await d.put({ poolHubUrl: url });
    assert.equal(rejected.code, 400, String(url));
    assert.match(rejected.body.error, /poolHubUrl/);
    assert.equal(d.store.getSettings().poolHubUrl, '');
  }
});

test('TRIPWIRE host role never fetches the hub across several timer intervals', async (t) => {
  const d = fixture(t);
  assert.equal((await d.put({ poolHubUrl: HUB })).code, 200);
  d.service.startAutoRefresh();
  for (let cycle = 0; cycle < 4; cycle++) {
    await d.advance();
    assert.deepEqual(await d.proxy(), { role: 'host' });
  }
  assert.equal(d.requests.length, 0, 'host hub requests must stay at ZERO');
});

test('remote hub polls use only credential-free GET status requests every minute', async (t) => {
  const d = fixture(t);
  await d.put({ proxyRole: 'remote', poolHubUrl: `${HUB}/usage/` });
  assert.equal(d.requests.length, 1);
  for (const timer of d.timers.values()) assert.equal(timer.unrefed, true);
  await d.advance(INTERVAL - 1);
  assert.equal(d.requests.length, 1);
  await d.put({ layout: 'single-column' });
  await d.put({ poolHubUrl: `${HUB}/usage/`, proxyRole: 'remote' });
  await d.proxy();
  assert.equal(d.requests.length, 1, 'settings echoes and state reads do not poll');
  await d.advance(1);
  await d.advance();
  assert.equal(d.requests.length, 3);
  for (const [url, init] of d.requests) {
    assert.equal(url, `${HUB}/api/status`); // status lives at the page root; /usage is the browser URL
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual([...new Headers(init.headers)], []);
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('hub lastAnsweredAt survives failures and lastReadOk reflects the latest page answer', async (t) => {
  let response = () => answer();
  const d = fixture(t, () => response());
  await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  const first = (await d.proxy()).hub.lastAnsweredAt;
  response = () => { throw new Error('private response detail'); };
  await d.advance();
  assert.deepEqual((await d.proxy()).hub, { url: HUB, lastAttemptAt: d.now(), lastAnsweredAt: first, lastFailedAt: d.now(), lastReadOk: true });
  await d.advance();
  assert.deepEqual(d.logs, ['[modeldeck] pool hub status read failed']);
  response = () => answer(status([{ name: 'studio', reachable: true, readAt: null, ok: false }]));
  await d.advance();
  assert.equal((await d.proxy()).hub.lastReadOk, false, 'reachable does not override explicit ok:false');
  assert.equal((await d.proxy()).hub.lastAnsweredAt, d.now());
  assert.equal(d.logs.length, 1, 'a continued page read failure does not repeat the log');
  response = () => answer(status([{ name: 'studio', reachable: true, readAt: null }]));
  await d.advance();
  assert.equal((await d.proxy()).hub.lastReadOk, true, 'older pages fall back to reachable');
  response = () => answer(status([]));
  await d.advance();
  assert.equal((await d.proxy()).hub.lastReadOk, false);
  assert.equal(d.logs.length, 2, 'a new failure after recovery logs once');
  response = () => answer(status([
    { name: 'one', reachable: true, readAt: null, ok: false },
    { name: 'two', reachable: false, readAt: null, ok: true },
  ]));
  await d.advance();
  assert.equal((await d.proxy()).hub.lastReadOk, true);
});

test('hub rejects non-JSON, invalid status, HTTP errors and bodies over 64 KiB without losing the last answer', async (t) => {
  let response = () => answer();
  const d = fixture(t, () => response());
  await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  const first = (await d.proxy()).hub.lastAnsweredAt;
  let cancelled = false;
  for (const bad of [
    () => new Response('private not-json text'), () => answer(null), () => answer({}),
    () => answer({ ...status(), generatedAt: 'yesterday' }),
    () => answer(status([{ name: 'studio', reachable: true, readAt: null, ok: 'yes' }])),
    () => new Response(JSON.stringify(status()), { status: 503 }),
    () => new Response(' '.repeat(64 * 1024 + 1)),
    () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024)); controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    })),
  ]) {
    response = bad;
    await d.advance();
    assert.equal((await d.proxy()).hub.lastAnsweredAt, first);
    assert.equal((await d.proxy()).hub.lastReadOk, true);
    assert.equal((await d.proxy()).hub.lastAttemptAt, d.now());
  }
  assert.equal(cancelled, true);
  assert.deepEqual(d.logs, ['[modeldeck] pool hub status read failed']);
  const json = JSON.stringify({ ...status(), untrusted: 'do not expose this' });
  response = () => new Response(json.padEnd(64 * 1024));
  await d.advance();
  assert.equal((await d.proxy()).hub.lastAnsweredAt, d.now(), 'exactly 64 KiB is accepted');
  assert.deepEqual(Object.keys((await d.proxy()).hub).sort(), ['lastAnsweredAt', 'lastAttemptAt', 'lastFailedAt', 'lastReadOk', 'url']);
});

test('hub timeout covers stalled headers and body, aborts at ten seconds and retries on its own timer', async (t) => {
  for (const stalledBody of [false, true]) {
    let cancelled = false;
    const d = fixture(t, async () => stalledBody ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : new Promise(() => {}));
    await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
    assert.deepEqual((await d.proxy()).hub, { url: HUB, lastAttemptAt: d.now(), lastAnsweredAt: null, lastFailedAt: null, lastReadOk: null });
    await d.advance(9999);
    assert.equal(d.requests[0][1].signal.aborted, false);
    await d.advance(1);
    assert.equal(d.requests[0][1].signal.aborted, true);
    assert.equal(d.logs.length, 1);
    if (stalledBody) assert.equal(cancelled, true, 'a timed-out body is cancelled');
    await d.advance(INTERVAL - 1);
    assert.equal(d.requests.length, 1);
    await d.advance(1);
    assert.equal(d.requests.length, 2);
  }
});

test('role and URL PUT changes restart or stop polling and stale callbacks cannot fetch', async (t) => {
  const d = fixture(t);
  await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  const oldTimer = [...d.timers.values()][0];
  await d.put({ poolHubUrl: 'http://other-studio:3871' });
  assert.equal(d.requests.length, 2);
  oldTimer.callback();
  await flush();
  assert.equal(d.requests.length, 2, 'cancelled callbacks must not poll the new hub early');
  await d.put({ proxyRole: 'host' });
  assert.deepEqual(await d.proxy(), { role: 'host' });
  assert.equal(d.timers.size, 0);
  await d.advance();
  assert.equal(d.requests.length, 2);
  await d.put({ proxyRole: 'remote' });
  assert.equal(d.requests.length, 3);
  await d.put({ poolHubUrl: '' });
  assert.deepEqual(await d.proxy(), { role: 'remote' });
  assert.equal(d.timers.size, 0);
  await d.advance();
  assert.equal(d.requests.length, 3);
});

test('hub stopAutoRefresh aborts in-flight work and ignores late replies after a URL change', async (t) => {
  const held = [];
  const d = fixture(t, () => { const reply = Promise.withResolvers(); held.push(reply); return reply.promise; });
  await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  await d.put({ poolHubUrl: 'http://other-studio:3871' });
  assert.equal(d.requests[0][1].signal.aborted, true);
  held[0].resolve(answer());
  await flush();
  assert.equal((await d.proxy()).hub.lastAnsweredAt, null);
  assert.equal((await d.proxy()).hub.url, 'http://other-studio:3871');
  await d.service.stopAutoRefresh();
  assert.equal(d.requests[1][1].signal.aborted, true);
  held[1].resolve(answer());
  await flush();
  assert.equal(d.timers.size, 0);
  await d.advance();
  assert.equal(d.requests.length, 2);
  assert.equal((await d.proxy()).hub.lastAnsweredAt, null);
});

test('hub starts at daemon startup with provider refresh disabled and failed settings PUT rolls URL back', async (t) => {
  const d = fixture(t, undefined, { start: false });
  d.store.saveSettings({ proxyRole: 'remote', poolHubUrl: HUB });
  d.service.startAutoRefresh();
  await flush();
  assert.equal(d.requests.length, 1);
  d.service.applySharedScopeSettings = async () => { throw Object.assign(new Error('placeholder conflict'), { statusCode: 409 }); };
  const failed = await d.put({ proxyRole: 'host', poolHubUrl: 'http://other-studio:3871', sharedUserScopeEnabled: true });
  assert.equal(failed.code, 409);
  assert.equal(d.store.getSettings().poolHubUrl, HUB);
  assert.equal(d.store.getSettings().proxyRole, 'remote');
  await d.advance();
  assert.equal(d.requests.length, 2);
  assert.equal(d.requests[1][0], `${HUB}/api/status`);
});

test('poolHubUrl remains valid after normalization and invalid persisted URLs fall back to empty', async (t) => {
  const d = fixture(t);
  const expanded = `http://studio/${'é'.repeat(100)}`;
  assert.ok(expanded.length <= 256);
  assert.equal((await d.put({ poolHubUrl: expanded })).code, 400, 'encoded stored URL must also fit the bound');
  const exact = `http://studio/${'a'.repeat(242)}`;
  assert.equal(exact.length, 256);
  assert.equal((await d.put({ poolHubUrl: exact })).code, 200);
  assert.equal(d.store.getSettings().poolHubUrl, exact);
  d.store.db.prepare('UPDATE settings SET value_json = ? WHERE id = 1').run(JSON.stringify({ poolHubUrl: 'http://127.0.0.1' }));
  assert.equal(d.store.getSettings().poolHubUrl, '');
});

test('failed combined PUT resumes the old hub when its pending read finishes during rollback', async (t) => {
  const reply = Promise.withResolvers();
  let reads = 0;
  const d = fixture(t, () => ++reads === 1 ? reply.promise : answer());
  await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  d.service.applySharedScopeSettings = async () => {
    reply.resolve(answer());
    await flush();
    throw Object.assign(new Error('placeholder conflict'), { statusCode: 409 });
  };
  const failed = await d.put({ proxyRole: 'host', sharedUserScopeEnabled: true });
  assert.equal(failed.code, 409);
  assert.equal((await d.proxy()).hub.url, HUB);
  await d.advance();
  assert.ok(d.requests.length >= 2, 'rollback must resume the old hub after losing its in-flight read');
  assert.equal((await d.proxy()).hub.lastAnsweredAt, d.now());
});

test('a settings PUT finishing during shutdown cannot restart hub polling', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const d = fixture(t);
  d.service.applySharedScopeSettings = async () => { entered.resolve(); await release.promise; };
  const pending = d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  await entered.promise;
  await d.service.stopAutoRefresh();
  release.resolve();
  assert.equal((await pending).code, 200);
  await d.advance();
  assert.equal(d.requests.length, 0, 'a draining settings request must not restart a stopped service');
  assert.equal(d.timers.size, 0);
  d.service.startAutoRefresh();
  await flush();
  assert.equal(d.requests.length, 1, 'an explicit lifecycle restart enables polling again');
});

test('a state read during a settings PUT that later rolls back never reads the rejected hub URL', async (t) => {
  const d = fixture(t);
  await d.put({ proxyRole: 'remote', poolHubUrl: HUB });
  d.service.applySharedScopeSettings = async () => {
    await d.request('/api/state'); // the deck's poll lands mid-PUT
    throw Object.assign(new Error('placeholder conflict'), { statusCode: 409 });
  };
  const failed = await d.put({ poolHubUrl: 'http://other-studio:3871', sharedUserScopeEnabled: true });
  assert.equal(failed.code, 409);
  assert.equal(d.requests.some(([url]) => String(url).startsWith('http://other-studio')), false);
});
