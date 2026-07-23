// Issue #108: two Codex profiles holding the same real account (identical
// tokens.account_id in their auth.json files) must surface as
// 'duplicate-token' on every member of the matching group — the Codex twin
// of the Claude weekly-fingerprint detection. All identities and account ids
// in this file are placeholders; no real credential material is ever used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { readCodexAccountId } from '../src/adapters/codex.mjs';

// ---------------------------------------------------------------------------
// Adapter: readCodexAccountId — identifier extraction only, graceful on
// every malformed input.

test('readCodexAccountId extracts only the account_id identifier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-authid-'));
  try {
    fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'placeholder-id-token-never-surfaced',
        access_token: 'placeholder-access-token-never-surfaced',
        refresh_token: 'placeholder-refresh-token-never-surfaced',
        account_id: 'acct-placeholder-1111',
      },
      last_refresh: '2026-07-21T20:01:00Z',
    }));
    const result = await readCodexAccountId({ codexHome: root });
    // Identifier only — the result must carry nothing else from auth.json.
    assert.deepEqual(result, { accountId: 'acct-placeholder-1111' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('readCodexAccountId treats every malformed or missing input as absent evidence', async () => {
  const cases = [
    ['missing home', { codexHome: null }],
    ['missing file', { codexHome: fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-empty-')) }],
    ['unreadable file', { codexHome: '/nonexistent-path/modeldeck', readFile: async () => { throw new Error('EACCES'); } }],
    ['invalid json', { codexHome: '/x', readFile: async () => 'not-json{' }],
    ['no tokens object', { codexHome: '/x', readFile: async () => JSON.stringify({ OPENAI_API_KEY: 'k' }) }],
    ['missing account_id', { codexHome: '/x', readFile: async () => JSON.stringify({ tokens: { id_token: 't' } }) }],
    ['blank account_id', { codexHome: '/x', readFile: async () => JSON.stringify({ tokens: { account_id: '   ' } }) }],
    ['non-string account_id', { codexHome: '/x', readFile: async () => JSON.stringify({ tokens: { account_id: 42 } }) }],
  ];
  for (const [label, options] of cases) {
    assert.deepEqual(await readCodexAccountId(options), { accountId: null }, label);
  }
});

// ---------------------------------------------------------------------------
// Service: detection, evidence memory, probe invalidation, precedence.

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-codex-dup-'));
  const profilesDir = path.join(root, 'codex-profiles');
  const homes = {};
  for (const name of ['insight', 'lending', 'personal']) {
    const home = path.join(profilesDir, name);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    homes[name] = home;
  }
  fs.chmodSync(profilesDir, 0o700);
  const store = new Store(':memory:');
  const insight = store.saveAccount({ provider: 'codex', label: 'Insight', profileRef: homes.insight, isDefault: true });
  const lending = store.saveAccount({ provider: 'codex', label: 'Lending', profileRef: homes.lending });
  const personal = store.saveAccount({ provider: 'codex', label: 'Personal', profileRef: homes.personal });
  const service = new ModelDeckService(store, {
    codexProfilesDir: profilesDir,
    codexActiveLink: path.join(root, 'active', '.codex'),
    claudeActiveLink: path.join(root, 'active', '.claude'),
    platform: 'linux',
    listProviderProcesses: async () => [],
    fetchCodex: async () => [{ scope: 'weekly', usedPercent: 2, resetsAt: '2026-07-21T20:56:00Z', source: 'fixture' }],
    ...options,
  });
  return {
    root, store, service, homes, insight, lending, personal,
    writeAuth(name, accountId) {
      fs.writeFileSync(path.join(homes[name], 'auth.json'), JSON.stringify({
        tokens: { id_token: 'placeholder-token', account_id: accountId },
      }), { mode: 0o600 });
    },
    async codexStates() {
      const accounts = await this.service.accountsWithAuthState();
      return accounts.filter((account) => account.provider === 'codex')
        .map((account) => [account.label, account.authState]);
    },
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('Codex refresh flags every profile sharing an account_id and leaves distinct ones healthy', async () => {
  const data = fixture();
  try {
    // End-to-end through the real adapter: two profiles carry the same
    // placeholder account_id, the third its own.
    data.writeAuth('insight', 'acct-placeholder-shared');
    data.writeAuth('lending', 'acct-placeholder-shared');
    data.writeAuth('personal', 'acct-placeholder-solo');
    await data.service.refreshCodex();
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'duplicate-token'],
      ['Lending', 'duplicate-token'],
      ['Personal', 'ok'],
    ]);
  } finally { data.close(); }
});

test('missing auth.json or missing account_id produces no flag and no crash', async () => {
  const data = fixture();
  try {
    // insight: no auth.json at all; lending: auth.json without account_id;
    // personal: healthy with its own id.
    fs.writeFileSync(path.join(data.homes.lending, 'auth.json'), JSON.stringify({ tokens: { id_token: 'placeholder-token' } }));
    data.writeAuth('personal', 'acct-placeholder-solo');
    const results = await data.service.refreshCodex();
    assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'signin-required'],
      ['Lending', 'ok'],
      ['Personal', 'ok'],
    ]);
    assert.equal(data.service.duplicateCodexTokenAccountIds.size, 0);
  } finally { data.close(); }
});

