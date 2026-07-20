import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-phase2-'));
  const firstHome = path.join(root, 'profiles', 'first');
  const secondHome = path.join(root, 'profiles', 'second');
  fs.mkdirSync(firstHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(secondHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(firstHome, 0o700);
  fs.chmodSync(secondHome, 0o700);
  const store = new Store(':memory:');
  const codexActiveLink = path.join(root, 'active', '.codex');
  const claudeActiveLink = path.join(root, 'active', '.claude');
  const service = new ModelDeckService(store, {
    codexActiveLink,
    claudeActiveLink,
    claudeProfilesDir: path.join(root, 'profiles'),
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
    const claudeOne = data.store.saveAccount({ provider: 'claude', label: 'Claude One', profileRef: data.firstHome, isDefault: true });
    const claudeTwo = data.store.saveAccount({ provider: 'claude', label: 'Claude Two', profileRef: data.secondHome });
    let active = await data.service.activateAccount(claudeTwo.id);
    assert.equal(active.isDefault, true);
    assert.equal(fs.readlinkSync(data.claudeActiveLink), fs.realpathSync(data.secondHome));
    assert.deepEqual((await data.service.state()).activation.claude, {
      state: 'effective', resolvedProfileRef: fs.realpathSync(data.secondHome),
    });

    fs.unlinkSync(data.claudeActiveLink);
    fs.mkdirSync(data.claudeActiveLink, { recursive: true });
    await assert.rejects(data.service.activateAccount(claudeOne.id), { code: 'active-link-blocked' });
    assert.equal(data.store.getAccount(claudeTwo.id).isDefault, true);

    const codexOne = data.store.saveAccount({ provider: 'codex', label: 'Codex One', profileRef: data.firstHome, isDefault: true });
    const codexTwo = data.store.saveAccount({ provider: 'codex', label: 'Codex Two', profileRef: data.secondHome });
    active = await data.service.activateAccount(codexTwo.id);
    assert.equal(active.isDefault, true);
    assert.equal(fs.readlinkSync(data.codexActiveLink), fs.realpathSync(data.secondHome));
    assert.deepEqual((await data.service.state()).activation.codex, {
      state: 'effective', resolvedProfileRef: fs.realpathSync(data.secondHome),
    });

    active = await data.service.activateAccount(codexOne.id);
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
    data.store.saveAccount({
      provider, label: `${provider} default`, profileRef: data.firstHome, isDefault: true,
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
      });
      fs.unlinkSync(activeLink);
    });
  }
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

test('creates managed Claude accounts and imports only an explicitly approved legacy home', async () => {
  const data = fixture();
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
