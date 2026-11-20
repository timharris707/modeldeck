// Issue #836 — a remote Mac's deck shows the usage page's Claude numbers,
// read from the page's /api/status, so a Mac with no ModelDeck sign-ins
// (the Studio) still shows every account.
//
// TRIPWIRE remote-deck-hub-usage: the page side is the real usage-page code
// (tools/phone-deck/server.mjs) in several-machine mode, answering
// /api/status from a fixture daemon state plus one direct (T3) reading. Labels
// differ between the page and the remote Mac on purpose, so only the email or
// account-id tag can pair them. If remote decks lose the page's numbers, the
// first test fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService, POOL_HUB_FRESH_MS } from '../src/service.mjs';
import { claudeUsageTags } from '../src/pool-member-tag.mjs';
import { buildDeck, createDeckReader, handle } from '../tools/phone-deck/server.mjs';

const HUB = 'http://100.72.124.113:3871';
const DECK_UUID = '00000000-0000-4000-8000-00000000d3c4';
const RESET = '2026-12-01T00:00:00.000Z';
const flush = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve(); };
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// The page machine's daemon: one account read by token five minutes ago, one
// with an older token reading that its direct T3 reading below overtakes.
const pageDaemonState = () => ({
  accounts: [
    { id: 'p1', provider: 'claude', label: 'ClickAI Skills', enabled: true, identity: 'Click@Example.invalid', authState: 'ok' },
    { id: 'p2', provider: 'claude', label: 'Model Deck', enabled: true, identity: 'deck@example.invalid', authState: 'signin-required',
      metadata: { claudeAccountUuid: DECK_UUID } },
    { id: 'p3', provider: 'claude', label: 'Quiet', enabled: true, identity: 'quiet@example.invalid', authState: 'ok' },
  ],
  usage: [
    { accountId: 'p1', scope: 'weekly', usedPercent: 40, resetsAt: RESET, observedAt: ago(5 * 60_000), source: 'claude-oauth-api', detail: {} },
    { accountId: 'p2', scope: 'weekly', usedPercent: 80, resetsAt: RESET, observedAt: ago(60 * 60_000), source: 'claude-oauth-api', detail: {} },
  ],
});

const directReading = () => ({
  v: 1, readAt: ago(0),
  folders: [{ folder: 'modeldeck', accountUuid: DECK_UUID, plan: 'Ultra', rateLimitTier: null }],
  readings: [{ folder: 'modeldeck', accountUuid: DECK_UUID, entry: 'claude-modeldeck', source: 't3', scope: 'weekly',
    usedPercent: 12, resetsAt: RESET, status: 'allowed', observedAt: ago(60_000) }],
  activity: [],
  health: { t3Logs: true, t3Entries: 1, conversationsLastDay: 1, withoutReadingLastDay: 0, formatWarning: false },
});

