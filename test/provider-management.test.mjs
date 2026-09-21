import test from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { fetchClaudeUsage, resolveClaudeCodeVersion } from '../src/adapters/claude.mjs';
import { fetchCodexRateLimits } from '../src/adapters/codex.mjs';
import { enumerateTranscriptFiles } from '../src/transcript-ingest.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-management-')));
  const store = new Store(':memory:');
  const service = new ModelDeckService(store, {
    claudeActiveLink: path.join(root, 'home', '.claude'),
    codexActiveLink: path.join(root, 'home', '.codex'),
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    zshenvPath: path.join(root, 'home', '.zshenv'),
    platform: 'linux',
    exec: async (_binary, args) => ({ stdout: args[0] === '--version' ? '2.2.0' : '/fixture/cli' }),
    realpath: async (value) => value,
    readClaudeAuth: async () => ({ authenticated: true, identity: 'person@example.invalid' }),
    readCodexAuth: async () => ({ authenticated: true, identity: 'person@example.invalid' }),
    readCodexAccountId: async () => null,
    claudeCredentialsPresent: async () => true,
    listProviderProcesses: async () => [],
    logWarehouseIngest: () => {},
    runDiagnostician: async () => ({}),
    refitUsageEstimates: async () => ({}),
    ...options,
  });
  t.after(async () => {
    await service.stopAutoRefresh();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, service };
}

function seedHome(service, provider) {
  const home = service[`${provider}ActiveLink`];
  const transcript = path.join(home, provider === 'claude' ? 'projects/project' : 'sessions/2026/09/11', provider === 'claude' ? 'session.jsonl' : 'rollout-placeholder-session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.writeFileSync(transcript, JSON.stringify(provider === 'claude'
    ? { type: 'user', sessionId: 'placeholder-session', uuid: 'placeholder-message', timestamp: '2026-09-11T10:00:00Z', message: { role: 'user', content: 'placeholder transcript' } }
    : { type: 'session_meta', timestamp: '2026-09-11T10:00:00Z', payload: { id: 'placeholder-session', cwd: '/placeholder/project' } }) + '\n');
  return { home, transcript, bytes: fs.readFileSync(transcript) };
}

function homeSnapshot(home) {
  const result = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, entry);
      const stat = fs.lstatSync(file);
      result[path.relative(home, file)] = { mode: stat.mode, inode: stat.ino,
        bytes: stat.isFile() ? fs.readFileSync(file).toString('base64') : null,
        link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null };
      if (stat.isDirectory()) walk(file);
    }
  };
  walk(home);
  return result;
}

async function api(service, store, method, url, input = {}, authenticated = true) {
  const token = 'placeholder-management-token';
  const port = 43564;
  const app = createApp({ store, service, host: '127.0.0.1', port, mutationToken: token });
  const req = Readable.from([Buffer.from(JSON.stringify(input))]);
  Object.assign(req, { method, url, socket: { remoteAddress: '127.0.0.1' }, headers: {
    host: `127.0.0.1:${port}`, 'content-type': 'application/json',
    ...(authenticated ? { 'x-modeldeck-token': token, cookie: `modeldeck_session=${token}` } : {}),
  } });
  let status;
  let body;
  await app.server.listeners('request')[0](req, {
    writeHead(value) { status = value; }, end(value) { body = JSON.parse(String(value)); },
  });
  return { status, body };
}

