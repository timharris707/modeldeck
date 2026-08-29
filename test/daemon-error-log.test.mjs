import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATUSLINE_SEA_COMMAND } from '../src/adapters/claude-statusline.mjs';
import { GROK_SEA_PROBE_COMMAND } from '../src/adapters/grok.mjs';
import {
  bootstrapDaemonStderr,
  maintainDaemonErrorLog,
  prepareDaemonErrorLog,
} from '../src/daemon-error-log.mjs';

test('installed-daemon error log rotates in place with owner-only permissions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-error-log-'));
  const logPath = path.join(root, 'data', 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  prepareDaemonErrorLog(logPath, { maxBytes: 64 });
  const fd = fs.openSync(logPath, 'a');
  t.after(() => fs.closeSync(fd));
  fs.writeSync(fd, 'a'.repeat(80));
  maintainDaemonErrorLog(logPath, { maxBytes: 64 });
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'a'.repeat(64));
  assert.equal(fs.readFileSync(logPath, 'utf8'), '');

  // The stderr fd remains attached to the active inode after rotation.
  fs.writeSync(fd, 'after rotation\n');
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'after rotation\n');
  fs.chmodSync(`${logPath}.1`, 0o644);
  maintainDaemonErrorLog(logPath, { maxBytes: 64 });
  assert.deepEqual(fs.readdirSync(path.dirname(logPath)).sort(), [
    'modeldeck.err.log',
    'modeldeck.err.log.1',
  ]);
  for (const file of [logPath, `${logPath}.1`]) {
    const stat = fs.statSync(file);
    assert.ok(stat.size <= 64);
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test('daemon stderr bootstrap captures direct fd 2 writes after re-exec', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-stderr-reexec-'));
  const logPath = path.join(root, 'Application Support', 'ModelDeck', 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fixture = path.join(root, 'stderr-fixture.mjs');
  const moduleUrl = new URL('../src/daemon-error-log.mjs', import.meta.url).href;
  fs.writeFileSync(fixture, [
    "import fs from 'node:fs';",
    `import { bootstrapDaemonStderr } from ${JSON.stringify(moduleUrl)};`,
    'bootstrapDaemonStderr({ logPath: process.env.MODELDECK_TEST_ERROR_LOG, enabled: true });',
    "fs.writeSync(2, 'direct fd diagnostic\\n');",
  ].join('\n'));
  const result = spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    env: { ...process.env, MODELDECK_TEST_ERROR_LOG: logPath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'direct fd diagnostic\n');
  assert.equal(result.stderr, '');
});

test('daemon stderr bootstrap passes a pre-opened append fd to execve', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-stderr-fd-'));
  const logPath = path.join(root, 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let shellCommand = null;

  assert.throws(
    () => bootstrapDaemonStderr({
      logPath,
      enabled: true,
      argv: ['/placeholder/modeldeckd'],
      env: {},
      execPath: '/placeholder/modeldeckd',
      pid: 42,
      execve: (_file, args) => {
        shellCommand = args[2];
        const redirect = shellCommand.match(/2>&(\d+)/);
        assert.ok(redirect, 'the shell redirect must name an inherited fd');
        const logFd = Number(redirect[1]);
        assert.equal(fs.fstatSync(logFd).isFile(), true);
        assert.equal(args.includes(logPath), false, 'the log path must not cross the exec boundary');
        fs.writeSync(logFd, 'pre-opened fd diagnostic\n');
      },
    }),
    /process\.execve returned without replacing the daemon/,
  );

  assert.match(shellCommand, /2>&\d+/);
  assert.doesNotMatch(shellCommand, /2>>/);
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'pre-opened fd diagnostic\n');
});

test('daemon stderr bootstrap preserves execve error when stdin restore also fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-stderr-cleanup-'));
  const logPath = path.join(root, 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const execveError = new Error('execve failed');
  const openSync = fs.openSync;

  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (file === '/dev/null') {
      assert.equal(openSync(file, flags, ...args), 0);
      return openSync(file, flags, ...args);
    }
    return openSync(file, flags, ...args);
  });

  assert.throws(
    () => bootstrapDaemonStderr({
      logPath,
      enabled: true,
      argv: ['/placeholder/modeldeckd'],
      env: {},
      execPath: '/placeholder/modeldeckd',
      pid: 42,
      execve: () => { throw execveError; },
    }),
    (error) => {
      assert.equal(error, execveError);
      assert.match(error.cause?.message, /could not restore stdin/);
      return true;
    },
  );
});

test('daemon stderr bootstrap refuses a symlink swapped in before the exec fd open', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-stderr-exec-link-'));
  const logPath = path.join(root, 'modeldeck.err.log');
  const victim = path.join(root, 'victim.txt');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(victim, 'do not change');

  const openSync = fs.openSync;
  let appendOpens = 0;
  let execCalls = 0;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (file === logPath && typeof flags === 'number' && (flags & fs.constants.O_APPEND)) {
      appendOpens += 1;
      if (appendOpens === 2) {
        fs.unlinkSync(logPath);
        fs.symlinkSync(victim, logPath);
      }
    }
    return openSync(file, flags, ...args);
  });

  assert.throws(
    () => bootstrapDaemonStderr({
      logPath,
      enabled: true,
      argv: ['/placeholder/modeldeckd'],
      env: {},
      execPath: '/placeholder/modeldeckd',
      pid: 42,
      execve: () => { execCalls += 1; },
    }),
    (error) => error?.code === 'ELOOP',
  );
  assert.equal(appendOpens, 2);
  assert.equal(execCalls, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not change');
});

