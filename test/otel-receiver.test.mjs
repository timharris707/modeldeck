import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

const metricsFixture = fs.readFileSync(new URL('./fixtures/otel/metrics.json', import.meta.url), 'utf8');
const logsFixture = fs.readFileSync(new URL('./fixtures/otel/logs.json', import.meta.url), 'utf8');
const unknownLogsFixture = fs.readFileSync(new URL('./fixtures/otel/unknown-logs.json', import.meta.url), 'utf8');

function appFixture(t, enabled = true) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  if (enabled) store.saveSettings({ otelReceiverEnabled: true });
  const service = {
    projectsRoot: '/placeholder/projects',
    startAutoRefresh() {},
    stopAutoRefresh() {},
  };
  return { store, app: createApp({ store, service, host: '127.0.0.1', port: 3867 }) };
}

function post(app, route, payload, contentType = 'application/json', remoteAddress = '127.0.0.1') {
  return request(app, route, payload, { contentType, remoteAddress });
}

async function request(app, route, payload = '', {
  method = 'POST', contentType = 'application/json', remoteAddress = '127.0.0.1',
} = {}) {
  const request = Readable.from([Buffer.from(payload)]);
  request.method = method;
  request.url = route;
  request.headers = { host: '127.0.0.1:3867', 'content-type': contentType };
  request.socket = { remoteAddress };
  let status;
  let headers;
  let responseBody = '';
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const response = {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
    end(chunk = '') { responseBody += chunk; finish(); },
  };
  await Promise.all([app.server.listeners('request')[0](request, response), finished]);
  return { status, headers, body: JSON.parse(responseBody), text: responseBody };
}

test('health answers during large OTLP quarantine and event inserts with byte-identical responses', async (t) => {
  const { store, app } = appFixture(t);
  const logRecords = Array.from({ length: 4_000 }, (_, index) => ({
    timeUnixNano: String(1786278900000000000n + BigInt(index) * 1_000_000n),
    body: { stringValue: index % 2 ? 'api_request' : `unknown-placeholder-${index}` },
  }));
  const payload = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });
  assert.ok(Buffer.byteLength(payload) < 1_000_000);
  let finished = false;
  const probes = [];
  for (const method of ['ingestOtelQuarantine', 'ingestOtelEvents']) {
    const original = store[method].bind(store);
    let inserted = 0;
    store[method] = (records) => {
      if (inserted === 0) {
        const started = performance.now();
        probes.push(new Promise((resolve) => setImmediate(resolve)).then(async () => ({
          health: await request(app, '/api/health', '', { method: 'GET' }),
          elapsed: performance.now() - started,
          inserted,
          finished,
        })));
      }
      const result = original(records);
      inserted += result.inserted;
      return result;
    };
  }
  const result = await post(app, '/otlp/v1/logs', payload).then((response) => {
    finished = true;
    return response;
  });
  const checks = await Promise.all(probes);
  assert.equal(checks.length, 2);
  for (const check of checks) {
    assert.equal(check.health.status, 200);
    assert.equal(check.health.body.ok, true);
    assert.ok(check.elapsed < 750, `health waited ${check.elapsed.toFixed(1)} ms`);
    assert.ok(check.inserted > 0 && check.inserted < 2_000, 'health must run between committed insert batches');
    assert.equal(check.finished, false, 'health must answer while the OTLP request is in flight');
  }
  t.diagnostic(`health during quarantine/event inserts: ${checks.map((check) => check.elapsed.toFixed(1)).join('/')} ms`);
  assert.equal(result.status, 200);
  assert.equal(result.text, '{"partialSuccess":{"rejectedLogRecords":"2000","errorMessage":"2000 unrecognized OTLP record(s) quarantined"}}');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_quarantine').get().count, 2_000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_events').get().count, 2_000);
});

