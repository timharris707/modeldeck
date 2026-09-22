import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateClaudeProfile } from '../src/adapters/claude.mjs';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

const EXPIRED = 'Claude usage refresh failed: stored OAuth credentials have expired; sign in explicitly before refreshing';
const MISSING = 'Claude usage refresh failed: stored OAuth credentials are unavailable; sign in explicitly before refreshing';
const SNAPSHOTS = [{ scope: 'weekly', usedPercent: 10, source: 'fixture' }];
const TARGET_EMAIL = 'target@example.invalid';
const TARGET_UUID = 'uuid-target';
const MATCHING_STATUS = JSON.stringify({ email: TARGET_EMAIL, accountUuid: TARGET_UUID });
// Issue #251: promise-first busy copy, pinned verbatim.
const BUSY_DETAIL = 'Will renew automatically at the next quiet moment — a Claude session is running right now.';

function snapshotsExpiringAt(expiresAt) {
  const snapshots = SNAPSHOTS.map((snapshot) => ({ ...snapshot }));
  Object.defineProperty(snapshots, 'expiresAt', { value: expiresAt, enumerable: false });
  return snapshots;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-renewal-'));
  const profilesDir = path.join(root, 'profiles');
  const priorHome = path.join(profilesDir, 'prior');
  const targetHome = path.join(profilesDir, 'target');
  fs.mkdirSync(priorHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);
  fs.chmodSync(priorHome, 0o700);
  fs.chmodSync(targetHome, 0o700);
  const activeLink = path.join(root, 'active', '.claude');
  fs.mkdirSync(path.dirname(activeLink), { recursive: true });
  fs.symlinkSync(priorHome, activeLink, 'dir');
  const store = options.store || new Store(':memory:');
  const calls = [];
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    claudeActiveLink: activeLink,
    dataDir: path.join(root, 'data'),
    platform: 'linux',
    claudeCredentialsPresent: async () => true,
    listProviderProcesses: async () => [],
    childEnv: {
      PATH: '/fixture/bin',
      ANTHROPIC_API_KEY: 'must-not-reach-child',
      ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
      ANTHROPIC_BASE_URL: 'https://must-not-reach-child.invalid',
    },
    userInfo: () => ({ username: 'fixture-user' }),
    exec: async (command, args, execOptions) => {
      calls.push({
        command,
        args,
        options: execOptions,
        activeProfile: fs.realpathSync(activeLink),
      });
      if (args[0] === 'auth' && options.statusError) {
        throw Object.assign(new Error('fixture auth status exit'), {
          stdout: options.statusOutput ?? MATCHING_STATUS,
        });
      }
      return {
        stdout: args[0] === 'auth' ? options.statusOutput ?? MATCHING_STATUS : '',
        stderr: '',
      };
    },
    fetchClaude: async () => SNAPSHOTS,
    ...options.serviceOptions,
  });
  const prior = store.saveAccount({ provider: 'claude', label: 'Prior', profileRef: priorHome, isDefault: true });
  const target = store.saveAccount({
    provider: 'claude',
    label: 'Target',
    profileRef: targetHome,
    identity: TARGET_EMAIL,
    metadata: { claudeAccountUuid: TARGET_UUID },
  });
  return {
    root, profilesDir, priorHome, targetHome, activeLink, store, service, calls, prior, target,
    expire(account = target) {
      service.recordAccountRefreshResults([{ accountId: account.id, ok: false, error: EXPIRED }]);
    },
    close() {
      if (!options.store) store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertPinnedRenewalCalls(data, calls = data.calls) {
  const scratchRoot = path.join(data.root, 'data', 'claude-renewal');
  for (const call of calls) {
    assert.equal(call.options.timeout, 60_000);
    // Issue #263: the renewal child no longer reads the PROFILE's settings.
    // Its config dir is a per-account scratch directory under the renewal
    // scratch root, so `apiKeyHelper` (and the proxy base URL) cannot reach
    // the CLI and blank out the identity the no-flip rung depends on.
    // Credential scoping still points at the real profile — that is the
    // separation the whole fix rests on.
    // cwd is unchanged from before #263: only the env moved.
    assert.equal(call.options.cwd, scratchRoot);
    const configDir = call.options.env.CLAUDE_CONFIG_DIR;
    assert.equal(path.dirname(configDir), scratchRoot);
    assert.match(path.basename(configDir), /^cfg-[0-9a-f]{12}$/);
    assert.notEqual(configDir, data.targetHome);
    assert.equal(call.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, data.targetHome);
    assert.equal(call.options.env.USER, 'fixture-user');
    for (const name of ['settings.json', 'settings.local.json']) {
      assert.equal(fs.existsSync(path.join(configDir, name)), false);
    }
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      assert.equal(Object.hasOwn(call.options.env, key), false);
    }
  }
}

test('renewal child scrubs an ANTHROPIC_API_KEY inherited from a pinned-shell daemon', () => {
  const data = fixture();
  try {
    const env = data.service.claudeRenewalEnv(data.targetHome, path.join(data.root, 'renewal-config'));
    assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false);
    assert.equal(env.PATH, '/fixture/bin');
  } finally { data.close(); }
});

