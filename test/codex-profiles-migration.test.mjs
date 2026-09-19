import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';
import { legacyCodexProfilesInUse } from '../src/codex-profiles-migration.mjs';
import { collectConfigLintSnapshot, configLintSnapshotOptions } from '../src/config-linter-snapshot.mjs';
import { evaluateConfigLint } from '../src/config-linter.mjs';

function fixture(t, migrationOptions = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-647-')));
  const legacyDir = path.join(root, '.codex-profiles');
  const dataDir = path.join(root, 'data');
  const profilesDir = path.join(dataDir, 'codex-profiles');
  const activeLink = path.join(root, '.codex');
  for (const name of ['first', 'second']) {
    const home = path.join(legacyDir, name);
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'auth.json'), `dummy-auth-${name}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'sessions', 'dummy.jsonl'), 'dummy-session\n', { mode: 0o600 });
  }
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.symlinkSync('.codex-profiles/first', activeLink);
  const store = new Store(':memory:');
  const account = store.saveAccount({
    provider: 'codex', label: 'Dummy first', profileRef: path.join(legacyDir, 'first'), isDefault: true,
  });
  const logs = [];
  const service = new ModelDeckService(store, {
    dataDir, codexProfilesDir: profilesDir, codexLegacyProfilesDir: legacyDir,
    codexActiveLink: activeLink,
    claudeProfilesDir: path.join(dataDir, 'claude-profiles'),
    claudeActiveLink: path.join(root, '.claude'),
    codexMigrationOptions: { now: () => new Date('2026-09-11T20:00:00.000Z'), isLegacyInUse: async () => false, ...migrationOptions },
    logCodexMigration: (message) => logs.push(message),
  });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, legacyDir, dataDir, profilesDir, activeLink, store, account, service, logs };
}

// Exercise the real startup callback and HTTP handler without binding a socket.
async function startup(data) {
  const app = createApp({ store: data.store, service: data.service, mutationToken: 'dummy-token' });
  const starts = [];
  for (const method of ['startAutoRefresh', 'startUsageSnapshotRetention', 'startUsageQueueConsumer', 'startConfigLint', 'startWarehouseIngest']) {
    data.service[method] = () => {
      starts.push(method);
      assert.equal(fs.existsSync(data.account.profileRef), Boolean(data.service.codexProfilesMigrationWarning));
    };
  }
  app.server.listen = (_port, _host, ready) => { ready(); return app.server; };
  await new Promise((resolve) => app.listen(resolve));
  return { app, starts };
}

async function health(app) {
  return new Promise((resolve) => {
    app.server.emit('request', {
      method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:3867' },
      socket: { remoteAddress: '127.0.0.1' },
    }, { writeHead() {}, end: (body) => resolve(JSON.parse(body)) });
  });
}

test('codex-profiles-migration-startup-moves-verifies-and-repoints', async (t) => {
  const data = fixture(t);
  const { app, starts } = await startup(data);
  assert.equal(starts.length, 5);
  for (const name of ['first', 'second']) {
    assert.equal(fs.readFileSync(path.join(data.profilesDir, name, 'auth.json'), 'utf8'), `dummy-auth-${name}\n`);
    assert.equal(fs.readFileSync(path.join(data.profilesDir, name, 'sessions', 'dummy.jsonl'), 'utf8'), 'dummy-session\n');
  }
  assert.equal(data.store.getAccount(data.account.id).profileRef, path.join(data.profilesDir, 'first'));
  assert.equal(fs.realpathSync(data.activeLink), path.join(data.profilesDir, 'first'));
  const marker = JSON.parse(fs.readFileSync(path.join(data.profilesDir, '.migrated-from'), 'utf8'));
  assert.equal(marker.legacyDir, data.legacyDir);
  assert.ok(Number.isFinite(Date.parse(marker.migratedAt)));
  assert.deepEqual(fs.readdirSync(data.legacyDir), []);
  assert.equal((await health(app)).warning, undefined);
});

test('codex-profiles-path-default-and-env-override', () => {
  for (const override of ['', '/dummy/custom-codex']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { CODEX_PROFILES_DIR } from './src/paths.mjs'; console.log(CODEX_PROFILES_DIR)"], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, MODELDECK_DATA_DIR: '/dummy/data', MODELDECK_CODEX_PROFILES_DIR: override },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), override || '/dummy/data/codex-profiles');
  }
});

test('codex-profiles-migration-running-process-refuses-with-health-warning', async (t) => {
  const data = fixture(t, { isLegacyInUse: async () => true });
  const before = data.store.listAccounts();
  const { app } = await startup(data);
  assert.deepEqual(data.store.listAccounts(), before);
  assert.deepEqual(fs.readdirSync(data.dataDir), []);
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
  assert.equal(fs.readlinkSync(data.activeLink), '.codex-profiles/first');
  assert.match((await health(app)).warning, /running processes/);
  assert.equal(data.logs.length, 1);
});

test('codex-profiles-migration-second-rename-rolls-back-first-profile', async (t) => {
  const data = fixture(t);
  const before = data.store.listAccounts();
  data.service.codexMigrationOptions.io = { ...fs.promises, rename: async (from, to) => {
    if (from === path.join(data.legacyDir, 'second')) throw new Error('injected second rename failure');
    return fs.promises.rename(from, to);
  } };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.blocked, false);
  assert.deepEqual(data.store.listAccounts(), before);
  for (const name of ['first', 'second']) {
    assert.equal(fs.readFileSync(path.join(data.legacyDir, name, 'auth.json'), 'utf8'), `dummy-auth-${name}\n`);
  }
  assert.equal(fs.existsSync(data.profilesDir), false);
  assert.equal(fs.readlinkSync(data.activeLink), '.codex-profiles/first');
  assert.match(result.warning, /moving and verifying/);
});

test('codex-profiles-migration-EXDEV-verifies-bytes-and-preserves-modes', async (t) => {
  const data = fixture(t);
  data.service.codexMigrationOptions.io = { ...fs.promises, rename: async (from, to) => {
    if (path.dirname(from) === data.legacyDir) throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' });
    return fs.promises.rename(from, to);
  } };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.migrated, true);
  assert.deepEqual(fs.readdirSync(data.legacyDir), []);
  for (const root of [data.profilesDir, path.join(result.backupDir, 'profiles')]) {
    for (const name of ['first', 'second']) {
      assert.equal(fs.readFileSync(path.join(root, name, 'auth.json'), 'utf8'), `dummy-auth-${name}\n`);
      assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(root, name, 'auth.json')).mode & 0o777, 0o600);
    }
  }
  assert.equal(fs.statSync(result.backupDir).mode & 0o777, 0o700);
  const restore = JSON.parse(fs.readFileSync(path.join(result.backupDir, 'restore.json'), 'utf8'));
  assert.equal(restore.accountMoves[0].from, data.account.profileRef);
});

test('codex-profiles-migration-EXDEV-corrupt-copy-never-removes-source', async (t) => {
  const data = fixture(t);
  data.service.codexMigrationOptions.io = {
    ...fs.promises,
    rename: async (from, to) => {
      if (path.dirname(from) === data.legacyDir) throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' });
      return fs.promises.rename(from, to);
    },
    cp: async (from, to, options) => {
      await fs.promises.cp(from, to, options);
      if (path.dirname(to) === data.profilesDir) {
        // Same length: size-only verification would lose the original bytes.
        await fs.promises.writeFile(path.join(to, 'auth.json'), 'wrong-auth-first\n');
      }
    },
  };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.blocked, false);
  assert.equal(fs.readFileSync(path.join(data.legacyDir, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
  assert.equal(fs.existsSync(data.profilesDir), false);
});

test('codex-profiles-migration-database-failure-restores-link-files-and-all-references', async (t) => {
  const data = fixture(t);
  data.store.saveAccount({ provider: 'codex', label: 'Dummy second', profileRef: path.join(data.legacyDir, 'second') });
  const before = data.store.listAccounts();
  data.store.db.exec(`CREATE TRIGGER abort_migration BEFORE UPDATE OF profile_ref ON accounts
    WHEN OLD.label = 'Dummy second' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.blocked, false);
  assert.deepEqual(data.store.listAccounts(), before);
  assert.equal(fs.readlinkSync(data.activeLink), '.codex-profiles/first');
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
  assert.equal(fs.existsSync(data.profilesDir), false);
  assert.match(result.warning, /publishing account/);
});

