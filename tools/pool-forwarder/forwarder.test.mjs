import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoute } from './forwarder.mjs';

test('path allowlist normalizes before checking and refuses management traversal', () => {
  for (const [method, path] of [
    ['GET', '/healthz'], ['HEAD', '/healthz'], ['POST', '/v1'], ['PATCH', '/v1/models'],
    ['POST', '/v1/chat/completions?secret=query'], ['GET', '/v1/a/../models'],
  ]) assert.ok(normalizeRoute(method, path), `${method} ${path}`);
  for (const path of ['/', '/v0/management', '/api/settings', '/v10', '/v1/../v0/management',
    '/v1/%2e%2e/v0/management', '/v1/.%2E/v0', '/v1//../../v0/management',
    '//v1/../v0', '/v1/%2f..%2f..%2fv0', '/v1/%252e%252e/v0', '/v1/..\\v0',
    'http://studio/v1', '/v1/%00', '/v1/%zz']) {
    assert.equal(normalizeRoute('GET', path), null, path);
  }
  assert.equal(normalizeRoute('POST', '/healthz'), null);
});

import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createForwarder, readConfig, validatePoolHost, endToEndHeaders } from './forwarder.mjs';

const TARGET = 'https://studio.tail0000.ts.net';
test('POOL_HOST_URL and PORT validation; bind host is loopback only', () => {
  for (const url of [TARGET, 'https://100.64.0.0', 'https://100.127.255.255']) assert.ok(validatePoolHost(url));
  for (const url of [undefined, '', 'http://studio', 'https://studio', 'http://100.64.0.1', 'http://studio.ts.net', 'https://example.com', 'http://localhost',
    'http://localhost:8317', 'http://localhost.ts.net', 'http://broadcasthost', 'http://100.63.255.255',
    'http://100.128.0.0', 'http://127.0.0.1', 'https://u:p@studio', 'https://@studio',
    `${TARGET}?`, `${TARGET}#`, `${TARGET}/v1`, 'http://[::1]', 'http://2130706433']) {
    assert.throws(() => validatePoolHost(url), /POOL_HOST_URL/, String(url));
  }
  assert.equal(readConfig({ POOL_HOST_URL: TARGET }).host, '127.0.0.1');
  assert.equal(readConfig({ POOL_HOST_URL: TARGET }).port, 8317);
  for (const env of [{ HOST: '0.0.0.0' }, { HOSTS: '127.0.0.1' }, { PORT: '0' }, { PORT: '65536' }, { PORT: 'bad' }]) {
    assert.throws(() => readConfig({ POOL_HOST_URL: TARGET, ...env }));
  }
});

test('hop-by-hop and Connection-nominated headers are stripped both ways', () => {
  assert.deepEqual(endToEndHeaders({ connection: 'x-private, TE', 'x-private': 'secret', te: 'trailers',
    'keep-alive': 'yes', 'proxy-authorization': 'secret', 'proxy-extra': 'x', trailer: 'a',
    'transfer-encoding': 'chunked', upgrade: 'websocket', authorization: 'Bearer placeholder', host: 'studio' }),
  { authorization: 'Bearer placeholder', host: 'studio' });
});

test('silent streams have no request, response or agent timeout', () => {
  let options;
  const server = createForwarder({ target: TARGET, request: (o) => {
    options = o;
    return new PassThrough();
  } });
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.timeout, 0);
  assert.ok(server.headersTimeout >= 120_000);
  const req = new PassThrough(); Object.assign(req, { method: 'POST', url: '/v1/chat/completions', headers: { host: 'localhost:18317' }, socket: { localPort: 18317 } });
  const res = new PassThrough();
  server.emit('request', req, res);
  assert.equal(options.agent.keepAlive, true);
  assert.equal(options.agent.options.timeout, 0);
  assert.equal(options.timeout, undefined);
  assert.equal(options.host, undefined);
  options.agent.destroy();
  req.destroy(); res.destroy();
});

