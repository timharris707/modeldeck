import test from 'node:test';
import { LEGACY_CLIENT_KEY_SERVICE, clientKeyShellFetch } from '../src/client-key-helper.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import {
  CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT,
  CLAUDE_STRAY_LOGIN_VERIFY_HINT,
  ModelDeckService,
} from '../src/service.mjs';
import { codexDeadCredentialError } from '../src/adapters/codex.mjs';

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-phase2-'));
  const firstHome = path.join(root, 'profiles', 'first');
  const secondHome = path.join(root, 'profiles', 'second');
  fs.mkdirSync(firstHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(secondHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(firstHome, 0o700);
  fs.chmodSync(secondHome, 0o700);
  const store = new Store(':memory:');
  store.saveSettings({ claudeManaged: true, codexManaged: true });
  const codexActiveLink = path.join(root, 'active', '.codex');
  const claudeActiveLink = path.join(root, 'active', '.claude');
  const service = new ModelDeckService(store, {
    codexActiveLink,
    claudeActiveLink,
    claudeProfilesDir: path.join(root, 'profiles'),
    platform: 'linux',
    listProviderProcesses: async () => [],
    ...options,
  });
  return {
    root, firstHome, secondHome, codexActiveLink, claudeActiveLink, store, service,
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('provider activation switches first and persists the default only after success', async () => {
  const data = fixture();
  try {
    fs.writeFileSync(path.join(data.secondHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'two@example.com' } }));
    const claudeOne = data.store.saveAccount({ provider: 'claude', label: 'Claude One', profileRef: data.firstHome, isDefault: true });
    const claudeTwo = data.store.saveAccount({ provider: 'claude', label: 'Claude Two', identity: 'two@example.com', profileRef: data.secondHome });
    let { account: active, warnings } = await data.service.activateAccount(claudeTwo.id);
    assert.equal(active.isDefault, true);
    assert.deepEqual(warnings, []);
    assert.equal(fs.readlinkSync(data.claudeActiveLink), fs.realpathSync(data.secondHome));
    assert.deepEqual((await data.service.state()).activation.claude, {
      state: 'effective', resolvedProfileRef: fs.realpathSync(data.secondHome),
      secureStorage: { value: fs.realpathSync(data.secondHome), status: 'not-applicable' },
    });

    fs.unlinkSync(data.claudeActiveLink);
    fs.mkdirSync(data.claudeActiveLink, { recursive: true });
    await assert.rejects(data.service.activateAccount(claudeOne.id), { code: 'active-link-blocked' });
    assert.equal(data.store.getAccount(claudeTwo.id).isDefault, true);

    const codexOne = data.store.saveAccount({ provider: 'codex', label: 'Codex One', profileRef: data.firstHome, isDefault: true });
    const codexTwo = data.store.saveAccount({ provider: 'codex', label: 'Codex Two', profileRef: data.secondHome });
    ({ account: active } = await data.service.activateAccount(codexTwo.id));
    assert.equal(active.isDefault, true);
    assert.equal(fs.readlinkSync(data.codexActiveLink), fs.realpathSync(data.secondHome));
    assert.deepEqual((await data.service.state()).activation.codex, {
      state: 'effective', resolvedProfileRef: fs.realpathSync(data.secondHome),
    });

    ({ account: active } = await data.service.activateAccount(codexOne.id));
    assert.equal(active.isDefault, true);
    assert.equal(fs.readlinkSync(data.codexActiveLink), fs.realpathSync(data.firstHome));

    fs.unlinkSync(data.codexActiveLink);
    fs.mkdirSync(data.codexActiveLink, { recursive: true });
    await assert.rejects(data.service.activateAccount(codexTwo.id), { code: 'active-link-blocked' });
    assert.equal(data.store.getAccount(codexOne.id).isDefault, true);
  } finally { data.close(); }
});

test('state reports all physical activation states for each provider', async (t) => {
  const data = fixture({ claudeCredentialsPresent: async () => false });
  t.after(() => data.close());
  for (const provider of ['claude', 'codex']) {
    if (provider === 'claude') fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'user@example.com' } }));
    data.store.saveAccount({
      provider, label: `${provider} default`, identity: provider === 'claude' ? 'user@example.com' : '', profileRef: data.firstHome, isDefault: true,
    });
    const activeLink = provider === 'claude' ? data.claudeActiveLink : data.codexActiveLink;

    await t.test(`${provider}: unlinked`, async () => {
      assert.deepEqual((await data.service.state()).activation[provider], { state: 'unlinked' });
    });

    await t.test(`${provider}: blocked`, async () => {
      fs.mkdirSync(activeLink, { recursive: true });
      assert.deepEqual((await data.service.state()).activation[provider], { state: 'blocked' });
      fs.rmSync(activeLink, { recursive: true });
    });

    await t.test(`${provider}: mismatched`, async () => {
      fs.mkdirSync(path.dirname(activeLink), { recursive: true });
      fs.symlinkSync(data.secondHome, activeLink, 'dir');
      assert.deepEqual((await data.service.state()).activation[provider], {
        state: 'mismatched', resolvedProfileRef: fs.realpathSync(data.secondHome),
      });
      fs.unlinkSync(activeLink);
    });

    await t.test(`${provider}: effective`, async () => {
      fs.symlinkSync(data.firstHome, activeLink, 'dir');
      assert.deepEqual((await data.service.state()).activation[provider], {
        state: 'effective', resolvedProfileRef: fs.realpathSync(data.firstHome),
        ...(provider === 'claude' ? { secureStorage: { value: null, status: 'not-applicable' } } : {}),
      });
      fs.unlinkSync(activeLink);
    });
  }
});

test('Claude identity backfill persists normalized email and account UUID metadata', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'User@Example.com', accountUuid: 'uuid-placeholder' },
  }));
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
  await data.service.backfillClaudeIdentities();
  assert.equal(data.store.getAccount(account.id).identity, 'user@example.com');
  assert.equal(data.store.getAccount(account.id).metadata.claudeAccountUuid, 'uuid-placeholder');
  assert.equal(data.store.getAccount(account.id).metadata.identitySource, 'seed');
});

test('Claude identity seed refuses an active unscoped profile', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'residue@example.invalid', accountUuid: 'uuid-residue' },
  }));
  fs.mkdirSync(path.dirname(data.claudeActiveLink), { recursive: true });
  fs.symlinkSync(data.firstHome, data.claudeActiveLink, 'dir');
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });

  await data.service.backfillClaudeIdentities();

  const saved = data.store.getAccount(account.id);
  assert.equal(saved.identity, '');
  assert.equal(saved.metadata.claudeAccountUuid, undefined);
  assert.equal(saved.metadata.identitySource, undefined);
  assert.equal((await data.service.state()).activation.claude.state, 'identity-unverified');
});

test('Claude identity seed verifies an active profile scoped to its real path', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'scoped@example.invalid', accountUuid: 'uuid-scoped' },
  }));
  fs.mkdirSync(path.dirname(data.claudeActiveLink), { recursive: true });
  fs.symlinkSync(data.firstHome, data.claudeActiveLink, 'dir');
  data.service.claudeSecureStorage = { status: 'active', value: fs.realpathSync(data.firstHome) };
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome, isDefault: true });

  await data.service.backfillClaudeIdentities();

  const saved = data.store.getAccount(account.id);
  assert.equal(saved.identity, 'scoped@example.invalid');
  assert.equal(saved.metadata.claudeAccountUuid, 'uuid-scoped');
  assert.equal(saved.metadata.identitySource, 'verified');
});

test('a reset landing mid-refresh is not undone by the refresh save', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({}));
  const account = data.store.saveAccount({
    provider: 'claude', label: 'Work', identity: 'user@example.com', profileRef: data.firstHome,
    metadata: { claudeAccountUuid: 'uuid-recorded', identitySource: 'seed' },
  });
  const originalReadTier = data.service.readClaudeTier.bind(data.service);
  data.service.readClaudeTier = async (options) => {
    data.service.resetClaudeIdentity(account.id);
    return originalReadTier(options);
  };
  await data.service.refreshClaudeProfileMetadata(account);
  const after = data.store.getAccount(account.id);
  assert.equal(after.identity, '');
  assert.equal(after.metadata.claudeAccountUuid, undefined);
  assert.equal(after.metadata.identitySource, undefined);
});

test('Claude identity refresh never overwrites a recorded identity', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'other@example.com', accountUuid: 'uuid-other' },
  }));
  const account = data.store.saveAccount({
    provider: 'claude', label: 'Work', identity: 'user@example.com', profileRef: data.firstHome,
    metadata: { claudeAccountUuid: 'uuid-recorded' },
  });
  await data.service.refreshClaudeProfileMetadata(data.store.getAccount(account.id));
  assert.equal(data.store.getAccount(account.id).identity, 'user@example.com');
  assert.equal(data.store.getAccount(account.id).metadata.claudeAccountUuid, 'uuid-recorded');
});