test('codex-profiles-migration-marker-failure-restores-active-link', async (t) => {
  const data = fixture(t);
  data.service.codexMigrationOptions.io = { ...fs.promises, open: async (file, flags, mode) => {
    if (path.basename(file) === '.migrated-from') throw new Error('injected marker failure');
    return fs.promises.open(file, flags, mode);
  } };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.blocked, false);
  assert.equal(fs.readlinkSync(data.activeLink), '.codex-profiles/first');
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
});

test('codex-profiles-migration-active-link-failure-keeps-store-untouched', async (t) => {
  const data = fixture(t);
  data.service.codexMigrationOptions.io = { ...fs.promises, rename: async (from, to) => {
    if (to === data.activeLink) throw new Error('injected active link failure');
    return fs.promises.rename(from, to);
  } };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.blocked, false);
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
  assert.equal(fs.readlinkSync(data.activeLink), '.codex-profiles/first');
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
});

test('codex-profiles-migration-preserves-symlinks-without-following-external-targets', async (t) => {
  const data = fixture(t);
  const external = path.join(data.root, 'external');
  fs.mkdirSync(external, { mode: 0o700 });
  fs.writeFileSync(path.join(external, 'untouched'), 'dummy-external\n');
  fs.symlinkSync(external, path.join(data.legacyDir, 'first', 'shared'));
  fs.symlinkSync('../second', path.join(data.legacyDir, 'first', 'relative'));
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.migrated, true);
  assert.equal(fs.readlinkSync(path.join(data.profilesDir, 'first', 'shared')), external);
  assert.equal(fs.realpathSync(path.join(data.profilesDir, 'first', 'relative')), path.join(data.profilesDir, 'second'));
  assert.deepEqual(fs.readdirSync(external), ['untouched']);
});

