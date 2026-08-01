import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { createApp } from '../src/server.mjs';
import { replaceTopLevelJsonProperty } from '../src/shared-scope.mjs';

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-shared-scope-'));
  const profilesDir = path.join(root, 'claude-profiles');
  const firstHome = path.join(profilesDir, 'first');
  const secondHome = path.join(profilesDir, 'second');
  fs.mkdirSync(firstHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(secondHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);
  const store = new Store(':memory:');
  const first = store.saveAccount({ provider: 'claude', label: 'First', profileRef: firstHome, isDefault: true });
  const second = store.saveAccount({ provider: 'claude', label: 'Second', profileRef: secondHome });
  const sharedDir = path.join(root, 'data', 'shared');
  const service = new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    sharedScopeDir: sharedDir,
    claudeActiveLink: path.join(root, 'active', '.claude'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    codexActiveLink: path.join(root, 'active', '.codex'),
    fetchClaude: async () => [],
    fetchCodex: async () => [],
    platform: 'linux',
    listProviderProcesses: async () => [],
    ...options,
  });
  return {
    root, profilesDir, firstHome, secondHome, sharedDir, store, service, first, second,
    close() {
      service.stopAutoRefresh();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeClaude(home, value) {
  const file = path.join(home, '.claude.json');
  fs.writeFileSync(file, value);
  return file;
}

function readClaude(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
}

function addUserMemory(home, files) {
  const memory = path.join(home, 'memory');
  fs.mkdirSync(memory, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(memory, name), content);
  return memory;
}

test('shared user scope defaults off and validates as a boolean setting', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.getSettings().sharedUserScopeEnabled, false);
    assert.equal(store.saveSettings({ sharedUserScopeEnabled: true }).sharedUserScopeEnabled, true);
    assert.throws(() => store.saveSettings({ sharedUserScopeEnabled: 'yes' }), /must be a boolean/);
  } finally { store.close(); }
});

test('section replacement retains every byte before and after mcpServers', () => {
  const before = '{\n  "oauthAccount" : {"nested":[{"opaque":"placeholder"}]},\n  "mcpServers" : ';
  const oldSection = '{ "old" : { "command" : "old" } }';
  const after = ',\n  "accountState" : {"flags":[true,false,null]}\n}\n';
  const replacement = { current: { command: 'new' } };
  const result = replaceTopLevelJsonProperty(`${before}${oldSection}${after}`, 'mcpServers', replacement);
  assert.equal(result, `${before}${JSON.stringify(replacement)}${after}`);
});

test('section replacement handles duplicate keys, string delimiters, insertion, and rejects non-JSON wrappers', () => {
  const replacement = { current: { command: 'new' } };
  const duplicate = '{"mcpServers":{"first":true},"text":"escaped \\" quote with } and {","mcpServers":{"last":true}}\n';
  assert.equal(
    replaceTopLevelJsonProperty(duplicate, 'mcpServers', replacement),
    `{"mcpServers":{"first":true},"text":"escaped \\" quote with } and {","mcpServers":${JSON.stringify(replacement)}}\n`,
  );

  const nestedStrings = '{"outer":[{"text":"brace } quote \\" bracket ]"}],"mcpServers":{"old":true},"tail":"{"}\n';
  assert.deepEqual(
    JSON.parse(replaceTopLevelJsonProperty(nestedStrings, 'mcpServers', replacement)),
    { outer: [{ text: 'brace } quote " bracket ]' }], mcpServers: replacement, tail: '{' },
  );

  const missing = '{\n  "oauthAccount": {"opaque":true}\n}\n';
  assert.equal(
    replaceTopLevelJsonProperty(missing, 'mcpServers', replacement),
    `{\n  "oauthAccount": {"opaque":true}\n,"mcpServers":${JSON.stringify(replacement)}}\n`,
  );
  assert.throws(() => replaceTopLevelJsonProperty(`\uFEFF${duplicate}`, 'mcpServers', replacement), /JSON/);
  assert.throws(() => replaceTopLevelJsonProperty(`${duplicate}trailing garbage`, 'mcpServers', replacement), /JSON/);
});