for (const [failureKind, trigger, label] of [
  ['uncaught exception', 'setImmediate(() => { throw error; });', 'uncaughtException'],
  ['unhandled rejection', 'setImmediate(() => { void Promise.reject(error); });', 'unhandledRejection'],
]) {
  test(`daemon top-level sanitizer contains an escaping ${failureKind} to one redacted line`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-fatal-error-'));
    const logPath = path.join(root, 'modeldeck.err.log');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const fixture = path.join(root, 'fatal-error-fixture.mjs');
    const daemonEntryUrl = new URL('../src/daemon-entry.mjs', import.meta.url).href;
    fs.writeFileSync(fixture, [
      `await import(${JSON.stringify(daemonEntryUrl)});`,
      "const error = new Error('request failed at https://example.invalid/path?access_token=query-secret with Bearer bearer-secret, token=message-secret, key=key-secret');",
      "error.secret = 'property-secret';",
      "error.cause = new Error('cause-secret');",
      trigger,
    ].join('\n'));
    const logFd = fs.openSync(logPath, 'w', 0o600);
    const result = spawnSync(process.execPath, [fixture], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', logFd],
    });
    fs.closeSync(logFd);

    assert.equal(result.status, 1);
    const logged = fs.readFileSync(logPath, 'utf8');
    assert.equal(
      logged,
      `[modeldeck] ${label}: Error: request failed at https://example.invalid/path?[REDACTED] with Bearer [REDACTED], token=[REDACTED], key=[REDACTED]\n`,
    );
    for (const secret of [
      'query-secret', 'bearer-secret', 'message-secret', 'key-secret',
      'property-secret', 'cause-secret',
    ]) {
      assert.equal(logged.includes(secret), false, `${secret} must be absent from the log`);
    }
  });
}

test('daemon top-level sanitizer redacts colon-separated and bare Claude tokens', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-fatal-token-redaction-'));
  const logPath = path.join(root, 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fixture = path.join(root, 'fatal-token-fixture.mjs');
  const daemonEntryUrl = new URL('../src/daemon-entry.mjs', import.meta.url).href;
  const probes = 'credentials {"access_token": "sk-ant-oat01-JSONSECRET"}, token: COLONSECRET, bare sk-ant-BARESECRET';
  fs.writeFileSync(fixture, [
    `await import(${JSON.stringify(daemonEntryUrl)});`,
    `const error = new Error(${JSON.stringify(probes)});`,
    'setImmediate(() => { throw error; });',
  ].join('\n'));
  const logFd = fs.openSync(logPath, 'w', 0o600);
  const result = spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', logFd],
  });
  fs.closeSync(logFd);

  assert.equal(result.status, 1);
  const logged = fs.readFileSync(logPath, 'utf8');
  assert.equal(
    logged,
    '[modeldeck] uncaughtException: Error: credentials {"access_token=[REDACTED]}, token=[REDACTED], bare [REDACTED]\n',
  );
  for (const secret of ['sk-ant-oat01-JSONSECRET', 'COLONSECRET', 'sk-ant-BARESECRET']) {
    assert.equal(logged.includes(secret), false, `${secret} must be absent from the log`);
  }
});

test('daemon stderr bootstrap leaves internal SEA helper stderr attached to its caller', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-stderr-helper-'));
  const logPath = path.join(root, 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let execCalls = 0;

  const redirected = bootstrapDaemonStderr({
    logPath,
    enabled: true,
    argv: ['/placeholder/modeldeckd', 'modeldeck-internal-claude-usage-probe'],
    env: {},
    execPath: '/placeholder/modeldeckd',
    pid: 42,
    execve: () => { execCalls += 1; },
  });

  assert.equal(redirected, false);
  assert.equal(execCalls, 0);
  assert.equal(fs.existsSync(logPath), false);
});

test('daemon stderr bootstrap leaves Grok SEA helper stderr attached without touching the log', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-stderr-grok-helper-'));
  const logPath = path.join(root, 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let execCalls = 0;

  const redirected = bootstrapDaemonStderr({
    logPath,
    enabled: true,
    argv: ['/placeholder/modeldeckd', GROK_SEA_PROBE_COMMAND],
    env: {},
    execPath: '/placeholder/modeldeckd',
    pid: 42,
    execve: () => { execCalls += 1; },
  });

  assert.equal(redirected, false);
  assert.equal(execCalls, 0);
  assert.equal(fs.existsSync(logPath), false);
});

test('daemon stderr bypass pins the complete internal SEA command set', async () => {
  const { INTERNAL_SEA_COMMANDS } = await import('../src/daemon-error-log.mjs');
  assert.ok(INTERNAL_SEA_COMMANDS instanceof Set);
  assert.deepEqual([...INTERNAL_SEA_COMMANDS].sort(), [
    'modeldeck-internal-claude-usage-probe',
    GROK_SEA_PROBE_COMMAND,
    STATUSLINE_SEA_COMMAND,
  ].sort());
});

test('daemon log maintenance refuses active and rotated symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-error-log-link-'));
  const dataDir = path.join(root, 'data');
  const victim = path.join(root, 'victim.txt');
  const logPath = path.join(dataDir, 'modeldeck.err.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(victim, 'do not change');

  fs.symlinkSync(victim, logPath);
  assert.throws(
    () => prepareDaemonErrorLog(logPath, { maxBytes: 64 }),
    /refusing non-regular daemon log/,
  );
  fs.unlinkSync(logPath);
  fs.writeFileSync(logPath, 'safe');
  fs.symlinkSync(victim, `${logPath}.1`);
  assert.throws(
    () => maintainDaemonErrorLog(logPath, { maxBytes: 64 }),
    /refusing non-regular daemon log/,
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not change');
});