test('refused paths never contact the upstream; failures never log Authorization or query', () => {
  const logs = [];
  let calls = 0;
  const server = createForwarder({ target: TARGET, log: (line) => logs.push(line), request: () => {
    calls++; throw new Error('Bearer placeholder-key private-query');
  } });
  function send(url) {
    const req = new PassThrough(); Object.assign(req, { method: 'GET', url, headers: { host: 'localhost:18317', authorization: 'Bearer placeholder-key' }, socket: { localPort: 18317 } });
    const res = new PassThrough(); res.writeHead = (code) => { res.statusCode = code; };
    server.emit('request', req, res);
    return res.statusCode;
  }
  assert.equal(send('/v1/%2e%2e/v0/management'), 404);
  assert.equal(calls, 0);
  assert.equal(send('/v1/models?private-query'), 502);
  assert.deepEqual(logs, ['pool-forwarder request-error /v1']);
});

async function listen(t, server) {
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('sandbox denies loopback listen; orchestrator must run unsandboxed');
      return null;
    }
    throw error;
  }
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

async function setup(t, handler) {
  const upstream = http.createServer(handler);
  const port = await listen(t, upstream);
  if (port === null) return null;
  const logs = [];
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const forwarder = createForwarder({ target: TARGET, log: (s) => logs.push(s),
    request: (options, cb) => http.request({ ...options, protocol: 'http:', agent, hostname: '127.0.0.1', port }, cb) });
  const local = await listen(t, forwarder);
  return local === null ? null : { local, upstream, logs };
}

test('streams upload and response before either side finishes, with a silent gap', { timeout: 5000 }, async (t) => {
  let upstreamHeaders;
  const fixture = await setup(t, (req, res) => {
    upstreamHeaders = req.headers;
    res.writeHead(200, { connection: 'x-hop', 'x-hop': 'drop', 'x-end': 'keep' });
    req.on('data', (chunk) => res.write(chunk));
    req.on('end', () => res.end('done'));
  });
  if (!fixture) return;
  const client = http.request({ host: '127.0.0.1', port: fixture.local, path: '/v1/chat/completions', method: 'POST',
    headers: { authorization: 'Bearer placeholder-key', connection: 'x-hop', 'x-hop': 'drop' } });
  client.write('first');
  const [res] = await once(client, 'response');
  assert.equal(res.headers['x-hop'], undefined);
  assert.equal(res.headers['x-end'], 'keep');
  assert.equal((await once(res, 'data'))[0].toString(), 'first');
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.end('last');
  let rest = ''; for await (const chunk of res) rest += chunk;
  assert.equal(rest, 'lastdone');
  assert.equal(upstreamHeaders.authorization, 'Bearer placeholder-key');
  assert.equal(upstreamHeaders.host, 'studio.tail0000.ts.net');
  assert.equal(upstreamHeaders['x-hop'], undefined);
  assert.equal(upstreamHeaders['x-forwarded-for'], undefined);
  assert.deepEqual(fixture.logs, []);
});

test('client abort destroys the upstream response', { timeout: 5000 }, async (t) => {
  let closed;
  const ended = new Promise((resolve) => { closed = resolve; });
  const fixture = await setup(t, (_req, res) => {
    res.on('close', closed); res.write('first');
  });
  if (!fixture) return;
  const client = http.get({ host: '127.0.0.1', port: fixture.local, path: '/v1/stream' });
  const [res] = await once(client, 'response');
  await once(res, 'data');
  res.destroy();
  await ended;
});

test('upstream down returns 502 without logging credentials', { timeout: 5000 }, async (t) => {
  const fixture = await setup(t, (_req, res) => res.end());
  if (!fixture) return;
  await new Promise((resolve) => fixture.upstream.close(resolve));
  const [res] = await once(http.get({ host: '127.0.0.1', port: fixture.local, path: '/v1/models?private-query',
    headers: { authorization: 'Bearer placeholder-key' } }), 'response');
  assert.equal(res.statusCode, 502); res.resume();
  assert.deepEqual(fixture.logs, ['pool-forwarder request-error /v1']);
});

