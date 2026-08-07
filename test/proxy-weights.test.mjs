import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

// CLIProxyAPI weight display: /api/state accounts carry an additive
// `proxyWeight` read from the proxy's auth files — Claude joined by identity
// email, Codex by the #108 remembered `tokens.account_id` identifier (Codex
// daemon identities are empty). The proxy is optional tooling: every failure
// mode (no dir configured, dir missing, malformed file, unknown account)
// reads as an absent key, never an error and never a null.

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
  return { root, store, service, claude, codex, codexHome };
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
  assert.equal(claude.proxyWeight, 0);
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

  // Before any refresh there is no remembered identifier: key absent.
  let accounts = await fixture.service.accountsWithAuthState();
  assert.equal(accounts.find((a) => a.provider === 'codex').proxyWeight, undefined);

  // The refresh pass reads tokens.account_id from the profile's auth.json
  // (the #108 evidence-memory path) — after it, the weight joins.
  fs.writeFileSync(
    path.join(fixture.codexHome, 'auth.json'),
    JSON.stringify({ tokens: { account_id: 'acct-uuid-1', id_token: 'x.y.z' } }),
  );
  await fixture.service.refreshCodexAccountIdentifier(fixture.codex);
  accounts = await fixture.service.accountsWithAuthState();
  assert.equal(accounts.find((a) => a.provider === 'codex').proxyWeight, 8);
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
      'claude-other@example.com.json': JSON.stringify({ type: 'claude', email: 'other@example.com', weight: 5 }),
      'claude-tim@example.com.json': JSON.stringify({ type: 'claude', email: 'tim@example.com', weight: 'heavy' }),
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
        type: 'claude', email: 'tim@example.com', weight: 8,
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
        type: 'claude', email: 'tim@example.com', weight: 3,
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
        type: 'claude', email: 'tim@example.com', weight: 5,
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
        type: 'claude', email: 'tim@example.com', weight: 5,
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
      'claude-tim@example.com.json': JSON.stringify({ type: 'claude', email: 'tim@example.com', weight: 7 }),
      'claude-neg@example.com.json': JSON.stringify({ type: 'claude', email: 'neg@example.com', weight: -3 }),
      'claude-frac@example.com.json': JSON.stringify({ type: 'claude', email: 'frac@example.com', weight: 2.5 }),
    },
  });
  t.after(() => cleanup(fixture));
  const accounts = await fixture.service.accountsWithAuthState();
  assert.equal(accounts.find((a) => a.provider === 'claude').proxyWeight, 7);
});
