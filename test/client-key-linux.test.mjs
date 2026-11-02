import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LEGACY_CLIENT_KEY_SERVICE, clientKeyHelperCommand, clientKeyService, clientKeyShellFetch, readClientKey,
} from '../src/client-key-helper.mjs';
import { claudePinnedEnvFileContent } from '../src/adapters/claude.mjs';

// #808: off macOS the proxy client key is the machine's one owner-only file
// (decision 0046). The Mac strings are pinned too, so neither side drifts.
const linux = { platform: 'linux', secretsDir: "/home/placeholder/.config/it's modeldeck" };

test('macOS keeps the Keychain commands byte for byte', () => {
  assert.equal(clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE, { platform: 'darwin' }),
    'security find-generic-password -s cli-proxy-api-client -w');
  assert.equal(clientKeyShellFetch(LEGACY_CLIENT_KEY_SERVICE, { platform: 'darwin' }),
    '"${MODELDECK_SECURITY_BIN:-/usr/bin/security}" find-generic-password -s cli-proxy-api-client -w');
});

test('Linux reads the pool-client-key file, single-quoted, and refuses per-profile keys', () => {
  const file = "'/home/placeholder/.config/it'\\''s modeldeck/pool-client-key'";
  const dir = "'/home/placeholder/.config/it'\\''s modeldeck'";
  const ownerOnly = (target) => `[ ! -L ${target} ] && case "$(/usr/bin/stat -c %u:%a -- ${target})" in "$(/usr/bin/id -u)":[1-7]00|"$(/usr/bin/id -u)":[1-7][1-7]00) true ;; *) false ;; esac`;
  assert.equal(clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE, linux),
    `${ownerOnly(dir)} && ${ownerOnly(file)} && /bin/cat -- ${file}`);
  assert.equal(clientKeyShellFetch(LEGACY_CLIENT_KEY_SERVICE, linux), clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE, linux));
  assert.throws(() => clientKeyHelperCommand(clientKeyService('abc'), linux), /macOS-only/);
});

test('the Linux helper command prints the key through a real shell', { skip: process.platform === 'darwin' && 'GNU stat only' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modeldeck-key-it's "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'pool-client-key'), 'placeholder-client-key\n', { mode: 0o600 });
  const command = clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE, { platform: 'linux', secretsDir: dir });
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.stdout.trim(), 'placeholder-client-key');
  assert.equal(readClientKey(LEGACY_CLIENT_KEY_SERVICE, { platform: 'linux', secretsDir: dir }), 'placeholder-client-key');
  fs.chmodSync(path.join(dir, 'pool-client-key'), 0o644);
  assert.equal(readClientKey(LEGACY_CLIENT_KEY_SERVICE, { platform: 'linux', secretsDir: dir }), '');
});

// Codex review of #813: the shell helper refuses a symlinked key file and
// never resolves cat through PATH.
test('the Linux helper refuses a symlinked key file and ignores a PATH cat', { skip: process.platform === 'darwin' && 'GNU stat only' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-key-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const elsewhere = path.join(dir, 'elsewhere');
  fs.writeFileSync(elsewhere, 'placeholder-foreign-key\n', { mode: 0o600 });
  const secrets = path.join(dir, 'secrets');
  fs.mkdirSync(secrets, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(secrets, 'pool-client-key'));
  const command = clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE, { platform: 'linux', secretsDir: secrets });
  const linked = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.notEqual(linked.status, 0);
  assert.equal(linked.stdout, '');
  fs.unlinkSync(path.join(secrets, 'pool-client-key'));
  fs.writeFileSync(path.join(secrets, 'pool-client-key'), 'placeholder-real-key\n', { mode: 0o600 });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'cat'), '#!/bin/sh\necho placeholder-fake-cat\n', { mode: 0o755 });
  const viaPath = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(viaPath.stdout.trim(), 'placeholder-real-key');
});

test('the generated env block never names the Keychain off macOS', { skip: process.platform === 'darwin' && 'Linux module defaults' }, () => {
  const block = claudePinnedEnvFileContent('/home/placeholder/profile', true);
  assert.doesNotMatch(block, /find-generic-password/);
  assert.match(block, /\/bin\/cat -- '[^']*\/pool-client-key' 2>\/dev\/null/);
});

// Codex review of #813: the wiring status looks for exactly what the env
// block contains, on every platform.
test('the env block carries the platform fetch the wiring status searches for', () => {
  const block = claudePinnedEnvFileContent('/home/placeholder/profile', true);
  assert.ok(block.includes(clientKeyShellFetch(LEGACY_CLIENT_KEY_SERVICE)));
});

// CodeRabbit on #813: the shell helper enforces the same owner-only contract
// as readClientKey. GNU stat, so this runs where the helper does (Linux).
test('the Linux helper refuses a key file other users can read', { skip: process.platform === 'darwin' && 'GNU stat only' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-key-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'pool-client-key');
  fs.writeFileSync(file, 'placeholder-client-key\n', { mode: 0o600 });
  const command = clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE, { platform: 'linux', secretsDir: dir });
  const sh = (shell) => spawnSync(shell, ['-c', command], { encoding: 'utf8' });
  assert.equal(sh('/bin/sh').stdout.trim(), 'placeholder-client-key');
  for (const mode of [0o640, 0o604]) {
    fs.chmodSync(file, mode);
    const result = sh('/bin/sh');
    assert.notEqual(result.status, 0, mode.toString(8));
    assert.equal(result.stdout, '');
  }
});

// CodeRabbit on #813 (second pass): another user who can write the folder
// could swap the file between the checks and cat, so the folder is checked too.
test('the Linux helper refuses a key in a folder other users can write', { skip: process.platform === 'darwin' && 'GNU stat only' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-key-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'pool-client-key'), 'placeholder-client-key\n', { mode: 0o600 });
  const command = clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE, { platform: 'linux', secretsDir: dir });
  // Special bits are not group or other access: a setgid 2700 folder passes,
  // as it does in readSecretFile (CodeRabbit on #813, third pass).
  for (const mode of [0o700, 0o2700]) {
    fs.chmodSync(dir, mode);
    assert.equal(spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).stdout.trim(), 'placeholder-client-key', mode.toString(8));
  }
  for (const mode of [0o770, 0o707, 0o2770]) {
    fs.chmodSync(dir, mode);
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, mode.toString(8));
    assert.equal(result.stdout, '');
  }
  fs.chmodSync(dir, 0o700);
});