test('codex-profiles-migration-populated-destination-never-merges-or-overwrites', async (t) => {
  const data = fixture(t);
  fs.mkdirSync(data.profilesDir, { mode: 0o700 });
  fs.writeFileSync(path.join(data.profilesDir, 'keep'), 'dummy-keep\n');
  const before = data.store.listAccounts();
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.deepEqual(data.store.listAccounts(), before);
  assert.equal(fs.readFileSync(path.join(data.profilesDir, 'keep'), 'utf8'), 'dummy-keep\n');
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
});

function processInspection(processes, { openFiles = '', psError, psOutput, environmentOnly = false } = {}) {
  return async (bin, args) => {
    if (bin === '/usr/bin/pgrep') {
      assert.deepEqual(args, ['-x', 'codex']);
      return { stdout: processes.map((_, index) => String(index + 1)).join('\n'), stderr: '' };
    }
    if (bin === '/bin/ps') {
      const environment = args.includes('-E');
      if (!environmentOnly || environment) {
        if (psError) throw psError;
        if (psOutput !== undefined) return { stdout: psOutput, stderr: '' };
      }
      const process = processes[Number(args.at(-1)) - 1];
      assert.deepEqual(args, environment
        ? ['-ww', '-E', '-o', 'command=', '-p', args.at(-1)]
        : ['-ww', '-o', 'comm=', '-p', args.at(-1)]);
      return { stdout: `${environment ? process.command : process.executable}\n`, stderr: '' };
    }
    assert.equal(bin, '/usr/sbin/lsof');
    if (openFiles) return { stdout: openFiles, stderr: '' };
    throw { code: 1, stdout: '', stderr: '' };
  };
}

const chatgptCodex = {
  executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
  command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://',
};

test('codex-profiles-migration-chatgpt-only-proceeds-without-health-warning', async (t) => {
  const exec = processInspection(Array(4).fill(chatgptCodex));
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', exec), false);
  const data = fixture(t, { isLegacyInUse: (legacyDir) => legacyCodexProfilesInUse(legacyDir, exec) });
  const { app } = await startup(data);
  assert.equal((await health(app)).warning, undefined);
  assert.equal(fs.readlinkSync(data.activeLink), path.join(data.profilesDir, 'first'));
});

test('codex-profiles-migration-real-cli-defers', async () => {
  for (const executable of ['/opt/homebrew/bin/codex', '/Users/dummy/.npm/bin/codex']) {
    assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', processInspection([
      { executable, command: `${executable} exec dummy` },
    ])), true);
  }
});

test('codex-profiles-migration-chatgpt-and-cli-defers', async () => {
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', processInspection([
    chatgptCodex, { executable: '/opt/homebrew/bin/codex', command: '/opt/homebrew/bin/codex exec dummy' },
  ])), true);
});

