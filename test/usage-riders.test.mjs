import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';
import { hash } from '../src/detectors/shared.mjs';
import { parseUsagePull, parseUsageRecord } from '../src/usage-ingest.mjs';
import { UsageQueueConsumer, usageQueueWarningCount } from '../src/usage-queue-consumer.mjs';

function proxyRecord(overrides = {}) {
  return {
    timestamp: '2026-08-18T20:00:00.000Z',
    source: 'rider-user@example.invalid',
    provider: 'claude',
    model: 'claude-rider-placeholder',
    request_id: 'proxy-internal-request-id',
    auth_type: 'oauth',
    status_code: 200,
    failed: false,
    response_headers: {},
    ...overrides,
  };
}

test('Anthropic unified rider headers traverse the allowlist into nullable warehouse columns', (t) => {
  const providerReset = '2026-08-20T00:00:00.000Z';
  const parsed = parseUsageRecord(proxyRecord({
    profile_label: 'forged-upstream-label',
    response_headers: {
      'rEqUeSt-Id': ['req_anthropic_rider_placeholder'],
      'ANTHROPIC-RATELIMIT-UNIFIED-FALLBACK-PERCENTAGE': ['12.5'],
      'Anthropic-Ratelimit-Unified-Status': ['allowed_warning'],
      'anthropic-ratelimit-unified-reset': [String(Date.parse(providerReset) / 1_000)],
    },
  }));

  assert.deepEqual({
    profileLabel: parsed.profileLabel,
    providerRequestId: parsed.providerRequestId,
    limitUsedPercent: parsed.limitUsedPercent,
    limitStatus: parsed.limitStatus,
    limitResetsAt: parsed.limitResetsAt,
  }, {
    profileLabel: null,
    providerRequestId: 'req_anthropic_rider_placeholder',
    limitUsedPercent: 12.5,
    limitStatus: 'allowed_warning',
    limitResetsAt: providerReset,
  });
  assert.equal(JSON.stringify(parsed).includes('forged-upstream-label'), false);

  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const hostileLabel of ['a'.repeat(129), 'ctl\tlabel', 'nl\nlabel']) {
    assert.throws(
      () => store.ingestRequestUsage([{ ...parsed, profileLabel: hostileLabel }]),
      /profileLabel/,
    );
  }
  store.ingestRequestUsage([{ ...parsed, profileLabel: 'Claude Rider Placeholder' }]);
  const row = store.db.prepare(`
    SELECT profile_label, provider_request_id, limit_used_percent,
      limit_status, limit_resets_at
    FROM request_usage WHERE request_id = ?
  `).get(parsed.requestId);
  assert.deepEqual({ ...row }, {
    profile_label: 'Claude Rider Placeholder',
    provider_request_id: 'req_anthropic_rider_placeholder',
    limit_used_percent: 12.5,
    limit_status: 'allowed_warning',
    limit_resets_at: providerReset,
  });

  const scoped = parseUsageRecord(proxyRecord({
    request_id: 'proxy-internal-scoped-request-id',
    response_headers: {
      'Anthropic-Ratelimit-Unified-5h-Utilization': ['0.95'],
      'Anthropic-Ratelimit-Unified-5h-Status': ['allowed'],
      'Anthropic-Ratelimit-Unified-5h-Reset': [String(Date.parse('2026-08-19T00:00:00.000Z') / 1_000)],
      'Anthropic-Ratelimit-Unified-7d-Utilization': ['0.90'],
      'Anthropic-Ratelimit-Unified-7d-Status': ['rejected'],
      'Anthropic-Ratelimit-Unified-7d-Reset': [String(Date.parse('2026-08-22T00:00:00.000Z') / 1_000)],
    },
  }));
  assert.equal(scoped.limitUsedPercent, 90, 'a rejected scope outranks a higher-utilization allowed scope');
  assert.equal(scoped.limitStatus, 'rejected');
  assert.equal(scoped.limitResetsAt, '2026-08-22T00:00:00.000Z');
});