test('Claude activation verifier distinguishes match, mismatch, and unknown identity', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const account = data.store.saveAccount({
    provider: 'claude', label: 'Work Claude', identity: 'user@example.com', profileRef: data.firstHome, isDefault: true,
  });
  fs.mkdirSync(path.dirname(data.claudeActiveLink), { recursive: true });
  fs.symlinkSync(data.firstHome, data.claudeActiveLink, 'dir');

  fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'USER@example.com' } }));
  assert.equal((await data.service.state()).activation.claude.state, 'effective');

  fs.writeFileSync(path.join(data.firstHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.com' } }));
  const mismatch = (await data.service.state()).activation.claude;
  assert.equal(mismatch.state, 'identity-mismatch');
  assert.equal(mismatch.guidance, 'log out and run /login as Work Claude');
  assert.doesNotMatch(mismatch.guidance, /user@example/);

  fs.unlinkSync(path.join(data.firstHome, '.claude.json'));
  const unknown = (await data.service.state()).activation.claude;
  assert.equal(unknown.state, 'identity-unverified');
  assert.match(unknown.guidance, /run one Claude session then refresh/);
  assert.equal(data.store.getAccount(account.id).identity, 'user@example.com');
});

test('Claude secure-storage activation handles darwin success, failure, non-darwin, and version gate', async (t) => {
  await t.test('darwin success', async () => {
    const calls = [];
    const data = fixture({
      platform: 'darwin',
      exec: async (binary, args) => {
        calls.push([binary, args]);
        if (args[0] === '--version') return { stdout: 'Claude Code 2.1.215' };
        return { stdout: '' };
      },
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.activateAccount(account.id);
      // Issue #66: both variables are pinned via launchd, always together
      // and always to the same resolved real path.
      const realHome = fs.realpathSync(data.firstHome);
      assert.deepEqual(calls.at(-2), ['/bin/launchctl', ['setenv', 'CLAUDE_CONFIG_DIR', realHome]]);
      assert.deepEqual(calls.at(-1), ['/bin/launchctl', ['setenv', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', realHome]]);
      assert.equal(data.service.claudeSecureStorage.status, 'active');
    } finally { data.close(); }
  });

  await t.test('launchctl failure degrades without failing activation', async () => {
    const data = fixture({
      platform: 'darwin',
      exec: async (_binary, args) => {
        if (args[0] === '--version') return { stdout: 'Claude Code 2.1.215' };
        throw new Error('launchctl unavailable');
      },
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      assert.equal((await data.service.activateAccount(account.id)).account.isDefault, true);
      const activation = (await data.service.state()).activation.claude;
      assert.equal(activation.state, 'identity-unverified');
      assert.equal(activation.secureStorage.status, 'degraded');
    } finally { data.close(); }
  });

  await t.test('non-darwin is a no-op', async () => {
    let calls = 0;
    const data = fixture({ platform: 'linux', exec: async () => { calls += 1; } });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.activateAccount(account.id);
      assert.equal(calls, 0);
      assert.equal(data.service.claudeSecureStorage.status, 'not-applicable');
    } finally { data.close(); }
  });

  // Issue #129 (PR #135 review): a demo-fixture instance must never run
  // `launchctl setenv` — that mutates the USER-GLOBAL launchd environment
  // and would steer subsequently launched real GUI Claude processes at the
  // demo profile. The seeded active link already establishes fixture state.
  await t.test('demo fixture mode never touches the global launchd environment', async () => {
    const calls = [];
    const data = fixture({
      platform: 'darwin',
      demoFixtures: true,
      exec: async (binary, args) => {
        calls.push([binary, args]);
        return { stdout: 'Claude Code 2.1.215' };
      },
    });
    const envFile = path.join(data.root, 'claude-env.sh');
    data.service.claudeShellEnvFile = envFile;
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.activateAccount(account.id);
      assert.equal(calls.filter(([binary]) => binary === '/bin/launchctl').length, 0);
      assert.equal(data.service.claudeSecureStorage.status, 'inactive');
      // The shell env pin (pinned inside the demo dir by demo-daemon.sh)
      // still lands, so demo terminals resolve the demo profile.
      assert.ok(fs.existsSync(envFile));
    } finally { data.close(); }
  });

  await t.test('older CLI is unsupported and probe reports the gate', async () => {
    const data = fixture({
      platform: 'darwin',
      exec: async (binary, args) => ({ stdout: binary.includes('claude') ? 'Claude Code 2.1.214' : 'codex 1.0.0' }),
      registryFetch: async () => ({ ok: true, json: async () => ({ version: '2.1.215' }) }),
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const tools = await data.service.probeTools();
      assert.equal(tools.tools.claude.secureStorageScopingSupported, false);
      await data.service.activateAccount(account.id);
      assert.equal(data.service.claudeSecureStorage.status, 'unsupported-cli');
      assert.equal((await data.service.state()).activation.claude.state, 'identity-unverified');
    } finally { data.close(); }
  });
});

test('Claude activation pins proxy credentials by Keychain pointer and removes the export per unproxied switch', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const proxiedSettings = `${JSON.stringify({
    apiKeyHelper: 'printf sk-placeholder',
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' },
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(data.firstHome, 'settings.json'), proxiedSettings, { mode: 0o600 });
  const first = data.store.saveAccount({ provider: 'claude', label: 'Proxied', profileRef: data.firstHome, isDefault: true });
  const second = data.store.saveAccount({ provider: 'claude', label: 'Unproxied', profileRef: data.secondHome });
  const envFile = path.join(data.root, 'claude-env.sh');
  assert.equal(data.service.claudeShellEnvFile, envFile);

  await data.service.activateAccount(first.id);
  let content = fs.readFileSync(envFile, 'utf8');
  const firstReal = fs.realpathSync(data.firstHome);
  assert.ok(content.includes(`export CLAUDE_CONFIG_DIR='${firstReal}'`));
  assert.ok(content.includes(`export CLAUDE_SECURESTORAGE_CONFIG_DIR='${firstReal}'`));
  // #278 review, major 1: guarded pointer — only a non-empty lookup exports.
  assert.ok(content.includes(`__modeldeck_key="$(${clientKeyShellFetch(LEGACY_CLIENT_KEY_SERVICE)} 2>/dev/null || true)"`));
  assert.ok(content.includes('export ANTHROPIC_API_KEY="$__modeldeck_key"'));
  assert.equal((fs.statSync(envFile).mode & 0o777), 0o600);
  // The activation path only reads routing from settings. The credential
  // remains a shell-time Keychain pointer and never enters settings.json,
  // where it would disable managed renewal (#199/#224/#263).
  const settingsAfterActivation = fs.readFileSync(path.join(data.firstHome, 'settings.json'), 'utf8');
  assert.equal(settingsAfterActivation, proxiedSettings);
  assert.equal(Object.hasOwn(JSON.parse(settingsAfterActivation).env, 'ANTHROPIC_API_KEY'), false);

  // Activation must refresh the exported path so new shells pick up the
  // newly active profile while already-pinned sessions stay insulated. A
  // complete rewrite also removes the proxy key export for an unproxied
  // profile, where that key would take precedence over stored OAuth.
  await data.service.activateAccount(second.id);
  content = fs.readFileSync(envFile, 'utf8');
  const secondReal = fs.realpathSync(data.secondHome);
  assert.ok(content.includes(`export CLAUDE_CONFIG_DIR='${secondReal}'`));
  assert.ok(content.includes(`export CLAUDE_SECURESTORAGE_CONFIG_DIR='${secondReal}'`));
  assert.ok(!content.includes(firstReal));
  // No EXPORT for an unproxied profile — but the guarded clear must be
  // present, or a nested shell keeps the key it inherited from the proxied
  // profile that was active a moment ago (CodeRabbit, PR #278).
  assert.ok(!/^\s*export ANTHROPIC_API_KEY=/m.test(content));
  assert.ok(content.includes('unset ANTHROPIC_API_KEY MODELDECK_MANAGED_ANTHROPIC_API_KEY'));
  assert.equal(fs.readFileSync(path.join(data.firstHome, 'settings.json'), 'utf8'), proxiedSettings);
  assert.equal(fs.existsSync(path.join(data.secondHome, 'settings.json')), false);

  // Issue #522: activation resolves the Keychain item from the ACTIVATED
  // profile's own recorded helper state. A profile with no record keeps the
  // shared item (asserted above); a profile with a per-profile record must
  // get its own, or activation would hand a migrated profile another
  // profile's key — the mis-attribution blocker 1 exists to prevent.
  // Per-profile items are macOS-only; elsewhere the Mac app never writes one (#808).
  if (process.platform === 'darwin') {
    const service = `cli-proxy-api-client.${first.id}`;
    data.service.saveClaudeClientKeyRecord(first.id, {
      mode: 'per-profile',
      service,
      helper: `security find-generic-password -s ${service} -w`,
      writtenAt: new Date().toISOString(),
    });
    await data.service.activateAccount(first.id);
    content = fs.readFileSync(envFile, 'utf8');
    assert.ok(content.includes(`find-generic-password -s ${service} -w`));
    assert.ok(!content.includes('-s cli-proxy-api-client -w'));
  }
  await data.service.activateAccount(second.id);

  // Codex activation must not touch the Claude pin.
  const codex = data.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(codex.id);
  assert.ok(fs.readFileSync(envFile, 'utf8').includes(secondReal));
});

test('a non-loopback base URL never receives the CLIProxy client key', async (t) => {
  // Adversarial review of #277: base-URL PRESENCE is not CLIProxy routing.
  // A corporate gateway (or an explicit api.anthropic.com) must not be
  // handed ModelDeck's Keychain client key.
  const data = fixture();
  t.after(() => data.close());
  const gatewaySettings = `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://llm-gateway.corp.example' },
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(data.firstHome, 'settings.json'), gatewaySettings, { mode: 0o600 });
  const account = data.store.saveAccount({ provider: 'claude', label: 'Gateway', profileRef: data.firstHome, isDefault: true });
  await data.service.activateAccount(account.id);
  const content = fs.readFileSync(path.join(data.root, 'claude-env.sh'), 'utf8');
  assert.ok(!/^export ANTHROPIC_API_KEY=/m.test(content));
  // The guarded clear still applies, exactly as for an unrouted profile.
  assert.ok(content.includes('unset ANTHROPIC_API_KEY MODELDECK_MANAGED_ANTHROPIC_API_KEY'));
});

test('Claude activation reports running unpinned sessions and never blocks on detection', async (t) => {
  await t.test('running claude processes produce one warning with the count', async () => {
    const data = fixture({ listProviderProcesses: async () => ['claude', 'codex', 'claude'] });
    t.after(() => data.close());
    const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
    const { warnings } = await data.service.activateAccount(account.id);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^2 running Claude sessions may lose session storage/);
  });

  await t.test('no claude processes means no warnings', async () => {
    const data = fixture({ listProviderProcesses: async () => ['codex'] });
    t.after(() => data.close());
    const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
    assert.deepEqual((await data.service.activateAccount(account.id)).warnings, []);
  });

  await t.test('detection failure yields empty warnings and activation succeeds', async () => {
    const data = fixture({ listProviderProcesses: async () => { throw new Error('ps unavailable'); } });
    t.after(() => data.close());
    const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
    const result = await data.service.activateAccount(account.id);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.account.isDefault, true);
  });

  await t.test('codex activation never runs claude session detection', async () => {
    const data = fixture({ listProviderProcesses: async () => ['claude'] });
    t.after(() => data.close());
    const account = data.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: data.firstHome });
    assert.deepEqual((await data.service.activateAccount(account.id)).warnings, []);
  });
});

