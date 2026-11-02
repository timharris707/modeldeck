import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPoolClientKeyEffects } from '../scripts/pool-client-keys.mjs';
import { POOL_CLIENT_KEYS_USAGE } from '../src/pool-client-keys.mjs';
import { T3_POOL_KEY_SCRIPT } from '../src/t3-pool-key.mjs';

const KEY = Buffer.alloc(32, 0x42).toString('base64url');
const TOKEN = 'placeholder-host-mutation-token';

function fixture(t, { fail = false, fromEnv = false, exitCode = 0 } = {}) {
  const calls = [];
  const printed = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk, ...args) => {
      if (String(chunk).includes(KEY) || String(chunk).includes(TOKEN)) {
        printed.push(String(chunk));
        return true;
      }
      return write(chunk, ...args);
    });
  }
  const env = { PATH: '/untrusted/bin', SSH_AUTH_SOCK: '/fixture/agent.sock', HOME: '/fixture/home',
    USER: 'tester', LOGNAME: 'tester', NODE_OPTIONS: '--inspect', UNRELATED_SECRET: KEY,
    ...(fromEnv ? { MODELDECK_MUTATION_TOKEN: TOKEN } : {}) };
  const spawn = (binary, argv, options) => {
    const call = { binary, argv, options, stdin: '' };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = options.stdio[1] === 'pipe' ? new PassThrough() : null;
    child.stderr = options.stdio[2] === 'pipe' ? new PassThrough() : null;
    child.kill = () => child.emit('close', null);
    child.stdin = new Writable({
      write(chunk, encoding, done) { call.stdin += chunk.toString(); done(); },
      final(done) {
        done();
        queueMicrotask(() => {
          // Simulate security -i echoing stdin, and an install child that
          // writes secrets on both streams or attaches them to an error.
          if (options.stdio[1] === 'inherit') process.stdout.write(KEY);
          if (options.stdio[2] === 'inherit') process.stderr.write(KEY);
          child.stdout?.end(binary === '/usr/bin/security' ? TOKEN : KEY);
          child.stderr?.end(KEY);
          if (fail) child.emit('error', Object.assign(new Error(KEY), { stdout: KEY, stderr: KEY }));
          child.emit('close', fail ? 1 : exitCode);
        });
      },
    });
    return child;
  };
  return { calls, env, printed, effects: createPoolClientKeyEffects({ spawn, env, platform: 'darwin' }) };
}

test('#786 CLI wrapper preserves only SSH_AUTH_SOCK HOME USER LOGNAME and a fixed PATH', async (t) => {
  const data = fixture(t);
  await data.effects.ssh(['-T', '--', 'tester@client.invalid', 'placeholder-install'], { stdin: KEY });
  assert.deepEqual(data.calls[0].options.env, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SSH_AUTH_SOCK: '/fixture/agent.sock',
    HOME: '/fixture/home', USER: 'tester', LOGNAME: 'tester',
  });
  const fromEnv = fixture(t, { fromEnv: true });
  assert.equal(await fromEnv.effects.readMutationToken(), TOKEN);
  assert.equal(fromEnv.calls.length, 0);
  await fromEnv.effects.ssh(['--', 'tester@client.invalid', 'placeholder-install'], { stdin: KEY });
  assert.equal(Object.hasOwn(fromEnv.calls[0].options.env, 'MODELDECK_MUTATION_TOKEN'), false);
});

test('#786 CLI NO-PRINT TRIPWIRE: security/install stderr is discarded; keys stay off argv env stdout stderr and errors', async (t) => {
  for (const fail of [false, true]) {
    const data = fixture(t, { fail });
    for (const run of [() => data.effects.readMutationToken(),
      () => data.effects.ssh(['-T', '--', 'tester@client.invalid', 'placeholder-install'], { stdin: KEY })]) {
      if (fail) await assert.rejects(run(), (error) => {
        assert.equal(JSON.stringify({ message: error.message, stack: error.stack, ...error }).includes(KEY), false);
        assert.equal(error.message, 'external command failed');
        return true;
      });
      else await run();
    }
    for (const call of data.calls) {
      assert.equal(call.options.stdio[2], 'ignore');
      if (call.binary === '/usr/bin/ssh') assert.equal(call.options.stdio[1], 'ignore');
      const publicCall = JSON.stringify({ ...call, stdin: undefined });
      assert.equal(publicCall.includes(KEY), false, 'key leaked to child argv or environment');
      assert.equal(publicCall.includes(TOKEN), false, 'mutation token leaked to child argv or environment');
    }
    assert.equal(data.printed.length, 0, 'child secret reached stdout/stderr');
    assert.equal(data.calls.find((call) => call.binary === '/usr/bin/ssh').stdin, KEY);
  }
});