test('installer uses stubbed commands, XML escapes paths, refuses foreign listeners', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarder-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home & placeholder'); fs.mkdirSync(home);
  const record = path.join(dir, 'calls');
  const stub = path.join(dir, 'stub');
  fs.writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$*" >> "$RECORD"\nif [[ "$1" == print ]]; then exit 1; fi\nif [[ "$1" == -nP && -n "\${FOREIGN:-}" ]]; then echo 999; fi\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, POOL_HOST_URL: TARGET, PORT: '18317', NODE: process.execPath,
    LAUNCHCTL: stub, LSOF: stub, RECORD: record, LAUNCH_AGENTS_DIR: path.join(home, 'agents') };
  const run = (extra = {}, action = 'install') => spawnSync('/bin/bash', ['tools/pool-forwarder/launch-agent.sh', action], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(run({ FOREIGN: '1' }).status, 1);
  assert.equal(fs.existsSync(env.LAUNCH_AGENTS_DIR), false);
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const plist = fs.readFileSync(path.join(env.LAUNCH_AGENTS_DIR, 'ai.modeldeck.pool-forwarder.plist'), 'utf8');
  assert.match(plist, /home &amp; placeholder/);
  assert.match(plist, /<key>POOL_HOST_URL<\/key>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /18317/);
  fs.writeFileSync(record, '');
  assert.equal(run({ POOL_HOST_URL: 'https://user:secret@studio' }).status, 1);
  assert.equal(fs.readFileSync(record, 'utf8'), '');
  assert.equal(run({}, 'uninstall').status, 0);
  assert.equal(fs.existsSync(path.join(env.LAUNCH_AGENTS_DIR, 'ai.modeldeck.pool-forwarder.plist')), false);
});

test('client upload abort destroys the upstream request without a socket', () => {
  let upstream;
  const server = createForwarder({ target: TARGET, request: () => { upstream = new PassThrough(); return upstream; } });
  const req = new PassThrough(); Object.assign(req, { method: 'POST', url: '/v1/upload', headers: { host: 'localhost:18317' }, socket: { localPort: 18317 } });
  const res = new PassThrough();
  server.emit('request', req, res);
  req.write('partial');
  req.emit('aborted');
  assert.equal(upstream.destroyed, true);
  req.destroy(); res.destroy();
});

test('upstream response failure destroys an already-started client stream and logs only its class', () => {
  const logs = [];
  let respond;
  const upstream = new PassThrough();
  const server = createForwarder({ target: TARGET, log: (line) => logs.push(line), request: (_options, cb) => { respond = cb; return upstream; } });
  const req = new PassThrough(); Object.assign(req, { method: 'GET', url: '/v1/stream?private-query', headers: { host: 'localhost:18317' }, socket: { localPort: 18317 } });
  const res = new PassThrough(); res.headersSent = false;
  res.writeHead = () => { res.headersSent = true; };
  server.emit('request', req, res);
  const up = new PassThrough(); Object.assign(up, { statusCode: 200, headers: { host: 'localhost:18317' }, socket: { localPort: 18317 } });
  respond(up); up.write('partial'); up.emit('error', Error('placeholder-key private-query'));
  assert.equal(res.destroyed, true);
  assert.equal(upstream.destroyed, true);
  assert.deepEqual(logs, ['pool-forwarder response-error /v1']);
  req.destroy();
});

function fakeClient(server, headers = {}, method = 'GET') {
  const req = new PassThrough();
  Object.assign(req, { method, url: '/v1/models', headers: { host: 'localhost:18317', ...headers }, socket: { localPort: 18317 } });
  const res = new PassThrough();
  res.writeHead = (status) => { res.statusCode = status; };
  server.emit('request', req, res);
  return { req, res };
}

test('chunked GET HEAD DELETE OPTIONS keep explicit upstream framing', () => {
  for (const method of ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'POST']) {
    let options;
    const server = createForwarder({ target: TARGET, request: (value) => { options = value; return new PassThrough(); } });
    const { req, res } = fakeClient(server, { 'transfer-encoding': 'chunked', connection: 'transfer-encoding' }, method);
    assert.equal(options.headers['transfer-encoding'], 'chunked', method);
    req.destroy(); res.destroy(); options.agent.destroy();
  }
});

