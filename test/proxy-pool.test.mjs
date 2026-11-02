import test from 'node:test';
import { LEGACY_CLIENT_KEY_HELPER } from '../src/client-key-helper.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';

const CLAUDE_EMAIL = 'pool-target@example.invalid';
const CODEX_ACCOUNT_ID = 'acct-pool-placeholder';
const CLIPROXY_PATH = '/fixture/bin/cliproxyapi';
const PROXY_BASE_URL = 'http://127.0.0.1:9137';
// The platform's helper: Keychain on macOS, the key file elsewhere (#808).
const API_KEY_HELPER = LEGACY_CLIENT_KEY_HELPER;
// PR #301 guarded form: pointer captured into a scratch var, exported only
// when non-empty. The marker line proves the routed rewrite ran.
const PINNED_PROXY_KEY = 'export ANTHROPIC_API_KEY="$__modeldeck_key"';
const EXPIRED = 'Claude usage refresh failed: stored OAuth credentials have expired; sign in explicitly before refreshing';

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let finished = false;
  child.finish = (code = 0, signal = null) => {
    if (finished) return;
    finished = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    queueMicrotask(() => child.finish(null, signal));
    return true;
  };
  return child;
}

function fixture(t, { spawn, serviceOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-proxypool-'));
  const claudeProfilesDir = path.join(root, 'claude-profiles');
  const codexProfilesDir = path.join(root, 'codex-profiles');
  const claudeHome = path.join(claudeProfilesDir, 'work');
  const codexHome = path.join(codexProfilesDir, 'work');
  const cliproxyAuthDir = path.join(root, 'cliproxy-auth');
  const cliproxyConfigDir = path.join(root, 'cliproxy-config');
  const claudeActiveLink = path.join(root, 'active', '.claude');
  const claudeShellEnvFile = path.join(root, 'claude-env.sh');
  for (const directory of [claudeProfilesDir, codexProfilesDir, claudeHome, codexHome, cliproxyAuthDir, cliproxyConfigDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  fs.mkdirSync(path.dirname(claudeActiveLink), { recursive: true });
  // Issue #625: the login spawn must name the serving proxy's config file.
  fs.writeFileSync(path.join(cliproxyConfigDir, 'config.yaml'), 'port: 9137\n', { mode: 0o600 });

  const store = new Store(':memory:');
  store.saveSettings({ claudeManaged: true, codexManaged: true });
  const claude = store.saveAccount({
    provider: 'claude',
    label: 'Pool Claude',
    identity: CLAUDE_EMAIL,
    profileRef: claudeHome,
    isDefault: true,
  });
  const codex = store.saveAccount({
    provider: 'codex',
    label: 'Pool Codex',
    identity: '',
    profileRef: codexHome,
    isDefault: true,
  });
  const service = new ModelDeckService(store, {
    claudeProfilesDir,
    codexProfilesDir,
    claudeActiveLink,
    claudeShellEnvFile,
    cliproxyAuthDir,
    cliproxyConfigDir,
    cliproxyPath: CLIPROXY_PATH,
    cliproxyBaseUrl: PROXY_BASE_URL,
    spawn: spawn || (() => fakeChild()),
    proxyJoinPollIntervalMs: 2,
    proxyJoinTimeoutMs: 80,
    platform: 'linux',
    claudeCredentialsPresent: async () => true,
    listProviderProcesses: async () => [],
    childEnv: { PATH: '/fixture/bin' },
    userInfo: () => ({ username: 'fixture-user' }),
    fetchClaude: async () => [{ scope: 'weekly', usedPercent: 10, source: 'fixture' }],
    ...serviceOptions,
  });

  t.after(async () => {
    await service.stopAutoRefresh();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    service,
    claude,
    codex,
    claudeHome,
    codexHome,
    cliproxyAuthDir,
    cliproxyConfigDir,
    claudeActiveLink,
    claudeShellEnvFile,
  };
}

function writeAuth(data, name, value) {
  fs.writeFileSync(path.join(data.cliproxyAuthDir, name), JSON.stringify(value), { mode: 0o600 });
}

async function rememberCodexIdentity(data) {
  fs.writeFileSync(
    path.join(data.codexHome, 'auth.json'),
    JSON.stringify({ tokens: { account_id: CODEX_ACCOUNT_ID, access_token: 'credential-never-consumed' } }),
    { mode: 0o600 },
  );
  await data.service.refreshCodexAccountIdentifier(data.codex);
}

test('Claude pool join spawns the exact login command and watches for its matching auth identity', async (t) => {
  const calls = [];
  let child;
  const data = fixture(t, {
    spawn(binary, args, options) {
      child = fakeChild();
      calls.push({ binary, args, options, child });
      queueMicrotask(() => writeAuth(data, 'claude-pool-target.json', {
        type: 'claude',
        email: CLAUDE_EMAIL.toUpperCase(),
        weight: 0,
        access_token: 'credential-never-consumed',
      }));
      return child;
    },
    serviceOptions: {
      childEnv: {
        PATH: '/fixture/bin',
        HOME: '/fixture/home',
        ANTHROPIC_API_KEY: 'expanded-key-must-not-reach-login',
        OPENAI_API_KEY: 'ambient-key-must-not-reach-login',
        MODELDECK_MUTATION_TOKEN: 'daemon-token-must-not-reach-login',
      },
    },
  });

  const joined = await data.service.joinProxyPool(data.claude.id);
  assert.deepEqual(joined, {
    accountId: data.claude.id,
    provider: 'claude',
    proxyPool: 'member',
    alreadyMember: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, CLIPROXY_PATH);
  assert.deepEqual(calls[0].args, ['-config', path.join(data.cliproxyConfigDir, 'config.yaml'), '-claude-login']);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, { HOME: '/fixture/home', PATH: '/fixture/bin' });
});

test('an account already in the pool returns without spawning another login', async (t) => {
  let spawns = 0;
  const data = fixture(t, { spawn: () => { spawns += 1; return fakeChild(); } });
  writeAuth(data, 'claude-existing.json', {
    type: 'claude', email: CLAUDE_EMAIL, weight: 4, refresh_token: 'credential-never-consumed',
  });

  assert.deepEqual(await data.service.joinProxyPool(data.claude.id), {
    accountId: data.claude.id,
    provider: 'claude',
    proxyPool: 'member',
    alreadyMember: true,
  });
  assert.equal(spawns, 0);
});

test('a join timeout kills the login child and reports a bounded honest failure', async (t) => {
  let child;
  const data = fixture(t, {
    spawn() { child = fakeChild(); return child; },
    serviceOptions: { proxyJoinTimeoutMs: 25 },
  });

  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), (error) => {
    assert.match(error.message, /timed out/i);
    return true;
  });
  assert.equal(child.killed, true);
});

test('join fails fast when the configured auth path cannot be watched', async (t) => {
  let spawns = 0;
  const data = fixture(t, { spawn: () => { spawns += 1; return fakeChild(); } });
  const notDirectory = path.join(data.root, 'cliproxy-auth-file');
  fs.writeFileSync(notDirectory, 'fixture');
  data.service.cliproxyAuthDir = notDirectory;

  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /auth directory is not readable \(ENOTDIR\)/);
    assert.ok(!error.message.includes(notDirectory), 'the configured path is not echoed');
    return true;
  });
  assert.equal(spawns, 0);
});