test('health answers while a near-limit OTLP logs body is still being parsed', async (t) => {
  const { store, app } = appFixture(t);
  const payload = JSON.stringify({
    resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: 250_000 }, () => ({})) }] }],
  });
  assert.ok(Buffer.byteLength(payload) < 1_000_000);
  let insertStarted = false;
  const original = store.ingestOtelQuarantine.bind(store);
  store.ingestOtelQuarantine = (records) => { insertStarted = true; return original(records); };
  const started = performance.now();
  const flight = post(app, '/otlp/v1/logs', payload);
  let result;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const health = await request(app, '/api/health', '', { method: 'GET' });
    const elapsed = performance.now() - started;
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.ok(elapsed < 750, `health waited ${elapsed.toFixed(1)} ms for OTLP parsing`);
    assert.equal(insertStarted, false, 'parsing must yield before all 250000 records are normalized');
    t.diagnostic(`health during 250000-record parse: ${elapsed.toFixed(1)} ms`);
  } finally { result = await flight; }
  assert.equal(result.text, '{"partialSuccess":{"rejectedLogRecords":"250000","errorMessage":"250000 unrecognized OTLP record(s) quarantined"}}');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_quarantine').get().count, 1, 'duplicate receipts still deduplicate across batches');
});

test('OTLP receiver defaults off and presents its routes as not found', async (t) => {
  const { store, app } = appFixture(t, false);
  assert.equal(store.getSettings().otelReceiverEnabled, false);
  assert.throws(() => store.saveSettings({ otelReceiverEnabled: 'yes' }), /must be a boolean/);
  const result = await post(app, '/otlp/v1/metrics', metricsFixture);
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: 'not found' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_metrics').get().count, 0);
});

