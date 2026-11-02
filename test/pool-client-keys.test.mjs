import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import { runPoolClientKeys } from '../src/pool-client-keys.mjs';

const BYTES = Buffer.alloc(32, 0x42);
const KEY = BYTES.toString('base64url');
const digest = (key) => createHash('sha256').update(key).digest('hex');
const HASH = digest(KEY);
const PROXY = 'http://127.0.0.1:43279';
const DAEMON = 'http://127.0.0.1:43290';
const common = ['--proxy-base', PROXY, '--daemon-base', DAEMON, '--management-key-file', '/fixture/management-key'];
const add = ['add', '--machine', 'client-one', '--ssh', 'tester@client.invalid', '--client-daemon-port', '43291', ...common];
const revoke = ['revoke', '--machine', 'client-one', ...common];
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

function fixture(t, options = {}) {
  const store = new Store(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-key-operator-'));
  const service = new ModelDeckService(store, {
    dataDir: root, claudeProfilesDir: path.join(root, 'claude-profiles'),
    claudeActiveLink: path.join(root, 'claude-active'), codexActiveLink: path.join(root, 'codex-active'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    now: () => Date.parse('2026-10-30T13:00:00Z'),
    exec: async () => { assert.fail('unexpected external command'); },
  });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const proxyKeys = [...(options.proxyKeys ?? ['unrelated-key-placeholder'])];
  const requests = [];
  const sshCalls = [];
  const output = [];
  const stdout = [];
  const stderr = [];
  for (const [stream, captured] of [[process.stdout, stdout], [process.stderr, stderr]]) {
    const write = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk, encoding, callback) => {
      captured.push(String(chunk));
      // Forward the test runner's own protocol; intercept any planted leak
      // before it reaches the terminal, then let noPrint reject it.
      if (!String(chunk).includes(KEY)) return write(chunk, encoding, callback);
      if (typeof encoding === 'function') encoding();
      else callback?.();
      return true;
    });
  }
  const events = [];
  const effects = {
    managementKeyFile: '/fixture/management-key',
    randomBytes: (size) => { assert.equal(size, 32); events.push('mint'); return BYTES; },
    readFile: async (file) => { assert.equal(file, '/fixture/management-key'); return 'placeholder-management-secret\n'; },
    readMutationToken: async () => 'placeholder-mutation-token',
    output: (line) => output.push(line),
    fetch: async (url, request = {}) => {
      requests.push({ url: String(url), ...request });
      const target = new URL(url);
      const method = request.method ?? 'GET';
      if (target.origin === PROXY) {
        assert.equal(request.headers.Authorization, 'Bearer placeholder-management-secret');
        assert.equal(request.redirect, 'error');
        assert.equal(target.pathname, '/v0/management/api-keys');
        if (method === 'PATCH') {
          events.push('proxy-add');
          const body = JSON.parse(request.body);
          assert.equal(proxyKeys.includes(body.old), false, 'PATCH sentinel is unused');
          proxyKeys.push(body.new);
          if (options.fail === 'proxy-add') throw new Error(KEY);
        } else if (method === 'DELETE') {
          events.push('proxy-delete');
          assert.equal(target.searchParams.has('value'), false);
          if (options.shiftOnce) { proxyKeys.reverse(); options.shiftOnce = false; }
          if (!options.stuckDelete) proxyKeys.splice(Number(target.searchParams.get('index')), 1);
        } else {
          events.push('proxy-list');
          if (options.fail === 'verify' && proxyKeys.includes(KEY)) {
            options.fail = null;
            throw new Error(KEY);
          }
          return response({ 'api-keys': [...proxyKeys] });
        }
        return response({ status: 'ok' });
      }
      assert.equal(target.origin, DAEMON);
      assert.equal(target.pathname, '/api/pool-client-keys');
      if (method === 'POST') {
        assert.equal(request.headers['x-modeldeck-token'], 'placeholder-mutation-token');
        assert.equal(request.headers.Cookie, 'modeldeck_session=placeholder-mutation-token');
        assert.equal(request.headers.Origin, DAEMON);
        const body = JSON.parse(request.body);
        if (body.add) {
          events.push('register');
          if (options.releasedDaemon && body.add.some((entry) => !/^[a-z0-9-]+$/.test(entry.profileSlug))) {
            return { ...response({ error: KEY }, false), status: 400 };
          }
          if (options.fail === 'register') { options.fail = null; throw new Error(KEY); }
        } else if (body.revokeWhere) {
          events.push('revoke-selection');
        } else {
          events.push('revoke');
        }
        return response(service.updatePoolClientKeys(body));
      }
      return response({ keys: service.listPoolClientKeys() });
    },
    ssh: async (argv, { stdin = '', captureStdout = false } = {}) => {
      sshCalls.push({ argv, stdin, captureStdout });
      const command = argv.at(-1);
      if (command.includes('/api/state')) return JSON.stringify({ proxy: { role: options.role ?? 'remote' }, codexProfilesDir: options.codexProfilesDir, accounts: options.accounts ?? [
        { id: 'profile-one', label: 'Work', provider: 'claude', cliproxyRouted: true },
        { id: 'grok-one', label: 'Other', provider: 'grok' },
      ] });
      if (command.includes('/usr/bin/id')) return 'tester\n';
      if (command === '/usr/bin/printenv HOME') return `${options.clientHome ?? '/fixture'}\n`;
      if (command.endsWith(' list')) return JSON.stringify(options.t3Instances ?? []);
      if (command.includes('/client-key-helper')) {
        events.push('wire');
        if (options.fail === 'wire') throw new Error(KEY);
        return options.wireStatus ?? '200';
      } else if (stdin) {
        events.push('install');
        if (options.fail === 'install') throw Object.assign(new Error(KEY), { stdout: KEY, stderr: KEY });
      }
      return '';
    },
  };
  return { store, proxyKeys, requests, sshCalls, output, stdout, stderr, events, effects };
}

function noPrint(data, error = null) {
  const allowed = data.requests.filter((call) => call.url.startsWith(PROXY) && call.method === 'PATCH');
  for (const call of allowed) {
    assert.equal(JSON.stringify({ ...call, body: undefined }).includes(KEY), false);
  }
  for (const call of data.requests.filter((call) => !allowed.includes(call))) {
    assert.equal(JSON.stringify(call).includes(KEY), false, 'raw key leaked into a URL, daemon request or header');
  }
  for (const call of data.sshCalls) {
    assert.equal(JSON.stringify(call.argv).includes(KEY), false, 'raw key leaked into ssh argv');
    assert.equal(JSON.stringify({ ...call, stdin: undefined }).includes(KEY), false);
    if (call.stdin.includes(KEY)) {
      assert.ok(call.argv.at(-1).includes('/usr/bin/security -i') || call.argv.at(-1).includes('pool-client-key')
        || call.argv.at(-1).startsWith('/usr/bin/python3 -I -c '));
      assert.equal(call.captureStdout, false, 'install output is discarded');
    }
  }
  const stored = data.store.db.prepare('SELECT * FROM pool_client_keys').all();
  for (const value of [stored, data.output, data.stdout, data.stderr, error && { message: error.message, stack: error.stack, ...error }]) {
    assert.equal(JSON.stringify(value).includes(KEY), false, 'raw key leaked into storage, output or thrown error');
  }
}

function assertKeys(data, expected) {
  assert.deepEqual(data.proxyKeys.map(digest), expected.map(digest));
}

test('#795 T3 NO-PRINT TRIPWIRE: default selection registers and installs its own key only through PATCH and Python stdin', async (t) => {
  const data = fixture(t, { accounts: [], t3Instances: [{ id: 'claude-pool', displayName: 'Claude pool' }] });
  await runPoolClientKeys(add, data.effects);
  assert.deepEqual(data.events.filter((event) => event !== 'proxy-list'), ['mint', 'register', 'proxy-add', 'install']);
  const installs = data.sshCalls.filter((call) => call.stdin.includes(KEY));
  assert.equal(installs.length, 1);
  assert.equal(installs[0].stdin === KEY, true);
  assert.match(installs[0].argv.at(-1), /^\/usr\/bin\/python3 -I -c /);
  assert.match(installs[0].argv.at(-1), / install 'claude-pool'$/);
  assert.equal(installs[0].captureStdout, false);
  assert.equal(data.sshCalls.some((call) => call.argv.at(-1).includes('/usr/bin/security')), false);
  assert.equal(data.store.poolClientKeys()[0].profileSlug, 't3-claude-pool');
  assert.equal(data.store.poolClientKeys()[0].profileLabel, 'T3 Claude pool');
  assert.ok(data.output.includes(`Added T3 Claude pool ${HASH.slice(0, 8)}`));
  assert.equal(data.output.filter((line) => line.includes('Restart open Codex sessions and the T3 server')).length, 1);
  noPrint(data);
});

const t3Profile = { id: 'claude-pool', displayName: 'Claude pool' };