test('a different account auth file never satisfies the join watcher', async (t) => {
  let child;
  const data = fixture(t, {
    spawn() {
      child = fakeChild();
      queueMicrotask(() => writeAuth(data, 'claude-someone-else.json', {
        type: 'claude',
        email: 'someone-else@example.invalid',
        weight: 1,
        access_token: 'credential-never-consumed',
      }));
      return child;
    },
    serviceOptions: { proxyJoinTimeoutMs: 25 },
  });

  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), /timed out/i);
  assert.equal(child.killed, true);
});

test('a dead login child reports exit detail without leaking its token-bearing output', async (t) => {
  const secret = 'super-secret-placeholder';
  const data = fixture(t, {
    spawn() {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`open https://login.example.invalid/callback?token=${secret}\n`));
        child.stderr.emit('data', Buffer.from(`browser URL contained token=${secret}\n`));
        child.finish(23, null);
      });
      return child;
    },
  });

  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), (error) => {
    assert.match(error.message, /23/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(error.message, /https:\/\/login\.example\.invalid/);
    return true;
  });
});

// Issue #625 — Tim clicked "Add to proxy pool…" under coexist and the join
// failed twice: first the daemon's static PATH could not see ~/bin, then the
// helper it did find read /config.yaml from cwd `/` and exited 0. Every
// TRIPWIRE below fails on the pre-fix code.

