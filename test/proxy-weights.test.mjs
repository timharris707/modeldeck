import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

// CLIProxyAPI state: /api/state accounts carry additive pool membership and,
// when present, `proxyWeight` read from the proxy's auth files — Claude joined
// by identity email, Codex by the #108 remembered `tokens.account_id`
// identifier (Codex daemon identities are empty). The proxy is optional
// tooling: an unavailable directory or one with no parseable auth object omits
// pool state entirely, never reporting a guessed absence.

function makeFixture({ authFiles, serviceOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-proxyweights-'));
  const claudeHome = path.join(root, 'claude-profiles', 'work');
  const codexHome = path.join(root, 'profiles', 'codex-work');
  fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  let cliproxyAuthDir = null;
  if (authFiles) {
    cliproxyAuthDir = path.join(root, 'cliproxy-auth');
    fs.mkdirSync(cliproxyAuthDir, { recursive: true });
    for (const [name, content] of Object.entries(authFiles)) {
      fs.writeFileSync(path.join(cliproxyAuthDir, name), content);
    }
  }
  const store = new Store(':memory:');
  const claude = store.saveAccount({
    provider: 'claude', label: 'Business', identity: 'Tim@Example.COM',
    profileRef: claudeHome, isDefault: true,
  });
  const codex = store.saveAccount({
    provider: 'codex', label: 'Business Codex', identity: '',
    profileRef: codexHome, isDefault: true,
  });
  const service = new ModelDeckService(store, {
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    codexProfilesDir: path.join(root, 'profiles'),
    cliproxyAuthDir,
    setTimeout: () => 0,
    clearTimeout: () => {},
    platform: 'linux',
    claudeCredentialsPresent: async () => true,
    ...serviceOptions,
  });
  return { root, store, service, claude, codex, claudeHome, codexHome, cliproxyAuthDir };
}

function cleanup(fixture) {
  fixture.store.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('claude accounts join by identity email, case-insensitively; weight 0 is a real value', async (t) => {
  const fixture = makeFixture({
    authFiles: {
      'claude-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 0, access_token: 'never-read',
      }),
    },
  });
  t.after(() => cleanup(fixture));
  const accounts = await fixture.service.accountsWithAuthState();
  const claude = accounts.find((a) => a.provider === 'claude');
  assert.equal(claude.proxyPool, 'member');
  assert.equal(claude.proxyWeight, 0);
});

test('a recognized identity makes pool state knowable even without a valid weight (#279)', async (t) => {
  const fixture = makeFixture({
    authFiles: {
      'claude-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 'not-a-weight', refresh_token: 'credential-never-consumed',
        access_token: 'credential-value-is-never-a-state-field',
      }),
    },
  });
  t.after(() => cleanup(fixture));

  const peerHome = path.join(path.dirname(fixture.claudeHome), 'peer');
  fs.mkdirSync(peerHome, { mode: 0o700 });
  const peer = fixture.store.saveAccount({
    provider: 'claude', label: 'Peer', identity: 'peer@example.invalid', profileRef: peerHome,
  });

  const accounts = await fixture.service.accountsWithAuthState();
  const member = accounts.find((account) => account.id === fixture.claude.id);
  const absent = accounts.find((account) => account.id === peer.id);
  assert.equal(member.proxyPool, 'member');
  assert.ok(!('proxyWeight' in member), 'membership does not require a valid routing weight');
  assert.equal(absent.proxyPool, 'absent');
  assert.ok(!('proxyWeight' in absent));
});

test('codex accounts join by the remembered tokens.account_id identifier', async (t) => {
  const fixture = makeFixture({
    authFiles: {
      'codex-abc-someone@example.com-pro.json': JSON.stringify({
        type: 'codex', email: 'someone@example.com', account_id: 'acct-uuid-1', weight: 8,
      }),
    },
  });
  t.after(() => cleanup(fixture));

  // Before any refresh there is no remembered identifier: the pool is
  // knowable, but this account is not yet joinable to its auth-file row.
  let accounts = await fixture.service.accountsWithAuthState();
  let codex = accounts.find((a) => a.provider === 'codex');
  assert.equal(codex.proxyPool, 'absent');
  assert.equal(codex.proxyWeight, undefined);

  // The refresh pass reads tokens.account_id from the profile's auth.json
  // (the #108 evidence-memory path) — after it, the weight joins.
  fs.writeFileSync(
    path.join(fixture.codexHome, 'auth.json'),
    JSON.stringify({ tokens: { account_id: 'acct-uuid-1', id_token: 'x.y.z' } }),
  );
  await fixture.service.refreshCodexAccountIdentifier(fixture.codex);
  accounts = await fixture.service.accountsWithAuthState();
  codex = accounts.find((a) => a.provider === 'codex');
  assert.equal(codex.proxyPool, 'member');
  assert.equal(codex.proxyWeight, 8);
});

