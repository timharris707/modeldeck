import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { daemonManifest } from '../scripts/write-daemon-manifest.mjs';

const buildScript = new URL('../scripts/build-daemon-binary.sh', import.meta.url);
const esbuild = new URL('../node_modules/.bin/esbuild', import.meta.url);

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function buildRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-daemon-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(buildScript, path.join(root, 'scripts', 'build-daemon-binary.sh'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'clean\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Daemon Build Test');
  git(root, 'config', 'user.email', 'daemon-build@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture baseline');
  return root;
}

function nodeWrapper(t, root, { fuse }) {
  const directory = fs.mkdtempSync(path.join(root, fuse ? 'node-with-fuse-' : 'node-without-fuse-'));
  const binary = path.join(directory, 'node');
  fs.writeFileSync(binary, `#!/bin/sh\n${fuse ? '# NODE_SEA_FUSE fixture\n' : ''}exec "$REAL_NODE" "$@"\n`);
  fs.chmodSync(binary, 0o755);
  return binary;
}

function checkOnlyEnvironment(t, root) {
  return {
    ...process.env,
    MD_NODE_BINARY: nodeWrapper(t, root, { fuse: true }),
    REAL_NODE: process.execPath,
  };
}

test('daemon build script has valid shell syntax and documents supported flags', () => {
  const syntax = spawnSync('bash', ['-n', fileURLToPath(buildScript)], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const help = spawnSync('bash', [fileURLToPath(buildScript), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--check-only/);
  assert.match(help.stdout, /--allow-dirty/);
  assert.match(help.stdout, /--fetch-node/);

  const unknown = spawnSync('bash', [fileURLToPath(buildScript), '--unknown'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument/);
});

test('daemon build check-only reports the complete plan without requiring build dependencies', (t) => {
  const root = buildRepository(t);
  const result = spawnSync('bash', ['scripts/build-daemon-binary.sh', '--check-only'], {
    cwd: root,
    encoding: 'utf8',
    env: checkOnlyEnvironment(t, root),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /version:\s+9\.8\.7/);
  assert.match(result.stdout, /would bundle src\/server\.mjs/);
  assert.match(result.stdout, /inject a Node SEA/);
  assert.match(result.stdout, /smoke-check GET \/api\/health/);
});

test('daemon build refuses tracked dirt unless --allow-dirty is explicit', (t) => {
  const root = buildRepository(t);
  fs.appendFileSync(path.join(root, 'tracked.txt'), 'dirty\n');

  let result = spawnSync('bash', ['scripts/build-daemon-binary.sh', '--check-only'], {
    cwd: root,
    encoding: 'utf8',
    env: checkOnlyEnvironment(t, root),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracked working-tree changes would be built/);

  result = spawnSync('bash', ['scripts/build-daemon-binary.sh', '--check-only', '--allow-dirty'], {
    cwd: root,
    encoding: 'utf8',
    env: checkOnlyEnvironment(t, root),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /RELEASE SAFETY OVERRIDE: --allow-dirty/);
});

test('daemon build refuses a selected Node binary without the SEA fuse', (t) => {
  const root = buildRepository(t);
  const runningNode = nodeWrapper(t, root, { fuse: false });
  const result = spawnSync('bash', ['scripts/build-daemon-binary.sh', '--check-only'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.dirname(runningNode)}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      MD_NODE_BINARY: '',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /running Node binary has no NODE_SEA_FUSE sentinel/);
  assert.match(result.stderr, /Set MD_NODE_BINARY to an official nodejs\.org Node/);
  assert.match(result.stderr, /--fetch-node/);
});

test('daemon build selects and validates MD_NODE_BINARY when running Node lacks the fuse', (t) => {
  const root = buildRepository(t);
  const runningNode = nodeWrapper(t, root, { fuse: false });
  const officialNode = nodeWrapper(t, root, { fuse: true });
  const result = spawnSync('bash', ['scripts/build-daemon-binary.sh', '--check-only'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.dirname(runningNode)}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      MD_NODE_BINARY: officialNode,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(officialNode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('daemon CJS bundle inlines its version and has no import.meta warnings', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-daemon-bundle-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bundle = path.join(temporary, 'modeldeckd.cjs');
  const result = spawnSync(fileURLToPath(esbuild), [
    fileURLToPath(new URL('../src/server.mjs', import.meta.url)),
    '--bundle', '--platform=node', '--target=node24', '--format=cjs',
    '--define:__MODELDECK_VERSION__="9.8.7"',
    '--define:import.meta.url="file:///__modeldeck_sea_bundle__.mjs"',
    `--outfile=${bundle}`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /import\.meta.*not available/i);
  const content = fs.readFileSync(bundle, 'utf8');
  assert.match(content, /VERSION = true \? "9\.8\.7"/);
  assert.doesNotMatch(content, /readFileSync\(new URL\("\.\.\/package\.json"/);
});

test('daemon manifest records artifact, Node version, commit, and SHA-256', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-daemon-manifest-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const binaryPath = path.join(temporary, 'modeldeckd');
  const bytes = Buffer.from('fixture modeldeckd binary');
  fs.writeFileSync(binaryPath, bytes);

  const manifest = daemonManifest({
    binaryPath,
    nodeVersion: 'v24.99.0',
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.deepEqual(manifest, {
    artifact: 'modeldeckd',
    nodeVersion: 'v24.99.0',
    MDGitCommit: '0123456789abcdef0123456789abcdef01234567',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
});

test('daemon build uses documented SEA injection and an EPERM-only smoke skip', () => {
  const script = fs.readFileSync(buildScript, 'utf8');
  assert.match(script, /--experimental-sea-config/);
  assert.match(script, /NODE_SEA_BLOB/);
  assert.match(script, /NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2/);
  assert.match(script, /grep -a -c NODE_SEA_FUSE/);
  assert.match(script, /MD_NODE_BINARY/);
  assert.match(script, /SHASUMS256\.txt/);
  assert.match(script, /codesign --remove-signature/);
  assert.match(script, /codesign --force --options runtime \\\n\s+--entitlements/);
  assert.match(script, /MODELDECK_DB_PATH=/);
  assert.match(script, /MODELDECK_PORT=0/);
  assert.match(script, /\/api\/health/);
  assert.match(script, /smoke test skipped because this sandbox forbids socket bind \(EPERM\)/);
});

test('smoke signing applies the hardened runtime with the daemon entitlements', () => {
  const script = fs.readFileSync(new URL('../scripts/build-daemon-binary.sh', import.meta.url), 'utf8');
  assert.match(script, /codesign --force --options runtime \\\n\s+--entitlements "\$REPO_ROOT\/scripts\/daemon-entitlements\.plist" --sign - "\$STAGED_BINARY"/);
  const entitlements = fs.readFileSync(new URL('../scripts/daemon-entitlements.plist', import.meta.url), 'utf8');
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
});