test('OTLP JSON metrics extract Claude attribution, discard email, and deduplicate retries', async (t) => {
  const { store, app } = appFixture(t);
  let result = await post(app, '/otlp/v1/metrics', metricsFixture);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {});

  const rows = store.db.prepare('SELECT * FROM otel_metrics ORDER BY metric_name DESC').all();
  assert.equal(rows.length, 2);
  const token = rows.find((row) => row.metric_name === 'claude_code.token.usage');
  assert.equal(token.observed_at, '2026-08-09T12:34:56.000Z');
  assert.equal(token.value, 1234);
  assert.equal(token.model, 'claude-placeholder-model');
  assert.equal(token.effort, 'high');
  assert.equal(token.speed, 'fast');
  assert.equal(token.query_source, 'agent');
  assert.equal(token.agent_name, 'placeholder-agent');
  assert.equal(token.skill_name, 'placeholder-skill');
  assert.equal(token.session_id, 'session-placeholder');
  assert.equal(token.account_uuid, 'account-uuid-placeholder');
  assert.equal(token.organization_id, 'organization-placeholder');
  assert.equal(token.token_type, 'input');
  assert.deepEqual(JSON.parse(token.details_json), { 'service.version': 'placeholder-version' });
  assert.equal(JSON.stringify(rows).includes('placeholder@example.invalid'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_quarantine').get().count, 0);

  result = await post(app, '/otlp/v1/metrics', metricsFixture);
  assert.deepEqual(result.body, {});
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_metrics').get().count, 2);
  store.migrate();
  store.migrate();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_metrics').get().count, 2);
});

test('OTLP JSON API-request events extract token splits and cost without sensitive details', async (t) => {
  const { store, app } = appFixture(t);
  const result = await post(app, '/otlp/v1/logs', logsFixture);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {});
  const row = store.db.prepare('SELECT * FROM otel_events').get();
  assert.equal(row.event_name, 'api_request');
  assert.equal(row.observed_at, '2026-08-09T12:35:00.000Z');
  assert.equal(row.model, 'claude-placeholder-model');
  assert.equal(row.effort, 'medium');
  assert.equal(row.speed, 'standard');
  assert.equal(row.query_source, 'user');
  assert.equal(row.agent_name, 'placeholder-agent');
  assert.equal(row.skill_name, 'placeholder-skill');
  assert.equal(row.session_id, 'session-placeholder');
  assert.equal(row.account_uuid, 'account-uuid-placeholder');
  assert.equal(row.organization_id, 'organization-placeholder');
  assert.equal(row.request_id, 'request-placeholder');
  assert.equal(row.input_tokens, 100);
  assert.equal(row.output_tokens, 20);
  assert.equal(row.cache_read_tokens, 70);
  assert.equal(row.cache_creation_tokens, 10);
  assert.equal(row.cost_usd, 0.025);
  assert.deepEqual(JSON.parse(row.details_json), { 'terminal.type': 'placeholder-terminal' });
  const persisted = JSON.stringify(row);
  assert.equal(persisted.includes('placeholder@example.invalid'), false);
  assert.equal(persisted.includes('credential-placeholder'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_quarantine').get().count, 0);
});

test('malformed OTLP JSON returns 400 and persists nothing', async (t) => {
  const { store, app } = appFixture(t);
  const result = await post(app, '/otlp/v1/metrics', '{"resourceMetrics":');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /JSON/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_metrics').get().count, 0);
});

test('protobuf OTLP is rejected with a clear 415 and persists nothing', async (t) => {
  const { store, app } = appFixture(t);
  const result = await post(app, '/otlp/v1/logs', 'protobuf-placeholder', 'application/x-protobuf');
  assert.equal(result.status, 415);
  assert.match(result.body.error, /JSON only; protobuf content types are not supported/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_events').get().count, 0);
});

test('unknown OTLP records are counted, scrubbed, quarantined, and deduplicated', async (t) => {
  const { store, app } = appFixture(t);
  let result = await post(app, '/otlp/v1/logs', unknownLogsFixture);
  assert.equal(result.status, 200);
  assert.equal(result.body.partialSuccess.rejectedLogRecords, '1');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_events').get().count, 0);
  let rows = store.db.prepare('SELECT * FROM otel_quarantine').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, 'logs');
  assert.match(rows[0].reason, /event name or timestamp/);
  assert.equal(rows[0].truncated, 0);
  assert.match(rows[0].received_at, /^\d{4}-\d{2}-\d{2}T/);
  const raw = JSON.parse(rows[0].raw_json);
  assert.equal(raw.body.stringValue, 'unknown-event-with-placeholder');
  assert.equal(Object.hasOwn(raw, 'resourceLogs'), false, 'stores the failed record subtree, not the whole payload');
  assert.equal(Object.hasOwn(raw, 'scopeLogs'), false, 'stores the failed record subtree, not its parent scope');
  const persisted = rows[0].raw_json;
  assert.equal(persisted.includes('unknown@example.invalid'), false);
  assert.equal(persisted.includes('authorization-placeholder'), false);
  assert.equal(persisted.includes('secret-placeholder'), false);

  result = await post(app, '/otlp/v1/logs', unknownLogsFixture);
  assert.equal(result.body.partialSuccess.rejectedLogRecords, '1');
  rows = store.db.prepare('SELECT * FROM otel_quarantine').all();
  assert.equal(rows.length, 1);
  store.migrate();
  store.migrate();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_quarantine').get().count, 1);
});

test('unsupported OTLP metrics report rejected data points rather than quarantine entries', async (t) => {
  const { store, app } = appFixture(t);
  const payload = JSON.stringify({
    resourceMetrics: [{ scopeMetrics: [{ metrics: [{
      name: 'placeholder.unsupported.metric',
      gauge: {
        dataPoints: [
          { timeUnixNano: '1786278900000000000', asInt: '1' },
          { timeUnixNano: '1786278901000000000', asInt: '2' },
        ],
      },
    }] }] }],
  });

  const result = await post(app, '/otlp/v1/metrics', payload);

  assert.equal(result.status, 200);
  assert.equal(result.body.partialSuccess.rejectedDataPoints, '2');
  assert.match(result.body.partialSuccess.errorMessage, /^1 unrecognized OTLP record/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_quarantine').get().count, 1);
});

test('oversized quarantine records are capped and marked truncated', async (t) => {
  const { store, app } = appFixture(t);
  const payload = JSON.stringify({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{
      timeUnixNano: '1786278900000000000',
      body: { stringValue: 'x'.repeat(70 * 1024) },
    }] }] }],
  });
  const result = await post(app, '/otlp/v1/logs', payload);
  assert.equal(result.body.partialSuccess.rejectedLogRecords, '1');
  const row = store.db.prepare('SELECT * FROM otel_quarantine').get();
  assert.equal(row.truncated, 1);
  assert.ok(Buffer.byteLength(row.raw_json) <= 64 * 1024);
  assert.equal(JSON.parse(row.raw_json)._modeldeckTruncated, true);
});

test('enabled OTLP routes reject non-loopback peers even with a local Host header', async (t) => {
  const { store, app } = appFixture(t);
  const result = await post(app, '/otlp/v1/metrics', metricsFixture, 'application/json', '192.0.2.10');
  assert.equal(result.status, 403);
  assert.match(result.body.error, /loopback connections only/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM otel_metrics').get().count, 0);
});