test('codex-profiles-migration-bundled-codex-sibling-path-does-not-defer', async () => {
  for (const command of [
    `${chatgptCodex.command} CODEX_HOME=/dummy/legacy-backup/first`,
    `${chatgptCodex.command} CODEX_HOME=/dummy/legacyold`,
  ]) {
    assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', processInspection([
      { ...chatgptCodex, command },
    ])), false);
  }
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', processInspection([
    { ...chatgptCodex, command: `${chatgptCodex.command} CODEX_HOME=/dummy/legacy` },
  ])), true);
});

test('codex-profiles-migration-bundled-codex-legacy-references-still-defer', async () => {
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', processInspection([
    { ...chatgptCodex, command: `${chatgptCodex.command} CODEX_HOME=/dummy/legacy/first` },
  ])), true);
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', processInspection([
    chatgptCodex,
  ], { openFiles: 'p1\n' })), true);
  const executable = '/Applications/Dummy App.app/Contents/Frameworks/Helper.framework/codex';
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', processInspection([
    { executable, command: `${executable} app-server` },
  ])), false);
});

test('codex-profiles-migration-ps-errors-and-garbage-fail-closed', async () => {
  for (const options of [
    { psError: { code: 1, stdout: '', stderr: '' } },
    { psError: { code: 'ENOENT' } },
    { psOutput: 'garbage' },
    { psOutput: '' },
    { psOutput: `${chatgptCodex.executable}\ngarbage` },
  ]) {
    for (const environmentOnly of [false, true]) {
      await assert.rejects(legacyCodexProfilesInUse('/dummy/legacy', processInspection([chatgptCodex], {
        ...options, environmentOnly,
      })), /process inspection unavailable/);
    }
  }
});

test('codex-profiles-migration-lsof-errors-and-ambiguous-results-fail-closed', async () => {
  const noMatch = () => { throw { code: 1, stdout: '', stderr: '' }; };
  const idle = async (bin, args) => {
    if (bin === '/usr/bin/pgrep') { assert.deepEqual(args, ['-x', 'codex']); noMatch(); }
    assert.equal(bin, '/usr/sbin/lsof');
    assert.deepEqual(args, ['-n', '-P', '-F', 'p', '+D', '/dummy/legacy']);
    noMatch();
  };
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', idle), false);
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', async (bin) => {
    if (bin === '/usr/bin/pgrep') noMatch();
    return { stdout: 'p123\n', stderr: '' };
  }), true);
  // A running codex process with no file open under the legacy root (a
  // CODEX_HOME pinned by environment, cwd elsewhere) still defers the move.
  assert.equal(await legacyCodexProfilesInUse('/dummy/legacy', async (bin) => {
    if (bin === '/usr/bin/pgrep') return { stdout: '4242\n', stderr: '' };
    if (bin === '/bin/ps') return { stdout: '/opt/homebrew/bin/codex\n', stderr: '' };
    noMatch();
  }), true);
  for (const exec of [
    async () => { throw { code: 'ENOENT' }; },
    async (bin) => { if (bin === '/usr/bin/pgrep') noMatch(); throw { code: 1, stderr: 'incomplete inspection' }; },
    async (bin) => { if (bin === '/usr/bin/pgrep') noMatch(); throw { code: 1, signal: 'SIGTERM', killed: true }; },
    async (bin) => { if (bin === '/usr/bin/pgrep') noMatch(); return { stdout: '', stderr: '' }; },
    async (bin) => { if (bin === '/usr/bin/pgrep') return { stdout: 'garbage', stderr: '' }; noMatch(); },
  ]) await assert.rejects(legacyCodexProfilesInUse('/dummy/legacy', exec));
});

test('codex-profiles-migration-MD-L04-flags-legacy-active-link-after-migration', async (t) => {
  const data = fixture(t);
  assert.equal((await data.service.migrateCodexProfilesDir()).migrated, true);
  fs.unlinkSync(data.activeLink);
  fs.symlinkSync(path.join(data.legacyDir, 'first'), data.activeLink);
  const snapshot = await collectConfigLintSnapshot({
    ...configLintSnapshotOptions(data.service), runtimeEnv: { PATH: '' },
    readLaunchd: async () => ({ exitCode: 3, output: '' }),
  });
  const findings = evaluateConfigLint(snapshot).filter((finding) => finding.ruleId === 'MD-L04');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scope, 'machine:codex');
  assert.equal(findings[0].severity, 'error');
});