for (const [skipped, reason] of [
  [20, 'T3 instance not routed to the local forwarder'], [21, 'invalid T3 settings or key'],
  [22, 'unsafe T3 secret path or owner'], [23, 'T3 settings or secret read or write failed'],
]) {
  test(`#795 review: T3 discovery skip ${skipped} reports its id and reason and explicit selection aborts before minting with NO-PRINT`, async (t) => {
    for (const explicit of [false, true]) {
      const data = fixture(t, { accounts: [claudeProfile], t3Instances: [{ id: 'unkeyable', skipped }] });
      let error;
      if (explicit) {
        await assert.rejects(runPoolClientKeys([...add, '--profiles', 'profile-one,t3-unkeyable'], data.effects), (caught) => {
          error = caught; return caught.message === `T3 unkeyable: ${reason}`;
        });
        assert.equal(data.events.includes('mint'), false);
      } else {
        await runPoolClientKeys(add, data.effects);
        assert.deepEqual(data.output.filter((line) => line.startsWith('Skipped')), [`Skipped T3 unkeyable: ${reason}`]);
        assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
      }
      assert.equal(data.sshCalls.some((call) => call.argv.at(-1).endsWith(" check 'unkeyable'")), false);
      noPrint(data, error);
    }
  });
}

test('#795 review: T3 discovery skips are printed even when another T3 id is selected', async (t) => {
  const data = fixture(t, { accounts: [], t3Instances: [t3Profile, { id: 'unkeyable', skipped: 20 },
    { id: 'invalid-id', skipped: 21 }, { id: 'invalid-id', skipped: 21 }] });
  await runPoolClientKeys([...add, '--profiles', 't3-claude-pool'], data.effects);
  assert.deepEqual(data.output.filter((line) => line.startsWith('Skipped')), [
    'Skipped T3 unkeyable: T3 instance not routed to the local forwarder',
    'Skipped T3 invalid-id: invalid T3 settings or key', 'Skipped T3 invalid-id: invalid T3 settings or key',
  ]);
  noPrint(data);
});

test('#795 review: a released daemon rejecting an uppercase T3 slug gives the host upgrade instruction with NO-PRINT', async (t) => {
  const data = fixture(t, { accounts: [], releasedDaemon: true, t3Instances: [{ id: 'claudeAgent', displayName: 'Claude' }] });
  let error;
  await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => {
    error = caught;
    return caught.message === `client-one t3-claudeAgent ${HASH.slice(0, 8)}: register failed; rollback complete; the pool host's ModelDeck may be older than this tool, update it and re-run`;
  });
  assert.deepEqual(data.events.filter((event) => event !== 'proxy-list'), ['mint', 'register', 'revoke']);
  assertKeys(data, ['unrelated-key-placeholder']);
  assert.deepEqual(data.store.poolClientKeys(), []);
  noPrint(data, error);
});

test('#795 real client T3 discovery, check and install use one fixed Python script against a temporary home', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't3-pool-client-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userdata = path.join(root, '.t3', 'userdata');
  const secrets = path.join(userdata, 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const id = 'Claude_Pool';
  fs.writeFileSync(path.join(userdata, 'settings.json'), JSON.stringify({ providerInstances: { [id]: {
    driver: 'claudeAgent', enabled: true, displayName: ' Claude pool ', environment: [
      { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8317/' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '', sensitive: true },
    ],
  } } }));
  const file = path.join(secrets, `provider-env-${Buffer.from(id).toString('base64url')}-QU5USFJPUElDX0FVVEhfVE9LRU4.bin`);
  fs.writeFileSync(file, 'old-placeholder-plain-token', { mode: 0o600 });
  const data = fixture(t, { accounts: [] });
  const ssh = data.effects.ssh;
  data.effects.ssh = async (argv, options) => {
    const stubbed = await ssh(argv, options);
    if (!argv.at(-1).startsWith('/usr/bin/python3 -I -c ')) return stubbed;
    const env = { PATH: '/usr/bin:/bin', HOME: root };
    assert.equal(JSON.stringify({ argv, env }).includes(KEY), false);
    const result = spawnSync('/bin/sh', ['-c', argv.at(-1)], {
      input: options.stdin, encoding: 'utf8', timeout: 5000, env,
    });
    assert.equal((result.stdout + result.stderr).includes(KEY), false);
    assert.equal(result.status, 0);
    return result.stdout;
  };
  await runPoolClientKeys([...add, '--profiles', `t3-${id}`], data.effects);
  assert.equal(fs.readFileSync(file, 'utf8') === KEY, true);
  assert.equal(data.store.poolClientKeys()[0].profileSlug, `t3-${id}`);
  const commands = data.sshCalls.filter((call) => call.argv.at(-1).startsWith('/usr/bin/python3')).map((call) => call.argv.at(-1));
  assert.equal(commands.length, 3);
  assert.equal(commands[0].slice(0, -5), commands[1].slice(0, -` check '${id}'`.length));
  assert.equal(commands[0].slice(0, -5), commands[2].slice(0, -` install '${id}'`.length));
  await runPoolClientKeys([...revoke, '--profile', `t3-${id}`], data.effects);
  assert.ok(data.store.poolClientKeys()[0].revokedAt);
  noPrint(data);
});

test('#795 selection includes T3 by default, accepts t3 ids, respects --no-t3, and prints one shared restart notice', async (t) => {
  for (const args of [[], ['--profiles', 't3-claude-pool'], ['--no-t3'], ['--no-t3', '--no-codex']]) {
    const data = fixture(t, { accounts: [claudeProfile, codexProfile], t3Instances: [t3Profile] });
    let count = 0;
    data.effects.randomBytes = () => Buffer.alloc(32, 0x42 + count++);
    await runPoolClientKeys([...add, ...args], data.effects);
    assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug).sort(), args.includes('--profiles')
      ? ['t3-claude-pool'] : args.includes('--no-codex') ? ['profile-one'] : args.includes('--no-t3')
        ? ['codex-one', 'profile-one'] : ['codex-one', 'profile-one', 't3-claude-pool']);
    assert.equal(data.sshCalls.some((call) => call.argv.at(-1).endsWith(' list')), !args.includes('--no-t3'));
    assert.equal(data.events.filter((event) => event === 'wire').length, args.includes('--profiles') ? 0 : 1);
    assert.equal(data.output.filter((line) => line.includes('Restart open Codex sessions and the T3 server')).length, args.includes('--no-codex') ? 0 : 1);
    noPrint(data);
  }
});

for (const [exitCode, reason] of [
  [20, 'T3 instance not routed to the local forwarder'], [21, 'invalid T3 settings or key'],
  [22, 'unsafe T3 secret path or owner'], [23, 'T3 settings or secret read or write failed'], [127, 'T3 instance command failed'],
]) {
  test(`#795 T3 check ${exitCode} skips by id by default but explicit names abort before minting with NO-PRINT`, async (t) => {
    for (const explicit of [false, true]) {
      const data = fixture(t, { accounts: [claudeProfile], t3Instances: [t3Profile] });
      const ssh = data.effects.ssh;
      data.effects.ssh = (argv, options) => {
        if (argv.at(-1).endsWith(" check 'claude-pool'")) throw Object.assign(new Error(KEY), { exitCode, stdout: KEY, stderr: KEY });
        return ssh(argv, options);
      };
      let error;
      if (explicit) {
        await assert.rejects(runPoolClientKeys([...add, '--profiles', 'profile-one,t3-claude-pool'], data.effects), (caught) => {
          error = caught; return caught.message === `T3 claude-pool: ${reason}`;
        });
        assert.equal(data.events.includes('mint'), false);
      } else {
        await runPoolClientKeys(add, data.effects);
        assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
        assert.deepEqual(data.output.filter((line) => line.startsWith('Skipped')), [`Skipped T3 claude-pool: ${reason}`]);
      }
      noPrint(data, error);
    }
  });
}

test('#795 T3 discovery/check SSH failures stop the whole run, including killed commands', async (t) => {
  for (const mode of ['list', "check 'claude-pool'"]) for (const exitCode of [255, null, undefined]) {
    const data = fixture(t, { accounts: [claudeProfile], t3Instances: [t3Profile] });
    const ssh = data.effects.ssh;
    data.effects.ssh = (argv, options) => {
      if (argv.at(-1).endsWith(` ${mode}`)) throw Object.assign(new Error(KEY), { exitCode, stdout: KEY, stderr: KEY });
      return ssh(argv, options);
    };
    let error;
    await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => {
      error = caught; return /ssh to the client failed.*T3/.test(caught.message);
    });
    assert.equal(data.events.includes('mint'), false);
    noPrint(data, error);
  }
});

test('#795 malformed or failed T3 discovery is sanitized and skipped by default, explicit T3 aborts', async (t) => {
  for (const reply of [KEY, JSON.stringify([{ id: '../bad', displayName: KEY }]), JSON.stringify([{ ...t3Profile, secret: KEY }]),
    JSON.stringify([{ ...t3Profile, displayName: `bad\n${KEY}` }]), JSON.stringify([t3Profile, t3Profile]), null]) {
    for (const explicit of [false, true]) {
      const data = fixture(t, { accounts: [claudeProfile] });
      const ssh = data.effects.ssh;
      data.effects.ssh = (argv, options) => {
        if (argv.at(-1).endsWith(' list')) {
          if (reply === null) throw Object.assign(new Error(KEY), { exitCode: 21, stderr: KEY });
          return reply;
        }
        return ssh(argv, options);
      };
      let error;
      if (explicit) {
        await assert.rejects(runPoolClientKeys([...add, '--profiles', 't3-claude-pool'], data.effects), (caught) => {
          error = caught; return /T3 discovery: (invalid T3 discovery|invalid T3 settings or key)/.test(caught.message);
        });
        assert.equal(data.events.includes('mint'), false);
      } else {
        await runPoolClientKeys(add, data.effects);
        assert.deepEqual(data.output.filter((line) => line.startsWith('Skipped')), [reply === null
          ? 'Skipped T3 discovery: invalid T3 settings or key' : 'Skipped T3 discovery: invalid T3 discovery']);
      }
      noPrint(data, error);
    }
  }
});