/// An `exec` double standing in for lsof: the port listing and the per-pid
/// executable lookup are the only two calls the probe may make.
function fakeLsof({ pids = [], executables = {}, listFails = false } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === '-nP') {
      if (listFails) throw Object.assign(new Error('lsof: no match'), { code: 1 });
      return { stdout: `${pids.join('\n')}\n`, stderr: '' };
    }
    if (args[0] === '-p') {
      const executable = executables[args[1]];
      if (executable === undefined) throw new Error('process exited');
      return { stdout: `p${args[1]}\nftxt\nn${executable}\nftxt\nn/usr/lib/dyld\n`, stderr: '' };
    }
    throw new Error(`unexpected exec ${command} ${args.join(' ')}`);
  };
  return { exec, calls };
}

function executableFixture(root, name = 'cliproxyapi') {
  const file = path.join(root, 'serving', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

test('TRIPWIRE #625 login-spawn-passes-config — every login spawn names the config file under CLIPROXY_CONFIG_DIR', async (t) => {
  const calls = [];
  const data = fixture(t, {
    spawn(binary, args) {
      calls.push({ binary, args });
      const child = fakeChild();
      queueMicrotask(() => writeAuth(data, 'claude-pool-target.json', {
        type: 'claude', email: CLAUDE_EMAIL, weight: 0, access_token: 'credential-never-consumed',
      }));
      return child;
    },
  });
  await data.service.joinProxyPool(data.claude.id);
  assert.equal(calls.length, 1);
  const configIndex = calls[0].args.indexOf('-config');
  assert.notEqual(configIndex, -1, 'the login spawn must carry -config');
  assert.equal(calls[0].args[configIndex + 1], path.join(data.cliproxyConfigDir, 'config.yaml'));
  assert.equal(calls[0].args.at(-1), '-claude-login');
});

test('TRIPWIRE #625 join-refuses-without-config — a missing config.yaml is refused before any spawn, with a plain reason', async (t) => {
  let spawns = 0;
  const data = fixture(t, { spawn: () => { spawns += 1; return fakeChild(); } });
  fs.rmSync(path.join(data.cliproxyConfigDir, 'config.yaml'));

  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /config\.yaml is missing/);
    assert.ok(!error.message.includes(data.cliproxyConfigDir), 'the configured path is not echoed');
    return true;
  });
  assert.equal(spawns, 0);
});

test('TRIPWIRE #625 coexist-spawns-the-serving-binary — a bare cliproxyapi name resolves to the executable of the process on the proxy port', async (t) => {
  const calls = [];
  let data;
  const servingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-serving-'));
  t.after(() => fs.rmSync(servingRoot, { recursive: true, force: true }));
  const serving = executableFixture(servingRoot);
  const lsof = fakeLsof({ pids: ['4242'], executables: { 4242: serving } });
  data = fixture(t, {
    spawn(binary, args) {
      calls.push({ binary, args });
      const child = fakeChild();
      queueMicrotask(() => writeAuth(data, 'claude-pool-target.json', {
        type: 'claude', email: CLAUDE_EMAIL, weight: 0, access_token: 'credential-never-consumed',
      }));
      return child;
    },
    serviceOptions: {
      cliproxyPath: 'cliproxyapi',
      lsofPath: '/fixture/sbin/lsof',
      processUid: () => 501,
      exec: lsof.exec,
      toolPathFallbackDirs: [],
    },
  });

  await data.service.joinProxyPool(data.claude.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, serving, 'the spawned binary is the port holder, not the bare name');
  // The probe asked lsof for this user's listeners on the proxy port, then
  // the program text of that pid; PATH resolution (`which`) never ran.
  assert.deepEqual(lsof.calls.map((call) => call.args[0]), ['-nP', '-p']);
  assert.deepEqual(lsof.calls[0].args, ['-nP', '-iTCP:9137', '-sTCP:LISTEN', '-a', '-u', '501', '-t']);
  assert.deepEqual(lsof.calls[1].args, ['-p', '4242', '-a', '-d', 'txt', '-Fn']);
});

