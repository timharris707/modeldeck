import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_PROFILE_EXPLAINER_BLOCK,
  CLAUDE_PROFILE_EXPLAINER_END,
  CLAUDE_PROFILE_EXPLAINER_START,
  reconcileClaudeProfileExplainer,
  removeClaudeProfileExplainer,
} from '../src/adapters/claude-profile-explainer.mjs';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

function temporaryProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-profile-explainer-'));
  const profileRef = path.join(root, 'profile');
  fs.mkdirSync(profileRef, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, profileRef, file: path.join(profileRef, 'CLAUDE.md') };
}

test('creates the pinned explainer in an absent CLAUDE.md', async (t) => {
  const { profileRef, file } = temporaryProfile(t);

  assert.deepEqual(await reconcileClaudeProfileExplainer({ profileRef }), { changed: true, file });
  assert.equal(fs.readFileSync(file, 'utf8'), CLAUDE_PROFILE_EXPLAINER_BLOCK);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(CLAUDE_PROFILE_EXPLAINER_BLOCK, /multi-account manager/);
  assert.match(CLAUDE_PROFILE_EXPLAINER_BLOCK, /exactly like a normal Claude home/);
  assert.match(CLAUDE_PROFILE_EXPLAINER_BLOCK, /MCP servers and memory/);
});

