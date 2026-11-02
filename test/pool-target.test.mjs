import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// launchd and Keychain behaviour; Linux runs pool-target-linux.sh (#809).
const macOnly = { skip: process.platform !== 'darwin' && 'pool-target.sh hands off to pool-target-linux.sh off macOS' };

function fixture(t, extra = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-target-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const record = path.join(dir, 'calls'); fs.writeFileSync(record, '');
  const headers = path.join(dir, 'headers');
  const stub = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const prior = fs.readFileSync(process.env.RECORD, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
fs.appendFileSync(process.env.RECORD, JSON.stringify({name,args,at:Date.now(),secretInEnv:Object.values(process.env).some(v=>/placeholder-(mutation-token|profile-key|management-key)/.test(v))})+'\\n');
if (process.env.FAIL === name + ':' + args[0] || (name === 'curl' && process.env.FAIL === 'curl:--fail' && args.includes('--fail'))) process.exit(7);
if (name === 'security') {
 const service = args[args.indexOf('-s') + 1];
 if (process.env.EMPTY_TOKEN === '1') process.exit(0);
 console.log(service === 'modeldeck' ? 'placeholder-mutation-token' : service === 'cli-proxy-api-client.already' ? 'placeholder-profile-key-already-00000000' : 'placeholder-profile-key-new');
}
if (name === 'launchctl') {
 const label = args[1]?.split('/').at(-1);
 if (args[0] === 'print') {
  if (process.env.UNLOADED === '1' || (process.env.HOST_JOBS_LOADED !== '1' && label !== 'ai.modeldeck.pool-forwarder' && process.env.SETTINGS?.includes('remote'))) process.exit(1);
  console.log('pid = ' + (label === 'com.cliproxyapi.server' ? '111' : label === 'com.cliproxyapi.rebalance-weights' ? '222' : '333'));
 }
 if (args[0] === 'print-disabled') console.log('"com.cliproxyapi.server" => disabled\\n"com.cliproxyapi.rebalance-weights" => disabled');
}
if (name === 'lsof' && process.env.PORT_HOLDER) {
 console.log(args.includes('-t') ? process.env.PORT_HOLDER : 'p'+process.env.PORT_HOLDER+'\\ncModelDeck');
}
if (name === 'curl') {
 if (args.includes('PUT')) {
  let text=''; for await (const chunk of process.stdin) text+=chunk;
  fs.writeFileSync(process.env.HEADERS,text);
  console.log('{}');
 } else if (args.includes('--config')) {
  if (process.env.FAIL_MANAGEMENT && args.includes(process.env.FAIL_MANAGEMENT)) process.exit(7);
  let text=''; for await (const chunk of process.stdin) text+=chunk;
  fs.appendFileSync(process.env.MANAGEMENT_INPUT, JSON.stringify({args,config:text})+'\\n');
  if (args.includes('PATCH')) console.log('{}');
  else console.log(process.env.EMPTY_KEYS === '1' ? '{"api-keys":[]}' : '{"api-keys":["placeholder-profile-key-already-00000000"]}');
 } else if (args.at(-1).endsWith('/healthz')) {
  const n = prior.filter(c=>c.name==='curl' && c.args.at(-1)?.endsWith('/healthz')).length;
  if (n < Number(process.env.HEALTH_FAILURES || 0)) process.exit(7);
  console.log(process.env.BAD_HEALTH === '1' ? '{"status":"bad"}' : '{"status":"ok"}');
 } else if (args.at(-1).endsWith('/api/state')) {
  if (process.env.DAEMON_DOWN === '1') process.exit(7);
  console.log(process.env.STATE || '{"accounts":[]}');
 } else {
  if (process.env.DAEMON_DOWN === '1') process.exit(7);
  console.log(process.env.SETTINGS || '{"proxyRole":"host","poolHubUrl":""}');
 }
}
`;
  for (const name of ['launchctl', 'lsof', 'curl', 'security', 'launch-agent.sh', 'sleep']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
  fs.renameSync(path.join(bin, 'launch-agent.sh'), path.join(bin, 'launch-agent.mjs'));
  fs.symlinkSync('launch-agent.mjs', path.join(bin, 'launch-agent.sh'));
  const agents = path.join(dir, 'agents'); fs.mkdirSync(agents);
  for (const label of ['com.cliproxyapi.server', 'com.cliproxyapi.rebalance-weights', 'ai.modeldeck.pool-forwarder']) fs.writeFileSync(path.join(agents, `${label}.plist`), '<plist/>');
  const managementInput = path.join(dir, 'management-input');
  fs.writeFileSync(path.join(dir, 'mgmt-key'), 'placeholder-management-key');
  const env = { ...process.env, HOME: dir, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}`, RECORD: record, HEADERS: headers, MANAGEMENT_INPUT: managementInput, MANAGEMENT_KEY_FILE: path.join(dir, 'mgmt-key'),
    LAUNCHCTL: path.join(bin, 'launchctl'), LSOF: path.join(bin, 'lsof'), CURL: path.join(bin, 'curl'),
    SECURITY: path.join(bin, 'security'), FORWARDER_DIR: bin, LAUNCH_AGENTS_DIR: agents,
    NODE: process.execPath, SLEEP: path.join(bin, 'sleep'), DAEMON_URL: 'http://127.0.0.1:13867', ...extra };
  return { run: (...args) => spawnSync('/bin/bash', ['scripts/pool-target.sh', ...args], { env, encoding: 'utf8' }),
    restore: (pythonFailure = null, failureTarget = 'codex') => {
      const preload = path.join(dir, 'python-stub.mjs');
      fs.writeFileSync(preload, `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync;
childProcess.spawnSync = (command, ...args) => {
  if (command !== '/usr/bin/python3') throw new Error('unexpected spawn');
  fs.appendFileSync(process.env.RECORD, JSON.stringify({ name: 'python', args: [] }) + '\\n');
  const target = args[0].at(-2) === 'read' ? 't3' : args[0].at(-1) === 'read' ? 'codex' : null;
  const failure = target === ${JSON.stringify(failureTarget)} ? ${JSON.stringify(pythonFailure)} : null;
  if (failure === 'missing') return { status: null, error: Object.assign(new Error('placeholder-profile-key-child-error'), { code: 'ENOENT' }), output: null };
  if (failure !== null) return { status: failure, output: [null, 'placeholder-profile-key-stdout', 'placeholder-profile-key-stderr', null] };
  return spawn(command, ...args);
};
syncBuiltinESMExports();
`);
      return spawnSync(process.execPath, ['--import', preload, 'tools/pool-forwarder/restore-local-keys.mjs', env.DAEMON_URL], { env, encoding: 'utf8', timeout: 10_000 });
    },
    calls: () => fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse), headers, dir, env, managementInput };
}
const remote = ['remote', '--hub-url', 'https://studio.tail0000.ts.net', '--page-url', 'http://100.64.0.10:3871'];