test('shell env pin failure degrades secure-storage status without failing activation', async (t) => {
  const data = fixture({
    platform: 'darwin',
    exec: async (_binary, args) => (args[0] === '--version' ? { stdout: 'Claude Code 2.1.215' } : { stdout: '' }),
  });
  t.after(() => data.close());
  // Force the env-file write to fail: make its parent path a regular file.
  data.service.claudeShellEnvFile = path.join(data.root, 'not-a-dir', 'claude-env.sh');
  fs.writeFileSync(path.join(data.root, 'not-a-dir'), 'occupied');
  const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
  const result = await data.service.activateAccount(account.id);
  assert.equal(result.account.isDefault, true);
  assert.equal(data.service.claudeSecureStorage.status, 'degraded');
  assert.ok(data.service.claudeSecureStorage.error);
});

test('tool probes share in-flight work, cache results, and isolate registry errors', async () => {
  let execCalls = 0;
  let registryCalls = 0;
  let failCodexRegistry = false;
  const data = fixture({
    claudePath: 'claude-fixture',
    codexPath: 'codex-fixture',
    fetchClaude: async () => [{ profileRef: '1' }],
    exec: async (binary) => {
      execCalls += 1;
      return { stdout: binary === 'claude-fixture' ? 'Claude Code v1.2.3' : 'codex 2.0.0' };
    },
    registryFetch: async (url) => {
      registryCalls += 1;
      if (failCodexRegistry && url.includes('@openai')) throw new Error('registry unavailable');
      return { ok: true, json: async () => ({ version: url.includes('@anthropic-ai') ? '1.4.0' : '2.0.0' }) };
    },
    toolProbeTtlMs: 60_000,
  });
  try {
    fs.writeFileSync(path.join(data.firstHome, 'auth.json'), '{}');
    data.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: data.firstHome, isDefault: true });

    const [first, concurrent] = await Promise.all([data.service.probeTools(), data.service.probeTools()]);
    assert.strictEqual(first, concurrent);
    assert.equal(first.tools.claude.updateAvailable, true);
    assert.equal(first.tools.codex.updateAvailable, false);
    assert.equal(first.tools.codex.authState, 'ok');
    assert.equal(execCalls, 2);
    assert.equal(registryCalls, 2);

    assert.strictEqual(await data.service.probeTools(), first);
    assert.equal(execCalls, 2);
    assert.equal(registryCalls, 2);

    failCodexRegistry = true;
    const refreshed = await data.service.probeTools({ refresh: true });
    assert.equal(execCalls, 4);
    assert.equal(registryCalls, 4);
    assert.equal(refreshed.tools.codex.latestVersion, null);
    assert.equal(refreshed.tools.codex.updateAvailable, null);
    assert.match(refreshed.tools.codex.error, /registry unavailable/);
  } finally { data.close(); }
});

test('per-account auth states diverge and tool auth follows the default profile', async () => {
  const data = fixture({
    claudeCredentialsPresent: async ({ claudeConfigDir }) => claudeConfigDir === data.firstHome,
    exec: async (binary) => ({ stdout: binary.includes('claude') ? 'Claude Code 1.2.3' : 'codex 2.0.0' }),
    registryFetch: async (url) => ({
      ok: true,
      json: async () => ({ version: url.includes('@anthropic-ai') ? '1.2.3' : '2.0.0' }),
    }),
  });
  try {
    const first = data.store.saveAccount({
      provider: 'claude', label: 'First', identity: 'dev@example.com', profileRef: data.firstHome, isDefault: true,
    });
    const second = data.store.saveAccount({
      provider: 'claude', label: 'Second', identity: 'ops@example.com', profileRef: data.secondHome,
    });

    let state = await data.service.state();
    assert.equal(state.accounts.find((account) => account.id === first.id).authState, 'ok');
    assert.equal(state.accounts.find((account) => account.id === second.id).authState, 'signin-required');
    assert.equal((await data.service.probeTools()).tools.claude.authState, 'ok');

    data.service.setDefaultAccount('claude', second.id);
    assert.equal((await data.service.probeTools()).tools.claude.authState, 'signin-required');
  } finally { data.close(); }
});

test('successful external login verification invalidates cached provider auth', async () => {
  let credentialsPresent = false;
  const data = fixture({
    claudePath: 'claude-fixture',
    codexPath: 'codex-fixture',
    claudeCredentialsPresent: async () => credentialsPresent,
    readClaudeAuth: async () => {
      credentialsPresent = true;
      return { authenticated: true, identity: 'dev@example.com' };
    },
    exec: async (binary) => ({ stdout: binary.includes('claude') ? 'Claude Code 1.0.0' : 'codex 1.0.0' }),
    registryFetch: async () => ({ ok: true, json: async () => ({ version: '1.0.0' }) }),
  });
  try {
    const account = data.store.saveAccount({
      provider: 'claude', label: 'First', identity: 'dev@example.com', profileRef: data.firstHome, isDefault: true,
    });
    assert.equal((await data.service.probeTools()).tools.claude.authState, 'signin-required');
    assert.equal((await data.service.verifyAccount(account.id)).authenticated, true);
    assert.equal((await data.service.probeTools()).tools.claude.authState, 'ok');
  } finally { data.close(); }
});

test('concurrent account state reads coalesce slow Keychain presence checks', async () => {
  let releasePresence;
  let presenceCalls = 0;
  const data = fixture({
    claudeCredentialsPresent: async () => {
      presenceCalls += 1;
      await new Promise((resolve) => { releasePresence = resolve; });
      return true;
    },
  });
  try {
    data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const first = data.service.state();
    const concurrent = data.service.state();
    while (!releasePresence) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(presenceCalls, 1);
    releasePresence();
    const [firstState, concurrentState] = await Promise.all([first, concurrent]);
    assert.equal(firstState.accounts[0].authState, 'ok');
    assert.equal(concurrentState.accounts[0].authState, 'ok');
  } finally { data.close(); }
});

function updateFixture(tool, canonicalPath) {
  let updated = false;
  const calls = [];
  const binary = `${tool}-fixture`;
  const data = fixture({
    [`${tool}Path`]: binary,
    realpath: async () => canonicalPath,
    exec: async (command, args, options) => {
      calls.push([command, args, options]);
      if (command === '/usr/bin/which') return { stdout: `/usr/local/bin/${binary}\n` };
      if (args[0] === '--version') {
        const version = updated ? '2.0.0' : '1.0.0';
        return { stdout: `${command} ${version}` };
      }
      if (command === 'npm' || command === 'brew') {
        updated = true;
        return { stdout: `${command} update complete` };
      }
      return { stdout: `${command} 1.0.0` };
    },
    registryFetch: async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) }),
  });
  return { data, calls };
}