test('Anthropic documented limit headers derive the most constrained resource without retaining headers', () => {
  const parsed = parseUsageRecord(proxyRecord({
    response_headers: {
      'Anthropic-Ratelimit-Requests-Limit': ['100'],
      'Anthropic-Ratelimit-Requests-Remaining': ['20'],
      'Anthropic-Ratelimit-Requests-Reset': ['2026-08-19T00:00:00Z'],
      'Anthropic-Ratelimit-Tokens-Limit': ['1000'],
      'Anthropic-Ratelimit-Tokens-Remaining': ['100'],
      'Anthropic-Ratelimit-Tokens-Reset': ['2026-08-20T00:00:00Z'],
    },
  }));

  assert.equal(parsed.limitUsedPercent, 90);
  assert.equal(parsed.limitStatus, null);
  assert.equal(parsed.limitResetsAt, '2026-08-20T00:00:00.000Z');
  assert.equal(Object.hasOwn(parsed, 'responseHeaders'), false);
  assert.equal(Object.hasOwn(parsed, 'response_headers'), false);
});

test('Codex rider parser selects the most constrained pinned x-codex window', () => {
  const parsed = parseUsageRecord(proxyRecord({
    provider: 'codex',
    model: 'gpt-rider-placeholder',
    response_headers: {
      'Request-Id': ['req_codex_rider_placeholder'],
      'X-Codex-Primary-Used-Percent': ['25'],
      'X-Codex-Primary-Reset-At': [String(Date.parse('2026-08-19T00:00:00.000Z') / 1_000)],
      'X-Codex-Secondary-Used-Percent': ['75.5'],
      'X-Codex-Secondary-Reset-At': [String(Date.parse('2026-08-22T00:00:00.000Z') / 1_000)],
      'X-Codex-Other-Primary-Used-Percent': ['99'],
      'X-Codex-Other-Primary-Reset-At': [String(Date.parse('2026-08-23T00:00:00.000Z') / 1_000)],
    },
  }));

  assert.equal(parsed.providerRequestId, 'req_codex_rider_placeholder');
  assert.equal(parsed.limitUsedPercent, 99);
  assert.equal(parsed.limitStatus, null);
  assert.equal(parsed.limitResetsAt, '2026-08-23T00:00:00.000Z');
});

test('rider parsers return NULL when provider headers are absent or renamed', () => {
  for (const record of [
    proxyRecord({
      response_headers: {
        'Provider-Request-Id': ['req_renamed_anthropic'],
        'Anthropic-Ratelimit-Unified-Percentage': ['44'],
        'Anthropic-Ratelimit-Unified-Reset-At': ['1787184000'],
      },
    }),
    proxyRecord({
      provider: 'codex',
      model: 'gpt-rider-placeholder',
      response_headers: {
        'Provider-Request-Id': ['req_renamed_codex'],
        'X-Codex-Primary-Usage-Percent': ['44'],
        'X-Codex-Primary-Reset': ['1787184000'],
      },
    }),
    proxyRecord({ response_headers: undefined }),
  ]) {
    const parsed = parseUsageRecord(record);
    assert.deepEqual({
      providerRequestId: parsed.providerRequestId,
      limitUsedPercent: parsed.limitUsedPercent,
      limitStatus: parsed.limitStatus,
      limitResetsAt: parsed.limitResetsAt,
    }, {
      providerRequestId: null,
      limitUsedPercent: null,
      limitStatus: null,
      limitResetsAt: null,
    });
  }
});

