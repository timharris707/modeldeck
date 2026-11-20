// Issue #847 — a Mac can be set to never read stored sign-ins.
//
// TRIPWIRE provider-usage-reads-off: with providerUsageReadsEnabled off, a
// refresh (scheduled or the deck's Refresh button), a single-account refresh,
// a renewal and an identity check reach no provider read. Every provider
// read below throws if called, so any path that slips through fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

function fixture(t, settings) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-847-')));
  const store = new Store(':memory:');
  store.saveSettings({ autoRenewEnabled: false, autoRefreshEnabled: false, claudeManaged: true, ...settings });
  const profile = path.join(root, 'profiles', 'probe');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, 'profiles'), 0o700);
  const account = store.saveAccount({ provider: 'claude', label: 'Probe', identity: 'probe@example.invalid', profileRef: profile });
  const reads = [];
  const read = (name) => async () => { reads.push(name); throw new Error(`stored sign-in read: ${name}`); };
  const service = new ModelDeckService(store, {
    dataDir: root, claudeProfilesDir: path.join(root, 'profiles'), codexProfilesDir: path.join(root, 'codex'),
    claudeActiveLink: path.join(root, 'active-claude'), codexActiveLink: path.join(root, 'active-codex'),
    claudeShellEnvFile: path.join(root, 'env.sh'), zshenvPath: path.join(root, '.zshenv'),
    platform: 'linux', listProviderProcesses: async () => [],
    fetchClaude: read('fetchClaude'), fetchCodex: read('fetchCodex'), fetchGrok: read('fetchGrok'),
    readClaudeAuth: read('readClaudeAuth'), readCodexAuth: read('readCodexAuth'),
    exec: read('exec'), spawn: read('spawn'),
  });
  t.after(async () => { await service.stopAutoRefresh(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, account, reads };
}

test('TRIPWIRE provider-usage-reads-off: no refresh, renewal or identity check reads a stored sign-in', async (t) => {
  const { service, account, reads } = fixture(t, { providerUsageReadsEnabled: false });
  const refresh = await service.refreshAll();
  assert.equal(refresh.usageReadsOff, true);
  assert.deepEqual([refresh.claude, refresh.codex, refresh.grok], [null, null, null]);
  assert.equal(await service.refreshClaudeAccount(account.id), null);
  await assert.rejects(service.renewClaudeAccount(account.id), (error) => error.statusCode === 409);
  await assert.rejects(service.verifyClaudeIdentity(account.id), (error) => error.statusCode === 409);
  // #847 review: account verification, and renewal or identity work that was
  // already queued when the setting turned off.
  await assert.rejects(service.verifyAccount(account.id), (error) => error.statusCode === 409);
  await assert.rejects(service.performClaudeRenewal(account.id), (error) => error.statusCode === 409);
  await assert.rejects(service.performClaudeIdentityVerification(account.id), (error) => error.statusCode === 409);
  assert.deepEqual(reads, []);
});

// #847 review: the setting turned off while the Claude read ran; the Codex and
// Grok reads of the same refresh must not start.
test('a refresh stops at the next provider when the setting turns off mid-cycle', async (t) => {
  const { service } = fixture(t, {});
  const started = [];
  service.refreshClaude = async () => { started.push('claude'); service.store.saveSettings({ providerUsageReadsEnabled: false }); return []; };
  service.refreshCodex = async () => { started.push('codex'); return []; };
  service.refreshGrok = async () => { started.push('grok'); return []; };
  const refresh = await service.refreshAll();
  assert.deepEqual(started, ['claude']);
  assert.equal(refresh.usageReadsOff, true);
});

test('the setting defaults on, and then a refresh reaches the provider read', async (t) => {
  const { service, reads } = fixture(t, {});
  assert.equal(service.providerUsageReadsAllowed(), true);
  await service.refreshAll();
  assert.ok(reads.includes('fetchClaude'), `reads: ${reads.join(', ')}`);
});

test('the setting only takes a boolean', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assert.throws(() => store.saveSettings({ providerUsageReadsEnabled: 'off' }));
});