test('dry-run prints all actions and records zero external stub calls', macOnly, (t) => {
  const f = fixture(t);
  for (const args of [remote, ['host']]) {
    const result = f.run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls(), [], 'dry-run must execute zero external commands');
    assert.match(result.stdout, /dry.run/i);
    assert.match(result.stdout, /healthz/);
    assert.match(result.stdout, /proxyRole/);
    assert.deepEqual(f.calls(), []);
  }
});

test('remote --yes stops jobs, installs, checks health then mutates; token stays out of argv', macOnly, (t) => {
  const f = fixture(t);
  const result = f.run(...remote, '--yes');
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const actions = calls.filter(({name,args}) => (name === 'launchctl' && args[0] === 'bootout') || name === 'launch-agent.sh' || (name === 'curl' && (args.includes('PUT') || args.at(-1).endsWith('/healthz'))));
  assert.deepEqual(actions.map(({ name, args }) => `${name}:${args[0]}`), ['launchctl:bootout', 'launchctl:bootout', 'launch-agent.sh:install', 'curl:--disable', 'curl:--disable']);
  assert.match(actions[0].args[1], /rebalance-weights$/);
  assert.match(actions[1].args[1], /com.cliproxyapi.server$/);
  const put = calls.find(({ args }) => args.includes('PUT'));
  assert.deepEqual(JSON.parse(put.args[put.args.indexOf('--data') + 1]), { proxyRole: 'remote', poolHubUrl: 'http://100.64.0.10:3871' });
  assert.ok(put.args.includes('@-'));
  assert.doesNotMatch(JSON.stringify(calls), /placeholder-mutation-token/);
  assert.match(fs.readFileSync(f.headers, 'utf8'), /x-modeldeck-token: placeholder-mutation-token\nCookie: modeldeck_session=placeholder-mutation-token/);
});

test('host --yes reverses: settings, uninstall, bootstrap jobs, local health', macOnly, (t) => {
  const f = fixture(t, { SETTINGS: '{"proxyRole":"remote","poolHubUrl":"http://100.64.0.10:3871"}' });
  const result = f.run('host', '--yes'); assert.equal(result.status, 0, result.stderr);
  const actions = f.calls().filter(({name,args}) => name === 'launch-agent.sh' || (name === 'launchctl' && args[0] === 'bootstrap') || (name === 'curl' && (args.includes('PUT') || args.at(-1).endsWith('/healthz'))));
  assert.deepEqual(actions.map(({name,args}) => `${name}:${args[0]}`), ['curl:--disable', 'launch-agent.sh:uninstall', 'launchctl:bootstrap', 'launchctl:bootstrap', 'curl:--disable']);
  assert.match(actions[2].args[2], /com.cliproxyapi.server.plist$/);
  assert.match(actions[3].args[2], /rebalance-weights.plist$/);
});

test('a failed install stops before health/settings and prints exact undo commands', macOnly, (t) => {
  const f = fixture(t, { FAIL: 'launch-agent.sh:install' });
  const result = f.run(...remote, '--yes');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Undo/);
  assert.match(result.stderr, /bootstrap.*com.cliproxyapi.server.plist/);
  assert.match(result.stderr, /bootstrap.*rebalance-weights.plist/);
  assert.equal(f.calls().filter(({args}) => args.includes('PUT') || args.at(-1)?.endsWith('/healthz')).length, 0);
});

test('health failure stops before settings and retains undo for stopped jobs', macOnly, (t) => {
  const f = fixture(t, { BAD_HEALTH: '1' });
  const result = f.run(...remote, '--yes');
  assert.notEqual(result.status, 0);
  const firstPoll = f.calls().find(c => c.name === 'curl' && c.args.at(-1)?.endsWith('/healthz'));
  assert.ok(Date.now() - firstPoll.at < 14000, 'health wait is bounded independently of fixture startup');
  assert.match(result.stderr, /healthz.*10 seconds/);
  assert.match(result.stderr, /Undo/);
  assert.equal(f.calls().some(({args}) => args.includes('PUT')), false);
});