test('enable merges MCP newest-wins, preserves non-MCP bytes, consolidates memory, and backs up first', async (t) => {
  let data;
  let backupsPresentBeforeFirstWrite = false;
  data = fixture({
    sharedScopeBeforeAtomicRename: ({ file }) => {
      if (!file.endsWith('mcp-servers.json')) return;
      backupsPresentBeforeFirstWrite = [data.first, data.second].every((account) => (
        fs.existsSync(path.join(data.sharedDir, 'backups', account.id, '.claude.json'))
        && fs.existsSync(path.join(data.sharedDir, 'backups', account.id, 'memory'))
      ));
    },
  });
  t.after(() => data.close());

  const firstOauth = '"oauthAccount" : { "emailAddress" : "first@example.invalid", "opaque" : "placeholder-a" }';
  const secondOauth = '"oauthAccount":{"emailAddress":"second@example.invalid","opaque":"placeholder-b"}';
  const firstRaw = `{\n  ${firstOauth},\n  "theme": "dark",\n  "mcpServers": {"alpha":{"command":"one"},"shared":{"command":"older"}}\n}\n`;
  const secondRaw = `{${secondOauth},"mcpServers":{"beta":{"command":"two"},"shared":{"command":"newer"}},"custom":true}\n`;
  const firstFile = writeClaude(data.firstHome, firstRaw);
  const secondFile = writeClaude(data.secondHome, secondRaw);
  const old = new Date(Date.now() - 20_000);
  const recent = new Date(Date.now() - 10_000);
  fs.utimesSync(firstFile, old, old);
  fs.utimesSync(secondFile, recent, recent);

  addUserMemory(data.firstHome, { 'first.md': 'first only', 'collision.md': 'older memory' });
  addUserMemory(data.secondHome, { 'second.md': 'second only', 'collision.md': 'newer memory' });
  fs.utimesSync(path.join(data.firstHome, 'memory', 'collision.md'), old, old);
  fs.utimesSync(path.join(data.secondHome, 'memory', 'collision.md'), recent, recent);

  const outcome = await data.service.enableSharedScope();
  assert.equal(backupsPresentBeforeFirstWrite, true);
  assert.equal(outcome.enabled, true);
  assert.deepEqual(outcome.merged, { mcpServers: 3, memoryItems: 4 });
  assert.ok(outcome.conflicts.some((item) => item.name === 'shared' && item.winner === data.second.id));
  assert.ok(outcome.conflicts.some((item) => item.name === 'memory/collision.md' && item.winner === data.second.id));
  assert.deepEqual(outcome.skipped, []);

  for (const home of [data.firstHome, data.secondHome]) {
    assert.deepEqual(readClaude(home).mcpServers, {
      alpha: { command: 'one' }, beta: { command: 'two' }, shared: { command: 'newer' },
    });
  }
  assert.ok(fs.readFileSync(firstFile, 'utf8').includes(firstOauth));
  assert.ok(fs.readFileSync(secondFile, 'utf8').includes(secondOauth));
  assert.equal(fs.readFileSync(path.join(data.sharedDir, 'backups', data.first.id, '.claude.json'), 'utf8'), firstRaw);
  assert.equal(fs.readFileSync(path.join(data.sharedDir, 'backups', data.second.id, '.claude.json'), 'utf8'), secondRaw);

  const sharedMemoryEntries = fs.readdirSync(path.join(data.sharedDir, 'memory')).sort();
  assert.ok(sharedMemoryEntries.includes('collision.md'));
  assert.ok(sharedMemoryEntries.some((name) => name.startsWith('collision.modeldeck-')));
  assert.ok(sharedMemoryEntries.includes('first.md'));
  assert.ok(sharedMemoryEntries.includes('second.md'));
  assert.equal(fs.readFileSync(path.join(data.sharedDir, 'memory', 'collision.md'), 'utf8'), 'newer memory');
  for (const home of [data.firstHome, data.secondHome]) {
    assert.equal(fs.lstatSync(path.join(home, 'memory')).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(home, 'memory')), fs.realpathSync(path.join(data.sharedDir, 'memory')));
  }
  assert.deepEqual(data.service.sharedScope.status(), { enabled: true, lastOutcome: outcome });
});

test('linking memory retains writes made after merge in a timestamped prior backup', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'before.md': 'before merge' });

  const engine = data.service.sharedScope;
  const linkMemory = engine.linkMemory.bind(engine);
  let injectedProfile = null;
  engine.linkMemory = async (entry) => {
    if (!injectedProfile && entry.stat?.isDirectory()) {
      injectedProfile = entry.profile;
      fs.writeFileSync(path.join(entry.path, 'late.md'), 'written after merge');
    }
    return linkMemory(entry);
  };

  await data.service.enableSharedScope();
  const backupDirectory = path.join(data.sharedDir, 'backups', injectedProfile.key);
  const prior = fs.readdirSync(backupDirectory).find((name) => name.startsWith('memory-prior-'));
  assert.ok(prior);
  assert.equal(fs.readFileSync(path.join(backupDirectory, prior, 'late.md'), 'utf8'), 'written after merge');
});