test('ambiguous Transfer-Encoding plus Content-Length is refused before forwarding', () => {
  let calls = 0;
  const server = createForwarder({ target: TARGET, request: () => { calls++; return new PassThrough(); } });
  const { req, res } = fakeClient(server, { 'transfer-encoding': 'chunked', 'content-length': '4' });
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
  req.destroy(); res.destroy();
});

test('Host must name a loopback address and the actual listening port', () => {
  let calls = 0;
  const server = createForwarder({ target: TARGET, log: () => {}, request: () => { calls++; throw Error(); } });
  for (const host of ['evil.example:18317', '127.0.0.1:8317', 'localhost', '[::1]:8317', undefined]) {
    const { req, res } = fakeClient(server, { host });
    assert.equal(res.statusCode, 400, String(host)); req.destroy(); res.destroy();
  }
  assert.equal(calls, 0);
  for (const host of ['localhost:18317', '127.0.0.1:18317', '[::1]:18317']) {
    const { req, res } = fakeClient(server, { host });
    assert.equal(res.statusCode, 502); req.destroy(); res.destroy();
  }
  assert.equal(calls, 3);
});

test('invalid upstream status and response headers return 502 without throwing', () => {
  for (const statusCode of [99, 101, 102, 600, 999, 200]) {
    let respond;
    const upstream = new PassThrough();
    const server = createForwarder({ target: TARGET, log: () => {}, request: (_o, cb) => { respond = cb; return upstream; } });
    const { req, res } = fakeClient(server);
    res.writeHead = (code) => { if (code === 200) throw Error('invalid response header'); res.statusCode = code; };
    const up = new PassThrough(); Object.assign(up, { statusCode, headers: {} });
    assert.doesNotThrow(() => respond(up), String(statusCode));
    assert.equal(res.statusCode, 502, String(statusCode));
    assert.equal(upstream.destroyed, true);
    assert.equal(up.destroyed, true);
    req.destroy(); res.destroy();
  }
});

test('upstream upgrade and unsupported informational responses return 502', () => {
  for (const statusCode of [101, 102, 103]) {
    const upstream = new PassThrough();
    const server = createForwarder({ target: TARGET, log: () => {}, request: () => upstream });
    const { req, res } = fakeClient(server);
    upstream.emit('information', { statusCode: 100 });
    assert.equal(res.statusCode, undefined);
    const socket = new PassThrough();
    if (statusCode === 101) upstream.emit('upgrade', {}, socket);
    else upstream.emit('information', { statusCode });
    assert.equal(res.statusCode, 502);
    if (statusCode === 101) assert.equal(socket.destroyed, true);
    req.destroy(); res.destroy(); socket.destroy();
  }
});

test('raw TCP chunked GET containing a management request reaches upstream as one request', { timeout: 5000 }, async (t) => {
  const requests = [];
  const fixture = await setup(t, (req, res) => {
    const record = { url: req.url, body: '' }; requests.push(record);
    req.on('data', (chunk) => { record.body += chunk; });
    req.on('end', () => { res.end('ok'); });
  });
  if (!fixture) return;
  const body = 'GET /v0/management/api-keys HTTP/1.1\r\nHost: hidden\r\n\r\n';
  const socket = net.connect(fixture.local, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`GET /v1/models HTTP/1.1\r\nHost: localhost:${fixture.local}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`);
  let output = ''; for await (const chunk of socket) output += chunk;
  assert.match(output, /HTTP\/1.1 200/);
  assert.deepEqual(requests, [{ url: '/v1/models', body }]);
});

test('installer requires an absolute executable Node path and resolves NODE unset from PATH', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarder-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const node = path.join(dir, 'node'); fs.symlinkSync(process.execPath, node);
  const stub = path.join(dir, 'stub');
  fs.writeFileSync(stub, '#!/bin/bash\nif [[ "$1" == print ]]; then exit 1; fi\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, POOL_HOST_URL: TARGET, PORT: '18317', LAUNCHCTL: stub, LSOF: stub, LAUNCH_AGENTS_DIR: path.join(dir, 'agents') };
  delete env.NODE;
  const run = (extra = {}) => spawnSync('/bin/bash', ['tools/pool-forwarder/launch-agent.sh', 'install'], { env: { ...env, ...extra }, encoding: 'utf8' });
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const plist = fs.readFileSync(path.join(env.LAUNCH_AGENTS_DIR, 'ai.modeldeck.pool-forwarder.plist'), 'utf8');
  assert.ok(plist.includes(`<key>ProgramArguments</key><array><string>${node}</string>`));
  for (const value of ['node', './node', dir, path.join(dir, 'absent')]) {
    assert.notEqual(run({ NODE: value }).status, 0, value);
  }
});