test('duplicate flag survives unreadable auth.json and invalidates the tool probe only on transitions', async () => {
  let mode = 'duplicate';
  const ids = {
    duplicate: { insight: 'acct-placeholder-shared', lending: 'acct-placeholder-shared', personal: 'acct-placeholder-solo' },
    separated: { insight: 'acct-placeholder-relogged', lending: 'acct-placeholder-shared', personal: 'acct-placeholder-solo' },
  };
  const data = fixture({
    readCodexAccountId: async ({ codexHome }) => {
      if (mode === 'unreadable') return { accountId: null };
      return { accountId: ids[mode][path.basename(codexHome)] };
    },
  });
  try {
    let invalidations = 0;
    const originalInvalidate = data.service.invalidateToolProbe.bind(data.service);
    data.service.invalidateToolProbe = () => { invalidations += 1; originalInvalidate(); };
    // Keep the presence probe out of the way so states are driven by the
    // duplicate flag alone.
    for (const name of ['insight', 'lending', 'personal']) data.writeAuth(name, 'unused-by-stub');

    await data.service.refreshCodex();
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'duplicate-token'],
      ['Lending', 'duplicate-token'],
      ['Personal', 'ok'],
    ]);
    assert.equal(invalidations, 1);

    // An unreadable auth.json is not evidence the credentials separated —
    // the flags persist and the probe is not churned (PR #77 lesson).
    mode = 'unreadable';
    await data.service.refreshCodex();
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'duplicate-token'],
      ['Lending', 'duplicate-token'],
      ['Personal', 'ok'],
    ]);
    assert.equal(invalidations, 1);

    // Steady duplicate evidence: no probe churn either.
    mode = 'duplicate';
    await data.service.refreshCodex();
    assert.equal(invalidations, 1);

    // A re-login rewrote one profile's auth.json with its own account —
    // fresh readable evidence clears both flags and invalidates the probe.
    mode = 'separated';
    await data.service.refreshCodex();
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'ok'],
      ['Lending', 'ok'],
      ['Personal', 'ok'],
    ]);
    assert.equal(invalidations, 2);
  } finally { data.close(); }
});

test('disabling a flagged account prunes its identifier so the survivor clears', async () => {
  const data = fixture();
  try {
    data.writeAuth('insight', 'acct-placeholder-shared');
    data.writeAuth('lending', 'acct-placeholder-shared');
    data.writeAuth('personal', 'acct-placeholder-solo');
    await data.service.refreshCodex();
    assert.equal(data.service.duplicateCodexTokenAccountIds.size, 2);

    data.store.saveAccount({
      id: data.lending.id, provider: 'codex', label: 'Lending',
      profileRef: data.homes.lending, enabled: false,
    });
    await data.service.refreshCodex();
    assert.equal(data.service.duplicateCodexTokenAccountIds.size, 0);
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'ok'],
      ['Lending', 'ok'],
      ['Personal', 'ok'],
    ]);
  } finally { data.close(); }
});

test('duplicate-token outranks the signin-required refresh error, matching the Claude precedence', async () => {
  const data = fixture({
    fetchCodex: async ({ codexHome }) => {
      if (path.basename(codexHome) === 'insight') throw new Error('You must sign in explicitly before refreshing usage.');
      return [{ scope: 'weekly', usedPercent: 2, resetsAt: '2026-07-21T20:56:00Z', source: 'fixture' }];
    },
  });
  try {
    data.writeAuth('insight', 'acct-placeholder-shared');
    data.writeAuth('lending', 'acct-placeholder-shared');
    data.writeAuth('personal', 'acct-placeholder-solo');
    await data.service.refreshCodex();
    // Insight carries BOTH a duplicate flag and a signin-required refresh
    // error; the shared-credential state wins because it explains the rest.
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'duplicate-token'],
      ['Lending', 'duplicate-token'],
      ['Personal', 'ok'],
    ]);
    // Issue #149: while duplicate-token outranks, the additive signinReason
    // never rides along — it exists only beside signin-required.
    let insight = (await data.service.accountsWithAuthState())
      .find((account) => account.label === 'Insight');
    assert.equal('signinReason' in insight, false);
    // And once the duplicate clears, the recorded error surfaces honestly.
    data.writeAuth('insight', 'acct-placeholder-relogged');
    await data.service.refreshCodex();
    assert.deepEqual(await data.codexStates(), [
      ['Insight', 'signin-required'],
      ['Lending', 'ok'],
      ['Personal', 'ok'],
    ]);
    // Issue #149: the Codex sign-in message has no expired prefix, so the
    // reason stays the conservative "missing" (today's alarm treatment).
    insight = (await data.service.accountsWithAuthState())
      .find((account) => account.label === 'Insight');
    assert.equal(insight.signinReason, 'missing');
  } finally { data.close(); }
});
