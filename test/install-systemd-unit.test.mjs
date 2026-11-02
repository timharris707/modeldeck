import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #807: the daemon's systemd user unit. A fake systemctl records calls; no
// real unit is ever installed or started by this suite.
const script = fileURLToPath(new URL('../scripts/install-systemd-unit.sh', import.meta.url));
const repo = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-unit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = path.join(home, 'calls');
  const systemctl = path.join(home, 'systemctl');
  fs.writeFileSync(systemctl, `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  const run = (...args) => spawnSync('/bin/bash', [script, '--node', process.execPath, ...args], {
    env: { HOME: home, PATH: '/usr/bin:/bin', SYSTEMCTL: systemctl, USER: 'placeholder' }, encoding: 'utf8',
  });
  return { home, run, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '') };
}

test('dry run renders a loopback-only unit with no token in it', (t) => {
  const { run } = fixture(t);
  const result = run('--port', '13867', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const unit = result.stdout;
  assert.match(unit, new RegExp(`^ExecStart="${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/src/server\\.mjs"$`, 'm'));
  assert.match(unit, /^Environment="MODELDECK_HOST=127\.0\.0\.1"$/m);
  assert.match(unit, /^Environment="MODELDECK_PORT=13867"$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.doesNotMatch(unit, /MUTATION_TOKEN/);
});

// The scratch run on L.Box found a quoted WorkingDirectory that systemd
// rejects; where systemd exists, the rendered unit must pass its own check.
const analyze = ['/usr/bin/systemd-analyze', '/bin/systemd-analyze'].find((p) => fs.existsSync(p));
// The rebalance role checks /usr/bin/python3 before it renders anything
// (CodeRabbit on #814: guard every rebalance render, not just the first).
const noPython = !fs.existsSync('/usr/bin/python3') && 'no /usr/bin/python3 here';
test('systemd accepts the rendered unit', { skip: (!analyze && 'no systemd-analyze here') || noPython }, (t) => {
  const { home, run } = fixture(t);
  const script = path.join(home, 'rebalance-weights.py');
  fs.writeFileSync(script, '');
  for (const args of [
    ['--port', '13867', '--env', 'MODELDECK_DATA_DIR=/tmp/a b%c'],
    ['--role', 'usage-page', '--env', 'SOURCES=local'],
    ['--role', 'forwarder', '--env', 'POOL_HOST_URL=https://studio.tail0000.ts.net'],
  ]) {
    const result = run(...args, '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    const unit = path.join(home, 'modeldeck-verify.service');
    fs.writeFileSync(unit, result.stdout);
    const verify = spawnSync(analyze, ['verify', '--user', unit], { encoding: 'utf8', env: { ...process.env, SYSTEMD_LOG_LEVEL: 'warning' } });
    assert.equal(verify.status, 0, verify.stderr);
    assert.doesNotMatch(verify.stderr, /modeldeck-verify\.service:\d+/, args.join(' '));
  }
  // The rebalance role renders a service and a timer; each is checked.
  const [service, timer] = run('--role', 'rebalance', '--script', script, '--dry-run').stdout.split('\n\n# Written');
  fs.writeFileSync(path.join(home, 'modeldeck-verify-rebalance.service'), service);
  fs.writeFileSync(path.join(home, 'modeldeck-verify-rebalance.timer'), `# Written${timer}`.replace('modeldeck-rebalance.service', 'modeldeck-verify-rebalance.service'));
  const verify = spawnSync(analyze, ['verify', '--user', path.join(home, 'modeldeck-verify-rebalance.timer'), path.join(home, 'modeldeck-verify-rebalance.service')], { encoding: 'utf8', env: { ...process.env, SYSTEMD_LOG_LEVEL: 'warning' } });
  assert.equal(verify.status, 0, verify.stderr);
  assert.doesNotMatch(verify.stderr, /modeldeck-verify-rebalance\.(service|timer):\d+/);
});