test('rider parsers reject hostile, ambiguous, and out-of-range values instead of clamping or throwing', () => {
  const outsideWindow = new Date(Date.parse('2026-08-18T20:00:00.000Z') + 401 * 86_400_000);
  const hostile = parseUsageRecord(proxyRecord({
    response_headers: {
      'Request-Id': ['<script>'],
      'Anthropic-Ratelimit-Unified-Fallback-Percentage': ['101'],
      'Anthropic-Ratelimit-Unified-Status': ['unexpected-status'],
      'Anthropic-Ratelimit-Unified-Reset': [String(outsideWindow.getTime() / 1_000)],
    },
  }));
  assert.deepEqual({
    providerRequestId: hostile.providerRequestId,
    limitUsedPercent: hostile.limitUsedPercent,
    limitStatus: hostile.limitStatus,
    limitResetsAt: hostile.limitResetsAt,
  }, {
    providerRequestId: null,
    limitUsedPercent: null,
    limitStatus: null,
    limitResetsAt: null,
  });

  const ambiguous = parseUsageRecord(proxyRecord({
    response_headers: {
      'Request-Id': ['req_first', 'req_second'],
      'Anthropic-Ratelimit-Unified-Fallback-Percentage': ['1', '2'],
      'Anthropic-Ratelimit-Unified-Status': ['allowed', 'rejected'],
      'Anthropic-Ratelimit-Unified-Reset': ['1787184000', '1787270400'],
    },
  }));
  assert.equal(ambiguous.providerRequestId, null);
  assert.equal(ambiguous.limitUsedPercent, null);
  assert.equal(ambiguous.limitStatus, null);
  assert.equal(ambiguous.limitResetsAt, null);

  const belowRange = parseUsageRecord(proxyRecord({
    provider: 'codex',
    model: 'gpt-rider-placeholder',
    response_headers: { 'X-Codex-Primary-Used-Percent': ['-0.1'] },
  }));
  assert.equal(belowRange.limitUsedPercent, null);

  const nonDecimal = parseUsageRecord(proxyRecord({
    provider: 'codex',
    model: 'gpt-rider-placeholder',
    response_headers: { 'X-Codex-Primary-Used-Percent': ['0x32'] },
  }));
  assert.equal(nonDecimal.limitUsedPercent, null, 'non-decimal numeric syntax is rejected');

  const impossibleDate = parseUsageRecord(proxyRecord({
    response_headers: {
      'Anthropic-Ratelimit-Requests-Limit': ['100'],
      'Anthropic-Ratelimit-Requests-Remaining': ['50'],
      'Anthropic-Ratelimit-Requests-Reset': ['2026-02-30T00:00:00Z'],
    },
  }));
  assert.equal(impossibleDate.limitResetsAt, null, 'impossible RFC 3339 dates are rejected');

});

test('rider rejection counts expose invalid fields without retaining their values', () => {
  const outsideWindow = new Date(Date.parse('2026-08-18T20:00:00.000Z') + 401 * 86_400_000);
  const counted = parseUsagePull(JSON.stringify({ usage: [proxyRecord({
    request_id: 'proxy-rider-rejection-count',
    response_headers: {
      'Request-Id': ['<script>'],
      'Anthropic-Ratelimit-Unified-Fallback-Percentage': ['101'],
      'Anthropic-Ratelimit-Unified-Status': ['unexpected-status'],
      'Anthropic-Ratelimit-Unified-Reset': [String(outsideWindow.getTime() / 1_000)],
    },
  })] }));
  assert.equal(counted.riderRejections, 4);
  assert.equal(JSON.stringify(counted.records).includes('<script>'), false);
  assert.equal(JSON.stringify(counted.records).includes(String(outsideWindow.getTime() / 1_000)), false);
});

test('usage queue surfaces rider rejection counts without logging rejected values', async (t) => {
  const outsideWindow = new Date(Date.parse('2026-08-18T20:00:00.000Z') + 401 * 86_400_000);
  const rejectedValues = ['<script>', '101', 'unexpected-status', String(outsideWindow.getTime() / 1_000)];
  const store = new Store(':memory:');
  t.after(() => store.close());
  const warnings = [];
  const logs = [];
  const consumer = new UsageQueueConsumer({
    store,
    managementKeyPath: '/placeholder-management-key',
    baseUrl: 'http://127.0.0.1:43210',
    readFile: async () => 'management-key-placeholder',
    fetcher: async () => ({
      ok: true,
      text: async () => JSON.stringify({ usage: [proxyRecord({
        request_id: 'queue-rider-rejection-count',
        response_headers: {
          'Request-Id': [rejectedValues[0]],
          'Anthropic-Ratelimit-Unified-Fallback-Percentage': [rejectedValues[1]],
          'Anthropic-Ratelimit-Unified-Status': [rejectedValues[2]],
          'Anthropic-Ratelimit-Unified-Reset': [rejectedValues[3]],
        },
      })] }),
    }),
    warn: (message) => warnings.push(message),
    log: (message) => logs.push(message),
  });

  const result = await consumer.pull();
  assert.equal(result.riderRejections, 4);
  assert.equal(result.warnings.riderRejections, undefined);
  assert.equal(usageQueueWarningCount(result), 0, 'field-level rider rejections do not dilute operational warnings');
  assert.deepEqual(warnings, ['usage queue rejected rider fields: count=4']);
  assert.deepEqual(logs, [
    'usage queue ingested: records=1 inserted=1 duplicates=0 resolved=0 unresolved=1 warnings=0',
  ]);
  for (const value of rejectedValues) {
    assert.equal([...warnings, ...logs].join('\n').includes(value), false);
  }
});

