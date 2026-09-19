import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_USAGE_PRUNE_BATCH_SIZE,
  REQUEST_USAGE_RETENTION_DAYS,
  Store,
} from '../src/db.mjs';
import {
  ModelDeckService,
  USAGE_SNAPSHOT_PRUNE_INTERVAL_MS,
} from '../src/service.mjs';

function requestUsage(requestId, observedAt) {
  return {
    requestId,
    machine: 'placeholder-machine',
    observedAt,
    source: 'placeholder-source',
    provider: 'codex',
    model: 'placeholder-model',
    alias: null,
    reasoningEffort: null,
    endpoint: '/v1/placeholder',
    userAgentClass: 'codex',
    failed: false,
    statusCode: 200,
    latencyMs: 1,
    ttftMs: 1,
    inputUncached: 1,
    inputCacheRead: 0,
    inputCacheWrite: 0,
    outputTotal: 1,
    outputReasoning: 0,
    total: 2,
  };
}

function requestIds(store) {
  return store.db.prepare(`
    SELECT request_id FROM request_usage ORDER BY observed_at, id
  `).all().map((row) => row.request_id);
}

test('request_usage retention tripwire deletes only rows older than 400 days and preserves boundary and clock-skew evidence', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(REQUEST_USAGE_RETENTION_DAYS, 400);
    store.ingestRequestUsage([
      requestUsage('expired-by-one-ms', '2025-06-28T23:59:59.999Z'),
      requestUsage('exact-boundary', '2025-06-29T00:00:00.000Z'),
      requestUsage('newer-evidence', '2025-06-29T00:00:00.001Z'),
      requestUsage('future-clock-skew', '2026-08-03T00:05:00.000Z'),
    ]);

    assert.equal(store.pruneRequestUsageBatch({
      cutoff: '2025-06-29T00:00:00.000Z',
    }), 1);
    assert.deepEqual(requestIds(store), [
      'exact-boundary',
      'newer-evidence',
      'future-clock-skew',
    ]);
    assert.equal(store.pruneRequestUsageBatch({
      cutoff: '2025-06-29T00:00:00.000Z',
    }), 0, 'repeating the same prune is idempotent');
  } finally { store.close(); }
});

test('request_usage retention is safe on an empty fresh database', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.pruneRequestUsageBatch({
      cutoff: '2025-06-29T00:00:00.000Z',
    }), 0);
  } finally { store.close(); }
});

test('request_usage retention logs committed deletions when a later batch fails', async () => {
  const store = new Store(':memory:');
  const records = Array.from({ length: REQUEST_USAGE_PRUNE_BATCH_SIZE + 1 }, (_, index) => (
    requestUsage(`partial-failure-${index}`, new Date(Date.parse('2025-01-01T00:00:00.000Z') + index).toISOString())
  ));
  store.ingestRequestUsage(records);
  const originalBatch = store.pruneRequestUsageBatch.bind(store);
  let calls = 0;
  store.pruneRequestUsageBatch = (options) => {
    calls += 1;
    if (calls === 2) throw new Error('forced second-batch failure');
    return originalBatch(options);
  };
  const logs = [];
  const service = new ModelDeckService(store, {
    now: () => Date.parse('2026-08-03T00:00:00.000Z'),
    yieldToServeLoop: async () => {},
    logRequestUsagePrune: (count) => logs.push(count),
  });
  try {
    await assert.rejects(service.pruneRequestUsage(), /forced second-batch failure/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM request_usage').get().count, 1);
    assert.deepEqual(logs, [REQUEST_USAGE_PRUNE_BATCH_SIZE]);
  } finally { store.close(); }
});

test('the existing daily retention schedule prunes request_usage and logs every row count', async () => {
  class FakeClock {
    time = Date.parse('2026-08-03T00:00:00.000Z');
    nextId = 1;
    timers = new Map();
    now = () => this.time;
    setTimeout = (callback, delay) => {
      const id = this.nextId++;
      this.timers.set(id, { callback, dueAt: this.time + delay });
      return id;
    };
    clearTimeout = (id) => this.timers.delete(id);
    async flush() {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    }
    async advance(ms) {
      const target = this.time + ms;
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (next) {
        this.time = next[1].dueAt;
        this.timers.delete(next[0]);
        next[1].callback();
        await this.flush();
      }
      this.time = target;
      await this.flush();
    }
  }

  const store = new Store(':memory:');
  store.ingestRequestUsage([
    requestUsage('scheduled-expired', '2025-06-28T23:59:59.999Z'),
    requestUsage('scheduled-current', '2026-08-02T00:00:00.000Z'),
  ]);
  const clock = new FakeClock();
  const logs = [];
  const service = new ModelDeckService(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logUsageSnapshotPrune: () => {},
    logRequestUsagePrune: (count) => logs.push(count),
  });
  try {
    service.startUsageSnapshotRetention();
    await clock.advance(30_000); // first pass waits for state or the startup deadline
    assert.deepEqual(logs, [1]);
    assert.deepEqual(requestIds(store), ['scheduled-current']);
    assert.equal(clock.timers.size, 1, 'request_usage shares the existing retention timer');

    await clock.advance(USAGE_SNAPSHOT_PRUNE_INTERVAL_MS);
    assert.deepEqual(logs, [1, 0], 'a zero-row prune result is still logged');
    assert.deepEqual(requestIds(store), ['scheduled-current']);
    assert.equal(clock.timers.size, 1);
  } finally {
    await service.stopUsageSnapshotRetention();
    store.close();
  }
});