test('renewal-network-failure-names-dns-and-is-not-budgeted', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const data = fixture({
    serviceOptions: {
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        throw Object.assign(new Error('renewal failed'), {
          stderr: "Can't reach the API server — check your internet or DNS (ENOTFOUND)",
          code: 1,
        });
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    const saved = data.store.getAccount(data.target.id).metadata.claudeRenewal;
    assert.equal(renew.outcome, 'failed');
    assert.equal(renew.cause, 'network');
    assert.match(renew.detail, /DNS/);
    assert.equal(saved.attempts.length, 0);
    assert.equal(saved.consecutiveFailures, 1);
    assert.match(logs.join('\n'), /account=Target.*cause=network/);
  } finally { data.close(); }
});

test('renewal-auth-failure-is-budgeted-and-names-the-cause', async (t) => {
  const data = fixture({
    serviceOptions: {
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        throw Object.assign(new Error('renewal failed'), { stderr: '401 invalid_grant', code: 1 });
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    const saved = data.store.getAccount(data.target.id).metadata.claudeRenewal;
    assert.equal(renew.cause, 'auth');
    assert.match(renew.detail, /sign in again/i);
    assert.equal(saved.attempts.length, 1);
  } finally { data.close(); }
});

test('renewal-other-failure-redacts-secrets', async (t) => {
  const secret = `sk-ant-oat01-${'x'.repeat(60)}`;
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const data = fixture({
    serviceOptions: {
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        throw Object.assign(new Error('renewal failed'), { stderr: secret, code: 1 });
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.cause, 'other');
    assert.match(renew.detail, /<redacted>/);
    assert.equal(renew.detail.includes(secret), false);
    assert.equal(logs.some((line) => line.includes(secret)), false);
  } finally { data.close(); }
});

test('renewal-network-failures-still-back-off-30-minutes', async () => {
  let timestamp = Date.parse('2026-09-22T12:00:00Z');
  const data = fixture({
    serviceOptions: {
      now: () => timestamp,
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        throw Object.assign(new Error('network'), { stderr: 'ENOTFOUND api.anthropic.com', code: 1 });
      },
    },
  });
  try {
    data.expire();
    await data.service.renewClaudeAccount(data.target.id);
    let account = data.store.getAccount(data.target.id);
    assert.equal(account.metadata.claudeRenewal.attempts.length, 0);
    timestamp += 5 * 60_000;
    assert.equal(data.service.renewalAttemptAllowed(account), false);
    timestamp += 30 * 60_000;
    account = data.store.getAccount(data.target.id);
    assert.equal(data.service.renewalAttemptAllowed(account), true);
  } finally { data.close(); }
});

// Review of #724 (PR #731), MAJOR 1: the manual path (the Settings "Renew
// now" click) must honour the same 30-minute backoff the scheduler does after
// an unbudgeted network failure, or a dead network becomes a tight loop.
test('renewal-manual-path-honours-network-backoff', async () => {
  let timestamp = Date.parse('2026-09-22T12:00:00Z');
  let invokes = 0;
  const data = fixture({
    serviceOptions: {
      now: () => timestamp,
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        invokes += 1;
        throw Object.assign(new Error('network'), { stderr: 'ENOTFOUND api.anthropic.com', code: 1 });
      },
    },
  });
  try {
    data.expire();
    await data.service.renewClaudeAccount(data.target.id);
    timestamp += 5 * 60_000;
    const second = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(second.outcome, 'rate-limited');
    assert.match(second.detail, /30 minutes/);
    assert.equal(invokes, 1);
    // CodeRabbit on PR #731: the refusal must not itself clear the backoff.
    timestamp += 5 * 60_000;
    const third = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(third.outcome, 'rate-limited');
    assert.equal(invokes, 1);
    timestamp += 30 * 60_000;
    await data.service.renewClaudeAccount(data.target.id);
    assert.equal(invokes, 2);
  } finally { data.close(); }
});

// Review of #724 (PR #731), MAJOR 2: explicit auth evidence wins over the
// broad "Connection error" marker, so a rejected sign-in is budgeted and
// named even when the CLI wraps it in connection wording.
test('renewal-auth-evidence-outranks-connection-wording', async () => {
  const data = fixture({
    serviceOptions: {
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        throw Object.assign(new Error('renewal failed'), { stderr: 'Connection error: 401 invalid_grant', code: 1 });
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.cause, 'auth');
    assert.equal(data.store.getAccount(data.target.id).metadata.claudeRenewal.attempts.length, 1);
  } finally { data.close(); }
});

// CodeRabbit on PR #731: short Basic/Bearer values and token= fields must be
// redacted too, not only 40+ character runs.
test('renewal-other-failure-redacts-short-auth-values', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const data = fixture({
    serviceOptions: {
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        throw Object.assign(new Error('renewal failed'), {
          stderr: 'upstream said no: Authorization: Basic dXNlcjpwdw== Bearer abc123 token=shortone authToken=xyz9',
          code: 1,
        });
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    const joined = `${renew.detail}\n${logs.join('\n')}`;
    for (const secret of ['dXNlcjpwdw==', 'abc123', 'shortone', 'xyz9']) assert.ok(!joined.includes(secret), secret);
    assert.match(renew.detail, /Basic <redacted>/);
  } finally { data.close(); }
});

// CodeRabbit on PR #731: a renewal that lands while verifyAccount awaits the
// provider probe must not be overwritten by the pre-probe snapshot.
test('verify-reset-keeps-a-renewal-recorded-during-the-probe', async () => {
  const data = fixture({
    serviceOptions: {
      fetchClaude: async () => { throw new Error(EXPIRED); },
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        throw Object.assign(new Error('network'), { stderr: 'ENOTFOUND api.anthropic.com', code: 1 });
      },
    },
  });
  try {
    data.expire();
    await data.service.renewClaudeAccount(data.target.id);
    const before = data.store.getAccount(data.target.id);
    assert.equal(before.metadata.claudeRenewal.consecutiveFailures, 1);
    // Simulate a renewal landing mid-probe: mutate the stored row after the
    // snapshot verifyAccount would have taken.
    const stored = data.store.getAccount(data.target.id);
    data.store.saveAccount({ ...stored, metadata: { ...stored.metadata, claudeRenewal: { ...stored.metadata.claudeRenewal, lastAttempt: { at: 'later', outcome: 'renewed' } } } });
    const latest = data.store.getAccount(data.target.id);
    // Drive the same reset branch verifyAccount uses, with `account` stale and `latest` fresh.
    const metadata = { ...before.metadata };
    metadata.claudeRenewal = { ...latest.metadata.claudeRenewal, consecutiveFailures: 0 };
    assert.equal(metadata.claudeRenewal.lastAttempt.outcome, 'renewed');
    assert.equal(metadata.claudeRenewal.consecutiveFailures, 0);
  } finally { data.close(); }
});

test('renewed-resets-consecutive-failures', async () => {
  const data = fixture();
  try {
    const at = (minutes) => new Date(Date.parse('2026-09-22T12:00:00Z') + minutes * 60_000).toISOString();
    data.service.recordClaudeRenewalAttempt(data.target.id, {
      at: at(0), outcome: 'failed', cause: 'network', mechanism: 'invoke', detail: 'Could not reach Anthropic',
    });
    data.service.recordClaudeRenewalAttempt(data.target.id, {
      at: at(1), outcome: 'failed', cause: 'network', mechanism: 'invoke', detail: 'Could not reach Anthropic',
    });
    assert.equal(data.store.getAccount(data.target.id).metadata.claudeRenewal.consecutiveFailures, 2);
    data.service.recordClaudeRenewalAttempt(data.target.id, {
      at: at(2), outcome: 'renewed', mechanism: 'invoke', detail: 'renewed',
    });
    assert.equal(data.store.getAccount(data.target.id).metadata.claudeRenewal.consecutiveFailures, 0);
    const stateAccount = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
    assert.equal(stateAccount.renew.consecutiveFailures, 0);
  } finally { data.close(); }
});

test('renewal preconditions return distinct decided outcomes without invoking Claude', async (t) => {
  await t.test('non-Claude accounts fail with provider mismatch and no renewal metadata', async () => {
    const data = fixture();
    try {
      const codexHome = path.join(data.root, 'codex');
      fs.mkdirSync(codexHome, { mode: 0o700 });
      const codex = data.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: codexHome });
      await assert.rejects(data.service.renewClaudeAccount(codex.id), /provider mismatch/i);
      assert.equal(Object.hasOwn(data.store.getAccount(codex.id).metadata, 'claudeRenewal'), false);
      assert.equal(data.calls.length, 0);
    } finally { data.close(); }
  });

  await t.test('signin-required for disabled Claude accounts', async () => {
    const data = fixture();
    try {
      const disabled = data.store.saveAccount({ ...data.target, enabled: false });
      const renew = await data.service.renewClaudeAccount(disabled.id);
      assert.equal(renew.outcome, 'signin-required');
      assert.equal(data.calls.length, 0);
    } finally { data.close(); }
  });

  await t.test('signin-required for a missing rather than expired sign-in', async () => {
    const data = fixture();
    try {
      data.service.recordAccountRefreshResults([{ accountId: data.target.id, ok: false, error: MISSING }]);
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'signin-required');
      assert.equal(renew.mechanism, null);
      assert.equal(data.calls.length, 0);
    } finally { data.close(); }
  });

  await t.test('a healthy token cannot enter renewal', async () => {
    const data = fixture();
    try {
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'signin-required');
      assert.equal(data.calls.length, 0);
    } finally { data.close(); }
  });

  await t.test('auth-overridden for a profile settings env override', async () => {
    const data = fixture();
    try {
      data.expire();
      fs.writeFileSync(path.join(data.targetHome, 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: 'placeholder-never-read-back' },
      }));
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'auth-overridden');
      assert.equal(renew.mechanism, null);
      assert.equal(data.calls.length, 0);
      const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
      assert.equal(account.renew.available, false);
      assert.equal(account.renew.authOverride, true);
    } finally { data.close(); }
  });

  await t.test('a base URL alongside a credential override still declines renewal', async () => {
    const data = fixture();
    try {
      data.expire();
      fs.writeFileSync(path.join(data.targetHome, 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_API_KEY: 'placeholder-never-read-back' },
      }));
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'auth-overridden');
      assert.equal(renew.mechanism, null);
      assert.equal(data.calls.length, 0);
    } finally { data.close(); }
  });

});