test('failed mutation prints token-safe settings restore and stops host cutover', macOnly, (t) => {
  const f = fixture(t, { FAIL: 'security:find-generic-password', SETTINGS: '{"proxyRole":"remote","poolHubUrl":"http://100.64.0.10:3871"}' });
  const result = f.run('host', '--yes');
  assert.notEqual(result.status, 0);
  assert.equal(f.calls().some(({name}) => name === 'launch-agent.sh'), false);
  assert.equal(f.calls().some(({args}) => args.includes('PUT')), false, 'failed Keychain read must not start a mutation');
  assert.match(result.stderr, /Undo commands/);
  assert.match(result.stderr, /No changes were made/);
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(f.calls()), /placeholder-mutation-token/);
});

test('unloaded remote jobs and absent host plists are skipped', macOnly, (t) => {
  const f = fixture(t, { UNLOADED: '1' });
  assert.equal(f.run(...remote, '--yes').status, 0);
  assert.equal(f.calls().some(({name,args}) => name === 'launchctl' && args[0] === 'bootout'), false);
  for (const label of ['com.cliproxyapi.server', 'com.cliproxyapi.rebalance-weights']) fs.unlinkSync(path.join(f.env.LAUNCH_AGENTS_DIR, `${label}.plist`));
  const result = f.run('host', '--yes'); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().some(({name,args}) => name === 'launchctl' && args[0] === 'bootstrap'), false);
});

test('status only reads settings, listeners and agent state', macOnly, (t) => {
  const f = fixture(t);
  const result = f.run('status'); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().filter(({name,args}) => name === 'launchctl' && args[0] === 'print').length, 3);
  assert.equal(f.calls().filter(({name}) => name === 'lsof').length, 1);
  assert.equal(f.calls().some(({name,args}) => name === 'security' || args.includes('PUT')), false);
});

test('invalid URLs fail before any service or Keychain call', macOnly, (t) => {
  const f = fixture(t);
  assert.notEqual(f.run('remote', '--hub-url', 'http://studio', '--page-url', 'http://100.64.0.10:3871', '--yes').status, 0);
  assert.deepEqual(f.calls(), []);
  const external = fixture(t, { DAEMON_URL: 'https://external.example' });
  assert.notEqual(external.run(...remote, '--yes').status, 0);
  assert.deepEqual(external.calls(), []);
});

test('failed host bootstrap does not offer to stop a job it did not start', macOnly, (t) => {
  const f = fixture(t, { FAIL: 'launchctl:bootstrap', UNLOADED: '1' });
  const result = f.run('host', '--yes');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Undo commands/);
  assert.doesNotMatch(result.stderr, /bootout gui\/\d+\/com\.cliproxyapi.server/);
  assert.equal(f.calls().some(({args}) => args.at(-1)?.endsWith('/healthz')), false);
});