test('debounced profile watches propagate the newest MCP section in both directions', async (t) => {
  const callbacks = new Map();
  const data = fixture({
    sharedScopeDebounceMs: 5,
    sharedScopeWatch: (home, callback) => {
      callbacks.set(home, callback);
      return { close() {}, on() {}, unref() {} };
    },
  });
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ oauthAccount: { emailAddress: 'first@example.invalid' }, mcpServers: { initial: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ oauthAccount: { emailAddress: 'second@example.invalid' }, mcpServers: {} }));
  addUserMemory(data.firstHome, {});
  await data.service.enableSharedScope();
  assert.equal(callbacks.size, 2);
  for (const account of [data.first, data.second]) {
    assert.deepEqual(
      JSON.parse(fs.readFileSync(
        path.join(data.sharedDir, 'backups', account.id, 'last-applied.json'),
        'utf8',
      )),
      { initial: { command: 'one' } },
    );
  }

  const pendingWatcherReconciles = [];
  const engine = data.service.sharedScope;
  const reconcile = engine.reconcile.bind(engine);
  engine.reconcile = (options) => {
    const result = reconcile(options);
    if (!options?.force) pendingWatcherReconciles.shift()?.(result);
    return result;
  };
  const nextWatcherReconcile = () => new Promise((resolve, reject) => {
    pendingWatcherReconciles.push((result) => result.then(resolve, reject));
  });

  const firstEdit = JSON.stringify({ oauthAccount: { emailAddress: 'first@example.invalid' }, mcpServers: { fromFirst: { command: 'first' } } });
  writeClaude(data.firstHome, firstEdit);
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(data.firstHome, '.claude.json'), future, future);
  const firstReconcile = nextWatcherReconcile();
  callbacks.get(fs.realpathSync(data.firstHome))('change', '.claude.json');
  callbacks.get(fs.realpathSync(data.firstHome))('change', '.claude.json');
  await firstReconcile;
  assert.deepEqual(readClaude(data.secondHome).mcpServers, { fromFirst: { command: 'first' } });

  const secondEdit = JSON.stringify({ oauthAccount: { emailAddress: 'second@example.invalid' }, mcpServers: { fromSecond: { command: 'second' } } });
  writeClaude(data.secondHome, secondEdit);
  const fartherFuture = new Date(Date.now() + 20_000);
  fs.utimesSync(path.join(data.secondHome, '.claude.json'), fartherFuture, fartherFuture);
  const secondReconcile = nextWatcherReconcile();
  callbacks.get(fs.realpathSync(data.secondHome))('rename', '.claude.json');
  await secondReconcile;
  assert.deepEqual(readClaude(data.firstHome).mcpServers, { fromSecond: { command: 'second' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.sharedDir, 'mcp-servers.json'), 'utf8')), {
    fromSecond: { command: 'second' },
  });
});

test('reconcile preserves a key added in one profile when another only has a newer unrelated rewrite', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const base = { base: { command: 'base' } };
  writeClaude(data.firstHome, JSON.stringify({ oauthAccount: { token: 'a' }, mcpServers: base }));
  writeClaude(data.secondHome, JSON.stringify({ oauthAccount: { token: 'b' }, mcpServers: base }));
  await data.service.enableSharedScope();

  writeClaude(data.firstHome, JSON.stringify({
    oauthAccount: { token: 'a' },
    mcpServers: { ...base, added: { command: 'from-first' } },
  }));
  writeClaude(data.secondHome, JSON.stringify({ oauthAccount: { token: 'refreshed-b' }, mcpServers: base }));
  const firstTime = new Date(Date.now() + 10_000);
  const newerUnrelatedRewrite = new Date(Date.now() + 20_000);
  fs.utimesSync(path.join(data.firstHome, '.claude.json'), firstTime, firstTime);
  fs.utimesSync(path.join(data.secondHome, '.claude.json'), newerUnrelatedRewrite, newerUnrelatedRewrite);

  await data.service.reconcileSharedScope({ force: true });
  const expected = { ...base, added: { command: 'from-first' } };
  assert.deepEqual(readClaude(data.firstHome).mcpServers, expected);
  assert.deepEqual(readClaude(data.secondHome).mcpServers, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.sharedDir, 'mcp-servers.json'), 'utf8')), expected);
});

test('reconcile unions distinct per-key additions made before one pass', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const base = { base: { command: 'base' } };
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: base }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: base }));
  await data.service.enableSharedScope();

  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { ...base, alpha: { command: 'alpha' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: { ...base, beta: { command: 'beta' } } }));
  const older = new Date(Date.now() + 10_000);
  const newer = new Date(Date.now() + 20_000);
  fs.utimesSync(path.join(data.firstHome, '.claude.json'), older, older);
  fs.utimesSync(path.join(data.secondHome, '.claude.json'), newer, newer);

  await data.service.reconcileSharedScope({ force: true });
  const expected = {
    ...base,
    alpha: { command: 'alpha' },
    beta: { command: 'beta' },
  };
  assert.deepEqual(readClaude(data.firstHome).mcpServers, expected);
  assert.deepEqual(readClaude(data.secondHome).mcpServers, expected);
});