test('a base-URL-only proxy route renews with the invocation pinned back to Anthropic', async () => {
  let probes = 0;
  const data = fixture({
    serviceOptions: {
      listProviderProcesses: async () => ['claude'],
      fetchClaude: async () => {
        probes += 1;
        if (probes === 1) throw new Error(EXPIRED);
        return SNAPSHOTS;
      },
    },
  });
  try {
    data.expire();
    fs.writeFileSync(path.join(data.targetHome, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' },
    }));
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed');
    assert.equal(renew.mechanism, 'invoke');
    assert.equal(renew.path, 'no-flip');
    assert.deepEqual(data.calls.map((call) => call.args), [
      ['auth', 'status', '--json'],
      ['-p', 'ok', '--model', 'claude-haiku-4-5-20251001',
        '--settings', '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}'],
    ]);
    assertPinnedRenewalCalls(data);
    const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
    assert.equal(account.renew.authOverride, false);
  } finally { data.close(); }
});

test('the no-flip identity gate accepts matching email or account UUID and rejects missing or contradictory identity', async (t) => {
  await t.test('a normalized nested email match is sufficient', async () => {
    const data = fixture({
      statusOutput: JSON.stringify({ account: { emailAddress: '  TARGET@EXAMPLE.INVALID  ' } }),
      serviceOptions: { listProviderProcesses: async () => ['claude'] },
    });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
      assert.equal(data.calls.length, 1);
    } finally { data.close(); }
  });

  await t.test('an account UUID match is sufficient when no emails are comparable', async () => {
    const data = fixture({
      statusOutput: JSON.stringify({ oauthAccount: { account_uuid: TARGET_UUID } }),
      serviceOptions: { listProviderProcesses: async () => ['claude'] },
    });
    try {
      data.store.saveAccount({ ...data.target, identity: '' });
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
      assert.equal(data.calls.length, 1);
    } finally { data.close(); }
  });

  await t.test('matching JSON from a nonzero auth-status exit is still usable evidence', async () => {
    const data = fixture({
      statusError: true,
      serviceOptions: { listProviderProcesses: async () => ['claude'] },
    });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally { data.close(); }
  });

  await t.test('a target with no stored identity cannot authorize no-flip renewal', async () => {
    const data = fixture({ serviceOptions: { listProviderProcesses: async () => ['claude'] } });
    try {
      data.store.saveAccount({ ...data.target, identity: '', metadata: {} });
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'busy');
      assert.equal(renew.detail, BUSY_DETAIL);
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    } finally { data.close(); }
  });

  await t.test('one matching identifier cannot excuse a contradictory identifier', async () => {
    const data = fixture({
      statusOutput: JSON.stringify({ email: 'other@example.invalid', accountUuid: TARGET_UUID }),
      serviceOptions: { listProviderProcesses: async () => ['claude'] },
    });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'busy');
      assert.equal(renew.mechanism, null);
      assert.equal(renew.path, 'flip');
      assert.equal(renew.detail, BUSY_DETAIL);
      assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
      assert.equal(data.calls.some((call) => call.args[0] === '-p'), false);
    } finally { data.close(); }
  });

  await t.test('an explicitly signed-out status cannot authorize a stale matching identity', async () => {
    const data = fixture({
      statusOutput: JSON.stringify({ loggedIn: false, email: TARGET_EMAIL }),
      serviceOptions: { listProviderProcesses: async () => ['claude'] },
    });
    try {
      data.expire();
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.equal(renew.outcome, 'busy');
      assert.equal(renew.detail, BUSY_DETAIL);
      assert.equal(data.calls.some((call) => call.args[0] === '-p'), false);
    } finally { data.close(); }
  });

  for (const [name, statusOutput] of [['missing', '{}'], ['unparseable', 'signed in without JSON']]) {
    await t.test(`${name} status identity fails closed without an invocation`, async () => {
      const data = fixture({
        statusOutput,
        serviceOptions: { listProviderProcesses: async () => ['claude'] },
      });
      try {
        data.expire();
        const renew = await data.service.renewClaudeAccount(data.target.id);
        assert.equal(renew.outcome, 'busy');
        assert.equal(renew.detail, BUSY_DETAIL);
        assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
        assert.equal(data.calls.some((call) => call.args[0] === '-p'), false);
      } finally { data.close(); }
    });
  }
});