test('#795 absent T3 settings are silent; unknown explicit ids, empty selections and T3/account id collisions abort', async (t) => {
  const data = fixture(t, { accounts: [claudeProfile], t3Instances: [] });
  await runPoolClientKeys(add, data.effects);
  assert.equal(data.output.some((line) => line.includes('T3')), false);
  for (const options of [{ accounts: [], t3Instances: [] }, { accounts: [{ ...claudeProfile, id: 't3-claude-pool' }], t3Instances: [t3Profile] }]) {
    const invalid = fixture(t, options);
    await assert.rejects(runPoolClientKeys(add, invalid.effects), /nothing to key|profile id conflicts/);
    assert.equal(invalid.events.includes('mint'), false);
  }
  const missing = fixture(t, { accounts: [claudeProfile], t3Instances: [] });
  await assert.rejects(runPoolClientKeys([...add, '--profiles', 't3-missing'], missing.effects), /profile not found/);
  assert.equal(missing.events.includes('mint'), false);
  const skipped = fixture(t, { accounts: [], t3Instances: [t3Profile] });
  const ssh = skipped.effects.ssh;
  skipped.effects.ssh = (argv, options) => {
    if (argv.at(-1).endsWith(" check 'claude-pool'")) throw Object.assign(new Error(KEY), { exitCode: 20 });
    return ssh(argv, options);
  };
  await assert.rejects(runPoolClientKeys(add, skipped.effects), /nothing to key/);
  assert.equal(skipped.events.includes('mint'), false);
});

test('#795 excluded Codex ids still prevent T3 collisions and rotation of an excluded account', async (t) => {
  const data = fixture(t, { accounts: [{ ...codexProfile, id: 't3-claude-pool' }], t3Instances: [t3Profile] });
  seedOldKeys(data, 't3-claude-pool');
  const before = data.proxyKeys.map(digest);
  await assert.rejects(runPoolClientKeys([...add, '--no-codex'], data.effects), /profile id conflicts/);
  assert.equal(data.events.includes('mint'), false);
  assert.deepEqual(data.proxyKeys.map(digest), before);
  assert.equal(data.store.poolClientKeys().some((row) => row.revokedAt), false);
  noPrint(data);
});

test('#795 T3 id grammar does not relax ModelDeck account validation before minting', async (t) => {
  for (const provider of ['claude', 'codex']) {
    const data = fixture(t, { accounts: [{ ...claudeProfile, id: 't3-Bad_ID', provider }] });
    await assert.rejects(runPoolClientKeys(add, data.effects));
    assert.equal(data.events.includes('mint'), false);
    assert.equal(data.requests.some((call) => call.method === 'PATCH'), false);
    assert.deepEqual(data.store.poolClientKeys(), []);
    noPrint(data);
  }
});

test('#795 the 32-profile cap counts routed T3, Claude and Codex together and excludes skipped T3', async (t) => {
  for (const skipped of [false, true]) {
    const data = fixture(t, { accounts: [...Array.from({ length: 31 }, (_, i) => ({ ...claudeProfile, id: `claude-${i}` })), codexProfile], t3Instances: [t3Profile] });
    const ssh = data.effects.ssh;
    data.effects.ssh = (argv, options) => {
      if (skipped && argv.at(-1).endsWith(" check 'claude-pool'")) throw Object.assign(new Error(KEY), { exitCode: 20 });
      return ssh(argv, options);
    };
    let count = 0;
    data.effects.randomBytes = () => Buffer.alloc(32, ++count);
    if (skipped) { await runPoolClientKeys(add, data.effects); assert.equal(count, 32); }
    else { await assert.rejects(runPoolClientKeys(add, data.effects), /at most 32 profiles/); assert.equal(count, 0); }
  }
});

test('#795 T3 rotates only its machine/instance after installation, with no wire step', async (t) => {
  const data = fixture(t, { accounts: [], t3Instances: [t3Profile] });
  seedOldKeys(data, 't3-claude-pool');
  await runPoolClientKeys(add, data.effects);
  assertKeys(data, ['unrelated-key-placeholder', 'other-profile-placeholder', 'other-machine-placeholder', KEY]);
  assert.equal(data.events.includes('wire'), false);
  assert.ok(data.events.indexOf('proxy-delete') > data.events.indexOf('install'));
  assert.equal(data.store.poolClientKeys().filter((row) => row.revokedAt).length, 2);
  noPrint(data);
});

test('#795 T3 NO-PRINT TRIPWIRE: failures before install roll back; install failures retain old and new keys', async (t) => {
  for (const fail of ['register', 'proxy-add', 'verify', 'install']) {
    const data = fixture(t, { accounts: [], t3Instances: [t3Profile], fail });
    seedOldKeys(data, 't3-claude-pool');
    let error;
    await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => {
      error = caught; return fail === 'install' ? /install unconfirmed: re-run add; T3 instance command failed/.test(caught.message) : /rollback complete/.test(caught.message);
    });
    assert.equal(data.proxyKeys.includes(KEY), fail === 'install');
    assert.equal(data.store.poolClientKeys().filter((row) => row.revokedAt && row.keySha256 !== HASH).length, 0);
    assert.equal(data.events.includes('install'), fail === 'install');
    if (fail === 'install') assert.equal(data.events.includes('proxy-delete'), false);
    noPrint(data, error);
  }
});

test('#791 Codex NO-PRINT TRIPWIRE: key travels only in proxy PATCH and python install stdin', async (t) => {
  const data = fixture(t, { accounts: [{ id: 'codex-one', label: 'Code', provider: 'codex', profileRef: '/fixture/.codex-profiles/codex-one' }] });
  await runPoolClientKeys([...add, '--profiles', 'codex-one'], data.effects);
  assert.deepEqual(data.events.filter((event) => event !== 'proxy-list'), ['mint', 'register', 'proxy-add', 'install']);
  const installs = data.sshCalls.filter((call) => call.stdin.includes(KEY));
  assert.equal(installs.length, 1);
  assert.equal(installs[0].stdin, KEY);
  assert.match(installs[0].argv.at(-1), /^\/usr\/bin\/python3 -I -c /);
  assert.equal(installs[0].captureStdout, false);
  assert.equal(data.sshCalls.some((call) => call.argv.at(-1).includes('/usr/bin/security')), false);
  assert.equal(data.store.poolClientKeys()[0].profileSlug, 'codex-one');
  assert.equal(data.store.poolClientKeys()[0].profileLabel, 'Code');
  assert.ok(data.output.some((line) => line.includes('Codex') && line.includes('Code') && line.includes(HASH.slice(0, 8))));
  noPrint(data);
});

test('#791 Codex rewrite is byte-identical except the token, including comments, other tables and CRLF', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pool-rewrite-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileRef = path.join(root, '.codex-profiles', 'codex-one');
  fs.mkdirSync(profileRef, { recursive: true });
  const config = path.join(profileRef, 'config.toml');
  const before = Buffer.from([
    '# Keep this comment', 'model_provider = "cliproxyapi" # chosen provider',
    '[model_providers.cliproxyapi] # forwarder', 'base_url = "http://127.0.0.1:8317/v1"',
    '  experimental_bearer_token  =  "old_placeholder"  # keep inline comment',
    'wire_api = "responses"', '', '[model_providers.other]',
    'experimental_bearer_token = "other_placeholder"', '# last comment', '',
  ].join('\r\n'));
  fs.writeFileSync(config, before, { mode: 0o640 });
  const data = fixture(t, { clientHome: root, accounts: [{ id: 'codex-one', label: 'Code', provider: 'codex', profileRef }] });
  await runPoolClientKeys([...add, '--profiles', 'codex-one'], data.effects);
  const install = data.sshCalls.find((call) => call.stdin === KEY);
  assert.ok(install, 'Codex install must exist before executing its fixed Python command');
  assert.match(install.argv.at(-1), /^\/usr\/bin\/python3 -I -c /);
  const result = spawnSync('/bin/sh', ['-c', install.argv.at(-1)], {
    input: install.stdin, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  // Apple's Python launcher can warn before Python starts in this sandbox.
  assert.equal(result.stderr.replaceAll("python3: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead\n", ''), '');
  assert.ok(fs.readFileSync(config).equals(Buffer.from(before.toString().replace('old_placeholder', KEY))), 'only the token bytes may change');
  assert.equal(fs.statSync(config).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(profileRef), ['config.toml'], 'no old-token backup or temporary file');
  noPrint(data);
});

const codexProfile = { id: 'codex-one', label: 'Code', provider: 'codex', profileRef: '/fixture/.codex-profiles/codex-one' };
const claudeProfile = { id: 'profile-one', label: 'Work', provider: 'claude', cliproxyRouted: true };

test('#791 review: default discovery skips an unmanaged Codex account and installs Claude and valid Codex keys', async (t) => {
  const data = fixture(t, { accounts: [
    { ...codexProfile, id: 'unmanaged', profileRef: '/fixture/.codex' }, claudeProfile, codexProfile,
  ] });
  let count = 0;
  data.effects.randomBytes = () => Buffer.alloc(32, 0x42 + count++);
  await runPoolClientKeys(add, data.effects);
  assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug).sort(), ['codex-one', 'profile-one']);
  assert.deepEqual(data.output.filter((line) => line.startsWith('Skipped')), ['Skipped Codex unmanaged: invalid Codex profile path']);
  assert.equal(data.events.filter((event) => event === 'wire').length, 1);
  assert.equal(count, 2);
  noPrint(data);
});