test('a concurrent profile rewrite before atomic rename is preserved and queues another reconcile', async (t) => {
  let armed = false;
  let secondFile;
  let scheduled = 0;
  let scheduledCallback;
  let mutated = false;
  const data = fixture({
    sharedScopeSetTimeout: (callback) => {
      scheduled += 1;
      scheduledCallback = callback;
      return { unref() {} };
    },
    sharedScopeClearTimeout: () => {},
    sharedScopeBeforeAtomicRename: ({ file }) => {
      if (!armed || file !== secondFile) return;
      armed = false;
      mutated = true;
      writeClaude(data.secondHome, JSON.stringify({
        oauthAccount: { token: 'fresh-token-written-concurrently' },
        mcpServers: { base: { command: 'base' } },
      }));
    },
  });
  t.after(() => data.close());
  const base = { base: { command: 'base' } };
  writeClaude(data.firstHome, JSON.stringify({ oauthAccount: { token: 'first' }, mcpServers: base }));
  secondFile = fs.realpathSync(writeClaude(data.secondHome, JSON.stringify({ oauthAccount: { token: 'stale' }, mcpServers: base })));
  await data.service.enableSharedScope();

  writeClaude(data.firstHome, JSON.stringify({
    oauthAccount: { token: 'first' },
    mcpServers: { ...base, added: { command: 'added' } },
  }));
  armed = true;
  const reconciled = await data.service.reconcileSharedScope({ force: true });

  assert.deepEqual(reconciled, { ...base, added: { command: 'added' } });
  assert.equal(mutated, true);
  assert.equal(readClaude(data.secondHome).oauthAccount.token, 'fresh-token-written-concurrently');
  assert.deepEqual(readClaude(data.secondHome).mcpServers, base);
  // This fixture leaves sharedScopeWatch real, so the test's own setup edit
  // can fire the FSWatcher with OS-dependent latency and add a second
  // (coalescing) schedule alongside the pre-rename guard's. The contract is
  // "at least one reschedule, nothing lost", not an exact count.
  assert.ok(scheduled >= 1, `expected at least one reschedule, got ${scheduled}`);

  const engine = data.service.sharedScope;
  const reconcile = engine.reconcile.bind(engine);
  let rescheduled;
  engine.reconcile = (options) => {
    const result = reconcile(options);
    if (!options?.force) rescheduled = result;
    return result;
  };
  scheduledCallback();
  await rescheduled;
  const expected = { ...base, added: { command: 'added' } };
  assert.deepEqual(readClaude(data.firstHome).mcpServers, expected);
  assert.deepEqual(readClaude(data.secondHome).mcpServers, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.sharedDir, 'mcp-servers.json'), 'utf8')), expected);
});

test('a rewrite after the read is skipped until a stable reconcile', async (t) => {
  let armed = false;
  let targetFile;
  let scheduledCallback;
  const data = fixture({
    sharedScopeSetTimeout: (callback) => {
      scheduledCallback = callback;
      return { unref() {} };
    },
    sharedScopeClearTimeout: () => {},
    sharedScopeAfterMcpRead: ({ file }) => {
      if (!armed || file !== targetFile) return;
      armed = false;
      writeClaude(data.firstHome, JSON.stringify({
        oauthAccount: { token: 'fresh' },
        mcpServers: { base: { command: 'base' }, fresh: { command: 'fresh' } },
      }));
    },
  });
  t.after(() => data.close());
  const base = { base: { command: 'base' } };
  targetFile = fs.realpathSync(writeClaude(
    data.firstHome,
    JSON.stringify({ oauthAccount: { token: 'stale' }, mcpServers: base }),
  ));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: base }));
  await data.service.enableSharedScope();
  data.service.sharedScope.stopWatchers();

  armed = true;
  const firstPass = await data.service.reconcileSharedScope({ force: true });
  assert.deepEqual(firstPass, base);
  assert.equal(readClaude(data.firstHome).oauthAccount.token, 'fresh');
  assert.deepEqual(readClaude(data.secondHome).mcpServers, base);
  assert.equal(typeof scheduledCallback, 'function');

  const engine = data.service.sharedScope;
  const reconcile = engine.reconcile.bind(engine);
  let rescheduled;
  engine.reconcile = (options) => {
    const result = reconcile(options);
    if (!options?.force) rescheduled = result;
    return result;
  };
  scheduledCallback();
  await rescheduled;
  const expected = { ...base, fresh: { command: 'fresh' } };
  assert.deepEqual(readClaude(data.firstHome).mcpServers, expected);
  assert.deepEqual(readClaude(data.secondHome).mcpServers, expected);
});

test('watcher feedback from reconcile writes converges without a write loop', async (t) => {
  const callbacks = new Map();
  let feedbackWrites = 0;
  const data = fixture({
    sharedScopeDebounceMs: 5,
    sharedScopeWatch: (home, callback) => {
      callbacks.set(home, callback);
      return { close() {}, on() {}, unref() {} };
    },
    sharedScopeBeforeAtomicRename: ({ file }) => {
      if (path.basename(file) !== '.claude.json') return;
      const callback = callbacks.get(path.dirname(file));
      if (!callback) return;
      feedbackWrites += 1;
      callback('rename', '.claude.json');
    },
  });
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  await data.service.enableSharedScope();

  let reconcileCalls = 0;
  const engine = data.service.sharedScope;
  const reconcile = engine.reconcile.bind(engine);
  engine.reconcile = (options) => {
    reconcileCalls += 1;
    return reconcile(options);
  };
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { added: { command: 'one' } } }));
  callbacks.get(fs.realpathSync(data.firstHome))('change', '.claude.json');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(readClaude(data.secondHome).mcpServers, { added: { command: 'one' } });
  assert.equal(feedbackWrites, 1);
  assert.equal(reconcileCalls, 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reconcileCalls, 2);
});