test('client-key hash-on-parse resolves exact mappings and skips keyless records', () => {
  const rawClientKey = 'mapped-client-key-placeholder';
  const mappedHash = hash(rawClientKey);
  const mappedProfile = {
    profileId: 'mapped-profile-placeholder',
    profileLabel: 'Mapped Profile Placeholder',
  };
  const resolvedHashes = [];
  const resolveClientKeyProfile = (keySha256) => {
    resolvedHashes.push(keySha256);
    return keySha256 === mappedHash ? mappedProfile : null;
  };

  const mapped = parseUsageRecord(proxyRecord({ api_key: rawClientKey }), { resolveClientKeyProfile });
  const unknown = parseUsageRecord(proxyRecord({
    request_id: 'proxy-unknown-client-key',
    api_key: 'unknown-client-key-placeholder',
    profile_label: 'forged-unknown-label-placeholder',
  }), { resolveClientKeyProfile });
  const keyless = parseUsageRecord(proxyRecord({
    request_id: 'proxy-keyless-client-key',
    api_key: '',
  }), { resolveClientKeyProfile });

  assert.equal(mapped.profileLabel, mappedProfile.profileLabel);
  assert.equal(unknown.profileLabel, null);
  assert.equal(keyless.profileLabel, null);
  assert.deepEqual(resolvedHashes, [mappedHash, hash('unknown-client-key-placeholder')]);
  for (const forbidden of [rawClientKey, mappedHash, 'unknown-client-key-placeholder', 'forged-unknown-label-placeholder']) {
    assert.equal(JSON.stringify([mapped, unknown, keyless]).includes(forbidden), false);
  }
});

test('TRIPWIRE ingest-attribution-discard-hardening — unresolved client identity never persists or logs', async (t) => {
  const mappedClientKey = 'queue-mapped-client-key-placeholder';
  const unknownClientKey = 'queue-unknown-client-key-placeholder';
  const mappedProfileLabel = 'Queue Mapped Profile Placeholder';
  const forgedUnknownLabel = 'Forged Unknown Profile Placeholder';
  const remoteClientKey = 'queue-remote-client-key-placeholder';
  const revokedClientKey = 'queue-revoked-client-key-placeholder';
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.replaceClientKeyMap({
    generation: 1,
    entries: [{
      keySha256: hash(mappedClientKey),
      profileId: 'queue-mapped-profile-placeholder',
      profileLabel: mappedProfileLabel,
    }],
  });
  for (const key of [remoteClientKey, revokedClientKey]) {
    store.addPoolClientKey({ keySha256: hash(key), machine: 'client-one', profileSlug: 'remote', profileLabel: 'Remote' });
  }
  store.revokePoolClientKey(hash(revokedClientKey));
  const warnings = [];
  const logs = [];
  const consumer = new UsageQueueConsumer({
    store,
    managementKeyPath: '/placeholder-management-key',
    baseUrl: 'http://127.0.0.1:43210',
    readFile: async () => 'management-key-placeholder',
    fetcher: async () => ({
      ok: true,
      text: async () => JSON.stringify({ usage: [
        proxyRecord({ request_id: 'queue-mapped-attribution', api_key: mappedClientKey }),
        proxyRecord({
          request_id: 'queue-unresolved-attribution',
          api_key: unknownClientKey,
          profile_label: forgedUnknownLabel,
        }),
        proxyRecord({ request_id: 'queue-keyless-attribution', api_key: '' }),
        proxyRecord({ request_id: 'queue-remote-attribution', api_key: remoteClientKey }),
        proxyRecord({ request_id: 'queue-revoked-attribution', api_key: revokedClientKey }),
      ] }),
    }),
    warn: (message) => warnings.push(message),
    log: (message) => logs.push(message),
  });

  const result = await consumer.pull();
  assert.equal(result.inserted, 5);
  assert.deepEqual(store.db.prepare(`
    SELECT request_id, profile_label, machine FROM request_usage ORDER BY request_id
  `).all().map((row) => ({ ...row })), [
    { request_id: 'queue-keyless-attribution', profile_label: null, machine: 'studio' },
    { request_id: 'queue-mapped-attribution', profile_label: mappedProfileLabel, machine: 'studio' },
    { request_id: 'queue-remote-attribution', profile_label: 'Remote', machine: 'client-one' },
    { request_id: 'queue-revoked-attribution', profile_label: 'Remote', machine: 'client-one' },
    { request_id: 'queue-unresolved-attribution', profile_label: null, machine: 'studio' },
  ]);

  const persistedUsage = JSON.stringify(store.db.prepare('SELECT * FROM request_usage').all());
  const emitted = [...warnings, ...logs].join('\n');
  assert.equal(persistedUsage.includes(mappedProfileLabel), true, 'only the resolved label is persisted');
  for (const forbidden of [
    mappedClientKey,
    unknownClientKey,
    hash(mappedClientKey),
    hash(unknownClientKey),
    forgedUnknownLabel,
    remoteClientKey, revokedClientKey, hash(remoteClientKey), hash(revokedClientKey), 'api_key',
  ]) {
    assert.equal(persistedUsage.includes(forbidden), false, `${forbidden} must not be persisted`);
  }
  for (const forbidden of [
    mappedClientKey,
    unknownClientKey,
    hash(mappedClientKey),
    hash(unknownClientKey),
    forgedUnknownLabel,
    mappedProfileLabel,
    remoteClientKey, revokedClientKey, hash(remoteClientKey), hash(revokedClientKey), 'api_key',
  ]) {
    assert.equal(emitted.includes(forbidden), false, `${forbidden} must not be logged`);
  }
});