test('#625 an absolute configured binary path is honoured without probing the port', async (t) => {
  const lsof = fakeLsof({ pids: ['4242'], executables: { 4242: '/elsewhere/cliproxyapi' } });
  const calls = [];
  const data = fixture(t, {
    spawn(binary, args) {
      calls.push({ binary, args });
      const child = fakeChild();
      queueMicrotask(() => writeAuth(data, 'claude-pool-target.json', {
        type: 'claude', email: CLAUDE_EMAIL, weight: 0, access_token: 'credential-never-consumed',
      }));
      return child;
    },
    serviceOptions: { lsofPath: '/fixture/sbin/lsof', processUid: () => 501, exec: lsof.exec },
  });
  await data.service.joinProxyPool(data.claude.id);
  assert.equal(calls[0].binary, CLIPROXY_PATH);
  assert.deepEqual(lsof.calls, [], 'MODELDECK_CLIPROXY_BIN is the operator\'s word');
});

test('#625 the port probe trusts only a regular executable named cliproxyapi owned by a same-user listener', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-serving-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const impostor = executableFixture(root, 'not-the-proxy');
  const directory = path.join(root, 'cliproxyapi');
  fs.mkdirSync(directory);
  const unreadable = path.join(root, 'gone', 'cliproxyapi');
  const notExecutable = path.join(root, 'plain', 'cliproxyapi');
  fs.mkdirSync(path.dirname(notExecutable));
  fs.writeFileSync(notExecutable, 'not a program', { mode: 0o644 });
  const cases = [
    { name: 'a differently named program on the port', executables: { 1: impostor } },
    { name: 'a directory posing as the binary', executables: { 1: directory } },
    { name: 'a path that no longer exists', executables: { 1: unreadable } },
    { name: 'a regular file without the execute bit', executables: { 1: notExecutable } },
    { name: 'a relative program text', executables: { 1: 'cliproxyapi' } },
    { name: 'a pid that exited between the calls', executables: {} },
  ];
  for (const testCase of cases) {
    const lsof = fakeLsof({ pids: ['1'], executables: testCase.executables });
    const data = fixture(t, {
      serviceOptions: {
        cliproxyPath: 'cliproxyapi',
        lsofPath: '/fixture/sbin/lsof',
        processUid: () => 501,
        exec: lsof.exec,
        toolPathFallbackDirs: [],
      },
    });
    assert.equal(await data.service.servingProxyExecutable(), null, testCase.name);
  }
  // Nothing listening: lsof exits non-zero, the probe answers null.
  const idle = fakeLsof({ listFails: true });
  const data = fixture(t, {
    serviceOptions: { cliproxyPath: 'cliproxyapi', lsofPath: '/fixture/sbin/lsof', processUid: () => 501, exec: idle.exec },
  });
  assert.equal(await data.service.servingProxyExecutable(), null);
  // A non-loopback base URL is never probed: the port holder would be a
  // different machine's.
  const remote = fakeLsof({ pids: ['1'], executables: { 1: impostor } });
  const remoteData = fixture(t, {
    serviceOptions: {
      cliproxyPath: 'cliproxyapi', cliproxyBaseUrl: 'http://proxy.example.invalid:8317',
      lsofPath: '/fixture/sbin/lsof', processUid: () => 501, exec: remote.exec,
    },
  });
  assert.equal(await remoteData.service.servingProxyExecutable(), null);
  assert.deepEqual(remote.calls, []);
  // No uid to filter on means no probe at all: a listener owned by another
  // user must never be a candidate.
  const noUid = fakeLsof({ pids: ['1'], executables: { 1: impostor } });
  const noUidData = fixture(t, {
    serviceOptions: { cliproxyPath: 'cliproxyapi', lsofPath: '/fixture/sbin/lsof', processUid: () => null, exec: noUid.exec },
  });
  assert.equal(await noUidData.service.servingProxyExecutable(), null);
  assert.deepEqual(noUid.calls, []);
});