test('printed undo commands restore prior settings using stdin-only token headers', macOnly, (t) => {
  const f = fixture(t, { FAIL: 'launchctl:bootstrap', SETTINGS: '{"proxyRole":"remote","poolHubUrl":"http://100.64.0.10:3871"}' });
  const result = f.run('host', '--yes'); assert.notEqual(result.status, 0);
  const undo = result.stderr.slice(result.stderr.indexOf('\n') + 1);
  const restored = spawnSync('/bin/bash', ['-c', undo], { env: { ...f.env, FAIL: '' }, encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  const puts = f.calls().filter(({args}) => args.includes('PUT'));
  assert.equal(puts.length, 2);
  assert.deepEqual(JSON.parse(puts[1].args[puts[1].args.indexOf('--data') + 1]), { proxyRole: 'remote', poolHubUrl: 'http://100.64.0.10:3871' });
  assert.doesNotMatch(undo + JSON.stringify(f.calls()), /placeholder-mutation-token/);
});


test('health succeeding on the third poll prints no false cutover failure', macOnly, (t) => {
  const f = fixture(t, { HEALTH_FAILURES: '2' });
  const result = f.run(...remote, '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /Cutover stopped|Undo commands/);
  assert.equal(f.calls().filter(c => c.name === 'curl' && c.args.at(-1)?.endsWith('/healthz')).length, 3);
});

test('a real command-substitution failure prints undo exactly once', macOnly, (t) => {
  const f = fixture(t, { FAIL: 'curl:--fail' });
  const result = f.run(...remote, '--yes');
  assert.notEqual(result.status, 0);
  assert.equal((result.stderr.match(/Cutover stopped/g) || []).length, 1, result.stderr);
});

test('missing or empty mutation token refuses remote before any launchctl call', macOnly, (t) => {
  for (const extra of [{ FAIL: 'security:find-generic-password' }, { EMPTY_TOKEN: '1' }]) {
    const f = fixture(t, extra);
    const result = f.run(...remote, '--yes');
    assert.notEqual(result.status, 0);
    assert.equal(f.calls().some(c => c.name === 'launchctl' || c.name === 'launch-agent.sh'), false);
    assert.equal((result.stderr.match(/Cutover stopped/g) || []).length, 1);
  }
});

test('remote disables before bootout and host enables before bootstrap', macOnly, (t) => {
  for (const mode of ['remote', 'host']) {
    const f = fixture(t, mode === 'host' ? { SETTINGS: '{"proxyRole":"remote","poolHubUrl":"http://100.64.0.10:3871"}' } : {});
    const result = f.run(...(mode === 'remote' ? remote : ['host']), '--yes');
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls().filter(c => c.name === 'launchctl' && ['disable','bootout','enable','bootstrap'].includes(c.args[0]));
    assert.deepEqual(calls.map(c => c.args[0]), mode === 'remote' ? ['disable','bootout','disable','bootout'] : ['enable','bootstrap','enable','bootstrap']);
  }
});

test('status reports disabled jobs even when the daemon is down', macOnly, (t) => {
  const f = fixture(t, { DAEMON_DOWN: '1' });
  const result = f.run('status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /daemon not answering/);
  assert.match(result.stdout, /Port 8317 listeners/);
  assert.match(result.stdout, /"com.cliproxyapi.server" => disabled/);
  assert.ok(f.calls().some(c => c.name === 'launchctl' && c.args[0] === 'print-disabled'));
});

test('remote preflights both local plists before changing any service', macOnly, (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.env.LAUNCH_AGENTS_DIR, 'com.cliproxyapi.server.plist'));
  const result = f.run(...remote, '--yes');
  assert.notEqual(result.status, 0);
  assert.equal(f.calls().some(c => c.name === 'launchctl' && ['disable','bootout','bootstrap'].includes(c.args[0])), false);
});

test('foreign port holder refuses before mutations with the Managed proxy instructions', macOnly, (t) => {
  const f = fixture(t, { PORT_HOLDER: '999' });
  const result = f.run(...remote, '--yes');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /port 8317 is held by ModelDeck; if ModelDeck manages the proxy, open Settings → Managed proxy → Stop Managing, then re-run/);
  assert.equal(f.calls().some(c => c.name === 'launch-agent.sh' || c.args.includes('PUT') || ['disable','enable','bootout','bootstrap'].includes(c.args[0])), false);
});

test('the local launchd proxy holder passes port ownership preflight', macOnly, (t) => {
  const f = fixture(t, { PORT_HOLDER: '111' });
  const result = f.run(...remote, '--yes');
  assert.equal(result.status, 0, result.stderr);
});

test('host is idempotent for already loaded local jobs', macOnly, (t) => {
  const f = fixture(t, { HOST_JOBS_LOADED: '1' });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().some(c => c.name === 'launchctl' && c.args[0] === 'bootstrap'), false);
  for (const label of ['com.cliproxyapi.server','com.cliproxyapi.rebalance-weights']) {
    assert.ok(f.calls().some(c => c.name === 'launchctl' && c.args[0] === 'print' && c.args[1].endsWith('/' + label)));
  }
});

test('host with daemon down restores local jobs and prints an executable daemon retry', macOnly, (t) => {
  const f = fixture(t, { DAEMON_DOWN: '1', UNLOADED: '1' });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /daemon not answering/);
  assert.ok(f.calls().some(c => c.name === 'launch-agent.sh' && c.args[0] === 'uninstall'));
  assert.equal(f.calls().filter(c => c.name === 'launchctl' && c.args[0] === 'bootstrap').length, 2);
  const retry = result.stdout.split('\n').find(line => line.startsWith("bash -c '"));
  assert.ok(retry, result.stdout);
  const retried = spawnSync('/bin/bash', ['-c', retry], { env: { ...f.env, DAEMON_DOWN: '0' }, cwd: f.dir, encoding: 'utf8' });
  assert.equal(retried.status, 0, retried.stderr);
  const put = f.calls().find(c => c.args.includes('PUT'));
  assert.deepEqual(JSON.parse(put.args[put.args.indexOf('--data') + 1]), { proxyRole: 'host', poolHubUrl: '' });
});

test('undo uses bash -c and retains its plist in a private durable backup directory', macOnly, (t) => {
  const f = fixture(t, { FAIL: 'launch-agent.sh:install' });
  const result = f.run(...remote, '--yes');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /export -n/);
  assert.match(result.stderr, /bash -c '/);
  const dir = path.join(f.dir, 'Library/Application Support/ModelDeck/pool-target-backups');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const backups = fs.readdirSync(dir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '<plist/>');
});

test('pool-target NODE unset installs an absolute PATH-resolved node in the real installer plist', macOnly, (t) => {
  const f = fixture(t);
  const node = path.join(f.dir, 'bin/node'); fs.symlinkSync(process.execPath, node);
  delete f.env.NODE;
  f.env.UNLOADED = '1';
  f.env.FORWARDER_DIR = path.resolve('tools/pool-forwarder');
  const result = f.run(...remote, '--yes');
  assert.equal(result.status, 0, result.stderr);
  const plist = fs.readFileSync(path.join(f.env.LAUNCH_AGENTS_DIR, 'ai.modeldeck.pool-forwarder.plist'), 'utf8');
  assert.ok(plist.includes(`<key>ProgramArguments</key><array><string>${node}</string>`), plist);
  f.env.NODE = 'node';
  assert.notEqual(f.run(...remote, '--yes').status, 0);
});

