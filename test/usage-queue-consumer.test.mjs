import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, Store } from '../src/db.mjs';
import { ModelDeckService } from '../src/service.mjs';
import {
  UsageQueueConsumer,
  USAGE_QUEUE_CONSUMER_INTERVAL_MS,
  usageQueueWarningCount,
} from '../src/usage-queue-consumer.mjs';
import { enableUsageQueue } from '../scripts/enable-usage-queue.mjs';
import { verifyUsageQueueGuard } from '../scripts/verify-usage-queue-guard.mjs';

const MANAGEMENT_KEY = 'management-key-placeholder';
const API_KEY_SECRET = 'api-key-placeholder';
const ACCESS_TOKEN_SECRET = 'access-token-hash-placeholder';
const RESPONSE_SECRET = 'response-header-secret-placeholder';
const FAILURE_SECRET = 'failure-body-placeholder';
const RAW_AGENT_SECRET = 'raw-agent-detail-placeholder';
const HTTP_BODY_SECRET = 'http-error-body-secret-placeholder';
const noForeignConsumers = async () => ({ checked: true, consumers: [], probe: 'ok' });

function proxyRecord(overrides = {}) {
  return {
    timestamp: '2026-08-09T12:00:00.000Z',
    source: 'queue-user@example.invalid',
    provider: 'claude',
    model: 'claude-placeholder-model',
    request_id: 'queue-request-placeholder-1',
    reasoning_effort: 'high',
    endpoint: '/v1/messages',
    user_agent: `claude-cli/2.0 ${RAW_AGENT_SECRET}`,
    status_code: 200,
    failed: false,
    latency_ms: 120,
    ttft_ms: 40,
    token_breakdown: {
      total_tokens: 116,
      input: { uncached_tokens: 10, cache_read_tokens: 80, cache_write_tokens: 5 },
      output: { total_tokens: 20, reasoning_tokens: 5 },
    },
    api_key: API_KEY_SECRET,
    access_token_sha256: ACCESS_TOKEN_SECRET,
    response_headers: { Authorization: [RESPONSE_SECRET] },
    fail: { status_code: 200, body: FAILURE_SECRET },
    client_ip: '192.0.2.10',
    ...overrides,
  };
}

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  async flush() {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  }

  async runNext(service) {
    assert.equal(this.timers.size, 1, 'exactly one usage-queue tick is armed');
    const [id, timer] = this.timers.entries().next().value;
    assert.equal(timer.delay, USAGE_QUEUE_CONSUMER_INTERVAL_MS);
    this.timers.delete(id);
    timer.callback();
    await this.flush();
    const scheduled = service.usageQueueConsumerPromise;
    assert.ok(scheduled, 'the scheduled callback initiated a queue pull');
    const result = await scheduled;
    await this.flush();
    return result;
  }
}