test('TRIPWIRE legacy invalid mapped labels degrade to NULL without dropping a destructive queue batch', async (t) => {
  const validClientKey = 'legacy-valid-label-key-placeholder';
  const overlongClientKey = 'legacy-overlong-label-key-placeholder';
  const controlClientKey = 'legacy-control-label-key-placeholder';
  const validProfileLabel = 'Legacy Valid Profile Placeholder';
  const store = new Store(':memory:');
  t.after(() => store.close());
  // Before issue #523, the report boundary admitted labels up to 256
  // characters and did not reject controls. Simulate that persisted state
  // directly so the first post-upgrade queue pull cannot lose valid records.
  store.replaceClientKeyMap({
    generation: 1,
    entries: [
      {
        keySha256: hash(validClientKey),
        profileId: 'legacy-valid-profile-placeholder',
        profileLabel: validProfileLabel,
      },
      {
        keySha256: hash(overlongClientKey),
        profileId: 'legacy-overlong-profile-placeholder',
        profileLabel: 'x'.repeat(129),
      },
      {
        keySha256: hash(controlClientKey),
        profileId: 'legacy-control-profile-placeholder',
        profileLabel: 'Legacy\nControl Profile Placeholder',
      },
    ],
  });
  const consumer = new UsageQueueConsumer({
    store,
    managementKeyPath: '/placeholder-management-key',
    baseUrl: 'http://127.0.0.1:43210',
    readFile: async () => 'management-key-placeholder',
    fetcher: async () => ({
      ok: true,
      text: async () => JSON.stringify({ usage: [
        proxyRecord({ request_id: 'legacy-valid-label-request', api_key: validClientKey }),
        proxyRecord({ request_id: 'legacy-overlong-label-request', api_key: overlongClientKey }),
        proxyRecord({ request_id: 'legacy-control-label-request', api_key: controlClientKey }),
      ] }),
    }),
    warn: () => {},
    log: () => {},
  });

  const result = await consumer.pull();
  assert.equal(result.warnings.ingestFailures, 0);
  assert.equal(result.inserted, 3);
  assert.deepEqual(store.db.prepare(`
    SELECT request_id, profile_label FROM request_usage ORDER BY request_id
  `).all().map((row) => ({ ...row })), [
    { request_id: 'legacy-control-label-request', profile_label: null },
    { request_id: 'legacy-overlong-label-request', profile_label: null },
    { request_id: 'legacy-valid-label-request', profile_label: validProfileLabel },
  ]);
});