test('matching auth-status renews without a flip while Claude is running and sanitizes the child environment', async () => {
  const data = fixture({ serviceOptions: { listProviderProcesses: async () => ['claude', 'codex'] } });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed');
    assert.equal(renew.mechanism, 'auth-status');
    assert.equal(renew.path, 'no-flip');
    assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    assertPinnedRenewalCalls(data);
    assert.equal(data.calls[0].activeProfile, fs.realpathSync(data.priorHome));
    assert.equal(fs.realpathSync(data.activeLink), fs.realpathSync(data.priorHome));
    assert.equal(data.store.getAccount(data.prior.id).isDefault, true);
    assert.equal(data.store.getAccount(data.target.id).isDefault, false);
    assert.equal(data.store.getAccount(data.target.id).metadata.claudeRenewal.lastAttempt.path, 'no-flip');
    const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
    // #263 made `path` additive on the wire: which rung ran is the fact that
    // distinguishes "a session was in the way" from "the cheap rung was never
    // tried", and the latter is what hid this defect for four releases.
    assert.deepEqual(account.renew.lastAttempt, {
      at: renew.at,
      outcome: 'renewed',
      mechanism: 'auth-status',
      path: 'no-flip',
    });
  } finally { data.close(); }
});

test('matching renewal promotes only seeded Claude identity provenance (#280)', async (t) => {
  await t.test('a seeded match becomes verified, learns the UUID, and is visible in state metadata', async () => {
    const data = fixture();
    try {
      data.store.saveAccount({
        id: data.target.id,
        provider: data.target.provider,
        label: data.target.label,
        profileRef: data.target.profileRef,
        identity: data.target.identity,
        color: data.target.color,
        enabled: data.target.enabled,
        metadata: { identitySource: 'seed', fixtureMarker: 'preserved' },
      });
      data.expire();

      const renew = await data.service.renewClaudeAccount(data.target.id);

      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.mechanism, 'auth-status');
      assert.equal(renew.path, 'no-flip');
      const saved = data.store.getAccount(data.target.id);
      assert.equal(saved.metadata.identitySource, 'verified');
      assert.equal(saved.metadata.claudeAccountUuid, TARGET_UUID);
      assert.equal(saved.metadata.fixtureMarker, 'preserved');
      const stateAccount = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
      assert.equal(stateAccount.metadata.identitySource, 'verified');
      assert.equal(stateAccount.metadata.claudeAccountUuid, TARGET_UUID);
    } finally { data.close(); }
  });

  await t.test('an already-verified match performs zero identity store writes', async () => {
    const data = fixture();
    try {
      data.store.saveAccount({
        id: data.target.id,
        provider: data.target.provider,
        label: data.target.label,
        profileRef: data.target.profileRef,
        identity: data.target.identity,
        color: data.target.color,
        enabled: data.target.enabled,
        metadata: { identitySource: 'verified' },
      });
      data.expire();

      // A completed renewal always persists its attempt history. Stub that
      // established bookkeeping write so this pin measures only #280's
      // promotion path: already-verified evidence must not call saveAccount.
      data.service.recordClaudeRenewalAttempt = (_accountId, attempt) => attempt;
      const originalSave = data.store.saveAccount.bind(data.store);
      let identityWrites = 0;
      data.store.saveAccount = (input) => {
        identityWrites += 1;
        return originalSave(input);
      };

      const renew = await data.service.renewClaudeAccount(data.target.id);

      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
      assert.equal(identityWrites, 0);
      assert.equal(data.store.getAccount(data.target.id).metadata.identitySource, 'verified');
      assert.equal(data.store.getAccount(data.target.id).metadata.claudeAccountUuid, undefined);
    } finally { data.close(); }
  });

  await t.test('an unseeded match performs zero identity store writes', async () => {
    const data = fixture();
    try {
      data.store.saveAccount({
        id: data.target.id,
        provider: data.target.provider,
        label: data.target.label,
        profileRef: data.target.profileRef,
        identity: data.target.identity,
        color: data.target.color,
        enabled: data.target.enabled,
        metadata: {},
      });
      data.expire();

      data.service.recordClaudeRenewalAttempt = (_accountId, attempt) => attempt;
      const originalSave = data.store.saveAccount.bind(data.store);
      let identityWrites = 0;
      data.store.saveAccount = (input) => {
        identityWrites += 1;
        return originalSave(input);
      };

      const renew = await data.service.renewClaudeAccount(data.target.id);

      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
      assert.equal(identityWrites, 0);
      assert.equal(data.store.getAccount(data.target.id).metadata.identitySource, undefined);
      assert.equal(data.store.getAccount(data.target.id).metadata.claudeAccountUuid, undefined);
    } finally { data.close(); }
  });

  await t.test('a mismatched seeded identity stays untouched and keeps the existing renewal outcome', async () => {
    const data = fixture({
      statusOutput: JSON.stringify({
        email: 'other@example.invalid',
        accountUuid: 'uuid-other-placeholder',
      }),
    });
    try {
      const metadata = { identitySource: 'seed', fixtureMarker: 'preserved' };
      data.store.saveAccount({
        id: data.target.id,
        provider: data.target.provider,
        label: data.target.label,
        profileRef: data.target.profileRef,
        identity: data.target.identity,
        color: data.target.color,
        enabled: data.target.enabled,
        metadata,
      });
      data.expire();

      const renew = await data.service.renewClaudeAccount(data.target.id);

      // This is the pre-#280 mismatch result: a quiet guarded flip succeeds.
      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.mechanism, 'auth-status');
      assert.equal(renew.path, 'flip');
      assert.equal(renew.identityDecline, 'mismatched');
      const saved = data.store.getAccount(data.target.id);
      assert.equal(saved.identity, TARGET_EMAIL);
      assert.equal(saved.metadata.identitySource, 'seed');
      assert.equal(saved.metadata.claudeAccountUuid, undefined);
      assert.equal(saved.metadata.fixtureMarker, 'preserved');
    } finally { data.close(); }
  });

  await t.test('ambiguous reported UUIDs are never chosen for metadata', async () => {
    const data = fixture({
      statusOutput: JSON.stringify({
        email: TARGET_EMAIL,
        accountUuid: 'uuid-first-placeholder',
        nested: { account_uuid: 'uuid-second-placeholder' },
      }),
    });
    try {
      data.store.saveAccount({
        id: data.target.id,
        provider: data.target.provider,
        label: data.target.label,
        profileRef: data.target.profileRef,
        identity: data.target.identity,
        color: data.target.color,
        enabled: data.target.enabled,
        metadata: { identitySource: 'seed' },
      });
      data.expire();

      const renew = await data.service.renewClaudeAccount(data.target.id);

      assert.equal(renew.outcome, 'renewed');
      assert.equal(renew.path, 'no-flip');
      const saved = data.store.getAccount(data.target.id);
      assert.equal(saved.metadata.identitySource, 'verified');
      assert.equal(saved.metadata.claudeAccountUuid, undefined);
    } finally { data.close(); }
  });
});

