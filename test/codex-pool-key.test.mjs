import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexPoolConfigPath, CODEX_POOL_KEY_SCRIPT } from '../src/codex-pool-key.mjs';

const KEY = Buffer.alloc(32, 0x42).toString('base64url');
const OLD = 'old_placeholder';
const routed = `model_provider = "cliproxyapi"\n[model_providers.cliproxyapi]\nbase_url = "http://127.0.0.1:8317/v1"\n`;

function fixture(t, content = `${routed}experimental_bearer_token = "${OLD}"\n`) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pool-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.toml');
  fs.writeFileSync(config, content, { mode: 0o640 });
  return { root, config, before: Buffer.from(content), run: (input = KEY, mode) => {
    const argv = ['-I', '-c', CODEX_POOL_KEY_SCRIPT, config, ...(mode ? [mode] : [])];
    const env = { PATH: '/usr/bin:/bin', HOME: root };
    assert.equal(JSON.stringify({ argv, env }).includes(KEY), false, 'key must stay off argv/env');
    const result = spawnSync('/usr/bin/python3', argv, {
      input, env, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    assert.equal(result.stdout, '', 'Python must never print config contents or a bearer');
    // The macOS launcher emits this fixed warning in the sandbox, before Python.
    assert.equal(result.stderr.replaceAll("python3: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead\n", ''), '');
    assert.equal((result.stdout + result.stderr).includes(KEY), false);
    assert.equal((result.stdout + result.stderr).includes(OLD), false);
    return result;
  } };
}

for (const newline of ['\n', '\r\n']) {
  test(`#791 missing Codex token is added at the table end (${JSON.stringify(newline)})`, (t) => {
    const before = `${routed}# trailing table comment\n\n[other]\nvalue = "unchanged"\n`.replaceAll('\n', newline);
    const f = fixture(t, before);
    assert.equal(f.run().status, 0);
    const expected = before.replace('[other]', `experimental_bearer_token = "${KEY}"${newline}[other]`);
    assert.ok(fs.readFileSync(f.config).equals(Buffer.from(expected)));
    assert.equal(fs.statSync(f.config).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(f.root), ['config.toml']);
  });
}

test('#791 missing Codex token at EOF without a newline preserves existing bytes', (t) => {
  const f = fixture(t, routed.trimEnd());
  assert.equal(f.run().status, 0);
  assert.ok(fs.readFileSync(f.config).equals(Buffer.concat([f.before, Buffer.from(`\nexperimental_bearer_token = "${KEY}"\n`)])));
});

for (const [name, content] of [
  ['foreign base URL', routed.replace('http://127.0.0.1:8317/v1', 'https://foreign.invalid/v1')],
  ['different port', routed.replace(':8317/', ':8318/')],
  ['base URL suffix', routed.replace('/v1"', '/v1/"')],
  ['different top-level provider', routed.replace('model_provider = "cliproxyapi"', 'model_provider = "openai"')],
  ['provider only inside a table', `[other]\n${routed}`],
  ['table only inside a multiline string', `model_provider = "openai"\nprompt = '''\n${routed}'''\n`],
]) {
  test(`#791 Codex ${name} is refused with fixed code 20 and leaves the file untouched`, (t) => {
    const f = fixture(t, content);
    for (const mode of [undefined, 'check', 'read']) assert.equal(f.run(mode ? '' : KEY, mode).status, 20);
    assert.ok(fs.readFileSync(f.config).equals(f.before));
    assert.deepEqual(fs.readdirSync(f.root), ['config.toml']);
  });
}

test('#791 strings, multiline arrays and unrelated tokens cannot spoof the routed table', (t) => {
  const before = `model_provider = 'cliproxyapi'\nprompt = '''\n[model_providers.cliproxyapi]\nexperimental_bearer_token = "decoy"\n'''\nfeatures = [\n  "[model_providers.cliproxyapi]", # array comment\n]\n[model_providers.cliproxyapi]\nbase_url = 'http://127.0.0.1:8317/v1'\n\texperimental_bearer_token = '${OLD}' # inline\n[other]\nexperimental_bearer_token = "untouched"\n`;
  const f = fixture(t, before);
  assert.equal(f.run().status, 0);
  assert.ok(fs.readFileSync(f.config).equals(Buffer.from(before.replace(OLD, KEY))));
});

for (const input of ['', 'bad key', 'bad\nkey', 'bad"key', 'bad\rkey', 'bad$()key', 'é', 'x'.repeat(4097)]) {
  test(`#791 Codex install rejects non-base64url or oversized stdin (${input.length} bytes, ${JSON.stringify(input.slice(0, 12))})`, (t) => {
    const f = fixture(t);
    assert.equal(f.run(input).status, 21);
    assert.ok(fs.readFileSync(f.config).equals(f.before));
    assert.deepEqual(fs.readdirSync(f.root), ['config.toml']);
  });
}

for (const parent of [false, true]) {
  test(`#791 Codex rejects a symlinked ${parent ? 'parent directory' : 'config file'} without touching the target`, (t) => {
    const f = fixture(t);
    if (parent) {
      const real = path.join(f.root, 'real');
      fs.mkdirSync(real);
      fs.renameSync(f.config, path.join(real, 'config.toml'));
      const link = path.join(f.root, 'link');
      fs.symlinkSync(real, link);
      const result = spawnSync('/usr/bin/python3', ['-I', '-c', CODEX_POOL_KEY_SCRIPT, path.join(link, 'config.toml')], {
        input: KEY, encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: f.root },
      });
      assert.equal(result.status, 22);
      assert.equal((result.stdout + result.stderr).includes(KEY), false);
      assert.ok(fs.readFileSync(path.join(real, 'config.toml')).equals(f.before));
    } else {
      const target = path.join(f.root, 'target.toml');
      fs.renameSync(f.config, target);
      fs.symlinkSync(target, f.config);
      assert.equal(f.run().status, 22);
      assert.ok(fs.readFileSync(target).equals(f.before));
    }
  });
}