test('#625 an explicit null lsofPath disables the port probe even on macOS; unset picks the system lsof', async (t) => {
  const seen = [];
  const exec = async (command, args) => { seen.push([command, ...args]); throw Object.assign(new Error('no match'), { code: 1 }); };
  const disabled = fixture(t, {
    serviceOptions: { cliproxyPath: 'cliproxyapi', platform: 'darwin', lsofPath: null, processUid: () => 501, exec },
  });
  assert.equal(await disabled.service.servingProxyExecutable(), null);
  assert.deepEqual(seen, [], 'null must switch the probe off, not fall through to the default');

  const defaulted = fixture(t, {
    serviceOptions: { cliproxyPath: 'cliproxyapi', platform: 'darwin', processUid: () => 501, exec },
  });
  assert.equal(await defaulted.service.servingProxyExecutable(), null);
  assert.equal(seen[0]?.[0], '/usr/sbin/lsof');

  seen.length = 0;
  const linux = fixture(t, {
    serviceOptions: { cliproxyPath: 'cliproxyapi', platform: 'linux', processUid: () => 501, exec },
  });
  assert.equal(await linux.service.servingProxyExecutable(), null);
  assert.deepEqual(seen, [], 'no default lsof off macOS');
});

test('TRIPWIRE #625 unresolvable-binary-is-a-plain-refusal — no serving proxy and no PATH hit means a 409 that names the program, not a bare "failed to start"', async (t) => {
  let spawns = 0;
  const lsof = fakeLsof({ listFails: true });
  const data = fixture(t, {
    spawn: () => { spawns += 1; return fakeChild(); },
    serviceOptions: {
      cliproxyPath: 'cliproxyapi',
      lsofPath: '/fixture/sbin/lsof',
      processUid: () => 501,
      exec: async (command, args) => {
        if (command === '/usr/bin/which') throw Object.assign(new Error('not found'), { code: 1 });
        return lsof.exec(command, args);
      },
      toolPathFallbackDirs: [path.join(os.tmpdir(), 'modeldeck-625-no-such-dir')],
    },
  });

  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Couldn't find the cliproxyapi program/);
    return true;
  });
  assert.equal(spawns, 0);
});

// The code was never dropped by the daemon (the #625 review reproduced the
// pre-fix text: "...before a matching auth file appeared (ENOENT)"); it sat at
// the tail of an 85-character sentence in a two-line row. This guards both
// its presence and its position right after "failed to start".
test('TRIPWIRE #625 spawn-error-code-leads-the-message — a child that dies with ENOENT reports the code right after "failed to start"', async (t) => {
  const data = fixture(t, {
    spawn() {
      const child = fakeChild();
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('spawn cliproxyapi ENOENT'), { code: 'ENOENT' }));
        child.finish(-2, null);
      });
      return child;
    },
  });
  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /failed to start \(ENOENT\)/);
    return true;
  });
});

test('join concurrency is guarded per provider while Codex uses its remembered account id', async (t) => {
  const calls = [];
  let enteredClaude;
  const claudeStarted = new Promise((resolve) => { enteredClaude = resolve; });
  const data = fixture(t, {
    spawn(binary, args, options) {
      const child = fakeChild();
      calls.push({ binary, args, options, child });
      if (args.at(-1) === '-claude-login') {
        enteredClaude();
      } else if (args.at(-1) === '-codex-login') {
        queueMicrotask(() => writeAuth(data, 'codex-pool-target.json', {
          type: 'codex',
          account_id: CODEX_ACCOUNT_ID,
          weight: 2,
          access_token: 'credential-never-consumed',
        }));
      }
      return child;
    },
    serviceOptions: { proxyJoinTimeoutMs: 250 },
  });
  await rememberCodexIdentity(data);

  const claudeJoin = data.service.joinProxyPool(data.claude.id);
  await claudeStarted;
  await assert.rejects(() => data.service.joinProxyPool(data.claude.id), (error) => {
    assert.equal(error.statusCode, 409);
    return true;
  });

  const codexJoined = await data.service.joinProxyPool(data.codex.id);
  assert.deepEqual(codexJoined, {
    accountId: data.codex.id,
    provider: 'codex',
    proxyPool: 'member',
    alreadyMember: false,
  });
  assert.ok(calls.some((call) => call.binary === CLIPROXY_PATH
    && JSON.stringify(call.args) === JSON.stringify(['-config', path.join(data.cliproxyConfigDir, 'config.yaml'), '-codex-login'])));

  writeAuth(data, 'claude-pool-target.json', { type: 'claude', email: CLAUDE_EMAIL, weight: 3, access_token: 'credential-never-consumed' });
  assert.equal((await claudeJoin).proxyPool, 'member');
});