// #847 review: the setting can turn off during a local await just before a
// provider read (refreshClaude's capture ingest, renewal's settings read).
// The read functions themselves refuse, so no timing reaches the provider.
test('the provider read functions refuse at the moment of the read, whatever ran before', async (t) => {
  const { service, reads } = fixture(t, {});
  service.ingestClaudeStatuslineCaptures = async () => { service.store.saveSettings({ providerUsageReadsEnabled: false }); };
  const [result] = await service.refreshClaude();
  assert.equal(result.ok, false);
  assert.deepEqual(reads, [], 'fetchClaude never reached the provider');
  for (const read of ['fetchClaude', 'fetchCodex', 'fetchGrok']) {
    assert.throws(() => service[read]({}), (error) => error.statusCode === 409, read);
  }
  await assert.rejects(service.readScopedClaudeAuthStatus('/nowhere'), (error) => error.statusCode === 409);
  assert.deepEqual(reads, []);
});

// #847 review: verify's executable lookup is awaited before its sign-in read.
test('account verify refuses when the setting turns off during its executable lookup', async (t) => {
  const { service, account, reads } = fixture(t, {});
  service.spawnableToolPath = async (tool) => { service.store.saveSettings({ providerUsageReadsEnabled: false }); return tool; };
  await assert.rejects(service.verifyAccount(account.id), (error) => error.statusCode === 409);
  assert.throws(() => service.readCodexAuth({}), (error) => error.statusCode === 409);
  assert.deepEqual(reads, []);
});

// #847 review: status line captures are local files and still arrive while
// the setting is off, even if the file watcher is unavailable.
test('a refresh with the setting off still picks up local status line captures', async (t) => {
  const { service, reads } = fixture(t, { providerUsageReadsEnabled: false });
  let ingested = 0;
  service.ingestClaudeStatuslineCaptures = async () => { ingested += 1; };
  assert.equal((await service.refreshAll()).usageReadsOff, true);
  assert.equal(ingested, 1);
  assert.deepEqual(reads, []);
});

// #847 review: a refusal must not overwrite an account's refresh error, or an
// expired sign-in would read as missing and renewal would switch off.
test('a refusal during refresh leaves the account\'s recorded refresh error unchanged', async (t) => {
  const { service, account } = fixture(t, {});
  const expired = 'stored OAuth credentials have expired; sign in explicitly before refreshing';
  service.recordAccountRefreshResults([{ accountId: account.id, ok: false, error: expired }]);
  const before = service.accountRefreshErrors.get(account.id);
  service.ingestClaudeStatuslineCaptures = async () => { service.store.saveSettings({ providerUsageReadsEnabled: false }); };
  const [result] = await service.refreshClaude();
  assert.equal(result.readsOff, true);
  assert.deepEqual(service.accountRefreshErrors.get(account.id), before);
});

// #847 review: the setting turns off during the renewal helper's setup awaits;
// no claude process may start, for the first binary or the fallback.
test('the renewal helper starts no claude process when the setting turns off during its setup', async (t) => {
  const { service, reads } = fixture(t, {});
  service.claudeRenewalConfigDir = async () => { service.store.saveSettings({ providerUsageReadsEnabled: false }); return '/nowhere'; };
  await assert.rejects(service.runClaudeRenewalCli(['auth', 'status', '--json'], '/nowhere'), (error) => error.statusCode === 409);
  assert.deepEqual(reads, [], 'exec never ran');
});

// #847 review: the same transition inside refreshCodex, during its local awaits.
test('a Codex refresh reads nothing when the setting turns off during its identifier await', async (t) => {
  const { service, reads } = fixture(t, {});
  // A Codex profile ModelDeck manages, inside its Codex profiles folder.
  service.store.saveSettings({ codexManaged: true });
  const home = path.join(service.codexProfilesDir, 'probe');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(service.codexProfilesDir, 0o700);
  const codex = service.store.saveAccount({ provider: 'codex', label: 'Codex Probe', profileRef: home });
  // Turn the setting off during the local await before the read.
  service.refreshCodexAccountIdentifier = async () => { await Promise.resolve(); service.store.saveSettings({ providerUsageReadsEnabled: false }); };
  const results = await service.refreshCodex();
  assert.deepEqual(results.map((r) => [r.accountId, r.ok, r.readsOff]), [[codex.id, false, true]]);
  assert.deepEqual(reads, []);
});