test('tool update selects npm global and Homebrew commands and refreshes versions', async () => {
  const npm = updateFixture('claude', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
  try {
    const result = await npm.data.service.updateTool('claude');
    assert.deepEqual(result, {
      ok: true, previousVersion: '1.0.0', newVersion: '2.0.0', 'output-tail': 'npm update complete',
    });
    assert.ok(npm.calls.some(([command, args]) => command === 'npm'
      && JSON.stringify(args) === JSON.stringify(['i', '-g', '@anthropic-ai/claude-code@latest'])));
    const npmOptions = npm.calls.find(([command]) => command === 'npm')[2];
    assert.equal(npmOptions.env.MODELDECK_MUTATION_TOKEN, undefined);
    assert.equal(npmOptions.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(npm.data.service.toolProbeCache.value.tools.claude.version, '2.0.0');
  } finally { npm.data.close(); }

  const brew = updateFixture('codex', '/opt/homebrew/Cellar/codex/2.0.0/bin/codex');
  try {
    const result = await brew.data.service.updateTool('codex');
    assert.equal(result.ok, true);
    assert.equal(result.previousVersion, '1.0.0');
    assert.equal(result.newVersion, '2.0.0');
    assert.ok(brew.calls.some(([command, args]) => command === 'brew'
      && JSON.stringify(args) === JSON.stringify(['upgrade', 'codex'])));
  } finally { brew.data.close(); }
});

test('tool update rejects unknown install methods and shares concurrent work per tool', async () => {
  const unknown = updateFixture('claude', '/Users/fixture/.local/bin/claude');
  try {
    await assert.rejects(unknown.data.service.updateTool('claude'), (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /unsupported direct\/native install method/);
      return true;
    });
  } finally { unknown.data.close(); }

  let releaseInstall;
  let installCalls = 0;
  const data = fixture({
    claudePath: 'claude-fixture',
    realpath: async () => '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    exec: async (command, args) => {
      if (command === '/usr/bin/which') return { stdout: '/usr/local/bin/claude-fixture\n' };
      if (command === 'npm') {
        installCalls += 1;
        await new Promise((resolve) => { releaseInstall = resolve; });
        return { stdout: 'updated' };
      }
      if (args[0] === '--version') return { stdout: 'Claude Code 1.0.0' };
      return { stdout: 'codex 1.0.0' };
    },
    registryFetch: async () => ({ ok: true, json: async () => ({ version: '1.0.0' }) }),
  });
  try {
    const first = data.service.updateTool('claude');
    const concurrent = data.service.updateTool('claude');
    assert.strictEqual(first, concurrent);
    while (!releaseInstall) await new Promise((resolve) => setImmediate(resolve));
    releaseInstall();
    await Promise.all([first, concurrent]);
    assert.equal(installCalls, 1);
  } finally { data.close(); }
});

test('post-update refresh does not join or accept stale in-flight tool probes', async () => {
  let updated = false;
  let releaseFirstVersion;
  let firstVersionStarted;
  const started = new Promise((resolve) => { firstVersionStarted = resolve; });
  let claudeVersionCalls = 0;
  const data = fixture({
    claudePath: 'claude-fixture',
    codexPath: 'codex-fixture',
    realpath: async () => '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    exec: async (command, args) => {
      if (command === '/usr/bin/which') return { stdout: '/usr/local/bin/claude-fixture\n' };
      if (command === 'npm') { updated = true; return { stdout: 'updated' }; }
      if (args[0] === '--version' && command === 'claude-fixture') {
        claudeVersionCalls += 1;
        if (claudeVersionCalls === 1) {
          firstVersionStarted();
          await new Promise((resolve) => { releaseFirstVersion = resolve; });
          return { stdout: 'Claude Code 1.0.0' };
        }
        return { stdout: `Claude Code ${updated ? '2.0.0' : '1.0.0'}` };
      }
      return { stdout: 'codex 1.0.0' };
    },
    registryFetch: async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) }),
  });
  try {
    const staleProbe = data.service.probeTools();
    await started;
    const result = await data.service.updateTool('claude');
    assert.equal(result.newVersion, '2.0.0');
    assert.equal(data.service.toolProbeCache.value.tools.claude.version, '2.0.0');
    releaseFirstVersion();
    await staleProbe;
    assert.equal(data.service.toolProbeCache.value.tools.claude.version, '2.0.0');
  } finally { releaseFirstVersion?.(); data.close(); }
});

test('missing Claude profile reports a clear activation error and leaves the default unchanged', async () => {
  const data = fixture();
  try {
    const first = data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const missing = path.join(data.root, 'profiles', 'missing');
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: missing });
    await assert.rejects(() => data.service.activateAccount(second.id), /profile home does not exist/);
    assert.equal(data.store.getAccount(first.id).isDefault, true);
    assert.equal(data.store.getAccount(second.id).isDefault, false);
  } finally { data.close(); }
});

// Account creation preflights the provider CLI (the add flow's next step
// cannot work without it), so fixtures pin `--version` to a fixed answer.
const cliInstalledExec = async (_binary, args) => {
  if (args?.[0] === '--version') return { stdout: '9.9.9' };
  return { stdout: '' };
};