for (const provider of ['claude', 'codex']) {
  test(`one-login-never-touches-home (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    const { home, transcript, bytes } = seedHome(service, provider);
    const before = homeSnapshot(home);
    const account = await service.saveAccount({ provider, label: 'Personal' });
    assert.equal(account.profileRef, home);
    assert.equal(fs.existsSync(service[`${provider}ProfilesDir`]), false);
    assert.equal((await service.verifyAccount(account.id)).authenticated, true);
    assert.equal((await service.loginSpec(account.id)).requiresActivation ?? false, false);
    let probedHome;
    if (provider === 'claude') {
      await resolveClaudeCodeVersion(async () => ({ stdout: '2.2.0' }));
      service.fetchClaude = (options) => fetchClaudeUsage({ ...options,
        lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o600 }),
        run: async (_binary, _args, invocation) => {
          probedHome = invocation.env.CLAUDE_CONFIG_DIR;
          return { stdout: JSON.stringify({ five_hour: { utilization: 12 } }) };
        },
      });
      assert.equal((await service.refreshClaude())[0].ok, true);
      const files = await enumerateTranscriptFiles(service.claudeProfilesDir, [{ path: home, profileSlug: account.id }]);
      assert.equal(files.files[0].path, transcript);
    } else {
      service.fetchCodex = (options) => fetchCodexRateLimits({ ...options,
        spawnImpl: (_binary, _args, invocation) => {
          probedHome = invocation.env.CODEX_HOME;
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.kill = () => { child.killed = true; };
          child.stdin = { write: (line) => {
            const request = JSON.parse(line);
            if (!request.id) return;
            queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: request.id, result: request.id === 1 ? {} : { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } } }) + '\n'));
          } };
          return child;
        },
      });
      assert.equal((await service.refreshCodex())[0].ok, true);
    }
    assert.equal(probedHome, home);
    await service.runWarehouseIngestPass();
    assert.ok(store.getIngestFileState(transcript), 'usage ingest found the transcript at its original path');
    await assert.rejects(service.activateAccount(account.id), { code: 'not-managed', statusCode: 409 });
    await assert.rejects(service.installProviderShellHook(provider), { code: 'not-managed', statusCode: 409 });
    await assert.rejects(service[provider === 'claude' ? 'writeClaudeShellEnvFile' : 'writeCodexShellEnvFile'](home), { code: 'not-managed', statusCode: 409 });
    assert.equal(fs.lstatSync(home).isDirectory(), true);
    assert.deepEqual(fs.readFileSync(transcript), bytes);
    assert.equal(fs.existsSync(service[`${provider}ShellEnvFile`]), false);
    assert.equal(store.getSettings()[`${provider}Managed`], null);
    assert.equal((await service.state()).managed[provider], false);
    assert.deepEqual(homeSnapshot(home), before);
    const installer = spawnSync('/bin/sh', ['scripts/install-shell-env.sh'], {
      env: { PATH: process.env.PATH, HOME: path.dirname(home), MODELDECK_DB_PATH: path.join(path.dirname(home), 'absent.sqlite') }, encoding: 'utf8',
    });
    assert.equal(installer.status, 1);
    assert.match(installer.stderr, /not-managed \(409\)/);
    assert.equal(fs.existsSync(service.configLintZshenvPath), false);
    assert.deepEqual(homeSnapshot(home), before);
  });
}

for (const provider of ['claude', 'codex']) {
  test(`first unmanaged login skips an orphaned profile choice (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    const { home } = seedHome(service, provider);
    const orphan = path.join(service[`${provider}ProfilesDir`], 'personal');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'keep.txt'), 'placeholder history');
    const before = homeSnapshot(home);
    const account = await service.saveAccount({ provider, label: 'Personal', manageProvider: true });
    assert.equal(account.profileRef, home);
    assert.equal(store.getSettings()[`${provider}Managed`], null);
    assert.deepEqual(homeSnapshot(home), before);
    assert.deepEqual(fs.readdirSync(service[`${provider}ProfilesDir`]), ['personal']);
    assert.equal(fs.readFileSync(path.join(orphan, 'keep.txt'), 'utf8'), 'placeholder history');
  });

  for (const choice of ['adopt', 'fresh']) {
    test(`management consent precedes the existing profile ${choice} choice (${provider})`, async (t) => {
      const { service, store } = fixture(t);
      const { home } = seedHome(service, provider);
      const first = await service.saveAccount({ provider, label: 'Personal' });
      const orphan = path.join(service[`${provider}ProfilesDir`], 'work');
      fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(orphan, 'keep.txt'), 'placeholder history');
      const request = { provider, label: 'Work' };
      const consent = await api(service, store, 'POST', '/api/accounts', request);
      assert.equal(consent.status, 409);
      assert.equal(consent.body.code, 'manage-required');
      const profile = await api(service, store, 'POST', '/api/accounts', { ...request, manageProvider: true });
      assert.equal(profile.status, 409);
      assert.equal(profile.body.code, 'profile-exists');
      assert.equal(store.getSettings()[`${provider}Managed`], null);
      assert.equal(store.getAccount(first.id).profileRef, home);
      assert.equal(fs.lstatSync(home).isDirectory(), true);
      const created = await api(service, store, 'POST', '/api/accounts', { ...request, manageProvider: true, existingProfile: choice });
      assert.equal(created.status, 201);
      assert.equal(store.listAccounts().length, 2);
      assert.equal(store.getSettings()[`${provider}Managed`], true);
      assert.equal(fs.realpathSync(home), store.getAccount(first.id).profileRef);
      assert.equal(created.body.account.profileRef === orphan, choice === 'adopt');
      assert.equal(fs.readFileSync(path.join(orphan, 'keep.txt'), 'utf8'), 'placeholder history');
      if (choice === 'fresh') assert.match(created.body.profileNote, /old folder was left/);
    });
  }

  test(`second-account-asks-before-managing (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    const { home, transcript, bytes } = seedHome(service, provider);
    const first = await service.saveAccount({ provider, label: 'Personal' });
    await assert.rejects(service.saveAccount({ provider, label: 'Work' }), { code: 'manage-required', statusCode: 409 });
    assert.equal(fs.lstatSync(home).isDirectory(), true);
    assert.deepEqual(fs.readFileSync(transcript), bytes);
    await service.saveAccount({ provider, label: 'Work', manageProvider: true });
    assert.equal(store.listAccounts().length, 2);
    assert.equal(store.getSettings()[`${provider}Managed`], true);
    assert.equal(fs.lstatSync(home).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(home), store.getAccount(first.id).profileRef);
    assert.deepEqual(fs.readFileSync(transcript), bytes);
    assert.equal(fs.existsSync(service[`${provider}ShellEnvFile`]), true);
  });

  test(`second-account-asks-before-managing rollback (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    const { home, transcript, bytes } = seedHome(service, provider);
    const first = await service.saveAccount({ provider, label: 'Personal' });
    const create = service.createManagedProviderAccount.bind(service);
    service.createManagedProviderAccount = async () => { throw new Error('injected failure'); };
    await assert.rejects(service.saveAccount({ provider, label: 'Work', manageProvider: true }), /injected failure/);
    assert.equal(store.getSettings()[`${provider}Managed`], null);
    assert.equal(store.listAccounts().length, 1);
    assert.equal(store.getAccount(first.id).profileRef, home);
    assert.equal(fs.lstatSync(home).isDirectory(), true);
    assert.deepEqual(fs.readFileSync(transcript), bytes);
    assert.equal(fs.existsSync(service[`${provider}ShellEnvFile`]), false);
    service.createManagedProviderAccount = create;
  });

  test(`unmanage-with-one-account-${provider === 'claude' ? 'refuses-without-changes' : 'restores-real-home'} (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    const { home, transcript, bytes } = seedHome(service, provider);
    const first = await service.saveAccount({ provider, label: 'Personal' });
    const second = await service.saveAccount({ provider, label: 'Work', manageProvider: true });
    await assert.rejects(service.updateSettings({ [`${provider}Managed`]: false }), { statusCode: 409 });
    await service.deleteAccount(second.id);
    if (provider === 'claude') {
      const before = homeSnapshot(service.claudeProfilesDir);
      await assert.rejects(service.updateSettings({ claudeManaged: false }), { code: 'claude-unmanage-unavailable', statusCode: 409 });
      assert.equal(store.getSettings().claudeManaged, true);
      assert.equal(fs.lstatSync(home).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(home), store.getAccount(first.id).profileRef);
      assert.deepEqual(homeSnapshot(service.claudeProfilesDir), before);
      return;
    }
    await service.updateSettings({ [`${provider}Managed`]: false });
    assert.equal(store.getSettings()[`${provider}Managed`], false);
    assert.equal(fs.lstatSync(home).isDirectory(), true);
    assert.deepEqual(fs.readFileSync(transcript), bytes);
    assert.equal(store.getAccount(first.id).profileRef, home);
    assert.equal(fs.existsSync(service[`${provider}ShellEnvFile`]), false);
  });

  test(`existing-managed-install-stays-managed (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    const home = service[`${provider}ActiveLink`];
    const profile = path.join(service[`${provider}ProfilesDir`], 'personal');
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(home), { recursive: true });
    fs.symlinkSync(profile, home);
    const before = fs.lstatSync(home);
    service.initializeProviderManagement();
    assert.equal(store.getSettings()[`${provider}Managed`], true);
    assert.equal(fs.lstatSync(home).ino, before.ino);
    assert.equal(fs.realpathSync(home), profile);
  });
}