test('Claude routing booleans are top-level and Claude-only (#279)', async (t) => {
  const fixture = makeFixture({ authFiles: null });
  t.after(() => cleanup(fixture));

  let accounts = await fixture.service.accountsWithAuthState();
  let claude = accounts.find((account) => account.provider === 'claude');
  let codex = accounts.find((account) => account.provider === 'codex');
  assert.equal(claude.proxyRouted, false);
  assert.equal(claude.helperRouted, false);
  assert.ok(!('proxyRouted' in codex));
  assert.ok(!('helperRouted' in codex));

  fs.writeFileSync(path.join(fixture.claudeHome, 'settings.json'), JSON.stringify({
    apiKeyHelper: 'security find-generic-password -s cli-proxy-api-client -w',
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
      UNRELATED_SETTING: 'preserved',
    },
  }));
  accounts = await fixture.service.accountsWithAuthState();
  claude = accounts.find((account) => account.provider === 'claude');
  codex = accounts.find((account) => account.provider === 'codex');
  assert.equal(claude.proxyRouted, true);
  assert.equal(claude.helperRouted, true);
  assert.ok(!('proxyRouted' in codex));
  assert.ok(!('helperRouted' in codex));
});

test('pool state is omitted when the auth directory cannot establish membership truth (#279)', async (t) => {
  const assertOmitted = async (fixture, label) => {
    const accounts = await fixture.service.accountsWithAuthState();
    assert.ok(accounts.every((account) => !('proxyPool' in account)), label);
  };

  // No configured directory.
  const unconfigured = makeFixture({ authFiles: null });
  t.after(() => cleanup(unconfigured));
  await assertOmitted(unconfigured, 'unconfigured directory');

  // Configured, but missing.
  const missing = makeFixture({ authFiles: null });
  t.after(() => cleanup(missing));
  missing.service.cliproxyAuthDir = path.join(missing.root, 'missing-auth-dir');
  await assertOmitted(missing, 'missing directory');

  // Configured path is a file, so readdir reports ENOTDIR.
  const notDirectory = makeFixture({ authFiles: null });
  t.after(() => cleanup(notDirectory));
  const regularFile = path.join(notDirectory.root, 'not-a-directory');
  fs.writeFileSync(regularFile, 'fixture');
  notDirectory.service.cliproxyAuthDir = regularFile;
  await assertOmitted(notDirectory, 'ENOTDIR');

  // Readable but empty.
  const empty = makeFixture({ authFiles: {} });
  t.after(() => cleanup(empty));
  await assertOmitted(empty, 'empty directory');

  // Malformed/non-object JSON cannot establish that this is a live auth pool.
  const garbage = makeFixture({
    authFiles: {
      'broken.json': '{not json',
      'array.json': JSON.stringify([{ type: 'claude' }]),
      'scalar.json': JSON.stringify('not-an-auth-object'),
      'notes.txt': 'not an auth file',
    },
  });
  t.after(() => cleanup(garbage));
  await assertOmitted(garbage, 'only malformed or non-object files');

  // Any parseable auth object proves that the configured pool exists. A row
  // for an unsupported provider carries no join identity, so ModelDeck's
  // Claude/Codex accounts are affirmatively absent.
  const unsupported = makeFixture({
    authFiles: {
      'unsupported.json': JSON.stringify({ type: 'xai', email: 'other@example.invalid' }),
    },
  });
  t.after(() => cleanup(unsupported));
  const unsupportedAccounts = await unsupported.service.accountsWithAuthState();
  assert.ok(unsupportedAccounts.every((account) => account.proxyPool === 'absent'));
});

test('codex accounts expose the remembered account_id identifier additively', async (t) => {
  // External joiners (the CLIProxyAPI rebalance job) need the identifier the
  // daemon already remembers — codex identities are empty. Claude accounts
  // and pre-refresh codex accounts omit the key entirely.
  const fixture = makeFixture({ authFiles: null });
  t.after(() => cleanup(fixture));

  let accounts = await fixture.service.accountsWithAuthState();
  assert.ok(accounts.every((a) => !('codexAccountId' in a)));

  fs.writeFileSync(
    path.join(fixture.codexHome, 'auth.json'),
    JSON.stringify({ tokens: { account_id: 'acct-uuid-9' } }),
  );
  await fixture.service.refreshCodexAccountIdentifier(fixture.codex);
  accounts = await fixture.service.accountsWithAuthState();
  assert.equal(accounts.find((a) => a.provider === 'codex').codexAccountId, 'acct-uuid-9');
  assert.ok(!('codexAccountId' in accounts.find((a) => a.provider === 'claude')));
});

