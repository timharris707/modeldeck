import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capture, capturePaths, setStatusLine, stableNode, windowsOf } from './statusline.mjs';
import { collect, readTerminal } from './reader.mjs';
import { withDirect } from '../phone-deck/server.mjs';

const STATUSLINE = fileURLToPath(new URL('./statusline.mjs', import.meta.url));
const NOW = Date.parse('2026-11-19T19:00:00.000Z');

// A status line payload as Claude Code sends it once the account has replied.
const payload = (weekly, fiveHour) => ({
  model: { display_name: 'Opus' }, cwd: '/tmp',
  rate_limits: {
    seven_day: { used_percentage: weekly, resets_at: 1795593600 },
    ...(fiveHour == null ? {} : { five_hour: { used_percentage: fiveHour, resets_at: 1795000000 } }),
  },
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-statusline-'));
  const paths = { ...capturePaths(home, {}) };
  for (const [name, uuid] of [['alpha', 'uuid-alpha'], ['beta', 'uuid-beta']]) {
    fs.mkdirSync(path.join(paths.accountsDir, name), { recursive: true });
    fs.writeFileSync(path.join(paths.accountsDir, name, '.claude.json'), JSON.stringify({
      oauthAccount: { accountUuid: uuid, emailAddress: `${name}@example.test` },
    }));
    fs.writeFileSync(path.join(paths.accountsDir, name, 'settings.json'), JSON.stringify({ model: 'opus', env: { KEEP: '1' } }), { mode: 0o640 });
  }
  return { home, paths };
}

const readerPaths = (home, paths) => ({
  accountsDir: paths.accountsDir,
  t3Settings: path.join(home, 'none', 'settings.json'),
  t3Logs: path.join(home, 'none', 'logs'),
  cacheFile: path.join(home, '.cache', 'modeldeck', 'direct-usage', 'state.json'),
  terminalDir: paths.terminalDir,
});

test('capture saves the weekly and 5-hour numbers with the account uuid, once a minute when unchanged', () => {
  const { paths } = fixture();
  assert.equal(capture('alpha', payload(12.5, 3), { paths, now: NOW }), true);
  const file = path.join(paths.terminalDir, 'alpha.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, {
    v: 1, folder: 'alpha', accountUuid: 'uuid-alpha', observedAt: new Date(NOW).toISOString(),
    windows: { seven_day: { used_percentage: 12.5, resets_at: 1795593600 }, five_hour: { used_percentage: 3, resets_at: 1795000000 } },
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(capture('alpha', payload(12.5, 3), { paths, now: NOW + 30_000 }), false, 'same numbers inside a minute');
  assert.equal(capture('alpha', payload(13, 3), { paths, now: NOW + 30_000 }), true, 'new numbers right away');
  assert.equal(capture('alpha', payload(13, 3), { paths, now: NOW + 120_000 }), true, 'same numbers after a minute');
});

test('capture ignores payloads without limits, bad folder names and folders with no account', () => {
  const { paths } = fixture();
  assert.equal(windowsOf({ model: {} }), null, 'before the first reply there are no rate_limits');
  assert.equal(windowsOf({ rate_limits: { seven_day: { used_percentage: 140 } } }), null);
  assert.equal(capture('alpha', { model: {} }, { paths, now: NOW }), false);
  assert.equal(capture('../alpha', payload(1), { paths, now: NOW }), false);
  assert.equal(capture('gamma', payload(1), { paths, now: NOW }), false);
  assert.equal(fs.existsSync(paths.terminalDir), false);
});

test('the reader turns captures into terminal readings and drops one made under another account', () => {
  const { home, paths } = fixture();
  capture('alpha', payload(40, 5), { paths, now: NOW });
  capture('beta', payload(7), { paths, now: NOW });
  assert.deepEqual(readTerminal(paths.terminalDir).map((r) => [r.folder, r.scope, r.usedPercent, r.source]),
    [['alpha', 'weekly', 40, 'terminal'], ['alpha', '5-hour', 5, 'terminal'], ['beta', 'weekly', 7, 'terminal']]);
  // beta is signed in to another account since its capture.
  fs.writeFileSync(path.join(paths.accountsDir, 'beta', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-other' } }));
  const out = collect({ paths: readerPaths(home, paths), now: NOW, useCache: false });
  assert.deepEqual(out.readings.map((r) => [r.folder, r.scope, r.resetsAt]),
    [['alpha', 'weekly', '2026-11-25T08:00:00.000Z'], ['alpha', '5-hour', '2026-11-18T11:06:40.000Z']]);
});

test('the page labels a terminal reading "Terminal"', () => {
  const { home, paths } = fixture();
  capture('alpha', payload(40), { paths, now: NOW });
  const direct = collect({ paths: readerPaths(home, paths), now: NOW, useCache: false });
  const state = withDirect({ accounts: [], usage: [] }, direct);
  assert.deepEqual(state.usage.map((u) => [u.scope, u.usedPercent, u.via]), [['weekly', 40, 'Terminal']]);
});

test('install names this program as the status line, keeps other settings, and uninstall undoes it', () => {
  const { paths } = fixture();
  fs.writeFileSync(path.join(paths.accountsDir, 'beta', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine.sh' } }));
  const source = fs.readFileSync(STATUSLINE, 'utf8');
  assert.deepEqual(setStatusLine(['alpha', 'beta', 'gamma', '../x'], { paths, source }), [
    ['alpha', 'installed'], ['beta', 'skipped: has its own status line'],
    ['gamma', 'skipped: not an account folder'], ['../x', 'refused: bad folder name'],
  ]);
  const file = path.join(paths.accountsDir, 'alpha', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(settings.env, { KEEP: '1' });
  assert.equal(settings.statusLine.type, 'command');
  assert.match(settings.statusLine.command, /direct-statusline\.mjs' capture alpha$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(paths.installed, 'utf8'), source);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak-modeldeck-statusline`, 'utf8')), { model: 'opus', env: { KEEP: '1' } });
  assert.deepEqual(setStatusLine(['alpha'], { paths, source }), [['alpha', 'installed']], 'a second install is the same');
  assert.deepEqual(setStatusLine(['alpha', 'beta'], { install: false, paths }), [['alpha', 'removed'], ['beta', 'nothing to remove']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus', env: { KEEP: '1' } });
});

// #838 review: Claude Code does not create settings.json, so an account
// folder without one gets a new file holding only the status line.
test('install creates settings.json for an account folder that has none, with no backup', () => {
  const { paths } = fixture();
  const file = path.join(paths.accountsDir, 'alpha', 'settings.json');
  fs.rmSync(file);
  assert.deepEqual(setStatusLine(['alpha'], { paths, source: 'x' }), [['alpha', 'installed']]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['statusLine']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.bak-modeldeck-statusline`), false);
  fs.rmSync(file);
  assert.deepEqual(setStatusLine(['alpha'], { install: false, paths }), [['alpha', 'nothing to remove']]);
});

// #838 review: status lines may be running the installed program, so a
// reinstall that fails part-way must leave the old program whole.
test('a failed reinstall leaves the installed program as it was', () => {
  const { paths } = fixture();
  setStatusLine([], { paths, source: 'old program' });
  // The temporary file's name is taken, so the new write fails.
  fs.mkdirSync(`${paths.installed}.${process.pid}.tmp`);
  assert.throws(() => setStatusLine(['alpha'], { paths, source: 'new program' }));
  assert.equal(fs.readFileSync(paths.installed, 'utf8'), 'old program');
});

// #838 review: one capture with an impossible reset time must not fail the read.
test('an out-of-range reset time reads as no reset, not a failed read', () => {
  const { home, paths } = fixture();
  fs.mkdirSync(paths.terminalDir, { recursive: true });
  fs.writeFileSync(path.join(paths.terminalDir, 'alpha.json'), JSON.stringify({
    v: 1, folder: 'alpha', accountUuid: 'uuid-alpha', observedAt: new Date(NOW).toISOString(),
    windows: { seven_day: { used_percentage: 9, resets_at: 1e20 } },
  }));
  const out = collect({ paths: readerPaths(home, paths), now: NOW, useCache: false });
  assert.deepEqual(out.readings.map((r) => [r.folder, r.usedPercent, r.resetsAt]), [['alpha', 9, null]]);
});

// The Macs' installs named Homebrew's version-numbered node, which the next
// Node upgrade deletes; settings.json must name the stable link instead.
test('the status line names a stable node on PATH, not a version-numbered one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-node-'));
  const cellar = path.join(home, 'Cellar', 'node', '26.12.1', 'bin');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(cellar, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(cellar, 'node'), '');
  fs.symlinkSync(path.join(cellar, 'node'), path.join(bin, 'node'));
  assert.equal(stableNode(path.join(cellar, 'node'), ['relative', '/nowhere', bin].join(path.delimiter)), path.join(bin, 'node'));
  assert.equal(stableNode(path.join(cellar, 'node'), '/nowhere'), path.join(cellar, 'node'), 'no link on PATH: the program itself');
  assert.equal(stableNode(path.join(cellar, 'node'), [cellar, bin].join(path.delimiter)), path.join(bin, 'node'),
    'the versioned folder earlier on PATH still gives the link (#840 review)');
});

// #840 review: the command written into settings.json, not only the helper,
// names the stable link.
test('install writes the stable node link into the status line command', () => {
  const { paths } = fixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'md-node-bin-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    setStatusLine(['alpha'], { paths, source: 'x' });
  } finally {
    process.env.PATH = saved;
  }
  const { command } = JSON.parse(fs.readFileSync(path.join(paths.accountsDir, 'alpha', 'settings.json'), 'utf8')).statusLine;
  assert.ok(command.startsWith(`'${path.join(bin, 'node')}' `), command);
});

// #840 review: quoting changes how a path with an apostrophe is stored; the
// install must still know the entry as its own.
test('a status line installed under a path with an apostrophe is still ours', () => {
  const { home, paths } = fixture();
  const quoted = { ...paths, installed: path.join(home, "it's", 'direct-statusline.mjs') };
  assert.deepEqual(setStatusLine(['alpha'], { paths: quoted, source: 'x' }), [['alpha', 'installed']]);
  assert.deepEqual(setStatusLine(['alpha'], { paths: quoted, source: 'x' }), [['alpha', 'installed']], 'not "has its own status line"');
  assert.deepEqual(setStatusLine(['alpha'], { install: false, paths: quoted }), [['alpha', 'removed']]);
});

// TRIPWIRE: the command written into settings.json, run the way Claude Code
// runs a status line (a shell, the payload on stdin), saves a capture and
// prints nothing.
test('TRIPWIRE the installed status line command captures and stays silent', () => {
  const { home, paths } = fixture();
  setStatusLine(['alpha'], { paths, source: fs.readFileSync(STATUSLINE, 'utf8') });
  const { command } = JSON.parse(fs.readFileSync(path.join(paths.accountsDir, 'alpha', 'settings.json'), 'utf8')).statusLine;
  const run = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(payload(21)), env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.terminalDir, 'alpha.json'), 'utf8')).windows.seven_day.used_percentage, 21);
  const broken = spawnSync('/bin/sh', ['-c', command], { input: 'not json', env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.deepEqual([broken.status, broken.stdout, broken.stderr], [0, '', ''], 'a bad payload never shows an error');
});

test('the status line program never names a credential store or a network API', () => {
  const src = fs.readFileSync(STATUSLINE, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of [/credentials/i, /keychain/i, /security\s/, /\bfetch\s*\(/, /node:https?/, /node:net/, /child_process/, /accessToken|refreshToken/]) {
    assert.doesNotMatch(src, banned, `statusline.mjs must not use ${banned}`);
  }
});