test('creates managed Claude accounts and imports only an explicitly approved legacy home', async () => {
  const data = fixture({ exec: cliInstalledExec });
  try {
    const created = await data.service.createClaudeAccount({
      label: 'New Profile',
      identity: 'user@example.invalid',
      purpose: 'fixture',
      isDefault: true,
    });
    assert.equal(created.profileRef, path.join(fs.realpathSync(path.join(data.root, 'profiles')), 'new-profile'));
    assert.equal(fs.statSync(created.profileRef).mode & 0o777, 0o700);

    const outside = path.join(data.root, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    await assert.rejects(data.service.saveAccount({
      provider: 'claude', label: 'Outside', profileRef: outside,
    }), /must be inside ModelDeck's profiles directory/);

    const approved = path.join(data.root, 'legacy', 'approved');
    fs.mkdirSync(approved, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(approved, '.credentials.json'), '{"fixture":true}', { mode: 0o600 });
    const [imported] = await data.service.importClaudeSwapProfiles([{
      label: 'Imported Profile', profileName: 'imported-profile', sourceDir: approved,
    }]);
    assert.equal(imported.profileRef, path.join(fs.realpathSync(path.join(data.root, 'profiles')), 'imported-profile'));
    assert.equal(imported.metadata.migratedFromClaudeSwap, true);
    assert.equal(fs.readFileSync(path.join(approved, '.credentials.json'), 'utf8'), '{"fixture":true}');
  } finally { data.close(); }
});

// First-run stuck states (field report, 2026-07-28): a fresh Mac with no
// provider CLI let step 1 create the profile home + account, then step 2
// died in Terminal with "command not found" — and every retry hit "profile
// destination already exists" with no way forward.
test('account creation refuses up front, with install guidance, when the provider CLI is missing', async (t) => {
  const missingCliExec = async () => {
    const error = new Error('spawn ENOENT');
    error.code = 'ENOENT';
    throw error;
  };

  await t.test('claude', async () => {
    const data = fixture({ exec: missingCliExec });
    try {
      await assert.rejects(
        data.service.createClaudeAccount({ label: 'Fresh Mac' }),
        /Claude Code is not installed on this Mac.*npm install -g @anthropic-ai\/claude-code/,
      );
      // Nothing partial left behind: no account, no profile home to collide
      // with a retry after the CLI gets installed.
      assert.equal(data.store.listAccounts().length, 0);
      assert.equal(fs.existsSync(path.join(data.root, 'profiles', 'fresh-mac')), false);
    } finally { data.close(); }
  });

  await t.test('codex', async () => {
    const data = fixture({ exec: missingCliExec, codexProfilesDir: path.join(os.tmpdir(), 'unused-codex-profiles') });
    try {
      await assert.rejects(
        data.service.createCodexAccount({ label: 'Fresh Mac' }),
        /Codex CLI is not installed on this Mac.*npm install -g @openai\/codex/,
      );
      assert.equal(data.store.listAccounts().length, 0);
    } finally { data.close(); }
  });

  await t.test('a flaky version read never blocks creation (fail open)', async () => {
    const data = fixture({
      exec: async () => ({ stdout: 'no semver here' }),
    });
    try {
      const created = await data.service.createClaudeAccount({ label: 'Flaky Read' });
      assert.ok(fs.existsSync(created.profileRef));
    } finally { data.close(); }
  });
});

test('starting fresh explicitly leaves a leftover profile directory and uses a suffixed home', async () => {
  const data = fixture({ exec: cliInstalledExec });
  try {
    fs.mkdirSync(path.join(data.root, 'profiles', 'exist12'), { mode: 0o700 });
    const created = await data.service.createClaudeAccount({ label: 'Exist12', existingProfile: 'fresh' });
    assert.equal(path.basename(created.profileRef), 'exist12-2');
    assert.equal(fs.statSync(created.profileRef).mode & 0o777, 0o700);
    assert.ok(created.profileNote.includes(path.join(data.root, 'profiles', 'exist12')));
  } finally { data.close(); }
});

// Issue #99's historical boundary still selects the conservative login flow;
// issue #300 additionally pins that decision to the exact served executable.
test('Claude login specs are version-aware (issue #99)', async (t) => {
  await t.test('a bare command resolves once and pins the probed realpath in the served command', async () => {
    const calls = [];
    let daemonPath;
    let canonicalPath;
    const data = fixture({
      claudePath: 'claude',
      exec: async (binary, args) => {
        calls.push({ binary, args });
        if (binary === '/usr/bin/which') return { stdout: `${daemonPath}\n` };
        assert.equal(binary, canonicalPath);
        assert.deepEqual(args, ['--version']);
        return { stdout: 'Claude Code 2.1.221' };
      },
    });
    try {
      const toolDir = path.join(data.root, 'Claude Code');
      canonicalPath = path.join(toolDir, 'claude-real');
      daemonPath = path.join(data.root, 'daemon-bin', 'claude');
      fs.mkdirSync(toolDir, { recursive: true });
      fs.mkdirSync(path.dirname(daemonPath), { recursive: true });
      fs.writeFileSync(canonicalPath, '#!/bin/sh\n', { mode: 0o700 });
      fs.symlinkSync(canonicalPath, daemonPath);

      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const spec = await data.service.loginSpec(account.id);

      assert.equal(path.isAbsolute(spec.command), true);
      assert.equal(spec.command, fs.realpathSync(canonicalPath));
      assert.equal(calls.find((call) => call.args[0] === '--version').binary, spec.command);
      assert.ok(spec.preview.endsWith(`'${spec.command}' /login`));
      assert.match(spec.preview, /; CLAUDE_CONFIG_DIR=/);
      assert.equal(spec.flow, 'activation');
    } finally { data.close(); }
  });

  await t.test('pre-2.1.216 keeps the env-scoped spec', async () => {
    const claudeExecutable = '/fixture/bin/claude';
    const data = fixture({
      claudePath: claudeExecutable,
      realpath: async (value) => value,
      exec: async (_binary, args) => ({ stdout: args[0] === '--version' ? 'Claude Code 2.1.215' : '' }),
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const spec = await data.service.loginSpec(account.id);
      assert.equal(spec.flow, 'config-dir');
      assert.equal(spec.requiresActivation, false);
      assert.deepEqual(spec.args, ['auth', 'login']);
      const real = fs.realpathSync(data.firstHome);
      assert.deepEqual(spec.env, { CLAUDE_CONFIG_DIR: real, CLAUDE_SECURESTORAGE_CONFIG_DIR: real });
      assert.match(spec.preview, /CLAUDE_CONFIG_DIR=/);
      assert.equal(spec.command, claudeExecutable);
      assert.match(spec.preview, /'\/fixture\/bin\/claude' auth login$/);
      assert.doesNotMatch(spec.preview, /logout/);
    } finally { data.close(); }
  });

  await t.test('both login previews drop the managed proxy key before the pins (#636 tripwire)', async () => {
    // A login run with ModelDeck's proxy client key in scope shows
    // "API Usage Billing" and takes the paste-the-code path. The preview
    // must unset OUR key (marker-guarded) ahead of the profile pins.
    const unset = 'if [ "${MODELDECK_MANAGED_ANTHROPIC_API_KEY:-}" = "1" ]; then unset ANTHROPIC_API_KEY MODELDECK_MANAGED_ANTHROPIC_API_KEY; fi; CLAUDE_CONFIG_DIR=';
    for (const version of ['2.1.215', '2.1.216']) {
      const data = fixture({
        claudePath: '/fixture/bin/claude',
        realpath: async (value) => value,
        exec: async (_binary, args) => ({ stdout: args[0] === '--version' ? `Claude Code ${version}` : '' }),
      });
      try {
        const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
        const spec = await data.service.loginSpec(account.id);
        assert.ok(spec.preview.startsWith(unset), `${version}: ${spec.preview}`);
        assert.doesNotMatch(spec.preview, /logout/);
      } finally { data.close(); }
    }
  });

  await t.test('2.1.216 and later drive sign-in through activation with the env pair pinned (#596 tripwire)', async () => {
    for (const version of ['2.1.216', '2.2.0', '3.0.1']) {
      const claudeExecutable = '/fixture/bin/claude';
      const data = fixture({
        claudePath: claudeExecutable,
        realpath: async (value) => value,
        exec: async (_binary, args) => ({ stdout: args[0] === '--version' ? `Claude Code ${version}` : '' }),
      });
      try {
        const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
        const spec = await data.service.loginSpec(account.id);
        assert.equal(spec.flow, 'activation');
        assert.equal(spec.requiresActivation, true);
        assert.deepEqual(spec.args, ['/login']);
        // Issue #596 tripwire: the activation-flow command must carry the
        // profile pin itself. Activation steers the credential on affected
        // releases, but only this env pin steers the .claude.json identity
        // write — an unpinned shell otherwise lands it in the default home
        // and sign-in fails silently. Never make the login command depend on
        // the invoking shell's environment again.
        const real = fs.realpathSync(data.firstHome);
        assert.deepEqual(spec.env, { CLAUDE_CONFIG_DIR: real, CLAUDE_SECURESTORAGE_CONFIG_DIR: real });
        // #636: the managed-key unset now leads; the pins must still precede the executable.
        assert.match(spec.preview, /; CLAUDE_CONFIG_DIR='[^']+' CLAUDE_SECURESTORAGE_CONFIG_DIR='[^']+' /);
        assert.match(spec.preview, /\/login$/);
        assert.doesNotMatch(spec.preview, /logout/);
      } finally { data.close(); }
    }
  });

  await t.test('an undetectable version fails toward the activation flow', async () => {
    const claudeExecutable = '/fixture/bin/claude';
    const data = fixture({
      claudePath: claudeExecutable,
      realpath: async (value) => value,
      exec: async () => { throw new Error('version is unreadable'); },
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const spec = await data.service.loginSpec(account.id);
      assert.equal(spec.flow, 'activation');
      assert.equal(spec.requiresActivation, true);
      assert.equal(spec.command, claudeExecutable);
    } finally { data.close(); }
  });

  await t.test('codex specs are untouched by the version gate', async () => {
    const data = fixture({ exec: async () => { throw new Error('never called for codex'); } });
    try {
      data.service.codexProfilesDir = path.join(data.root, 'profiles');
      const account = data.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: data.firstHome });
      const spec = await data.service.loginSpec(account.id);
      assert.equal(spec.flow, undefined);
      assert.equal(spec.requiresActivation, undefined);
      assert.deepEqual(spec.args, ['login']);
    } finally { data.close(); }
  });
});

// Issue #825: verify saves the plan display name, keeps it when the profile
// file gave nothing, and clears it when the file was read without one.
test('Claude verify saves, keeps, and clears the plan display name', async () => {
  let plan = { subscriptionType: null, rateLimitTier: null, displayName: 'Ultra' };
  const data = fixture({
    readClaudeAuth: async () => ({ authenticated: true, identity: 'user@example.invalid', plan }),
  });
  try {
    const account = data.store.saveAccount({
      provider: 'claude', label: 'Work', identity: 'user@example.invalid', profileRef: data.firstHome,
    });
    await data.service.verifyAccount(account.id);
    assert.deepEqual(data.store.getAccount(account.id).metadata.claudePlan,
      { subscriptionType: null, rateLimitTier: null, displayName: 'Ultra' });
    plan = { subscriptionType: 'max', rateLimitTier: null, displayName: null };
    await data.service.verifyAccount(account.id);
    assert.equal(data.store.getAccount(account.id).metadata.claudePlan.displayName, 'Ultra');
    plan = { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x', displayName: null };
    await data.service.verifyAccount(account.id);
    assert.deepEqual(data.store.getAccount(account.id).metadata.claudePlan,
      { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' });
  } finally { data.close(); }
});

// Issue #99 fix direction 2: post-login identity verification with teeth.
test('Claude verify refuses a read-back identity that contradicts the account', async (t) => {
  await t.test('mismatch is reported and nothing is persisted', async () => {
    const data = fixture({
      readClaudeAuth: async () => ({
        authenticated: true,
        identity: 'other@example.invalid',
        plan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
      }),
    });
    try {
      const account = data.store.saveAccount({
        provider: 'claude', label: 'Work', identity: 'intended@example.invalid', profileRef: data.firstHome,
      });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, true);
      assert.equal(result.identity, 'other@example.invalid');
      assert.deepEqual(result.identityMismatch, {
        expected: 'intended@example.invalid',
        actual: 'other@example.invalid',
      });
      const stored = data.store.getAccount(account.id);
      assert.equal(stored.identity, 'intended@example.invalid');
      assert.equal(stored.metadata.claudePlan, undefined);
    } finally { data.close(); }
  });

  await t.test('a case-only difference is not a mismatch', async () => {
    const data = fixture({
      readClaudeAuth: async () => ({ authenticated: true, identity: 'user@example.invalid' }),
    });
    try {
      const account = data.store.saveAccount({
        provider: 'claude', label: 'Work', identity: 'User@Example.invalid', profileRef: data.firstHome,
      });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.identityMismatch, undefined);
      assert.equal(result.authenticated, true);
    } finally { data.close(); }
  });

  await t.test('a first capture (no recorded identity) still records honestly', async () => {
    const data = fixture({
      readClaudeAuth: async () => ({ authenticated: true, identity: 'user@example.invalid' }),
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.identityMismatch, undefined);
      assert.equal(result.identity, 'user@example.invalid');
      assert.equal(data.store.getAccount(account.id).identity, 'user@example.invalid');
    } finally { data.close(); }
  });

  await t.test('an unauthenticated profile reports a credential in Claude\'s plain Keychain slot', async () => {
    let slotProbe;
    const data = fixture({
      readClaudeAuth: async () => ({ authenticated: false, identity: null }),
      claudeCredentialKeychainSlotState: async (input) => {
        slotProbe = input;
        return { profileScoped: false, unscoped: true };
      },
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, false);
      assert.equal(result.verifyHint, CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT);
      assert.deepEqual(slotProbe, { claudeConfigDir: data.firstHome, platform: 'linux' });
      assert.equal(data.store.getAccount(account.id).metadata.verifyHint, undefined);
    } finally { data.close(); }
  });

  // Issue #596: a login from an unpinned shell lands in the DEFAULT
  // ~/.claude.json (sibling of the active-profile symlink) and used to be
  // indistinguishable from "not signed in yet". The detector compares the
  // default home's identity against a snapshot taken when the login command
  // was served — never file mtime, which unrelated config writes refresh.
  const strayFixture = (overrides = {}) => fixture({
    claudePath: '/fixture/bin/claude',
    realpath: async (value) => value,
    exec: async (_binary, args) => ({ stdout: args[0] === '--version' ? 'Claude Code 2.2.0' : '' }),
    readClaudeAuth: async () => ({ authenticated: false, identity: null }),
    // Both slot conditions hold in the field failure; the stray-login
    // diagnostic must win when it fires because it names the actual cause.
    claudeCredentialKeychainSlotState: async () => ({ profileScoped: false, unscoped: true }),
    ...overrides,
  });
  const writeDefaultHomeConfig = (data, contents) => {
    const defaultHome = path.dirname(data.claudeActiveLink);
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.writeFileSync(path.join(defaultHome, '.claude.json'), JSON.stringify(contents));
  };
  // Issue #608: loginSpec stores the baseline snapshot promise WITHOUT
  // awaiting it (the atomic check-and-set from #600), so the fs read can
  // land after this test's next default-home write under full-suite
  // threadpool load. Tests pin the intended "baseline before write"
  // ordering explicitly instead of racing it.
  const strayBaselineCaptured = (data, accountId) => data.service.claudeStrayLoginBaseline.get(accountId);

  await t.test('an identity appearing in the default home after the login was served names what happened', async () => {
    const data = strayFixture();
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      await strayBaselineCaptured(data, account.id);
      writeDefaultHomeConfig(data, { oauthAccount: { emailAddress: 'stray@example.invalid', accountUuid: 'u-1' } });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, false);
      assert.equal(result.verifyHint, CLAUDE_STRAY_LOGIN_VERIFY_HINT);
      assert.equal(data.store.getAccount(account.id).metadata.verifyHint, undefined);
    } finally { data.close(); }
  });

  await t.test('a long-standing default-home identity does not flag a signed-out verify, even freshly rewritten', async () => {
    const data = strayFixture();
    try {
      writeDefaultHomeConfig(data, { oauthAccount: { emailAddress: 'old@example.invalid', accountUuid: 'u-0' } });
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      await strayBaselineCaptured(data, account.id);
      // Unpinned sessions rewrite this file constantly (history, project
      // trust) without a new login; a fresh mtime must not read as one.
      writeDefaultHomeConfig(data, {
        oauthAccount: { emailAddress: 'old@example.invalid', accountUuid: 'u-0' },
        history: ['unrelated write'],
      });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, false);
      // Falls through to the accurate Keychain-slot diagnostic instead.
      assert.equal(result.verifyHint, CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT);
    } finally { data.close(); }
  });

  await t.test('a default-home identity with no served login command stays an ordinary signed-out verify', async () => {
    const data = strayFixture();
    try {
      writeDefaultHomeConfig(data, { oauthAccount: { emailAddress: 'old@example.invalid', accountUuid: 'u-0' } });
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, false);
      assert.equal(result.verifyHint, CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT);
    } finally { data.close(); }
  });

  await t.test('a clean authenticated verify concludes the attempt: later default-home changes stop flagging', async () => {
    let authResult = { authenticated: false, identity: null };
    const data = strayFixture({ readClaudeAuth: async () => authResult });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      await strayBaselineCaptured(data, account.id);
      authResult = { authenticated: true, identity: 'user@example.invalid' };
      await data.service.verifyAccount(account.id);
      // The attempt is over; an unpinned login by ANYONE later must not be
      // pinned on this account's long-finished sign-in.
      writeDefaultHomeConfig(data, { oauthAccount: { emailAddress: 'later@example.invalid', accountUuid: 'u-9' } });
      authResult = { authenticated: false, identity: null };
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.verifyHint, CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT);
    } finally { data.close(); }
  });

  await t.test('an unreadable default config at serve time makes no stray claim', async () => {
    const data = strayFixture();
    try {
      // Mid-rewrite truncation at snapshot time: the baseline must record
      // "unknown", not "no identity" — else the long-standing identity below
      // would read as a fresh stray login.
      const defaultHome = path.dirname(data.claudeActiveLink);
      fs.mkdirSync(defaultHome, { recursive: true });
      fs.writeFileSync(path.join(defaultHome, '.claude.json'), '{"oauthAccount":{"emailAddr');
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      await strayBaselineCaptured(data, account.id);
      writeDefaultHomeConfig(data, { oauthAccount: { emailAddress: 'old@example.invalid', accountUuid: 'u-0' } });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.verifyHint, CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT);
    } finally { data.close(); }
  });

  await t.test('re-serving the login command never disarms a live attempt', async () => {
    const data = strayFixture();
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      await strayBaselineCaptured(data, account.id);
      writeDefaultHomeConfig(data, { oauthAccount: { emailAddress: 'stray@example.invalid', accountUuid: 'u-1' } });
      // A Copy-button refetch (or any out-of-band GET) after the stray login
      // landed must not overwrite the baseline with the strayed identity.
      await data.service.loginSpec(account.id);
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.verifyHint, CLAUDE_STRAY_LOGIN_VERIFY_HINT);
    } finally { data.close(); }
  });

  await t.test('concurrent serves capture exactly one baseline (atomic check-and-set)', async () => {
    const data = strayFixture();
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      let snapshots = 0;
      const original = data.service.claudeDefaultHomeIdentitySnapshot.bind(data.service);
      data.service.claudeDefaultHomeIdentitySnapshot = async () => {
        snapshots += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return original();
      };
      await Promise.all([data.service.loginSpec(account.id), data.service.loginSpec(account.id)]);
      assert.equal(snapshots, 1);
    } finally { data.close(); }
  });

  await t.test('deleting the account clears its stray-login baseline like the sibling maps', async () => {
    const data = strayFixture();
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      assert.equal(data.service.claudeStrayLoginBaseline.has(account.id), true);
      await data.service.deleteAccount(account.id);
      assert.equal(data.service.claudeStrayLoginBaseline.has(account.id), false);
    } finally { data.close(); }
  });

  await t.test('a failed slot diagnostic preserves the ordinary unauthenticated result', async () => {
    const data = fixture({
      readClaudeAuth: async () => ({ authenticated: false, identity: null }),
      claudeCredentialKeychainSlotState: async () => { throw new Error('Keychain unavailable'); },
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, false);
      assert.equal(result.verifyHint, undefined);
    } finally { data.close(); }
  });

  // Two cases carried over from PR #597's suite, adapted to the baseline
  // design that replaced its mtime detector.
  await t.test('a default-home config gaining non-identity keys produces no stray hint', async () => {
    const data = strayFixture();
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      writeDefaultHomeConfig(data, { firstStartTime: '2026-08-29T00:00:00.000Z' });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, false);
      assert.equal(result.verifyHint, CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT);
    } finally { data.close(); }
  });

  await t.test('an authenticated verify never carries the stray-login hint', async () => {
    const data = strayFixture({
      readClaudeAuth: async () => ({ authenticated: true, identity: 'user@example.invalid' }),
    });
    try {
      const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
      await data.service.loginSpec(account.id);
      writeDefaultHomeConfig(data, { oauthAccount: { emailAddress: 'stray@example.invalid', accountUuid: 'u-1' } });
      const result = await data.service.verifyAccount(account.id);
      assert.equal(result.authenticated, true);
      assert.equal(result.verifyHint, undefined);
    } finally { data.close(); }
  });
});