test('identity mismatch falls back to a quiet guarded flip and restores activation', async () => {
  const data = fixture({ statusOutput: JSON.stringify({ email: 'other@example.invalid' }) });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed');
    assert.equal(renew.mechanism, 'auth-status');
    assert.equal(renew.path, 'flip');
    assert.deepEqual(data.calls.map((call) => call.args), [
      ['auth', 'status', '--json'],
      ['auth', 'status', '--json'],
    ]);
    assert.equal(data.calls[0].activeProfile, fs.realpathSync(data.priorHome));
    assert.equal(data.calls[1].activeProfile, fs.realpathSync(data.targetHome));
    assertPinnedRenewalCalls(data);
    assert.equal(fs.realpathSync(data.activeLink), fs.realpathSync(data.priorHome));
    assert.equal(data.store.getAccount(data.target.id).metadata.claudeRenewal.lastAttempt.path, 'flip');
  } finally { data.close(); }
});

test('identity mismatch keeps the flip fallback guarded and pins the busy detail', async () => {
  const data = fixture({
    statusOutput: JSON.stringify({ email: 'other@example.invalid' }),
    serviceOptions: { listProviderProcesses: async () => ['claude', 'codex'] },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'busy');
    assert.equal(renew.mechanism, null);
    assert.equal(renew.path, 'flip');
    assert.equal(renew.detail, BUSY_DETAIL);
    assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    assert.equal(fs.realpathSync(data.activeLink), fs.realpathSync(data.priorHome));
    const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
    assert.equal(account.renew.available, true, 'availability intentionally ignores transient busy state');
  } finally { data.close(); }
});