test('#791 selection includes Codex by default, accepts its id, and --no-codex skips it', async (t) => {
  for (const args of [[], ['--profiles', 'codex-one'], ['--no-codex']]) {
    const data = fixture(t, { accounts: [claudeProfile, codexProfile] });
    let count = 0;
    data.effects.randomBytes = () => Buffer.alloc(32, 0x42 + count++);
    await runPoolClientKeys([...add, ...args], data.effects);
    assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug).sort(),
      args.includes('--no-codex') ? ['profile-one'] : args.includes('--profiles') ? ['codex-one'] : ['codex-one', 'profile-one']);
    assert.equal(data.events.filter((event) => event === 'wire').length, args.includes('--profiles') ? 0 : 1);
    assert.equal(data.sshCalls.some((call) => call.argv.at(-1).startsWith('/usr/bin/python3') && !call.argv.at(-1).endsWith(' list')), !args.includes('--no-codex'));
    noPrint(data);
  }
});

test('#791 Codex preflight skips non-routed defaults and rejects explicitly named non-routed profiles before minting', async (t) => {
  for (const explicit of [false, true]) {
    const data = fixture(t, { accounts: [claudeProfile, codexProfile] });
    const ssh = data.effects.ssh;
    data.effects.ssh = (argv, options) => {
      if (argv.at(-1).endsWith(' check')) throw Object.assign(new Error(KEY), { exitCode: 20, stderr: KEY });
      return ssh(argv, options);
    };
    if (explicit) {
      await assert.rejects(runPoolClientKeys([...add, '--profiles', 'codex-one'], data.effects), /Codex profile not routed to the local forwarder/);
      assert.equal(data.events.includes('mint'), false);
    } else {
      await runPoolClientKeys(add, data.effects);
      assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
      assert.ok(data.output.includes('Skipped Codex codex-one: Codex profile not routed to the local forwarder'));
    }
    noPrint(data);
  }
});

test('#791 Codex odd paths fail before minting or running Python; custom daemon root is accepted', async (t) => {
  for (const profileRef of [undefined, '/tmp/unmanaged', '/fixture/.codex-profiles/../code', '/fixture/.codex-profiles/code;bad', '/fixture/.codex-profiles/code\n']) {
    const data = fixture(t, { accounts: [{ ...codexProfile, profileRef }] });
    await assert.rejects(runPoolClientKeys([...add, '--profiles', 'codex-one'], data.effects), /account codex-one: invalid Codex profile path/);
    assert.equal(data.events.includes('mint'), false);
    assert.equal(data.sshCalls.some((call) => call.argv.at(-1).startsWith('/usr/bin/python3')), false);
    noPrint(data);
  }
  const data = fixture(t, { codexProfilesDir: '/fixture/daemon/custom', accounts: [{ ...codexProfile, profileRef: '/fixture/daemon/custom/code' }] });
  await runPoolClientKeys(add, data.effects);
  assert.equal(data.store.poolClientKeys()[0].profileSlug, 'codex-one');
});

for (const [exitCode, reason] of [
  [20, 'Codex profile not routed to the local forwarder'], [21, 'invalid Codex config or bearer'],
  [22, 'unsafe Codex config path'], [23, 'Codex config read or write failed'], [24, 'Codex profile has no bearer'],
  [1, 'Codex config command failed'], [127, 'Codex config command failed'],
]) {
  test(`#791 review: Codex remote check ${exitCode} skips defaults by id but explicit selection aborts with NO-PRINT`, async (t) => {
    for (const explicit of [false, true]) {
      const data = fixture(t, { accounts: [codexProfile, claudeProfile] });
      const ssh = data.effects.ssh;
      data.effects.ssh = (argv, options) => {
        if (argv.at(-1).endsWith(' check')) throw Object.assign(new Error(KEY), { exitCode, stdout: KEY, stderr: KEY });
        return ssh(argv, options);
      };
      let error;
      if (explicit) {
        await assert.rejects(runPoolClientKeys([...add, '--profiles', 'codex-one,profile-one'], data.effects), (caught) => {
          error = caught;
          return caught.message === `account codex-one: ${reason}`;
        });
        assert.equal(data.events.includes('mint'), false);
      } else {
        await runPoolClientKeys(add, data.effects);
        assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
        assert.deepEqual(data.output.filter((line) => line.startsWith('Skipped')), [`Skipped Codex codex-one: ${reason}`]);
      }
      noPrint(data, error);
    }
  });
}

test('#791 review: invalid Codex labels skip defaults, abort explicit selection, and are ignored for unrouted accounts', async (t) => {
  for (const label of ['bad\nlabel', 'bad\u202elabel', 'x'.repeat(129)]) {
    for (const selection of ['default', 'explicit', 'unrouted', 'unselected']) {
      const data = fixture(t, { accounts: [{ ...codexProfile, label }, claudeProfile] });
      const ssh = data.effects.ssh;
      data.effects.ssh = (argv, options) => {
        if (selection === 'unrouted' && argv.at(-1).endsWith(' check')) throw Object.assign(new Error(KEY), { exitCode: 20 });
        return ssh(argv, options);
      };
      let error;
      if (selection === 'explicit') {
        await assert.rejects(runPoolClientKeys([...add, '--profiles', 'codex-one'], data.effects), (caught) => {
          error = caught;
          return caught.message === 'account codex-one: invalid Codex profile label';
        });
        assert.equal(data.events.includes('mint'), false);
      } else {
        await runPoolClientKeys(selection === 'unselected' ? [...add, '--profiles', 'profile-one'] : add, data.effects);
        assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
        const skips = data.output.filter((line) => line.startsWith('Skipped'));
        assert.deepEqual(skips, selection === 'unselected' ? [] : [selection === 'unrouted'
          ? 'Skipped Codex codex-one: Codex profile not routed to the local forwarder'
          : 'Skipped Codex codex-one: invalid Codex profile label']);
      }
      noPrint(data, error);
    }
  }
});

test('#791 review: missing Codex profileRef and unavailable client home do not block Claude', async (t) => {
  for (const missingHome of [false, true]) {
    const data = fixture(t, { accounts: [{ ...codexProfile, ...(!missingHome ? { profileRef: undefined } : {}) }, claudeProfile] });
    const ssh = data.effects.ssh;
    data.effects.ssh = (argv, options) => {
      if (missingHome && argv.at(-1) === '/usr/bin/printenv HOME') throw Object.assign(new Error(KEY), { exitCode: 1 }); // printenv failed; the link itself is fine
      return ssh(argv, options);
    };
    await runPoolClientKeys(add, data.effects);
    assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
    assert.equal(data.output.filter((line) => line.startsWith('Skipped Codex codex-one: ')).length, 1);
    noPrint(data);
  }
});

test('#791 review: a default selection containing only skipped Codex accounts fails without minting', async (t) => {
  const data = fixture(t, { accounts: [{ ...codexProfile, profileRef: undefined }] });
  await assert.rejects(runPoolClientKeys(add, data.effects), /nothing to key: every selected profile was skipped/);
  assert.equal(data.events.includes('mint'), false);
  assert.equal(data.requests.some((call) => call.url.startsWith(PROXY)), false);
  noPrint(data);
});

test('#791 review: add prints exactly one Codex and T3 restart notice only after a Codex install', async (t) => {
  const notice = 'Restart open Codex sessions and the T3 server on client-one so they read the new key.';
  for (const accounts of [[claudeProfile], [codexProfile], [codexProfile, { ...codexProfile, id: 'code-two', profileRef: '/fixture/.codex-profiles/code-two' }]]) {
    const data = fixture(t, { accounts });
    let count = 0;
    data.effects.randomBytes = () => Buffer.alloc(32, 0x42 + count++);
    const output = data.effects.output;
    data.effects.output = (line) => {
      if (line === notice) assert.ok(data.events.includes('install'));
      output(line);
    };
    await runPoolClientKeys(add, data.effects);
    assert.equal(data.output.filter((line) => line === notice).length, accounts[0].provider === 'codex' ? 1 : 0);
    noPrint(data);
  }
});

test('#791 the 32-profile cap counts Claude and Codex together', async (t) => {
  const accounts = [...Array.from({ length: 32 }, (_, i) => ({ ...claudeProfile, id: `claude-${i}` })), codexProfile];
  const data = fixture(t, { accounts });
  await assert.rejects(runPoolClientKeys(add, data.effects), /at most 32 profiles/);
  assert.equal(data.events.includes('mint'), false);
  let count = 0;
  data.effects.randomBytes = () => Buffer.alloc(32, ++count);
  await runPoolClientKeys([...add, '--profiles', accounts.slice(1).map((account) => account.id).join(',')], data.effects);
  assert.equal(count, 32);
  assert.equal(data.store.poolClientKeys().filter((row) => row.profileSlug === 'codex-one').length, 1);
});

test('#791 the 32-profile cap excludes Codex profiles that are not routed', async (t) => {
  const accounts = [claudeProfile, ...Array.from({ length: 32 }, (_, i) => ({ ...codexProfile, id: `code-${i}`, profileRef: `/fixture/.codex-profiles/code-${i}` }))];
  const data = fixture(t, { accounts });
  const ssh = data.effects.ssh;
  let checks = 0;
  data.effects.ssh = (argv, options) => {
    if (argv.at(-1).endsWith(' check')) { checks += 1; throw Object.assign(new Error(KEY), { exitCode: 20 }); }
    return ssh(argv, options);
  };
  await runPoolClientKeys(add, data.effects);
  assert.equal(checks, 32);
  assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
  noPrint(data);
});