test('scratch env is quoted for systemd; host, port and token overrides are refused', (t) => {
  const { run } = fixture(t);
  const ok = run('--env', 'MODELDECK_DATA_DIR=/tmp/a b%c"d', '--dry-run');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Environment="MODELDECK_DATA_DIR=\/tmp\/a b%%c\\"d"$/m);
  for (const bad of ['MODELDECK_HOST=0.0.0.0', 'MODELDECK_MUTATION_TOKEN=x', 'MODELDECK_PORT=1', 'MODELDECK_PROJECTS_ROOT=relative', 'MODELDECK_SECRETS_DIR=relative', 'MODELDECK_DB_PATH=data/x.sqlite', 'PATH=/evil', 'MODELDECK_X=a\nb']) {
    const result = run('--env', bad, '--dry-run');
    assert.equal(result.status, 1, bad);
  }
  assert.equal(run('--unit', 'other', '--dry-run').status, 1);
  assert.equal(run('--port', '0', '--dry-run').status, 1);
});

test('install writes the unit, reloads, enables and restarts; uninstall removes it', (t) => {
  const { home, run, calls } = fixture(t);
  const result = run('--unit', 'modeldeck-scratch', '--port', '13867');
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(home, '.config', 'systemd', 'user', 'modeldeck-scratch.service');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(calls(), '--user daemon-reload\n--user enable modeldeck-scratch.service\n--user restart modeldeck-scratch.service\n');
  assert.equal(run('--uninstall', '--unit', 'modeldeck-scratch').status, 0);
  assert.equal(fs.existsSync(file), false);
});

// Codex review of #812: no value may start a new unit directive, and
// uninstall touches only a unit this script wrote, never during a dry run.
test('a newline in any path is refused', (t) => {
  const { run } = fixture(t);
  const result = run('--projects-root', '/tmp/x\nEnvironment=MODELDECK_HOST=0.0.0.0', '--dry-run');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(run('--projects-root', 'relative', '--dry-run').status, 1);
  assert.equal(run('--projects-root', '/tmp/x\\', '--dry-run').status, 1);
});

test('uninstall leaves foreign units alone and dry-run changes nothing', (t) => {
  const { home, run, calls } = fixture(t);
  const dir = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const foreign = path.join(dir, 'modeldeck-other.service');
  fs.writeFileSync(foreign, '[Unit]\nDescription=not ours\n');
  assert.equal(run('--uninstall', '--unit', 'modeldeck-other').status, 1);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(run('--unit', 'modeldeck-scratch', '--port', '13867').status, 0);
  const ours = path.join(dir, 'modeldeck-scratch.service');
  const before = calls();
  const dry = run('--uninstall', '--unit', 'modeldeck-scratch', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would run/);
  assert.equal(fs.existsSync(ours), true);
  assert.equal(calls(), before);
});

