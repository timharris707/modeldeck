#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validatePoolHost(value) {
  const invalid = () => { throw new Error('POOL_HOST_URL must be an HTTPS origin on *.ts.net or 100.64.0.0/10, without credentials, query or fragment'); };
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\?#@]/.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  const host = url.hostname;
  const octets = host.split('.').map(Number);
  const tailIP = /^\d+\.\d+\.\d+\.\d+$/.test(host) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
  const tailDNS = new RegExp(`^(?:${label}\\.)+ts\\.net$`).test(host) && url.protocol === 'https:';
  if ((!tailIP && !tailDNS) || host === 'localhost' || host === 'broadcasthost'
    || host.startsWith('localhost.') || host.endsWith('-localhost') || url.username || url.password
    || url.pathname !== '/') invalid();
  return url;
}

export function readConfig(env = process.env) {
  if ((env.HOST !== undefined && env.HOST !== '127.0.0.1') || env.HOSTS !== undefined) {
    throw new Error('pool forwarder binds only to 127.0.0.1; HOSTS is unsupported');
  }
  const port = env.PORT ?? '8317';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PORT must be 1..65535');
  return { target: validatePoolHost(env.POOL_HOST_URL), port: Number(port), host: '127.0.0.1' };
}

// Check and forward the same canonical path, so an upstream cannot interpret
// encoded separators or dot segments differently from this allowlist.
export function normalizeRoute(method, raw) {
  if (!raw?.startsWith('/') || raw.startsWith('//') || /[\\#\s]/.test(raw)) return null;
  const queryAt = raw.indexOf('?');
  const pathname = queryAt < 0 ? raw : raw.slice(0, queryAt);
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (/%(?:2f|5c|25)/i.test(pathname) || /[%\\\x00-\x1f\x7f]/.test(decoded)) return null;
  const normalized = posix.normalize(decoded);
  const prefix = normalized === '/healthz' && (method === 'GET' || method === 'HEAD') ? '/healthz'
    : normalized === '/v1' || normalized.startsWith('/v1/') ? '/v1' : null;
  if (!prefix) return null;
  return { prefix, path: normalized.split('/').map(encodeURIComponent).join('/') + (queryAt < 0 ? '' : raw.slice(queryAt)) };
}

export function endToEndHeaders(headers) {
  const nominated = new Set(String(headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    return !nominated.has(lower) && !/^(connection|keep-alive|te|trailer|transfer-encoding|upgrade)$/.test(lower)
      && !lower.startsWith('proxy-');
  }));
}

export function createForwarder({ target, request, log = console.log }) {
  target = validatePoolHost(String(target));
  const transport = target.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, timeout: 0 });
  request ??= transport.request;
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 120_000 }, (req, res) => {
    const port = req.socket.localPort;
    const host = req.headers.host?.toLowerCase();
    if (!port || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)
      || (req.headers['transfer-encoding'] !== undefined && req.headers['content-length'] !== undefined)) {
      res.writeHead(400, { connection: 'close' }); res.end('invalid request\n'); return;
    }
    const route = normalizeRoute(req.method, req.url);
    if (!route) { res.writeHead(404); res.end('not forwarded\n'); return; }
    let failed = false;
    let upstream;
    let response;
    const fail = (kind) => {
      if (failed || req.aborted || res.destroyed) return;
      failed = true;
      log(`pool-forwarder ${kind} ${route.prefix}`);
      if (res.headersSent) res.destroy();
      else { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('pool host unreachable\n'); }
      upstream?.destroy();
      response?.destroy();
    };
    try {
      const headers = { ...endToEndHeaders(req.headers), host: target.host };
      // Node decoded the incoming body. Give its client explicit framing even
      // for methods (GET/HEAD/DELETE/OPTIONS) that otherwise send raw bytes.
      if (req.headers['transfer-encoding'] !== undefined) headers['transfer-encoding'] = 'chunked';
      else if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];
      upstream = request({
        protocol: target.protocol, hostname: target.hostname, port: target.port,
        method: req.method, path: route.path, headers, agent,
      }, (up) => {
        response = up;
        up.on('error', () => fail('response-error'));
        up.on('aborted', () => fail('response-error'));
        if (failed || res.destroyed) { up.destroy(); return; }
        if (!Number.isInteger(up.statusCode) || up.statusCode < 200 || up.statusCode > 599) { fail('response-error'); return; }
        try { res.writeHead(up.statusCode, endToEndHeaders(up.headers)); }
        catch { fail('response-error'); return; }
        up.pipe(res);
      });
      upstream.on('error', () => fail('request-error'));
      upstream.on('upgrade', (_up, socket) => { socket.destroy(); fail('response-error'); });
      upstream.on('information', (up) => { if (up.statusCode !== 100) fail('response-error'); });
      req.on('aborted', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      res.on('close', () => { if (!res.writableFinished) { upstream.destroy(); response?.destroy(); } });
      req.pipe(upstream);
    } catch { fail('request-error'); }
  });
  server.timeout = 0;
  server.on('close', () => agent.destroy());
  return server;
}

export function startForwarder(env = process.env, options = {}) {
  const config = readConfig(env);
  const server = createForwarder({ ...options, target: config.target });
  server.listen(config.port, config.host, () => (options.log ?? console.log)(`pool-forwarder listening on 127.0.0.1:${config.port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { startForwarder().on('error', () => { console.error('pool-forwarder listen-error'); process.exitCode = 1; }); }
  catch { console.error('pool-forwarder invalid configuration'); process.exitCode = 1; }
}
