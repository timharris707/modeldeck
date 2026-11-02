import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { addAccount, findAccount, runInTerminal, signin } from '../src/signin-cli.mjs';

// #808: the headless sign-in drives only the daemon's API and the provider's
// own command. A fake daemon records calls; nothing is spawned.
const DAEMON = 'http://127.0.0.1:13867';
const accounts = [
  { id: 'a1', label: 'Work', provider: 'claude', profileRef: '/p/a1' },
  { id: 'a2', label: 'Home', provider: 'claude', profileRef: '/p/a2' },
  { id: 'c1', label: 'Work', provider: 'codex', profileRef: '/p/c1' },
];

function fakeDaemon({ login = {}, verify = { authenticated: true, identity: 'user@example.com' }, active = '/p/a2', failRestore = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    calls.push({ method: init.method, path: pathname + search, headers: init.headers, redirect: init.redirect });
    if (failRestore && pathname === `/api/accounts/${failRestore}/activate`) return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
    let body;
    if (pathname === '/api/state') body = { accounts, activation: { claude: { resolvedProfileRef: active } } };
    else if (pathname.endsWith('/login')) body = { command: "CLAUDE_CONFIG_DIR='/p/a1' claude auth login", ...login };
    else if (pathname.endsWith('/verify')) body = verify;
    else if (pathname.endsWith('/activate')) body = {};
    return { ok: true, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('labels resolve only when unambiguous; ids always do', () => {
  assert.equal(findAccount(accounts, 'home').id, 'a2');
  assert.equal(findAccount(accounts, 'c1').id, 'c1');
  assert.throws(() => findAccount(accounts, 'Work'), /more than one account/);
  assert.throws(() => findAccount(accounts, 'nobody'), /no account "nobody"/);
});

test('runs the daemon-served command, verifies, and sends the token only on mutations', async () => {
  const { calls, fetchImpl } = fakeDaemon();
  const ran = [];
  const lines = [];
  const code = await signin('a1', {
    daemonUrl: DAEMON, token: 'placeholder-token', fetchImpl, run: async (cmd) => { ran.push(cmd); return 0; }, out: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.deepEqual(ran, ["CLAUDE_CONFIG_DIR='/p/a1' claude auth login"]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /api/state', 'GET /api/accounts/a1/login?headless=1', 'POST /api/accounts/a1/verify',
  ]);
  for (const call of calls) {
    if (call.method === 'GET') assert.equal(call.headers['x-modeldeck-token'], undefined);
    else {
      assert.equal(call.headers['x-modeldeck-token'], 'placeholder-token');
      assert.equal(call.headers.Origin, DAEMON);
    }
  }
  assert.ok(lines.every((l) => !l.includes('placeholder-token')));
  assert.match(lines.at(-1), /Signed in as user@example\.com/);
});

test('an activation login switches to the account and back, even when the command fails', async () => {
  const { calls, fetchImpl } = fakeDaemon({ login: { requiresActivation: true } });
  const code = await signin('a1', {
    daemonUrl: DAEMON, token: 't', fetchImpl, run: async () => { throw new Error('spawn failed'); }, out: () => {},
  }).catch((error) => error);
  assert.match(code.message, /spawn failed/);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), [
    '/api/accounts/a1/activate', '/api/accounts/a2/activate',
  ]);
});

test('a sign-in as the wrong person is reported, not accepted', async () => {
  const { fetchImpl } = fakeDaemon({
    verify: { authenticated: true, identity: 'other@example.com', identityMismatch: { expected: 'user@example.com', actual: 'other@example.com' } },
  });
  const lines = [];
  const code = await signin('a1', { daemonUrl: DAEMON, token: 't', fetchImpl, run: async () => 0, out: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.at(-1), /but this account is user@example\.com/);
});

// Codex review of #813.
test('no daemon call follows a redirect', async () => {
  const { calls, fetchImpl } = fakeDaemon();
  await signin('a1', { daemonUrl: DAEMON, token: 't', fetchImpl, run: async () => 0, out: () => {} });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.redirect === 'error'));
});

test('a failed switch back to the previous account makes the sign-in fail', async () => {
  const { fetchImpl } = fakeDaemon({ login: { requiresActivation: true }, failRestore: 'a2' });
  const lines = [];
  const code = await signin('a1', { daemonUrl: DAEMON, token: 't', fetchImpl, run: async () => 0, out: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => /Could not switch back to Home/.test(l)));
});

test('the provider command never inherits the mutation token, and Ctrl-C is left to it', async () => {
  let seen;
  const signals = new EventEmitter();
  const spawnImpl = (cmd, args, options) => {
    seen = { cmd, args, env: options.env, listening: signals.listenerCount('SIGINT') };
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  const code = await runInTerminal('true', { env: { PATH: '/bin', MODELDECK_MUTATION_TOKEN: 'placeholder-token' }, spawnImpl, signals });
  assert.equal(code, 0);
  assert.deepEqual(seen.args, ['-c', 'true']);
  assert.equal(seen.env.MODELDECK_MUTATION_TOKEN, undefined);
  assert.equal(seen.env.PATH, '/bin');
  assert.equal(seen.listening, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

// CodeRabbit on #813: activation that fails after the daemon switched still
// switches back, and a failed sign-in command is never reported as success.
test('a failed activation still switches back to the previous account', async () => {
  const { calls, fetchImpl } = fakeDaemon({ login: { requiresActivation: true }, failRestore: 'a1' });
  const ran = [];
  const result = await signin('a1', {
    daemonUrl: DAEMON, token: 't', fetchImpl, run: async (cmd) => { ran.push(cmd); return 0; }, out: () => {},
  }).catch((error) => error);
  assert.match(result.message, /activate: busy/);
  assert.deepEqual(ran, []);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), [
    '/api/accounts/a1/activate', '/api/accounts/a2/activate',
  ]);
});

test('a failed sign-in command fails even when an older sign-in still verifies', async () => {
  const { fetchImpl } = fakeDaemon();
  const lines = [];
  const code = await signin('a1', { daemonUrl: DAEMON, token: 't', fetchImpl, run: async () => 1, out: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.at(-1), /earlier sign-in/);
});

// #811: adding an account goes through the daemon; taking over ~/.claude
// only happens with --manage.
test('add asks for --manage before the daemon takes over a home, and sends it only when given', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ body, redirect: init.redirect, token: init.headers['x-modeldeck-token'] });
    if (!body.manageProvider) return { ok: false, status: 409, json: async () => ({ error: 'needs manage', code: 'manage-required' }) };
    return { ok: true, status: 201, json: async () => ({ account: { id: 'n1', label: body.label } }) };
  };
  const lines = [];
  const out = (l) => lines.push(l);
  assert.equal(await addAccount('claude', 'Work', { daemonUrl: DAEMON, token: 't', fetchImpl, out }), 1);
  assert.match(lines.at(-1), /Run again with --manage/);
  assert.equal(await addAccount('claude', 'Work', { daemonUrl: DAEMON, token: 't', manage: true, fetchImpl, out }), 0);
  assert.match(lines.at(-1), /modeldeck signin n1/);
  assert.deepEqual(bodies.map((b) => b.body.manageProvider ?? false), [false, true]);
  assert.ok(bodies.every((b) => b.redirect === 'error' && b.token === 't'));
  await assert.rejects(addAccount('grok', 'x', { daemonUrl: DAEMON, token: 't', fetchImpl, out }), /claude or codex/);
});