test('#791 successful Codex install rotates only older keys for the same machine/profile without wiring', async (t) => {
  const data = fixture(t, { accounts: [codexProfile] });
  seedOldKeys(data, 'codex-one');
  await runPoolClientKeys(add, data.effects);
  assertKeys(data, ['unrelated-key-placeholder', 'other-profile-placeholder', 'other-machine-placeholder', KEY]);
  assert.equal(data.events.includes('wire'), false);
  assert.ok(data.events.indexOf('proxy-delete') > data.events.indexOf('install'));
  assert.equal(data.store.poolClientKeys().filter((row) => row.revokedAt).length, 2);
  noPrint(data);
});

test('#791 Codex NO-PRINT TRIPWIRE: fixed install failures preserve old and new admission without rollback', async (t) => {
  for (const [exitCode, reason] of [[20, 'not routed'], [21, 'invalid Codex config or bearer'], [22, 'unsafe Codex config path'], [23, 'read or write failed'], [255, 'Codex config command failed']]) {
    const data = fixture(t, { accounts: [codexProfile] });
    seedOldKeys(data, 'codex-one');
    const ssh = data.effects.ssh;
    data.effects.ssh = async (argv, options) => {
      const result = await ssh(argv, options);
      if (options.stdin === KEY) throw Object.assign(new Error(KEY), { exitCode, stdout: KEY, stderr: KEY });
      return result;
    };
    let error;
    await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => {
      error = caught;
      return caught.message.includes('install unconfirmed: re-run add') && caught.message.includes(reason);
    });
    assert.ok(data.proxyKeys.includes(KEY));
    assert.equal(data.events.includes('proxy-delete'), false);
    assert.equal(data.store.poolClientKeys().some((row) => row.revokedAt), false);
    noPrint(data, error);
  }
});

for (const fail of ['register', 'proxy-add', 'verify']) {
  test(`#791 Codex ${fail} failure before install rolls back safely with NO-PRINT`, async (t) => {
    const data = fixture(t, { accounts: [codexProfile], fail });
    let error;
    await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => { error = caught; return true; });
    assert.equal(data.events.includes('install'), false);
    assertKeys(data, ['unrelated-key-placeholder']);
    assert.ok(data.store.poolClientKeys().every((row) => row.revokedAt));
    noPrint(data, error);
  });
}

test('#786 NO-PRINT TRIPWIRE: add and revoke carry the raw key only in proxy PATCH and install stdin', async (t) => {
  const data = fixture(t);
  await runPoolClientKeys(add, data.effects);
  assert.deepEqual(data.events.filter((event) => event !== 'proxy-list'), ['mint', 'register', 'proxy-add', 'install', 'wire']);
  assert.ok(data.proxyKeys.includes(KEY));
  assert.equal(data.store.poolClientKeys()[0].keySha256, HASH);
  const install = data.sshCalls.find((call) => call.stdin.includes(KEY));
  assert.match(install.stdin, /delete-generic-password -s "cli-proxy-api-client.profile-one"/);
  assert.match(install.stdin, /add-generic-password -s "cli-proxy-api-client.profile-one" -a "tester"/);
  assert.ok(install.stdin.includes('-T /usr/bin/security'));
  const wire = data.sshCalls.find((call) => call.argv.at(-1).includes('/client-key-helper'));
  assert.ok(wire.argv.at(-1).includes('poolHostVerified'));
  assert.ok(wire.argv.at(-1).includes('--header @-'));
  assert.ok(wire.argv.at(-1).includes('mutation-token'));
  assert.ok(wire.argv.at(-1).includes('set +x'));
  await runPoolClientKeys(['list', ...common], data.effects);
  assert.ok(data.output.some((line) => line.includes(HASH.slice(0, 8))));
  const beforeRevoke = data.sshCalls.length;
  await runPoolClientKeys(revoke, data.effects);
  assert.equal(data.sshCalls.length, beforeRevoke, 'revoke never touches the client');
  assertKeys(data, ['unrelated-key-placeholder']);
  assert.ok(data.store.poolClientKeys()[0].revokedAt);
  noPrint(data);
});

test('#786 last-key revoke refuses before any deletion because an empty list accepts every request', async (t) => {
  const data = fixture(t, { proxyKeys: [KEY] });
  data.store.addPoolClientKey({ keySha256: HASH, machine: 'client-one' });
  await assert.rejects(runPoolClientKeys(revoke, data.effects), /empty list lets every request in/);
  assert.equal(data.events.includes('proxy-delete'), false);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  noPrint(data);
});

test('#786 empty-list add needs explicit key-checking consent before minting', async (t) => {
  const data = fixture(t, { proxyKeys: [] });
  await assert.rejects(runPoolClientKeys(add, data.effects), /first key turns key checking on.*keyless clients will get 401s/);
  assert.equal(data.events.includes('mint'), false);
  await runPoolClientKeys([...add, '--enable-key-checking'], data.effects);
  assertKeys(data, [KEY]);
  noPrint(data);
});

test('#786 failed first-key install keeps the sole admitted key active instead of rolling back to accept-all', async (t) => {
  const data = fixture(t, { proxyKeys: [], fail: 'install' });
  await assert.rejects(runPoolClientKeys([...add, '--enable-key-checking'], data.effects), /install unconfirmed: re-run add/);
  assertKeys(data, [KEY]);
  assert.equal(data.events.includes('proxy-delete'), false);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  noPrint(data);
});

function seedOldKeys(data, profileSlug = 'profile-one') {
  for (const [key, machine, profile] of [
    ['old-one-placeholder', 'client-one', profileSlug],
    ['old-two-placeholder', 'client-one', profileSlug],
    ['other-profile-placeholder', 'client-one', 'other-profile'],
    ['other-machine-placeholder', 'client-two', profileSlug],
  ]) {
    data.proxyKeys.push(key);
    data.store.addPoolClientKey({ keySha256: digest(key), machine, profileSlug: profile });
  }
}

for (const perMachine of [false, true]) {
  test(`#786 rotation removes all previous active keys only for the same machine/profile (${perMachine ? 'machine' : 'profile'})`, async (t) => {
    const data = fixture(t);
    seedOldKeys(data, perMachine ? null : 'profile-one');
    const ssh = data.effects.ssh;
    data.effects.ssh = (...args) => {
      assert.ok(data.proxyKeys.includes('old-one-placeholder'), 'old admission survives through install and wiring');
      return ssh(...args);
    };
    await runPoolClientKeys(perMachine ? [...add, '--per-machine'] : add, data.effects);
    assertKeys(data, ['unrelated-key-placeholder', 'other-profile-placeholder', 'other-machine-placeholder', KEY]);
    assert.equal(data.store.poolClientKeys().filter((row) => row.revokedAt).length, 2);
    assert.equal(data.store.poolClientKeys().find((row) => row.keySha256 === HASH).revokedAt, null);
    noPrint(data);
  });
}

for (const platform of ['darwin', 'linux']) {
  test(`#786 install failure keeps both generations live and rerun completes rotation (${platform})`, async (t) => {
    const options = { fail: 'install' };
    const data = fixture(t, options);
    const args = platform === 'linux' ? [...add, '--per-machine', '--platform', platform] : add;
    seedOldKeys(data, platform === 'linux' ? null : 'profile-one');
    const oldKeys = [...data.proxyKeys];
    const oldRows = data.store.poolClientKeys();
    const ssh = data.effects.ssh;
    let installedKey;
    data.effects.ssh = (argv, input) => {
      // The remote write may finish before SSH loses its response.
      if (input.stdin.includes(KEY)) installedKey = KEY;
      return ssh(argv, input);
    };
    let error;
    await assert.rejects(runPoolClientKeys(args, data.effects), (caught) => {
      error = caught;
      return /install unconfirmed: re-run add/.test(caught.message);
    });
    assert.equal(installedKey === KEY, true);
    assertKeys(data, [...oldKeys, KEY]);
    assert.deepEqual(data.store.poolClientKeys().filter((row) => row.keySha256 !== HASH), oldRows);
    assert.equal(data.store.poolClientKeys().find((row) => row.keySha256 === HASH).revokedAt, null);
    assert.equal(data.events.includes('proxy-delete'), false);
    assert.equal(data.events.includes('revoke'), false);
    noPrint(data, error);
    options.fail = null;
    const nextKey = Buffer.alloc(32, 0x43).toString('base64url');
    data.effects.randomBytes = () => Buffer.alloc(32, 0x43);
    await runPoolClientKeys(args, data.effects);
    assertKeys(data, ['unrelated-key-placeholder', 'other-profile-placeholder', 'other-machine-placeholder', nextKey]);
    assert.ok(data.store.poolClientKeys().find((row) => row.keySha256 === HASH).revokedAt);
    noPrint(data);
  });
}

test('#786 installed-but-not-wired preserves both generations and rerun completes rotation', async (t) => {
  const options = { fail: 'wire' };
  const data = fixture(t, options);
  seedOldKeys(data);
  await assert.rejects(runPoolClientKeys(add, data.effects), /installed but not wired: wire request failed/);
  assert.ok(data.proxyKeys.includes(KEY));
  assert.ok(data.proxyKeys.includes('old-one-placeholder'));
  assert.ok(data.store.poolClientKeys().every((row) => !row.revokedAt));
  options.fail = null;
  data.effects.randomBytes = () => Buffer.alloc(32, 0x43);
  await runPoolClientKeys(add, data.effects);
  assertKeys(data, ['unrelated-key-placeholder', 'other-profile-placeholder', 'other-machine-placeholder', Buffer.alloc(32, 0x43).toString('base64url')]);
  assert.equal(data.store.poolClientKeys().filter((row) => row.machine === 'client-one' && row.profileSlug === 'profile-one' && !row.revokedAt).length, 1);
  noPrint(data);
});