test('pool-target with no node on PATH says so before any change', macOnly, (t) => {
  const f = fixture(t);
  delete f.env.NODE;
  // Only the tools the script runs before its node check; Linux has node in /usr/bin (#807).
  const tools = path.join(f.dir, 'tools'); fs.mkdirSync(tools);
  fs.symlinkSync(['/usr/bin/dirname', '/bin/dirname'].find((p) => fs.existsSync(p)), path.join(tools, 'dirname'));
  f.env.PATH = `${path.join(f.dir, 'bin')}:${tools}`;
  const result = f.run(...remote, '--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node must be an absolute executable path/);
  assert.equal(f.calls().some(c => c.name === 'launchctl'), false);
});

test('pool-target run as a bare file name from scripts/ still finds the forwarder', macOnly, (t) => {
  const f = fixture(t);
  delete f.env.FORWARDER_DIR;
  f.env.UNLOADED = '1';
  const result = spawnSync('/bin/bash', ['pool-target.sh', ...remote, '--yes'], { env: f.env, encoding: 'utf8', cwd: path.resolve('scripts') });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(f.env.LAUNCH_AGENTS_DIR, 'ai.modeldeck.pool-forwarder.plist')));
});

test('host restores only routed per-profile Claude keys using local PATCH stdin and SHA-256 deduplication', macOnly, (t) => {
  const account = (id, extra = {}) => ({ id, provider: 'claude', proxyRouted: true, cliproxyRouted: true, helperRouted: true,
    metadata: { clientKeyHelper: { mode: 'per-profile', service: `cli-proxy-api-client.${id}` } }, ...extra });
  const f = fixture(t, { STATE: JSON.stringify({ accounts: [account('new'), account('already'), account('same-key'), account('duplicate', { metadata: account('new').metadata }), account('direct', { proxyRouted: false, cliproxyRouted: false }), account('grok', { provider: 'grok' }), account('no-helper', { helperRouted: false }), account('legacy', { metadata: { clientKeyHelper: { mode: 'legacy', service: 'cli-proxy-api-client' } } })] }) });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  const inputs = fs.existsSync(f.managementInput) ? fs.readFileSync(f.managementInput,'utf8').trim().split('\n').map(JSON.parse) : [];
  assert.equal(inputs.length, 2, 'one GET, one append PATCH');
  const patch = inputs.find(c => c.args.includes('PATCH'));
  assert.ok(patch);
  assert.equal(patch.args.at(-1), 'http://127.0.0.1:8317/v0/management/api-keys');
  const bodyLine = patch.config.split('\n').find(line => line.startsWith('data = '));
  const body = JSON.parse(JSON.parse(bodyLine.slice('data = '.length)));
  assert.equal(body.new, 'placeholder-profile-key-new');
  assert.ok(body.old && body.old !== body.new);
  assert.match(patch.config, /Authorization: Bearer placeholder-management-key/);
  const calls = f.calls();
  assert.ok(calls.findIndex(c=>c.args.includes('PATCH')) > calls.findIndex(c=>c.args.at(-1)?.endsWith('/healthz')));
  const services = calls.filter(c=>c.name==='security').map(c=>c.args[c.args.indexOf('-s')+1]);
  assert.deepEqual(services, ['modeldeck','cli-proxy-api-client.new','cli-proxy-api-client.already','cli-proxy-api-client.same-key']);
  assert.doesNotMatch(JSON.stringify(calls)+result.stdout+result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  assert.equal(calls.some(c => c.secretInEnv), false);
});

const CODEX_KEY = 'placeholder-profile-key-codex-00000000';
const DAEMON_CODEX_KEY = 'placeholder-profile-key-daemon-00000000';

function codexAccount(f, id, { token = CODEX_KEY, provider = 'cliproxyapi', base = 'http://127.0.0.1:8317/v1', root } = {}) {
  const profileRef = path.join(root ?? path.join(f.dir, '.codex-profiles'), id);
  fs.mkdirSync(profileRef, { recursive: true });
  fs.writeFileSync(path.join(profileRef, 'config.toml'), `model_provider = "${provider}"\n[model_providers.cliproxyapi]\nbase_url = "${base}"\nexperimental_bearer_token = "${token}"\n`);
  return { id, label: id, provider: 'codex', profileRef };
}

test('#791 restore Codex NO-PRINT TRIPWIRE: routed bearers append via curl stdin, deduplicated, never argv env stdout stderr', macOnly, (t) => {
  const f = fixture(t);
  const root = path.join(f.dir, 'daemon-data', 'codex-profiles');
  const accounts = [
    codexAccount(f, 'code-one'), codexAccount(f, 'duplicate'),
    codexAccount(f, 'already', { token: 'placeholder-profile-key-already-00000000' }),
    codexAccount(f, 'daemon-profile', { root, token: DAEMON_CODEX_KEY }),
    codexAccount(f, 'direct', { provider: 'openai' }),
    codexAccount(f, 'foreign', { base: 'https://foreign.invalid/v1' }),
  ];
  f.env.STATE = JSON.stringify({ accounts, codexProfilesDir: root });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  const inputs = fs.existsSync(f.managementInput) ? fs.readFileSync(f.managementInput, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const patches = inputs.filter((call) => call.args.includes('PATCH'));
  assert.equal(patches.length, 2, 'only two distinct, routed, absent Codex keys');
  const keys = patches.map((call) => JSON.parse(JSON.parse(call.config.split('\n').find((line) => line.startsWith('data = ')).slice(7))).new);
  assert.deepEqual(keys, [CODEX_KEY, DAEMON_CODEX_KEY]);
  assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  assert.equal(f.calls().some((call) => call.secretInEnv), false);
  assert.equal(f.calls().filter((call) => call.name === 'security').length, 1, 'only the host role mutation token, no Codex Keychain access');
});

test('#791 restore never enables key checking for an empty local list, even with a routed Codex bearer', macOnly, (t) => {
  const f = fixture(t, { EMPTY_KEYS: '1' });
  f.env.STATE = JSON.stringify({ accounts: [codexAccount(f, 'code-one')] });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /key checking is off/);
  assert.equal(f.calls().some((call) => call.args.includes('PATCH')), false);
  assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-profile-key/);
});

