import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecretFile } from '../src/secret-file.mjs';

// #807: off macOS the token goes to an owner-only file (decision 0046). A fake
// `uname` forces the Linux branch on any host; the real Keychain is never used.
const script = fileURLToPath(new URL('../scripts/set-mutation-token.sh', import.meta.url));

function linuxHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-token-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
  const run = (args, input) => spawnSync('/bin/bash', [script, ...args], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, input, encoding: 'utf8',
  });
  return { home, run, file: path.join(home, '.config', 'modeldeck', 'mutation-token') };
}

test('generate writes an owner-only token file and never prints it', (t) => {
  const { run, file } = linuxHome(t);
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const token = readSecretFile(file);
  assert.ok(token && token.length >= 40);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
  assert.match(result.stdout, /every ModelDeck unit that reads it.*systemctl --user restart modeldeck\.service/);
});

test('--stdin stores the given token; --delete removes it', (t) => {
  const { run, file } = linuxHome(t);
  assert.equal(run(['--stdin'], 'placeholder-stdin-token\n').status, 0);
  assert.equal(readSecretFile(file), 'placeholder-stdin-token');
  assert.equal(run(['--stdin'], '\n').status, 1);
  assert.equal(run(['--delete']).status, 0);
  assert.equal(fs.existsSync(file), false);
});

// Codex review of #812: the writer refuses what the reader would refuse, and
// an inherited TOKEN export never carries the secret to a child process.
test('a symlinked secrets dir or a non-file target is refused', (t) => {
  const { home, run, file } = linuxHome(t);
  const real = path.join(home, 'elsewhere');
  fs.mkdirSync(real);
  fs.mkdirSync(path.join(home, '.config'));
  fs.symlinkSync(real, path.dirname(file));
  assert.equal(run([]).status, 1);
  assert.deepEqual(fs.readdirSync(real), []);
  fs.unlinkSync(path.dirname(file));
  fs.mkdirSync(file, { recursive: true });
  assert.equal(run([]).status, 1);
});

test('--stdin does not export the token to child processes', (t) => {
  const { home, file } = linuxHome(t);
  const bin = path.join(home, 'bin');
  const seen = path.join(home, 'seen');
  fs.writeFileSync(path.join(bin, 'mv'), `#!/bin/sh\nenv > '${seen}'\nexec /bin/mv "$@"\n`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', [script, '--stdin'], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TOKEN: 'inherited' }, input: 'placeholder-secret\n', encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readSecretFile(file), 'placeholder-secret');
  assert.doesNotMatch(fs.readFileSync(seen, 'utf8'), /placeholder-secret/);
});

// CodeRabbit on #812: a token the reader's 4096-byte cap would refuse is
// refused at write time, counted in bytes (the newline included) in any locale.
test('--stdin refuses a token too long for the reader, counted in bytes', (t) => {
  const { run, file, home } = linuxHome(t);
  assert.equal(run(['--stdin'], `${'a'.repeat(4095)}\n`).status, 0);
  assert.equal(readSecretFile(file), 'a'.repeat(4095));
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(run(['--stdin'], `${'b'.repeat(4096)}\n`).status, 1);
  const utf8 = spawnSync('/bin/bash', [script, '--stdin'], {
    env: { HOME: home, PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`, LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' },
    input: `${'é'.repeat(2048)}\n`, encoding: 'utf8',
  });
  assert.equal(utf8.status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// CodeRabbit on #812: a relative override would resolve against the writer's
// folder here and the daemon's elsewhere, so it is refused before any write.
test('a relative MODELDECK_SECRETS_DIR is refused', (t) => {
  const { home } = linuxHome(t);
  const result = spawnSync('/bin/bash', [script], {
    cwd: home, env: { HOME: home, PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`, MODELDECK_SECRETS_DIR: 'relative-secrets' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /absolute/);
  assert.equal(fs.existsSync(path.join(home, 'relative-secrets')), false);
});
