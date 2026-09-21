import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';
import { legacyCodexProfilesInUse, legacyCodexProfilesUsage } from '../src/codex-profiles-migration.mjs';
import { collectConfigLintSnapshot, configLintSnapshotOptions } from '../src/config-linter-snapshot.mjs';
import { evaluateConfigLint } from '../src/config-linter.mjs';

function fixture(t, migrationOptions = {}, serviceOptions = {}, { sameVolume = false, shortRoot = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(shortRoot ? '/tmp/md693-' : path.join(os.tmpdir(), 'modeldeck-647-')));
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
  // The original 41 tests retain the idle-only copy contract on another device.
  const io = { ...fs.promises, lstat: async (file) => {
    const stat = await fs.promises.lstat(file);
    if (!sameVolume && file === path.dirname(profilesDir)) stat.dev += 1;
    return stat;
  } };
  const logs = [];
  const service = new ModelDeckService(store, {
    dataDir, codexProfilesDir: profilesDir, codexLegacyProfilesDir: legacyDir,
    codexActiveLink: activeLink,
    claudeProfilesDir: path.join(dataDir, 'claude-profiles'),
    claudeActiveLink: path.join(root, '.claude'),
    codexMigrationOptions: { io, now: () => new Date('2026-09-11T20:00:00.000Z'), isLegacyInUse: async () => false, ...migrationOptions },
    logCodexMigration: (message) => logs.push(message),
    ...serviceOptions,
  });
  t.after(async () => { await service.stopCodexProfilesMigration?.(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
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
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io, rename: async (from, to) => {
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
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io, rename: async (from, to) => {
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
    ...data.service.codexMigrationOptions.io,
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
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io, open: async (file, flags, mode) => {
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
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io, rename: async (from, to) => {
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
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io, rename: async (from, to) => {
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
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io, rename: async (from, to) => {
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
    ...data.service.codexMigrationOptions.io,
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
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io, open: async (file, flags, mode) => {
    if (path.basename(file) === '.migrated-from') await fs.promises.writeFile(file, 'dummy-existing-marker', { mode: 0o600 });
    return fs.promises.open(file, flags, mode);
  } };
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.equal(fs.readFileSync(path.join(data.profilesDir, '.migrated-from'), 'utf8'), 'dummy-existing-marker');
  assert.equal(fs.realpathSync(data.activeLink), data.account.profileRef);
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
});


function migrationClock() {
  let time = Date.parse('2026-09-19T12:00:00Z');
  const timers = new Map();
  let id = 0;
  return {
    now: () => time,
    setTimeout: (run, delay) => { timers.set(++id, { run, delay }); return id; },
    clearTimeout: (timer) => timers.delete(timer),
    timers,
    async tick() {
      assert.equal(timers.size, 1);
      const [key, timer] = timers.entries().next().value;
      timers.delete(key);
      assert.ok(timer.delay >= 8 * 60_000 && timer.delay <= 12 * 60_000);
      time += timer.delay;
      await timer.run();
    },
  };
}

async function migrationRequest(app, method, url, headers = {}) {
  return new Promise((resolve) => {
    let status;
    app.server.emit('request', {
      method, url, headers: { host: '127.0.0.1:3867', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
    }, { writeHead(code) { status = code; }, end: (body) => resolve({ status, body: JSON.parse(body) }) });
  });
}
const migrationToken = { 'x-modeldeck-token': 'dummy-token', cookie: 'modeldeck_session=dummy-token' };

test('TRIPWIRE codex-migration-retries-after-deferral', async (t) => {
  const clock = migrationClock();
  let checks = 0;
  const data = fixture(t, { isLegacyInUse: async () => ++checks === 1
    ? { inUse: true, holders: ['ChatGPT', 'codex'] } : false }, clock);
  const first = await data.service.migrateCodexProfilesDir();
  assert.equal(first.retryable, true);
  assert.deepEqual(data.service.codexProfilesMigration, {
    status: 'deferred', holders: ['ChatGPT', 'codex'], since: new Date(clock.now()).toISOString(),
  });
  await clock.tick();
  assert.equal(data.store.getAccount(data.account.id).profileRef, path.join(data.profilesDir, 'first'));
  assert.deepEqual(data.service.codexProfilesMigration, { status: 'done', movedAt: new Date(clock.now()).toISOString() });
  assert.equal(data.service.codexProfilesMigrationWarning, null);
  assert.equal(clock.timers.size, 0);
  assert.equal(checks, 5, 'one deferred check plus all four idle safety checks during the move');
});

test('codex-migration-retry-never-overlaps', async (t) => {
  const clock = migrationClock();
  let checks = 0;
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const data = fixture(t, { isLegacyInUse: async () => {
    checks++;
    if (checks === 2) { entered(); await gate; }
    return { inUse: true, holders: ['codex'] };
  } }, clock);
  await data.service.migrateCodexProfilesDir();
  const queuedTick = [...clock.timers.values()][0].run;
  const onDemand = data.service.migrateCodexProfilesDir();
  await waiting;
  const tick = queuedTick();
  const joined = data.service.migrateCodexProfilesDir();
  assert.equal(joined, onDemand);
  assert.equal(checks, 2);
  release();
  await Promise.all([tick, onDemand]);
  assert.equal(checks, 2);
  assert.equal(clock.timers.size, 1);
});

test('TRIPWIRE codex-migration-on-demand-endpoint', async (t) => {
  const clock = migrationClock();
  let busy = true;
  let checks = 0;
  const data = fixture(t, { isLegacyInUse: async () => {
    checks++;
    return busy ? { inUse: true, holders: ['codex'] } : false;
  } }, clock);
  const { app } = await startup(data);
  const before = checks;
  for (const headers of [{}, { 'x-modeldeck-token': 'dummy-token' }, { ...migrationToken, origin: 'https://invalid.example' }]) {
    assert.equal((await migrationRequest(app, 'POST', '/api/codex-profiles/migrate', headers)).status, 403);
  }
  assert.equal(checks, before);
  assert.deepEqual(await migrationRequest(app, 'POST', '/api/codex-profiles/migrate', migrationToken), {
    status: 200, body: { status: 'deferred', holders: ['codex'] },
  });
  busy = false;
  assert.deepEqual(await migrationRequest(app, 'POST', '/api/codex-profiles/migrate', migrationToken), {
    status: 200, body: { status: 'moved' },
  });
  assert.deepEqual(await migrationRequest(app, 'POST', '/api/codex-profiles/migrate', migrationToken), {
    status: 200, body: { status: 'not-needed' },
  });
  assert.equal(clock.timers.size, 0);
  assert.equal((await migrationRequest(app, 'GET', '/api/state')).body.codexProfilesMigration.status, 'done');
});

test('TRIPWIRE codex-migration-warning-names-holders-not-paths', async (t) => {
  const clock = migrationClock();
  const data = fixture(t, {}, clock);
  const processes = [
    { ...chatgptCodex, command: `${chatgptCodex.command} CODEX_HOME=${data.legacyDir}/first DUMMY_SECRET=private` },
    { executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: 'never read this' },
    { executable: '/dummy/tools/SkyComputerUseService', command: 'never read this' },
    { executable: '/dummy/other/SkyComputerUseService', command: 'never read this' },
  ];
  const exec = async (bin, args) => {
    if (bin === '/usr/bin/pgrep') return { stdout: '1', stderr: '' };
    return processInspection(processes, { openFiles: 'p1\np2\np3\np4\n' })(bin, args);
  };
  data.service.codexMigrationOptions.isLegacyInUse = (legacy) => legacyCodexProfilesUsage(legacy, exec);
  const { app } = await startup(data);
  const warning = (await health(app)).warning;
  const record = (await migrationRequest(app, 'GET', '/api/state')).body.codexProfilesMigration;
  assert.equal(warning, 'Codex profile move is waiting on codex, ChatGPT, and SkyComputerUseService');
  assert.deepEqual(record, { status: 'deferred', holders: ['codex', 'ChatGPT', 'SkyComputerUseService'], since: new Date(clock.now()).toISOString() });
  for (const text of [warning, JSON.stringify(record), ...data.logs]) {
    assert.doesNotMatch(text, /\/|CODEX_HOME|legacy|DUMMY_SECRET|private/);
  }
});

test('codex-migration-hard-failure-does-not-retry', async (t) => {
  const clock = migrationClock();
  const data = fixture(t, {}, clock);
  fs.mkdirSync(data.profilesDir, { mode: 0o700 });
  fs.writeFileSync(path.join(data.profilesDir, 'keep'), 'dummy');
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.equal(result.retryable, false);
  assert.equal(clock.timers.size, 0);
});

test('codex-migration-shutdown-cancels-and-drains-retry', async (t) => {
  const clock = migrationClock();
  let release;
  let entered;
  let checks = 0;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const data = fixture(t, { isLegacyInUse: async () => {
    if (++checks === 2) { entered(); await gate; }
    return true;
  } }, clock);
  await data.service.migrateCodexProfilesDir();
  const tick = clock.tick();
  await waiting;
  let stopped = false;
  const stop = data.service.stopCodexProfilesMigration().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([tick, stop]);
  assert.equal(clock.timers.size, 0);
});

test('codex-migration-runtime-requests-wait-and-active-requests-defer', async (t) => {
  const clock = migrationClock();
  let busy = true;
  let hold = false;
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const data = fixture(t, { isLegacyInUse: async () => {
    if (busy) return true;
    if (hold) { entered(); await gate; }
    return false;
  } }, clock);
  const { app } = await startup(data);
  let releaseState;
  let stateEntered;
  const stateWaiting = new Promise((resolve) => { stateEntered = resolve; });
  const stateGate = new Promise((resolve) => { releaseState = resolve; });
  const originalState = data.service.state.bind(data.service);
  let stateCalls = 0;
  data.service.state = async () => { stateCalls++; stateEntered(); await stateGate; return originalState(); };
  const active = migrationRequest(app, 'GET', '/api/state');
  await stateWaiting;
  // An API reader that started first owns its stable profile view.
  busy = false;
  await clock.tick();
  assert.equal(data.service.codexProfilesMigration.status, 'deferred');
  releaseState();
  await active;
  hold = true;
  const move = migrationRequest(app, 'POST', '/api/codex-profiles/migrate', migrationToken);
  await waiting;
  const joinedMove = migrationRequest(app, 'POST', '/api/codex-profiles/migrate', migrationToken);
  let readDone = false;
  const read = migrationRequest(app, 'GET', '/api/state').then((result) => { readDone = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readDone, false);
  assert.equal(stateCalls, 1);
  release();
  assert.equal((await move).body.status, 'moved');
  assert.equal((await joinedMove).body.status, 'moved');
  assert.equal((await read).body.codexProfilesMigration.status, 'done');
});

test('codex-migration-unknown-process-check-retries-and-late-deferral-rolls-back', async (t) => {
  const clock = migrationClock();
  let checks = 0;
  const data = fixture(t, { isLegacyInUse: async () => {
    checks++;
    if (checks === 1) throw new Error('dummy private command CODEX_HOME=/dummy/legacy');
    if (checks === 5) return { inUse: true, holders: ['codex'] };
    return false;
  } }, clock);
  await data.service.migrateCodexProfilesDir();
  const since = data.service.codexProfilesMigration.since;
  await clock.tick();
  assert.equal(checks, 5);
  assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
  assert.equal(data.service.codexProfilesMigration.since, since);
  assert.deepEqual(data.service.codexProfilesMigration.holders, ['codex']);
  await clock.tick();
  assert.equal(data.service.codexProfilesMigration.status, 'done');
  assert.equal(clock.timers.size, 0);
  assert.doesNotMatch(data.logs.join(' '), /CODEX_HOME|\/dummy\/legacy/);
});

test('codex-migration-warning-limits-names-state-keeps-all-and-empty-start-omits-field', async (t) => {
  const clock = migrationClock();
  const holders = ['ChatGPT', 'codex', 'Helper1', 'Helper2', 'Helper3', 'Helper4', 'Helper5'];
  const data = fixture(t, { isLegacyInUse: async () => ({ inUse: true, holders }) }, clock);
  await data.service.migrateCodexProfilesDir();
  assert.equal(data.service.codexProfilesMigrationWarning, 'Codex profile move is waiting on ChatGPT, codex, Helper1, Helper2, Helper3, and 2 more');
  assert.deepEqual(data.service.codexProfilesMigration.holders, holders);
  data.service.codexMigrationOptions.isLegacyInUse = async () => false;
  await data.service.migrateCodexProfilesDir();
  const empty = fixture(t, {}, migrationClock());
  empty.store.deleteAccount(empty.account.id);
  fs.rmSync(empty.legacyDir, { recursive: true });
  fs.unlinkSync(empty.activeLink);
  await empty.service.migrateCodexProfilesDir();
  assert.equal(Object.hasOwn(await empty.service.state(), 'codexProfilesMigration'), false);
});

test('codex-migration-shutdown-drains-background-work-waiting-on-migration', async (t) => {
  const clock = migrationClock();
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const data = fixture(t, { isLegacyInUse: async () => { entered(); await gate; return true; } }, {
    ...clock,
    configLintSnapshotCollector: async () => ({}), configLintEvaluate: () => [],
    ingestTranscriptArchive: async () => ({}), ingestCodexRollouts: async () => ({}),
    runDiagnostician: async () => ({}), refitUsageEstimates: async () => ({}),
  });
  const move = data.service.migrateCodexProfilesDir();
  await waiting;
  const lint = data.service.runConfigLint();
  const ingest = data.service.runWarehouseIngestPass();
  let lintStopped = false;
  let ingestStopped = false;
  const stopLint = data.service.stopConfigLint().then(() => { lintStopped = true; });
  const stopIngest = data.service.stopWarehouseIngest().then(() => { ingestStopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const stoppedEarly = { lintStopped, ingestStopped };
  release();
  await Promise.all([move, lint, ingest, stopLint, stopIngest]);
  assert.deepEqual(stoppedEarly, { lintStopped: false, ingestStopped: false });
});

test('codex-migration-endpoint-reports-move-before-terminal-pin-failure', async (t) => {
  const clock = migrationClock();
  const data = fixture(t, { isLegacyInUse: async () => true }, clock);
  const { app } = await startup(data);
  data.service.codexMigrationOptions.isLegacyInUse = async () => false;
  fs.writeFileSync(data.service.codexShellEnvFile, 'dummy terminal pin', { mode: 0o600 });
  data.service.writeCodexShellEnvFile = async () => { throw new Error('dummy terminal pin failure'); };
  const response = await migrationRequest(app, 'POST', '/api/codex-profiles/migrate', migrationToken);
  assert.deepEqual(response, { status: 200, body: { status: 'moved' } });
  assert.equal(data.service.codexProfilesMigration.status, 'done');
  assert.equal(data.service.codexProfilesMigrationBlocked, true);
  assert.equal(fs.realpathSync(data.activeLink), path.join(data.profilesDir, 'first'));
  assert.equal(clock.timers.size, 0);
  assert.match((await health(app)).warning, /terminal environment/);
  assert.equal((await migrationRequest(app, 'GET', '/api/state')).status, 503);
});

test('TRIPWIRE codex-migration-waiting-daemon-work-is-not-a-holder (CodeRabbit, PR #680)', async (t) => {
  // A lint pass and an ingest pass queued WHILE the migration runs sit in
  // their promise fields awaiting the migration. The idle check must not
  // count those waiters as holders of the legacy root, or the move defers
  // against its own waiters and rolls back entries it already moved.
  const clock = migrationClock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  const data = fixture(t, { isLegacyInUse: async () => {
    checks++;
    if (checks === 1) await gate; // hold the first idle check open
    return false;
  } }, {
    ...clock,
    configLintSnapshotCollector: async () => ({}), configLintEvaluate: () => [],
    ingestTranscriptArchive: async () => ({}), ingestCodexRollouts: async () => ({}),
    runDiagnostician: async () => ({}), refitUsageEstimates: async () => ({}),
  });
  const migration = data.service.migrateCodexProfilesDir();
  await new Promise((resolve) => setImmediate(resolve));
  const lint = data.service.runConfigLint();
  const ingest = data.service.runWarehouseIngestPass();
  assert.ok(data.service.configLintPromise && data.service.warehouseIngestPromise, 'both passes are queued behind the migration');
  release();
  const result = await migration;
  assert.equal(result.migrated, true, 'queued daemon work must not defer the move');
  assert.deepEqual(data.service.codexProfilesMigration.status, 'done');
  assert.equal(data.store.getAccount(data.account.id).profileRef, path.join(data.profilesDir, 'first'));
  await Promise.all([lint, ingest]);
  assert.equal(data.service.configLintActive, false);
  assert.equal(data.service.warehouseIngestActive, false);
});


test('TRIPWIRE codex-migration-held-root-renames-and-aliases', async (t) => {
  let processChecks = 0;
  const data = fixture(t, { isLegacyInUse: async () => {
    processChecks++;
    return { inUse: true, holders: ['ChatGPT', 'codex'] };
  } }, migrationClock(), { sameVolume: true, shortRoot: true });
  const file = path.join(data.legacyDir, 'first', 'auth.json');
  const fd = fs.openSync(file, 'a');
  const child = spawn('/bin/sleep', ['5'], { cwd: path.dirname(file) });
  await once(child, 'spawn');
  t.after(async () => {
    fs.closeSync(fd);
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const socketPath = path.join(data.legacyDir, 'first', 'ipc.sock');
  const socket = net.createServer((client) => client.end('dummy'));
  let socketAvailable = true;
  try {
    socket.listen(socketPath);
    await once(socket, 'listening');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    socketAvailable = false;
  }
  t.after(async () => { if (socket.listening) await new Promise((resolve) => socket.close(resolve)); });
  const app = createApp({ store: data.store, service: data.service, mutationToken: 'dummy-token' });
  const response = await migrationRequest(app, 'POST', '/api/codex-profiles/migrate', migrationToken);
  assert.deepEqual(response, { status: 200, body: { status: 'moved' } });
  assert.equal(processChecks, 0);
  assert.ok(fs.lstatSync(data.legacyDir).isSymbolicLink());
  assert.equal(fs.readlinkSync(data.legacyDir), data.profilesDir);
  fs.writeSync(fd, 'after-move');
  assert.match(fs.readFileSync(path.join(data.profilesDir, 'first', 'auth.json'), 'utf8'), /after-move$/);
  fs.writeFileSync(path.join(data.legacyDir, 'first', 'new-file'), 'new-dummy');
  assert.equal(fs.readFileSync(path.join(data.profilesDir, 'first', 'new-file'), 'utf8'), 'new-dummy');
  assert.equal(child.exitCode, null);
  assert.equal(fs.realpathSync(data.activeLink), path.join(data.profilesDir, 'first'));
  assert.equal(data.store.getAccount(data.account.id).profileRef, path.join(data.profilesDir, 'first'));
  const marker = JSON.parse(fs.readFileSync(path.join(data.profilesDir, '.migrated-from'), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['alias', 'legacyDir', 'migratedAt']);
  assert.equal(marker.alias, true);
  assert.equal(marker.legacyDir, data.legacyDir);
  assert.equal((await migrationRequest(app, 'GET', '/api/state')).body.codexProfilesMigration.status, 'done');
  await t.test('socket accepts connections through the legacy alias', async (t) => {
    if (!socketAvailable) return t.skip('sandbox denies unix socket listen with EPERM; other held-root assertions ran');
    const client = net.createConnection(socketPath);
    let bytes = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => { bytes += chunk; });
    await once(client, 'end');
    client.destroy();
    assert.equal(bytes, 'dummy');
  });
});

test('TRIPWIRE codex-migration-held-root-never-copies', async (t) => {
  const data = fixture(t, { isLegacyInUse: async () => ({ inUse: true, holders: ['codex'] }) });
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.retryable, true);
  assert.match(result.warning, /waiting on codex/);
  assert.equal(fs.existsSync(data.profilesDir), false);
});

test('TRIPWIRE codex-migration-alias-race-rolls-back', async (t) => {
  const data = fixture(t, {}, {}, { sameVolume: true });
  let raced = false;
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
    symlink: async (target, link, type) => {
      if (!raced) { raced = true; await fs.promises.mkdir(data.legacyDir, { mode: 0o700 }); }
      return fs.promises.symlink(target, link, type);
    },
  };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.blocked, false);
  assert.equal(result.retryable, true);
  assert.equal(fs.lstatSync(data.legacyDir).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(data.legacyDir, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
});

test('TRIPWIRE codex-migration-restart-after-alias-is-done', async (t) => {
  const data = fixture(t, {}, {}, { sameVolume: true });
  fs.mkdirSync(data.profilesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data.profilesDir, 'marker-file'), 'dummy');
  data.store.repointCodexProfiles([{ id: data.account.id, from: data.account.profileRef, to: path.join(data.profilesDir, 'first') }]);
  fs.rmSync(data.legacyDir, { recursive: true });
  fs.symlinkSync(data.profilesDir, data.legacyDir, 'dir');
  assert.deepEqual(await data.service.migrateCodexProfilesDir(), {});
  assert.equal(data.service.codexProfilesMigrationWarning, null);
});

test('TRIPWIRE codex-migration-alias-is-owner-only-and-never-followed', async (t) => {
  const data = fixture(t, {}, {}, { sameVolume: true });
  const foreign = path.join(data.root, 'foreign');
  fs.mkdirSync(foreign, { mode: 0o700 });
  fs.writeFileSync(path.join(foreign, 'canary'), 'untouched');
  fs.rmSync(data.legacyDir, { recursive: true });
  fs.symlinkSync(foreign, data.legacyDir, 'dir');
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(result.warning);
  assert.equal(fs.readFileSync(path.join(foreign, 'canary'), 'utf8'), 'untouched');
});

test('codex-migration-absolute-links-into-legacy-survive-via-alias', async (t) => {
  const data = fixture(t, {}, {}, { sameVolume: true });
  const target = path.join(data.legacyDir, 'first', 'auth.json');
  fs.symlinkSync(target, path.join(data.legacyDir, 'first', 'absolute-link'));
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(data.profilesDir, 'first', 'absolute-link'), 'utf8'), 'dummy-auth-first\n');
});

test('codex-migration-daemon-busy-still-defers-on-rename-path', async (t) => {
  const data = fixture(t, {}, {}, { sameVolume: true });
  data.service.codexProfilesMigrationReaders = 1;
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(result.retryable, true);
  assert.match(result.warning, /node/);
  assert.equal(fs.existsSync(data.profilesDir), false);
});

test('TRIPWIRE codex-migration-root-identity-race-never-publishes-replacement', async (t) => {
  for (const restoreOriginal of [false, true]) {
    await t.test(restoreOriginal ? 'original restored permits retry' : 'original still missing blocks operations', async (t) => {
      const clock = migrationClock();
      const data = fixture(t, {}, clock, { sameVolume: true });
      const saved = `${data.legacyDir}-save`;
      let raced = false;
      data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
        rename: async (from, to) => {
          if (from === data.legacyDir && !raced) {
            raced = true;
            await fs.promises.rename(from, saved);
            await fs.promises.mkdir(from, { mode: 0o700 });
          }
          await fs.promises.rename(from, to);
          if (from === data.profilesDir && restoreOriginal) {
            await fs.promises.rmdir(data.legacyDir);
            await fs.promises.rename(saved, data.legacyDir);
          }
        },
      };
      const result = await data.service.migrateCodexProfilesDir();
      assert.ok(result.warning);
      assert.equal(result.migrated, undefined);
      assert.equal(result.blocked, !restoreOriginal);
      assert.equal(result.retryable, restoreOriginal);
      assert.equal(clock.timers.size, restoreOriginal ? 1 : 0);
      assert.equal(fs.existsSync(data.profilesDir), false);
      assert.equal(fs.existsSync(path.join(data.legacyDir, '.migrated-from')), false);
      if (!restoreOriginal) assert.deepEqual(fs.readdirSync(data.legacyDir), []);
      assert.equal(fs.readFileSync(path.join(restoreOriginal ? data.legacyDir : saved, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
      assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
      assert.equal(fs.readlinkSync(data.activeLink), '.codex-profiles/first');
    });
  }
});

test('TRIPWIRE codex-migration-destination-swap-after-moved-inode-check-never-publishes-replacement', async (t) => {
  const data = fixture(t, {}, {}, { sameVolume: true });
  const saved = `${data.profilesDir}-original`;
  let raced = false;
  let activeLinkTouched = false;
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
    symlink: async (target, link, type) => {
      if (link === data.legacyDir && !raced) {
        raced = true;
        await fs.promises.rename(data.profilesDir, saved);
        fs.mkdirSync(data.profilesDir, { mode: 0o700 });
        fs.mkdirSync(path.join(data.profilesDir, 'first'), { mode: 0o700 });
        fs.writeFileSync(path.join(data.profilesDir, 'first', 'auth.json'), 'foreign-dummy\n', { mode: 0o600 });
      }
      return fs.promises.symlink(target, link, type);
    },
    rename: async (from, to) => {
      if (to === data.activeLink) activeLinkTouched = true;
      return fs.promises.rename(from, to);
    },
  };
  const result = await data.service.migrateCodexProfilesDir();
  assert.equal(raced, true);
  assert.equal(result.migrated, undefined);
  assert.equal(result.blocked, true);
  assert.equal(activeLinkTouched, false);
  assert.equal(fs.readFileSync(path.join(saved, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
  assert.equal(fs.readFileSync(path.join(data.profilesDir, 'first', 'auth.json'), 'utf8'), 'foreign-dummy\n');
  assert.equal(fs.existsSync(path.join(data.profilesDir, '.migrated-from')), false);
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
});

test('TRIPWIRE codex-migration-rollback-alias-quarantine-preserves-foreign-substitution', async (t) => {
  for (const variant of ['symlink', 'file']) {
    await t.test(variant, async (t) => {
      const data = fixture(t, {}, {}, { sameVolume: true });
      const foreignTarget = path.join(data.root, `${variant}-foreign-target`);
      fs.mkdirSync(foreignTarget, { mode: 0o700 });
      fs.writeFileSync(path.join(foreignTarget, 'canary'), 'untouched\n');
      let raced = false;
      const placeForeign = () => {
        if (variant === 'symlink') fs.symlinkSync(foreignTarget, data.legacyDir, 'dir');
        else fs.writeFileSync(data.legacyDir, 'foreign-file-canary\n', { mode: 0o600 });
      };
      data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
        open: async (file, flags, mode) => {
          if (path.basename(file) === '.migrated-from') throw new Error('injected marker failure');
          return fs.promises.open(file, flags, mode);
        },
        rename: async (from, to) => {
          const result = await fs.promises.rename(from, to);
          if (!raced && from === data.legacyDir && path.basename(to).startsWith('.codex-migration-alias-')) {
            raced = true;
            placeForeign();
          }
          return result;
        },
        unlink: async (file) => {
          if (!raced && file === data.legacyDir) {
            raced = true;
            fs.unlinkSync(data.legacyDir);
            placeForeign();
          }
          return fs.promises.unlink(file);
        },
      };
      const result = await data.service.migrateCodexProfilesDir();
      assert.equal(raced, true);
      assert.equal(result.migrated, undefined);
      assert.equal(result.blocked, true);
      if (variant === 'symlink') {
        assert.equal(fs.readlinkSync(data.legacyDir), foreignTarget);
        assert.equal(fs.readFileSync(path.join(foreignTarget, 'canary'), 'utf8'), 'untouched\n');
      } else {
        assert.equal(fs.readFileSync(data.legacyDir, 'utf8'), 'foreign-file-canary\n');
      }
    });
  }
});

test('TRIPWIRE codex-migration-alias-race-preserves-foreign-symlink', async (t) => {
  const data = fixture(t, {}, {}, { sameVolume: true });
  const foreign = path.join(data.root, 'foreign');
  fs.mkdirSync(foreign, { mode: 0o700 });
  fs.writeFileSync(path.join(foreign, 'canary'), 'untouched');
  let raced = false;
  const race = () => {
    if (!raced) { raced = true; fs.symlinkSync(foreign, data.legacyDir); }
  };
  data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
    symlink: async (target, link, type) => {
      if (link === data.legacyDir) race();
      return fs.promises.symlink(target, link, type);
    },
    rename: async (from, to) => {
      if (to === data.legacyDir && path.basename(from).startsWith('.codex-migration-')) race();
      return fs.promises.rename(from, to);
    },
  };
  const result = await data.service.migrateCodexProfilesDir();
  assert.ok(raced);
  assert.equal(result.migrated, undefined);
  assert.equal(result.blocked, true, 'foreign entry prevents a safe rename back');
  assert.equal(fs.readlinkSync(data.legacyDir), foreign);
  assert.equal(fs.readFileSync(path.join(foreign, 'canary'), 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(path.join(data.profilesDir, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
  assert.equal(fs.existsSync(path.join(data.profilesDir, '.migrated-from')), false);
  assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
});

test('TRIPWIRE codex-migration-restart-alias-validates-destination-integrity', async (t) => {
  for (const variant of ['dangling', 'redirected', 'public', 'foreign-owner', 'identity-swap']) {
    await t.test(variant, async (t) => {
      const data = fixture(t, {}, {}, { sameVolume: true });
      fs.renameSync(data.legacyDir, data.profilesDir);
      fs.symlinkSync(data.profilesDir, data.legacyDir);
      const saved = path.join(data.root, 'saved');
      if (variant === 'dangling') fs.renameSync(data.profilesDir, saved);
      if (variant === 'redirected') {
        fs.renameSync(data.profilesDir, saved);
        fs.symlinkSync(saved, data.profilesDir);
      }
      if (variant === 'public') fs.chmodSync(data.profilesDir, 0o755);
      let swapped = false;
      data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
        lstat: async (file) => {
          const stat = await fs.promises.lstat(file);
          if (variant === 'foreign-owner' && file === data.profilesDir) stat.uid += 1;
          return stat;
        },
        realpath: async (file) => {
          if (variant === 'identity-swap' && file === data.legacyDir && !swapped) {
            swapped = true;
            fs.renameSync(data.profilesDir, saved);
            fs.mkdirSync(data.profilesDir, { mode: 0o700 });
          }
          return fs.promises.realpath(file);
        },
      };
      const result = await data.service.migrateCodexProfilesDir();
      assert.ok(result.warning);
      assert.equal(result.retryable, false);
      assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
    });
  }
});

test('TRIPWIRE codex-migration-restart-alias-repairs-stale-references-transactionally', async (t) => {
  for (const abort of [false, true]) {
    await t.test(abort ? 'transaction failure retains every old reference' : 'publishes every legacy reference', async (t) => {
      const data = fixture(t, {}, {}, { sameVolume: true });
      const second = data.store.saveAccount({ provider: 'codex', label: 'Dummy second', profileRef: path.join(data.legacyDir, 'second') });
      fs.renameSync(data.legacyDir, data.profilesDir);
      fs.symlinkSync(data.profilesDir, data.legacyDir);
      if (abort) data.store.db.exec(`CREATE TRIGGER abort_restart BEFORE UPDATE OF profile_ref ON accounts
        WHEN OLD.label = 'Dummy second' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      let publishes = 0;
      const repoint = data.store.repointCodexProfiles.bind(data.store);
      data.store.repointCodexProfiles = (moves) => { publishes++; return repoint(moves); };
      const result = await data.service.migrateCodexProfilesDir();
      assert.equal(publishes, 1);
      for (const account of [data.account, second]) {
        assert.equal(data.store.getAccount(account.id).profileRef,
          abort ? account.profileRef : path.join(data.profilesDir, path.basename(account.profileRef)));
      }
      if (abort) { assert.ok(result.warning); assert.equal(result.blocked, true); }
      else { assert.deepEqual(result, {}); assert.equal(data.service.codexProfilesMigration, null); }
      assert.equal(fs.realpathSync(data.legacyDir), data.profilesDir);
    });
  }
});

test('TRIPWIRE codex-migration-rename-validates-registered-nested-profile', async (t) => {
  for (const variant of ['public', 'symlink', 'file', 'foreign-owner']) {
    await t.test(variant, async (t) => {
      const data = fixture(t, {}, {}, { sameVolume: true });
      const nested = path.join(data.legacyDir, 'first', 'nested');
      if (variant === 'symlink') fs.symlinkSync(path.join(data.legacyDir, 'second'), nested);
      else if (variant === 'file') fs.writeFileSync(nested, 'dummy', { mode: 0o600 });
      else fs.mkdirSync(nested, { mode: variant === 'public' ? 0o755 : 0o700 });
      data.store.repointCodexProfiles([{ id: data.account.id, from: data.account.profileRef, to: nested }]);
      data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
        lstat: async (file) => {
          const stat = await fs.promises.lstat(file);
          if (variant === 'foreign-owner' && file === nested) stat.uid += 1;
          return stat;
        },
      };
      const result = await data.service.migrateCodexProfilesDir();
      assert.ok(result.warning);
      assert.equal(fs.existsSync(data.profilesDir), false);
      assert.equal(fs.lstatSync(data.legacyDir).isDirectory(), true);
      assert.equal(data.store.getAccount(data.account.id).profileRef, nested);
    });
  }
});

// CodeRabbit (PR #695): a legacy root at 0o750/0o755 passes every earlier
// guard, must not be RENAMED (the mode would ride along), and before #693 it
// migrated through the verified copy. Falling through keeps that behavior.
test('TRIPWIRE codex-migration-non-private-legacy-root-enters-verified-copy-not-abort', async (t) => {
  for (const held of [false, true]) {
    await t.test(`held ${held}`, async (t) => {
      const clock = migrationClock();
      let checks = 0;
      const data = fixture(t, { isLegacyInUse: async () => {
        checks++;
        return held ? { inUse: true, holders: ['codex'] } : false;
      } }, clock, { sameVolume: true });
      fs.chmodSync(data.legacyDir, 0o750);
      let renamedRoot = false;
      data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
        rename: async (from, to) => {
          if (from === data.legacyDir) renamedRoot = true;
          return fs.promises.rename(from, to);
        },
      };
      const result = await data.service.migrateCodexProfilesDir();
      assert.equal(renamedRoot, false, 'a non-private root must never be renamed');
      assert.ok(checks > 0, 'the copy path must consult the process gate');
      if (held) {
        assert.equal(result.retryable, true, 'held copy path defers, never a permanent warning');
        assert.equal(result.blocked, false);
        assert.equal(clock.timers.size, 1);
      } else {
        assert.equal(result.migrated, true);
        assert.ok(result.backupDir, 'the copy path ran');
        assert.equal(fs.statSync(data.profilesDir).mode & 0o077, 0, 'the destination root is owner-only');
      }
    });
  }
});

test('TRIPWIRE codex-migration-same-device-EXDEV-enters-idle-verified-copy', async (t) => {
  for (const emptyDestination of [false, true]) {
    for (const held of [false, true]) {
      await t.test(`empty destination ${emptyDestination}, held ${held}`, async (t) => {
        const clock = migrationClock();
        let checks = 0;
        const data = fixture(t, { isLegacyInUse: async () => {
          checks++;
          return held ? { inUse: true, holders: ['codex'] } : false;
        } }, clock, { sameVolume: true });
        if (emptyDestination) fs.mkdirSync(data.profilesDir, { mode: 0o700 });
        data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
          rename: async (from, to) => {
            if (from === data.legacyDir || path.dirname(from) === data.legacyDir) {
              throw Object.assign(new Error('same-device EXDEV fixture'), { code: 'EXDEV' });
            }
            return fs.promises.rename(from, to);
          },
        };
        const result = await data.service.migrateCodexProfilesDir();
        assert.ok(checks > 0, 'fallback must consult the process gate');
        if (held) {
          assert.equal(result.retryable, true);
          assert.equal(result.blocked, false);
          assert.equal(clock.timers.size, 1);
          assert.equal(fs.existsSync(data.profilesDir), false);
          assert.deepEqual(fs.readdirSync(data.dataDir), []);
          assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
        } else {
          assert.equal(result.migrated, true);
          assert.ok(result.backupDir);
          for (const root of [data.profilesDir, path.join(result.backupDir, 'profiles')]) {
            assert.equal(fs.readFileSync(path.join(root, 'first', 'auth.json'), 'utf8'), 'dummy-auth-first\n');
          }
          assert.deepEqual(fs.readdirSync(data.legacyDir), []);
          assert.equal(data.store.getAccount(data.account.id).profileRef, path.join(data.profilesDir, 'first'));
        }
      });
    }
  }
});


test('codex-migration-rename-failures-restore-original-root', async (t) => {
  for (const stage of ['active-link', 'marker', 'database']) {
    await t.test(stage, async (t) => {
      const data = fixture(t, {}, {}, { sameVolume: true });
      const identity = fs.lstatSync(data.legacyDir);
      data.service.codexMigrationOptions.io = { ...data.service.codexMigrationOptions.io,
        rename: async (from, to) => {
          if (stage === 'active-link' && to === data.activeLink) throw new Error('fixture link failure');
          return fs.promises.rename(from, to);
        },
        open: async (file, flags, mode) => {
          if (stage === 'marker' && file === path.join(data.profilesDir, '.migrated-from')) throw new Error('fixture marker failure');
          return fs.promises.open(file, flags, mode);
        },
      };
      if (stage === 'database') data.store.repointCodexProfiles = () => { throw new Error('fixture database failure'); };
      const result = await data.service.migrateCodexProfilesDir();
      assert.ok(result.warning);
      assert.equal(result.blocked, false);
      assert.equal(fs.lstatSync(data.legacyDir).ino, identity.ino);
      assert.equal(fs.existsSync(data.profilesDir), false);
      assert.deepEqual(fs.readdirSync(data.legacyDir), ['first', 'second']);
      assert.equal(fs.readlinkSync(data.activeLink), '.codex-profiles/first');
      assert.equal(data.store.getAccount(data.account.id).profileRef, data.account.profileRef);
    });
  }
});
