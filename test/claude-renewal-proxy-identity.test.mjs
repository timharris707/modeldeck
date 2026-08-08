import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';

// Issue #263 (Tim, 2026-08-05). Four of his six Claude accounts went idle every
// ~8h and stayed idle until he signed in by hand; the other two healed
// themselves inside one 5-minute tick. The four were exactly the four whose
// profile settings.json carries an `apiKeyHelper` for the CLIProxyAPI route.
//
// Hand-tested against CLI 2.1.223 — the test #176 specified and closed
// "by construction" without running:
//
//   profile WITHOUT apiKeyHelper → {"loggedIn":true,"authMethod":"claude.ai",
//                                   "email":"…","subscriptionType":"max"}
//   profile WITH    apiKeyHelper → {"loggedIn":true,"authMethod":"api_key_helper"}
//
// The helper outranks the stored OAuth credential, so `claude auth status
// --json` names NOBODY. claudeRenewalIdentityMatches is fail-closed, declines
// the cheap no-flip rung, and every attempt falls to the flip rung — which is
// refused whenever any `claude` process is alive. For an always-on user that
// is never, so those accounts recorded outcome "busy" every 5 minutes with
// `attempts: []` — zero completed renewals in 24h.
//
// The fix: CLAUDE_CONFIG_DIR (which supplies settings.json) and
// CLAUDE_SECURESTORAGE_CONFIG_DIR (which selects the Keychain item) are
// independent knobs. The renewal child now reads a scratch config dir that
// carries only a link to the profile's .claude.json, so no apiKeyHelper and no
// proxy base URL can reach it, while credential scoping still names the real
// profile.
//
// These tests pin the SEPARATION, because that is the property the field
// depends on. Placeholder identities only.

