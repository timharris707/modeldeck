import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseT3PoolInstances, T3_POOL_KEY_SCRIPT, T3_POOL_KEY_ERRORS } from '../src/t3-pool-key.mjs';

const KEY = Buffer.alloc(32, 0x42).toString('base64url');
const OLD = 'placeholder-old-t3-key-000000000000000000';
const tokenName = 'ANTHROPIC_AUTH_TOKEN';
const secretName = (id) => `provider-env-${Buffer.from(id).toString('base64url')}-${Buffer.from(tokenName).toString('base64url')}.bin`;
const routed = () => ({ driver: 'claudeAgent', enabled: true, displayName: ' Claude pool ', environment: [
  { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8317' },
  { name: tokenName, value: '', sensitive: true, valueRedacted: true },
] });

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't3-pool-key-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userdata = path.join(root, '.t3', 'userdata');
  const secrets = path.join(userdata, 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const settings = path.join(userdata, 'settings.json');
  const instances = {};
  const save = () => fs.writeFileSync(settings, JSON.stringify({ providerInstances: instances }));
  const add = (id, instance = routed()) => {
    instances[id] = instance;
    const file = path.join(secrets, secretName(id));
    fs.writeFileSync(file, OLD, { mode: 0o640 });
    save();
    return file;
  };
  const run = (mode, id, input = '', prefix = '') => {
    const argv = ['-I', '-c', prefix + T3_POOL_KEY_SCRIPT, mode, ...(id === undefined ? [] : [id])];
    const env = { PATH: '/usr/bin:/bin', HOME: root };
    assert.equal(JSON.stringify({ argv, env }).includes(KEY), false);
    const result = spawnSync('/usr/bin/python3', argv, {
      input, env, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    assert.equal(result.stderr.replaceAll("python3: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead\n", ''), '');
    if (mode !== 'list') assert.equal(result.stdout, '');
    for (const value of [KEY, OLD]) assert.equal((result.stdout + result.stderr).includes(value), false);
    if (mode !== 'read') assert.equal(result.output[3], '');
    return result;
  };
  return { root, userdata, secrets, settings, instances, add, save, run };
}

test('#795 review: T3 discovery reports every enabled Claude instance as keyable or skipped, never values', (t) => {
  const f = fixture(t);
  f.add('claude-pool');
  const slash = routed(); slash.environment[0].value += '/'; slash.displayName = ` \u001b\n\u202e${'x'.repeat(70)} `;
  f.add('Slash_2', slash);
  for (const [id, change] of [
    ['disabled', (p) => { p.enabled = false; }], ['truthy', (p) => { p.enabled = 1; }],
    ['config-disabled', (p) => { p.config = { enabled: false }; }],
    ['driver', (p) => { p.driver = 'codex'; }], ['elsewhere', (p) => { p.environment[0].value = 'https://foreign.invalid'; }],
    ['suffix', (p) => { p.environment[0].value += '/v1'; }],
    ['no-token', (p) => { p.environment.pop(); }], ['not-sensitive', (p) => { p.environment[1].sensitive = false; }],
    ['duplicate-base', (p) => { p.environment.push({ ...p.environment[0] }); }],
    ['duplicate-token', (p) => { p.environment.push({ ...p.environment[1] }); }],
    ['bad.id', () => {}], ['x'.repeat(65), () => {}],
  ]) { const p = routed(); change(p); f.add(id, p); }
  fs.unlinkSync(f.add('missing'));
  const linked = f.add('linked'); fs.unlinkSync(linked); fs.symlinkSync(path.join(f.secrets, secretName('claude-pool')), linked);
  const directory = f.add('directory'); fs.unlinkSync(directory); fs.mkdirSync(directory);
  assert.deepEqual(JSON.parse(f.run('list').stdout), [
    { id: 'claude-pool', displayName: 'Claude pool' }, { id: 'Slash_2', displayName: 'x'.repeat(64) },
    { id: 'truthy', displayName: 'Claude pool' },
    ...['elsewhere', 'suffix', 'no-token', 'not-sensitive', 'duplicate-base', 'duplicate-token'].map((id) => ({ id, skipped: 20 })),
    { id: 'invalid-id', skipped: 21 }, { id: 'invalid-id', skipped: 21 },
    { id: 'missing', skipped: 24 }, { id: 'linked', skipped: 22 }, { id: 'directory', skipped: 22 },
  ]);
});

test('#795 review: T3 enabled defaults to on and only exactly false disables it', (t) => {
  for (const enabled of [undefined, null, 0, 1, '', 'false']) {
    const f = fixture(t);
    const instance = routed();
    if (enabled === undefined) delete instance.enabled;
    else instance.enabled = enabled;
    f.add('claudeAgent', instance);
    assert.deepEqual(parseT3PoolInstances(f.run('list').stdout), [{ id: 'claudeAgent', displayName: 'Claude pool' }]);
    for (const mode of ['check', 'read', 'install']) assert.equal(f.run(mode, 'claudeAgent', mode === 'install' ? KEY : '').status, 0);
  }
});

test('#795 review: T3 discovery parser accepts exactly keyable and skipped metadata shapes', () => {
  const rows = [{ id: 'claudeAgent', displayName: 'Claude pool' },
    ...[20, 21, 22, 23, 24].map((skipped) => ({ id: `skip-${skipped}`, skipped })),
    { id: 'invalid-id', skipped: 21 }, { id: 'invalid-id', skipped: 21 },
    { id: 'invalid-id', displayName: 'A valid id can match the placeholder' }];
  assert.deepEqual(parseT3PoolInstances(JSON.stringify(rows)), rows);
  for (const bad of [
    null, {}, [null], [[]], [{ id: 'only-id' }], [{ id: 'bad.id', skipped: 21 }],
    [{ id: 'bad', skipped: '20' }], [{ id: 'bad', skipped: 25 }], [{ id: 'bad', skipped: null }],
    [{ id: 'bad', skipped: 20, displayName: 'Both shapes' }], [{ id: 'bad', skipped: 20, value: KEY }],
    [{ id: 'bad', displayName: KEY, value: KEY }], [{ id: 'bad', displayName: `\n${KEY}` }],
    [{ id: 'duplicate', skipped: 20 }, { id: 'duplicate', skipped: 22 }],
    [{ id: 'duplicate', displayName: 'First' }, { id: 'duplicate', skipped: 20 }],
  ]) assert.throws(() => parseT3PoolInstances(JSON.stringify(bad)), { message: 'invalid T3 discovery' });
});

test('#795 T3 install is atomic, exactly replaces the existing secret with mode 0600 and leaves all other files alone', (t) => {
  const f = fixture(t);
  const file = f.add('claude-pool');
  const other = f.add('other');
  const settings = fs.readFileSync(f.settings);
  const otherBefore = fs.readFileSync(other);
  const names = fs.readdirSync(f.secrets);
  assert.equal(f.run('check', 'claude-pool').status, 0);
  assert.equal(fs.readFileSync(file, 'utf8') === OLD, true);
  assert.equal(f.run('install', 'claude-pool', KEY).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8') === KEY, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(f.settings).equals(settings));
  assert.ok(fs.readFileSync(other).equals(otherBefore));
  assert.deepEqual(fs.readdirSync(f.secrets), names);
  const read = f.run('read', 'claude-pool');
  assert.equal(read.status, 0);
  assert.equal(read.output[3] === KEY, true, 'current key must travel only over fd 3');
});

for (const missing of ['secret', 'secrets', 'settings', 'userdata']) {
  test(`#795 T3 refuses missing ${missing} without creating it; absent settings are silent discovery`, (t) => {
    const f = fixture(t);
    const file = f.add('claude-pool');
    const target = { secret: file, secrets: f.secrets, settings: f.settings, userdata: f.userdata }[missing];
    fs.rmSync(target, { recursive: true });
    const noKey = ['secret', 'secrets'].includes(missing);
    assert.deepEqual(JSON.parse(f.run('list').stdout), noKey ? [{ id: 'claude-pool', skipped: 24 }] : []);
    for (const mode of ['check', 'install', 'read']) assert.equal(f.run(mode, 'claude-pool', mode === 'install' ? KEY : '').status, noKey ? 24 : 20);
    assert.equal(fs.existsSync(target), false);
  });
}

for (const target of ['secret', 'secrets', 'userdata', '.t3', 'home', 'settings']) {
  test(`#795 T3 rejects symlinked ${target} without reading or changing the target`, (t) => {
    const f = fixture(t);
    const file = f.add('claude-pool');
    const link = { secret: file, secrets: f.secrets, userdata: f.userdata, '.t3': path.join(f.root, '.t3'), home: f.root, settings: f.settings }[target];
    const real = `${link}-real`;
    fs.renameSync(link, real); fs.symlinkSync(real, link);
    t.after(() => fs.rmSync(real, { recursive: true, force: true }));
    for (const mode of ['check', 'install', 'read']) assert.equal(f.run(mode, 'claude-pool', mode === 'install' ? KEY : '').status, 22);
    const list = f.run('list');
    if (['secret', 'secrets'].includes(target)) { assert.equal(list.status, 0); assert.deepEqual(JSON.parse(list.stdout), [{ id: 'claude-pool', skipped: 22 }]); }
    else assert.equal(list.status, 22);
    assert.equal(fs.readFileSync(file, 'utf8') === OLD, true);
  });
}

for (const input of ['', 'x'.repeat(31), 'x'.repeat(129), 'x'.repeat(4097), `${KEY}\n`, `${KEY} `, `!${KEY}`, 'é'.repeat(32)]) {
  test(`#795 T3 bad stdin is refused with fixed code and the file untouched (${input.length} chars)`, (t) => {
    const f = fixture(t); const file = f.add('claude-pool');
    assert.equal(f.run('install', 'claude-pool', input).status, 21);
    assert.equal(fs.readFileSync(file, 'utf8') === OLD, true);
    assert.deepEqual(fs.readdirSync(f.secrets), [secretName('claude-pool')]);
  });
}

test('#795 T3 accepts the key length boundaries and refuses bad ids and malformed settings with fixed errors', (t) => {
  const f = fixture(t); f.add('claude-pool');
  assert.equal(Object.isFrozen(T3_POOL_KEY_ERRORS), true);
  for (const length of [32, 128]) assert.equal(f.run('install', 'claude-pool', 'x'.repeat(length)).status, 0);
  for (const id of ['', '../escape', 'bad.id', 'x'.repeat(65), 'newline\n']) assert.equal(f.run('check', id).status, 21);
  fs.writeFileSync(f.settings, `bad-json-${OLD}`);
  assert.equal(f.run('list').status, 21);
});

test('#795 T3 secret ownership is checked before reading or replacing it', (t) => {
  const f = fixture(t); const file = f.add('claude-pool');
  // The first uid check belongs to settings, the second to the secret. Simulate
  // a different owner without privileges or changing any real ownership.
  const prefix = `import os\n_real_uid = os.getuid\n_calls = 0\ndef test_uid():\n    global _calls\n    _calls += 1\n    return _real_uid() if _calls == 1 else _real_uid() + 1\nos.getuid = test_uid\n`;
  for (const mode of ['check', 'read', 'install']) assert.equal(f.run(mode, 'claude-pool', mode === 'install' ? KEY : '', prefix).status, 22);
  assert.deepEqual(JSON.parse(f.run('list', undefined, '', prefix).stdout), [{ id: 'claude-pool', skipped: 22 }]);
  assert.equal(fs.readFileSync(file, 'utf8') === OLD, true);
  assert.deepEqual(fs.readdirSync(f.secrets), [secretName('claude-pool')]);
});

test('#795 T3 concurrent secret replacement aborts without clobbering it or leaving a backup', (t) => {
  const f = fixture(t); const file = f.add('claude-pool');
  const prefix = `import os\n_real_fsync = os.fsync\ndef test_fsync(fd):\n    _real_fsync(fd)\n    os.unlink(${JSON.stringify(file)})\n    with open(${JSON.stringify(file)}, 'wb') as replacement:\n        replacement.write(b'concurrent-placeholder')\nos.fsync = test_fsync\n`;
  assert.equal(f.run('install', 'claude-pool', KEY, prefix).status, 23);
  assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent-placeholder');
  assert.deepEqual(fs.readdirSync(f.secrets), [secretName('claude-pool')]);
});

test('#795 T3 supplementary Unicode labels fit the profile metadata limit after sanitizing', (t) => {
  const f = fixture(t); const instance = routed(); instance.displayName = '🔑'.repeat(64);
  f.add('unicode', instance);
  const result = f.run('list');
  const listed = parseT3PoolInstances(result.stdout);
  assert.ok(listed[0].displayName.length <= 64);
});

test('#795 T3 refuses ids whose secret names alias the same file on a case-insensitive filesystem', (t) => {
  const f = fixture(t);
  const first = f.add('AAG');
  const second = f.add('AAa');
  if (fs.statSync(first).ino !== fs.statSync(second).ino) {
    // Emulate the same file identity on case-sensitive CI without any real data.
    fs.unlinkSync(second); fs.linkSync(first, second);
  }
  assert.equal(secretName('AAG').toLowerCase(), secretName('AAa').toLowerCase());
  assert.deepEqual(JSON.parse(f.run('list').stdout), [{ id: 'AAG', skipped: 22 }, { id: 'AAa', skipped: 22 }]);
  for (const id of ['AAG', 'AAa']) for (const mode of ['check', 'read', 'install']) {
    assert.equal(f.run(mode, id, mode === 'install' ? KEY : '').status, 22);
  }
  assert.equal(fs.readFileSync(first, 'utf8') === OLD, true);
  assert.equal(fs.readFileSync(second, 'utf8') === OLD, true);
});

for (const [id, otherId] of [['aaa', 'aaG'], ['aaA', 'aa[']]) for (const mode of ['list', 'check', 'read', 'install']) {
  test(`#795 review: T3 ${mode} refuses a routed/direct secret alias (${id}) and leaves the direct key untouched`, (t) => {
    const f = fixture(t);
    const first = f.add(id);
    const direct = routed(); direct.environment[0].value = 'https://direct.invalid';
    const second = f.add(otherId, direct);
    // Other provider keys need not satisfy the keyable-id grammar.
    f.instances['é/☃'] = { driver: 'codex', enabled: false }; f.save();
    if (fs.statSync(first).ino !== fs.statSync(second).ino) {
      fs.unlinkSync(second); fs.linkSync(first, second);
    }
    assert.equal(secretName(id).toLowerCase(), secretName(otherId).toLowerCase());
    const before = fs.statSync(first);
    const result = f.run(mode, mode === 'list' ? undefined : id, mode === 'install' ? KEY : '');
    if (mode === 'list') assert.deepEqual(parseT3PoolInstances(result.stdout), [{ id, skipped: 22 },
      otherId === 'aaG' ? { id: otherId, skipped: 20 } : { id: 'invalid-id', skipped: 21 }]);
    else assert.equal(result.status, 22);
    assert.equal(result.output[3], '');
    for (const file of [first, second]) {
      assert.equal(fs.readFileSync(file, 'utf8') === OLD, true);
      assert.equal(fs.statSync(file).ino, before.ino);
      assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    }
  });
}

for (const [kind, content] of [['binary', Buffer.from([0, 255, 128, 1])], ['empty', Buffer.alloc(0)],
  ['short', Buffer.alloc(15, 0x61)], ['oversize', Buffer.alloc(513, 0x61)], ['newline', Buffer.from(`${OLD}\n`)]]) {
  for (const mode of ['list', 'check', 'install']) {
    test(`#795 review: T3 ${mode} rejects ${kind} existing secret content without changing the file`, (t) => {
      const f = fixture(t); const file = f.add('claude-pool');
      fs.writeFileSync(file, content);
      const before = fs.statSync(file);
      const result = f.run(mode, mode === 'list' ? undefined : 'claude-pool', mode === 'install' ? KEY : '');
      if (mode === 'list') assert.deepEqual(parseT3PoolInstances(result.stdout), [{ id: 'claude-pool', skipped: 21 }]);
      else assert.equal(result.status, 21);
      assert.ok(fs.readFileSync(file).equals(content));
      assert.equal(fs.statSync(file).ino, before.ino);
      assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
      assert.equal(fs.statSync(file).mode, before.mode);
      assert.deepEqual(fs.readdirSync(f.secrets), [secretName('claude-pool')]);
    });
  }
}

test('#795 review: T3 check and install accept existing plain-token boundaries and punctuation', (t) => {
  for (const length of [16, 512]) {
    const f = fixture(t); const file = f.add('claude-pool');
    fs.writeFileSync(file, 'Aa0._~+/=-'.padEnd(length, 'x'));
    assert.equal(f.run('check', 'claude-pool').status, 0);
    assert.equal(f.run('install', 'claude-pool', KEY).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8') === KEY, true);
  }
});