// Issue #99, fix direction 4 fallout: the tool probe names which mechanism
// scopes credential storage on the installed CLI.
test('tool probe reports the Claude credential-scoping mechanism', async (t) => {
  const probeFixture = (claudeVersion) => fixture({
    claudePath: 'claude-fixture',
    codexPath: 'codex-fixture',
    exec: async (binary, args) => {
      if (args[0] !== '--version') return { stdout: '' };
      if (binary === 'claude-fixture') {
        if (!claudeVersion) { const error = new Error('not installed'); error.code = 'ENOENT'; throw error; }
        return { stdout: `Claude Code ${claudeVersion}` };
      }
      return { stdout: 'codex 1.0.0' };
    },
    registryFetch: async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }),
  });

  await t.test('config-dir below 2.1.216', async () => {
    const data = probeFixture('2.1.215');
    try {
      assert.equal((await data.service.probeTools()).tools.claude.credentialScoping, 'config-dir');
    } finally { data.close(); }
  });

  await t.test('historical resolved-home classifier from 2.1.216 on', async () => {
    const data = probeFixture('2.1.216');
    try {
      assert.equal((await data.service.probeTools()).tools.claude.credentialScoping, 'resolved-home');
    } finally { data.close(); }
  });

  await t.test('null when the CLI is not installed', async () => {
    const data = probeFixture(null);
    try {
      assert.equal((await data.service.probeTools()).tools.claude.credentialScoping, null);
    } finally { data.close(); }
  });
});