test('a quiet identity mismatch may invoke only after the flip makes the target active', async () => {
  let probes = 0;
  const data = fixture({
    statusOutput: JSON.stringify({ email: 'other@example.invalid' }),
    serviceOptions: {
      fetchClaude: async () => {
        probes += 1;
        if (probes === 1) throw new Error(EXPIRED);
        return SNAPSHOTS;
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed');
    assert.equal(renew.mechanism, 'invoke');
    assert.equal(renew.path, 'flip');
    assert.deepEqual(data.calls.map((call) => call.args), [
      ['auth', 'status', '--json'],
      ['auth', 'status', '--json'],
      ['-p', 'ok', '--model', 'claude-haiku-4-5-20251001'],
    ]);
    assert.equal(data.calls[0].activeProfile, fs.realpathSync(data.priorHome));
    assert.deepEqual(data.calls.slice(1).map((call) => call.activeProfile), [
      fs.realpathSync(data.targetHome),
      fs.realpathSync(data.targetHome),
    ]);
    assertPinnedRenewalCalls(data);
  } finally { data.close(); }
});

test('expired auth-status verification falls back to the pinned Haiku invocation', async () => {
  let probes = 0;
  const data = fixture({
    serviceOptions: {
      listProviderProcesses: async () => ['claude'],
      fetchClaude: async () => {
        probes += 1;
        if (probes === 1) throw new Error(EXPIRED);
        return SNAPSHOTS;
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed');
    assert.equal(renew.mechanism, 'invoke');
    assert.equal(renew.path, 'no-flip');
    assert.deepEqual(data.calls.map((call) => call.args), [
      ['auth', 'status', '--json'],
      ['-p', 'ok', '--model', 'claude-haiku-4-5-20251001'],
    ]);
    assertPinnedRenewalCalls(data);
    assert.deepEqual(data.calls.map((call) => call.activeProfile), [
      fs.realpathSync(data.priorHome),
      fs.realpathSync(data.priorHome),
    ]);
    assert.equal(fs.realpathSync(data.activeLink), fs.realpathSync(data.priorHome));
  } finally { data.close(); }
});

test('an unsupported pinned model retries the invocation without --model', async () => {
  let probes = 0;
  const data = fixture({
    serviceOptions: {
      exec: async (command, args, execOptions) => {
        data.calls.push({
          command,
          args,
          options: execOptions,
          activeProfile: fs.realpathSync(data.activeLink),
        });
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        if (args.includes('--model')) throw Object.assign(new Error('unknown model'), { stderr: 'model not found' });
        return { stdout: '', stderr: '' };
      },
      fetchClaude: async () => {
        probes += 1;
        if (probes === 1) throw new Error(EXPIRED);
        return SNAPSHOTS;
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed');
    assert.deepEqual(data.calls.map((call) => call.args), [
      ['auth', 'status', '--json'],
      ['-p', 'ok', '--model', 'claude-haiku-4-5-20251001'],
      ['-p', 'ok'],
    ]);
  } finally { data.close(); }
});

test('successful CLI fallback is still failed when the target profile probe remains expired', async () => {
  const data = fixture({ serviceOptions: { fetchClaude: async () => { throw new Error(EXPIRED); } } });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'failed');
    assert.equal(renew.mechanism, 'invoke');
    assert.equal(data.calls.length, 2);
    assert.equal(fs.realpathSync(data.activeLink), fs.realpathSync(data.priorHome), 'probe throws still restore the prior activation');
  } finally { data.close(); }
});

test('restore failure overrides renewal success and is persisted visibly in state', async () => {
  let activations = 0;
  const data = fixture({
    statusOutput: JSON.stringify({ email: 'other@example.invalid' }),
    serviceOptions: {
      activateClaude: async (options) => {
        activations += 1;
        if (activations === 2) throw new Error('fixture restore failure');
        return activateClaudeProfile(options);
      },
    },
  });
  try {
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'failed');
    assert.equal(renew.mechanism, 'auth-status');
    assert.equal(renew.path, 'flip');
    assert.match(renew.detail, /restore/i);
    const account = (await data.service.state()).accounts.find((item) => item.id === data.target.id);
    assert.equal(account.renew.lastAttempt.outcome, 'failed');
    assert.match(account.renew.error, /restore/i);
  } finally { data.close(); }
});

test('an unsafe previous profile aborts renewal before the active link flips', async () => {
  const data = fixture({ statusOutput: JSON.stringify({ email: 'other@example.invalid' }) });
  try {
    data.expire();
    fs.chmodSync(data.priorHome, 0o755);
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'failed');
    assert.equal(renew.mechanism, null);
    assert.equal(renew.path, 'flip');
    assert.match(renew.detail, /previously active Claude profile/i);
    assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    assert.equal(fs.realpathSync(data.activeLink), fs.realpathSync(data.priorHome));
  } finally { data.close(); }
});

test('manual renewal enforces the daily cap without extending the rolling window', async () => {
  let timestamp = Date.parse('2026-07-31T12:00:00Z');
  const data = fixture({ serviceOptions: { now: () => timestamp } });
  try {
    data.expire();
    for (const hoursAgo of [23, 20, 16, 12, 8, 4]) {
      data.service.recordClaudeRenewalAttempt(data.target.id, {
        at: new Date(timestamp - hoursAgo * 60 * 60_000).toISOString(),
        outcome: 'failed',
        mechanism: null,
        detail: 'fixture',
      });
    }
    const before = data.store.getAccount(data.target.id).metadata.claudeRenewal.attempts;

    for (let click = 0; click < 2; click += 1) {
      const renew = await data.service.renewClaudeAccount(data.target.id);
      assert.deepEqual(renew, {
        at: new Date(timestamp).toISOString(),
        outcome: 'rate-limited',
        mechanism: null,
        detail: 'This account has reached the Claude renewal limit for the last 24 hours; try again later.',
      });
    }
    assert.equal(data.calls.length, 0);
    const metadata = data.store.getAccount(data.target.id).metadata.claudeRenewal;
    assert.deepEqual(metadata.attempts, before);
    assert.equal(metadata.lastAttempt.at, new Date(timestamp).toISOString());
    assert.equal(metadata.lastAttempt.outcome, 'rate-limited');

    timestamp += 2 * 60 * 60_000;
    const renew = await data.service.renewClaudeAccount(data.target.id);
    assert.equal(renew.outcome, 'renewed', 'the rejected clicks do not keep the oldest attempt inside the window');
    assert.equal(data.calls.length, 1);
  } finally { data.close(); }
});

test('a second renewal conflicts immediately while the first is in flight', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const data = fixture({ serviceOptions: { fetchClaude: async () => { await blocked; return SNAPSHOTS; } } });
  try {
    data.expire();
    const first = data.service.renewClaudeAccount(data.target.id);
    await Promise.resolve();
    await assert.rejects(data.service.renewClaudeAccount(data.target.id), { statusCode: 409 });
    release();
    assert.equal((await first).outcome, 'renewed');
  } finally { data.close(); }
});

test('renewal waits for an in-flight manual activation before flipping the profile', async () => {
  let releaseActivation;
  let activationStarted;
  const started = new Promise((resolve) => { activationStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseActivation = resolve; });
  let activationCalls = 0;
  const data = fixture({
    statusOutput: JSON.stringify({ email: 'other@example.invalid' }),
    serviceOptions: {
      activateClaude: async (options) => {
        activationCalls += 1;
        if (activationCalls === 1) {
          activationStarted();
          await blocked;
        }
        return activateClaudeProfile(options);
      },
    },
  });
  try {
    data.expire();
    const activation = data.service.activateAccount(data.target.id);
    await started;
    const renewal = data.service.renewClaudeAccount(data.target.id);
    await Promise.resolve();
    assert.equal(data.calls.length, 0, 'the renewal CLI cannot start inside activation');
    releaseActivation();
    await activation;
    assert.equal((await renewal).outcome, 'renewed');
    assert.equal(data.calls.length, 2);
  } finally { data.close(); }
});

test('renewal keeps its legitimate queue wait when activation uses the short starvation budget', async () => {
  let releaseActivation;
  let activationStarted;
  const started = new Promise((resolve) => { activationStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseActivation = resolve; });
  let activationCalls = 0;
  const data = fixture({
    statusOutput: JSON.stringify({ email: 'other@example.invalid' }),
    serviceOptions: {
      claudeActivationQueueTimeoutMs: 15,
      claudeActivationOperationTimeoutMs: 200,
      activateClaude: async (options) => {
        activationCalls += 1;
        if (activationCalls === 1) {
          activationStarted();
          await blocked;
        }
        return activateClaudeProfile(options);
      },
    },
  });
  try {
    data.expire();
    const activation = data.service.activateAccount(data.target.id);
    await started;
    const renewalOutcome = data.service.renewClaudeAccount(data.target.id).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(data.calls.length, 0, 'renewal remains serialized behind the legitimate activation');
    releaseActivation();
    await activation;
    const outcome = await renewalOutcome;
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value.outcome, 'renewed');
  } finally { data.close(); }
});

test('TRIPWIRE #564: two full token lifetimes spend exactly one budget attempt each, none pre-expiry', async () => {
  let timestamp = Date.parse('2026-08-08T12:00:00Z');
  let credentialExpiresAt = timestamp + 8 * 60 * 60_000;
  let cliInvocations = 0;
  let data;
  data = fixture({
    serviceOptions: {
      now: () => timestamp,
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        if (args[0] === '-p') {
          cliInvocations += 1;
          credentialExpiresAt = timestamp + 8 * 60 * 60_000;
        }
        return { stdout: '', stderr: '' };
      },
      fetchClaude: async ({ claudeConfigDir }) => {
        if (claudeConfigDir !== data.targetHome) return SNAPSHOTS;
        if (credentialExpiresAt <= timestamp) throw new Error(EXPIRED);
        return snapshotsExpiringAt(credentialExpiresAt);
      },
    },
  });
  try {
    // Seed the legacy pre-expiry bookkeeping an upgraded install carries.
    data.store.saveAccount({
      ...data.store.getAccount(data.target.id),
      metadata: {
        ...data.store.getAccount(data.target.id).metadata,
        claudeRenewal: {
          attempts: [],
          lastPreExpiryAttemptAt: '2026-08-08T09:00:00.000Z',
          postExpiryGuardUntil: '2026-08-08T10:30:00.000Z',
        },
      },
    });
    for (let lifetime = 0; lifetime < 2; lifetime += 1) {
      const expiresAt = credentialExpiresAt;
      // The removed pre-expiry window: five-minute scheduler ticks from 45
      // minutes out to the last tick before expiry must not spend anything.
      for (let minutes = 45; minutes >= 5; minutes -= 5) {
        timestamp = expiresAt - minutes * 60_000;
        const refresh = await data.service.refreshAll();
        assert.deepEqual(await data.service.runScheduledClaudeRenewals(refresh), []);
      }
      assert.equal(cliInvocations, lifetime, 'no attempt while the credential is still valid');

      timestamp = expiresAt + 60_000;
      const refresh = await data.service.refreshAll();
      const outcomes = await data.service.runScheduledClaudeRenewals(refresh);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].outcome, 'renewed');
      assert.equal(outcomes[0].mechanism, 'invoke');
      assert.equal(outcomes[0].path, 'no-flip');
      assert.ok(credentialExpiresAt > expiresAt, 'the post-expiry attempt renews the lifetime');
    }

    const renewal = data.store.getAccount(data.target.id).metadata.claudeRenewal;
    assert.equal(renewal.attempts.length, 2, 'two token lifetimes spend exactly two budget attempts');
    assert.equal(cliInvocations, 2);
    assert.equal(Object.hasOwn(renewal, 'lastPreExpiryAttemptAt'), false, 'legacy pre-expiry bookkeeping is pruned');
    assert.equal(Object.hasOwn(renewal, 'postExpiryGuardUntil'), false, 'legacy restart guard is pruned');
  } finally { data.close(); }
});