test('Codex legacy profile migration preserves inferred management', async (t) => {
  const { service, store, root } = fixture(t);
  const legacy = path.join(root, 'legacy-codex-profiles');
  const original = path.join(legacy, 'personal');
  fs.mkdirSync(original, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(service.codexActiveLink));
  fs.symlinkSync(original, service.codexActiveLink);
  const account = store.saveAccount({ provider: 'codex', label: 'Personal', profileRef: original, isDefault: true });
  service.codexLegacyProfilesDir = legacy;
  service.codexMigrationOptions = { isLegacyInUse: async () => false };
  service.logCodexMigration = () => {};
  assert.equal(store.getSettings().codexManaged, null);
  await service.migrateCodexProfilesDir();
  assert.equal(store.getSettings().codexManaged, true);
  assert.equal(service.providerProfileRef(store.getAccount(account.id)), path.join(service.codexProfilesDir, 'personal'));
});

test('Codex migration updates an existing terminal pin and retries a failed write at restart', async (t) => {
  const { service, store, root } = fixture(t);
  const legacy = path.join(root, 'legacy-codex-profiles');
  const original = path.join(legacy, 'personal');
  const destination = service.codexProfilesDir;
  fs.mkdirSync(original, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(service.codexActiveLink));
  fs.symlinkSync(original, service.codexActiveLink);
  const account = store.saveAccount({ provider: 'codex', label: 'Personal', profileRef: original, isDefault: true });
  service.codexLegacyProfilesDir = legacy;
  service.codexMigrationOptions = { isLegacyInUse: async () => true };
  service.logCodexMigration = () => {};
  // #693: a process holder no longer defers a same-volume move; only the
  // daemon's own in-flight work does. Hold the first attempt that way.
  service.codexActivationCount = 1;
  await service.migrateCodexProfilesDir();
  service.codexActivationCount = 0;
  assert.equal(fs.existsSync(original), true);
  await service.activateCodexProfile(original);
  const oldPin = fs.readFileSync(service.codexShellEnvFile, 'utf8');
  assert.ok(oldPin.includes(original));

  const restart = () => new ModelDeckService(store, {
    dataDir: service.dataDir,
    codexProfilesDir: destination, codexLegacyProfilesDir: legacy,
    codexActiveLink: service.codexActiveLink, codexShellEnvFile: service.codexShellEnvFile,
    claudeProfilesDir: service.claudeProfilesDir, claudeActiveLink: service.claudeActiveLink,
    codexMigrationOptions: { isLegacyInUse: async () => false }, logCodexMigration: () => {},
  });
  const failed = restart();
  failed.writeCodexShellEnvFile = async () => { throw new Error('injected terminal write failure'); };
  await failed.migrateCodexProfilesDir();
  assert.equal(failed.codexProfilesMigrationBlocked, true);
  assert.match(failed.codexProfilesMigrationWarning, /terminal environment/);
  assert.equal(fs.readFileSync(service.codexShellEnvFile, 'utf8'), oldPin);
  // The root moved; the old path is now the #693 alias onto the new root.
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(destination, 'personal')), true);

  const retried = restart();
  await retried.migrateCodexProfilesDir();
  assert.equal(retried.codexProfilesMigrationBlocked, false);
  const profile = store.getAccount(account.id).profileRef;
  assert.equal(profile, path.join(destination, 'personal'));
  const terminal = spawnSync('/bin/sh', ['-c', '. "$1"; printf "%s" "$CODEX_HOME"', 'fixture', retried.codexShellEnvFile], {
    env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(terminal.status, 0);
  assert.equal(terminal.stdout, profile);
  assert.equal(fs.statSync(retried.codexShellEnvFile).mode & 0o777, 0o600);
});