const EXPIRED = 'Claude usage refresh failed: stored OAuth credentials have expired; sign in explicitly before refreshing';
const SNAPSHOTS = [{ scope: 'weekly', usedPercent: 10, source: 'fixture' }];
const TARGET_EMAIL = 'target@example.invalid';
const TARGET_UUID = 'uuid-target';
const MATCHING_STATUS = JSON.stringify({ email: TARGET_EMAIL, accountUuid: TARGET_UUID });
// What the CLI really answers for a proxy-routed profile: authenticated, but
// naming nobody. This exact shape is what defeated the fail-closed matcher.
const HELPER_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: 'api_key_helper',
  apiProvider: 'firstParty',
  apiKeySource: 'helper',
});
const OTHER_ACCOUNT_STATUS = JSON.stringify({ email: 'someone-else@example.invalid' });
const VERIFY_API_PORT = 43280;
const VERIFY_API_TOKEN = 'identity-verification-placeholder-token';

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-263-'));
  const profilesDir = path.join(root, 'profiles');
  const priorHome = path.join(profilesDir, 'prior');
  const targetHome = path.join(profilesDir, 'target');
  for (const dir of [priorHome, targetHome]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);

  // The profile as Tim's four actually look: proxy base URL plus the helper
  // that blanks the identity. `settings` overrides let a test drop either.
  const settings = Object.hasOwn(options, 'settings')
    ? options.settings
    : { apiKeyHelper: 'echo sk-placeholder', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } };
  if (settings !== null) {
    fs.writeFileSync(path.join(targetHome, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  }
  if (options.claudeJson !== false) {
    fs.writeFileSync(
      path.join(targetHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: TARGET_EMAIL, accountUuid: TARGET_UUID } }),
      { mode: 0o600 },
    );
  }

  const activeLink = path.join(root, 'active', '.claude');
  fs.mkdirSync(path.dirname(activeLink), { recursive: true });
  fs.symlinkSync(priorHome, activeLink, 'dir');

  const store = new Store(':memory:');
  const calls = [];
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    claudeActiveLink: activeLink,
    dataDir: path.join(root, 'data'),
    platform: 'linux',
    claudeCredentialsPresent: async () => true,
    // A Claude session is running for every test in this file. That is the
    // whole point: the fix must work in the state Tim is actually in.
    listProviderProcesses: async () => ['claude'],
    childEnv: {
      PATH: '/fixture/bin',
      ANTHROPIC_API_KEY: 'ambient-key-must-not-reach-renewal-child',
      ANTHROPIC_AUTH_TOKEN: 'ambient-token-must-not-reach-renewal-child',
      ANTHROPIC_BASE_URL: 'https://must-not-reach-child.invalid',
    },
    userInfo: () => ({ username: 'fixture-user' }),
    exec: async (command, args, execOptions) => {
      calls.push({ command, args, options: execOptions });
      // Model the CLI faithfully on both counts measured in the hand-test:
      //  - an apiKeyHelper in the config dir outranks the OAuth credential and
      //    the answer names nobody;
      //  - otherwise the identity is read from .claude.json IN THE CONFIG DIR,
      //    which is why an empty scratch dir returned authMethod "claude.ai"
      //    with email null until the profile's file was linked in.
      if (args[0] === 'auth') {
        options.onAuthCall?.();
        if (options.authGate) await options.authGate;
        if (options.authThrows) {
          // A failed invocation with NO usable stdout: timeout, ENOENT,
          // a crash. Distinct from "ran fine and named nobody".
          throw Object.assign(new Error('fixture auth status failed'), {
            code: 'ETIMEDOUT',
            ...(options.authErrorStdout ? { stdout: options.authErrorStdout } : {}),
          });
        }
        const configDir = execOptions.env.CLAUDE_CONFIG_DIR;
        const read = (file) => {
          try { return JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8')); }
          catch { return null; }
        };
        if (read('settings.json')?.apiKeyHelper) return { stdout: HELPER_STATUS, stderr: '' };
        if (options.statusOutput) return { stdout: options.statusOutput, stderr: '' };
        const account = read('.claude.json')?.oauthAccount;
        if (!account) {
          return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' };
        }
        return { stdout: MATCHING_STATUS, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    fetchClaude: async () => SNAPSHOTS,
    ...options.serviceOptions,
  });

  const target = store.saveAccount({
    provider: 'claude',
    label: 'Target',
    profileRef: targetHome,
    identity: Object.hasOwn(options, 'targetIdentity') ? options.targetIdentity : TARGET_EMAIL,
    metadata: Object.hasOwn(options, 'targetMetadata')
      ? options.targetMetadata
      : { claudeAccountUuid: TARGET_UUID },
  });
  store.saveAccount({ provider: 'claude', label: 'Prior', profileRef: priorHome, isDefault: true });

  return {
    root, priorHome, targetHome, activeLink, store, service, calls, target,
    expire() {
      service.recordAccountRefreshResults([{ accountId: target.id, ok: false, error: EXPIRED }]);
    },
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function verifyApi(data) {
  return createApp({
    store: data.store,
    service: data.service,
    host: '127.0.0.1',
    port: VERIFY_API_PORT,
    mutationToken: VERIFY_API_TOKEN,
  });
}

async function verifyApiRequest(app, route, { method = 'POST', authenticated = true } = {}) {
  const req = Readable.from([]);
  Object.assign(req, {
    method,
    url: route,
    headers: {
      host: `127.0.0.1:${VERIFY_API_PORT}`,
      ...(method !== 'GET' && authenticated ? {
        'x-modeldeck-token': VERIFY_API_TOKEN,
        cookie: `modeldeck_session=${VERIFY_API_TOKEN}`,
      } : {}),
    },
  });
  let status;
  let payload;
  const res = {
    writeHead(value) { status = value; },
    end(value) {
      payload = value == null || value === '' ? null : JSON.parse(String(value));
    },
  };
  await app.server.listeners('request')[0](req, res);
  return { status, body: payload };
}

function assertVerifyNeverInvokedInference(data) {
  assert.equal(
    data.calls.some((call) => call.args.includes('-p')),
    false,
    'verify-identity never includes -p in any provider exec call',
  );
}

test('a proxy-routed profile renews on the no-flip rung while Claude is running', async (t) => {
  await t.test('the helper never reaches the renewal child, so the identity rung names the account', async () => {
    const data = fixture();
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      // Before #263 this was outcome 'busy', path 'flip', forever.
      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
      const authCall = data.calls.find((call) => call.args[0] === 'auth');
      assert.ok(authCall, 'the identity rung ran');
      assert.notEqual(authCall.options.env.CLAUDE_CONFIG_DIR, data.targetHome);
      assert.equal(authCall.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, data.targetHome);
    } finally { data.close(); }
  });

  await t.test('the scratch config dir carries the profile identity but not its settings', async () => {
    const data = fixture();
    try {
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const configDir = data.calls[0].options.env.CLAUDE_CONFIG_DIR;
      assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false);
      assert.equal(
        fs.readlinkSync(path.join(configDir, '.claude.json')),
        path.join(data.targetHome, '.claude.json'),
      );
      // The link, not a copy: the CLI's writes still land in the profile.
      assert.equal(fs.lstatSync(path.join(configDir, '.claude.json')).isSymbolicLink(), true);
    } finally { data.close(); }
  });

  await t.test('the config dir is per-account and stable across attempts', async () => {
    const data = fixture();
    try {
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const first = data.calls[0].options.env.CLAUDE_CONFIG_DIR;
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const second = data.calls[data.calls.length - 1].options.env.CLAUDE_CONFIG_DIR;
      assert.equal(second, first);
      assert.match(path.basename(first), /^cfg-[0-9a-f]{12}$/);
    } finally { data.close(); }
  });

  await t.test('a settings.json appearing in the scratch dir is removed before the child runs', async () => {
    // The invariant is the fix. If anything ever wrote settings into the
    // scratch dir the bug would return silently, so assert it rather than
    // trust it.
    const data = fixture();
    try {
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const configDir = data.calls[0].options.env.CLAUDE_CONFIG_DIR;
      fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo x' }));
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false);
      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
    } finally { data.close(); }
  });

  await t.test('a .claude.json link replaced by a regular file is repaired, never clobbering the profile', async () => {
    const data = fixture();
    try {
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const link = path.join(data.calls[0].options.env.CLAUDE_CONFIG_DIR, '.claude.json');
      fs.rmSync(link);
      fs.writeFileSync(link, JSON.stringify({ oauthAccount: { emailAddress: 'stale@example.invalid' } }));

      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(link), path.join(data.targetHome, '.claude.json'));
      assert.equal(renew.outcome, 'renewed');
      // The profile's own file is untouched by the detour.
      const profileJson = JSON.parse(fs.readFileSync(path.join(data.targetHome, '.claude.json'), 'utf8'));
      assert.equal(profileJson.oauthAccount.emailAddress, TARGET_EMAIL);
    } finally { data.close(); }
  });

  await t.test('a profile with no .claude.json leaves no dangling link and stays fail-closed', async () => {
    const data = fixture({ claudeJson: false });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      const configDir = data.calls[0].options.env.CLAUDE_CONFIG_DIR;
      assert.equal(fs.existsSync(path.join(configDir, '.claude.json')), false);
      // No identity to carry: the matcher stays fail-closed exactly as before,
      // so this lands on the flip rung and defers to the running session.
      assert.equal(renew.outcome, 'busy');
      assert.equal(renew.identityDecline, 'absent');
    } finally { data.close(); }
  });
});