test('#791 restore skips a symlinked Codex config without exposing its bearer', macOnly, (t) => {
  const f = fixture(t);
  const account = codexAccount(f, 'code-one');
  const config = path.join(account.profileRef, 'config.toml');
  const target = path.join(f.dir, 'target.toml');
  fs.renameSync(config, target);
  fs.symlinkSync(target, config);
  f.env.STATE = JSON.stringify({ accounts: [account] });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Skipped Codex account code-one: unsafe Codex config path/);
  assert.equal(f.calls().some((call) => call.args.includes('PATCH')), false);
  assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-profile-key/);
});

function restoredKeys(f) {
  const inputs = fs.existsSync(f.managementInput) ? fs.readFileSync(f.managementInput, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return inputs.filter((call) => call.args.includes('PATCH')).map((call) =>
    JSON.parse(JSON.parse(call.config.split('\n').find((line) => line.startsWith('data = ')).slice(7))).new);
}

const restoredClaude = { id: 'new', provider: 'claude', cliproxyRouted: true, helperRouted: true,
  metadata: { clientKeyHelper: { mode: 'per-profile', service: 'cli-proxy-api-client.new' } } };

const T3_KEY = 'placeholder-profile-key-t3-00000000000';
function t3Instance(f, id, { key = T3_KEY, enabled = true } = {}) {
  const userdata = path.join(f.dir, '.t3', 'userdata');
  const secrets = path.join(userdata, 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const settingsFile = path.join(userdata, 'settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : { providerInstances: {} };
  settings.providerInstances[id] = { driver: 'claudeAgent', enabled, displayName: id, environment: [
    { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8317' },
    { name: 'ANTHROPIC_AUTH_TOKEN', value: '', sensitive: true, valueRedacted: true },
  ] };
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const file = path.join(secrets, `provider-env-${Buffer.from(id).toString('base64url')}-${Buffer.from('ANTHROPIC_AUTH_TOKEN').toString('base64url')}.bin`);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return file;
}

test('#795 restore T3 NO-PRINT TRIPWIRE: current routed values append after Claude and Codex through curl stdin only, with SHA-256 dedup', macOnly, (t) => {
  const f = fixture(t);
  f.env.STATE = JSON.stringify({ accounts: [codexAccount(f, 'code-one'), restoredClaude] });
  const file = t3Instance(f, 'claude-pool');
  fs.writeFileSync(file, `${T3_KEY}-current`);
  t3Instance(f, 'duplicate', { key: `${T3_KEY}-current` });
  t3Instance(f, 'already', { key: 'placeholder-profile-key-already-00000000' });
  t3Instance(f, 'codex-duplicate', { key: CODEX_KEY });
  t3Instance(f, 'disabled', { enabled: false, key: `${T3_KEY}-disabled` });
  const result = f.restore();
  assert.equal(result.status, 0);
  assert.deepEqual(restoredKeys(f), ['placeholder-profile-key-new', CODEX_KEY, `${T3_KEY}-current`]);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  assert.equal(f.calls().some((call) => call.secretInEnv), false);
});

test('#795 T3 restore preserves the empty-list guard and silently ignores absent settings', macOnly, (t) => {
  for (const present of [false, true]) {
    const f = fixture(t, { EMPTY_KEYS: '1' });
    if (present) t3Instance(f, 'claude-pool');
    const result = f.restore();
    assert.equal(result.status, 0);
    assert.deepEqual(restoredKeys(f), []);
    assert.equal(f.calls().some((call) => call.args.includes('--config')), present);
    if (present) assert.match(result.stderr, /key checking is off/);
    else assert.equal(result.stderr, '');
    assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  }
});

test('#795 T3 restore skips invalid current keys by instance id and continues', macOnly, (t) => {
  for (const key of ['x'.repeat(31), `${T3_KEY}!`, 'x'.repeat(129)]) {
    const f = fixture(t);
    t3Instance(f, 'bad', { key }); t3Instance(f, 'good');
    const result = f.restore();
    assert.equal(result.status, 0);
    assert.equal(result.stderr, 'Skipped T3 instance bad: invalid T3 settings or key\n');
    assert.deepEqual(restoredKeys(f), [T3_KEY]);
    assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  }
});

test('#795 review: restore reports unkeyable T3 instances by id and fixed reason with NO-PRINT', macOnly, (t) => {
  const f = fixture(t);
  f.env.STATE = JSON.stringify({ accounts: [codexAccount(f, 'code-one'), restoredClaude] });
  t3Instance(f, 'direct');
  fs.unlinkSync(t3Instance(f, 'missing'));
  const linked = t3Instance(f, 'linked');
  const target = t3Instance(f, 'disabled', { enabled: false });
  fs.unlinkSync(linked); fs.symlinkSync(target, linked);
  t3Instance(f, 'binary', { key: Buffer.from([0, 255, 1]) });
  for (const id of ['bad.id', 'bad/id']) t3Instance(f, id);
  const settingsFile = path.join(f.dir, '.t3', 'userdata', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.providerInstances.direct.environment[0].value = 'https://direct.invalid';
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const result = f.restore();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, [
    'Skipped T3 instance direct: T3 instance not routed to the local forwarder',
    'Skipped T3 instance missing: T3 instance has no stored key',
    'Skipped T3 instance linked: unsafe T3 secret path or owner',
    'Skipped T3 instance binary: invalid T3 settings or key',
    'Skipped T3 instance invalid-id: invalid T3 settings or key',
    'Skipped T3 instance invalid-id: invalid T3 settings or key', '',
  ].join('\n'));
  assert.deepEqual(restoredKeys(f), ['placeholder-profile-key-new', CODEX_KEY]);
  assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  assert.equal(f.calls().some((call) => call.secretInEnv), false);
});

for (const failure of ['missing', 1, 20, 21, 22, 23, 127]) {
  test(`#795 review: restore skips injected T3 read failure ${failure} by id while Claude and Codex restore with NO-PRINT`, macOnly, (t) => {
    const f = fixture(t);
    f.env.STATE = JSON.stringify({ accounts: [codexAccount(f, 'code-one'), restoredClaude] });
    t3Instance(f, 'claude-pool');
    const result = f.restore(failure, 't3');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    const reason = ({ 20: 'T3 instance not routed to the local forwarder', 21: 'invalid T3 settings or key',
      22: 'unsafe T3 secret path or owner', 23: 'T3 settings or secret read or write failed' })[failure] ?? 'T3 instance command failed';
    assert.equal(result.stderr, `Skipped T3 instance claude-pool: ${reason}\n`);
    assert.deepEqual(restoredKeys(f), ['placeholder-profile-key-new', CODEX_KEY]);
    assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
    assert.equal(f.calls().some((call) => call.secretInEnv), false);
  });
}

for (const [problem, reason] of [
  ['unmanaged', 'invalid Codex profile path'], ['missing-ref', 'invalid Codex profile path'],
  ['missing-folder', 'Codex profile not routed to the local forwarder'],
  ['missing-config', 'Codex profile not routed to the local forwarder'],
  ['symlink', 'unsafe Codex config path'], ['unreadable', 'unsafe Codex config path'],
  ['bad-bearer', 'invalid Codex config or bearer'], ['no-bearer', 'Codex profile has no bearer'],
]) {
  test(`#791 review: restore skips ${problem} by id and restores Claude first, then remaining Codex with NO-PRINT`, macOnly, (t) => {
    const f = fixture(t);
    const bad = codexAccount(f, 'bad', { token: problem === 'bad-bearer' ? 'placeholder-profile-key-invalid!token' : CODEX_KEY });
    const config = path.join(bad.profileRef, 'config.toml');
    if (problem === 'unmanaged') bad.profileRef = path.join(f.dir, '.codex');
    if (problem === 'missing-ref') delete bad.profileRef;
    if (problem === 'missing-folder') fs.rmSync(bad.profileRef, { recursive: true });
    if (problem === 'missing-config') fs.unlinkSync(config);
    if (problem === 'no-bearer') fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/^experimental_bearer_token.*\n/m, ''));
    if (problem === 'symlink') { fs.renameSync(config, `${config}.target`); fs.symlinkSync(`${config}.target`, config); }
    if (problem === 'unreadable') { fs.chmodSync(config, 0); t.after(() => { if (fs.existsSync(config)) fs.chmodSync(config, 0o600); }); }
    f.env.STATE = JSON.stringify({ accounts: [bad, codexAccount(f, 'good'), restoredClaude] });
    const result = f.restore();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Skipped Codex account bad: ${reason}\n`);
    assert.deepEqual(restoredKeys(f), ['placeholder-profile-key-new', CODEX_KEY]);
    const calls = f.calls();
    assert.ok(calls.findIndex((call) => call.args.includes('PATCH')) < calls.findIndex((call) => call.name === 'python'), 'Claude admission must precede Codex reads');
    assert.doesNotMatch(JSON.stringify(calls) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
    assert.equal(calls.some((call) => call.secretInEnv), false);
  });
}

for (const failure of ['missing', 1, 22, 23, 127]) {
  test(`#791 review: restore skips Python failure ${failure} after admitting Claude with NO-PRINT`, macOnly, (t) => {
    const f = fixture(t);
    f.env.STATE = JSON.stringify({ accounts: [codexAccount(f, 'code-one'), restoredClaude] });
    const result = f.restore(failure);
    assert.equal(result.status, 0, result.stderr);
    const reason = failure === 22 ? 'unsafe Codex config path' : failure === 23 ? 'Codex config read or write failed' : 'Codex config command failed';
    assert.equal(result.stderr, `Skipped Codex account code-one: ${reason}\n`);
    assert.deepEqual(restoredKeys(f), ['placeholder-profile-key-new']);
    assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  });
}

test('#791 review: restore admits 32-character base64url bearers and skips shorter ones without management calls', macOnly, (t) => {
  for (const length of [1, 31, 32]) {
    const f = fixture(t);
    const token = 'x'.repeat(length);
    f.env.STATE = JSON.stringify({ accounts: [codexAccount(f, 'code-one', { token })] });
    const result = f.restore();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, length < 32 ? 'Skipped Codex account code-one: Codex bearer too short\n' : '');
    assert.deepEqual(restoredKeys(f), length < 32 ? [] : [token]);
    if (length < 32) assert.equal(f.calls().some((call) => call.args.includes('--config')), false);
  }
});

test('#791 review: restore rejects advertised roots outside home or through symlinks and still admits legacy profiles', macOnly, (t) => {
  for (const symlink of [false, true]) {
    const f = fixture(t);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-codex-root-')));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const bad = codexAccount(f, 'outside', { root: outside, token: DAEMON_CODEX_KEY });
    let codexProfilesDir = outside;
    if (symlink) {
      codexProfilesDir = path.join(f.dir, 'linked-profiles');
      fs.symlinkSync(outside, codexProfilesDir);
      bad.profileRef = path.join(codexProfilesDir, 'outside');
    }
    f.env.STATE = JSON.stringify({ codexProfilesDir, accounts: [bad, codexAccount(f, 'legacy')] });
    const result = f.restore();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, `Skipped Codex account outside: ${symlink ? 'unsafe Codex config path' : 'invalid Codex profile path'}\n`);
    assert.deepEqual(restoredKeys(f), [CODEX_KEY]);
    assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  }
});