for (const provider of ['claude', 'codex']) {
  test(`management HTTP consent and Settings round-trip (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    seedHome(service, provider);
    const first = await api(service, store, 'POST', '/api/accounts', { provider, label: 'Personal' });
    assert.equal(first.status, 201);
    const denied = await api(service, store, 'POST', `/api/accounts/${first.body.account.id}/activate`);
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'not-managed');
    const second = await api(service, store, 'POST', '/api/accounts', { provider, label: 'Work' });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'manage-required');
    assert.equal((await api(service, store, 'PUT', '/api/settings', { [`${provider}Managed`]: true }, false)).status, 403);
    assert.equal((await api(service, store, 'PUT', '/api/settings', { [`${provider}Managed`]: true })).status, 200);
    const release = await api(service, store, 'PUT', '/api/settings', { [`${provider}Managed`]: false });
    assert.equal(release.status, provider === 'claude' ? 409 : 200);
    if (provider === 'claude') assert.equal(release.body.code, 'claude-unmanage-unavailable');
    assert.equal(store.getSettings()[`${provider}Managed`], provider === 'claude');
  });
}

for (const provider of ['claude', 'codex']) {
  for (const stage of ['move', 'shell', 'hook']) {
    test(`takeover rolls back a ${stage} failure (${provider})`, async (t) => {
      const { service, store } = fixture(t);
      const { home } = seedHome(service, provider);
      fs.chmodSync(home, 0o755);
      const before = homeSnapshot(home);
      const account = await service.saveAccount({ provider, label: 'Personal' });
      const method = stage === 'move' ? 'moveLegacyHome' : stage === 'hook' ? 'installProviderShellHook'
        : provider === 'claude' ? 'writeClaudeShellEnvFile' : 'writeCodexShellEnvFile';
      const original = service[method].bind(service);
      let calls = 0;
      service[method] = async (...args) => {
        if (++calls === 1) {
          if (stage === 'hook') await original(...args);
          throw new Error(`injected ${stage} failure`);
        }
        return original(...args);
      };
      await assert.rejects(service.saveAccount({ provider, label: 'Work', manageProvider: true }), /injected/);
      assert.equal(store.getSettings()[`${provider}Managed`], null);
      assert.equal(store.listAccounts().length, 1);
      assert.equal(store.getAccount(account.id).profileRef, home);
      assert.equal(fs.lstatSync(home).isDirectory(), true);
      assert.equal(fs.statSync(home).mode & 0o777, 0o755);
      assert.deepEqual(homeSnapshot(home), before);
      assert.equal(fs.existsSync(service[`${provider}ShellEnvFile`]), false);
      assert.equal(fs.existsSync(service.configLintZshenvPath), false);
    });
  }

  test(`takeover refuses concurrent account and Settings writes (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    seedHome(service, provider);
    const account = await service.saveAccount({ provider, label: 'Personal' });
    let started;
    let finish;
    const entered = new Promise((resolve) => { started = resolve; });
    const blocked = new Promise((resolve) => { finish = resolve; });
    const create = service.createManagedProviderAccount.bind(service);
    service.createManagedProviderAccount = async (...args) => { started(); await blocked; return create(...args); };
    const pending = service.saveAccount({ provider, label: 'Work', manageProvider: true });
    try {
      await entered;
      await assert.rejects(service.updateSettings({ [`${provider}Managed`]: false }), {
        code: provider === 'claude' ? 'claude-unmanage-unavailable' : 'management-in-progress', statusCode: 409,
      });
      await assert.rejects(service.deleteAccount(account.id), { code: 'management-in-progress', statusCode: 409 });
      await assert.rejects(service.activateAccount(account.id), { code: 'management-in-progress', statusCode: 409 });
      assert.ok((await service.state()).managementBlocked[provider]);
    } finally { finish(); await pending; }
  });

  test(`explicit false and foreign symlinks never become managed (${provider})`, async (t) => {
    const { service, store, root } = fixture(t);
    const home = service[`${provider}ActiveLink`];
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign); fs.mkdirSync(path.dirname(home)); fs.symlinkSync(foreign, home);
    service.initializeProviderManagement();
    assert.equal(store.getSettings()[`${provider}Managed`], null);
    fs.unlinkSync(home);
    const own = path.join(service[`${provider}ProfilesDir`], 'personal');
    fs.mkdirSync(own, { recursive: true }); fs.symlinkSync(own, home);
    store.saveSettings({ [`${provider}Managed`]: false });
    service.initializeProviderManagement();
    assert.equal(store.getSettings()[`${provider}Managed`], false);
    await assert.rejects(service.saveAccount({ provider, label: 'Personal' }), /real directory/);
  });
}