test('service-wired routing preserves the #263 renewal isolation pin', async () => {
  const data = fixture({
    settings: {
      opaque: {
        nested: ['placeholder', { enabled: false }],
        whitespace: '  value bytes survive  ',
      },
      env: { KEEP_ME: 'unrelated-value' },
    },
  });
  try {
    const settingsPath = path.join(data.targetHome, 'settings.json');
    const routed = await data.service.wireProxyRouting(data.target.id);
    assert.deepEqual(routed, {
      accountId: data.target.id,
      provider: 'claude',
      proxyRouted: true,
      cliproxyRouted: true,
      helperRouted: true,
    });

    // Capture the REAL profile after the routing mutation. Renewal must treat
    // these bytes as read-only: its settings-free scratch config is the #263
    // boundary that keeps apiKeyHelper from blinding the identity rung.
    const wiredSettings = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(wiredSettings);
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8317');
    assert.equal(parsed.env.KEEP_ME, 'unrelated-value');
    assert.equal(
      parsed.apiKeyHelper,
      'security find-generic-password -s cli-proxy-api-client -w',
    );

    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed');
    assert.equal(renew.path, 'no-flip');
    assert.ok(data.calls.length > 0, 'renewal spawned at least one Claude child');

    for (const call of data.calls) {
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
        assert.equal(Object.hasOwn(call.options.env, key), false, `${key} stayed out of the renewal child`);
      }
      const scratchConfig = call.options.env.CLAUDE_CONFIG_DIR;
      assert.notEqual(scratchConfig, data.targetHome);
      assert.equal(fs.existsSync(path.join(scratchConfig, 'settings.json')), false);
      assert.equal(fs.existsSync(path.join(scratchConfig, 'settings.local.json')), false);
    }
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), wiredSettings);
  } finally {
    data.close();
  }
});