test('#791 routing check is read-only; rollback reads the current bearer solely through its private pipe', (t) => {
  const f = fixture(t);
  assert.equal(f.run('', 'check').status, 0);
  assert.ok(fs.readFileSync(f.config).equals(f.before));
  assert.equal(f.run().status, 0);
  const read = f.run('', 'read');
  assert.equal(read.status, 0);
  assert.equal(read.output[3] === KEY, true);
  assert.equal(f.run('', 'check').output[3], '');
});

test('#791 ambiguous Codex routing/token fields are refused without rewriting', (t) => {
  for (const suffix of ['base_url = "https://foreign.invalid"\n', `experimental_bearer_token = "duplicate"\n`, '[model_providers.cliproxyapi]\n']) {
    const f = fixture(t, `${routed}experimental_bearer_token = "${OLD}"\n${suffix}`);
    assert.equal(f.run().status, 21);
    assert.ok(fs.readFileSync(f.config).equals(f.before));
  }
});

test('#791 escaped TOML key names retain a single bearer and change only its value', (t) => {
  for (const name of [String.raw`"experimental_bearer_\u0074oken"`, String.raw`"experimental_bearer_\U00000074oken"`]) {
    const before = `${routed}${name} = '${OLD}' # retain spelling\n`;
    const f = fixture(t, before);
    assert.equal(f.run().status, 0);
    assert.ok(fs.readFileSync(f.config).equals(Buffer.from(before.replace(OLD, KEY))), 'escaped key must be recognized, not duplicated');
    const read = f.run('', 'read');
    assert.equal(read.status, 0);
    assert.equal(read.output[3] === KEY, true);
  }
});

test('#791 missing config in an existing Codex home is unrouted for discovery and restore; install still refuses', (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.config);
  assert.equal(f.run('', 'check').status, 20);
  assert.equal(f.run('', 'read').status, 20);
  assert.equal(f.run().status, 23);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('#791 review: missing Codex profile directory is unrouted for check/read and never created by install', (t) => {
  const f = fixture(t);
  fs.rmSync(f.root, { recursive: true });
  assert.equal(f.run('', 'check').status, 20);
  assert.equal(f.run('', 'read').status, 20);
  assert.equal(f.run().status, 23);
  assert.equal(fs.existsSync(f.root), false);
});

test('#791 review: script replaces a middle CRLF bearer without changing any other bytes or permissions', (t) => {
  const before = `${routed}  experimental_bearer_token = '${OLD}' # keep comment\nwire_api = "responses"\n\n[other]\nvalue = "untouched"\n`.replaceAll('\n', '\r\n');
  const f = fixture(t, before);
  assert.equal(f.run().status, 0);
  assert.ok(fs.readFileSync(f.config).equals(Buffer.from(before.replace(OLD, KEY))));
  assert.equal(fs.statSync(f.config).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(f.root), ['config.toml']);
});

test('#791 review: an outside-home or invalid daemon root never expands the Codex allowlist or blocks legacy profiles', () => {
  const homeDir = '/Users/tester';
  for (const profilesDir of ['/outside/profiles', '/Users/tester-other/profiles', '/Users/tester/../outside', '/Users/tester/./profiles', 'relative', '', null]) {
    assert.throws(() => codexPoolConfigPath('/outside/profiles/code', { homeDir, profilesDir }), /invalid Codex profile path/);
    assert.equal(codexPoolConfigPath(`${homeDir}/.codex-profiles/code`, { homeDir, profilesDir }), `${homeDir}/.codex-profiles/code/config.toml`);
  }
});

test('#791 Codex path allowlist accepts only direct profiles under the daemon or legacy roots', () => {
  const homeDir = '/Users/tester';
  const profilesDir = `${homeDir}/daemon/codex-profiles`;
  for (const profile of [`${homeDir}/.codex-profiles/code-one`, `${profilesDir}/code-two`]) {
    assert.equal(codexPoolConfigPath(profile, { homeDir, profilesDir }), `${profile}/config.toml`);
  }
  assert.equal(codexPoolConfigPath(`${homeDir}/Library/Application Support/ModelDeck/codex-profiles/code`, { homeDir }), `${homeDir}/Library/Application Support/ModelDeck/codex-profiles/code/config.toml`);
  for (const profile of [null, '', '~/.codex-profiles/code', 'relative/code', '/tmp/code', '/Users/other/.codex-profiles/code',
    `${profilesDir}/../code`, `${profilesDir}/co..de`, `${profilesDir}/./code`, `${profilesDir}//code`,
    `${profilesDir}-other/code`, `${profilesDir}/code/child`, `${profilesDir}/code/`, `${profilesDir}/code\n`,
    `${profilesDir}/co'de`, `${profilesDir}/co$de`, `${profilesDir}/co;de`, `${profilesDir}/co\\de`, `${profilesDir}/co\u202ede`,
  ]) assert.throws(() => codexPoolConfigPath(profile, { homeDir, profilesDir }), /invalid Codex profile path/);
});