test('wire and unwire preserve unknown JSON values and the existing file mode', async (t) => {
  const data = fixture(t);
  const settingsPath = path.join(data.claudeHome, 'settings.json');
  const raw = `{
    "opaque string" : "  snowman ☃ and \\n stay exact  ",
    "unknownNested": { "enabled" : false, "items" : [null, 0, 1.25, {"x":"y"}] },
    "unsafeInteger": 9007199254740993,
    "negativeZero": -0,
    "preciseExponent": 1.2300e+40,
    "env" : { "KEEP_ME" : "  spaced value  ", "EMPTY" : "" },
    "statusLine": {"type":"command", "command":"printf placeholder"}
  }
  `;
  fs.writeFileSync(settingsPath, raw, { mode: 0o660 });
  fs.chmodSync(settingsPath, 0o660);
  const before = JSON.parse(raw);

  assert.deepEqual(await data.service.wireProxyRouting(data.claude.id), {
    accountId: data.claude.id,
    provider: 'claude',
    proxyRouted: true,
    cliproxyRouted: true,
    helperRouted: true,
  });
  const wiredRaw = fs.readFileSync(settingsPath, 'utf8');
  const wired = JSON.parse(wiredRaw);
  assert.deepEqual(wired, {
    ...before,
    env: { ...before.env, ANTHROPIC_BASE_URL: PROXY_BASE_URL },
    apiKeyHelper: API_KEY_HELPER,
  });
  assert.deepEqual(wired.unknownNested, before.unknownNested);
  assert.equal(wired['opaque string'], before['opaque string']);
  assert.match(wiredRaw, /"unsafeInteger": 9007199254740993/);
  assert.match(wiredRaw, /"negativeZero": -0/);
  assert.match(wiredRaw, /"preciseExponent": 1\.2300e\+40/);
  assert.equal(Object.hasOwn(wired.env, 'ANTHROPIC_API_KEY'), false);
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o660);

  assert.deepEqual(await data.service.unwireProxyRouting(data.claude.id), {
    accountId: data.claude.id,
    provider: 'claude',
    proxyRouted: false,
    cliproxyRouted: false,
    helperRouted: false,
  });
  const unwiredRaw = fs.readFileSync(settingsPath, 'utf8');
  const unwired = JSON.parse(unwiredRaw);
  assert.deepEqual(unwired, before);
  assert.match(unwiredRaw, /"unsafeInteger": 9007199254740993/);
  assert.match(unwiredRaw, /"negativeZero": -0/);
  assert.match(unwiredRaw, /"preciseExponent": 1\.2300e\+40/);
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o660);
  assert.equal(fs.readdirSync(data.claudeHome).some((name) => name.includes('.modeldeck-')), false);
});

test('unwire removes an empty env object and leaves every unknown key alone', async (t) => {
  const data = fixture(t);
  const settingsPath = path.join(data.claudeHome, 'settings.json');
  const opaque = { nested: ['one', { two: false }], text: 'placeholder' };
  fs.writeFileSync(settingsPath, JSON.stringify({ opaque, env: {}, apiKeyHelper: API_KEY_HELPER }), { mode: 0o600 });

  await data.service.unwireProxyRouting(data.claude.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { opaque });
});