test('startup reconciliation propagates an edit made while the daemon was down', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { initial: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, {});
  const enabled = await data.service.enableSharedScope();
  data.service.sharedScope.stopWatchers();

  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { offline: { command: 'newest' } } }));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(data.firstHome, '.claude.json'), future, future);
  const restarted = new ModelDeckService(data.store, {
    claudeProfilesDir: data.profilesDir,
    sharedScopeDir: data.sharedDir,
    claudeActiveLink: path.join(data.root, 'active', '.claude'),
    codexProfilesDir: path.join(data.root, 'codex-profiles'),
    codexActiveLink: path.join(data.root, 'active', '.codex'),
    platform: 'linux',
    listProviderProcesses: async () => [],
  });
  await restarted.sharedScope.start();
  t.after(() => restarted.sharedScope.stopWatchers());
  assert.deepEqual(readClaude(data.secondHome).mcpServers, { offline: { command: 'newest' } });
  assert.deepEqual(restarted.sharedScope.status(), { enabled: true, lastOutcome: enabled });
});

test('startup preserves a canonical addition after a crash before every profile received it', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  const base = { base: { command: 'base' } };
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: base }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: base }));
  await data.service.enableSharedScope();
  data.service.sharedScope.stopWatchers();

  const expected = { ...base, survivedCrash: { command: 'survived' } };
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: expected }));
  fs.writeFileSync(path.join(data.sharedDir, 'mcp-servers.json'), `${JSON.stringify(expected, null, 2)}\n`);
  fs.writeFileSync(
    path.join(data.sharedDir, 'backups', data.first.id, 'last-applied.json'),
    `${JSON.stringify(expected, null, 2)}\n`,
  );

  const restarted = new ModelDeckService(data.store, {
    claudeProfilesDir: data.profilesDir,
    sharedScopeDir: data.sharedDir,
    claudeActiveLink: path.join(data.root, 'active', '.claude'),
    codexProfilesDir: path.join(data.root, 'codex-profiles'),
    codexActiveLink: path.join(data.root, 'active', '.codex'),
    sharedScopeWatch: () => ({ close() {}, on() {}, unref() {} }),
    platform: 'linux',
    listProviderProcesses: async () => [],
  });
  t.after(() => restarted.sharedScope.stopWatchers());
  await restarted.sharedScope.start();

  assert.deepEqual(readClaude(data.firstHome).mcpServers, expected);
  assert.deepEqual(readClaude(data.secondHome).mcpServers, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data.sharedDir, 'mcp-servers.json'), 'utf8')), expected);
});

test('startup resumes a persisted opt-in whose canonical enable files are missing', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { first: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: { second: { command: 'two' } } }));
  addUserMemory(data.firstHome, { 'memory.md': 'remembered' });
  data.store.saveSettings({ sharedUserScopeEnabled: true });

  await data.service.sharedScope.start();
  assert.deepEqual(readClaude(data.firstHome).mcpServers, {
    first: { command: 'one' }, second: { command: 'two' },
  });
  assert.deepEqual(readClaude(data.secondHome).mcpServers, {
    first: { command: 'one' }, second: { command: 'two' },
  });
  assert.equal(fs.lstatSync(path.join(data.secondHome, 'memory')).isSymbolicLink(), true);
  assert.equal(data.service.sharedScope.status().lastOutcome.enabled, true);
});

test('startup resumes a crash during memory linking without re-merging manifest profiles', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'collision.md': 'first' });
  addUserMemory(data.secondHome, { 'collision.md': 'second' });

  const engine = data.service.sharedScope;
  const linkMemory = engine.linkMemory.bind(engine);
  let calls = 0;
  engine.linkMemory = async (entry) => {
    calls += 1;
    if (calls === 2) throw new Error('simulated crash during memory linking');
    return linkMemory(entry);
  };
  await assert.rejects(() => data.service.enableSharedScope(), /simulated crash during memory linking/);
  assert.equal(data.store.getSettings().sharedUserScopeEnabled, true);
  const beforeResume = fs.readdirSync(path.join(data.sharedDir, 'memory')).sort();
  assert.equal(beforeResume.filter((name) => name.startsWith('collision.modeldeck-')).length, 1);

  engine.linkMemory = linkMemory;
  await engine.start();
  const afterResume = fs.readdirSync(path.join(data.sharedDir, 'memory')).sort();
  assert.deepEqual(afterResume, beforeResume);
  for (const home of [data.firstHome, data.secondHome]) {
    assert.equal(fs.lstatSync(path.join(home, 'memory')).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(home, 'memory')), fs.realpathSync(path.join(data.sharedDir, 'memory')));
  }
});

test('ambiguous layouts share MCP only and leave project-scoped memory untouched', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { one: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: { two: { command: 'two' } } }));
  const projectMemory = path.join(data.firstHome, 'projects', 'placeholder-project', 'memory');
  fs.mkdirSync(projectMemory, { recursive: true });
  fs.writeFileSync(path.join(projectMemory, 'MEMORY.md'), 'project scoped');

  const outcome = await data.service.enableSharedScope();
  assert.deepEqual(outcome.merged, { mcpServers: 2, memoryItems: 0 });
  assert.ok(outcome.skipped.some((item) => item.what === 'memory' && /ambiguous/.test(item.reason)));
  assert.equal(fs.existsSync(path.join(data.firstHome, 'memory')), false);
  assert.equal(fs.readFileSync(path.join(projectMemory, 'MEMORY.md'), 'utf8'), 'project scoped');
});