test('unmanaged Claude restore, adoption, and config writers refuse before writes', async (t) => {
  const { service } = fixture(t);
  const { home } = seedHome(service, 'claude');
  const before = homeSnapshot(home);
  const account = await service.createClaudeAccount({ label: 'Personal' });
  for (const operation of [
    () => service.adoptClaudeLegacyHome(account.id),
    () => service.restoreClaudeActivation({ state: 'unlinked' }),
    () => service.restoreClaudeScopePins({ shellPin: null }),
    () => service.scopeClaudeSecureStorage(home),
    () => service.writeClaudeProfileSettings(path.join(home, 'settings.json'), '{}'),
    () => service.installClaudeStatusline(account.id),
    () => service.performClaudeFlipRenewal(account, new Date().toISOString()),
    () => service.importClaudeSwapProfiles([]),
  ]) await assert.rejects(operation, { code: 'not-managed', statusCode: 409 });
  assert.equal(await service.claudeRenewalConfigDir(home), home);
  assert.deepEqual(homeSnapshot(home), before);
});

test('Codex activation holds off unmanage until its shell write finishes', async (t) => {
  const { service, store } = fixture(t);
  seedHome(service, 'codex');
  const account = await service.createCodexAccount({ label: 'Personal' });
  await service.updateSettings({ codexManaged: true });
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const write = service.writeCodexShellEnvFile.bind(service);
  service.writeCodexShellEnvFile = async (...args) => { entered(); await waiting; return write(...args); };
  const activating = service.activateAccount(account.id);
  try {
    await started;
    await assert.rejects(service.updateSettings({ codexManaged: false }), { code: 'management-in-progress', statusCode: 409 });
    assert.equal(store.getSettings().codexManaged, true);
  } finally { release(); await activating; }
  await service.updateSettings({ codexManaged: false });
  assert.equal(fs.existsSync(service.codexShellEnvFile), false);
});