// Exercise Node's real HTTP parser and client framing without binding a socket.
// The raw TCP counterpart above remains required on an unsandboxed machine.
function memoryConnection(t, server) {
  let client;
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) { client.push(Buffer.from(chunk)); done(); },
    final(done) { client.push(null); done(); },
    destroy(error, done) { client.push(null); done(error); },
  });
  client = new Duplex({
    read() {},
    write(chunk, _encoding, done) { socket.push(Buffer.from(chunk)); done(); },
    final(done) { socket.push(null); done(); },
    destroy(error, done) { socket.push(null); done(error); },
  });
  for (const end of [client, socket]) {
    end.setTimeout = end.setNoDelay = end.setKeepAlive = end.ref = end.unref = () => end;
    end.localPort = 18317;
  }
  t.after(() => { client.destroy(); socket.destroy(); });
  server.emit('connection', socket);
  return client;
}

test('real HTTP parsers keep a smuggled management request inside a chunked GET body without sockets', { timeout: 3000 }, async (t) => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const record = { url: req.url, body: '' }; requests.push(record);
    req.on('data', chunk => { record.body += chunk; });
    req.on('end', () => res.end('ok'));
  });
  const agent = new http.Agent({ keepAlive: true });
  agent.createConnection = () => memoryConnection(t, upstream);
  t.after(() => agent.destroy());
  const server = createForwarder({ target: TARGET, request: (options, cb) => http.request({ ...options, protocol: 'http:', agent }, cb) });
  t.after(() => server.emit('close'));
  const client = memoryConnection(t, server);
  const body = 'GET /v0/management/api-keys HTTP/1.1\r\nHost: hidden\r\n\r\n';
  client.write(`GET /v1/models HTTP/1.1\r\nHost: localhost:18317\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`);
  let response = ''; for await (const chunk of client) response += chunk;
  assert.match(response, /HTTP\/1.1 200/);
  assert.deepEqual(requests, [{ url: '/v1/models', body }]);
});

test('real HTTP parser rejects ambiguous framing and foreign Host before upstream contact', { timeout: 3000 }, async (t) => {
  let calls = 0;
  const server = createForwarder({ target: TARGET, request: () => { calls++; throw Error(); } });
  t.after(() => server.emit('close'));
  for (const headers of ['Host: localhost:18317\r\nTransfer-Encoding: chunked\r\nContent-Length: 0', 'Host: attacker.example:18317']) {
    const client = memoryConnection(t, server);
    client.write(`GET /v1/models HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`);
    let response = ''; for await (const chunk of client) response += chunk;
    assert.match(response, /HTTP\/1.1 400/);
  }
  assert.equal(calls, 0);
});

test('real HTTP client rejects malformed statuses and upgrades without hanging', { timeout: 3000 }, async (t) => {
  for (const code of ['099', '101', '102', '103', '600']) {
    const agent = new http.Agent({ keepAlive: true });
    agent.createConnection = () => memoryConnection(t, { emit(_event, socket) {
      socket.once('data', () => socket.end(`HTTP/1.1 ${code} Test\r\n${code === '101' ? 'Connection: upgrade\r\nUpgrade: websocket\r\n' : ''}Content-Length: 0\r\n\r\n`));
    } });
    t.after(() => agent.destroy());
    const server = createForwarder({ target: TARGET, log: () => {}, request: (options, cb) => http.request({ ...options, protocol: 'http:', agent }, cb) });
    t.after(() => server.emit('close'));
    const client = memoryConnection(t, server);
    client.write('GET /v1/models HTTP/1.1\r\nHost: localhost:18317\r\nConnection: close\r\n\r\n');
    let response = ''; for await (const chunk of client) response += chunk;
    assert.match(response, /HTTP\/1.1 502/, code);
  }
});
