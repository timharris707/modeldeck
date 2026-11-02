import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Read only these test inputs before installing the fail-closed runtime guards.
const installer = await fs.readFile(new URL('./launch-agent.sh', import.meta.url), 'utf8');
const configSource = await fs.readFile(new URL('./config.mjs', import.meta.url), 'utf8');
const readme = await fs.readFile(new URL('./README.md', import.meta.url), 'utf8');
const page = await fs.readFile(new URL('./index.html', import.meta.url), 'utf8');

// Fail closed: importing or building a deck must never do live I/O.
const forbidden = () => { throw new Error('Live I/O is forbidden in phone deck tests'); };
mock.method(http, 'createServer', forbidden);
mock.method(childProcess, 'execFile', forbidden);
mock.method(fs, 'readdir', forbidden);
mock.method(fs, 'readFile', forbidden);
mock.method(globalThis, 'fetch', forbidden);
syncBuiltinESMExports();
const {
  createDeckReader, buildDeck, mergeAccounts, headlineOf, weightOf, windowTitle, windowRank,
  severity, hidden, planLabel, signInOf, hostAllowed, SAFE_PATH, DOWN_AFTER, handle, isMain, hubPoolOf,
} = await import('./server.mjs');
const { poolMemberTag } = await import('../../src/pool-member-tag.mjs');
after(() => {
  try {
    for (const fn of [http.createServer, childProcess.execFile, fs.readdir, fs.readFile, globalThis.fetch]) {
      assert.equal(fn.mock.callCount(), 0, 'No live I/O may even be attempted');
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

// The installer runs /usr/bin/plutil, which exists only on macOS (CodeRabbit, PR #793).
const MACOS_ONLY = process.platform === 'darwin' ? false : 'installer runs /usr/bin/plutil (macOS only)';
const NOW = Date.parse('2026-10-22T12:00:00Z');
const machine = (name, accounts = [], usage = []) => ({
  name, remote: name === 'M5', ok: true, stateAt: NOW,
  state: { accounts, usage }, forecast: null,
});
const account = (id, extra = {}) => ({ id, provider: 'claude', label: 'Probe', enabled: true, ...extra });
const usage = (accountId, scope, remainingPercent, age = 0) => ({
  accountId, scope, remainingPercent,
  observedAt: new Date(NOW - age).toISOString(),
  resetsAt: '2026-10-24T12:00:00Z',
});

test('merge: same account on both Macs becomes one card with freshest reading per window', () => {
  const states = {
    M5: machine('M5', [account('remote')], [usage('remote', 'week', 70), usage('remote', '5h', 40, 60_000)]),
    M1: machine('M1', [account('local')], [usage('local', 'week', 90, 60_000), usage('local', '5h', 20)]),
  };
  const deck = buildDeck(states, NOW);
  assert.equal(deck.accounts.length, 1);
  assert.deepEqual(deck.accounts[0].windows.map((w) => [w.title, w.remaining, w.source]), [
    ['5-hour limit', 20, 'M1'], ['Weekly · all models', 70, 'M5'],
  ]);
});

test('import and pure deck building perform no network, process, or filesystem reads', () => {
  assert.deepEqual(buildDeck({ M5: machine('M5'), M1: machine('M1') }, NOW).accounts, []);
});

test('merge: accounts present on only one Mac survive; disabled accounts do not', () => {
  const states = {
    M5: machine('M5', [account('remote', { label: 'Remote' })]),
    M1: machine('M1', [account('local', { label: 'Local' }), account('disabled', { enabled: false })]),
  };
  assert.deepEqual(buildDeck(states, NOW).accounts.map((a) => a.label), ['Remote', 'Local']);
});

test('merge: UUID match wins over renamed labels, distinct UUIDs stay separate', () => {
  const metadata = { claudeAccountUuid: '11111111-2222-4333-8444-555555555555' };
  const states = {
    M5: machine('M5', [account('remote', { metadata })]),
    M1: machine('M1', [account('local', { label: 'Renamed', metadata })]),
  };
  assert.equal(mergeAccounts(states).length, 1);
  assert.equal(buildDeck(states, NOW).accounts[0].label, 'Probe');
  states.M1.state.accounts[0] = account('other', { metadata: { claudeAccountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } });
  assert.equal(mergeAccounts(states).length, 2);
});

const window = (scope, remaining, resetsAt = null) => ({
  title: windowTitle(scope), rank: windowRank(scope), remaining, resetsAt, spend: scope === 'spend',
});
test('headline: on a Claude card the weekly all-models leads even when another window is lower', () => {
  assert.equal(headlineOf([window('5h', 5), window('week', 80), window('week:model', 10)], 'claude'), 1);
});
test('headline: a Codex card leads with its lowest window, as on the Mac deck', () => {
  assert.equal(headlineOf([window('5h', 3), window('week', 80)], 'codex'), 0);
  assert.equal(headlineOf([window('5h', 90), window('week', 80)], 'codex'), 1);
});
test('headline: monthly and usage-period windows do not masquerade as the weekly lead', () => {
  assert.equal(headlineOf([window('month', 90), window('week', 80), window('5h', 5)], 'claude'), 1);
  assert.equal(headlineOf([window('month', 90), window('usage period', 80), window('5h', 5)], 'claude'), 2);
});
test('headline: lowest non-spend window leads without a weekly; earlier reset breaks ties', () => {
  assert.equal(headlineOf([window('5h', 40), window('week:model', 10), window('spend', 1)], 'claude'), 1);
  assert.equal(headlineOf([window('5h', 10, NOW + 2000), window('week:model', 10, NOW + 1000)], 'claude'), 1);
  assert.equal(headlineOf([], 'claude'), -1);
});

test('weight: member preserves number including zero, absent is null, missing M5 account is undefined', () => {
  assert.equal(weightOf(account('a', { proxyPool: 'member', proxyWeight: 7 })), 7);
  assert.equal(weightOf(account('a', { proxyPool: 'member', proxyWeight: 0 })), 0);
  assert.equal(weightOf(account('a', { proxyPool: 'absent', proxyWeight: 7 })), null);
  assert.equal(weightOf(account('a')), null);
  assert.equal(weightOf(undefined), undefined);
  const states = { M5: machine('M5'), M1: machine('M1', [account('local', { proxyPool: 'member', proxyWeight: 9 })]) };
  assert.equal(buildDeck(states, NOW).accounts[0].weight, undefined);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(buildDeck(states, NOW))).accounts[0], 'weight'), false);
});

test('privacy: serialized deck excludes emails, UUIDs, credentials, and identity fields', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const a = account(uuid, {
    email: 'probe@example.invalid', token: 'placeholder-token', key: 'placeholder-key',
    credential: 'placeholder-credential', profileRef: '/placeholder/profile', identity: 'probe@example.invalid',
    metadata: { claudeAccountUuid: uuid, email: 'probe@example.invalid', plan: 'pro' },
  });
  const states = { M5: machine('M5', [a], [usage(uuid, 'week', 70)]), M1: machine('M1') };
  const histories = new Map([[`M5:${uuid}:2026-10-24T12:00:00.000Z`, { rows: [
    { bucketStart: '2026-10-21T12:00:00Z', lastUsedPercent: 10, token: 'placeholder-token' },
    { bucketStart: '2026-10-22T11:00:00Z', lastUsedPercent: 20 },
  ] }]]);
  states.M5.forecast = { accounts: [{ accountId: uuid, scope: 'week', status: 'forecast', dryAt: '2026-10-23T12:00:00Z' }] };
  const deck = buildDeck(states, NOW, { histories, pool: { grok: 1, antigravity: 2 } });
  assert.ok(deck.accounts[0].history);
  assert.ok(deck.accounts[0].forecast);
  const json = JSON.stringify(deck);
  assert.doesNotMatch(json, /@|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
  assert.doesNotMatch(json, /"[^"\\]*(?:token|key|credential|profileRef|identity)[^"\\]*"\s*:/i);
  assert.doesNotMatch(json, /placeholder/);
});

test('reachability: a failed read stays reachable inside DOWN_AFTER, then expires', () => {
  const states = { M5: { ...machine('M5'), ok: false }, M1: machine('M1') };
  assert.equal(buildDeck(states, NOW + DOWN_AFTER - 1).sources[0].reachable, true);
  assert.equal(buildDeck(states, NOW + DOWN_AFTER).sources[0].reachable, false);
  assert.equal(buildDeck(states, NOW + DOWN_AFTER + 1).sources[0].reachable, false);
  states.M5.stateAt = 0;
  assert.equal(buildDeck(states, NOW).sources[0].reachable, false);
});

test('SAFE_PATH accepts daemon paths and rejects quotes, semicolons, spaces, backticks, and command substitution', () => {
  assert.equal(SAFE_PATH.test('/api/usage/history?accountId=probe&since=2026-10-22T12%3A00%3A00Z'), true);
  for (const suffix of ["'", '"', ';id', ' space', '`id`', '$(id)', '\n', '\r']) {
    assert.equal(SAFE_PATH.test(`/api/state${suffix}`), false, JSON.stringify(suffix));
  }
  assert.equal(SAFE_PATH.test('https://example.invalid/api/state'), false);
});
test('SAFE_PATH accepts the + that URLSearchParams writes for a space in a window scope', () => {
  const q = new URLSearchParams({ accountId: 'probe', scope: 'usage period', bucket: 'hour' });
  assert.equal(SAFE_PATH.test(`/api/usage/history?${q}`), true);
  assert.equal(SAFE_PATH.test('/api/usage/history?scope=usage+period'), true);
});

const request = async (url, headers = { host: '127.0.0.1:3871' }) => {
  const res = { status: 0, writeHead(status) { this.status = status; }, end() {} };
  await handle({ method: 'GET', url, headers }, res);
  return res.status;
};
test('http: a malformed request path answers 400 instead of crashing the server', async () => {
  for (const url of ['//', '//x%20y', '//[', '//?x', '//a:99999']) assert.equal(await request(url), 400, url);
});
test('http: answers only to an IP address, localhost or a tailnet name', async () => {
  for (const host of ['100.97.205.116:3871', '127.0.0.1:3871', 'localhost:3871', '[fd7a::1]:3871',
    hostname().split('.')[0], 'probe-mac.tail0000.ts.net:3871']) {
    assert.equal(await request('/missing', { host }), 404, host);
  }
  for (const host of ['attacker.example', 'attacker.example:3871', '100.97.205.116.attacker.example', '']) {
    assert.equal(await request('/missing', { host }), 403, host);
  }
  assert.equal(await request('/missing', {}), 403, 'no Host header');
});

test('the server starts when node is given a symlinked path to it', async () => {
  const real = fileURLToPath(new URL('./server.mjs', import.meta.url));
  const dir = await fs.mkdtemp(join(tmpdir(), 'phone-deck-'));
  try {
    const link = join(dir, 'server.mjs');
    await fs.symlink(real, link);
    const url = pathToFileURL(realpathSync(real)).href;
    assert.equal(isMain(link, url), true);
    assert.equal(isMain(real, url), true);
    assert.equal(isMain(fileURLToPath(import.meta.url), url), false);
    assert.equal(isMain(undefined, url), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('window titles and ranks preserve session, weekly, model, and spend ordering', () => {
  assert.deepEqual(['session', 'weekly', 'week:model', 'spend'].map(windowTitle),
    ['5-hour limit', 'Weekly · all models', 'Weekly · Model', 'Spend']);
  assert.deepEqual(['5h', '7d', 'model weekly', 'spend'].map(windowRank), [0, 1, 2, 3]);
  assert.equal(windowTitle('unknown-scope'), 'unknown-scope');
});
test('severity uses the 10 and 25 percent boundaries', () => {
  assert.deepEqual([null, 0, 10, 10.1, 25, 25.1].map(severity),
    ['unknown', 'critical', 'critical', 'warning', 'warning', 'healthy']);
});
test('hidden windows suppress unused Codex models and meaningless unknown windows', () => {
  const w = { scope: 'week:model', rank: 2, remaining: 100 };
  assert.equal(hidden(w, 'codex'), true);
  assert.equal(hidden({ ...w, remaining: null }, 'codex'), true);
  assert.equal(hidden({ ...w, remaining: 99 }, 'codex'), false);
  assert.equal(hidden(w, 'claude'), false);
  assert.equal(hidden({ scope: 'unknown', remaining: 100 }, 'claude'), true);
  assert.equal(hidden({ scope: 'spend', spend: true, spendText: '$1 of $5' }, 'claude'), false);
});
test('plan labels format subscription tiers without exposing metadata', () => {
  assert.equal(planLabel({ claudePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }), 'Max (20x)');
  // Issue #799: Max 20x renamed Ultra.
  assert.equal(planLabel({ claudePlan: { rateLimitTier: 'default_claude_ultra' } }), 'Ultra');
  assert.equal(planLabel({ codexPlan: 'pro' }), 'Pro');
  assert.equal(planLabel({}), null);
});
test('sign-in state distinguishes idle expiry, repeated renewal failure, and duplicates', () => {
  assert.deepEqual(signInOf(account('a')), { state: 'ok', text: null });
  const expired = account('a', { authState: 'signin-required', signinReason: 'expired' });
  assert.equal(signInOf(expired).state, 'idle');
  assert.equal(signInOf({ ...expired, renew: { consecutiveFailures: 2 } }).state, 'needed');
  assert.equal(signInOf(account('a', { authState: 'duplicate-token' })).state, 'needed');
});

// Injected spies never delegate to the live implementations blocked above.
const response = async (reader, url = '/api/deck', method = 'GET', host = 'localhost') => {
  const res = {
    status: 0, headers: {}, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  await handle({ method, url, headers: { host } }, res, reader);
  return res;
};
const fixtureReader = (env = { SOURCES: 'local' }, state) => {
  const now = Date.now();
  state ??= { accounts: [account('probe', { proxyPool: 'member', proxyWeight: 7 })], usage: [{
    ...usage('probe', 'week', 70), observedAt: new Date(now).toISOString(),
    resetsAt: new Date(now + 86_400_000).toISOString(),
  }] };
  const calls = { fetch: [], exec: [], readdir: [] };
  const reader = createDeckReader(env, {
    fetch: async (url, options) => {
      calls.fetch.push([url, options]);
      const path = new URL(url).pathname;
      assert.equal(new URL(url).origin, 'http://127.0.0.1:3867');
      assert.equal(options.method ?? 'GET', 'GET');
      assert.ok(['/api/state', '/api/usage/exhaustion-forecast', '/api/usage/history'].includes(path));
      return { ok: true, json: async () => path === '/api/state' ? state : path.endsWith('history') ? { rows: [] } : { accounts: [] } };
    },
    execFile: (...args) => { calls.exec.push(args); args.at(-1)(new Error('offline fixture')); },
    readdir: async (...args) => { calls.readdir.push(args); return ['xai-probe.json', 'antigravity-probe.json']; },
  });
  return { reader, calls };
};

test('TRIPWIRE hub mode: zero SSH or pool directory reads; only local daemon GETs', async () => {
  const { reader, calls } = fixtureReader({ SOURCES: 'local', MACHINE_LABEL: 'Pool Studio' });
  const res = await response(reader);
  assert.equal(res.status, 200);
  assert.deepEqual({ ssh: calls.exec.length, readdir: calls.readdir.length }, { ssh: 0, readdir: 0 });
  assert.equal(calls.fetch.length, 3, 'state, forecast and weekly history');
  const deck = JSON.parse(res.body);
  assert.deepEqual(deck.sources.map((s) => s.name), ['Pool Studio']);
  assert.equal(deck.accounts.length, 1, 'no placeholder pool cards');
  assert.equal(deck.accounts[0].weight, 7);
  assert.deepEqual(deck.accounts[0].feeds, ['Pool Studio']);
  assert.equal(deck.accounts[0].windows[0].source, 'Pool Studio');
});

test('status: cold build, allowlist, shared cache, HEAD, host and method guards, no CORS', async () => {
  const { reader, calls } = fixtureReader();
  const first = await response(reader, '/api/status');
  assert.equal(first.status, 200);
  const status = JSON.parse(first.body);
  assert.deepEqual(Object.keys(status), ['generatedAt', 'sources', 'pool']);
  assert.deepEqual(status.pool, { readAt: status.sources[0].readAt, members: [] }, 'the probe has no identity to tag');
  assert.deepEqual(Object.keys(status.sources[0]), ['name', 'ok', 'reachable', 'readAt']);
  assert.deepEqual(status.sources, [{ name: 'Studio', ok: true, reachable: true, readAt: status.sources[0].readAt }]);
  assert.ok(Number.isFinite(Date.parse(status.generatedAt)));
  assert.ok(Number.isFinite(Date.parse(status.sources[0].readAt)));
  assert.equal(calls.fetch.length, 3);
  const deckResponse = await response(reader);
  const deck = JSON.parse(deckResponse.body);
  assert.equal(status.generatedAt, deck.generatedAt);
  assert.equal(status.sources[0].readAt, deck.sources[0].readAt);
  assert.deepEqual(first.headers, deckResponse.headers);
  assert.equal(first.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(first.headers['Referrer-Policy'], 'no-referrer');
  assert.match(first.headers['Content-Security-Policy'], /connect-src 'self'/);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.ok(!Object.keys(first.headers).some((k) => k.toLowerCase().startsWith('access-control-')));
  const head = await response(reader, '/api/status', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert.deepEqual(head.headers, first.headers);
  assert.deepEqual(JSON.parse((await response(reader, '/api/status')).body), status);
  assert.equal(calls.fetch.length, 3, 'status/deck/HEAD share the cached build');
  const post = await response(forbidden, '/api/status', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET, HEAD');
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await response(forbidden, '/api/status', method, 'attacker.example')).status, 403);
  }
});

test('MACHINE_LABEL: default, boundaries, safe characters, invalid values rejected before I/O', async () => {
  for (const name of ['S', 'Pool Studio-2', 'A '.repeat(12), 'Studio-Pool-Mac-M4-Pro', 'M1', 'M5', 'constructor']) {
    const { reader } = fixtureReader({ SOURCES: 'local', MACHINE_LABEL: name });
    assert.equal((await reader()).sources[0].name, name);
  }
  for (const name of ['', 'A'.repeat(25), 'Studio\n', '<Studio>', 'probe@example.invalid', 'a/b', 'a_b', 'Stúdio']) {
    assert.throws(() => createDeckReader({ SOURCES: 'local', MACHINE_LABEL: name }), /MACHINE_LABEL/);
  }
});

test('default mode retains both sources, remote reads, pool counts and output', async () => {
  const { reader, calls } = fixtureReader({});
  const deck = await reader();
  assert.deepEqual(deck.sources.map((s) => s.name), ['M5', 'M1']);
  assert.equal(calls.exec.length, 2);
  assert.equal(calls.exec[0][0], 'ssh');
  assert.equal(calls.readdir.length, 1);
  assert.deepEqual(deck.accounts.slice(1), [
    { id: 'g1', provider: 'grok', label: 'Grok', reads: false, note: 'Signed in to the M1 proxy pool. ModelDeck doesn’t read its usage yet.' },
    { id: 'ag1', provider: 'antigravity', label: 'Antigravity', reads: false, note: 'Signed in to the M1 proxy pool. ModelDeck doesn’t read its usage yet.' },
  ]);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(deck)).accounts[0], 'weight'), false);
});

test('TRIPWIRE hub pool (#827): status lists pool members by tag only; deck and two-Mac mode carry none', async () => {
  const email = 'Pool.Member@example.invalid';
  const codexId = 'acct-0123456789abcdef0123456789abcdef';
  const state = { accounts: [
    account('c1', { label: 'ClickAI Skills', identity: email, proxyPool: 'member', proxyWeight: 6,
      proxyFableExcluded: true, proxyCredential: 'error', proxyCredentialDetail: 'token for probe@example.invalid expired' }),
    account('c2', { label: 'Outside Pool', identity: 'lend@example.invalid', proxyPool: 'absent' }),
    account('c3', { label: 'Disabled', identity: 'off@example.invalid', proxyPool: 'member', proxyWeight: 3, enabled: false }),
    account('c4', { label: 'No identity', proxyPool: 'member', proxyWeight: 2 }),
    { id: 'x1', provider: 'codex', label: 'Codex Probe', enabled: true, codexAccountId: codexId, proxyPool: 'member', proxyWeight: 0 },
  ], usage: [] };
  const { reader } = fixtureReader({ SOURCES: 'local', MACHINE_LABEL: 'Mini' }, state);
  const body = (await response(reader, '/api/status')).body;
  const status = JSON.parse(body);
  assert.deepEqual(status.pool, { readAt: status.sources[0].readAt, members: [
    { provider: 'claude', match: poolMemberTag('claude', email), weight: 6, fableExcluded: true,
      credential: 'error', credentialDetail: null },
    { provider: 'codex', match: poolMemberTag('codex', codexId), weight: 0, fableExcluded: false,
      credential: null, credentialDetail: null },
  ] }, 'members only: not the absent, disabled or unidentified accounts');
  assert.equal(poolMemberTag('claude', email), poolMemberTag('claude', ' pool.member@EXAMPLE.invalid'));
  for (const leak of [email.toLowerCase(), codexId, 'Outside Pool', 'ClickAI', 'Codex Probe', 'c1', 'x1']) {
    assert.ok(!body.toLowerCase().includes(leak.toLowerCase()), `status leaked ${leak}`);
  }
  const deck = JSON.parse((await response(reader)).body);
  assert.equal(Object.hasOwn(deck, 'pool') || Object.hasOwn(deck, 'hubPool'), false, 'the page\'s own deck is unchanged');
  const twoMacs = { M5: machine('M5', state.accounts), M1: machine('M1', state.accounts) };
  assert.equal(hubPoolOf(twoMacs), undefined);
  assert.equal(Object.hasOwn(buildDeck(twoMacs, NOW), 'hubPool'), false, 'only a pool host publishes its pool');
});

test('TRIPWIRE privacy: sensitive daemon fields cannot reach deck or status, including display text', async () => {
  const secrets = ['probe@example.invalid', '11111111-2222-4333-8444-555555555555',
    '/Users/probe/private/profile', 'sk-probe-placeholder-secret', 'abcdef0123456789'.repeat(4)];
  for (const secret of secrets) {
    const extra = { identity: secret, purpose: secret, profileRef: secret, notes: secret };
    const a = account(secret, { ...extra, label: secret, metadata: {
      ...extra, claudeAccountUuid: secret, claudePlan: { displayName: secret }, codexPlan: secret, plan: secret,
    } });
    const state = { ...extra, accounts: [a], usage: [
      { ...usage(secret, 'week', 70), ...extra, detail: extra },
      { ...usage(secret, `week:${secret}`, 60), ...extra },
    ] };
    const states = { M5: machine('M5', state.accounts, state.usage), M1: machine('M1') };
    states.M5.forecast = { ...extra, basisWindow: { label: secret }, estimateLabel: secret,
      accounts: [{ ...extra, accountId: secret, scope: 'week', status: 'forecast', dryAt: '2026-10-23T12:00:00Z' }] };
    const histories = new Map([[`M5:${secret}:2026-10-24T12:00:00.000Z`, { rows: [
      { ...extra, bucketStart: '2026-10-21T12:00:00Z', lastUsedPercent: 10 },
      { ...extra, bucketStart: '2026-10-22T11:00:00Z', lastUsedPercent: 20 },
    ] }]]);
    const pureDeck = buildDeck(states, NOW, { histories });
    assert.ok(pureDeck.accounts[0].history);
    assert.ok(pureDeck.accounts[0].forecast);
    const { reader } = fixtureReader({ SOURCES: 'local' }, state);
    for (const json of [JSON.stringify(pureDeck), (await response(reader)).body,
      (await response(reader, '/api/status')).body]) {
      assert.ok(!json.toLowerCase().includes(secret.toLowerCase()), `sensitive value leaked: ${secret}`);
      assert.doesNotMatch(json, /"(?:identity|metadata|purpose|profileRef|notes)"\s*:/);
    }
  }
});

const renderPlist = (env) => {
  const program = installer.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
  let output;
  vm.runInNewContext(program, {
    process: { argv: ['node', '-', '/fixture/deck', '/fixture/home'], env },
    console: { log: (s) => { output = s; } },
  });
  return output;
};
test('installer: optional source variables are XML-escaped; unset plist stays byte-identical', () => {
  const original = renderPlist({});
  assert.equal(createHash('sha256').update(original).digest('hex'), '60e3de41a7ed3b576059f33d43e3c40b5cdf2b6c8d3a8388cf70786721a430c5');
  const configured = renderPlist({ SOURCES: 'local', MACHINE_LABEL: 'Pool Studio' });
  assert.match(configured, /<key>SOURCES<\/key><string>local<\/string>/);
  assert.match(configured, /<key>MACHINE_LABEL<\/key><string>Pool Studio<\/string>/);
  assert.match(renderPlist({ MACHINE_LABEL: '<&"\'>' }), /&lt;&amp;&quot;&apos;&gt;/);
  assert.match(renderPlist({ SOURCES: '' }), /<key>SOURCES<\/key><string><\/string>/);
});

test('page: all three views and offline copy use the configured source label', () => {
  const context = vm.createContext({});
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const deck = buildDeck({ Studio: { ...machine('Studio'), ok: false, stateAt: 0 } }, NOW);
  context.deck = deck;
  context.now = NOW;
  for (const render of ['renderA', 'renderB', 'renderC']) {
    const html = vm.runInContext(`${render}(deck, now, 390)`, context);
    assert.match(html, /Studio/);
    assert.doesNotMatch(html, /the M[15]|other Mac/);
  }
  assert.doesNotMatch(page, /Reading the M5 and the M1/);
});

test('default projection: serialized fixture remains byte-identical to the pre-hub server', () => {
  const states = {
    M5: machine('M5', [account('remote', { metadata: { plan: 'pro' }, proxyPool: 'member', proxyWeight: 3 })],
      [usage('remote', 'week', 70), usage('remote', '5h', 40)]),
    M1: machine('M1', [account('local')], [usage('local', 'week', 80)]),
  };
  const deck = buildDeck(states, NOW, { pool: { grok: 1, antigravity: 2 } });
  for (const source of deck.sources) delete source.ok; // New status field; preserve every pre-hub field.
  const json = JSON.stringify(deck);
  // Captured from HEAD's server before this change, with exactly this fixture.
  assert.equal(createHash('sha256').update(json).digest('hex'), '27251b4acfd152f6462d20e528b7cfa05e82ed3a24d05a1ab978b1ac2ea4858b');
});


test('config: invalid SOURCES and orphan MACHINE_LABEL refuse before I/O', () => {
  for (const SOURCES of ['Local', 'local ', 'hub', '']) {
    assert.throws(() => createDeckReader({ SOURCES }), /SOURCES must be exactly local/);
  }
  for (const MACHINE_LABEL of ['Studio', '']) {
    assert.throws(() => createDeckReader({ MACHINE_LABEL }), /MACHINE_LABEL needs SOURCES=local/);
  }
});

test('http: intranet refused, own short hostname allowed', async () => {
  assert.equal(await request('/missing', { host: 'intranet' }), 403);
  assert.equal(await request('/missing', { host: hostname().split('.')[0].toUpperCase() }), 404);
  for (const host of ['[not-ip]', '999.999.999.999', '12345']) {
    assert.equal(await request('/missing', { host }), 403, host);
  }
});

test('privacy: token formats and private paths are redacted from display text', () => {
  const values = [
    'AbcDef0123456789_-'.repeat(2), 'AbcDef0123456789+/'.repeat(2) + '=',
    'q3ZtV9x_Lw2kRb7nHc4PdY8mEf1sJg6aUo0iTe5rWyN', 'Bearer short-secret', 'eyJhbGciOiJub25lIn0.eyJhIjoxfQ.signature',
    'ghp_example', 'gho_example', 'github_pat_example', 'xai-example', 'AIzaExample', 'ya29.example',
    'a1'.repeat(16), 'b2'.repeat(20),
    '/home/probe/profile', '~/profile', '/private/probe', '/Volumes/probe', '/var/probe',
    'probe%40example.invalid',
  ];
  for (const label of values) {
    const deck = buildDeck({ Studio: machine('Studio', [account('probe', { label })]) }, NOW);
    assert.equal(deck.accounts[0].label, '[redacted]', `format ${values.indexOf(label)}`);
  }
});

test('privacy: ordinary labels and display texts stay byte-identical', () => {
  for (const label of ['Business', 'Hobby Account', 'Side1971', 'Side Instead', 'HomeLab',
    'Demo AI', 'Studio AI', 'School', 'Personal Max', 'Weekly · all models',
    'Resets Sat 5:58 AM', '2026-10-30T12:34:56.000Z', '#aabbcc', 'five_hour', 'seven_day_opus',
    // Ordinary words the first redaction pass blanked (#787 re-check).
    'Aizawa', 'SK-Hynix', 'xAI-Grok', 'Task-sk-1', 'Bearer of bad news', 'Eyjafjallajokull',
    'seven_day_claude_design_artifacts', 'Studio-Pool-Mac-M4-Pro']) {
    assert.equal(buildDeck({ Studio: machine('Studio', [account('probe', { label })]) }, NOW).accounts[0].label, label);
  }
});

test('status: ok tracks latest state attempt while reachable and readAt retain last success', async (t) => {
  let now = NOW, fail = true;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  const reader = createDeckReader({ SOURCES: 'local' }, {
    fetch: async () => {
      if (fail) throw new Error('offline fixture');
      return { ok: true, json: async () => ({ accounts: [], usage: [] }) };
    },
  });
  const status = async () => JSON.parse((await response(reader, '/api/status')).body).sources[0];
  assert.deepEqual(await status(), { name: 'Studio', ok: false, reachable: false, readAt: null });
  fail = false; now += 60_001;
  const success = await status();
  assert.deepEqual(success, { name: 'Studio', ok: true, reachable: true, readAt: new Date(now).toISOString() });
  fail = true; now += 60_001;
  assert.deepEqual(await status(), { ...success, ok: false });
  now += DOWN_AFTER;
  assert.deepEqual(await status(), { ...success, ok: false, reachable: false });
});

test('logs: non-JSON response bodies never appear in either mode', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const body = 'PRIVATE_BODY';
  for (const env of [{ SOURCES: 'local' }, {}]) {
    const reader = createDeckReader(env, {
      fetch: async () => ({ ok: true, json: async () => JSON.parse(body) }),
      execFile: (...args) => args.at(-1)(null, body),
      readdir: async () => [],
    });
    await reader();
  }
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((line) => !line.includes(body)), 'response body leaked into log');
  assert.ok(lines.every((line) => /read failed$/.test(line)), 'failure message must be fixed');
});


test('http: ALLOWED_NAMES permits listed short names and rejects invalid lists', () => {
  assert.equal(hostAllowed('intranet'), false);
  assert.equal(hostAllowed('phone-alias:3871', ['phone-alias']), true);
  assert.equal(hostAllowed('intranet', ['phone-alias']), false);
  for (const ALLOWED_NAMES of ['a.b', 'a,b c', 'A', 'a,,b', ',a', 'a,', 'a\n', '<a>']) {
    assert.throws(() => createDeckReader({ ALLOWED_NAMES }), /ALLOWED_NAMES/);
  }
  assert.doesNotThrow(() => createDeckReader({ ALLOWED_NAMES: 'phone-alias,studio-2' }));
  assert.doesNotThrow(() => createDeckReader({ ALLOWED_NAMES: '' }));
});

// Execute only a sandbox copy: all service/network commands are replaced before
// bash sees it. plutil reads/writes fixture plists under the temporary HOME only.
async function installFixture(env, { installedEnv, twoMac = false } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'phone-deck-install-'));
  try {
    const agents = join(dir, 'Library/LaunchAgents');
    const plist = join(agents, 'ai.modeldeck.phone-deck.plist');
    const calls = join(dir, 'service-calls');
    await fs.mkdir(agents, { recursive: true });
    const previous = installedEnv === undefined ? null : renderPlist(installedEnv);
    if (previous !== null) await fs.writeFile(plist, previous);
    await fs.writeFile(join(dir, 'config.mjs'), configSource);
    const script = installer
      .replace('NODE=/opt/homebrew/bin/node', `NODE='${process.execPath}'`)
      .replace(/serve_hint\(\) \{[\s\S]*?\n\}/, 'serve_hint() { :; }')
      .replaceAll('/bin/launchctl', 'fixture_launchctl')
      .replaceAll('/usr/sbin/lsof', 'fixture_lsof');
    assert.doesNotMatch(script, /\/bin\/launchctl|\/usr\/sbin\/lsof|\$tailscale/);
    const stubs = `fixture_launchctl() { printf '%s\\n' "$*" >> "$HOME/service-calls"; [[ "$1" != print ]]; }
fixture_lsof() { :; }
`;
    const path = join(dir, 'launch-agent.sh');
    await fs.writeFile(path, stubs + script);
    let output, code = 0;
    try {
      output = childProcess.execFileSync('/bin/bash', [path, 'install', ...(twoMac ? ['--two-mac'] : [])], {
        env: { PATH: '/usr/bin:/bin', HOME: dir, ...env }, encoding: 'utf8', stdio: 'pipe',
      });
    } catch (error) {
      code = error.status;
      output = String(error.stdout) + String(error.stderr);
    }
    const read = (path) => { try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
    return { code, output, plist: read(plist), calls: read(calls), previous };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('installer: reinstall preserves hub settings and ALLOWED_NAMES with notice', { skip: MACOS_ONLY }, async () => {
  const result = await installFixture({}, { installedEnv: { SOURCES: 'local', MACHINE_LABEL: 'Pool Studio', ALLOWED_NAMES: 'phone-alias,studio-2' } });
  assert.equal(result.code, 0, result.output);
  for (const [key, value] of Object.entries({ SOURCES: 'local', MACHINE_LABEL: 'Pool Studio', ALLOWED_NAMES: 'phone-alias,studio-2' })) {
    assert.ok(result.plist.includes(`<key>${key}</key><string>${value}</string>`), key);
    assert.match(result.output, new RegExp(`Preserving ${key} from installed plist`));
  }
});

test('installer: explicit overrides win and --two-mac alone clears carried hub mode', { skip: MACOS_ONLY }, async () => {
  const installedEnv = { SOURCES: 'local', MACHINE_LABEL: 'Old Studio', ALLOWED_NAMES: 'old-alias' };
  const override = await installFixture({ MACHINE_LABEL: 'New Studio', ALLOWED_NAMES: 'new-alias' }, { installedEnv });
  assert.equal(override.code, 0, override.output);
  assert.match(override.plist, /<key>MACHINE_LABEL<\/key><string>New Studio<\/string>/);
  assert.match(override.plist, /<key>ALLOWED_NAMES<\/key><string>new-alias<\/string>/);
  const reset = await installFixture({}, { installedEnv, twoMac: true });
  assert.equal(reset.code, 0, reset.output);
  assert.doesNotMatch(reset.plist, /<key>(SOURCES|MACHINE_LABEL)<\/key>/);
  assert.match(reset.plist, /<key>ALLOWED_NAMES<\/key><string>old-alias<\/string>/);
  const clearedNames = await installFixture({ ALLOWED_NAMES: '' }, { installedEnv });
  assert.equal(clearedNames.code, 0, clearedNames.output);
  assert.match(clearedNames.plist, /<key>ALLOWED_NAMES<\/key><string><\/string>/);
});

test('installer: invalid config refuses before plist or service changes', { skip: MACOS_ONLY }, async () => {
  for (const [env, reason] of [
    ...['Local', 'local ', 'hub', ''].map((SOURCES) => [{ SOURCES }, /SOURCES must be exactly local/]),
    [{ MACHINE_LABEL: 'Studio' }, /MACHINE_LABEL needs SOURCES=local/],
    [{ SOURCES: 'local', MACHINE_LABEL: '<Studio>' }, /MACHINE_LABEL must be/],
    [{ ALLOWED_NAMES: 'bad.name' }, /ALLOWED_NAMES/],
  ]) {
    const result = await installFixture(env);
    assert.notEqual(result.code, 0, 'invalid config installed');
    assert.match(result.output, reason);
    assert.equal(result.plist, null);
    assert.equal(result.calls, null);
  }
  const invalid = { SOURCES: 'hub' };
  const result = await installFixture({}, { installedEnv: invalid });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /SOURCES must be exactly local/);
  assert.equal(result.plist, result.previous);
  assert.equal(result.calls, null);
});

test('docs: hub cutover command, Studio address, read modes and status contract', () => {
  const hub = readme.split('## Run on the pool host (hub mode)')[1].split('## Open on')[0];
  assert.match(hub, /tailscale serve --bg --tcp=3871 tcp:\/\/127\.0\.0\.1:3871/);
  assert.match(hub, /Tim.s OK at cutover/);
  assert.match(hub, /never use[\s\S]*Funnel/);
  assert.match(hub, /Studio.s tailnet address/);
  assert.match(hub, /`ok`/);
  assert.doesNotMatch(readme, /Mac app can fetch it natively/);
  const reads = readme.split('## What it reads')[1].split('## Stop')[0];
  assert.match(reads, /Hub mode/);
  assert.match(reads, /Two-Mac mode/);
  assert.match(readme, /--two-mac/);
});

// #809: a scratch hub page reads a daemon on another loopback port.
import { validateConfig as validateDeckConfig } from './config.mjs';
test('config: DAEMON_PORT defaults to 3867 and accepts only a port number', () => {
  assert.equal(validateDeckConfig({}).daemonPort, 3867);
  assert.equal(validateDeckConfig({ DAEMON_PORT: '13867' }).daemonPort, 13867);
  for (const DAEMON_PORT of ['', '0', '65536', '3867x', ' 3867', '-1']) {
    assert.throws(() => validateDeckConfig({ DAEMON_PORT }), /DAEMON_PORT must be a port number/, DAEMON_PORT);
  }
});

// CodeRabbit on #814: the reader reads the daemon on the port from its own
// settings, not the server process's.
test('reader: DAEMON_PORT from its settings picks the daemon it reads', async () => {
  const origins = new Set();
  const reader = createDeckReader({ SOURCES: 'local', DAEMON_PORT: '13867' }, {
    fetch: async (url) => {
      origins.add(new URL(url).origin);
      const path = new URL(url).pathname;
      return { ok: true, json: async () => (path === '/api/state' ? { accounts: [], usage: [] } : path.endsWith('history') ? { rows: [] } : { accounts: [] }) };
    },
    execFile: (...args) => args.at(-1)(new Error('offline fixture')),
    readdir: async () => [],
  });
  assert.equal((await response(reader)).status, 200);
  assert.deepEqual([...origins], ['http://127.0.0.1:13867']);
});

// Codex review of #814: the Mac installer keeps DAEMON_PORT, like the other
// optional settings, across installs.
test('installer: DAEMON_PORT is written and preserved', { skip: MACOS_ONLY }, async () => {
  const fresh = await installFixture({ SOURCES: 'local', DAEMON_PORT: '13867' });
  assert.equal(fresh.code, 0, fresh.output);
  assert.match(fresh.plist, /<key>DAEMON_PORT<\/key><string>13867<\/string>/);
  const again = await installFixture({}, { installedEnv: { SOURCES: 'local', DAEMON_PORT: '13867' } });
  assert.equal(again.code, 0, again.output);
  assert.match(again.plist, /<key>DAEMON_PORT<\/key><string>13867<\/string>/);
  const bad = await installFixture({ DAEMON_PORT: 'x' });
  assert.notEqual(bad.code, 0);
  assert.equal(bad.plist, null);
  // CodeRabbit on #814: leaving hub mode drops a carried scratch port; an
  // explicit one still applies.
  const twoMac = await installFixture({}, { installedEnv: { SOURCES: 'local', DAEMON_PORT: '13867' }, twoMac: true });
  assert.equal(twoMac.code, 0, twoMac.output);
  assert.doesNotMatch(twoMac.plist, /DAEMON_PORT/);
  const explicit = await installFixture({ DAEMON_PORT: '13868' }, { installedEnv: { SOURCES: 'local', DAEMON_PORT: '13867' }, twoMac: true });
  assert.match(explicit.plist, /<key>DAEMON_PORT<\/key><string>13868<\/string>/);
});