test('Codex plan refresh cannot restore a profile path moved by unmanage', async (t) => {
  const { service, store } = fixture(t);
  const { home } = seedHome(service, 'codex');
  const account = await service.createCodexAccount({ label: 'Personal' });
  await service.updateSettings({ codexManaged: true });
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  service.readCodexPlan = async () => { entered(); await waiting; return { planType: 'plus' }; };
  const refreshing = service.refreshCodexPlanTier(store.getAccount(account.id));
  try {
    await started;
    await service.updateSettings({ codexManaged: false });
  } finally { release(); await refreshing; }
  assert.equal(store.getAccount(account.id).profileRef, home);
  assert.equal(service.providerProfileRef(store.getAccount(account.id)), home);
});

for (const provider of ['claude', 'codex']) {
  test(`takeover rollback preserves terminal file permissions (${provider})`, async (t) => {
    const { service } = fixture(t);
    seedHome(service, provider);
    await service.saveAccount({ provider, label: 'Personal' });
    const files = [service.configLintZshenvPath, service[`${provider}ShellEnvFile`]];
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# placeholder original\n', { mode: 0o640 });
    }
    service.createManagedProviderAccount = async () => { throw new Error('injected creation failure'); };
    await assert.rejects(service.saveAccount({ provider, label: 'Work', manageProvider: true }), /injected creation failure/);
    for (const file of files) {
      assert.equal(fs.readFileSync(file, 'utf8'), '# placeholder original\n');
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    }
  });
}