test('profiles added and removed while enabled join and leave the shared memory safely', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { initial: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'initial.md': 'initial memory' });
  await data.service.enableSharedScope();

  const thirdHome = path.join(data.profilesDir, 'third');
  fs.mkdirSync(thirdHome, { recursive: true, mode: 0o700 });
  writeClaude(thirdHome, JSON.stringify({ mcpServers: { third: { command: 'newest' } } }));
  addUserMemory(thirdHome, { 'third.md': 'third memory' });
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(thirdHome, '.claude.json'), future, future);
  const third = await data.service.saveAccount({ provider: 'claude', label: 'Third', profileRef: thirdHome });

  assert.equal(fs.lstatSync(path.join(thirdHome, 'memory')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(data.sharedDir, 'memory', 'third.md'), 'utf8'), 'third memory');
  assert.deepEqual(readClaude(data.firstHome).mcpServers, {
    initial: { command: 'one' }, third: { command: 'newest' },
  });
  assert.equal(fs.existsSync(path.join(data.sharedDir, 'backups', third.id, '.claude.json')), true);
  assert.equal(fs.existsSync(path.join(data.sharedDir, 'backups', third.id, 'memory')), true);

  assert.equal(await data.service.deleteAccount(third.id), true);
  assert.equal(fs.lstatSync(path.join(thirdHome, 'memory')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(thirdHome, 'memory', 'third.md'), 'utf8'), 'third memory');
});

test('profile-set changes and direct detaches are refused while disable is materializing memory', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'memory.md': 'value' });
  await data.service.enableSharedScope();

  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = data.service.sharedScope;
  const materializeMemory = engine.materializeMemory.bind(engine);
  let gated = false;
  engine.materializeMemory = async (profile) => {
    if (!gated) {
      gated = true;
      enteredResolve();
      await gate;
    }
    return materializeMemory(profile);
  };

  const disabling = data.service.disableSharedScope();
  await entered;
  await assert.rejects(() => engine.profileSetChanged(), { statusCode: 409 });
  await assert.rejects(() => engine.detachProfile(data.first), { statusCode: 409 });
  release();
  await disabling;
});

test('creating an account during enable succeeds and attaches it after the operation', async (t) => {
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  const data = fixture({
    sharedScopeWatch: () => ({ close() {}, on() {}, unref() {} }),
    sharedScopeBeforeAtomicRename: async ({ file }) => {
      if (held || file !== path.join(data.sharedDir, 'mcp-servers.json')) return;
      held = true;
      enteredResolve();
      await gate;
    },
  });
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { initial: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'initial.md': 'initial' });

  const enabling = data.service.enableSharedScope();
  await entered;
  const thirdHome = path.join(data.profilesDir, 'during-enable');
  fs.mkdirSync(thirdHome, { recursive: true, mode: 0o700 });
  writeClaude(thirdHome, JSON.stringify({ mcpServers: { deferred: { command: 'deferred' } } }));
  addUserMemory(thirdHome, { 'deferred.md': 'deferred memory' });
  const creating = data.service.saveAccount({ provider: 'claude', label: 'During Enable', profileRef: thirdHome });
  release();
  const [, created] = await Promise.all([enabling, creating]);

  assert.ok(data.store.getAccount(created.id));
  assert.equal(fs.lstatSync(path.join(thirdHome, 'memory')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(data.sharedDir, 'memory', 'deferred.md'), 'utf8'), 'deferred memory');
  assert.deepEqual(readClaude(data.firstHome).mcpServers, {
    initial: { command: 'one' }, deferred: { command: 'deferred' },
  });
  assert.equal(fs.existsSync(path.join(data.sharedDir, 'backups', created.id, 'last-applied.json')), true);
});

test('deleting an account during disable succeeds after a deferred non-concurrent detach', async (t) => {
  const data = fixture({ sharedScopeWatch: () => ({ close() {}, on() {}, unref() {} }) });
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'memory.md': 'value' });
  await data.service.enableSharedScope();

  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = data.service.sharedScope;
  const materializeMemory = engine.materializeMemory.bind(engine);
  let targetAccount;
  let targetCalls = 0;
  let targetActive = false;
  let concurrentTargetCall = false;
  engine.materializeMemory = async (profile) => {
    if (!targetAccount) {
      targetAccount = profile.account;
      enteredResolve();
      targetActive = true;
      targetCalls += 1;
      await gate;
      try { return await materializeMemory(profile); }
      finally { targetActive = false; }
    }
    if (profile.account.id === targetAccount.id) {
      if (targetActive) concurrentTargetCall = true;
      targetCalls += 1;
    }
    return materializeMemory(profile);
  };

  const disabling = data.service.disableSharedScope();
  await entered;
  const deleting = data.service.deleteAccount(targetAccount.id);
  release();
  const [, deleted] = await Promise.all([disabling, deleting]);

  assert.equal(deleted, true);
  assert.equal(data.store.getAccount(targetAccount.id), null);
  assert.equal(concurrentTargetCall, false);
  assert.equal(targetCalls, 2);
  assert.equal(fs.lstatSync(path.join(targetAccount.profileRef, 'memory')).isDirectory(), true);
});

