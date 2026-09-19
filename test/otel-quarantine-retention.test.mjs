import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

class FakeClock {
  time = Date.parse('2026-09-12T00:00:00.000Z');
  nextId = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, dueAt: this.time + delay });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async flush() {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  }
  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.time = next[1].dueAt;
      this.timers.delete(next[0]);
      next[1].callback();
      await this.flush();
    }
    this.time = target;
    await this.flush();
  }
}

function scheduledService(store, clock, options = {}) {
  store.saveSettings({ autoRefreshEnabled: false, claudeManaged: false, codexManaged: false });
  return new ModelDeckService(store, {
    demoFixtures: true,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logUsageSnapshotPrune: () => {},
    logRequestUsagePrune: () => {},
    logOtelQuarantinePrune: () => {},
    ...options,
  });
}

for (const trigger of ['state', 'timeout']) {
  test(`TRIPWIRE first-start-prune-waits-for-${trigger}`, async () => {
    const store = new database.Store(':memory:');
    const clock = new FakeClock();
    const logs = [];
    const service = scheduledService(store, clock, {
      logOtelQuarantinePrune: (count) => logs.push(count),
    });
    try {
      seed(store, 1, '2026-09-01T00:00:00.000Z');
      service.startUsageSnapshotRetention();
      service.startUsageSnapshotRetention();
      await clock.advance(29_999);
      assert.equal(rows(store).length, 1, 'no cleanup before state or the 30 s deadline');
      assert.equal(clock.timers.size, 1);
      if (trigger === 'state') {
        await service.state();
        await service.state();
        assert.equal(rows(store).length, 1, 'state returns before cleanup starts');
        await clock.advance(0);
      } else {
        await clock.advance(1);
      }
      await clock.advance(100);
      assert.deepEqual(logs, [1]);
      assert.equal(rows(store).length, 0);
      const [timer] = clock.timers.values();
      assert.ok(timer.dueAt > clock.time + USAGE_SNAPSHOT_PRUNE_INTERVAL_MS - 101);
      await service.state();
      await clock.advance(30_000);
      assert.deepEqual(logs, [1], 'later state reads and the old deadline do not prune again');
    } finally {
      await clock.advance(10_000);
      await service.stopUsageSnapshotRetention();
      store.close();
    }
  });
}