test('unreadable launchd pins refuse takeover before any home or environment write', async (t) => {
  let writes = 0;
  const { service, store } = fixture(t, { platform: 'darwin', exec: async (binary, args) => {
    if (binary === '/bin/launchctl') {
      if (args[0] === 'getenv') throw new Error('injected capture failure');
      writes += 1;
    }
    return { stdout: '2.2.0' };
  } });
  const { home } = seedHome(service, 'claude');
  const before = homeSnapshot(home);
  await service.createClaudeAccount({ label: 'Personal' });
  await assert.rejects(service.createClaudeAccount({ label: 'Work', manageProvider: true }), /environment.*read|read.*environment/i);
  assert.equal(writes, 0);
  assert.equal(store.getSettings().claudeManaged, null);
  assert.equal(fs.lstatSync(home).isDirectory(), true);
  assert.deepEqual(homeSnapshot(home), before);
  assert.equal(fs.existsSync(service.claudeProfilesDir), false);
  assert.equal(fs.existsSync(service.claudeShellEnvFile), false);
});

for (const provider of ['claude', 'codex']) {
  test(`verification preserves the profile when unmanage ${provider === 'claude' ? 'refuses' : 'moves it'} (${provider})`, async (t) => {
    const { service, store } = fixture(t);
    const { home } = seedHome(service, provider);
    const account = await service.saveAccount({ provider, label: 'Personal' });
    await service.updateSettings({ [`${provider}Managed`]: true });
    const managedProfile = store.getAccount(account.id).profileRef;
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    service[provider === 'claude' ? 'readClaudeAuth' : 'readCodexAuth'] = async () => {
      entered(); await waiting;
      return { authenticated: true, identity: 'person@example.invalid' };
    };
    const verifying = service.verifyAccount(account.id).catch((error) => error);
    try {
      await started;
      if (provider === 'claude') {
        await assert.rejects(service.updateSettings({ claudeManaged: false }), { code: 'claude-unmanage-unavailable', statusCode: 409 });
      } else await service.updateSettings({ codexManaged: false });
    }
    finally { release(); }
    const result = await verifying;
    if (provider === 'claude') assert.equal(result.authenticated, true);
    else assert.equal(result.code, 'management-in-progress');
    assert.equal(store.getAccount(account.id).profileRef, provider === 'claude' ? managedProfile : home);
  });
}

test('Claude unmanage refusal preserves the profile during metadata identity lookup', async (t) => {
  const { service, store } = fixture(t);
  const { home } = seedHome(service, 'claude');
  const account = await service.createClaudeAccount({ label: 'Personal' });
  await service.updateSettings({ claudeManaged: true });
  const managedProfile = store.getAccount(account.id).profileRef;
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  service.readClaudeIdentity = async () => ({ identity: 'person@example.invalid' });
  service.claudeIdentitySeedSource = async () => { entered(); await waiting; return 'fixture'; };
  const refreshing = service.refreshClaudeProfileMetadata(store.getAccount(account.id));
  try {
    await started;
    await assert.rejects(service.updateSettings({ claudeManaged: false }), { code: 'claude-unmanage-unavailable', statusCode: 409 });
  }
  finally { release(); await refreshing; }
  assert.equal(store.getAccount(account.id).profileRef, managedProfile);
  assert.equal(fs.realpathSync(home), managedProfile);
});