async function startQueueStub(t, responses, requests) {
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    const response = responses.shift();
    assert.ok(response, 'stub received no unplanned queue request');
    res.setHeader('Content-Type', 'application/json');
    if (response === 'unauthorized') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: HTTP_BODY_SECRET }));
      return;
    }
    if (response === 'malformed') {
      res.end('{"usage": [');
      return;
    }
    if (response === 'empty') {
      res.end(JSON.stringify({ usage: [] }));
      return;
    }
    res.end(JSON.stringify({
      usage: [
        proxyRecord(),
        { provider: 'claude', api_key: 'malformed-record-secret-placeholder' },
      ],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test('usage queue consumption is disabled by default and validates its opt-in setting', async () => {
  assert.equal(DEFAULT_SETTINGS.usageQueueConsumerEnabled, false);
  const store = new Store(':memory:');
  const timers = new FakeTimers();
  let pulls = 0;
  const service = new ModelDeckService(store, {
    usageQueueConsumer: { pull: async () => { pulls += 1; } },
    detectForeignUsageConsumers: noForeignConsumers,
    logUsageQueueGuard: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  try {
    assert.equal(store.getSettings().usageQueueConsumerEnabled, false);
    assert.throws(
      () => store.saveSettings({ usageQueueConsumerEnabled: 'yes' }),
      /usageQueueConsumerEnabled must be a boolean/,
    );
    assert.equal(store.saveSettings({ usageQueueConsumerEnabled: true }).usageQueueConsumerEnabled, true);
    assert.equal(store.saveSettings({ usageQueueConsumerEnabled: false }).usageQueueConsumerEnabled, false);

    service.startUsageQueueConsumer();
    await timers.flush();
    assert.equal(pulls, 0);
    assert.equal(timers.timers.size, 0);

    await service.rescheduleUsageQueueConsumer(
      store.saveSettings({ usageQueueConsumerEnabled: true }),
    );
    await timers.flush();
    assert.equal(pulls, 1);
    assert.equal(timers.timers.size, 1);

    // A full settings echo or unrelated update must not create another
    // destructive read before the fixed interval.
    service.rescheduleUsageQueueConsumer(store.saveSettings({ layout: 'single-column' }));
    await timers.flush();
    assert.equal(pulls, 1);
    assert.equal(timers.timers.size, 1);

    await service.rescheduleUsageQueueConsumer(
      store.saveSettings({ usageQueueConsumerEnabled: false }),
    );
    assert.equal(timers.timers.size, 0);
  } finally {
    await service.stopUsageQueueConsumer();
    store.close();
  }
});

test('disabling waits for an in-flight destructive pull before completing the handoff', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ usageQueueConsumerEnabled: true });
  const timers = new FakeTimers();
  let release;
  const inFlightGate = new Promise((resolve) => { release = resolve; });
  const service = new ModelDeckService(store, {
    usageQueueConsumer: { pull: () => inFlightGate },
    detectForeignUsageConsumers: noForeignConsumers,
    logUsageQueueGuard: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  try {
    await service.startUsageQueueConsumer();
    assert.ok(service.usageQueueConsumerPromise);
    let handoffComplete = false;
    const disabling = service.rescheduleUsageQueueConsumer(
      store.saveSettings({ usageQueueConsumerEnabled: false }),
    ).then(() => { handoffComplete = true; });
    await timers.flush();
    assert.equal(handoffComplete, false);
    assert.equal(timers.timers.size, 0);

    release({ records: 0 });
    await disabling;
    assert.equal(handoffComplete, true);
    assert.equal(timers.timers.size, 0);
  } finally {
    release({ records: 0 });
    await service.stopUsageQueueConsumer();
    store.close();
  }
});

test('enabled daemon retries stub failures every five minutes and persists only allowlisted fields', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managementKeyPath = path.join(root, '.mgmt-key');
  const requests = [];
  const baseUrl = await startQueueStub(
    t,
    ['unauthorized', 'malformed', 'empty', 'success'],
    requests,
  );
  const store = new Store(':memory:');
  const timers = new FakeTimers();
  const warnings = [];
  const logs = [];
  const account = store.saveAccount({
    provider: 'claude',
    label: 'Queue Placeholder',
    identity: 'queue-user@example.invalid',
    profileRef: 'queue-placeholder-profile',
  });
  store.saveSettings({ usageQueueConsumerEnabled: true });
  const service = new ModelDeckService(store, {
    cliproxyManagementKeyPath: managementKeyPath,
    usageQueueBaseUrl: baseUrl,
    warnUsageQueue: (message) => warnings.push(message),
    logUsageQueue: (message) => logs.push(message),
    detectForeignUsageConsumers: noForeignConsumers,
    logUsageQueueGuard: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  t.after(async () => {
    await service.stopUsageQueueConsumer();
    store.close();
  });

  // Startup resolves the key at runtime. Its absence is a counted warning,
  // never a crash or an accidental request to either the stub or live port.
  await service.startUsageQueueConsumer();
  assert.ok(service.usageQueueConsumerPromise, 'startup initiated the enabled consumer');
  const missingKey = await service.usageQueueConsumerPromise;
  await timers.flush();
  assert.equal(missingKey.warnings.keyFile, 1);
  assert.equal(usageQueueWarningCount(missingKey), 1);
  assert.equal(requests.length, 0);

  // Key rotation/creation is noticed on the next tick without daemon restart.
  fs.writeFileSync(managementKeyPath, `  ${MANAGEMENT_KEY}\n`, { mode: 0o600 });

  const unauthorized = await timers.runNext(service);
  assert.equal(unauthorized.warnings.httpFailures, 1);
  assert.equal(usageQueueWarningCount(unauthorized), 1);

  const malformed = await timers.runNext(service);
  assert.equal(malformed.warnings.malformedBodies, 1);
  assert.equal(usageQueueWarningCount(malformed), 1);

  const empty = await timers.runNext(service);
  assert.equal(empty.records, 0);
  assert.equal(usageQueueWarningCount(empty), 0);

  const ingested = await timers.runNext(service);
  assert.deepEqual({
    records: ingested.records,
    inserted: ingested.inserted,
    duplicates: ingested.duplicates,
    resolved: ingested.resolved,
    unresolved: ingested.unresolved,
    malformedRecords: ingested.warnings.malformedRecords,
  }, {
    records: 1,
    inserted: 1,
    duplicates: 0,
    resolved: 1,
    unresolved: 0,
    malformedRecords: 1,
  });
  assert.equal(usageQueueWarningCount(ingested), 1);
  assert.equal(timers.timers.size, 1, 'success also arms only the next five-minute tick');

  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/v0/management/usage-queue?count=500');
    assert.equal(request.authorization, `Bearer ${MANAGEMENT_KEY}`);
  }

  const rows = store.db.prepare('SELECT * FROM request_usage').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, 'queue-request-placeholder-1');
  assert.equal(rows[0].account_id, account.id);
  assert.equal(rows[0].source_raw, null);
  const columns = store.db.prepare('PRAGMA table_info(request_usage)').all().map((column) => column.name);
  for (const forbiddenColumn of ['api_key', 'access_token_sha256', 'response_headers']) {
    assert.equal(columns.includes(forbiddenColumn), false);
  }

  const persisted = JSON.stringify({
    rows,
    settings: store.db.prepare('SELECT value_json FROM settings').all(),
  });
  const emitted = [...warnings, ...logs].join('\n');
  for (const secret of [
    MANAGEMENT_KEY,
    API_KEY_SECRET,
    ACCESS_TOKEN_SECRET,
    RESPONSE_SECRET,
    FAILURE_SECRET,
    RAW_AGENT_SECRET,
    HTTP_BODY_SECRET,
    'malformed-record-secret-placeholder',
  ]) {
    assert.equal(persisted.includes(secret), false, `${secret} must not be persisted`);
    assert.equal(emitted.includes(secret), false, `${secret} must not be logged`);
  }
  assert.deepEqual(logs, [
    'usage queue ingested: records=1 inserted=1 duplicates=0 resolved=1 unresolved=0 warnings=1',
  ]);
});

test('proxy-down errors are counted without exposing fetch or credential details', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-queue-down-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managementKeyPath = path.join(root, '.mgmt-key');
  fs.writeFileSync(managementKeyPath, MANAGEMENT_KEY, { mode: 0o600 });
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveSettings({ usageQueueConsumerEnabled: true });
  const warnings = [];
  const consumer = new UsageQueueConsumer({
    store,
    managementKeyPath,
    baseUrl: 'http://127.0.0.1:43210',
    fetcher: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${MANAGEMENT_KEY}`);
      throw new Error(`proxy down: ${MANAGEMENT_KEY}`);
    },
    warn: (message) => warnings.push(message),
    log: () => assert.fail('a failed pull must not log a successful ingest'),
  });

  const result = await consumer.pull();
  assert.equal(result.warnings.requestFailures, 1);
  assert.equal(usageQueueWarningCount(result), 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM request_usage').get().count, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(MANAGEMENT_KEY), false);
});

test('a scheduled proxy-down warning retries on the next five-minute tick', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-queue-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managementKeyPath = path.join(root, '.mgmt-key');
  fs.writeFileSync(managementKeyPath, MANAGEMENT_KEY, { mode: 0o600 });
  const store = new Store(':memory:');
  store.saveSettings({ usageQueueConsumerEnabled: true });
  const timers = new FakeTimers();
  const warnings = [];
  let attempts = 0;
  const service = new ModelDeckService(store, {
    cliproxyManagementKeyPath: managementKeyPath,
    usageQueueBaseUrl: 'http://127.0.0.1:43210',
    usageQueueFetch: async () => {
      attempts += 1;
      throw new Error('stub proxy unavailable');
    },
    warnUsageQueue: (message) => warnings.push(message),
    logUsageQueue: () => assert.fail('a failed pull must not log a successful ingest'),
    detectForeignUsageConsumers: noForeignConsumers,
    logUsageQueueGuard: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  t.after(async () => {
    await service.stopUsageQueueConsumer();
    store.close();
  });

  await service.startUsageQueueConsumer();
  assert.ok(service.usageQueueConsumerPromise, 'startup initiated the enabled consumer');
  const first = await service.usageQueueConsumerPromise;
  await timers.flush();
  assert.equal(first.warnings.requestFailures, 1);
  assert.equal(attempts, 1);
  assert.equal(timers.timers.size, 1);

  const second = await timers.runNext(service);
  assert.equal(second.warnings.requestFailures, 1);
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 2);
  assert.equal(timers.timers.size, 1);
});

// TRIPWIRE (#388): a live retired launchd job must block the daemon before
// its first destructive read, log loudly, and remain visible in state.
test('TRIPWIRE: startup blocks and surfaces a simulated foreign usage consumer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-usage-queue-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  let pulls = 0;
  const logs = [];
  const service = new ModelDeckService(store, {
    claudeActiveLink: path.join(root, 'active-claude'),
    codexActiveLink: path.join(root, 'active-codex'),
    usageQueueConsumer: { pull: async () => { pulls += 1; } },
    detectForeignUsageConsumers: async () => ({
      checked: true,
      consumers: ['ai.hermes.modeldeck.ingest'],
      probe: 'ok',
    }),
    logUsageQueueGuard: (message) => logs.push(message),
  });
  t.after(async () => {
    await service.stopUsageQueueConsumer();
    store.close();
  });

  await service.startUsageQueueConsumer();

  // Startup checks even while the daemon consumer is still operator-disabled.
  // Arming it afterwards must remain blocked without a destructive read.
  assert.equal(service.usageQueueStatus().configured, false);
  await service.rescheduleUsageQueueConsumer(
    store.saveSettings({ usageQueueConsumerEnabled: true }),
  );
  assert.equal(pulls, 0, 'the queue is never read while the foreign job is loaded');
  assert.deepEqual(logs, [
    'USAGE QUEUE FOREIGN CONSUMER DETECTED: still loaded: ai.hermes.modeldeck.ingest; daemon consumer blocked',
  ]);
  const state = await service.state();
  assert.deepEqual(state.usageQueue.guard, {
    status: 'blocked',
    checkedAt: state.usageQueue.guard.checkedAt,
    foreignConsumers: ['ai.hermes.modeldeck.ingest'],
    message: logs[0],
  });
  assert.equal(state.usageQueue.configured, true);
  assert.equal(state.usageQueue.running, false);
});

test('clear startup announces the single-consumer invariant in the daemon log', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ usageQueueConsumerEnabled: true });
  const logs = [];
  const service = new ModelDeckService(store, {
    usageQueueConsumer: { pull: async () => ({ records: 0, warnings: {} }) },
    detectForeignUsageConsumers: noForeignConsumers,
    logUsageQueueGuard: (message) => logs.push(message),
  });
  try {
    await service.startUsageQueueConsumer();
    assert.deepEqual(logs, [
      'USAGE QUEUE DAEMON CONSUMER ARMED: retired launchd consumers confirmed absent',
    ]);
    assert.equal((await service.state()).usageQueue.guard.status, 'clear');
  } finally {
    await service.stopUsageQueueConsumer();
    store.close();
  }
});

test('an unchanged enabled setting retries after the foreign consumer is unloaded', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ usageQueueConsumerEnabled: true });
  let blocked = true;
  let pulls = 0;
  const service = new ModelDeckService(store, {
    usageQueueConsumer: { pull: async () => { pulls += 1; return { records: 0, warnings: {} }; } },
    detectForeignUsageConsumers: async () => ({
      checked: true,
      consumers: blocked ? ['ai.hermes.modeldeck.ingest'] : [],
      probe: 'ok',
    }),
    logUsageQueueGuard: () => {},
  });
  try {
    await service.startUsageQueueConsumer();
    assert.equal(pulls, 0);
    blocked = false;
    await service.rescheduleUsageQueueConsumer(store.getSettings());
    await service.usageQueueConsumerPromise;
    assert.equal(pulls, 1);
    assert.equal(service.usageQueueStatus().guard.status, 'clear');
  } finally {
    await service.stopUsageQueueConsumer();
    store.close();
  }
});

test('startup cannot overwrite an operator cutover completed during its guard probe', async () => {
  const store = new Store(':memory:');
  let releaseStartupProbe;
  const startupProbe = new Promise((resolve) => { releaseStartupProbe = resolve; });
  let probes = 0;
  let pulls = 0;
  const service = new ModelDeckService(store, {
    usageQueueConsumer: { pull: async () => { pulls += 1; return { records: 0, warnings: {} }; } },
    detectForeignUsageConsumers: async () => {
      probes += 1;
      if (probes === 1) await startupProbe;
      return { checked: true, consumers: [], probe: 'ok' };
    },
    logUsageQueueGuard: () => {},
  });
  try {
    const starting = service.startUsageQueueConsumer();
    await Promise.resolve();
    const enabling = service.rescheduleUsageQueueConsumer(
      store.saveSettings({ usageQueueConsumerEnabled: true }),
    );
    releaseStartupProbe();
    await Promise.all([starting, enabling]);
    await service.usageQueueConsumerPromise;

    assert.equal(probes, 1, 'concurrent startup and cutover share one launchd probe');
    assert.equal(pulls, 1);
    assert.equal(service.usageQueueStatus().configured, true);
    assert.equal(service.usageQueueStatus().running, true);
  } finally {
    releaseStartupProbe();
    await service.stopUsageQueueConsumer();
    store.close();
  }
});

test('re-arming clears the prior pull result until the new first pull completes', async () => {
  const store = new Store(':memory:');
  store.saveSettings({ usageQueueConsumerEnabled: true });
  let releaseSecondPull;
  const secondPull = new Promise((resolve) => { releaseSecondPull = resolve; });
  let pulls = 0;
  const service = new ModelDeckService(store, {
    usageQueueConsumer: {
      pull: async () => {
        pulls += 1;
        if (pulls === 2) await secondPull;
        return { records: 0, warnings: {} };
      },
    },
    detectForeignUsageConsumers: noForeignConsumers,
    logUsageQueueGuard: () => {},
  });
  try {
    await service.startUsageQueueConsumer();
    await service.usageQueueConsumerPromise;
    await service.rescheduleUsageQueueConsumer(
      store.saveSettings({ usageQueueConsumerEnabled: false }),
    );
    assert.equal(typeof service.usageQueueStatus().lastPull.at, 'string');

    await service.rescheduleUsageQueueConsumer(
      store.saveSettings({ usageQueueConsumerEnabled: true }),
    );
    assert.equal(service.usageQueueStatus().lastPull, null);
    releaseSecondPull();
    await service.usageQueueConsumerPromise;
    assert.equal(typeof service.usageQueueStatus().lastPull.at, 'string');
  } finally {
    releaseSecondPull();
    await service.stopUsageQueueConsumer();
    store.close();
  }
});

test('management key file path honors the environment override without reading the key', async () => {
  const original = process.env.MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH;
  const override = path.join(os.tmpdir(), 'modeldeck-management-key-path-placeholder');
  try {
    process.env.MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH = override;
    const paths = await import(`../src/paths.mjs?usage-queue-test=${Date.now()}`);
    assert.equal(paths.CLIPROXY_MANAGEMENT_KEY_PATH, path.resolve(override));
  } finally {
    if (original === undefined) delete process.env.MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH;
    else process.env.MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH = original;
  }
});

test('launchd guard classifies only exit 0 as loaded and known not-found exits as absent', async () => {
  const { classifyLaunchctlPrint, RETIRED_USAGE_CONSUMER_LABELS } = await import('../src/usage-queue-guard.mjs');
  assert.deepEqual(RETIRED_USAGE_CONSUMER_LABELS, [
    'com.cliproxyapi.poller',
    'ai.hermes.modeldeck.ingest',
  ]);
  assert.equal(classifyLaunchctlPrint({ code: 0 }), 'loaded');
  assert.equal(classifyLaunchctlPrint({ code: 113 }), 'not-found');
  assert.equal(classifyLaunchctlPrint({ code: 3 }), 'not-found');
  assert.equal(classifyLaunchctlPrint({ code: 1 }), 'unknown');
  assert.equal(classifyLaunchctlPrint({ signal: 'SIGTERM' }), 'unknown');
});

test('retirement script removes both pre-0.4.6 consumer jobs together', () => {
  const script = fs.readFileSync(new URL('../scripts/retire-usage-poller.sh', import.meta.url), 'utf8');
  assert.match(script, /for LABEL in com\.cliproxyapi\.poller ai\.hermes\.modeldeck\.ingest/);
  assert.match(script, /"\$LAUNCHCTL_BIN" print "\$GUI_TARGET\/\$LABEL"/);
  assert.match(script, /"\$LAUNCHCTL_BIN" bootout "\$GUI_TARGET\/\$LABEL"/);
  assert.match(script, /3\|113\).*was not loaded/);
  assert.match(script, /could not confirm unload.*plist retained/);
  assert.match(script, /could not determine launchd state.*plist retained/);
  assert.match(script, /rm "\$PLIST"/);
  assert.doesNotMatch(script, /echo .*\$PLIST|echo .*\$GUI_TARGET/);
});

test('retirement script retains a plist when launchctl cannot confirm unload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-retire-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = path.join(root, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  const poller = path.join(agents, 'com.cliproxyapi.poller.plist');
  const ingest = path.join(agents, 'ai.hermes.modeldeck.ingest.plist');
  fs.writeFileSync(poller, 'placeholder\n');
  fs.writeFileSync(ingest, 'placeholder\n');
  const launchctl = path.join(root, 'launchctl-placeholder');
  fs.writeFileSync(launchctl, '#!/bin/sh\ncase "$1:$2" in print:*com.cliproxyapi.poller) exit 0;; bootout:*com.cliproxyapi.poller) exit 1;; print:*) exit 3;; *) exit 0;; esac\n', { mode: 0o700 });

  const result = spawnSync('/bin/bash', [fileURLToPath(new URL('../scripts/retire-usage-poller.sh', import.meta.url))], {
    env: { HOME: root, PATH: '/usr/bin:/bin', MODELDECK_LAUNCHCTL_BIN: launchctl },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /com\.cliproxyapi\.poller: could not confirm unload.*plist retained/);
  assert.equal(fs.existsSync(poller), true);
  assert.equal(fs.existsSync(ingest), false);
});

test('retired interim ingest target is inert in 0.4.6', () => {
  const script = fs.readFileSync(new URL('../scripts/ingest-all.sh', import.meta.url), 'utf8');
  assert.match(script, /retired in ModelDeck 0\.4\.6/);
  assert.doesNotMatch(script, /npm run|refit-usage-estimates|scripts\/ingest-/);
});

test('release helper enables only the daemon usage-queue setting', async () => {
  const requests = [];
  const output = [];
  await enableUsageQueue({
    token: 'mutation-token-placeholder',
    fetcher: async (url, options) => {
      requests.push({ url: String(url), options });
      return String(url).endsWith('/api/settings')
        ? {
          ok: true,
          status: 200,
          json: async () => ({
            usageQueueConsumerEnabled: options?.body
              ? JSON.parse(options.body).usageQueueConsumerEnabled
              : false,
          }),
        }
        : {
          ok: true,
          status: 200,
          json: async () => ({
            usageQueue: {
              running: true,
              guard: { status: 'clear' },
              lastPull: { at: '2026-08-13T00:00:00.000Z', warnings: 0 },
            },
          }),
        };
    },
    wait: async () => {},
    stdout: { write: (value) => output.push(value) },
  });
  assert.equal(requests[0].url, 'http://127.0.0.1:3867/api/settings');
  assert.equal(requests[0].options.method, undefined);
  assert.deepEqual(JSON.parse(requests[1].options.body), { usageQueueConsumerEnabled: true });
  assert.equal(requests[1].options.headers['X-ModelDeck-Token'], 'mutation-token-placeholder');
  assert.equal(requests[2].url, 'http://127.0.0.1:3867/api/state');
  assert.deepEqual(output, ['Usage queue enabled; guard clear and first daemon pull clean\n']);
});

test('release helper restores the prior off kill switch when startup guard blocks', async () => {
  const bodies = [];
  await assert.rejects(() => enableUsageQueue({
    token: 'mutation-token-placeholder',
    fetcher: async (url, options) => {
      if (options?.body) bodies.push(JSON.parse(options.body));
      if (String(url).endsWith('/api/state')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usageQueue: {
              running: false,
              guard: { status: 'blocked', message: 'foreign consumer placeholder' },
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          usageQueueConsumerEnabled: options?.body
            ? JSON.parse(options.body).usageQueueConsumerEnabled
            : false,
        }),
      };
    },
    wait: async () => {},
  }), /foreign consumer placeholder/);
  assert.deepEqual(bodies, [
    { usageQueueConsumerEnabled: true },
    { usageQueueConsumerEnabled: false },
  ]);
});

test('release helper rolls back an applied settings update it cannot confirm', async () => {
  const bodies = [];
  await assert.rejects(() => enableUsageQueue({
    token: 'mutation-token-placeholder',
    fetcher: async (_url, options) => {
      if (!options?.body) {
        return { ok: true, status: 200, json: async () => ({ usageQueueConsumerEnabled: false }) };
      }
      const body = JSON.parse(options.body);
      bodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => body.usageQueueConsumerEnabled ? ({}) : ({ usageQueueConsumerEnabled: false }),
      };
    },
    wait: async () => {},
  }), /daemon did not confirm usageQueueConsumerEnabled=true/);
  assert.deepEqual(bodies, [
    { usageQueueConsumerEnabled: true },
    { usageQueueConsumerEnabled: false },
  ]);
});

test('release helper refuses to mutate without an explicit boolean snapshot', async () => {
  let requests = 0;
  await assert.rejects(() => enableUsageQueue({
    token: 'mutation-token-placeholder',
    fetcher: async () => {
      requests += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  }), /could not snapshot usage-queue kill switch: settings read did not return usageQueueConsumerEnabled/);
  assert.equal(requests, 1);
});

test('release verifier requires the surfaced queue guard to be clear and running', async () => {
  const output = [];
  await verifyUsageQueueGuard({
    fetcher: async () => ({
      ok: true,
      json: async () => ({
        usageQueue: {
          configured: true,
          running: true,
          guard: { status: 'clear' },
          lastPull: { at: '2026-08-13T00:00:00.000Z', warnings: 0 },
        },
      }),
    }),
    stdout: { write: (value) => output.push(value) },
  });
  assert.deepEqual(output, ['Usage queue guard clear; latest daemon pull completed without warnings\n']);
  await assert.rejects(() => verifyUsageQueueGuard({
    fetcher: async () => ({
      ok: true,
      json: async () => ({
        usageQueue: {
          configured: true,
          running: false,
          guard: { status: 'blocked', message: 'foreign consumer placeholder' },
        },
      }),
    }),
  }), /foreign consumer placeholder/);
});

// CodeRabbit on #816: a whitespace-only token is no token, from an argument or
// from the environment, and nothing is sent to the daemon.
test('a whitespace-only mutation token is refused before any request', async (t) => {
  let fetched = 0;
  await assert.rejects(() => enableUsageQueue({ token: '  \t', fetcher: async () => { fetched += 1; } }), /no mutation token/);
  assert.equal(fetched, 0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-enable-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/enable-usage-queue.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: home, MODELDECK_MUTATION_TOKEN: '   ', MODELDECK_SKIP_KEYCHAIN: '1',
    MODELDECK_SECRETS_DIR: path.join(home, 'secrets'), MODELDECK_BASE_URL: 'http://127.0.0.1:9',
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no mutation token/);
});