test('POST verify-identity uses only the scoped auth-status identity rung (#280)', async (t) => {
  await t.test('a matching seed is promoted and the pill predicate field is visible through /api/state', async () => {
    const data = fixture({ targetMetadata: { identitySource: 'seed', fixtureMarker: 'preserved' } });
    const app = verifyApi(data);
    try {
      const activeBefore = fs.realpathSync(data.activeLink);
      const result = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { outcome: 'verified' });
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
      assert.equal(data.calls[0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, data.targetHome);
      assert.notEqual(data.calls[0].options.env.CLAUDE_CONFIG_DIR, data.targetHome);
      assert.equal(fs.realpathSync(data.activeLink), activeBefore, 'identity verification never flips activation');

      const state = await verifyApiRequest(app, '/api/state', { method: 'GET' });
      const account = state.body.accounts.find((item) => item.id === data.target.id);
      assert.equal(account.metadata.identitySource, 'verified');
      assert.equal(account.metadata.claudeAccountUuid, TARGET_UUID);
      assert.equal(account.metadata.fixtureMarker, 'preserved');

      const reset = data.service.resetClaudeIdentity(data.target.id);
      assert.equal(Object.hasOwn(reset.metadata, 'identitySource'), false);
      assert.equal(Object.hasOwn(reset.metadata, 'claudeAccountUuid'), false);
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('an already-verified account re-checks idempotently with zero store writes', async () => {
    const data = fixture({
      targetMetadata: { identitySource: 'verified' },
    });
    const app = verifyApi(data);
    const originalSave = data.store.saveAccount.bind(data.store);
    let saves = 0;
    data.store.saveAccount = (input) => {
      saves += 1;
      return originalSave(input);
    };
    try {
      const result = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { outcome: 'verified' });
      assert.equal(saves, 0);
      assert.equal(data.store.getAccount(data.target.id).metadata.claudeAccountUuid, undefined);
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('a mismatch reports the provider email without changing seeded metadata', async () => {
    const metadata = { identitySource: 'seed', fixtureMarker: 'preserved' };
    const data = fixture({ statusOutput: OTHER_ACCOUNT_STATUS, targetMetadata: metadata });
    const app = verifyApi(data);
    try {
      const result = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        outcome: 'mismatch',
        reported: 'someone-else@example.invalid',
      });
      assert.deepEqual(data.store.getAccount(data.target.id).metadata, metadata);
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('a matching email with a contradictory UUID is unavailable, not a same-email mismatch', async () => {
    const metadata = {
      identitySource: 'seed',
      claudeAccountUuid: TARGET_UUID,
      fixtureMarker: 'preserved',
    };
    const data = fixture({
      statusOutput: JSON.stringify({ email: TARGET_EMAIL, accountUuid: 'uuid-other-placeholder' }),
      targetMetadata: metadata,
    });
    const app = verifyApi(data);
    try {
      const result = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        outcome: 'unavailable',
        detail: 'Claude reported conflicting identity details for this account.',
      });
      assert.deepEqual(data.store.getAccount(data.target.id).metadata, metadata);
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('a successful CLI read that names nobody is unavailable', async () => {
    const data = fixture({ statusOutput: HELPER_STATUS, targetMetadata: { identitySource: 'seed' } });
    const app = verifyApi(data);
    try {
      const result = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        outcome: 'unavailable',
        detail: 'Claude did not report an identity for this account.',
      });
      assert.deepEqual(data.store.getAccount(data.target.id).metadata, { identitySource: 'seed' });
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('an account with no stored identity reports the no-identity detail', async () => {
    // CodeRabbit (PR #284): the third `unavailable` detail was unpinned. With
    // nothing stored there is nothing to compare against, so verification must
    // say so plainly rather than silently promoting or reporting a mismatch.
    const data = fixture({ targetIdentity: '', targetMetadata: { identitySource: 'seed' } });
    const app = verifyApi(data);
    try {
      const result = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        outcome: 'unavailable',
        detail: 'This account has no stored Claude identity to verify.',
      });
      assert.deepEqual(data.store.getAccount(data.target.id).metadata, { identitySource: 'seed' });
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('an invocation failure is unavailable and never exposes usable raw stdout', async () => {
    const rawMarker = 'raw-stdout-placeholder-must-not-surface';
    const data = fixture({
      authThrows: true,
      authErrorStdout: JSON.stringify({ email: TARGET_EMAIL, opaque: rawMarker }),
      targetMetadata: { identitySource: 'seed' },
    });
    const app = verifyApi(data);
    try {
      const result = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        outcome: 'unavailable',
        detail: 'ModelDeck could not read this account’s Claude identity.',
      });
      assert.doesNotMatch(JSON.stringify(result.body), new RegExp(`${rawMarker}|fixture auth status failed|ETIMEDOUT`));
      assert.deepEqual(data.store.getAccount(data.target.id).metadata, { identitySource: 'seed' });
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('evidence from an old profile cannot promote an account moved during the read', async () => {
    let releaseAuth;
    const authGate = new Promise((resolve) => { releaseAuth = resolve; });
    let markAuthStarted;
    const authStarted = new Promise((resolve) => { markAuthStarted = resolve; });
    const data = fixture({
      authGate,
      onAuthCall: markAuthStarted,
      targetMetadata: { identitySource: 'seed' },
    });
    const app = verifyApi(data);
    let verification;
    try {
      verification = verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      await authStarted;
      const movedHome = path.join(data.root, 'profiles', 'moved-placeholder');
      fs.mkdirSync(movedHome, { mode: 0o700 });
      const current = data.store.getAccount(data.target.id);
      data.store.saveAccount({
        id: current.id,
        provider: current.provider,
        label: current.label,
        profileRef: movedHome,
        identity: current.identity,
        color: current.color,
        enabled: current.enabled,
        metadata: current.metadata,
      });
      releaseAuth();

      const result = await verification;
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        outcome: 'unavailable',
        detail: 'This account changed while ModelDeck was checking its Claude identity.',
      });
      assert.equal(data.store.getAccount(data.target.id).metadata.identitySource, 'seed');
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      releaseAuth?.();
      if (verification) await verification.catch(() => {});
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('non-Claude accounts return 400 and unknown accounts return 404 without an exec', async () => {
    const data = fixture();
    const app = verifyApi(data);
    try {
      const codexHome = path.join(data.root, 'codex-placeholder');
      fs.mkdirSync(codexHome, { mode: 0o700 });
      const codex = data.store.saveAccount({
        provider: 'codex',
        label: 'Codex Placeholder',
        profileRef: codexHome,
      });

      let result = await verifyApiRequest(app, `/api/accounts/${codex.id}/verify-identity`);
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, {
        error: 'identity verification is only supported for claude accounts',
      });

      result = await verifyApiRequest(app, '/api/accounts/missing/verify-identity');
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'account not found' });
      assert.deepEqual(data.calls, []);
    } finally {
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });
});

test('POST verify-identity returns 409 for same-account work already in flight (#280)', async (t) => {
  await t.test('another identity verification', async () => {
    let releaseAuth;
    const authGate = new Promise((resolve) => { releaseAuth = resolve; });
    let markAuthStarted;
    const authStarted = new Promise((resolve) => { markAuthStarted = resolve; });
    const data = fixture({
      authGate,
      onAuthCall: markAuthStarted,
      targetMetadata: { identitySource: 'verified', claudeAccountUuid: TARGET_UUID },
    });
    const app = verifyApi(data);
    let first;
    try {
      first = verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      await authStarted;
      const conflict = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(conflict.status, 409);
      assert.match(conflict.body.error, /in-flight operation/i);
      releaseAuth();
      assert.deepEqual((await first).body, { outcome: 'verified' });
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      releaseAuth?.();
      if (first) await first.catch(() => {});
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('a renewal for the account', async () => {
    let releaseAuth;
    const authGate = new Promise((resolve) => { releaseAuth = resolve; });
    let markAuthStarted;
    const authStarted = new Promise((resolve) => { markAuthStarted = resolve; });
    const data = fixture({ authGate, onAuthCall: markAuthStarted });
    const app = verifyApi(data);
    let renewal;
    try {
      data.expire();
      renewal = data.service.renewClaudeAccount(data.target.id);
      await authStarted;
      const conflict = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(conflict.status, 409);
      assert.match(conflict.body.error, /in-flight operation/i);
      releaseAuth();
      assert.equal((await renewal).outcome, 'renewed');
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally {
      releaseAuth?.();
      if (renewal) await renewal.catch(() => {});
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });

  await t.test('an activation for the account', async () => {
    let releaseActivation;
    const activationGate = new Promise((resolve) => { releaseActivation = resolve; });
    let markActivationStarted;
    const activationStarted = new Promise((resolve) => { markActivationStarted = resolve; });
    const data = fixture({
      serviceOptions: {
        activateClaude: async () => {
          markActivationStarted();
          await activationGate;
        },
      },
    });
    const app = verifyApi(data);
    let activation;
    try {
      activation = data.service.activateAccount(data.target.id);
      await activationStarted;
      const conflict = await verifyApiRequest(app, `/api/accounts/${data.target.id}/verify-identity`);
      assert.equal(conflict.status, 409);
      assert.match(conflict.body.error, /in-flight operation/i);
      releaseActivation();
      await activation;
      assert.deepEqual(data.calls, []);
    } finally {
      releaseActivation?.();
      if (activation) await activation.catch(() => {});
      assertVerifyNeverInvokedInference(data);
      data.close();
    }
  });
});

test('renewal records why the cheap rung was declined (#263 visibility)', async (t) => {
  await t.test('an identity naming nobody is recorded as absent, not a bare busy', async () => {
    const data = fixture({ statusOutput: JSON.stringify({ loggedIn: true, authMethod: 'none' }) });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'busy');
      assert.equal(renew.identityDecline, 'absent');
      const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
      assert.equal(account.renew.lastAttempt.identityDecline, 'absent');
      assert.equal(account.renew.lastAttempt.path, 'flip');
    } finally { data.close(); }
  });

  await t.test('an identity naming a different account is recorded as mismatched', async () => {
    const data = fixture({ statusOutput: OTHER_ACCOUNT_STATUS });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'busy');
      assert.equal(renew.identityDecline, 'mismatched');
    } finally { data.close(); }
  });

  await t.test('a successful no-flip renewal records no decline at all', async () => {
    const data = fixture();
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'renewed');
      assert.equal(Object.hasOwn(renew, 'identityDecline'), false);
    } finally { data.close(); }
  });

  await t.test('a failed invocation is "error", never the "absent" that means the helper won', async () => {
    // Adversarial review of #263: collapsing these two is the exact confusion
    // the field spent four releases in. A timeout must not read as "the CLI
    // ran and named nobody".
    const data = fixture({ authThrows: true });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'busy');
      assert.equal(renew.identityDecline, 'error');
    } finally { data.close(); }
  });

  await t.test('a failure of ModelDeck’s own setup is "setup-failed", not "absent"', async () => {
    const data = fixture();
    try {
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const scratchRoot = path.dirname(data.calls[0].options.env.CLAUDE_CONFIG_DIR);
      // Make the config dir unpreparable: mkdir of the per-account subdir
      // fails EACCES under a read-only parent.
      fs.rmSync(data.calls[0].options.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
      fs.chmodSync(scratchRoot, 0o500);
      try {
        data.expire();
        const renew = await data.service.renewClaudeAccount(data.target.id);
        assert.equal(renew.identityDecline, 'setup-failed');
      } finally {
        fs.chmodSync(scratchRoot, 0o700);
      }
    } finally { data.close(); }
  });
});

test('the settings-free invariant is enforced, not assumed (#263)', async (t) => {
  await t.test('settings.local.json is swept alongside settings.json', async () => {
    const data = fixture();
    try {
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const configDir = data.calls[0].options.env.CLAUDE_CONFIG_DIR;
      for (const name of ['settings.json', 'settings.local.json']) {
        fs.writeFileSync(path.join(configDir, name), JSON.stringify({ apiKeyHelper: 'echo x' }));
      }
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      for (const name of ['settings.json', 'settings.local.json']) {
        assert.equal(fs.existsSync(path.join(configDir, name)), false);
      }
      assert.equal(renew.outcome, 'renewed');
    } finally { data.close(); }
  });

  await t.test('cwd stays the shared scratch root, so no new project settings path appears', async () => {
    const data = fixture();
    try {
      data.expire();
      await data.service.renewClaudeAccount(data.target.id);
      const call = data.calls[0];
      assert.equal(call.options.cwd, path.join(data.root, 'data', 'claude-renewal'));
      assert.notEqual(call.options.cwd, call.options.env.CLAUDE_CONFIG_DIR);
    } finally { data.close(); }
  });

  await t.test('claudeRenewalEnv refuses to hand the profile back as the config dir', async () => {
    // The unsafe shape must not be constructible by accident: a default of
    // profileRef would silently reinstate #263 for any future caller.
    const data = fixture();
    try {
      assert.throws(() => data.service.claudeRenewalEnv(data.targetHome), /explicit renewal config dir/);
      const env = data.service.claudeRenewalEnv(data.targetHome, '/tmp/cfg-fixture');
      assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/cfg-fixture');
      assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, data.targetHome);
    } finally { data.close(); }
  });
});

test('apiKeyHelper is reported but never blocks renewal (#263)', async (t) => {
  await t.test('helperRouted is surfaced while the account stays renewable', async () => {
    const data = fixture();
    try {
      data.expire();
      const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
      assert.equal(account.renew.helperRouted, true);
      // The distinction that matters: an apiKeyHelper is NOT an auth override.
      // Marking it one would remove the capability this issue restores.
      assert.equal(account.renew.authOverride, false);
      assert.equal(account.renew.available, true);
    } finally { data.close(); }
  });

  await t.test('a profile without a helper omits the key entirely', async () => {
    const data = fixture({ settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } } });
    try {
      data.expire();
      const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
      assert.equal(Object.hasOwn(account.renew, 'helperRouted'), false);
      assert.equal(account.renew.available, true);
    } finally { data.close(); }
  });

  await t.test('a real credential override still blocks renewal, helper or not', async () => {
    const data = fixture({
      settings: { apiKeyHelper: 'echo sk-placeholder', env: { ANTHROPIC_API_KEY: 'placeholder' } },
    });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'auth-overridden');
      const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
      assert.equal(account.renew.authOverride, true);
      assert.equal(account.renew.available, false);
    } finally { data.close(); }
  });
});