test('absence in every direction omits the key entirely', async (t) => {
  // 1. No dir configured (the default in tests and non-proxy installs).
  const unconfigured = makeFixture({ authFiles: null });
  t.after(() => cleanup(unconfigured));
  let accounts = await unconfigured.service.accountsWithAuthState();
  assert.ok(accounts.every((a) => !('proxyWeight' in a)));

  // 2. Configured dir that does not exist on disk.
  const missingDir = makeFixture({ authFiles: null, serviceOptions: {} });
  t.after(() => cleanup(missingDir));
  missingDir.service.cliproxyAuthDir = path.join(missingDir.root, 'nope');
  accounts = await missingDir.service.accountsWithAuthState();
  assert.ok(accounts.every((a) => !('proxyWeight' in a)));

  // 3. Files present but unmatchable / malformed / invalid weights.
  const garbage = makeFixture({
    authFiles: {
      'claude-other@example.com.json': JSON.stringify({ type: 'claude', email: 'other@example.com', weight: 5, access_token: 'credential-never-consumed' }),
      'claude-tim@example.com.json': JSON.stringify({ type: 'claude', email: 'tim@example.com', weight: 'heavy', access_token: 'credential-never-consumed' }),
      'broken.json': '{not json',
      'notes.txt': 'ignored — not a .json auth file',
      'xai-tim@example.com.json': JSON.stringify({ type: 'xai', email: 'tim@example.com', weight: 5 }),
    },
  });
  t.after(() => cleanup(garbage));
  accounts = await garbage.service.accountsWithAuthState();
  assert.ok(accounts.every((a) => !('proxyWeight' in a)));
});

test('a Fable exclusion travels with the weight; its absence omits the key (#272)', async (t) => {
  // The two-tier rebalance benches a Fable-drained account via
  // `excluded-models` while its weight switches to general-pace duty. The
  // deck needs the exclusion to show the EFFECTIVE weight per view.
  const fixture = makeFixture({
    authFiles: {
      'claude-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 8, access_token: 'credential-never-consumed',
        'excluded-models': ['claude-fable-5'],
      }),
    },
  });
  t.after(() => cleanup(fixture));
  const claude = (await fixture.service.accountsWithAuthState())
    .find((a) => a.provider === 'claude');
  assert.equal(claude.proxyWeight, 8);
  assert.equal(claude.proxyFableExcluded, true);

  // No exclusion → key absent entirely, per the additive discipline.
  const plain = makeFixture({
    authFiles: {
      'claude-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 3, access_token: 'credential-never-consumed',
      }),
    },
  });
  t.after(() => cleanup(plain));
  const unbenched = (await plain.service.accountsWithAuthState())
    .find((a) => a.provider === 'claude');
  assert.equal(unbenched.proxyWeight, 3);
  assert.ok(!('proxyFableExcluded' in unbenched));
});

test('non-Fable exclusions and malformed excluded-models do not read as benched (#272)', async (t) => {
  const fixture = makeFixture({
    authFiles: {
      'claude-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 5, access_token: 'credential-never-consumed',
        'excluded-models': ['claude-haiku-4-5-20251001'],
      }),
    },
  });
  t.after(() => cleanup(fixture));
  const claude = (await fixture.service.accountsWithAuthState())
    .find((a) => a.provider === 'claude');
  assert.equal(claude.proxyWeight, 5);
  assert.ok(!('proxyFableExcluded' in claude));

  // Malformed shapes read as "not benched", never as an error.
  const malformed = makeFixture({
    authFiles: {
      'claude-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 5, access_token: 'credential-never-consumed',
        'excluded-models': 'claude-fable-5',
      }),
    },
  });
  t.after(() => cleanup(malformed));
  const survived = (await malformed.service.accountsWithAuthState())
    .find((a) => a.provider === 'claude');
  assert.equal(survived.proxyWeight, 5);
  assert.ok(!('proxyFableExcluded' in survived));
});

test('negative and non-integer weights are ignored; a valid sibling still joins', async (t) => {
  const fixture = makeFixture({
    authFiles: {
      'claude-tim@example.com.json': JSON.stringify({ type: 'claude', email: 'tim@example.com', weight: 7, access_token: 'credential-never-consumed' }),
      'claude-neg@example.com.json': JSON.stringify({ type: 'claude', email: 'neg@example.com', weight: -3, access_token: 'credential-never-consumed' }),
      'claude-frac@example.com.json': JSON.stringify({ type: 'claude', email: 'frac@example.com', weight: 2.5, access_token: 'credential-never-consumed' }),
    },
  });
  t.after(() => cleanup(fixture));
  const accounts = await fixture.service.accountsWithAuthState();
  assert.equal(accounts.find((a) => a.provider === 'claude').proxyWeight, 7);
});

test('a duplicate auth file for one identity cannot un-bench it (CodeRabbit, PR #282)', async (t) => {
  // Two files, same email, only ONE carrying excluded-models. readdir order
  // used to decide the answer: parsed second, the unbenched sibling reset the
  // flag and the deck showed the account as Fable-routable while the policy
  // had benched it — the exact overstatement #272 exists to prevent.
  // Names chosen so the UNBENCHED file sorts last.
  const fixture = makeFixture({
    authFiles: {
      'claude-a-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 8, access_token: 'credential-never-consumed',
        'excluded-models': ['claude-fable-5'],
      }),
      'claude-z-tim@example.com.json': JSON.stringify({
        type: 'claude', email: 'tim@example.com', weight: 8, access_token: 'credential-never-consumed',
      }),
    },
  });
  t.after(() => cleanup(fixture));
  const claude = (await fixture.service.accountsWithAuthState())
    .find((a) => a.provider === 'claude');
  assert.equal(claude.proxyFableExcluded, true, 'benched wins regardless of parse order');
});