test('moving a Claude home requires identity verification before quota or renewal', async (t) => {
  let probes = 0;
  const { service, store } = fixture(t, {
    platform: 'darwin',
    fetchClaude: async () => { probes += 1; return [{ scope: 'weekly', usedPercent: 12, source: 'fixture' }]; },
  });
  seedHome(service, 'claude');
  const account = await service.createClaudeAccount({ label: 'Personal', identity: 'person@example.invalid' });
  for (const managed of [true]) {
    await service.updateSettings({ claudeManaged: managed });
    assert.equal(await service.accountAuthState(store.getAccount(account.id)), 'signin-required');
    assert.equal(service.signinReason(store.getAccount(account.id), 'signin-required'), 'missing');
    assert.equal((await service.refreshClaude())[0].ok, false);
    assert.equal((await service.refreshClaudeAccount(account.id)).ok, false);
    assert.equal(probes, 0);
    assert.equal((await service.renewClaudeAccount(account.id)).outcome, 'signin-required');
    service.readClaudeAuth = async () => ({ authenticated: true, identity: 'other@example.invalid' });
    assert.ok((await service.verifyAccount(account.id)).identityMismatch);
    assert.equal((await service.refreshClaudeAccount(account.id)).ok, false);
    assert.equal(probes, 0);
    service.readClaudeAuth = async () => ({ authenticated: true });
    assert.equal((await service.verifyAccount(account.id)).authenticated, false);
    await service.saveAccount({ ...store.getAccount(account.id), metadata: {} });
    assert.equal(store.getAccount(account.id).metadata.claudeHomeNeedsVerification, true);
    service.readClaudeAuth = async () => ({ authenticated: true, identity: 'person@example.invalid' });
    assert.equal((await service.verifyAccount(account.id)).authenticated, true);
    assert.equal(store.getAccount(account.id).metadata.claudeHomeNeedsVerification, undefined);
  }
  assert.equal((await service.refreshClaudeAccount(account.id)).ok, true);
  assert.equal(probes, 1);
});

// Config identity cannot prove which Keychain login a moved Claude home uses.
// Tim's decision on #648 refuses this transition before any state changes.
test('claude-unmanage-unavailable refuses before moving home or changing settings', async (t) => {
  const { service, store, root } = fixture(t, { platform: 'darwin' });
  const { home } = seedHome(service, 'claude');
  await service.createClaudeAccount({ label: 'Personal', identity: 'person@example.invalid' });
  await service.updateSettings({ claudeManaged: true });
  const before = homeSnapshot(root);
  const accounts = store.listAccounts();
  const settings = store.getSettings();
  let moves = 0;
  let environmentWrites = 0;
  service.moveLegacyHome = async () => { moves += 1; throw new Error('unexpected home move'); };
  service.exec = async () => { environmentWrites += 1; throw new Error('unexpected environment write'); };
  const message = 'Turning off account switching for Claude is not available yet. Your accounts and history are unchanged.';

  for (const sharedUserScopeEnabled of [false, true]) {
    store.saveSettings({ sharedUserScopeEnabled });
    const response = await api(service, store, 'PUT', '/api/settings', { claudeManaged: false });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'claude-unmanage-unavailable');
    assert.equal(response.body.error, message);
    assert.deepEqual(store.getSettings(), { ...settings, sharedUserScopeEnabled });
    assert.deepEqual(store.listAccounts(), accounts);
    assert.deepEqual(homeSnapshot(root), before);
  }
  await assert.rejects(service.releaseProviderHome('claude'), {
    code: 'claude-unmanage-unavailable', statusCode: 409, message,
  });
  assert.equal(service.providerManagementBlocked().claude, message);
  assert.equal(fs.lstatSync(home).isSymbolicLink(), true);
  assert.equal(moves, 0);
  assert.equal(environmentWrites, 0);
});