test('TRIPWIRE riders-discard-hardening — raw client keys, upstream keys, and header maps cannot persist', (t) => {
  const rawUpstreamKey = 'sk-ant-api03-upstream-key-placeholder';
  const rawClientKey = 'client-api-key-placeholder';
  const rawHeaderSecret = 'raw-response-header-secret-placeholder';
  const normalized = parseUsageRecord(proxyRecord({
    auth_type: 'apikey',
    source: rawUpstreamKey,
    profile_label: 'forged-profile-label',
    api_key: rawClientKey,
    access_token_sha256: 'raw-access-token-hash-placeholder',
    response_headers: {
      Authorization: [rawHeaderSecret],
      'Request-Id': [rawUpstreamKey],
      'Anthropic-Ratelimit-Unified-Fallback-Percentage': ['35'],
      'Anthropic-Ratelimit-Unified-Status': ['allowed'],
      'Anthropic-Ratelimit-Unified-Reset': [String(Date.parse('2026-08-20T00:00:00.000Z') / 1_000)],
    },
    fail: { status_code: 200, body: 'raw-failure-body-placeholder' },
  }));

  assert.equal(normalized.source, hash(rawUpstreamKey));
  assert.equal(normalized.profileLabel, null);
  assert.equal(normalized.providerRequestId, null, 'a raw key cannot be smuggled through Request-Id');
  const clientKeyCollision = parseUsageRecord(proxyRecord({
    request_id: 'proxy-client-key-collision',
    auth_type: 'apikey',
    source: rawUpstreamKey,
    api_key: rawClientKey,
    response_headers: { 'Request-Id': [rawClientKey] },
  }));
  assert.equal(clientKeyCollision.providerRequestId, null, 'the discarded client api_key cannot be smuggled either');
  const normalizedJson = JSON.stringify(normalized);
  for (const secret of [rawUpstreamKey, rawClientKey, rawHeaderSecret, 'raw-access-token-hash-placeholder', 'raw-failure-body-placeholder', 'forged-profile-label']) {
    assert.equal(normalizedJson.includes(secret), false, `${secret} must be dropped before persistence`);
  }

  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ingestRequestUsage([normalized]);
  const row = store.db.prepare('SELECT * FROM request_usage WHERE request_id = ?').get(normalized.requestId);
  assert.equal(row.source_raw, hash(rawUpstreamKey));
  assert.notEqual(row.source_raw, rawUpstreamKey, 'request_usage.source_raw never contains the raw upstream key');
  assert.equal(row.provider_request_id, null);
  assert.equal(row.limit_used_percent, 35);

  const columns = store.db.prepare('PRAGMA table_info(request_usage)').all().map((column) => column.name);
  for (const forbiddenColumn of ['api_key', 'access_token_sha256', 'response_headers']) {
    assert.equal(columns.includes(forbiddenColumn), false, `${forbiddenColumn} must stay structurally unreachable`);
  }
  const persistedJson = JSON.stringify(store.db.prepare('SELECT * FROM request_usage').all());
  for (const secret of [rawUpstreamKey, rawClientKey, rawHeaderSecret, 'raw-access-token-hash-placeholder', 'raw-failure-body-placeholder', 'forged-profile-label']) {
    assert.equal(persistedJson.includes(secret), false, `${secret} must not be persisted`);
  }
});

test('request_usage migration adds nullable rider columns once and preserves historical rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-riders-migration-'));
  const dbPath = path.join(root, 'legacy.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE request_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      machine TEXT NOT NULL DEFAULT 'studio',
      observed_at TEXT NOT NULL,
      account_id TEXT,
      source_raw TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      alias TEXT,
      reasoning_effort TEXT,
      endpoint TEXT,
      user_agent_class TEXT NOT NULL DEFAULT 'unknown',
      failed INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      latency_ms REAL,
      ttft_ms REAL,
      input_uncached INTEGER NOT NULL DEFAULT 0,
      input_cache_read INTEGER NOT NULL DEFAULT 0,
      input_cache_write INTEGER NOT NULL DEFAULT 0,
      output_total INTEGER NOT NULL DEFAULT 0,
      output_reasoning INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO request_usage(request_id, observed_at, source_raw, provider, model)
    VALUES (
      'historical-rider-placeholder', '2026-08-01T00:00:00.000Z',
      'historical-source-placeholder', 'claude', 'historical-model-placeholder'
    );
  `);
  legacy.close();

  const store = new Store(dbPath);
  t.after(() => store.close());
  store.migrate();
  store.migrate();
  const columns = store.db.prepare('PRAGMA table_info(request_usage)').all().map((column) => column.name);
  for (const column of ['profile_label', 'provider_request_id', 'limit_used_percent', 'limit_status', 'limit_resets_at']) {
    assert.equal(columns.filter((candidate) => candidate === column).length, 1, `${column} is added exactly once`);
  }
  assert.deepEqual({ ...store.db.prepare(`
    SELECT profile_label, provider_request_id, limit_used_percent,
      limit_status, limit_resets_at
    FROM request_usage WHERE request_id = 'historical-rider-placeholder'
  `).get() }, {
    profile_label: null,
    provider_request_id: null,
    limit_used_percent: null,
    limit_status: null,
    limit_resets_at: null,
  });
});