test('#786 CLI wrapper sanitizes synchronous spawn failures too', async () => {
  const effects = createPoolClientKeyEffects({ env: {}, platform: 'darwin', spawn() { throw new Error(KEY); } });
  let caught;
  try { await effects.ssh(['--', 'tester@client.invalid', 'placeholder-install'], { stdin: KEY }); }
  catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(String(caught.stack).includes(KEY), false, 'synchronous child error leaked its input');
  assert.equal(caught.message, 'external command failed');
});

test('#791 CLI NO-PRINT TRIPWIRE: Python install failures carry only a numeric exit code, never child output', async (t) => {
  const data = fixture(t, { exitCode: 20 });
  await assert.rejects(data.effects.ssh(['-T', '--', 'tester@client.invalid', '/usr/bin/python3 -I -c fixed-script /fixture/config.toml'], { stdin: KEY }), (error) => {
    assert.equal(error.exitCode, 20);
    assert.equal(error.message, 'external command failed');
    assert.equal(JSON.stringify({ ...error, stack: error.stack }).includes(KEY), false);
    return true;
  });
  assert.deepEqual(data.calls[0].options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(JSON.stringify({ ...data.calls[0], stdin: undefined }).includes(KEY), false);
  assert.deepEqual(data.printed, []);
});

test('#795 CLI T3 NO-PRINT TRIPWIRE: install stdin is private, and noisy children expose only fixed exit status', async (t) => {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const exitCode of [0, 20, 21, 22, 23, 255, null]) {
    const data = fixture(t, { exitCode });
    const install = () => data.effects.ssh(['-T', '--', 'tester@client.invalid',
      `/usr/bin/python3 -I -c ${quote(T3_POOL_KEY_SCRIPT)} install 'claude-pool'`], { stdin: KEY });
    if (exitCode === 0) await install();
    else await assert.rejects(install(), (error) => {
      assert.equal(error.message, 'external command failed');
      assert.equal(error.exitCode, exitCode ?? undefined);
      assert.equal(JSON.stringify({ ...error, stack: error.stack }).includes(KEY), false);
      return true;
    });
    assert.deepEqual(data.calls[0].options.stdio, ['pipe', 'ignore', 'ignore']);
    assert.equal(data.calls[0].stdin === KEY, true);
    assert.equal(JSON.stringify({ ...data.calls[0], stdin: undefined }).includes(KEY), false);
    assert.deepEqual(data.printed, []);
  }
});

test('#786 CLI symlink entry runs main and prints help without external effects', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-key-cli-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, 'pool-client-keys.mjs');
  fs.symlinkSync(fileURLToPath(new URL('../scripts/pool-client-keys.mjs', import.meta.url)), link);
  // Help is parsed before any credential read, network request or child spawn.
  const result = spawnSync(process.execPath, [link, '--help'], {
    encoding: 'utf8', timeout: 5000, cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: root, MODELDECK_SKIP_KEYCHAIN: '1' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${POOL_CLIENT_KEYS_USAGE}\n`);
});

// #809: a Linux pool host reads its own mutation token from the owner-only
// file (decision 0046); an unsafe file is refused, never read.
test('a Linux host reads the mutation token file and refuses an unsafe one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-keys-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'mutation-token');
  fs.writeFileSync(file, 'placeholder-host-token\n', { mode: 0o600 });
  const effects = createPoolClientKeyEffects({ platform: 'linux', env: {}, mutationTokenFile: file });
  assert.equal(await effects.readMutationToken(), 'placeholder-host-token');
  fs.chmodSync(file, 0o644);
  await assert.rejects(effects.readMutationToken(), /owner-only/);
  fs.rmSync(file);
  await assert.rejects(effects.readMutationToken(), /mutation token unavailable/);
});