test('materialization rejects an unrelated dangling symlink when shared memory is also missing', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'memory.md': 'value' });
  await data.service.enableSharedScope();

  const memoryPath = path.join(data.firstHome, 'memory');
  fs.unlinkSync(memoryPath);
  fs.symlinkSync(path.join(data.root, 'unrelated-missing-memory'), memoryPath, 'dir');
  fs.rmSync(path.join(data.sharedDir, 'memory'), { recursive: true, force: true });

  await assert.rejects(
    () => data.service.sharedScope.detachProfile(data.first),
    /managed user-memory symlink no longer points to the shared directory/,
  );
});

test('disable materializes the current shared state per profile and retains backups', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ oauthAccount: { emailAddress: 'first@example.invalid' }, mcpServers: { one: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ oauthAccount: { emailAddress: 'second@example.invalid' }, mcpServers: {} }));
  addUserMemory(data.firstHome, { 'original.md': 'original' });
  await data.service.enableSharedScope();
  fs.writeFileSync(path.join(data.sharedDir, 'memory', 'live.md'), 'live shared value');

  // An edit immediately before disable must win even if its watcher debounce
  // has not fired yet.
  writeClaude(data.secondHome, JSON.stringify({
    oauthAccount: { emailAddress: 'second@example.invalid' },
    mcpServers: { live: { command: 'latest' } },
  }));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(data.secondHome, '.claude.json'), future, future);

  const outcome = await data.service.disableSharedScope();
  assert.deepEqual(outcome, { enabled: false, merged: { mcpServers: 0, memoryItems: 0 }, conflicts: [], skipped: [] });
  assert.equal(data.store.getSettings().sharedUserScopeEnabled, false);
  for (const account of [data.first, data.second]) {
    const home = account.id === data.first.id ? data.firstHome : data.secondHome;
    assert.equal(fs.lstatSync(path.join(home, 'memory')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(home, 'memory', 'live.md'), 'utf8'), 'live shared value');
    assert.deepEqual(readClaude(home).mcpServers, { live: { command: 'latest' } });
    assert.equal(fs.existsSync(path.join(data.sharedDir, 'backups', account.id, '.claude.json')), true);
  }
});

test('disable without a manifest restores live shared memory instead of stale backups', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'memory.md': 'enable-time backup' });
  await data.service.enableSharedScope();
  fs.writeFileSync(path.join(data.sharedDir, 'memory', 'memory.md'), 'live shared value');
  fs.unlinkSync(path.join(data.sharedDir, 'manifest.json'));

  const outcome = await data.service.disableSharedScope();

  assert.deepEqual(outcome.skipped, []);
  for (const home of [data.firstHome, data.secondHome]) {
    assert.equal(fs.lstatSync(path.join(home, 'memory')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(home, 'memory', 'memory.md'), 'utf8'), 'live shared value');
  }
});

test('disable without a manifest discloses fallback when only memory backups remain', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: {} }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'memory.md': 'enable-time backup' });
  await data.service.enableSharedScope();
  fs.unlinkSync(path.join(data.sharedDir, 'manifest.json'));
  fs.rmSync(path.join(data.sharedDir, 'memory'), { recursive: true, force: true });

  const outcome = await data.service.disableSharedScope();

  assert.ok(outcome.skipped.some((item) => item.what === 'memory' && /backups or empty directories/.test(item.reason)));
  assert.equal(fs.lstatSync(path.join(data.firstHome, 'memory')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(data.firstHome, 'memory', 'memory.md'), 'utf8'), 'enable-time backup');
  assert.equal(fs.lstatSync(path.join(data.secondHome, 'memory')).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.join(data.secondHome, 'memory')), []);
});

test('disable repairs managed dangling memory links after the shared directory was deleted', async (t) => {
  const data = fixture();
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { one: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'original.md': 'original' });
  await data.service.enableSharedScope();
  fs.rmSync(data.sharedDir, { recursive: true, force: true });

  const outcome = await data.service.disableSharedScope();
  assert.equal(outcome.enabled, false);
  assert.ok(outcome.skipped.some((item) => item.what === 'memory' && /manifest missing or unreadable/.test(item.reason)));
  assert.equal(data.store.getSettings().sharedUserScopeEnabled, false);
  for (const home of [data.firstHome, data.secondHome]) {
    const memoryPath = path.join(home, 'memory');
    assert.equal(fs.lstatSync(memoryPath).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(memoryPath), []);
    fs.writeFileSync(path.join(memoryPath, 'writable.md'), 'independent again');
  }
});

