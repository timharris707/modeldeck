// Issue #827 — a remote Mac's deck shows the pool hub's weights and sign-in
// verdicts, read from the hub page over the tailnet.
//
// TRIPWIRE remote-deck-hub-weights: the hub side is the real usage-page code
// (tools/phone-deck/server.mjs) answering /api/status from a fixture hub
// daemon state; its exact body is what the remote daemon reads. Labels differ
// between the two Macs on purpose, so only the identity match can pair them.
// If remote decks lose their weights again, the first test fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService, POOL_HUB_POLL_MS, POOL_HUB_FRESH_MS } from '../src/service.mjs';
import { poolMemberTag } from '../src/pool-member-tag.mjs';
import { createDeckReader, handle } from '../tools/phone-deck/server.mjs';

const HUB = 'http://100.96.22.65:3871';
const REMOTE_REASON = 'This Mac uses the proxy pool on another machine; manage it there.';
const POOL_FIELDS = ['proxyPool', 'proxyWeight', 'proxyFableExcluded', 'proxyCredential', 'proxyCredentialDetail', 'proxyRelogin'];
const flush = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve(); };

// The hub daemon's own /api/state, as the Mini reports it: its names, its
// identities, its pool fields. One account is signed in but not pooled.
const hubState = () => ({
  accounts: [
    { id: 'h1', provider: 'claude', label: 'ClickAI Skills', enabled: true, identity: 'Click@Example.invalid',
      proxyPool: 'member', proxyWeight: 9, proxyFableExcluded: true, proxyCredential: 'ok' },
    { id: 'h2', provider: 'claude', label: 'Model Deck', enabled: true, identity: 'deck@example.invalid',
      proxyPool: 'member', proxyWeight: 0, proxyCredential: 'error', proxyCredentialDetail: 'refresh token expired' },
    { id: 'h3', provider: 'claude', label: 'Outside Pool', enabled: true, identity: 'lend@example.invalid',
      proxyPool: 'absent', authState: 'signin-required' },
    { id: 'h4', provider: 'codex', label: 'Codex Probe', enabled: true, codexAccountId: 'acct-placeholder-1',
      proxyPool: 'member', proxyWeight: 4, proxyCredential: 'ok' },
  ],
  usage: [],
});

