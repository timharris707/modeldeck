import test from 'node:test';
import assert from 'node:assert/strict';
import * as database from '../src/db.mjs';
import { ModelDeckService, USAGE_SNAPSHOT_PRUNE_INTERVAL_MS } from '../src/service.mjs';

const cutoff = '2026-09-05T00:00:00.000Z';

function seed(store, count, receivedAt, prefix = 'placeholder') {
  const insert = store.db.prepare(`
    INSERT INTO otel_quarantine(ingest_key, received_at, endpoint, reason, raw_json)
    VALUES (?, ?, 'logs', 'unknown event', '{}')
  `);
  store.db.exec('BEGIN');
  try {
    for (let index = 0; index < count; index += 1) insert.run(`${prefix}-${index}`, receivedAt);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

function rows(store) {
  return store.db.prepare('SELECT ingest_key FROM otel_quarantine ORDER BY id').all()
    .map((row) => row.ingest_key);
}

test('quarantine retention removes expired rows in bounded scans and keeps the cutoff boundary', async () => {
  const store = new database.Store(':memory:');
  try {
    seed(store, 1, cutoff, 'boundary');
    seed(store, 1_206, '2026-09-04T23:59:59.999Z', 'expired');
    seed(store, 1, '2026-09-12T00:00:00.000Z', 'current');
    seed(store, 1, '2026-09-13T00:00:00.000Z', 'future');
    let cursor = {};
    let deleted = 0;
    let batches = 0;
    do {
      cursor = store.pruneOtelQuarantineBatch({ cutoff, ...cursor });
      assert.ok(cursor.scanned <= database.OTEL_QUARANTINE_PRUNE_BATCH_SIZE);
      assert.ok(cursor.deleted <= cursor.scanned);
      deleted += cursor.deleted;
      batches += 1;
    } while (cursor.scanned === database.OTEL_QUARANTINE_PRUNE_BATCH_SIZE);
    assert.equal(deleted, 1_206);
    assert.equal(batches, 3);
    assert.deepEqual(rows(store), ['boundary-0', 'current-0', 'future-0']);
    assert.throws(() => store.pruneOtelQuarantineBatch({ cutoff: 'September 5, 2026' }), /canonical ISO timestamp/);
    assert.throws(() => store.pruneOtelQuarantineBatch({ cutoff, batchSize: 501 }), /batchSize/);
  } finally { store.close(); }
});

test('quarantine retention keeps the newest 50000 unexpired receipts and yields between bounded batches', async () => {
  const store = new database.Store(':memory:');
  try {
    seed(store, 51_205, cutoff);
    // An expired receipt inserted last must not consume a place under the cap.
    seed(store, 1, '2026-09-01T00:00:00.000Z', 'late-expired');
    let yields = 0;
    const logs = [];
    const service = new ModelDeckService(store, {
      now: () => Date.parse('2026-09-12T00:00:00.000Z'),
      yieldToServeLoop: async () => { yields += 1; },
      logOtelQuarantinePrune: (count) => logs.push(count),
    });
    assert.equal(database.OTEL_QUARANTINE_RETENTION_DAYS, 7);
    assert.equal(database.OTEL_QUARANTINE_MAX_ROWS, 50_000);
    assert.equal(await service.pruneOtelQuarantine(), 1_206);
    assert.equal(yields, 102);
    assert.deepEqual(logs, [1_206]);
    const remaining = rows(store);
    assert.equal(remaining.length, 50_000);
    assert.equal(remaining[0], 'placeholder-1205');
    assert.equal(remaining.at(-1), 'placeholder-51204');
    assert.equal(await service.pruneOtelQuarantine(), 0, 'a second pass is idempotent');
  } finally { store.close(); }
});

test('quarantine retention runs at startup and on the existing daily interval', async () => {
  const store = new database.Store(':memory:');
  let time = Date.parse('2026-09-12T00:00:00.000Z');
  let nextId = 0;
  const timers = new Map();
  const logs = [];
  const flush = async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); };
  const service = new ModelDeckService(store, {
    demoFixtures: true,
    now: () => time,
    setTimeout: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: time + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    logRequestUsagePrune: () => {},
    logOtelQuarantinePrune: (count) => logs.push(count),
  });
  try {
    store.saveSettings({ autoRefreshEnabled: false });
    seed(store, 1, '2026-09-04T23:59:59.999Z', 'expired');
    seed(store, 1, cutoff, 'boundary');
    service.startUsageSnapshotRetention();
    service.startUsageSnapshotRetention();
    await flush();
    assert.deepEqual(logs, [1]);
    assert.deepEqual(rows(store), ['boundary-0']);
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers.entries()][0];
    assert.equal(timer.dueAt - time, USAGE_SNAPSHOT_PRUNE_INTERVAL_MS);
    time = timer.dueAt;
    timers.delete(id);
    timer.callback();
    await flush();
    assert.deepEqual(logs, [1, 1]);
    assert.deepEqual(rows(store), []);
    assert.equal(timers.size, 1);
    await service.stopUsageSnapshotRetention();
    assert.equal(timers.size, 0);
  } finally {
    await service.stopUsageSnapshotRetention();
    store.close();
  }
});

test('quarantine retention coalesces concurrent drains and shutdown waits for a yielding batch', async () => {
  const store = new database.Store(':memory:');
  let release;
  const yielded = new Promise((resolve) => { release = resolve; });
  const service = new ModelDeckService(store, {
    now: () => Date.parse('2026-09-12T00:00:00.000Z'),
    yieldToServeLoop: () => yielded,
    logOtelQuarantinePrune: () => {},
  });
  try {
    seed(store, 501, '2026-09-01T00:00:00.000Z');
    const first = service.pruneOtelQuarantine();
    assert.equal(service.pruneOtelQuarantine(), first);
    let stopped = false;
    const stopping = service.stopUsageSnapshotRetention().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    assert.equal(await first, 501);
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(rows(store), []);
  } finally {
    release();
    await service.stopUsageSnapshotRetention();
    store.close();
  }
});