test('#786 stale active rows revoke by selection, repeated revoke says already revoked', async (t) => {
  const data = fixture(t);
  data.store.addPoolClientKey({ keySha256: HASH, machine: 'client-one', profileSlug: 'profile-one' });
  await runPoolClientKeys([...revoke, '--profile', 'profile-one'], data.effects);
  assert.ok(data.store.poolClientKeys()[0].revokedAt);
  assert.equal(data.events.includes('proxy-delete'), false);
  await runPoolClientKeys(revoke, data.effects);
  assert.match(data.output.at(-1), /already revoked/);
  noPrint(data);
});

for (const command of ['revoke', 'rotation']) {
  test(`#786 ${command} sends exact hashes and initial absent prefixes, preserving a row added mid-run`, async (t) => {
    const data = fixture(t);
    const oldHash = digest('previous-placeholder');
    const absentHash = digest('absent-placeholder');
    const concurrentKey = 'new-writer-placeholder';
    data.proxyKeys.push('previous-placeholder');
    for (const keySha256 of [oldHash, absentHash]) {
      data.store.addPoolClientKey({ keySha256, machine: 'client-one', profileSlug: 'profile-one' });
    }
    const fetch = data.effects.fetch;
    let selection;
    data.effects.fetch = (url, request) => {
      const body = request.body && JSON.parse(request.body);
      if (url.startsWith(DAEMON) && body?.revokeWhere) {
        selection = body.revokeWhere;
        data.proxyKeys.push(concurrentKey);
        data.store.addPoolClientKey({ keySha256: digest(concurrentKey), machine: 'client-one', profileSlug: 'profile-one' });
      }
      return fetch(url, request);
    };
    await runPoolClientKeys(command === 'revoke' ? [...revoke, '--profile', 'profile-one'] : add, data.effects);
    assert.equal(data.store.poolClientKeys().find((row) => row.keySha256 === digest(concurrentKey)).revokedAt, null,
      'a row the run never checked must remain active');
    assert.ok(data.proxyKeys.includes(concurrentKey));
    assert.deepEqual(selection, { machine: 'client-one', profileSlug: 'profile-one',
      keySha256s: [oldHash], hashPrefixes: [absentHash.slice(0, 8)] });
    for (const hash of [oldHash, absentHash]) assert.ok(data.store.poolClientKeys().find((row) => row.keySha256 === hash).revokedAt);
    if (command === 'rotation') assert.equal(data.store.poolClientKeys().find((row) => row.keySha256 === HASH).revokedAt, null);
    noPrint(data);
  });
}

test('#786 registration is confirmed before proxy PATCH, including lost registration responses', async (t) => {
  const data = fixture(t);
  const fetch = data.effects.fetch;
  data.effects.fetch = async (url, options) => {
    if (url.startsWith(PROXY) && options.method === 'PATCH') {
      assert.ok(data.store.poolClientKeys().some((row) => row.keySha256 === HASH && !row.revokedAt));
    }
    return fetch(url, options);
  };
  await runPoolClientKeys(add, data.effects);
  const lost = fixture(t);
  const fetchLost = lost.effects.fetch;
  lost.effects.fetch = async (url, options) => {
    const result = await fetchLost(url, options);
    if (url.startsWith(DAEMON) && options.body && JSON.parse(options.body).add) throw new Error(KEY);
    return result;
  };
  await assert.rejects(runPoolClientKeys(add, lost.effects), /register failed/);
  assert.equal(lost.events.includes('proxy-add'), false);
  assert.ok(lost.store.poolClientKeys()[0].revokedAt);
  noPrint(data);
  noPrint(lost);
});

test('#786 delete race never re-adds another writer\'s removed key and reports vanished/appeared prefixes', async (t) => {
  const bystander = 'deliberately-revoked-placeholder';
  const appeared = 'concurrently-added-placeholder';
  const data = fixture(t, { proxyKeys: ['unrelated-key-placeholder', KEY, bystander] });
  data.store.addPoolClientKey({ keySha256: HASH, machine: 'client-one' });
  const fetch = data.effects.fetch;
  data.effects.fetch = async (url, request) => {
    const result = await fetch(url, request);
    if (request.method === 'DELETE') {
      data.proxyKeys.splice(data.proxyKeys.indexOf(bystander), 1);
      data.proxyKeys.push(appeared);
    }
    return result;
  };
  let error;
  await assert.rejects(runPoolClientKeys(revoke, data.effects), (caught) => { error = caught; return true; });
  assert.match(error.message, /another writer changed api-keys during this run; check them/);
  assert.ok(error.message.includes(digest(bystander).slice(0, 8)));
  assert.ok(error.message.includes(digest(appeared).slice(0, 8)));
  assert.equal(error.message.includes(bystander), false);
  assert.equal(error.message.includes(appeared), false);
  assert.equal(data.events.includes('proxy-add'), false);
  assertKeys(data, ['unrelated-key-placeholder', appeared]);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  noPrint(data, error);
});

test('#786 empty list after a raced delete restores only our key and fails without revoking its row', async (t) => {
  const data = fixture(t, { proxyKeys: ['unrelated-key-placeholder', KEY] });
  data.store.addPoolClientKey({ keySha256: HASH, machine: 'client-one' });
  const fetch = data.effects.fetch;
  data.effects.fetch = async (url, request) => {
    const result = await fetch(url, request);
    if (request.method === 'DELETE') data.proxyKeys.length = 0;
    return result;
  };
  let error;
  await assert.rejects(runPoolClientKeys(revoke, data.effects), (caught) => { error = caught; return true; });
  assertKeys(data, [KEY]);
  assert.match(error.message, /another writer changed api-keys during this run; check them/);
  assert.match(error.message, /empty list.*restored our key/);
  assert.ok(error.message.includes(HASH.slice(0, 8)));
  assert.equal(data.events.filter((event) => event === 'proxy-add').length, 1);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  noPrint(data, error);
});

test('#786 delete stops when another writer restores the pre-delete list', async (t) => {
  const data = fixture(t, { proxyKeys: ['unrelated-key-placeholder', KEY] });
  data.store.addPoolClientKey({ keySha256: HASH, machine: 'client-one' });
  const fetch = data.effects.fetch;
  let deletes = 0;
  data.effects.fetch = async (url, request) => {
    const result = await fetch(url, request);
    if (request.method === 'DELETE' && ++deletes === 1) data.proxyKeys.push(KEY);
    return result;
  };
  let error;
  await assert.rejects(runPoolClientKeys(revoke, data.effects), (caught) => { error = caught; return true; });
  assert.match(error.message, /another writer changed api-keys during this run; check them/);
  assert.ok(error.message.includes(`appeared: ${HASH.slice(0, 8)}`));
  assert.equal(deletes, 1);
  assertKeys(data, ['unrelated-key-placeholder', KEY]);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  noPrint(data, error);
});

for (const change of ['addition', 'reorder']) {
  test(`#786 delete detects concurrent ${change} even without missing bystanders`, async (t) => {
    const data = fixture(t, { proxyKeys: [KEY, 'first-placeholder', 'second-placeholder'] });
    data.store.addPoolClientKey({ keySha256: HASH, machine: 'client-one' });
    const fetch = data.effects.fetch;
    data.effects.fetch = async (url, request) => {
      const result = await fetch(url, request);
      if (request.method === 'DELETE') {
        if (change === 'addition') data.proxyKeys.push('concurrently-added-placeholder');
        else data.proxyKeys.reverse();
      }
      return result;
    };
    let error;
    await assert.rejects(runPoolClientKeys(revoke, data.effects), (caught) => { error = caught; return true; });
    assert.match(error.message, /another writer changed api-keys during this run; check them/);
    if (change === 'addition') assert.ok(error.message.includes(digest('concurrently-added-placeholder').slice(0, 8)));
    assert.equal(data.events.includes('proxy-add'), false);
    assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
    noPrint(data, error);
  });
}

test('#786 per-profile preflight reads state once and refuses every non-remote role before minting', async (t) => {
  for (const role of ['host', '', 'unexpected']) {
    const data = fixture(t, { role });
    await assert.rejects(runPoolClientKeys(add, data.effects), /flip the client to remote role first/);
    assert.equal(data.events.includes('mint'), false);
    assert.equal(data.sshCalls.filter((call) => call.argv.at(-1).includes('/api/state')).length, 1);
  }
});

for (const platform of ['linux', 'darwin']) {
  test(`#786 per-machine ${platform} succeeds without a client daemon`, async (t) => {
    const data = fixture(t);
    const ssh = data.effects.ssh;
    let stateReads = 0;
    data.effects.ssh = (argv, options) => {
      if (argv.at(-1).includes('/api/state')) { stateReads += 1; throw new Error('unreachable'); }
      return ssh(argv, options);
    };
    await runPoolClientKeys([...add, '--per-machine', '--platform', platform], data.effects);
    assert.equal(stateReads, 0);
    assert.equal(data.events.includes('wire'), false);
    assert.equal(data.store.poolClientKeys()[0].profileSlug, null);
    assert.ok(data.proxyKeys.includes(KEY));
    noPrint(data);
  });
}

