import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #809/#810: the systemd counterpart of pool-target.sh. Fake systemctl, lsof
// and curl record every call; no real unit, port, proxy or daemon is touched.
const script = fileURLToPath(new URL('../scripts/pool-target-linux.sh', import.meta.url));
const HUB = 'https://studio.tail0000.ts.net';
const PAGE = 'http://100.64.0.10:3871';

function fixture(t, { units, settings = '{"proxyRole":"host","poolHubUrl":""}', env: extra = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-target-linux-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const home = path.join(dir, 'home');
  const secrets = path.join(home, '.config', 'modeldeck');
  fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
  fs.chmodSync(secrets, 0o700);
  fs.writeFileSync(path.join(secrets, 'mutation-token'), 'placeholder-mutation-token\n', { mode: 0o600 });
  const record = path.join(dir, 'calls'); fs.writeFileSync(record, '');
  const state = path.join(dir, 'units.json');
  fs.writeFileSync(state, JSON.stringify(units ?? {
    'cliproxyapi.service': { enabled: 'enabled', active: 'active', pid: 111 },
    'modeldeck-rebalance.timer': { enabled: 'enabled', active: 'active', pid: 0 },
  }));
  const stub = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify({ name, args, secretInEnv: Object.values(process.env).some((v) => /placeholder-(mutation-token|machine-key)/.test(v)) }) + '\\n');
if (process.env.FAIL === name + ':' + args.at(-1)) process.exit(7);
if (name === 'systemctl') {
  const units = JSON.parse(fs.readFileSync(process.env.UNITS, 'utf8'));
  const rest = args.filter((a) => a !== '--user');
  const unit = rest.at(-1);
  const u = units[unit] ?? units[unit + '.service'];
  if (rest[0] === 'is-enabled') { console.log(u?.enabled ?? 'not-found'); process.exit(u?.enabled === 'enabled' ? 0 : 1); }
  if (rest[0] === 'is-active') { console.log(u?.active ?? 'inactive'); process.exit(u?.active === 'active' ? 0 : 3); }
  if (rest[0] === 'show') { console.log(rest.includes('Environment') ? (u?.env ?? '') : (u?.pid ?? 0)); process.exit(0); }
  const set = (patch) => { units[unit] = { ...(u ?? {}), ...patch }; fs.writeFileSync(process.env.UNITS, JSON.stringify(units)); };
  if (rest[0] === 'disable') set({ enabled: 'disabled', ...(rest.includes('--now') ? { active: 'inactive', pid: 0 } : {}) });
  if (rest[0] === 'enable') set({ enabled: 'enabled', ...(rest.includes('--now') ? { active: 'active', pid: 999 } : {}) });
  if (rest[0] === 'restart' || rest[0] === 'start') set({ active: 'active', pid: 999 });
  if (rest[0] === 'stop') set({ active: 'inactive', pid: 0 });
  process.exit(0);
}
if (name === 'lsof') { if (process.env.PORT_HOLDER) { console.log(process.env.PORT_HOLDER); process.exit(0); } process.exit(1); }
if (name === 'curl') {
  if (args.includes('PUT')) { let text = ''; for await (const c of process.stdin) text += c; fs.writeFileSync(process.env.HEADERS, text); console.log('{}'); }
  else if (args.includes('--config')) { let text = ''; for await (const c of process.stdin) text += c; fs.appendFileSync(process.env.MANAGEMENT_INPUT, JSON.stringify({ args, config: text }) + '\\n'); console.log(args.includes('PATCH') ? '{}' : '{"api-keys":["placeholder-other-key"]}'); }
  else if (args.at(-1).endsWith('/healthz')) { if (process.env.BAD_HEALTH === '1') process.exit(7); console.log('{"status":"ok"}'); }
  else if (args.at(-1).endsWith('/api/state')) console.log('{"accounts":[]}');
  else console.log(process.env.SETTINGS);
}
`;
  for (const name of ['systemctl', 'lsof', 'curl']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });
  const headers = path.join(dir, 'headers');
  const management = path.join(dir, 'management');
  fs.writeFileSync(management, '');
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, NODE: process.execPath, RECORD: record, UNITS: state, HEADERS: headers,
    MANAGEMENT_INPUT: management, SETTINGS: settings, SYSTEMCTL: path.join(bin, 'systemctl'), LSOF: path.join(bin, 'lsof'),
    CURL: path.join(bin, 'curl'), SLEEP: path.join(bin, 'sleep'), ...extra,
  };
  const run = (...args) => spawnSync('/bin/bash', [script, ...args], { env, encoding: 'utf8' });
  const calls = () => fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const units_ = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  return { dir, home, secrets, run, calls, units: units_, headers, management, forwarderFile: path.join(home, '.config', 'systemd', 'user', 'modeldeck-pool-forwarder.service') };
}

const systemctlCalls = (calls) => calls.filter((c) => c.name === 'systemctl' && !['is-enabled', 'is-active', 'show'].includes(c.args[1])).map((c) => c.args.join(' '));

test('a dry run prints the plan and changes nothing', (t) => {
  const f = fixture(t);
  const result = f.run('remote', '--hub-url', HUB, '--page-url', PAGE);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /disable --now modeldeck-rebalance\.timer/);
  assert.match(result.stdout, /Dry-run: nothing changed/);
  assert.deepEqual(f.calls(), []);
});

test('remote stops the local pool, installs the forwarder and switches the daemon, token by stdin only', (t) => {
  const f = fixture(t);
  const result = f.run('remote', '--hub-url', HUB, '--page-url', PAGE, '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(systemctlCalls(f.calls()).slice(0, 2), [
    '--user disable --now modeldeck-rebalance.timer', '--user disable --now cliproxyapi.service',
  ]);
  const unit = fs.readFileSync(f.forwarderFile, 'utf8');
  assert.match(unit, /^Environment="POOL_HOST_URL=https:\/\/studio\.tail0000\.ts\.net"$/m);
  assert.match(unit, /^Environment="PORT=8317"$/m);
  assert.equal(f.units()['modeldeck-pool-forwarder.service'].active, 'active');
  assert.match(fs.readFileSync(f.headers, 'utf8'), /^x-modeldeck-token: placeholder-mutation-token$/m);
  const put = f.calls().find((c) => c.name === 'curl' && c.args.includes('PUT'));
  assert.match(put.args.at(-1), /"proxyRole":"remote"/);
  for (const call of f.calls()) {
    assert.equal(call.secretInEnv, false, `${call.name} saw a secret in its env`);
    assert.ok(!call.args.some((a) => a.includes('placeholder-mutation-token')), `${call.name} saw a secret in argv`);
  }
  assert.match(result.stdout, /Pool target is now remote/);
});

test('a failed health check prints an undo that restores the units and settings', (t) => {
  const f = fixture(t, { env: { BAD_HEALTH: '1' } });
  const result = f.run('remote', '--hub-url', HUB, '--page-url', PAGE, '--yes');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Undo commands/);
  assert.match(result.stderr, /enable cliproxyapi\.service/);
  assert.match(result.stderr, /start cliproxyapi\.service/);
  assert.match(result.stderr, /enable modeldeck-rebalance\.timer/);
  assert.match(result.stderr, /disable --now modeldeck-pool-forwarder\.service/);
  assert.ok(!result.stderr.includes('placeholder-mutation-token'));
  assert.ok(!f.calls().some((c) => c.name === 'curl' && c.args.includes('PUT')));
});

test('a port held by anything but the proxy or forwarder stops the cutover before any change', (t) => {
  const f = fixture(t, { env: { PORT_HOLDER: '4242' } });
  const result = f.run('remote', '--hub-url', HUB, '--page-url', PAGE, '--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /held by PID 4242/);
  assert.match(result.stderr, /No changes were made/);
  assert.deepEqual(systemctlCalls(f.calls()), []);
});

test('an unsafe token file is refused before any change', (t) => {
  const f = fixture(t);
  fs.chmodSync(path.join(f.secrets, 'mutation-token'), 0o644);
  const result = f.run('remote', '--hub-url', HUB, '--page-url', PAGE, '--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read the mutation token file/);
  assert.deepEqual(systemctlCalls(f.calls()), []);
});

test('host removes the forwarder, restarts the local pool and admits the machine key', (t) => {
  const f = fixture(t, {
    settings: `{"proxyRole":"remote","poolHubUrl":"${PAGE}"}`,
    units: {
      'cliproxyapi.service': { enabled: 'disabled', active: 'inactive', pid: 0 },
      'modeldeck-rebalance.timer': { enabled: 'disabled', active: 'inactive', pid: 0 },
    },
  });
  fs.mkdirSync(path.dirname(f.forwarderFile), { recursive: true });
  fs.writeFileSync(f.forwarderFile, '# Written by scripts/install-systemd-unit.sh. Re-run it to change; do not edit.\n');
  fs.writeFileSync(path.join(f.secrets, 'pool-client-key'), 'placeholder-machine-key-000000000000\n', { mode: 0o600 });
  fs.mkdirSync(path.join(f.home, '.config', 'cliproxyapi'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.config', 'cliproxyapi', '.mgmt-key'), 'placeholder-management-key\n');
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  const units = f.units();
  assert.equal(units['cliproxyapi.service'].active, 'active');
  assert.equal(units['modeldeck-rebalance.timer'].enabled, 'enabled');
  assert.equal(fs.existsSync(f.forwarderFile), false);
  const put = f.calls().find((c) => c.name === 'curl' && c.args.includes('PUT'));
  assert.match(put.args.at(-1), /"proxyRole":"host"/);
  if (process.platform !== 'darwin') {
    const patches = fs.readFileSync(f.management, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((m) => m.args.includes('PATCH'));
    assert.equal(patches.length, 1);
    assert.match(patches[0].config, /placeholder-machine-key/);
    assert.ok(patches[0].args.includes('http://127.0.0.1:8317/v0/management/api-keys'));
  }
});

// CodeRabbit on #814: host mode wakes the rebalancer, so its service must read
// this switch's proxy and daemon; a scratch run never rebalances the live pool.
test('host refuses a rebalance timer whose service reads another proxy or daemon', (t) => {
  const f = fixture(t, { units: {
    'cliproxyapi.service': { enabled: 'disabled', active: 'inactive', pid: 0 },
    'modeldeck-rebalance.timer': { enabled: 'disabled', active: 'inactive', pid: 0 },
    'modeldeck-rebalance.service': { env: 'MODELDECK_HOST=127.0.0.1 CLIPROXY_PORT=18317 MODELDECK_PORT=13867' },
  } });
  for (const args of [['host'], ['host', '--yes']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /modeldeck-rebalance\.timer reads proxy port 18317 and daemon port 13867, but this switch uses 8317 and 3867/);
    assert.doesNotMatch(result.stdout, /Plan/);
  }
  assert.deepEqual(systemctlCalls(f.calls()), []);
  assert.ok(!f.calls().some((c) => c.name === 'curl'));
});

test('host accepts a scratch rebalance timer that reads the scratch proxy and daemon', (t) => {
  const f = fixture(t, {
    env: { PROXY_PORT: '18317', PROXY_UNIT: 'modeldeck-scratch-proxy.service', REBALANCE_UNIT: 'modeldeck-scratch-rebalance.timer', DAEMON_URL: 'http://127.0.0.1:13867' },
    units: {
      'modeldeck-scratch-proxy.service': { enabled: 'disabled', active: 'inactive', pid: 0 },
      'modeldeck-scratch-rebalance.timer': { enabled: 'disabled', active: 'inactive', pid: 0 },
      'modeldeck-scratch-rebalance.service': { env: 'MODELDECK_HOST=127.0.0.1 CLIPROXY_PORT=18317 MODELDECK_PORT=13867' },
    },
  });
  const result = f.run('host');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry-run: nothing changed/);
});

test('a scratch proxy port moves health, the port check and the forwarder together', (t) => {
  const f = fixture(t, { env: { PROXY_PORT: '18317', PROXY_UNIT: 'modeldeck-scratch-proxy.service' },
    units: { 'modeldeck-scratch-proxy.service': { enabled: 'enabled', active: 'active', pid: 111 } } });
  const result = f.run('remote', '--hub-url', HUB, '--page-url', PAGE, '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls().some((c) => c.name === 'curl' && c.args.at(-1) === 'http://127.0.0.1:18317/healthz'));
  assert.ok(f.calls().some((c) => c.name === 'lsof' && c.args.includes('-iTCP:18317')));
  assert.match(fs.readFileSync(f.forwarderFile, 'utf8'), /^Environment="PORT=18317"$/m);
  assert.ok(!systemctlCalls(f.calls()).some((c) => c.includes('cliproxyapi.service')));
});

// Codex review of #814. The printed undo is replayed through the same fakes,
// so these check where the units end up, not just what was printed.
function replayUndo(f, stderr) {
  const undo = stderr.split(/Undo commands, in order[^\n]*\n/)[1];
  assert.ok(undo, 'an undo block was printed');
  const env = { HOME: f.home, PATH: `${path.join(f.dir, 'bin')}:/usr/bin:/bin`, RECORD: path.join(f.dir, 'calls'), UNITS: path.join(f.dir, 'units.json'), HEADERS: f.headers, MANAGEMENT_INPUT: f.management, SETTINGS: '{}' };
  const result = spawnSync('/bin/bash', ['-c', undo], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('a failed host switch undoes to the exact prior unit states', (t) => {
  const f = fixture(t, {
    settings: `{"proxyRole":"remote","poolHubUrl":"${PAGE}"}`,
    env: { BAD_HEALTH: '1' },
    units: {
      'cliproxyapi.service': { enabled: 'enabled', active: 'inactive', pid: 0 },
      'modeldeck-rebalance.timer': { enabled: 'disabled', active: 'active', pid: 0 },
    },
  });
  const result = f.run('host', '--yes');
  assert.notEqual(result.status, 0);
  replayUndo(f, result.stderr);
  const units = f.units();
  assert.deepEqual([units['cliproxyapi.service'].enabled, units['cliproxyapi.service'].active], ['enabled', 'inactive']);
  assert.deepEqual([units['modeldeck-rebalance.timer'].enabled, units['modeldeck-rebalance.timer'].active], ['disabled', 'active']);
});

test('a failed remote switch restores an existing forwarder exactly', (t) => {
  for (const [enabled, active] of [['enabled', 'inactive'], ['disabled', 'active']]) {
    const f = fixture(t, {
      env: { BAD_HEALTH: '1' },
      units: {
        'cliproxyapi.service': { enabled: 'enabled', active: 'active', pid: 111 },
        'modeldeck-pool-forwarder.service': { enabled, active, pid: active === 'active' ? 222 : 0 },
      },
    });
    fs.mkdirSync(path.dirname(f.forwarderFile), { recursive: true });
    fs.writeFileSync(f.forwarderFile, '# Written by scripts/install-systemd-unit.sh. Re-run it to change; do not edit.\nold\n');
    const result = f.run('remote', '--hub-url', HUB, '--page-url', PAGE, '--yes');
    assert.notEqual(result.status, 0);
    replayUndo(f, result.stderr);
    const forwarder = f.units()['modeldeck-pool-forwarder.service'];
    assert.deepEqual([forwarder.enabled, forwarder.active], [enabled, active], `${enabled}/${active}`);
    assert.match(fs.readFileSync(f.forwarderFile, 'utf8'), /^old$/m);
    assert.equal(f.units()['cliproxyapi.service'].active, 'active');
  }
});

test('status and the plan check every URL before using or printing it', (t) => {
  const f = fixture(t);
  for (const DAEMON_URL of ['https://attacker.example/loot', '-K/tmp/x', 'http://127.0.0.1:3867/x']) {
    const bad = fixture(t, { env: { DAEMON_URL } });
    const result = bad.run('status');
    assert.equal(result.status, 2, DAEMON_URL);
    assert.deepEqual(bad.calls(), []);
  }
  const leaked = f.run('remote', '--hub-url', 'https://user:placeholder-secret@studio.tail0000.ts.net', '--page-url', PAGE);
  assert.notEqual(leaked.status, 0);
  assert.ok(!(leaked.stdout + leaked.stderr).includes('placeholder-secret'));
  assert.deepEqual(f.calls(), []);
});

test('host mode says so when the machine key file is missing', { skip: process.platform === 'darwin' && 'the machine key is Linux-only' }, (t) => {
  const f = fixture(t, { settings: `{"proxyRole":"remote","poolHubUrl":"${PAGE}"}` });
  fs.mkdirSync(path.join(f.home, '.config', 'cliproxyapi'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.config', 'cliproxyapi', '.mgmt-key'), 'placeholder-management-key\n');
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No .*pool-client-key: this machine's Claude profiles have no key/);
});