/** The page's /api/status body, via the real handler in several-machine mode. */
async function pageStatusBody(state = pageDaemonState()) {
  const reader = createDeckReader({ MACHINES: 'Studio=local', DIRECT_NO_CACHE: '1' }, {
    fetch: async (url) => {
      const pathname = new URL(url).pathname;
      return { ok: true, json: async () => (pathname === '/api/state' ? state : { accounts: [], rows: [] }) };
    },
    readDirectLocal: () => directReading(),
    execFile: () => { throw new Error('a local-only page must not SSH'); },
    readdir: async () => { throw new Error('the page must not list pool files'); },
  });
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await handle({ method: 'GET', url: '/api/status', headers: { host: '100.72.124.113:3871' } }, res, reader);
  assert.equal(res.status, 200);
  return String(res.body);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-hub-usage-'));
  const store = new Store(':memory:');
  store.saveSettings({ autoRenewEnabled: false, autoRefreshEnabled: false });
  const profile = (name) => { const dir = path.join(root, 'profiles', name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const accounts = {
    // This Mac knows Click AI only by email and ModelDeck only by account id.
    click: store.saveAccount({ provider: 'claude', label: 'Click AI', identity: 'click@example.invalid', profileRef: profile('click') }),
    deck: store.saveAccount({ provider: 'claude', label: 'ModelDeck', profileRef: profile('deck'), metadata: { claudeAccountUuid: DECK_UUID } }),
    quiet: store.saveAccount({ provider: 'claude', label: 'Quiet', identity: 'quiet@example.invalid', profileRef: profile('quiet') }),
  };
  // Old local rows from when this Mac still read usage itself.
  store.recordUsage(accounts.click.id, { scope: 'weekly', usedPercent: 5, resetsAt: '2026-11-01T00:00:00.000Z', observedAt: ago(20 * 86_400_000), source: 'claude-oauth-api' });
  store.recordUsage(accounts.quiet.id, { scope: 'weekly', usedPercent: 33, resetsAt: RESET, observedAt: ago(60_000), source: 'claude-oauth-api' });
  let now = Date.now();
  const timers = new Map();
  let reply = async () => new Response(await pageStatusBody());
  const unexpected = (name) => async () => { throw new Error(`unexpected ${name}`); };
  const service = new ModelDeckService(store, {
    dataDir: root, claudeProfilesDir: path.join(root, 'profiles'), codexProfilesDir: path.join(root, 'profiles'),
    claudeActiveLink: path.join(root, 'active-claude'), codexActiveLink: path.join(root, 'active-codex'),
    claudeShellEnvFile: path.join(root, 'env.sh'), zshenvPath: path.join(root, '.zshenv'),
    cliproxyAuthDir: path.join(root, 'proxy', 'auth'), cliproxyManagementKeyPath: path.join(root, 'proxy', '.mgmt-key'),
    cliproxyBaseUrl: 'http://127.0.0.1:43279',
    platform: 'linux', exec: unexpected('exec'), spawn: unexpected('spawn'),
    fetchClaude: unexpected('fetchClaude'), fetchCodex: unexpected('fetchCodex'), fetchGrok: unexpected('fetchGrok'),
    fetcher: unexpected('fetcher'), registryFetch: unexpected('registryFetch'),
    usageQueueFetch: unexpected('usageQueueFetch'), proxyReloginFetch: unexpected('proxyReloginFetch'),
    usageQueueReadFile: unexpected('usageQueueReadFile'), proxyReloginReadFile: unexpected('proxyReloginReadFile'),
    proxyAuthOpen: unexpected('proxyAuthOpen'),
    poolHubFetch: async (...args) => reply(...args),
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
  t.after(async () => { await service.stopAutoRefresh(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const weekly = async () => {
    const value = await service.state();
    await flush();
    return Object.fromEntries(Object.entries(accounts).map(([key, account]) => {
      const row = value.usage.find((u) => u.accountId === account.id && u.scope === 'weekly');
      return [key, row && { used: row.usedPercent, source: row.source, hubSource: row.hubSource ?? null }];
    }));
  };
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
    store, service, accounts, weekly, advance,
    setReply: (fn) => { reply = fn; },
    goRemote: async () => { store.saveSettings({ proxyRole: 'remote', poolHubUrl: HUB }); service.startAutoRefresh(); await flush(); },
  };
}

test('TRIPWIRE remote deck shows the usage page numbers, matched by email or account id, not by name', async (t) => {
  const d = fixture(t);
  await d.goRemote();
  assert.deepEqual(await d.weekly(), {
    click: { used: 40, source: 'pool-hub', hubSource: 'Studio' },
    deck: { used: 12, source: 'pool-hub', hubSource: 'Studio · T3' },
    // This Mac's own reading is newer than anything the page has.
    quiet: { used: 33, source: 'claude-oauth-api', hubSource: null },
  });
  // The menu bar's lowest-left number counts the page's readings too.
  const { worst } = d.service.worstCapacity();
  assert.deepEqual([worst.accountId, worst.remainingPercent], [d.accounts.click.id, 60]);
});

// #836 review: the page may name a window differently from this Mac ('week'
// against 'weekly'); a newer page reading still replaces the old row, and a
// model window stays its own row.
test('a page reading replaces this Mac\'s row for the same window under another spelling', async (t) => {
  const d = fixture(t);
  const state = pageDaemonState();
  state.usage[0] = { ...state.usage[0], scope: 'week' };
  state.usage.push({ accountId: 'p1', scope: 'Fable weekly', usedPercent: 70, resetsAt: RESET, observedAt: ago(5 * 60_000), source: 'claude-oauth-api', detail: {} });
  d.setReply(async () => new Response(await pageStatusBody(state)));
  d.store.recordUsage(d.accounts.click.id, { scope: 'weekly', usedPercent: 95, resetsAt: RESET, observedAt: ago(60 * 60_000), source: 'claude-oauth-api' });
  await d.goRemote();
  const value = await d.service.state();
  const click = value.usage.filter((u) => u.accountId === d.accounts.click.id).map((u) => [u.scope, u.usedPercent, u.source]);
  assert.deepEqual(click.sort(), [['Fable weekly', 70, 'pool-hub'], ['weekly', 40, 'pool-hub']]);
  assert.equal(d.service.worstCapacity().worst.remainingPercent, 30, 'the old 95% row no longer counts');
});

// #847: on the M5, the page's newest reading for an account was the M5's own
// (same time, same number). The card kept its own row and fell back to "Uses
// the pool on <host>". An equal page reading now replaces it and names its source.
test('a page reading equal to this Mac\'s own replaces it, so the card names its source', async (t) => {
  const d = fixture(t);
  const state = pageDaemonState();
  d.setReply(async () => new Response(await pageStatusBody(state)));
  const own = state.usage[0];
  d.store.recordUsage(d.accounts.click.id, { scope: 'weekly', usedPercent: own.usedPercent, resetsAt: own.resetsAt, observedAt: own.observedAt, source: 'claude-oauth-api' });
  await d.goRemote();
  assert.deepEqual((await d.weekly()).click, { used: 40, source: 'pool-hub', hubSource: 'Studio' });
});

test('the page sends only one-way tags, never an email or account id', async () => {
  const body = await pageStatusBody();
  const status = JSON.parse(body);
  assert.ok(!/example\.invalid|d3c4|Click/i.test(JSON.stringify(status.usage)), 'no identity in the usage block');
  const [click] = claudeUsageTags('click@example.invalid');
  assert.ok(status.usage.accounts.some((a) => a.matches.includes(click)));
  assert.equal(status.usage.accounts.length, 2, 'an account with no readings is left out');
});

test('page numbers go away when the page is 10 minutes old, stops answering, or was never asked', async (t) => {
  const d = fixture(t);
  assert.equal((await d.weekly()).click.used, 5, 'a host Mac (not remote) keeps its own rows');
  await d.goRemote();
  assert.equal((await d.weekly()).click.used, 40);
  d.setReply(async () => { throw new Error('offline'); });
  await d.advance(60_000);
  assert.equal((await d.weekly()).click.used, 5, 'a failed read drops the page numbers');
  d.setReply(async () => new Response(await pageStatusBody()));
  await d.advance(60_000);
  assert.equal((await d.weekly()).click.used, 40);
  d.setReply(async () => new Promise(() => {}));
  await d.advance(POOL_HUB_FRESH_MS);
  assert.equal((await d.weekly()).click.used, 5, 'a page silent for 10 minutes shows nothing');
});

test('a page without a usage block, a malformed one, or a tag two cards share pairs nothing', async (t) => {
  const d = fixture(t);
  const status = JSON.parse(await pageStatusBody());
  const replies = [
    { ...status, usage: undefined },
    { ...status, usage: { ...status.usage, accounts: [{ matches: ['not-a-tag'], windows: [] }] } },
    { ...status, usage: { ...status.usage, accounts: [...status.usage.accounts, { ...status.usage.accounts[0], windows: [] }] } },
  ];
  let reply = replies[0];
  d.setReply(async () => new Response(JSON.stringify(reply)));
  await d.goRemote();
  for (const [index, next] of replies.entries()) {
    reply = next;
    await d.advance(60_000);
    const cards = await d.weekly();
    assert.equal(cards.click.used, 5, `reply ${index}`);
  }
});

// #850 — the Studio, 2026-11-20: four cards lost their weekly numbers once a
// minute. The M5's only copy of a reading came back to the page as a
// 'pool-hub' row naming the M5 (its daemon takes the page's equal copy), the
// page dropped every 'pool-hub' row, the window vanished, the M5 showed its
// own row again, and round it went.
//
// TRIPWIRE page-daemon-loop-keeps-windows: real page build -> real remote
// daemon merge -> real page build, three rounds. A window must never vanish.
test('TRIPWIRE page-daemon-loop-keeps-windows: a reading only one machine holds survives the round trip', async (t) => {
  const d = fixture(t);
  const observedAt = ago(13 * 3_600_000);
  d.store.recordUsage(d.accounts.click.id, { scope: 'weekly', usedPercent: 0, resetsAt: RESET, observedAt, source: 'claude-oauth-api' });
  // The M5's daemon state as the page reads it: this test's remote daemon.
  const m5State = async () => {
    const value = await d.service.state();
    return { accounts: value.accounts, usage: value.usage };
  };
  const page = async () => buildDeck({
    Studio: { name: 'Studio', remote: false, ok: true, stateAt: Date.now(), state: { accounts: [], usage: [] }, forecast: null },
    M5: { name: 'M5', remote: true, ok: true, stateAt: Date.now(), state: await m5State(), forecast: null },
  }, Date.now());
  let deck = await page();
  d.setReply(async () => new Response(JSON.stringify({
    generatedAt: deck.generatedAt, sources: deck.sources.map(({ name, ok, reachable, readAt }) => ({ name, ok, reachable, readAt })),
    usage: deck.hubUsage,
  })));
  await d.goRemote();
  for (let round = 1; round <= 3; round += 1) {
    const click = deck.accounts.find((a) => a.label === 'Click AI');
    const weekly = click?.windows.find((w) => w.title === 'Weekly · all models');
    assert.ok(weekly, `round ${round}: the weekly window is on the card`);
    assert.deepEqual([weekly.remaining, weekly.source], [100, 'M5'], `round ${round}`);
    await d.advance(60_000);
    deck = await page();
  }
  const row = (await d.service.state()).usage.find((u) => u.accountId === d.accounts.click.id && u.scope === 'weekly');
  assert.deepEqual([row.source, row.hubSource], ['pool-hub', 'M5'], 'the daemon did swap in the echo, so the loop really ran');
});