test('#786 selection skips direct and foreign-gateway Claude accounts and refuses explicit unrouted profiles', async (t) => {
  const data = fixture(t, { accounts: [
    { id: 'profile-one', label: 'Local', provider: 'claude', proxyRouted: true, cliproxyRouted: true },
    { id: 'direct', label: 'Direct', provider: 'claude', proxyRouted: false, cliproxyRouted: false },
    { id: 'foreign', label: 'Gateway', provider: 'claude', proxyRouted: true, cliproxyRouted: false },
  ] });
  await runPoolClientKeys(add, data.effects);
  assert.equal(data.store.poolClientKeys().length, 1);
  assert.ok(data.output.some((line) => /Skipped direct: profile not routed/.test(line)));
  assert.ok(data.output.some((line) => /Skipped foreign: profile not routed/.test(line)));
  assert.equal(data.sshCalls.filter((call) => call.argv.at(-1).includes('/api/state')).length, 1);
  data.events.length = 0;
  await assert.rejects(runPoolClientKeys([...add, '--profiles', 'direct'], data.effects), /wire refused: profile not routed/);
  assert.equal(data.events.includes('mint'), false);
});

test('#786 selected invalid labels name the account id and fail before minting', async (t) => {
  const account = { id: 'profile-one', label: 'Work', provider: 'claude', cliproxyRouted: true };
  for (const label of ['bad\u202elabel', 'bad\u200blabel', 'bad\nlabel', 'x'.repeat(129), '\u{1f469}\u200d\u{1f4bb}']) {
    const data = fixture(t, { accounts: [account, { ...account, id: 'profile-two', label }] });
    await assert.rejects(runPoolClientKeys(add, data.effects), /account profile-two: profileLabel/);
    assert.equal(data.events.includes('mint'), false);
    noPrint(data);
  }
});

for (const routed of [false, true]) {
  test(`#786 label validation ignores ${routed ? 'explicitly unselected' : 'unrouted'} accounts with emoji ZWJ labels`, async (t) => {
    const data = fixture(t, { accounts: [
      { id: 'profile-one', label: 'Work', provider: 'claude', cliproxyRouted: true },
      { id: 'profile-two', label: '\u{1f469}\u200d\u{1f4bb}', provider: 'claude', cliproxyRouted: routed },
    ] });
    await runPoolClientKeys(routed ? [...add, '--profiles', 'profile-one'] : add, data.effects);
    assert.deepEqual(data.store.poolClientKeys().map((row) => row.profileSlug), ['profile-one']);
    noPrint(data);
  });
}

test('#786 preflight caps default and explicit selection at 32 profiles', async (t) => {
  const accounts = Array.from({ length: 33 }, (_, i) => ({ id: `profile-${i}`, label: 'Work', provider: 'claude', cliproxyRouted: true }));
  const data = fixture(t, { accounts });
  await assert.rejects(runPoolClientKeys(add, data.effects), /at most 32 profiles/);
  await assert.rejects(runPoolClientKeys([...add, '--profiles', accounts.map((account) => account.id).join(',')], data.effects), /at most 32 profiles/);
  assert.equal(data.events.includes('mint'), false);
  let count = 0;
  data.effects.randomBytes = () => Buffer.alloc(32, ++count);
  await runPoolClientKeys([...add, '--profiles', accounts.slice(0, 32).map((account) => account.id).join(',')], data.effects);
  assert.equal(count, 32);
  assert.equal(data.store.poolClientKeys().length, 32);
});

test('#786 wire refusal reports a fixed reason class and preserves installed admission', async (t) => {
  const data = fixture(t, { wireStatus: '409' });
  await assert.rejects(runPoolClientKeys(add, data.effects), /installed but not wired: wire refused: conflict/);
  assert.ok(data.proxyKeys.includes(KEY));
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  const hostile = fixture(t, { wireStatus: KEY });
  let error;
  await assert.rejects(runPoolClientKeys(add, hostile.effects), (caught) => { error = caught; return /invalid wire response/.test(caught.message); });
  noPrint(hostile, error);
});

test('#786 a named keychain is refused for per-profile installs, whose helper reads the default list', async (t) => {
  const data = fixture(t);
  await assert.rejects(runPoolClientKeys([...add, '--keychain', '/tmp/scratch.keychain-db'], data.effects), /option does not apply/);
  assert.equal(data.sshCalls.length, 0);
  assert.equal(data.requests.length, 0);
});

test('#786 missing keychain path fails its remote file preflight before mint or security', async (t) => {
  const data = fixture(t);
  const ssh = data.effects.ssh;
  data.effects.ssh = (argv, options) => {
    if (argv.at(-1).includes('test -f')) throw new Error(KEY);
    return ssh(argv, options);
  };
  await assert.rejects(runPoolClientKeys([...add, '--per-machine', '--keychain', '/fixture/missing.keychain-db'], data.effects), /keychain path must name an existing file/);
  assert.equal(data.events.includes('mint'), false);
  assert.equal(data.events.includes('install'), false);
  noPrint(data);
});

test('#786 remote install rechecks keychain existence before invoking security (fake binary only)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'called');
  const fakeSecurity = path.join(root, 'security');
  fs.writeFileSync(fakeSecurity, `#!/bin/sh\nprintf 'called\\n' >> '${marker}'\n[ "$1" = delete-generic-password ] && exit 44\nexit 0\n`, { mode: 0o700 });
  const data = fixture(t);
  await runPoolClientKeys([...add, '--per-machine', '--keychain', path.join(root, 'missing.keychain-db')], data.effects);
  const install = data.sshCalls.find((call) => call.stdin.includes(KEY));
  // Replace every executable reference before the generated shell runs.
  // Even the unfixed version can only invoke this inert fake.
  const command = install.argv.at(-1).replaceAll('/usr/bin/security', fakeSecurity);
  const result = spawnSync('/bin/sh', ['-c', command], { input: install.stdin, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 2000 });
  assert.equal(result.status, 66);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(result.stdout + result.stderr, '');
});

test('#786 repeat revoke describes an already-revoked row accurately', async (t) => {
  const data = fixture(t);
  data.store.addPoolClientKey({ keySha256: HASH, machine: 'client-one' });
  data.store.revokePoolClientKey(HASH);
  await runPoolClientKeys(revoke, data.effects);
  assert.equal(data.output[0], `already revoked client-one - ${HASH.slice(0, 8)}`);
});

for (const profile of [null, 'missing-profile']) {
  test(`#786 revoke with no matching ${profile ? 'profile' : 'machine'} rows reports nothing to revoke and succeeds`, async (t) => {
    const data = fixture(t);
    data.store.addPoolClientKey({ keySha256: HASH, machine: profile ? 'client-one' : 'other', profileSlug: 'profile-one' });
    await runPoolClientKeys(profile ? [...revoke, '--profile', profile] : revoke, data.effects);
    assert.deepEqual(data.output, [`nothing to revoke for client-one${profile ? `/${profile}` : ''}`]);
    assert.equal(data.requests.length, 1, 'only the initial daemon list is needed');
    assert.equal(data.sshCalls.length, 0);
    assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
    noPrint(data);
  });
}

test('#786 revoke refuses the whole selection before deleting when it would empty the proxy', async (t) => {
  const data = fixture(t, { proxyKeys: [] });
  for (const key of ['first-placeholder', 'second-placeholder']) {
    data.proxyKeys.push(key);
    data.store.addPoolClientKey({ keySha256: digest(key), machine: 'client-one' });
  }
  await assert.rejects(runPoolClientKeys(revoke, data.effects), /empty list lets every request in/);
  assert.equal(data.events.includes('proxy-delete'), false);
  assert.ok(data.store.poolClientKeys().every((row) => !row.revokedAt));
});

test('#786 rotation also retires an old active row already absent from the proxy', async (t) => {
  const data = fixture(t);
  data.store.addPoolClientKey({ keySha256: digest('absent-old-placeholder'), machine: 'client-one', profileSlug: 'profile-one' });
  await runPoolClientKeys(add, data.effects);
  assert.ok(data.store.poolClientKeys().find((row) => row.keySha256 !== HASH).revokedAt);
  assert.equal(data.store.poolClientKeys().find((row) => row.keySha256 === HASH).revokedAt, null);
});

for (const fail of ['proxy-add', 'verify', 'register']) {
  test(`#786 ${fail} failure rolls back proxy admission and records revocation without leaking errors`, async (t) => {
    const data = fixture(t, { fail });
    let error;
    await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => { error = caught; return true; });
    assert.ok(error.message.includes(fail));
    assertKeys(data, ['unrelated-key-placeholder']);
    assert.ok(data.store.poolClientKeys().every((row) => row.revokedAt));
    noPrint(data, error);
  });
}

test('#786 install failure preserves proxy admission and the active row without leaking errors', async (t) => {
  const data = fixture(t, { fail: 'install' });
  let error;
  await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => {
    error = caught;
    return true;
  });
  assert.ok(data.proxyKeys.includes(KEY), 'install-unconfirmed key must stay admitted');
  assertKeys(data, ['unrelated-key-placeholder', KEY]);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  assert.equal(data.events.includes('proxy-delete'), false);
  assert.equal(data.events.includes('revoke'), false);
  assert.match(error.message, /install unconfirmed: re-run add/);
  noPrint(data, error);
});

