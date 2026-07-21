import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const syncScript = new URL('../scripts/sync-mirror.sh', import.meta.url);

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, relative, contents = `${relative}\n`) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function initRepository(root) {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Mirror Fixture');
  git(root, 'config', 'user.email', 'mirror-fixture@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
}

function fixture(t, { plantedHit = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-sync-mirror-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const mirror = path.join(temporary, 'mirror');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.copyFileSync(syncScript, path.join(source, 'scripts', 'sync-mirror.sh'));
  fs.chmodSync(path.join(source, 'scripts', 'sync-mirror.sh'), 0o755);

  write(source, 'public/readme.md', 'safe mirror content\n');
  write(source, '.claude/settings.json');
  write(source, 'docs/HANDOFF.md');
  write(source, 'docs/ACCOUNT_ONBOARDING.md');
  write(source, 'docs/lane-routing-policy.md');
  write(source, 'docs/incidents/example.md');
  write(source, 'scripts/lane-codex.sh');
  write(source, 'scripts/lane-watch.mjs');
  write(source, 'design/mac-app-roadmap.md');
  write(source, 'scripts/private-scrub-patterns', '^FORBIDDEN_[0-9]+$\n');
  if (plantedHit) write(source, 'public/hit.txt', 'FORBIDDEN_123\n');

  initRepository(source);
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'source fixture');

  fs.mkdirSync(mirror);
  initRepository(mirror);
  write(mirror, 'obsolete.txt', 'remove me\n');
  git(mirror, 'add', '.');
  git(mirror, 'commit', '-m', 'mirror baseline');

  return {
    source,
    mirror,
    patterns: path.join(source, 'scripts', 'private-scrub-patterns'),
    missingMirror: path.join(temporary, 'must-not-be-created'),
  };
}

function runSync({ source, mirror, patterns }, ...flags) {
  return spawnSync(
    'bash',
    ['scripts/sync-mirror.sh', ...flags, mirror, 'fixture update'],
    {
      cwd: source,
      encoding: 'utf8',
      env: { ...process.env, MD_SCRUB_PATTERNS: patterns },
    },
  );
}

test('strip list is absent from the committed mirror staging tree', (t) => {
  const data = fixture(t);
  const result = runSync(data);
  assert.equal(result.status, 0, result.stderr);

  const stripped = [
    '.claude',
    'docs/HANDOFF.md',
    'docs/ACCOUNT_ONBOARDING.md',
    'docs/lane-routing-policy.md',
    'docs/incidents',
    'scripts/lane-codex.sh',
    'scripts/lane-watch.mjs',
    'design/mac-app-roadmap.md',
    'scripts/private-scrub-patterns',
  ];
  for (const relative of stripped) {
    assert.equal(fs.existsSync(path.join(data.mirror, relative)), false, relative);
  }
  assert.equal(fs.readFileSync(path.join(data.mirror, 'public/readme.md'), 'utf8'), 'safe mirror content\n');
  assert.equal(fs.existsSync(path.join(data.mirror, 'obsolete.txt')), false);
  assert.equal(git(data.mirror, 'status', '--porcelain'), '');
  assert.equal(git(data.mirror, 'log', '-1', '--format=%s'), 'Sync: fixture update');
  assert.equal(git(data.mirror, 'log', '-1', '--format=%ae'), 'mirror-sync@example.invalid');
});

test('scrub gate refuses a planted pattern and reports only its file', (t) => {
  const data = fixture(t, { plantedHit: true });
  const result = runSync(data, '--check-only');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public\/hit\.txt/);
  assert.doesNotMatch(result.stderr, /FORBIDDEN_123/);
});

test('scrub gate passes a clean staged snapshot', (t) => {
  const data = fixture(t);
  const result = runSync(data, '--check-only');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scrub gate passed/);
});

test('--check-only does not touch or create the mirror clone', (t) => {
  const data = fixture(t);
  const missing = { ...data, mirror: data.missingMirror };
  const result = runSync(missing, '--check-only');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mirror clone was not touched/);
  assert.equal(fs.existsSync(data.missingMirror), false);
});

test('scrub gate catches a pattern hit inside a binary artifact', (t) => {
  const data = fixture(t);
  const binary = path.join(data.source, 'public', 'artifact.bin');
  fs.writeFileSync(binary, Buffer.concat([Buffer.from('FORBIDDEN_42'), Buffer.from([0, 1, 2, 255])]));
  git(data.source, 'add', '.');
  git(data.source, 'commit', '-m', 'binary with planted hit');
  const result = runSync(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact\.bin/);
});

test('a bare repository is rejected as a mirror target', (t) => {
  const data = fixture(t);
  const bare = path.join(path.dirname(data.mirror), 'bare.git');
  const init = spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const result = runSync({ ...data, mirror: bare });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-bare git working tree/);
});

test('the source checkout is rejected as a mirror target', (t) => {
  const data = fixture(t);
  const result = runSync({ ...data, mirror: data.source });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be the source checkout/);
});
