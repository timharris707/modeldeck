// Issue #129 (PR #135 review): the demo seeder and demo-daemon launcher must
// each enforce isolation THEMSELVES — canonicalized (symlink-resolved) path
// checks against the live data directory, and a database path pinned inside
// the demo directory. These tests run both entry points in child processes
// under a throwaway fake HOME, so the "live" directory they refuse is itself
// a fixture — nothing here ever touches a real install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seeder = path.join(repoRoot, 'scripts', 'seed-demo.mjs');
const launcher = path.join(repoRoot, 'scripts', 'demo-daemon.sh');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-demo-iso-'));
  const liveDataDir = path.join(home, 'Library', 'Application Support', 'ModelDeck');
  fs.mkdirSync(liveDataDir, { recursive: true });
  return { home, liveDataDir };
}

function runSeeder(home, env = {}) {
  return spawnSync(process.execPath, [seeder], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, ...env },
  });
}

function runLauncher(home, args, env = {}) {
  return spawnSync('/bin/bash', [launcher, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, ...env },
  });
}

test('seeder refuses the live data directory, even through a symlink', (t) => {
  const { home, liveDataDir } = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const direct = runSeeder(home, { MODELDECK_DATA_DIR: liveDataDir });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /refusing to seed the live ModelDeck data directory/);

  const link = path.join(home, 'demo-link');
  fs.symlinkSync(liveDataDir, link);
  const viaLink = runSeeder(home, { MODELDECK_DATA_DIR: link });
  assert.notEqual(viaLink.status, 0);
  assert.match(viaLink.stderr, /refusing to seed the live ModelDeck data directory/);
  assert.equal(fs.readdirSync(liveDataDir).length, 0);
});

test('seeder refuses an inherited database path outside the demo directory', (t) => {
  const { home, liveDataDir } = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const demoDir = path.join(home, 'demo');

  const outside = runSeeder(home, {
    MODELDECK_DATA_DIR: demoDir,
    MODELDECK_DB_PATH: path.join(liveDataDir, 'modeldeck.sqlite'),
  });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /outside the demo data directory/);
  assert.ok(!fs.existsSync(path.join(liveDataDir, 'modeldeck.sqlite')));

  const wrongName = runSeeder(home, {
    MODELDECK_DATA_DIR: demoDir,
    MODELDECK_DB_PATH: path.join(demoDir, 'other.sqlite'),
  });
  assert.notEqual(wrongName.status, 0);
  assert.match(wrongName.stderr, /modeldeck\.sqlite/);
});

test('seeder refuses profile and project roots outside the demo directory', (t) => {
  const { home } = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const demoDir = path.join(home, 'demo');

  const profiles = runSeeder(home, {
    MODELDECK_DATA_DIR: demoDir,
    MODELDECK_CLAUDE_PROFILES_DIR: path.join(home, 'elsewhere-profiles'),
  });
  assert.notEqual(profiles.status, 0);
  assert.match(profiles.stderr, /Claude profiles dir .* outside the demo data directory/);

  const projects = runSeeder(home, {
    MODELDECK_DATA_DIR: demoDir,
    MODELDECK_PROJECTS_ROOT: path.join(home, 'elsewhere-projects'),
  });
  assert.notEqual(projects.status, 0);
  assert.match(projects.stderr, /projects root .* outside the demo data directory/);
});

test('seeder succeeds in an isolated demo directory', (t) => {
  const { home } = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const demoDir = path.join(home, 'demo');
  const result = runSeeder(home, { MODELDECK_DATA_DIR: demoDir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"seeded":true/);
  assert.ok(fs.existsSync(path.join(demoDir, 'modeldeck.sqlite')));
});

test('demo-daemon.sh refuses the live port and the live directory through a symlink', (t) => {
  const { home, liveDataDir } = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const port = runLauncher(home, [path.join(home, 'demo'), '3867']);
  assert.notEqual(port.status, 0);
  assert.match(port.stderr, /refusing to run the demo daemon on 3867/);

  const link = path.join(home, 'demo-link');
  fs.symlinkSync(liveDataDir, link);
  const viaLink = runLauncher(home, [link, '4867']);
  assert.notEqual(viaLink.status, 0);
  assert.match(viaLink.stderr, /refusing to use the live ModelDeck data directory/);
  assert.equal(fs.readdirSync(liveDataDir).length, 0);
});