test('#791 review: restore still fails for local daemon and management call failures without printing credentials', macOnly, (t) => {
  for (const fail of ['state', 'GET', 'PATCH']) {
    const f = fixture(t, fail === 'state' ? { DAEMON_DOWN: '1' } : { FAIL_MANAGEMENT: fail });
    f.env.STATE = JSON.stringify({ accounts: [restoredClaude, codexAccount(f, 'good')] });
    const result = f.restore();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Local profile key restore failed/);
    assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-(mutation-token|profile-key|management-key)/);
  }
});

test('#791 restore skips a fresh Codex home with no config and still admits the routed profile', macOnly, (t) => {
  const f = fixture(t);
  const direct = codexAccount(f, 'fresh');
  fs.unlinkSync(path.join(direct.profileRef, 'config.toml'));
  f.env.STATE = JSON.stringify({ accounts: [direct, codexAccount(f, 'routed')] });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().filter((call) => call.args.includes('PATCH')).length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls()) + result.stdout + result.stderr, /placeholder-profile-key/);
});


test('local curl calls bypass ambient proxies and curlrc so credentials stay on this Mac', macOnly, (t) => {
  const f = fixture(t, { http_proxy: 'http://proxy.example.invalid:18888', ALL_PROXY: 'http://proxy.example.invalid:18888', NO_PROXY: '', no_proxy: '', STATE: JSON.stringify({ accounts: [{ provider: 'claude', cliproxyRouted: true, helperRouted: true, metadata: { clientKeyHelper: { mode: 'per-profile', service: 'cli-proxy-api-client.new' } } }] }) });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls().some(c => c.args.includes('PATCH')), 'exercise management credentials too');
  for (const call of f.calls().filter(c => c.name === 'curl')) {
    assert.equal(call.args[0], '--disable', 'ignore curlrc before any other option');
    assert.equal(call.args[call.args.indexOf('--noproxy') + 1], '*', 'never send local secrets to a proxy');
  }
});