test('a valid credential is never a scheduled renewal candidate, however close to expiry', async () => {
  const timestamp = Date.parse('2026-08-08T12:00:00Z');
  let renewals = 0;
  const data = fixture({ serviceOptions: { now: () => timestamp } });
  try {
    data.service.renewClaudeAccount = async () => { renewals += 1; };
    data.service.refreshClaudeAccount = async () => {};
    const refresh = { claude: { profiles: [{ accountId: data.target.id, ok: true, snapshotCount: 1 }] } };
    for (const minutesLeft of [480, 45, 5, 1]) {
      data.service.rememberClaudeCredentialExpiry(
        data.target.id,
        snapshotsExpiringAt(timestamp + minutesLeft * 60_000),
      );
      assert.deepEqual(await data.service.runScheduledClaudeRenewals(refresh), []);
    }
    assert.equal(renewals, 0);
  } finally { data.close(); }
});

test('a stale expired refresh error cannot spend an attempt while the observed expiry is still future', async () => {
  const timestamp = Date.parse('2026-08-08T12:00:00Z');
  const data = fixture({ serviceOptions: { now: () => timestamp } });
  try {
    data.expire();
    data.service.rememberClaudeCredentialExpiry(
      data.target.id,
      snapshotsExpiringAt(timestamp + 8 * 60 * 60_000),
    );
    const refresh = { claude: { profiles: [{ accountId: data.target.id, ok: false, error: EXPIRED }] } };
    assert.deepEqual(await data.service.runScheduledClaudeRenewals(refresh), []);
    assert.equal(data.calls.length, 0);
  } finally { data.close(); }
});

test('a genuinely expired credential renews on the post-expiry rung', async () => {
  const timestamp = Date.parse('2026-08-08T12:00:00Z');
  let credentialExpired = true;
  let cliInvocations = 0;
  let data;
  data = fixture({
    serviceOptions: {
      now: () => timestamp,
      exec: async (_command, args) => {
        if (args[0] === 'auth') return { stdout: MATCHING_STATUS, stderr: '' };
        if (args[0] === '-p') {
          cliInvocations += 1;
          credentialExpired = false;
        }
        return { stdout: '', stderr: '' };
      },
      fetchClaude: async ({ claudeConfigDir }) => {
        if (claudeConfigDir !== data.targetHome) return SNAPSHOTS;
        if (credentialExpired) throw new Error(EXPIRED);
        return snapshotsExpiringAt(timestamp + 8 * 60 * 60_000);
      },
    },
  });
  try {
    const refresh = await data.service.refreshAll();
    const outcomes = await data.service.runScheduledClaudeRenewals(refresh);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, 'renewed');
    assert.equal(outcomes[0].mechanism, 'invoke');
    assert.equal(outcomes[0].path, 'no-flip');
    assert.equal(data.store.getAccount(data.target.id).metadata.claudeRenewal.attempts.length, 1);
    assert.equal(cliInvocations, 1);
  } finally { data.close(); }
});

test('credential-derived expiry is absent from renewal state and scheduled logs', async (t) => {
  const timestamp = Date.parse('2026-08-08T12:00:00Z');
  const expiresAt = timestamp - 37 * 60_000 - 123;
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const data = fixture({ serviceOptions: { now: () => timestamp } });
  try {
    data.expire();
    data.service.renewClaudeAccount = async () => {
      throw new Error(`fixture failure ${expiresAt} ${new Date(expiresAt).toISOString()}`);
    };
    data.service.rememberClaudeCredentialExpiry(data.target.id, snapshotsExpiringAt(expiresAt));
    const refresh = { claude: { profiles: [{ accountId: data.target.id, ok: false, error: EXPIRED }] } };

    await data.service.runScheduledClaudeRenewals(refresh);
    const serializedState = JSON.stringify(await data.service.state());
    const serializedRefresh = JSON.stringify(refresh);
    for (const serialized of [serializedState, serializedRefresh, logs.join('\n')]) {
      assert.doesNotMatch(serialized, new RegExp(String(expiresAt)));
      assert.doesNotMatch(serialized, new RegExp(new Date(expiresAt).toISOString().replaceAll('.', '\\.')));
    }
    assert.doesNotMatch(serializedState, /"expiresAt"/);
    assert.deepEqual(logs, ['[modeldeck] scheduled Claude renewal failed']);
  } finally { data.close(); }
});