test('prepends the block without changing any existing user bytes', async (t) => {
  const { profileRef, file } = temporaryProfile(t);
  const original = '# My instructions\r\n\r\nKeep this final line byte-exact';
  fs.writeFileSync(file, original, { mode: 0o640 });

  await reconcileClaudeProfileExplainer({ profileRef });
  assert.equal(fs.readFileSync(file, 'utf8'), `${CLAUDE_PROFILE_EXPLAINER_BLOCK}${original}`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test('reconcile is idempotent and performs no write when bytes already match', async (t) => {
  const { profileRef, file } = temporaryProfile(t);
  await reconcileClaudeProfileExplainer({ profileRef });

  const noWrites = {
    readFile: fs.promises.readFile.bind(fs.promises),
    stat: fs.promises.stat.bind(fs.promises),
    writeFile: async () => assert.fail('idempotent reconcile must not write'),
    rename: async () => assert.fail('idempotent reconcile must not rename'),
    unlink: fs.promises.unlink.bind(fs.promises),
  };
  assert.deepEqual(
    await reconcileClaudeProfileExplainer({ profileRef, fileSystem: noWrites }),
    { changed: false, file },
  );
});

test('a stale v1 block upgrades in place while preserving content before and after it', async (t) => {
  const { profileRef, file } = temporaryProfile(t);
  const before = '# User content before\r\n';
  const after = '## User content after\nNo final newline';
  const stale = `${CLAUDE_PROFILE_EXPLAINER_START}\r\nOld pinned guidance\r\n${CLAUDE_PROFILE_EXPLAINER_END}\r\n`;
  fs.writeFileSync(file, `${before}${stale}${after}`);

  await reconcileClaudeProfileExplainer({ profileRef });
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(written, `${before}${CLAUDE_PROFILE_EXPLAINER_BLOCK}${after}`);
  assert.ok(written.startsWith(before));
  assert.ok(written.endsWith(after));
  assert.doesNotMatch(written, /Old pinned guidance/);
});

test('removal restores the byte-exact document that existed before install', async (t) => {
  const { profileRef, file } = temporaryProfile(t);
  const original = Buffer.concat([
    Buffer.from('User-owned bytes\r\nwith mixed endings\nand an unusual byte: '),
    Buffer.from([0xff]),
  ]);
  fs.writeFileSync(file, original, { mode: 0o640 });

  await reconcileClaudeProfileExplainer({ profileRef });
  assert.deepEqual(await removeClaudeProfileExplainer({ profileRef }), { changed: true, file });
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(await removeClaudeProfileExplainer({ profileRef }), { changed: false, file });
});

test('writes through a same-directory temporary and cleans it if rename fails', async (t) => {
  const { profileRef, file } = temporaryProfile(t);
  const original = 'Leave me intact';
  fs.writeFileSync(file, original);
  const calls = [];
  const fileSystem = {
    readFile: fs.promises.readFile.bind(fs.promises),
    stat: fs.promises.stat.bind(fs.promises),
    writeFile: async (target, content, options) => {
      calls.push(['write', target]);
      assert.equal(path.dirname(target), profileRef);
      assert.notEqual(target, file);
      await fs.promises.writeFile(target, content, options);
    },
    rename: async (source, destination) => {
      calls.push(['rename', source, destination]);
      assert.equal(destination, file);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.ok(fs.existsSync(source));
      const error = new Error('fixture rename failure');
      error.code = 'EIO';
      throw error;
    },
    unlink: fs.promises.unlink.bind(fs.promises),
  };

  await assert.rejects(
    reconcileClaudeProfileExplainer({
      profileRef,
      fileSystem,
      pid: 123,
      randomUUID: () => 'fixture-uuid',
    }),
    /fixture rename failure/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(calls, [
    ['write', path.join(profileRef, '.CLAUDE.md.modeldeck-123-fixture-uuid')],
    ['rename', path.join(profileRef, '.CLAUDE.md.modeldeck-123-fixture-uuid'), file],
  ]);
  assert.equal(fs.existsSync(path.join(profileRef, '.CLAUDE.md.modeldeck-123-fixture-uuid')), false);
});

test('daemon startup reconciles every managed Claude profile, including disabled accounts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-profile-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'claude-profiles');
  const firstProfile = path.join(profilesDir, 'first');
  const secondProfile = path.join(profilesDir, 'second');
  const codexProfilesDir = path.join(root, 'codex-profiles');
  const codexProfile = path.join(codexProfilesDir, 'codex');
  for (const directory of [firstProfile, secondProfile, codexProfile]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(profilesDir, 0o700);
  fs.chmodSync(codexProfilesDir, 0o700);
  fs.writeFileSync(
    path.join(secondProfile, 'CLAUDE.md'),
    `${CLAUDE_PROFILE_EXPLAINER_START}\nstale\n${CLAUDE_PROFILE_EXPLAINER_END}\nuser bytes`,
  );

  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveSettings({ autoRefreshEnabled: false });
  const first = store.saveAccount({ provider: 'claude', label: 'First', profileRef: firstProfile });
  const second = store.saveAccount({ provider: 'claude', label: 'Second', profileRef: secondProfile, enabled: false });
  store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: codexProfile });
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    codexProfilesDir,
    claudeStatuslineDir: path.join(root, 'statusline'),
    platform: 'linux',
  });
  t.after(() => service.stopAutoRefresh());
  service.backfillClaudeIdentities = async () => {};
  service.reconcileClaudeStatuslineInstalls = async () => [];
  service.ingestClaudeStatuslineCaptures = async () => [];
  service.startClaudeStatuslineWatcher = () => {};

  let resolveStartup;
  let rejectStartup;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  const reconcile = service.reconcileClaudeProfileExplainers.bind(service);
  service.reconcileClaudeProfileExplainers = async () => {
    try {
      const result = await reconcile();
      resolveStartup(result);
      return result;
    } catch (error) {
      rejectStartup(error);
      throw error;
    }
  };

  service.startAutoRefresh();
  assert.deepEqual((await startup).sort(), [first.id, second.id].sort());
  assert.equal(fs.readFileSync(path.join(firstProfile, 'CLAUDE.md'), 'utf8'), CLAUDE_PROFILE_EXPLAINER_BLOCK);
  assert.equal(
    fs.readFileSync(path.join(secondProfile, 'CLAUDE.md'), 'utf8'),
    `${CLAUDE_PROFILE_EXPLAINER_BLOCK}user bytes`,
  );
  assert.equal(fs.existsSync(path.join(codexProfile, 'CLAUDE.md')), false);
  assert.deepEqual(await reconcile(), []);
});