test('TRIPWIRE first-start-prune-does-not-starve-state-reads', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-prune-'));
  const store = new database.Store(path.join(directory, 'state.sqlite'));
  const clock = new FakeClock();
  const logs = [];
  const service = scheduledService(store, clock, {
    logOtelQuarantinePrune: (count, elapsedMs) => logs.push({ count, elapsedMs }),
  });
  const events = [];
  const batch = store.pruneOtelQuarantineBatch.bind(store);
  t.mock.method(store, 'pruneOtelQuarantineBatch', (options) => {
    events.push({ type: 'batch', time: clock.time,
      autoCheckpoint: store.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint });
    return batch(options);
  });
  const exec = store.db.exec.bind(store.db);
  t.mock.method(store.db, 'exec', (sql) => {
    if (/wal_checkpoint\(PASSIVE\)/i.test(sql)) events.push({ type: 'checkpoint', time: clock.time });
    return exec(sql);
  });
  try {
    // Real file-backed WAL, small rows, and an aggressively low checkpoint
    // threshold exercise the reported SQLite path without a multi-GB fixture.
    seed(store, 20_000, '2026-09-01T00:00:00.000Z', 'expired');
    seed(store, 60_000, cutoff, 'current');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 1');
    const startedAt = performance.now();
    service.startUsageSnapshotRetention();
    await service.state();
    await clock.advance(0);
    // Reach deletion work (the newest 50k survive), with more still pending.
    await clock.advance(3_000);
    const during = rows(store).length;
    assert.ok(during > 50_000 && during < 80_000, 'prune has deleted rows but is still running');
    const prune = service.otelQuarantinePrunePromise;
    assert.ok(prune);
    const readStartedAt = performance.now();
    let completed = false;
    // State includes asynchronous work as on the real activation/read path.
    t.mock.method(service, 'providerActivationState', () => new Promise((resolve) => {
      clock.setTimeout(() => resolve({ state: 'unmanaged' }), 5);
    }));
    const read = service.state().then((value) => { completed = true; return value; });
    const batchCount = events.filter((event) => event.type === 'batch').length;
    await clock.advance(5);
    assert.equal(completed, true, 'state finishes in 5 ms of simulated time during cleanup');
    await read;
    const readMs = performance.now() - readStartedAt;
    assert.ok(readMs < 2_000, `state took ${readMs} ms`);
    assert.equal(events.filter((event) => event.type === 'batch').length, batchCount,
      'a queued state read finishes before the next batch');
    assert.equal(service.otelQuarantinePrunePromise, prune);
    await clock.advance(10_000);
    assert.equal(await prune, 30_000);
    assert.equal(rows(store).length, 50_000);
    assert.ok(rows(store).every((key) => key.startsWith('current-')));
    assert.equal(store.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 1);
    assert.ok(events.filter((event) => event.type === 'batch').every((event) => event.autoCheckpoint === 0),
      'batch commits cannot trigger automatic checkpoints');
    const checkpoints = events.filter((event) => event.type === 'checkpoint');
    assert.ok(checkpoints.length > 1, 'the backlog is checkpointed periodically');
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(events[index].time - events[index - 1].time >= 20,
        'every batch and checkpoint gets a separate timer turn');
    }
    assert.equal(logs.length, 1);
    assert.equal(logs[0].count, 30_000);
    assert.ok(logs[0].elapsedMs > 0);
    t.diagnostic(`80,000 -> 50,000 rows; concurrent state ${readMs.toFixed(1)} ms wall / 5 ms fake clock; total test work ${(performance.now() - startedAt).toFixed(1)} ms`);
  } finally {
    await clock.advance(10_000);
    await service.stopUsageSnapshotRetention();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
      setTimeout: (callback, delay) => {
        assert.equal(delay, 25);
        yields += 1;
        callback();
      },
      logOtelQuarantinePrune: (count) => logs.push(count),
    });
    assert.equal(database.OTEL_QUARANTINE_RETENTION_DAYS, 7);
    assert.equal(database.OTEL_QUARANTINE_MAX_ROWS, 50_000);
    assert.equal(await service.pruneOtelQuarantine(), 1_206);
    assert.equal(yields, 108, '102 batch pauses, five checkpoint pauses, and a final checkpoint pause');
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
  const clock = new FakeClock();
  const logs = [];
  const service = new ModelDeckService(store, {
    demoFixtures: true,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logRequestUsagePrune: () => {},
    logOtelQuarantinePrune: (count) => logs.push(count),
  });
  try {
    store.saveSettings({ autoRefreshEnabled: false });
    seed(store, 1, '2026-09-04T23:59:59.999Z', 'expired');
    seed(store, 1, '2026-09-05T00:00:30.000Z', 'boundary');
    service.startUsageSnapshotRetention();
    service.startUsageSnapshotRetention();
    await clock.advance(30_025);
    assert.deepEqual(logs, [1]);
    assert.deepEqual(rows(store), ['boundary-0']);
    assert.equal(clock.timers.size, 1);
    const [timer] = clock.timers.values();
    assert.equal(timer.dueAt - clock.time, USAGE_SNAPSHOT_PRUNE_INTERVAL_MS);
    await clock.advance(USAGE_SNAPSHOT_PRUNE_INTERVAL_MS + 25);
    assert.deepEqual(logs, [1, 1]);
    assert.deepEqual(rows(store), []);
    assert.equal(clock.timers.size, 1);
    await service.stopUsageSnapshotRetention();
    assert.equal(clock.timers.size, 0);
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
    setTimeout: (callback) => { void yielded.then(callback); },
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

for (const failure of ['batch', 'checkpoint']) {
  test(`quarantine retention restores WAL autocheckpoint after a ${failure} failure`, async (t) => {
    const store = new database.Store(':memory:');
    const clock = new FakeClock();
    const logs = [];
    const service = scheduledService(store, clock, {
      logOtelQuarantinePrune: (count) => logs.push(count),
    });
    try {
      seed(store, 501, '2026-09-01T00:00:00.000Z');
      store.db.exec('PRAGMA wal_autocheckpoint = 37');
      const method = failure === 'batch' ? 'pruneOtelQuarantineBatch' : 'checkpointWal';
      const original = store[method].bind(store);
      let calls = 0;
      const mock = t.mock.method(store, method, (...args) => {
        if (++calls === (failure === 'batch' ? 2 : 1)) throw new Error('fixture prune failure');
        return original(...args);
      });
      const pruning = service.pruneOtelQuarantine();
      const rejected = assert.rejects(pruning, /fixture prune failure/);
      await clock.advance(100);
      await rejected;
      assert.equal(store.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 37);
      assert.equal(service.otelQuarantinePrunePromise, null);
      assert.deepEqual(logs, [], 'a failed pass is not logged as finished');
      mock.mock.restore();
      const retry = service.pruneOtelQuarantine();
      await clock.advance(100);
      await retry;
      assert.deepEqual(rows(store), []);
      assert.equal(logs.length, 1);
    } finally {
      await clock.advance(10_000);
      await service.stopUsageSnapshotRetention();
      store.close();
    }
  });
}

test('first-start prune is cancelled on shutdown before state or the deadline', async () => {
  const store = new database.Store(':memory:');
  const clock = new FakeClock();
  const service = scheduledService(store, clock);
  try {
    seed(store, 1, '2026-09-01T00:00:00.000Z');
    service.startUsageSnapshotRetention();
    await service.stopUsageSnapshotRetention();
    await service.state();
    await clock.advance(30_000);
    assert.equal(clock.timers.size, 0);
    assert.equal(rows(store).length, 1);
    service.startUsageSnapshotRetention();
    await clock.advance(30_025);
    assert.equal(rows(store).length, 0, 'retention can restart after cancellation');
  } finally {
    await service.stopUsageSnapshotRetention();
    store.close();
  }
});

test('first-start quarantine prune logs its row count and elapsed seconds once', async (t) => {
  const store = new database.Store(':memory:');
  const clock = new FakeClock();
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const service = scheduledService(store, clock, { logOtelQuarantinePrune: undefined });
  try {
    seed(store, 501, '2026-09-01T00:00:00.000Z');
    service.startUsageSnapshotRetention();
    await clock.advance(30_100);
    assert.deepEqual(lines, ['[modeldeck] OTLP quarantine pruned: 501 rows in 0.05 s']);
  } finally {
    await service.stopUsageSnapshotRetention();
    store.close();
  }
});