/** The hub page's /api/status body for a hub daemon state, via the real handler. */
async function hubStatusBody(state = hubState()) {
  const reader = createDeckReader({ SOURCES: 'local', MACHINE_LABEL: 'Mini' }, {
    fetch: async (url) => {
      const pathname = new URL(url).pathname;
      return { ok: true, json: async () => (pathname === '/api/state' ? state : { accounts: [], rows: [] }) };
    },
    execFile: () => { throw new Error('the hub page must not SSH'); },
    readdir: async () => { throw new Error('the hub page must not list pool files'); },
  });
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await handle({ method: 'GET', url: '/api/status', headers: { host: '100.96.22.65:3871' } }, res, reader);
  assert.equal(res.status, 200);
  return String(res.body);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-hub-weights-'));
  // Leftover local pool files and a management key, with different weights:
  // a remote daemon must never read them.
  const cliproxyAuthDir = path.join(root, 'proxy', 'auth');
  fs.mkdirSync(cliproxyAuthDir, { recursive: true });
  fs.writeFileSync(path.join(cliproxyAuthDir, 'claude.json'), JSON.stringify({
    type: 'claude', email: 'click@example.invalid', weight: 1, access_token: 'placeholder-not-a-credential',
  }));
  const managementKeyPath = path.join(root, 'proxy', '.mgmt-key');
  fs.writeFileSync(managementKeyPath, 'placeholder-management-key', { mode: 0o600 });
  const store = new Store(':memory:');
  store.saveSettings({ autoRenewEnabled: false, autoRefreshEnabled: false });
  const profile = (name) => { const dir = path.join(root, 'profiles', name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const accounts = {
    click: store.saveAccount({ provider: 'claude', label: 'Click AI', identity: 'click@example.invalid', profileRef: profile('click') }),
    deck: store.saveAccount({ provider: 'claude', label: 'ModelDeck', identity: 'DECK@example.invalid ', profileRef: profile('deck') }),
    lend: store.saveAccount({ provider: 'claude', label: 'Outside Pool', identity: 'lend@example.invalid', profileRef: profile('lend') }),
    codex: store.saveAccount({ provider: 'codex', label: 'codex-probe', profileRef: profile('codex') }),
  };
  let now = Date.now(); // the hub page stamps readAt with the real clock
  const timers = new Map();
  const hubRequests = [];
  const forbidden = [];
  let reply = async () => new Response(await hubStatusBody());
  const unexpected = (name) => async () => { forbidden.push(name); throw new Error(`unexpected ${name}`); };
  const service = new ModelDeckService(store, {
    dataDir: root, claudeProfilesDir: path.join(root, 'profiles'), codexProfilesDir: path.join(root, 'profiles'),
    claudeActiveLink: path.join(root, 'active-claude'), codexActiveLink: path.join(root, 'active-codex'),
    claudeShellEnvFile: path.join(root, 'env.sh'), zshenvPath: path.join(root, '.zshenv'),
    cliproxyAuthDir, cliproxyManagementKeyPath: managementKeyPath, cliproxyBaseUrl: 'http://127.0.0.1:43279',
    platform: 'linux', exec: unexpected('exec'), spawn: unexpected('spawn'),
    fetchClaude: unexpected('fetchClaude'), fetchCodex: unexpected('fetchCodex'), fetchGrok: unexpected('fetchGrok'),
    fetcher: unexpected('fetcher'), registryFetch: unexpected('registryFetch'),
    usageQueueFetch: unexpected('usageQueueFetch'), proxyReloginFetch: unexpected('proxyReloginFetch'),
    usageQueueReadFile: unexpected('usageQueueReadFile'), proxyReloginReadFile: unexpected('proxyReloginReadFile'),
    proxyAuthOpen: unexpected('proxyAuthOpen'),
    poolHubFetch: async (...args) => { hubRequests.push(args); return reply(...args); },
    logPoolHub: () => {},
    listProviderProcesses: async () => [],
    now: () => now,
    proxyReloginNow: () => now,
    setTimeout: (callback, delay) => {
      const timer = { callback, due: now + delay, unref() {} };
      timers.set(timer, timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  service.codexAccountIdentifiers.set(accounts.codex.id, 'acct-placeholder-1');
  t.after(async () => { await service.stopAutoRefresh(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = async () => {
    const value = await service.state();
    await flush();
    return Object.fromEntries(Object.entries(accounts).map(([key, account]) => [key, value.accounts.find((a) => a.id === account.id)]));
  };
  const pool = (account) => Object.fromEntries(POOL_FIELDS.filter((key) => Object.hasOwn(account, key)).map((key) => [key, account[key]]));
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due > now) continue;
      timers.delete(id);
      timer.callback();
    }
    await flush();
  }
  return {
    store, service, accounts, hubRequests, forbidden, state, pool, advance,
    setReply: (fn) => { reply = fn; },
    jump: (ms) => { now += ms; },
    clock: () => now,
    goRemote: async () => { store.saveSettings({ proxyRole: 'remote', poolHubUrl: HUB }); service.startAutoRefresh(); await flush(); },
  };
}

test('TRIPWIRE remote deck shows the hub weights and sign-in verdicts, matched by identity, not by name', async (t) => {
  const d = fixture(t);
  await d.goRemote();
  const cards = await d.state();
  assert.deepEqual(d.pool(cards.click), {
    proxyPool: 'member', proxyWeight: 9, proxyFableExcluded: true, proxyCredential: 'ok',
    proxyRelogin: { available: false, reason: REMOTE_REASON },
  }, '"Click AI" here is "ClickAI Skills" on the hub');
  assert.deepEqual(d.pool(cards.deck), {
    proxyPool: 'member', proxyWeight: 0, proxyCredential: 'error',
    proxyRelogin: { available: false, reason: REMOTE_REASON },
  }, 'the hub\'s sign-in warning reaches the card (without the proxy\'s own text); case and spaces in the email do not matter');
  assert.deepEqual(d.pool(cards.codex), {
    proxyPool: 'member', proxyWeight: 4, proxyCredential: 'ok',
    proxyRelogin: { available: false, reason: REMOTE_REASON },
  }, 'Codex matches by the remembered account id');
  assert.deepEqual(d.pool(cards.lend), {}, 'an account outside the pool shows no weight and no sign-in warning');
  assert.deepEqual(d.forbidden, [], 'no management call, key read or auth-file read on a remote Mac');
  assert.ok(d.hubRequests.every(([url, init]) => url === `${HUB}/api/status` && init.method === 'GET'
    && init.credentials === 'omit' && init.body === undefined));
});

test('the hub record goes away when it is 10 minutes old, the hub stops answering, or its own read fails', async (t) => {
  const d = fixture(t);
  // How old the hub page says its record is, against this Mac's clock.
  let recordAge = 0;
  const body = async () => {
    const value = JSON.parse(await hubStatusBody());
    value.pool.readAt = new Date(d.clock() - recordAge).toISOString();
    return value;
  };
  d.setReply(async () => new Response(JSON.stringify(await body())));
  await d.goRemote();
  assert.equal((await d.state()).click.proxyWeight, 9);

  // The page keeps answering, but with a record of its daemon that has aged.
  recordAge = POOL_HUB_FRESH_MS - 1;
  await d.advance(POOL_HUB_POLL_MS);
  assert.equal((await d.state()).click.proxyWeight, 9, 'just under 10 minutes still counts');
  recordAge = POOL_HUB_FRESH_MS;
  await d.advance(POOL_HUB_POLL_MS);
  assert.deepEqual(d.pool((await d.state()).click), {}, 'a 10-minute-old weight is never shown as live');
  recordAge = 0;
  await d.advance(POOL_HUB_POLL_MS);
  assert.equal((await d.state()).click.proxyWeight, 9);

  // The page stops answering.
  d.setReply(async () => { throw new Error('placeholder network failure'); });
  await d.advance(POOL_HUB_POLL_MS);
  assert.deepEqual(d.pool((await d.state()).click), {});
  assert.notEqual(d.service.poolHubState().hub.lastFailedAt, null, 'the header says the page is not answering');

  // The page answers, but its own read of the hub daemon failed.
  d.setReply(async () => {
    const value = await body();
    value.sources[0].ok = false;
    return new Response(JSON.stringify(value));
  });
  await d.advance(POOL_HUB_POLL_MS);
  assert.equal(d.service.poolHubState().hub.lastReadOk, false);
  assert.deepEqual(d.pool((await d.state()).click), {});

  // No timer fires (a sleeping Mac): the last record ages out on the first
  // state read, before any catch-up read can replace it.
  d.setReply(async () => new Response(JSON.stringify(await body())));
  await d.advance(POOL_HUB_POLL_MS);
  assert.equal((await d.state()).click.proxyWeight, 9);
  d.setReply(() => new Promise(() => {}));
  d.jump(POOL_HUB_FRESH_MS - 1);
  assert.equal((await d.state()).click.proxyWeight, 9);
  d.jump(1);
  assert.deepEqual(d.pool((await d.state()).click), {});
  assert.deepEqual(d.forbidden, []);
});

test('a hub clock running ahead cannot keep a record alive past 10 minutes from its arrival', async (t) => {
  const d = fixture(t);
  const ahead = 24 * 3_600_000;
  d.setReply(async () => {
    const value = JSON.parse(await hubStatusBody());
    value.pool.readAt = new Date(d.clock() + ahead).toISOString();
    return new Response(JSON.stringify(value));
  });
  await d.goRemote();
  assert.equal((await d.state()).click.proxyWeight, 9, 'a fast hub clock does not hide a fresh record');
  d.setReply(() => new Promise(() => {}));
  d.jump(POOL_HUB_FRESH_MS);
  assert.deepEqual(d.pool((await d.state()).click), {}, 'counted from arrival, the record is 10 minutes old');
  d.jump(ahead);
  assert.deepEqual(d.pool((await d.state()).click), {}, 'and it never comes back without a new read');
});

test('the proxy\'s own status text never reaches a remote Mac; only a retry time or "provider overloaded"', async (t) => {
  const d = fixture(t);
  const state = hubState();
  const [click, deck, , codex] = state.accounts;
  Object.assign(click, { proxyCredential: 'resting', proxyCredentialDetail: '2026-11-02T07:30:00Z' });
  Object.assign(deck, { proxyCredential: 'error',
    proxyCredentialDetail: 'service_unavailable for person@example.invalid refresh_token=rt_lowercase1234567890abc' });
  Object.assign(codex, { proxyCredential: 'error',
    proxyCredentialDetail: 'cannot read /etc/cliproxyapi/auth/acct-placeholder-1.json' });
  const body = await hubStatusBody(state);
  for (const leak of ['person@', 'rt_lowercase', '/etc/', 'acct-placeholder', 'service_unavailable']) {
    assert.ok(!body.includes(leak), `the hub page published ${leak}`);
  }
  d.setReply(async () => new Response(body));
  await d.goRemote();
  const cards = await d.state();
  assert.equal(cards.click.proxyCredentialDetail, '2026-11-02T07:30:00.000Z', 'the deck can say "back at" a time');
  assert.equal(cards.deck.proxyCredentialDetail, 'provider overloaded', 'an overload stays an overload, not "sign-in expired"');
  assert.equal(cards.codex.proxyCredential, 'error');
  assert.equal(Object.hasOwn(cards.codex, 'proxyCredentialDetail'), false);

  // A hub that sends any other text is refused outright.
  const value = JSON.parse(body);
  value.pool.members[0].credentialDetail = 'refresh token for person@example.invalid expired';
  d.setReply(async () => new Response(JSON.stringify(value)));
  await d.advance(POOL_HUB_POLL_MS);
  for (const card of Object.values(await d.state())) assert.deepEqual(d.pool(card), {});
});

test('a page without a pool block, a malformed one, or a tag listed twice pairs nothing', async (t) => {
  const d = fixture(t);
  const status = JSON.parse(await hubStatusBody());
  const send = (value) => d.setReply(async () => new Response(JSON.stringify(value)));
  const { pool, ...older } = status;
  send(older);
  await d.goRemote();
  assert.equal(d.service.poolHubState().hub.lastReadOk, true, 'an older page still answers');
  for (const card of Object.values(await d.state())) assert.deepEqual(d.pool(card), {});

  for (const bad of [
    { ...pool, readAt: 'yesterday' },
    { ...pool, members: [{ ...pool.members[0], match: 'click@example.invalid' }] },
    { ...pool, members: [{ ...pool.members[0], weight: -1 }] },
    { ...pool, members: [{ ...pool.members[0], credential: 'fine' }] },
    { ...pool, members: [{ ...pool.members[0], provider: 'grok' }] },
  ]) {
    send({ ...status, pool: bad });
    await d.advance(POOL_HUB_POLL_MS);
    assert.ok(Date.parse(d.service.poolHubState().hub.lastFailedAt) >= Date.parse(d.service.poolHubState().hub.lastAnsweredAt),
      'a malformed pool block fails the read');
    for (const card of Object.values(await d.state())) assert.deepEqual(d.pool(card), {});
  }

  const click = pool.members.find((member) => member.match === poolMemberTag('claude', 'click@example.invalid'));
  send({ ...status, pool: { ...pool, members: [...pool.members, { ...click, weight: 1 }] } });
  await d.advance(POOL_HUB_POLL_MS);
  const cards = await d.state();
  assert.deepEqual(d.pool(cards.click), {}, 'two hub records for one identity: show neither');
  assert.equal(cards.deck.proxyWeight, 0, 'other members still pair');
});

test('remote Macs raise no member-failure alert from their old local request archive', async (t) => {
  const d = fixture(t);
  d.store.requestFailureStreak = () => ({
    consecutiveFailures: 50, lastFailureAt: '2026-10-31T00:00:00Z', statusCode: 401,
  });
  await d.goRemote();
  const value = await d.service.state();
  assert.equal(value.accounts.find((a) => a.id === d.accounts.click.id).proxyWeight, 9, 'the member has a live weight');
  assert.deepEqual(value.memberBlackout.alerts, []);
});

test('a host Mac never applies a hub record, even one left over from remote role', async (t) => {
  const d = fixture(t);
  await d.goRemote();
  assert.equal((await d.state()).click.proxyWeight, 9);
  d.store.saveSettings({ proxyRole: 'host' });
  assert.notEqual((await d.state()).click.proxyWeight, 9, 'host weights come from local files, never the hub');
});
