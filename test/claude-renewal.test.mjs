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
const BUSY_DETAIL = 'A Claude session is running; ModelDeck will renew at the next quiet moment.';

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
  for (const call of calls) {
    assert.equal(call.options.timeout, 60_000);
    assert.equal(call.options.cwd, path.join(data.root, 'data', 'claude-renewal'));
    assert.equal(call.options.env.CLAUDE_CONFIG_DIR, data.targetHome);
    assert.equal(call.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, data.targetHome);
    assert.equal(call.options.env.USER, 'fixture-user');
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      assert.equal(Object.hasOwn(call.options.env, key), false);
    }
  }
}

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
    assert.deepEqual(account.renew.lastAttempt, {
      at: renew.at,
      outcome: 'renewed',
      mechanism: 'auth-status',
    });
  } finally { data.close(); }
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
      });
    } finally { reopened.close(); }
  } finally {
    if (data) fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