test('routing the active Claude profile adds and removes the #277 shell Keychain pointer', async (t) => {
  const data = fixture(t);
  fs.symlinkSync(data.claudeHome, data.claudeActiveLink, 'dir');
  const realProfile = fs.realpathSync(data.claudeHome);
  await data.service.writeClaudeShellEnvFile(realProfile, false);

  await data.service.wireProxyRouting(data.claude.id);
  let content = fs.readFileSync(data.claudeShellEnvFile, 'utf8');
  assert.ok(content.includes(`export CLAUDE_CONFIG_DIR='${realProfile}'`));
  assert.ok(content.includes(`export CLAUDE_SECURESTORAGE_CONFIG_DIR='${realProfile}'`));
  assert.ok(content.includes(PINNED_PROXY_KEY));

  await data.service.unwireProxyRouting(data.claude.id);
  content = fs.readFileSync(data.claudeShellEnvFile, 'utf8');
  assert.ok(content.includes(`export CLAUDE_CONFIG_DIR='${realProfile}'`));
  assert.ok(content.includes(`export CLAUDE_SECURESTORAGE_CONFIG_DIR='${realProfile}'`));
  // Unwiring stops EXPORTING the key but must still CLEAR one ModelDeck
  // exported a moment ago, or a nested shell keeps it and this now-unrouted
  // profile authenticates with an API key instead of its OAuth
  // (CodeRabbit, PR #278).
  assert.ok(!/^export ANTHROPIC_API_KEY=/m.test(content));
  assert.ok(content.includes('unset ANTHROPIC_API_KEY MODELDECK_MANAGED_ANTHROPIC_API_KEY'));
});

test('routing aborts unchanged when active-profile identity cannot be read honestly', async (t) => {
  let data;
  data = fixture(t, {
    serviceOptions: {
      realpath: async (value) => {
        if (value === data.claudeActiveLink) {
          throw Object.assign(new Error('fixture active-link access denied'), { code: 'EACCES' });
        }
        return fs.promises.realpath(value);
      },
    },
  });
  const settingsPath = path.join(data.claudeHome, 'settings.json');
  const original = '{"opaque":{"preserve":"exactly"}}\n';
  fs.writeFileSync(settingsPath, original, { mode: 0o600 });

  await assert.rejects(() => data.service.wireProxyRouting(data.claude.id), { code: 'EACCES' });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  assert.equal(fs.existsSync(data.claudeShellEnvFile), false);
});