// #809/#810: the host and client pieces render through the same checks.
test('the forwarder check ignores HOST and HOSTS from the caller', (t) => {
  // CodeRabbit on #814: the rendered unit sets neither, so the check must not read them.
  const { home } = fixture(t);
  const result = spawnSync('/bin/bash', [script, '--node', process.execPath, '--role', 'forwarder', '--env', 'POOL_HOST_URL=https://hub.tail0000.ts.net', '--dry-run'], {
    env: { HOME: home, PATH: '/usr/bin:/bin', USER: 'placeholder', HOST: '0.0.0.0', HOSTS: 'legacy' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('usage page and forwarder roles render loopback units and validate their settings', (t) => {
  const { run } = fixture(t);
  const page = run('--role', 'usage-page', '--env', 'SOURCES=local', '--env', 'MACHINE_LABEL=L Box', '--dry-run');
  assert.equal(page.status, 0, page.stderr);
  assert.match(page.stdout, /tools\/phone-deck\/server\.mjs"$/m);
  assert.match(page.stdout, /^Environment="HOSTS=127\.0\.0\.1"$/m);
  assert.match(page.stdout, /^Environment="PORT=3871"$/m);
  assert.match(page.stdout, /^Environment="MACHINE_LABEL=L Box"$/m);
  assert.equal(run('--role', 'usage-page', '--env', 'SOURCES=hub', '--dry-run').status, 1);
  assert.equal(run('--role', 'usage-page', '--env', 'HOSTS=0.0.0.0', '--dry-run').status, 1);
  assert.equal(run('--role', 'usage-page', '--env', 'MODELDECK_DATA_DIR=/x', '--dry-run').status, 1);
  const forwarder = run('--role', 'forwarder', '--env', 'POOL_HOST_URL=https://studio.tail0000.ts.net', '--dry-run');
  assert.equal(forwarder.status, 0, forwarder.stderr);
  assert.match(forwarder.stdout, /tools\/pool-forwarder\/forwarder\.mjs"$/m);
  assert.match(forwarder.stdout, /^Environment="PORT=8317"$/m);
  assert.equal(run('--role', 'forwarder', '--env', 'POOL_HOST_URL=http://studio.tail0000.ts.net', '--dry-run').status, 1);
  assert.equal(run('--role', 'forwarder', '--dry-run').status, 1);
});

test('rebalance role renders a oneshot service and a 300 s timer, and removes both', { skip: noPython }, (t) => {
  const { home, run, calls } = fixture(t);
  const script = path.join(home, 'rebalance-weights.py');
  fs.writeFileSync(script, '');
  const dry = run('--role', 'rebalance', '--script', script, '--env', 'CLIPROXY_PORT=18317', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^Type=oneshot$/m);
  assert.match(dry.stdout, /^ExecStart="\/usr\/bin\/python3" -I ".*rebalance-weights\.py"$/m);
  assert.match(dry.stdout, /^OnUnitActiveSec=300$/m);
  assert.match(dry.stdout, /^Environment="CLIPROXY_PORT=18317"$/m);
  assert.equal(run('--role', 'rebalance', '--script', path.join(home, 'absent.py'), '--dry-run').status, 1);
  assert.equal(run('--role', 'rebalance', '--script', script, '--unit', 'modeldeck-scratch-rebalance').status, 0);
  const dir = path.join(home, '.config', 'systemd', 'user');
  assert.ok(fs.existsSync(path.join(dir, 'modeldeck-scratch-rebalance.timer')));
  assert.match(calls(), /--user enable modeldeck-scratch-rebalance\.timer/);
  assert.equal(run('--role', 'rebalance', '--uninstall', '--unit', 'modeldeck-scratch-rebalance').status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'modeldeck-scratch-rebalance.timer')), false);
  assert.equal(fs.existsSync(path.join(dir, 'modeldeck-scratch-rebalance.service')), false);
});

// Codex review of #814.
test('port settings are plain numbers and the rebalancer always reads this machine', { skip: noPython }, (t) => {
  const { home, run } = fixture(t);
  const script = path.join(home, 'rebalance-weights.py');
  fs.writeFileSync(script, '');
  for (const env of ['MODELDECK_PORT=3867@evil.example', 'CLIPROXY_PORT=0', 'MODELDECK_PORT=99999']) {
    assert.equal(run('--role', 'rebalance', '--script', script, '--env', env, '--dry-run').status, 1, env);
  }
  assert.equal(run('--role', 'usage-page', '--env', 'DAEMON_PORT=1@x', '--dry-run').status, 1);
  const dry = run('--role', 'rebalance', '--script', script, '--dry-run');
  assert.match(dry.stdout, /^Environment="MODELDECK_HOST=127\.0\.0\.1"$/m);
});

test('an uninstall whose stop fails keeps the unit file', (t) => {
  const { home, run } = fixture(t);
  assert.equal(run('--unit', 'modeldeck-scratch', '--port', '13867').status, 0);
  const file = path.join(home, '.config', 'systemd', 'user', 'modeldeck-scratch.service');
  fs.writeFileSync(path.join(home, 'systemctl'), '#!/bin/sh\ncase "$*" in *disable*) exit 1;; esac\n', { mode: 0o755 });
  const result = run('--uninstall', '--unit', 'modeldeck-scratch');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not stop/);
  assert.equal(fs.existsSync(file), true);
});