test('inherited allexport never exports the cached mutation token to child commands', macOnly, (t) => {
  const f = fixture(t, { SHELLOPTS: 'allexport', pool_token_headers: 'inherited-export' });
  const result = f.run(...remote, '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().some(c => c.secretInEnv), false);
});

test('printed mutation undo disables inherited allexport before reading the token', macOnly, (t) => {
  const f = fixture(t, { FAIL: 'launchctl:bootstrap', UNLOADED: '1' });
  const result = f.run('host', '--yes');
  assert.notEqual(result.status, 0);
  const undo = result.stderr.slice(result.stderr.indexOf('\n') + 1);
  const restored = spawnSync('/bin/bash', ['-c', undo], { env: { ...f.env, FAIL: '', SHELLOPTS: 'allexport' }, encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(f.calls().some(c => c.secretInEnv), false);
});

test('host dry-run discloses per-profile Keychain reads and local key admission after health', macOnly, (t) => {
  const f = fixture(t);
  const result = f.run('host');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Action:.*Keychain.*local.*api-keys/);
  assert.deepEqual(f.calls(), []);
});

test('page URL keeps accepting a single-label tailnet name while inference requires HTTPS', macOnly, (t) => {
  const f = fixture(t);
  const result = f.run('remote', '--hub-url', 'https://studio.tail0000.ts.net', '--page-url', 'http://studio:3871', '--yes');
  assert.equal(result.status, 0, result.stderr);
  const put = f.calls().find(c => c.args.includes('PUT'));
  assert.equal(JSON.parse(put.args[put.args.indexOf('--data') + 1]).poolHubUrl, 'http://studio:3871');
});

test('host never turns key checking on: an empty local api-keys list gets no profile keys', macOnly, (t) => {
  const account = { id: 'new', provider: 'claude', proxyRouted: true, cliproxyRouted: true, helperRouted: true,
    metadata: { clientKeyHelper: { mode: 'per-profile', service: 'cli-proxy-api-client.new' } } };
  const f = fixture(t, { STATE: JSON.stringify({ accounts: [account] }), EMPTY_KEYS: '1' });
  const result = f.run('host', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no api-keys \(key checking is off\)/);
  const inputs = fs.readFileSync(f.managementInput, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(inputs.some((call) => call.args.includes('PATCH')), false);
});