test('an injected failure before profile rename leaves .claude.json complete and original', async (t) => {
  let data;
  let injected = false;
  data = fixture({
    sharedScopeBeforeAtomicRename: ({ file }) => {
      if (path.basename(file) === '.claude.json') {
        injected = true;
        throw new Error('simulated crash before rename');
      }
    },
  });
  t.after(() => data.close());
  const firstRaw = '{"oauthAccount":{"emailAddress":"first@example.invalid"},"mcpServers":{"one":{"command":"one"}}}\n';
  const secondRaw = '{"oauthAccount":{"emailAddress":"second@example.invalid"},"mcpServers":{"two":{"command":"two"}}}\n';
  writeClaude(data.firstHome, firstRaw);
  writeClaude(data.secondHome, secondRaw);
  addUserMemory(data.firstHome, {});

  await assert.rejects(() => data.service.enableSharedScope(), /simulated crash before rename/);
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(data.firstHome, '.claude.json'), 'utf8'), firstRaw);
  assert.equal(fs.readFileSync(path.join(data.secondHome, '.claude.json'), 'utf8'), secondRaw);
  assert.ok(JSON.parse(fs.readFileSync(path.join(data.firstHome, '.claude.json'), 'utf8')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(data.secondHome, '.claude.json'), 'utf8')));
  assert.equal(fs.readdirSync(data.firstHome).some((name) => name.includes('.modeldeck-')), false);
  assert.equal(data.store.getSettings().sharedUserScopeEnabled, false);
});

test('shared-scope endpoints are mutation guarded and expose the exact state contract', async (t) => {
  const data = fixture({ setTimeout: () => 0, clearTimeout: () => {} });
  const app = createApp({ store: data.store, service: data.service, host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await app.close();
    data.store.close();
    fs.rmSync(data.root, { recursive: true, force: true });
  });
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { one: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  addUserMemory(data.firstHome, { 'collision.md': 'first' });
  addUserMemory(data.secondHome, { 'collision.md': 'second' });
  await new Promise((resolve) => app.listen(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionResponse = await fetch(`${base}/api/session`);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  const mutate = (route, method = 'POST', body) => fetch(`${base}${route}`, {
    method,
    headers: {
      'x-modeldeck-token': session.token,
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  assert.equal((await fetch(`${base}/api/shared-scope/enable`, { method: 'POST' })).status, 403);
  let response = await mutate('/api/shared-scope/enable');
  assert.equal(response.status, 200);
  const enabled = (await response.json()).sharedScope;
  assert.equal(enabled.enabled, true);
  assert.deepEqual(Object.keys(enabled).sort(), ['conflicts', 'enabled', 'merged', 'skipped']);

  const memoryEntries = fs.readdirSync(path.join(data.sharedDir, 'memory')).sort();
  assert.equal(memoryEntries.filter((name) => name.startsWith('collision.modeldeck-')).length, 1);
  response = await mutate('/api/shared-scope/enable');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sharedScope, enabled);
  assert.deepEqual(fs.readdirSync(path.join(data.sharedDir, 'memory')).sort(), memoryEntries);

  response = await fetch(`${base}/api/state`);
  const state = await response.json();
  assert.deepEqual(state.sharedScope, { enabled: true, lastOutcome: enabled });

  response = await mutate('/api/settings', 'PUT', { layout: 'single-column' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sharedUserScopeEnabled, true);

  response = await mutate('/api/shared-scope/disable');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sharedScope, {
    enabled: false,
    merged: { mcpServers: 0, memoryItems: 0 },
    conflicts: [],
    skipped: [],
  });
});

test('a second shared-scope mutation receives a 409 while the first is in flight', async (t) => {
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const data = fixture({
    sharedScopeBeforeAtomicRename: async ({ file }) => {
      if (file.endsWith('mcp-servers.json')) {
        enteredResolve();
        await gate;
      }
    },
  });
  t.after(() => data.close());
  writeClaude(data.firstHome, JSON.stringify({ mcpServers: { one: { command: 'one' } } }));
  writeClaude(data.secondHome, JSON.stringify({ mcpServers: {} }));
  const first = data.service.enableSharedScope();
  await entered;
  await assert.rejects(() => data.service.disableSharedScope(), { statusCode: 409 });
  release();
  await first;
});

test('a settings PUT conflict restores the prior shared-scope opt-in value', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const conflict = new Error('a shared-scope operation is already in progress');
  conflict.statusCode = 409;
  const service = {
    applySharedScopeSettings: async () => { throw conflict; },
    stopAutoRefresh() {},
  };
  const port = 43210;
  const token = 'settings-conflict-token';
  const app = createApp({ store, service, host: '127.0.0.1', port, mutationToken: token });
  const request = Readable.from([Buffer.from(JSON.stringify({ sharedUserScopeEnabled: true }))]);
  Object.assign(request, {
    method: 'PUT',
    url: '/api/settings',
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-modeldeck-token': token,
      cookie: `modeldeck_session=${token}`,
    },
  });
  let status;
  let payload;
  const completed = new Promise((resolve) => {
    const response = {
      writeHead(value) { status = value; },
      end(value) {
        payload = JSON.parse(value);
        resolve();
      },
    };
    void app.server.listeners('request')[0](request, response);
  });

  await completed;
  assert.equal(status, 409);
  assert.deepEqual(payload, { error: conflict.message });
  assert.equal(store.getSettings().sharedUserScopeEnabled, false);
});