test('codex-profiles-migration-corrupt-renamed-tree-recovers-from-verified-backup', async (t) => {
  const data = fixture(t);
  data.service.codexMigrationOptions.io = { ...fs.promises, rename: async (from, to) => {
    await fs.promises.rename(from, to);
    if (from === path.join(data.legacyDir, 'first')) await fs.promises.writeFile(path.join(to, 'auth.json'), 'wrong-auth-first\n');
  } };
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.equal(fs.readFileSync(path.join(data.legacyDir, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
  assert.equal(fs.realpathSync(data.activeLink), data.account.profileRef);
});

test('codex-profiles-migration-incomplete-rollback-stays-blocked-on-restart', async (t) => {
  const data = fixture(t);
  data.service.codexMigrationOptions.io = { ...fs.promises, rename: async (from, to) => {
    if (from === path.join(data.legacyDir, 'second') || from === path.join(data.profilesDir, 'first')) {
      throw new Error('injected forward/reverse failure');
    }
    return fs.promises.rename(from, to);
  } };
  assert.equal((await data.service.migrateCodexProfilesDir()).blocked, true);
  data.service.codexProfilesMigrationPromise = null;
  data.service.codexMigrationOptions.io = fs.promises;
  const { app, starts } = await startup(data);
  assert.equal(starts.length, 0);
  assert.equal(data.service.codexProfilesMigrationBlocked, true);
  assert.match((await health(app)).warning, /blocked/);
});

test('codex-profiles-migration-deferred-accounts-remain-usable-and-retryable', async (t) => {
  const data = fixture(t, { isLegacyInUse: async () => true });
  await data.service.migrateCodexProfilesDir();
  assert.equal(data.service.codexProfilesDir, data.legacyDir);
  const spec = await data.service.loginSpec(data.account.id);
  assert.equal(spec.env.CODEX_HOME, data.account.profileRef);
  data.service.requireProviderCli = async () => {};
  const added = await data.service.createCodexAccount({ label: 'Dummy third' });
  assert.equal(path.dirname(added.profileRef), data.legacyDir);
  assert.equal(fs.existsSync(data.profilesDir), false);
  const restarted = new ModelDeckService(data.store, {
    dataDir: data.dataDir, codexProfilesDir: data.profilesDir,
    codexLegacyProfilesDir: data.legacyDir, codexActiveLink: data.activeLink,
    codexMigrationOptions: { now: () => new Date('2026-09-11T20:00:00.000Z'), isLegacyInUse: async () => false },
    logCodexMigration: () => {},
  });
  assert.equal((await restarted.migrateCodexProfilesDir()).migrated, true);
  assert.equal(data.store.getAccount(added.id).profileRef, path.join(data.profilesDir, 'dummy-third'));
});

test('codex-profiles-migration-destination-symlink-swap-never-writes-outside-root', async (t) => {
  const data = fixture(t);
  fs.mkdirSync(data.profilesDir, { mode: 0o700 });
  const external = path.join(data.root, 'outside');
  fs.mkdirSync(external, { mode: 0o700 });
  let checks = 0;
  data.service.codexMigrationOptions.isLegacyInUse = async () => {
    if (++checks === 2) {
      fs.rmdirSync(data.profilesDir);
      fs.symlinkSync(external, data.profilesDir);
    }
    return false;
  };
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.deepEqual(fs.readdirSync(external), []);
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
});

test('codex-profiles-migration-custom-root-and-all-registered-accounts', async (t) => {
  const data = fixture(t);
  const custom = path.join(data.root, 'custom-codex-profiles');
  data.service.codexProfilesDir = custom;
  const second = data.store.saveAccount({ provider: 'codex', label: 'Dummy second', profileRef: path.join(data.legacyDir, 'second') });
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.migrated, true);
  for (const account of [data.account, second]) {
    assert.equal(data.store.getAccount(account.id).profileRef, path.join(custom, path.basename(account.profileRef)));
  }
  assert.equal(fs.realpathSync(data.activeLink), path.join(custom, 'first'));
});

test('codex-profiles-migration-late-destination-swap-restores-from-backup-without-following-link', async (t) => {
  const data = fixture(t);
  const external = path.join(data.root, 'outside');
  fs.mkdirSync(external, { mode: 0o700 });
  let checks = 0;
  data.service.codexMigrationOptions.isLegacyInUse = async () => {
    if (++checks === 4) {
      fs.renameSync(data.profilesDir, path.join(data.root, 'displaced-destination'));
      fs.symlinkSync(external, data.profilesDir);
    }
    return false;
  };
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.deepEqual(fs.readdirSync(external), []);
  assert.equal(fs.readFileSync(path.join(data.legacyDir, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
  assert.equal(fs.realpathSync(data.activeLink), data.account.profileRef);
});

test('codex-profiles-migration-EXDEV-partial-source-removal-rolls-back', async (t) => {
  const data = fixture(t);
  let failed = false;
  data.service.codexMigrationOptions.io = {
    ...fs.promises,
    rename: async (from, to) => {
      if ((path.dirname(from) === data.legacyDir && path.dirname(to) === data.profilesDir)
          || (path.dirname(from) === data.profilesDir && path.dirname(to) === data.legacyDir)) {
        throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' });
      }
      return fs.promises.rename(from, to);
    },
    rm: async (file, options) => {
      if (!failed && file === path.join(data.legacyDir, 'first')) {
        failed = true;
        await fs.promises.unlink(path.join(file, 'auth.json'));
        throw new Error('dummy-private-error-never-log');
      }
      return fs.promises.rm(file, options);
    },
  };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.blocked, false);
  assert.equal(fs.readFileSync(path.join(data.legacyDir, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
  assert.equal(fs.existsSync(data.profilesDir), false);
  assert.doesNotMatch(JSON.stringify(data.logs), /dummy-private-error/);
});

test('codex-profiles-migration-empty-destination-and-completed-start-are-idempotent', async (t) => {
  const data = fixture(t);
  fs.mkdirSync(data.profilesDir, { mode: 0o700 });
  fs.writeFileSync(path.join(data.legacyDir, '.DS_Store'), 'dummy-metadata', { mode: 0o600 });
  const inode = fs.statSync(path.join(data.legacyDir, 'first', 'auth.json')).ino;
  assert.equal((await data.service.migrateCodexProfilesDir()).migrated, true);
  assert.equal(fs.statSync(path.join(data.profilesDir, 'first', 'auth.json')).ino, inode);
  assert.equal(fs.readFileSync(path.join(data.profilesDir, '.DS_Store'), 'utf8'), 'dummy-metadata');
  const before = data.store.listAccounts();
  const marker = fs.readFileSync(path.join(data.profilesDir, '.migrated-from'), 'utf8');
  const contents = fs.readdirSync(data.dataDir);
  data.service.codexProfilesMigrationPromise = null;
  assert.deepEqual(await data.service.migrateCodexProfilesDir(), {});
  assert.equal(fs.readFileSync(path.join(data.profilesDir, '.migrated-from'), 'utf8'), marker);
  assert.deepEqual(data.store.listAccounts(), before);
  assert.deepEqual(fs.readdirSync(data.dataDir), contents);
});

test('codex-profiles-migration-refuses-symlinks-that-would-change-meaning', async (t) => {
  for (const target of ['/dummy/unused', '../../outside']) {
    const data = fixture(t);
    const actualTarget = target === '/dummy/unused' ? path.join(data.legacyDir, 'second') : target;
    fs.symlinkSync(actualTarget, path.join(data.legacyDir, 'first', 'unsafe-link'));
    const result = await data.service.migrateCodexProfilesDir();
    assert.ok(result.warning);
    assert.deepEqual(fs.readdirSync(data.dataDir), []);
    assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
  }
});

test('codex-profiles-migration-marker-collision-preserves-unowned-file', async (t) => {
  const data = fixture(t);
  data.service.codexMigrationOptions.io = { ...fs.promises, open: async (file, flags, mode) => {
    if (path.basename(file) === '.migrated-from') await fs.promises.writeFile(file, 'dummy-existing-marker', { mode: 0o600 });
    return fs.promises.open(file, flags, mode);
  } };
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.equal(fs.readFileSync(path.join(data.profilesDir, '.migrated-from'), 'utf8'), 'dummy-existing-marker');
  assert.equal(fs.realpathSync(data.activeLink), data.account.profileRef);
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
});