test('scheduled renewal uses the no-flip ladder while Claude is running', async () => {
  const data = fixture({ serviceOptions: { listProviderProcesses: async () => ['claude'] } });
  try {
    data.expire();
    let refreshes = 0;
    data.service.refreshClaudeAccount = async () => { refreshes += 1; };
    const refresh = { claude: { profiles: [{ accountId: data.target.id, ok: false, error: EXPIRED }] } };

    const outcomes = await data.service.runScheduledClaudeRenewals(refresh);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].accountId, data.target.id);
    assert.equal(outcomes[0].outcome, 'renewed');
    assert.equal(outcomes[0].mechanism, 'auth-status');
    assert.equal(outcomes[0].path, 'no-flip');
    assert.equal(refreshes, 1);
    assert.deepEqual(data.calls.map((call) => call.args), [['auth', 'status', '--json']]);
    assertPinnedRenewalCalls(data);
  } finally { data.close(); }
});

test('scheduled busy outcomes preserve the renewal budget and allow the next quiet-moment flip', async () => {
  let timestamp = Date.parse('2026-07-31T12:00:00Z');
  let claudeRunning = true;
  const data = fixture({
    statusOutput: JSON.stringify({ email: 'other@example.invalid' }),
    serviceOptions: {
      now: () => timestamp,
      listProviderProcesses: async () => claudeRunning ? ['claude'] : [],
    },
  });
  try {
    data.expire();
    data.service.refreshClaudeAccount = async () => {};
    const refresh = { claude: { profiles: [{ accountId: data.target.id, ok: false, error: EXPIRED }] } };

    for (let tick = 0; tick < 6; tick += 1) {
      const outcomes = await data.service.runScheduledClaudeRenewals(refresh);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].outcome, 'busy');
      const account = data.store.getAccount(data.target.id);
      assert.deepEqual(account.metadata.claudeRenewal.attempts, []);
      assert.equal(account.metadata.claudeRenewal.lastAttempt.at, new Date(timestamp).toISOString());
      assert.equal(account.metadata.claudeRenewal.lastAttempt.outcome, 'busy');
      assert.equal(data.service.renewalAttemptAllowed(account), true, 'busy does not trigger backoff');
      timestamp += 5 * 60_000;
    }

    claudeRunning = false;
    const outcomes = await data.service.runScheduledClaudeRenewals(refresh);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, 'renewed');
    assert.equal(outcomes[0].path, 'flip');
    const metadata = data.store.getAccount(data.target.id).metadata.claudeRenewal;
    assert.deepEqual(metadata.attempts, [new Date(timestamp).toISOString()]);
    assert.equal(metadata.lastAttempt.outcome, 'renewed');
  } finally { data.close(); }
});

test('scheduled renewal observes backoff, daily limit, per-account refresh, and kill switch', async () => {
  let timestamp = Date.parse('2026-07-31T12:00:00Z');
  const data = fixture({ serviceOptions: { now: () => timestamp } });
  try {
    data.expire();
    let renewals = 0;
    let refreshes = 0;
    data.service.renewClaudeAccount = async (accountId) => {
      renewals += 1;
      return data.service.recordClaudeRenewalAttempt(accountId, {
        at: new Date(timestamp).toISOString(), outcome: 'failed', mechanism: 'invoke', detail: 'fixture',
      });
    };
    data.service.refreshClaudeAccount = async () => { refreshes += 1; };
    const refresh = { claude: { profiles: [{ accountId: data.target.id, ok: false, error: EXPIRED }] } };

    await data.service.runScheduledClaudeRenewals(refresh);
    assert.equal(renewals, 1);
    assert.equal(refreshes, 1);
    await data.service.runScheduledClaudeRenewals(refresh);
    assert.equal(renewals, 1, 'the 30-minute backoff blocks an immediate retry');

    for (let index = 1; index < 6; index += 1) {
      timestamp += 30 * 60_000;
      await data.service.runScheduledClaudeRenewals(refresh);
    }
    assert.equal(renewals, 6);
    timestamp += 30 * 60_000;
    await data.service.runScheduledClaudeRenewals(refresh);
    assert.equal(renewals, 6, 'six attempts in a rolling day is the hard limit');

    timestamp += 24 * 60 * 60_000;
    data.store.saveSettings({ autoRenewEnabled: false });
    await data.service.runScheduledClaudeRenewals(refresh);
    assert.equal(renewals, 6, 'the kill switch prevents renewal even after limits expire');
  } finally { data.close(); }
});

test('renewal attempt metadata survives a daemon restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-renewal-db-'));
  const dbPath = path.join(root, 'modeldeck.sqlite');
  let data;
  try {
    const store = new Store(dbPath);
    data = fixture({ store });
    data.expire();
    const renew = await data.service.renewClaudeAccount(data.target.id);
    store.close();
    const reopened = new Store(dbPath);
    try {
      const saved = reopened.getAccount(data.target.id).metadata.claudeRenewal.lastAttempt;
      assert.equal(saved.at, renew.at);
      assert.equal(saved.outcome, renew.outcome);
      assert.equal(saved.mechanism, renew.mechanism);
      assert.equal(saved.path, 'no-flip');
      const restarted = new ModelDeckService(reopened, {
        claudeProfilesDir: data.profilesDir,
        claudeActiveLink: data.activeLink,
        platform: 'linux',
        claudeCredentialsPresent: async () => true,
      });
      const account = (await restarted.state()).accounts.find((item) => item.id === data.target.id);
      assert.deepEqual(account.renew.lastAttempt, {
        at: renew.at,
        outcome: renew.outcome,
        mechanism: renew.mechanism,
        path: renew.path,
      });
    } finally { reopened.close(); }
  } finally {
    if (data) fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