test('new Claude account creation installs the explainer before returning', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-profile-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const service = new ModelDeckService(store, {
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    exec: async () => ({ stdout: 'Claude Code 9.9.9' }),
    readClaudeTier: async () => null,
    readClaudeIdentity: async () => null,
    platform: 'linux',
  });

  const account = await service.createClaudeAccount({ label: 'Work Profile' });
  assert.equal(
    fs.readFileSync(path.join(account.profileRef, 'CLAUDE.md'), 'utf8'),
    CLAUDE_PROFILE_EXPLAINER_BLOCK,
  );
});

test('Claude account creation succeeds when explainer installation fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-profile-create-best-effort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const service = new ModelDeckService(store, {
    claudeProfilesDir: path.join(root, 'claude-profiles'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    exec: async () => ({ stdout: 'Claude Code 9.9.9' }),
    reconcileClaudeProfileExplainer: async () => { throw new Error('fixture explainer write failure'); },
    readClaudeTier: async () => null,
    readClaudeIdentity: async () => null,
    platform: 'linux',
  });

  const account = await service.createClaudeAccount({ label: 'Best Effort' });
  assert.equal(store.getAccount(account.id)?.profileRef, account.profileRef);
  assert.equal(fs.existsSync(account.profileRef), true);
});

test('caller-supplied Claude profile registration succeeds when explainer installation fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-profile-register-best-effort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'claude-profiles');
  const profileRef = path.join(profilesDir, 'registered');
  fs.mkdirSync(profileRef, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    codexProfilesDir: path.join(root, 'codex-profiles'),
    reconcileClaudeProfileExplainer: async () => { throw new Error('fixture explainer write failure'); },
    readClaudeTier: async () => null,
    readClaudeIdentity: async () => null,
    platform: 'linux',
  });

  const account = await service.saveAccount({ provider: 'claude', label: 'Registered', profileRef });
  assert.equal(store.getAccount(account.id)?.profileRef, fs.realpathSync(profileRef));
});

test('failed Claude account creation removes a fresh profile containing an explainer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-profile-create-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'claude-profiles');
  let failedProfileRef;
  const store = new Store(':memory:');
  t.after(() => store.close());
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    codexProfilesDir: path.join(root, 'codex-profiles'),
    exec: async () => ({ stdout: 'Claude Code 9.9.9' }),
    readClaudeTier: async ({ claudeConfigDir }) => {
      failedProfileRef = claudeConfigDir;
      assert.equal(fs.existsSync(path.join(claudeConfigDir, 'CLAUDE.md')), true);
      throw new Error('fixture metadata failure');
    },
    readClaudeIdentity: async () => null,
    platform: 'linux',
  });

  await assert.rejects(
    service.createClaudeAccount({ label: 'Cleanup Profile' }),
    /fixture metadata failure/,
  );
  assert.equal(store.listAccounts().length, 0);
  assert.equal(fs.existsSync(failedProfileRef), false);
});

test('Claude profile import validates duplicate registration before installing the explainer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-profile-import-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'claude-profiles');
  const profileRef = path.join(profilesDir, 'registered');
  fs.mkdirSync(profileRef, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveAccount({ provider: 'claude', label: 'Existing', profileRef });
  let explainerCalls = 0;
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    codexProfilesDir: path.join(root, 'codex-profiles'),
    migrateClaude: async () => [{ label: 'Duplicate', profileRef }],
    reconcileClaudeProfileExplainer: async () => { explainerCalls += 1; },
    platform: 'linux',
  });

  await assert.rejects(
    service.importClaudeSwapProfiles([{ label: 'Duplicate' }]),
    /Claude profile is already registered/,
  );
  assert.equal(explainerCalls, 0);
});