test('#786 unconfirmed removal stops after one delete, keeps the live record active, and fails loudly', async (t) => {
  const data = fixture(t, { fail: 'verify', stuckDelete: true });
  await assert.rejects(runPoolClientKeys(add, data.effects), /another writer changed api-keys during this run; check them/);
  assert.equal(data.events.filter((event) => event === 'proxy-delete').length, 1);
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  assert.ok(data.proxyKeys.includes(KEY));
  noPrint(data);
});

test('#786 invalid explicit profile slugs are refused before any SSH call', async (t) => {
  const data = fixture(t);
  for (const id of ['work;touch /tmp/no', 'work\nnext', '../work', 'Work', 'a'.repeat(129)]) {
    await assert.rejects(runPoolClientKeys([...add, '--profiles', id], data.effects));
  }
  assert.equal(data.sshCalls.length, 0);
  assert.equal(data.requests.length, 0);
});

test('#786 invalid discovered ids are refused before mint or install; selection excludes other providers', async (t) => {
  const bad = fixture(t, { accounts: [{ provider: 'claude', id: 'work;false', label: 'Work', cliproxyRouted: true }] });
  await assert.rejects(runPoolClientKeys(add, bad.effects));
  assert.equal(bad.sshCalls.length, 1);
  assert.equal(bad.events.includes('mint'), false);
  const good = fixture(t);
  await runPoolClientKeys([...add, '--profiles', 'profile-one'], good.effects);
  assert.equal(good.store.poolClientKeys().length, 1);
  const absent = fixture(t);
  await assert.rejects(runPoolClientKeys([...add, '--profiles', 'codex-one'], absent.effects));
  assert.equal(absent.events.includes('mint'), false);
});

test('#786 per-machine Linux uses only stdin and fixes permissions before writing', async (t) => {
  const data = fixture(t);
  await runPoolClientKeys([...add, '--per-machine', '--platform', 'linux'], data.effects);
  assert.equal(data.sshCalls.length, 1, 'install only');
  const install = data.sshCalls[0];
  assert.equal(install.stdin, KEY);
  const command = install.argv.at(-1);
  assert.ok(command.includes('umask 077'));
  assert.ok(command.indexOf('chmod 600') < command.indexOf('cat >'));
  assert.equal(data.store.poolClientKeys()[0].profileSlug, null);
  assert.ok(data.output.includes('Client key file: ~/.config/modeldeck/pool-client-key'));
  await runPoolClientKeys(revoke, data.effects);
  noPrint(data);
});

test('#786 per-machine Mac supports a quoted scratch keychain and skips helper wiring', async (t) => {
  const data = fixture(t);
  await runPoolClientKeys([...add, '--per-machine', '--keychain', "/tmp/Operator's scratch.keychain-db"], data.effects);
  const install = data.sshCalls.find((call) => call.stdin.includes(KEY));
  assert.ok(install.stdin.includes('cli-proxy-api-client.machine-client-one'));
  assert.ok(data.output.includes('Client helper: security find-generic-password -s cli-proxy-api-client.machine-client-one -w'));
  assert.equal(install.stdin.split("/tmp/Operator's scratch.keychain-db").length - 1, 2);
  assert.equal(data.events.includes('wire'), false);
  noPrint(data);
});

test('#786 unsafe options fail before external effects and HTTP redirects cannot carry secrets away', async (t) => {
  const data = fixture(t);
  for (const args of [
    ['add', '--machine', 'client-one', '--ssh', '-oProxyCommand=bad'],
    [...add, '--platform', 'linux'], [...add, '--per-machine', '--profiles', 'work'],
    ['list', '--daemon-base', 'https://foreign.invalid'],
    ['list', '--daemon-base', 'http://127.0.0.1:43290/path'],
    ['list', '--daemon-base', 'http://user:pass@127.0.0.1:43290'],
    [...add, '--client-daemon-port', '3867;false'],
    [...add, '--keychain', '/tmp/bad\ncommand'],
  ]) await assert.rejects(runPoolClientKeys(args, data.effects));
  assert.equal(data.sshCalls.length, 0);
  assert.equal(data.requests.length, 0);
});

test('#786 revoke stops on a shifted list without repairing or deleting again', async (t) => {
  const options = {};
  const data = fixture(t, options);
  await runPoolClientKeys(add, data.effects);
  options.shiftOnce = true;
  const before = data.sshCalls.length;
  let error;
  await assert.rejects(runPoolClientKeys([...revoke, '--profile', 'profile-one'], data.effects), (caught) => { error = caught; return true; });
  assert.match(error.message, /another writer changed api-keys during this run; check them/);
  assert.ok(error.message.includes(digest('unrelated-key-placeholder').slice(0, 8)));
  assertKeys(data, [KEY]);
  assert.deepEqual(data.requests.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).search), ['?index=1']);
  assert.equal(data.events.filter((event) => event === 'proxy-add').length, 1, 'only initial admission');
  assert.equal(data.store.poolClientKeys()[0].revokedAt, null);
  assert.equal(data.sshCalls.length, before);
  noPrint(data);
});

test('#786 revoke removes a duplicate copy of its own key instead of blaming another writer', async (t) => {
  const data = fixture(t);
  await runPoolClientKeys(add, data.effects);
  data.proxyKeys.push(KEY); // a hand-edited config holding our key twice
  await runPoolClientKeys([...revoke, '--profile', 'profile-one'], data.effects);
  assert.deepEqual(data.proxyKeys, ['unrelated-key-placeholder']);
  assert.notEqual(data.store.poolClientKeys()[0].revokedAt, null);
  noPrint(data);
});

test('#786 revoke refuses ambiguous prefixes before deleting anything', async (t) => {
  const data = fixture(t);
  await runPoolClientKeys(add, data.effects);
  data.store.addPoolClientKey({ keySha256: `${HASH.slice(0, 8)}${'0'.repeat(56)}`, machine: 'other' });
  await assert.rejects(runPoolClientKeys(revoke, data.effects), /ambiguous hash prefix/);
  assert.equal(data.events.includes('proxy-delete'), false);
});

test('#786 an unavailable daemon prevents admission and reports an unconfirmed rollback', async (t) => {
  const data = fixture(t);
  const fetch = data.effects.fetch;
  data.effects.fetch = (url, options) => {
    if (url.startsWith(DAEMON) && options.method === 'POST') throw new Error(KEY);
    return fetch(url, options);
  };
  let error;
  await assert.rejects(runPoolClientKeys(add, data.effects), (caught) => { error = caught; return /rollback incomplete/.test(caught.message); });
  assert.equal(data.proxyKeys.includes(KEY), false);
  assert.equal(data.events.includes('proxy-add'), false);
  assert.match(error.message, /daemon revocation unconfirmed/);
  noPrint(data, error);
});

test('#786 help and list never read credentials or contact SSH/proxy', async (t) => {
  const data = fixture(t);
  for (const effect of ['readFile', 'readMutationToken', 'ssh', 'randomBytes']) {
    data.effects[effect] = () => { assert.fail(`unexpected ${effect}`); };
  }
  await runPoolClientKeys(['--help'], data.effects);
  assert.equal(data.requests.length, 0);
  await runPoolClientKeys(['list', ...common], data.effects);
  assert.equal(data.requests.length, 1);
  assert.ok(data.requests[0].url.startsWith(DAEMON));
});

test('#786 a partial multi-profile add keeps completed and install-unconfirmed keys active', async (t) => {
  const data = fixture(t, { accounts: [
    { id: 'profile-one', label: 'One', provider: 'claude', cliproxyRouted: true },
    { id: 'profile-two', label: 'Two', provider: 'claude', cliproxyRouted: true },
    { id: 'grok-one', label: 'Other', provider: 'grok' },
  ] });
  let count = 0;
  data.effects.randomBytes = () => Buffer.alloc(32, 0x42 + count++);
  const ssh = data.effects.ssh;
  data.effects.ssh = (argv, options) => {
    if (options.stdin && argv.at(-1).includes('cli-proxy-api-client.profile-two')) throw new Error(KEY);
    return ssh(argv, options);
  };
  await assert.rejects(runPoolClientKeys(add, data.effects), /profile-two.*install unconfirmed: re-run add/);
  const [first, second] = data.store.poolClientKeys();
  assert.equal(first.profileSlug, 'profile-one');
  assert.equal(first.revokedAt, null);
  assert.equal(second.profileSlug, 'profile-two');
  assert.equal(second.revokedAt, null);
  const secondKey = Buffer.alloc(32, 0x43).toString('base64url');
  assertKeys(data, ['unrelated-key-placeholder', KEY, secondKey]);
  assert.equal(count, 2);
  await runPoolClientKeys([...revoke, '--profile', 'profile-one'], data.effects);
  assertKeys(data, ['unrelated-key-placeholder', secondKey]);
  assert.ok(data.store.poolClientKeys().find((row) => row.profileSlug === 'profile-one').revokedAt);
  assert.equal(data.store.poolClientKeys().find((row) => row.profileSlug === 'profile-two').revokedAt, null);
});

for (const exitCode of [255, null]) {
  test(`#791 re-check: an ssh-level failure (${exitCode}) during the Codex check stops the run instead of skipping`, async (t) => {
    const data = fixture(t, { accounts: [claudeProfile, codexProfile] });
    const ssh = data.effects.ssh;
    data.effects.ssh = (argv, options) => {
      if (argv.at(-1).endsWith(' check')) throw Object.assign(new Error(KEY), exitCode === null ? {} : { exitCode });
      return ssh(argv, options);
    };
    await assert.rejects(runPoolClientKeys(add, data.effects), /ssh to the client failed during the Codex check/);
    assert.equal(data.events.includes('mint'), false);
    noPrint(data);
  });
}
