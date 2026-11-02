import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMutationToken, secretFileLookup } from '../src/token.mjs';
import { readSecretFile } from '../src/secret-file.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('explicit token option wins over everything', () => {
  const result = resolveMutationToken({
    token: 'explicit-token',
    env: { MODELDECK_MUTATION_TOKEN: 'env-token' },
    lookup: () => 'keychain-token',
  });
  assert.deepEqual(result, { token: 'explicit-token', source: 'option' });
});

test('MODELDECK_MUTATION_TOKEN env var is the test/CI fallback', () => {
  const result = resolveMutationToken({
    env: { MODELDECK_MUTATION_TOKEN: '  env-token  ' },
    lookup: () => 'keychain-token',
  });
  assert.deepEqual(result, { token: 'env-token', source: 'env' });
});

test('keychain lookup is used when no option or env token is present', () => {
  const result = resolveMutationToken({ env: {}, lookup: () => 'keychain-token', platform: 'darwin' });
  assert.deepEqual(result, { token: 'keychain-token', source: 'keychain' });
});

test('off macOS the stored token is reported as coming from the file (#807)', () => {
  const result = resolveMutationToken({ env: {}, lookup: () => 'file-token', platform: 'linux' });
  assert.deepEqual(result, { token: 'file-token', source: 'file' });
});

function secretHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  return dir;
}

test('a 0600 secret file in a 0700 directory is read and trimmed (#807)', (t) => {
  const dir = secretHome(t);
  const file = path.join(dir, 'mutation-token');
  fs.writeFileSync(file, 'placeholder-token\n', { mode: 0o600 });
  assert.equal(readSecretFile(file), 'placeholder-token');
  assert.equal(readSecretFile(path.join(dir, 'absent')), null);
});

test('unsafe secret files are refused without echoing the value (#807)', (t) => {
  const dir = secretHome(t);
  const file = path.join(dir, 'mutation-token');
  fs.writeFileSync(file, 'placeholder-secret-value\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readSecretFile(file), (error) => /owner-only/.test(error.message) && !error.message.includes('placeholder-secret-value'));
  fs.chmodSync(file, 0o600);
  fs.chmodSync(dir, 0o750);
  assert.throws(() => readSecretFile(file), /owner-only/);
  fs.chmodSync(dir, 0o700);
  const link = path.join(dir, 'link');
  fs.symlinkSync(file, link);
  assert.throws(() => readSecretFile(link), /not a regular file/);
  assert.throws(() => readSecretFile(file, { uid: (process.getuid?.() ?? 0) + 1 }), /not owned/);
  fs.writeFileSync(file, 'one\ntwo\n');
  assert.throws(() => readSecretFile(file), /single line/);
});

test('an unsafe token file is ignored with one warning, so the daemon fails closed (#807)', () => {
  const warnings = [];
  const value = secretFileLookup({
    file: '/placeholder/mutation-token',
    read: () => { throw new Error('/placeholder/mutation-token is readable or writable by other users'); },
    warn: (line) => warnings.push(line),
  });
  assert.equal(value, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignoring the mutation token file/);
});

test('MODELDECK_SKIP_KEYCHAIN=1 bypasses the keychain', () => {
  const result = resolveMutationToken({
    env: { MODELDECK_SKIP_KEYCHAIN: '1' },
    lookup: () => { throw new Error('keychain must not be consulted'); },
  });
  assert.equal(result.source, 'ephemeral');
});

test('falls back to a random ephemeral token when nothing is configured', () => {
  const first = resolveMutationToken({ env: {}, lookup: () => null });
  const second = resolveMutationToken({ env: {}, lookup: () => null });
  assert.equal(first.source, 'ephemeral');
  assert.equal(second.source, 'ephemeral');
  assert.ok(first.token.length >= 32);
  assert.notEqual(first.token, second.token);
});

// Codex review of #812: the production lookup off macOS must reach the file.
// The child pretends to be Linux, so the real Keychain is never asked.
test('off macOS the default lookup reads the secrets-dir token file (#807)', (t) => {
  const dir = secretHome(t);
  fs.writeFileSync(path.join(dir, 'mutation-token'), 'placeholder-file-token\n', { mode: 0o600 });
  const tokenModule = fileURLToPath(new URL('../src/token.mjs', import.meta.url));
  const script = `Object.defineProperty(process, 'platform', { value: 'linux' });
const { resolveMutationToken } = await import(${JSON.stringify(tokenModule)});
const { token, source } = resolveMutationToken({ env: {} });
console.log(source, token === 'placeholder-file-token');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, HOME: dir, MODELDECK_SECRETS_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'file true');
});

test('a directory swapped in between check and open is refused (#807)', (t) => {
  const dir = secretHome(t);
  const file = path.join(dir, 'mutation-token');
  fs.writeFileSync(file, 'placeholder-a\n', { mode: 0o600 });
  const swapped = { ...fs, openSync: (...args) => {
    fs.renameSync(dir, `${dir}.old`);
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.writeFileSync(file, 'placeholder-b\n', { mode: 0o600 });
    t.after(() => fs.rmSync(`${dir}.old`, { recursive: true, force: true }));
    return fs.openSync(...args);
  } };
  assert.throws(() => readSecretFile(file, { fsImpl: swapped }), /changed while it was being checked/);
});

test('an oversized secret file is refused (#807)', (t) => {
  const dir = secretHome(t);
  const file = path.join(dir, 'mutation-token');
  fs.writeFileSync(file, 'x'.repeat(5000), { mode: 0o600 });
  assert.throws(() => readSecretFile(file), /larger than a secret/);
});