test('routing and statusline installation serialize settings updates without losing either', async (t) => {
  const data = fixture(t);
  const originalWrite = data.service.writeClaudeProfileSettings.bind(data.service);
  let heldStatuslineWrite = false;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  data.service.writeClaudeProfileSettings = async (settingsPath, content) => {
    if (!heldStatuslineWrite && content.includes('"statusLine"')) {
      heldStatuslineWrite = true;
      enteredResolve();
      await release;
    }
    return originalWrite(settingsPath, content);
  };

  const installing = data.service.installClaudeStatusline(data.claude.id);
  await entered;
  const wiring = data.service.wireProxyRouting(data.claude.id);
  releaseResolve();
  await Promise.all([installing, wiring]);

  const settings = JSON.parse(fs.readFileSync(path.join(data.claudeHome, 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, PROXY_BASE_URL);
  assert.equal(settings.apiKeyHelper, API_KEY_HELPER);
  assert.match(settings.statusLine.command, /claude-statusline\.mjs/);
});

test('routing refuses the same account while its Claude renewal is in flight', async (t) => {
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { releaseResolve = resolve; });
  const data = fixture(t, {
    serviceOptions: {
      exec: async (_command, args) => {
        if (args[0] === 'auth') {
          enteredResolve();
          await gate;
          return { stdout: JSON.stringify({ email: CLAUDE_EMAIL }), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    },
  });
  const settingsPath = path.join(data.claudeHome, 'settings.json');
  const original = '{"opaque":{"preserve":true}}\n';
  fs.writeFileSync(settingsPath, original, { mode: 0o600 });
  data.service.recordAccountRefreshResults([{ accountId: data.claude.id, ok: false, error: EXPIRED }]);

  const renewal = data.service.renewClaudeAccount(data.claude.id);
  await entered;
  try {
    await assert.rejects(() => data.service.wireProxyRouting(data.claude.id), (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    });
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  } finally {
    releaseResolve();
    await renewal;
  }
});

test('routing refuses the same account while its Claude activation is in flight', async (t) => {
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { releaseResolve = resolve; });
  const data = fixture(t, {
    serviceOptions: {
      activateClaude: async () => {
        enteredResolve();
        await gate;
      },
    },
  });
  await data.service.wireProxyRouting(data.claude.id);
  const settingsPath = path.join(data.claudeHome, 'settings.json');
  const wired = fs.readFileSync(settingsPath, 'utf8');

  const activation = data.service.activateAccount(data.claude.id);
  await entered;
  try {
    await assert.rejects(() => data.service.unwireProxyRouting(data.claude.id), (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    });
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), wired);
  } finally {
    releaseResolve();
    await activation;
  }
});

test('wire and unwire refuse to touch routing values ModelDeck did not write (#282 review, major 4)', async (t) => {
  const data = fixture(t);
  const settingsPath = path.join(data.claudeHome, 'settings.json');

  // A corporate gateway base URL: wiring over it would silently repoint the
  // user's sessions; unwiring would delete configuration the user owns.
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' },
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(data.service.wireProxyRouting(data.claude.id), /did not write/);
  await assert.rejects(data.service.unwireProxyRouting(data.claude.id), /did not write/);

  // A user-supplied apiKeyHelper is equally off-limits, even with our base.
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
    apiKeyHelper: 'my-own-helper --print-key',
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(data.service.unwireProxyRouting(data.claude.id), /apiKeyHelper/);

  // ModelDeck's own wiring still unwinds cleanly.
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
    apiKeyHelper: API_KEY_HELPER,
  }, null, 2)}\n`, { mode: 0o600 });
  const unwired = await data.service.unwireProxyRouting(data.claude.id);
  assert.equal(unwired.proxyRouted, false);
  assert.equal(unwired.cliproxyRouted, false);
  assert.equal(fs.existsSync(settingsPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {});
});

test('an identity-only auth file cannot satisfy membership (#282 review, minor)', async (t) => {
  const data = fixture(t);
  // A parseable torso with no credential material — a partial write or a
  // hand-made file. It must not read as a pool member.
  fs.writeFileSync(path.join(data.cliproxyAuthDir, 'claude-torso.json'), JSON.stringify({
    type: 'claude', email: CLAUDE_EMAIL,
  }));
  const accounts = await data.service.accountsWithAuthState([data.store.getAccount(data.claude.id)]);
  assert.equal(accounts[0].proxyPool, 'absent');
});

test('startup reconciles the shell pin against actual routing state (#282 review, major 2)', async (t) => {
  const data = fixture(t);
  // The crash aftermath: settings.json says UNROUTED (no base URL), but the
  // shell pin on disk still exports the proxy key from before the crash.
  fs.symlinkSync(data.claudeHome, data.claudeActiveLink);
  fs.writeFileSync(data.service.claudeShellEnvFile, [
    `export CLAUDE_CONFIG_DIR='${data.claudeHome}'`,
    `export CLAUDE_SECURESTORAGE_CONFIG_DIR='${data.claudeHome}'`,
    'export ANTHROPIC_API_KEY="stale-from-before-the-crash"',
    'export MODELDECK_MANAGED_ANTHROPIC_API_KEY=1',
    '',
  ].join('\n'), { mode: 0o600 });

  await data.service.reconcileClaudeShellEnvFile();
  const repaired = fs.readFileSync(data.service.claudeShellEnvFile, 'utf8');
  assert.ok(!/^\s*export ANTHROPIC_API_KEY=/m.test(repaired), 'unrouted profile must not export the key');
  assert.ok(repaired.includes('unset ANTHROPIC_API_KEY MODELDECK_MANAGED_ANTHROPIC_API_KEY'));

  // And the same call is a no-op repair in the routed direction.
  fs.writeFileSync(path.join(data.claudeHome, 'settings.json'), `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL },
    apiKeyHelper: API_KEY_HELPER,
  }, null, 2)}\n`, { mode: 0o600 });
  await data.service.reconcileClaudeShellEnvFile();
  const routed = fs.readFileSync(data.service.claudeShellEnvFile, 'utf8');
  // Form-agnostic: the exact pointer text belongs to the adapter's own
  // tests — here only the managed marker proves the routed rewrite ran.
  assert.ok(routed.includes('MODELDECK_MANAGED_ANTHROPIC_API_KEY=1'));
});