test('Claude refresh isolates per-profile failures and never rotates accounts', async () => {
  const calls = [];
  const data = fixture({
    fetchClaude: async ({ claudeConfigDir }) => {
      calls.push(claudeConfigDir);
      if (claudeConfigDir === data.secondHome) throw new Error('fixture provider failure');
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    const first = data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    const results = await data.service.refreshClaude();
    assert.deepEqual([...calls].sort(), [data.firstHome, data.secondHome].sort());
    assert.deepEqual(results, [
      { accountId: first.id, ok: true, snapshotCount: 1 },
      { accountId: second.id, ok: false, error: 'fixture provider failure' },
    ]);
    assert.equal(data.store.getAccount(first.id).isDefault, true);
    assert.equal(data.store.getAccount(second.id).isDefault, false);
  } finally { data.close(); }
});

test('Claude refresh keeps credential expiry private while threading it to the scheduler (issue #265)', async () => {
  const expiresAt = Date.parse('2097-06-05T04:03:02.100Z');
  const data = fixture({
    claudeCredentialsPresent: async () => true,
    fetchClaude: async () => {
      const snapshots = [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
      Object.defineProperty(snapshots, 'expiresAt', { value: expiresAt, enumerable: false });
      return snapshots;
    },
  });
  try {
    const account = data.store.saveAccount({ provider: 'claude', label: 'Work', profileRef: data.firstHome });
    const results = await data.service.refreshClaude();
    assert.deepEqual(results, [{ accountId: account.id, ok: true, snapshotCount: 1 }]);
    assert.equal(data.service.claudeCredentialExpiries.get(account.id), expiresAt);

    for (const payload of [results, await data.service.state()]) {
      const serialized = JSON.stringify(payload);
      assert.doesNotMatch(serialized, new RegExp(String(expiresAt)));
      assert.doesNotMatch(serialized, /"expiresAt"/);
    }
    assert.equal(await data.service.deleteAccount(account.id), true);
    assert.equal(data.service.claudeCredentialExpiries.has(account.id), false);
  } finally { data.close(); }
});

// Issue #89 — per-account refresh failures must surface instead of being
// dropped by refreshAll, and a credentials-expired failure must flip the
// account's auth chip even though the presence probe still sees credentials.

const EXPIRED_OAUTH_ERROR = 'Claude usage refresh failed: stored OAuth credentials have expired; sign in explicitly before refreshing';

// Issue #98 — the probe's denied-Keychain-read message as it arrives through
// the fetchClaude stderr wrapping (see KEYCHAIN_DENIED_ERROR in
// src/adapters/claude-usage-probe.mjs).
const KEYCHAIN_DENIED_REFRESH_ERROR = "Claude usage refresh failed: Claude usage probe failed: macOS Keychain blocked ModelDeck's background service from reading this account's stored sign-in (a dismissed permission prompt does this); click Refresh and choose Always Allow when macOS asks again";

test('denied Keychain read flips the account chip to keychain-denied, not signin-required (issue #98)', async () => {
  let deny = true;
  const data = fixture({
    // The item exists, so the presence probe keeps saying "ok" — exactly
    // the state a dismissed prompt leaves behind.
    claudeCredentialsPresent: async () => true,
    fetchClaude: async ({ claudeConfigDir }) => {
      if (deny && claudeConfigDir === data.secondHome) throw new Error(KEYCHAIN_DENIED_REFRESH_ERROR);
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    const first = data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    await data.service.refreshAll();

    let state = await data.service.state();
    assert.equal(state.accounts.find((account) => account.id === first.id).authState, 'ok');
    const denied = state.accounts.find((account) => account.id === second.id);
    assert.equal(denied.authState, 'keychain-denied');
    assert.match(denied.lastRefreshError.message, /Keychain blocked ModelDeck/);
    assert.match(denied.lastRefreshError.message, /Always Allow/);

    // The user clicked Refresh and chose Always Allow: the next successful
    // pass clears both the error and the chip.
    deny = false;
    await data.service.refreshAll();
    state = await data.service.state();
    const recovered = state.accounts.find((account) => account.id === second.id);
    assert.equal(recovered.authState, 'ok');
    assert.equal(recovered.lastRefreshError, undefined);
  } finally { data.close(); }
});

test('per-account refresh failures propagate into state and clear on the next success', async () => {
  let failSecond = true;
  const timestamps = [1_800_000_000_000, 1_800_000_300_000];
  const data = fixture({
    now: () => timestamps[0],
    claudeCredentialsPresent: async () => true,
    fetchClaude: async ({ claudeConfigDir }) => {
      if (failSecond && claudeConfigDir === data.secondHome) throw new Error('fixture provider failure');
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    const first = data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    await data.service.refreshAll();

    let state = await data.service.state();
    const okAccount = state.accounts.find((account) => account.id === first.id);
    const failed = state.accounts.find((account) => account.id === second.id);
    assert.equal(okAccount.lastRefreshError, undefined);
    assert.deepEqual(failed.lastRefreshError, {
      message: 'fixture provider failure',
      at: new Date(timestamps[0]).toISOString(),
    });
    // A generic provider failure is not a sign-in problem — the chip holds.
    assert.equal(failed.authState, 'ok');

    failSecond = false;
    data.service.now = () => timestamps[1];
    await data.service.refreshAll();
    state = await data.service.state();
    assert.equal(state.accounts.find((account) => account.id === second.id).lastRefreshError, undefined);
  } finally { data.close(); }
});

test('expired stored OAuth flips the account auth chip to signin-required despite present credentials', async () => {
  const data = fixture({
    // The Keychain/file presence probe still SEES the expired credentials —
    // exactly the hand-test failure where the chip stayed Healthy.
    claudeCredentialsPresent: async () => true,
    fetchClaude: async ({ claudeConfigDir }) => {
      if (claudeConfigDir === data.secondHome) throw new Error(EXPIRED_OAUTH_ERROR);
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    const first = data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    await data.service.refreshAll();

    const state = await data.service.state();
    assert.equal(state.accounts.find((account) => account.id === first.id).authState, 'ok');
    const expired = state.accounts.find((account) => account.id === second.id);
    assert.equal(expired.authState, 'signin-required');
    assert.match(expired.lastRefreshError.message, /sign in explicitly before refreshing/);
  } finally { data.close(); }
});

// Issue #149 — the ADDITIVE `signinReason` beside authState: "expired" is
// idle-decay (credentials present, Claude Code renews them on next use, the
// deck renders the calm idle notice); "missing" is the only genuine sign-out
// (today's alarm). Both probe messages are pinned VERBATIM here and in
// adapters.test.mjs so probe wording drift fails loudly instead of silently
// re-alarming every idle account. authState values themselves are unchanged.
const MISSING_OAUTH_ERROR = 'Claude usage refresh failed: stored OAuth credentials are unavailable; sign in explicitly before refreshing';

test('expired-credentials refresh failure carries signinReason "expired" (issue #149)', async () => {
  const data = fixture({
    claudeCredentialsPresent: async () => true,
    fetchClaude: async ({ claudeConfigDir }) => {
      if (claudeConfigDir === data.secondHome) throw new Error(EXPIRED_OAUTH_ERROR);
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    const first = data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    await data.service.refreshAll();

    const state = await data.service.state();
    const healthy = state.accounts.find((account) => account.id === first.id);
    assert.equal(healthy.authState, 'ok');
    // The reason field is present ONLY alongside signin-required — every
    // other account's payload stays byte-identical to the pre-#149 shape.
    assert.equal('signinReason' in healthy, false);
    const expired = state.accounts.find((account) => account.id === second.id);
    assert.equal(expired.authState, 'signin-required');
    assert.equal(expired.signinReason, 'expired');
  } finally { data.close(); }
});

test('missing-credentials refresh failure carries signinReason "missing" (issue #149)', async () => {
  const data = fixture({
    claudeCredentialsPresent: async () => true,
    fetchClaude: async ({ claudeConfigDir }) => {
      if (claudeConfigDir === data.secondHome) throw new Error(MISSING_OAUTH_ERROR);
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    await data.service.refreshAll();

    const account = (await data.service.state()).accounts.find((item) => item.id === second.id);
    assert.equal(account.authState, 'signin-required');
    assert.equal(account.signinReason, 'missing');
  } finally { data.close(); }
});

test('presence-probe sign-in states carry signinReason "missing" — absent credentials are a genuine sign-out (issue #149)', async () => {
  // No refresh ran, so there is no per-account refresh error to derive from:
  // the reason comes from the presence path (Claude Keychain/file probe and
  // the Codex auth.json check alike).
  const data = fixture({ claudeCredentialsPresent: async () => false });
  try {
    const claude = data.store.saveAccount({ provider: 'claude', label: 'Claude', profileRef: data.firstHome, isDefault: true });
    const codex = data.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: data.secondHome, isDefault: true });

    const state = await data.service.state();
    for (const id of [claude.id, codex.id]) {
      const account = state.accounts.find((item) => item.id === id);
      assert.equal(account.authState, 'signin-required');
      assert.equal(account.signinReason, 'missing');
    }
  } finally { data.close(); }
});

// Issue #164 — the live forensics: a Codex probe failing `401
// token_invalidated` (token family rotated after re-logging the #108
// duplicate's other half) left authState "ok" — auth.json still exists, so
// the presence check passed — and the deck showed only the passive #89
// staleness chip. The classified probe rejection must flip the account to
// signin-required/"missing" (amber "Sign in needed" + #118 one-click path),
// while an UNRECOGNIZED 401 keeps exactly the old behavior.

test('Codex token_invalidated probe failure flips authState to signin-required with reason "missing" (issue #164)', async () => {
  const data = fixture({
    fetchCodex: async ({ codexHome }) => {
      if (path.basename(codexHome) === 'second') throw codexDeadCredentialError('token_invalidated');
      return [{ scope: 'weekly', usedPercent: 12, source: 'fixture' }];
    },
  });
  try {
    // Both profiles still HOLD an auth.json — the dead token looks present
    // locally, which is exactly how the account hid behind the stale chip.
    for (const home of [data.firstHome, data.secondHome]) {
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
        tokens: { id_token: 'placeholder-token', account_id: `acct-placeholder-${path.basename(home)}` },
      }), { mode: 0o600 });
    }
    const healthy = data.store.saveAccount({ provider: 'codex', label: 'Healthy', profileRef: data.firstHome, isDefault: true });
    const dead = data.store.saveAccount({ provider: 'codex', label: 'Invalidated', profileRef: data.secondHome });
    await data.service.refreshAll();

    const state = await data.service.state();
    assert.equal(state.accounts.find((account) => account.id === healthy.id).authState, 'ok');
    const flipped = state.accounts.find((account) => account.id === dead.id);
    assert.equal(flipped.authState, 'signin-required');
    // Genuine sign-out: amber "Sign in needed", never the calm #149 idle tone.
    assert.equal(flipped.signinReason, 'missing');
    assert.match(flipped.lastRefreshError.message, /token_invalidated/);
    assert.match(flipped.lastRefreshError.message, /sign in explicitly before refreshing/);
  } finally { data.close(); }
});

test('unrecognized Codex 401 keeps authState "ok" with only the staleness error — no false alarm (issue #164)', async () => {
  const transient = 'unexpected status 401 Unauthorized: {"error":{"message":"intermittent auth verification failure","type":"server_error"}}';
  const data = fixture({
    fetchCodex: async ({ codexHome }) => {
      if (path.basename(codexHome) === 'second') throw new Error(transient);
      return [{ scope: 'weekly', usedPercent: 12, source: 'fixture' }];
    },
  });
  try {
    for (const home of [data.firstHome, data.secondHome]) {
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
        tokens: { id_token: 'placeholder-token', account_id: `acct-placeholder-${path.basename(home)}` },
      }), { mode: 0o600 });
    }
    data.store.saveAccount({ provider: 'codex', label: 'Healthy', profileRef: data.firstHome, isDefault: true });
    const hiccup = data.store.saveAccount({ provider: 'codex', label: 'Hiccup', profileRef: data.secondHome });
    await data.service.refreshAll();

    const account = (await data.service.state()).accounts.find((item) => item.id === hiccup.id);
    // Exactly today's behavior: honest staleness, no sign-in alarm.
    assert.equal(account.authState, 'ok');
    assert.equal('signinReason' in account, false);
    assert.equal(account.lastRefreshError.message, transient);
  } finally { data.close(); }
});

test('re-login after token_invalidated clears the alarm without waiting for the next tick (issues #118/#164)', async () => {
  let invalidated = true;
  const data = fixture({
    fetchCodex: async () => {
      if (invalidated) throw codexDeadCredentialError('token_invalidated');
      return [{ scope: 'weekly', usedPercent: 12, source: 'fixture' }];
    },
  });
  try {
    fs.writeFileSync(path.join(data.firstHome, 'auth.json'), JSON.stringify({
      tokens: { id_token: 'placeholder-token', account_id: 'acct-placeholder-relogged' },
    }), { mode: 0o600 });
    const account = data.store.saveAccount({ provider: 'codex', label: 'Invalidated', profileRef: data.firstHome, isDefault: true });
    await data.service.refreshAll();
    assert.equal((await data.service.state()).accounts[0].authState, 'signin-required');

    // The #118 one-click path ends in a verify; an authenticated result
    // supersedes the recorded failure immediately (#89 contract).
    invalidated = false;
    data.service.readCodexAuth = async () => ({ authenticated: true, identity: 'user@example.invalid', plan: { planType: null } });
    await data.service.verifyAccount(account.id);
    const recovered = (await data.service.state()).accounts[0];
    assert.equal(recovered.authState, 'ok');
    assert.equal(recovered.lastRefreshError, undefined);
  } finally { data.close(); }
});

test('keychain-denied precedence is untouched: no signinReason rides along (issues #98/#149)', async () => {
  const data = fixture({
    claudeCredentialsPresent: async () => true,
    fetchClaude: async ({ claudeConfigDir }) => {
      if (claudeConfigDir === data.secondHome) throw new Error(KEYCHAIN_DENIED_REFRESH_ERROR);
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    await data.service.refreshAll();

    const account = (await data.service.state()).accounts.find((item) => item.id === second.id);
    assert.equal(account.authState, 'keychain-denied');
    assert.equal('signinReason' in account, false);
  } finally { data.close(); }
});

test('expired-OAuth transition invalidates the cached tool probe so the provider chip flips too', async () => {
  let expired = false;
  const data = fixture({
    claudePath: 'claude-fixture',
    codexPath: 'codex-fixture',
    claudeCredentialsPresent: async () => true,
    fetchClaude: async () => {
      if (expired) throw new Error(EXPIRED_OAUTH_ERROR);
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
    exec: async (binary) => ({ stdout: binary.includes('claude') ? 'Claude Code 1.0.0' : 'codex 1.0.0' }),
    registryFetch: async () => ({ ok: true, json: async () => ({ version: '1.0.0' }) }),
    toolProbeTtlMs: 60 * 60_000,
  });
  try {
    const account = data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    assert.equal((await data.service.probeTools()).tools.claude.authState, 'ok');

    expired = true;
    await data.service.refreshAll();
    // The 60-minute probe cache would still say Healthy — the transition
    // must have invalidated it (mirrors the duplicate-token handling).
    assert.equal((await data.service.probeTools()).tools.claude.authState, 'signin-required');

    // Re-login: an authenticated verify clears the recorded failure so the
    // chip flips back without waiting for the next refresh tick.
    data.service.readClaudeAuth = async () => ({ authenticated: true, identity: 'dev@example.com' });
    await data.service.verifyAccount(account.id);
    assert.equal((await data.service.probeTools()).tools.claude.authState, 'ok');
    assert.equal((await data.service.state()).accounts[0].lastRefreshError, undefined);
  } finally { data.close(); }
});

test('disabling an account prunes its recorded refresh error on the next refresh pass', async () => {
  let fail = true;
  const data = fixture({
    claudeCredentialsPresent: async () => true,
    fetchClaude: async ({ claudeConfigDir }) => {
      if (fail && claudeConfigDir === data.secondHome) throw new Error(EXPIRED_OAUTH_ERROR);
      return [{ scope: 'weekly', usedPercent: 15, source: 'fixture' }];
    },
  });
  try {
    data.store.saveAccount({ provider: 'claude', label: 'First', profileRef: data.firstHome, isDefault: true });
    const second = data.store.saveAccount({ provider: 'claude', label: 'Second', profileRef: data.secondHome });
    await data.service.refreshAll();
    let account = (await data.service.state()).accounts.find((item) => item.id === second.id);
    assert.equal(account.authState, 'signin-required');
    assert.match(account.lastRefreshError.message, /sign in explicitly before refreshing/);

    // Disable the account: it drops out of the refresh list, so a success
    // can never clear its entry — the next pass must prune it instead of
    // leaving the chip stuck on signin-required forever.
    data.store.saveAccount({ ...second, enabled: false });
    await data.service.refreshAll();
    account = (await data.service.state()).accounts.find((item) => item.id === second.id);
    assert.equal(account.lastRefreshError, undefined);
    assert.notEqual(account.authState, 'signin-required');
    assert.equal(data.service.accountRefreshErrors.has(second.id), false);
  } finally { data.close(); }
});

test('codex refresh failures propagate per account as well', async () => {
  const data = fixture({
    fetchCodex: async () => { throw new Error('codex fixture failure'); },
  });
  try {
    const account = data.store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: data.firstHome, isDefault: true });
    fs.writeFileSync(path.join(data.firstHome, 'auth.json'), '{}');
    await data.service.refreshAll();
    const state = await data.service.state();
    const codex = state.accounts.find((item) => item.id === account.id);
    assert.equal(codex.lastRefreshError.message, 'codex fixture failure');
    // auth.json exists and the failure message is not credential-shaped.
    assert.equal(codex.authState, 'ok');
  } finally { data.close(); }
});

test('state self-reports the daemon runtime and admits a missing executable (issue #185)', async () => {
  // A daemon launched from a since-deleted bundle keeps answering
  // /api/state while every SEA self-spawn fails ENOENT — the app can only
  // repair what the daemon admits, so the state payload carries the truth.
  const gone = fixture({
    daemonExecPath: '/deleted-worktree/modeldeckd',
    daemonExecPathExists: () => false,
    daemonSea: true,
    daemonGitCommit: 'abc123',
  });
  try {
    assert.deepEqual((await gone.service.state()).daemon, {
      execPath: '/deleted-worktree/modeldeckd',
      binaryPresent: false,
      sea: true,
      MDGitCommit: 'abc123',
    });
  } finally { gone.close(); }

  // Defaults: the live process executable, which exists; source-mode runs
  // have no inlined build commit to self-report.
  const healthy = fixture();
  try {
    assert.deepEqual((await healthy.service.state()).daemon, {
      execPath: process.execPath,
      binaryPresent: true,
      sea: false,
      MDGitCommit: null,
    });
  } finally { healthy.close(); }

  // A throwing existence probe reads as missing, never as healthy.
  const throwing = fixture({
    daemonExecPath: '/unreadable/modeldeckd',
    daemonExecPathExists: () => { throw new Error('probe blew up'); },
  });
  try {
    assert.equal((await throwing.service.state()).daemon.binaryPresent, false);
  } finally { throwing.close(); }
});
