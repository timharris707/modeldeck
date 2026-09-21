import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  OTEL_HISTORY_PRUNE_BATCH_SIZE,
  OTEL_HISTORY_RETENTION_DAYS,
  SQLITE_OPEN_BUSY_TIMEOUT_MS,
  SQLITE_RECLAIM_PAGES_PER_PASS,
  SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
  Store,
} from '../src/db.mjs';
import { ModelDeckService, USAGE_SNAPSHOT_PRUNE_INTERVAL_MS } from '../src/service.mjs';

// Issue #701: otel_metrics and otel_events had no retention (382k rows in five
// weeks on one machine) and every prune left its freed pages in the file
// (1.8 GB of a 2.9 GB file). Retention is bounded by the receipts arc's
// 13-month rule; freed pages are handed back incrementally.

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-09-20T00:00:00.000Z');
const CUTOFF = new Date(NOW - OTEL_HISTORY_RETENTION_DAYS * DAY_MS).toISOString();

const NULL_DIMENSIONS = Object.freeze({
  model: null, effort: null, speed: null, querySource: null, agentName: null, skillName: null,
  sessionId: null, accountUuid: null, organizationId: null, tokenType: null,
});

function metric(ingestKey, observedAt) {
  return { ingestKey, metricName: 'claude_code.token.usage', observedAt, value: 1, details: {}, ...NULL_DIMENSIONS };
}

function event(ingestKey, observedAt, details = {}) {
  return {
    ingestKey, eventName: 'api_request', observedAt, details, ...NULL_DIMENSIONS,
    requestId: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
  };
}

function keys(store, table) {
  return store.db.prepare(`SELECT ingest_key FROM ${table} ORDER BY observed_at, id`).all()
    .map((row) => row.ingest_key);
}

class FakeClock {
  time = NOW;
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

test('TRIPWIRE #701: OTLP history retention is 13 months, matching the receipts rule', () => {
  assert.equal(OTEL_HISTORY_RETENTION_DAYS, 400);
});

test('TRIPWIRE #701: the batch prune deletes only rows strictly older than the cutoff, per table', () => {
  const store = new Store(':memory:');
  try {
    const expired = new Date(Date.parse(CUTOFF) - 1).toISOString();
    const future = new Date(NOW + DAY_MS).toISOString();
    store.ingestOtelMetrics([metric('m-expired', expired), metric('m-boundary', CUTOFF), metric('m-future', future)]);
    store.ingestOtelEvents([event('e-expired', expired), event('e-boundary', CUTOFF), event('e-now', new Date(NOW).toISOString())]);
    assert.equal(store.pruneOtelHistoryBatch('otel_metrics', { cutoff: CUTOFF }), 1);
    assert.deepEqual(keys(store, 'otel_metrics'), ['m-boundary', 'm-future']);
    assert.deepEqual(keys(store, 'otel_events'), ['e-expired', 'e-boundary', 'e-now'], 'the metrics prune must not touch events');
    assert.equal(store.pruneOtelHistoryBatch('otel_events', { cutoff: CUTOFF }), 1);
    assert.deepEqual(keys(store, 'otel_events'), ['e-boundary', 'e-now']);
    assert.equal(store.pruneOtelHistoryBatch('otel_metrics', { cutoff: CUTOFF }), 0, 'idempotent');
  } finally {
    store.close();
  }
});

test('the batch prune refuses other tables, non-canonical cutoffs, and oversize batches', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.pruneOtelHistoryBatch('otel_quarantine', { cutoff: CUTOFF }), /otel_metrics or otel_events/);
    assert.throws(() => store.pruneOtelHistoryBatch('otel_metrics', { cutoff: '2026-09-20' }), /canonical ISO/);
    assert.throws(() => store.pruneOtelHistoryBatch('otel_metrics', { cutoff: CUTOFF, batchSize: OTEL_HISTORY_PRUNE_BATCH_SIZE + 1 }), /batchSize/);
  } finally {
    store.close();
  }
});

test('the service drains a backlog larger than one batch and yields between batches', async () => {
  const store = new Store(':memory:');
  const expired = new Date(Date.parse(CUTOFF) - 1).toISOString();
  store.ingestOtelMetrics(Array.from({ length: OTEL_HISTORY_PRUNE_BATCH_SIZE + 3 }, (_, i) => metric(`m-${i}`, expired)));
  store.ingestOtelMetrics([metric('m-keep', CUTOFF)]);
  store.ingestOtelEvents([event('e-old', expired), event('e-keep', CUTOFF)]);
  let yields = 0;
  const logs = [];
  const service = new ModelDeckService(store, {
    demoFixtures: true,
    now: () => NOW,
    yieldToServeLoop: async () => { yields += 1; },
    logOtelHistoryPrune: (counts) => logs.push(counts),
  });
  try {
    const counts = await service.pruneOtelHistory();
    assert.deepEqual(counts, { otel_metrics: OTEL_HISTORY_PRUNE_BATCH_SIZE + 3, otel_events: 1 });
    assert.deepEqual(logs, [counts]);
    assert.equal(yields, 1, 'one full batch, one yield, then the short tail');
    assert.deepEqual(keys(store, 'otel_metrics'), ['m-keep']);
    assert.deepEqual(keys(store, 'otel_events'), ['e-keep']);
  } finally {
    store.close();
  }
});

test('TRIPWIRE #701: the daily retention schedule prunes OTLP history and then reclaims free pages', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-retention-'));
  const store = new Store(path.join(directory, 'state.sqlite'));
  const expired = new Date(Date.parse(CUTOFF) - 1).toISOString();
  store.ingestOtelEvents([event('scheduled-expired', expired), event('scheduled-current', new Date(NOW).toISOString())]);
  const clock = new FakeClock();
  const pruneLogs = [];
  const reclaimLogs = [];
  const service = new ModelDeckService(store, {
    demoFixtures: true,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logUsageSnapshotPrune: () => {},
    logRequestUsagePrune: () => {},
    logOtelQuarantinePrune: () => {},
    logOtelHistoryPrune: (counts) => pruneLogs.push(counts),
    logFreePageReclaim: (passes, remaining) => reclaimLogs.push({ passes, remaining }),
  });
  try {
    service.startUsageSnapshotRetention();
    await clock.advance(30_000);
    await clock.advance(100);
    assert.deepEqual(pruneLogs, [{ otel_metrics: 0, otel_events: 1 }]);
    assert.deepEqual(keys(store, 'otel_events'), ['scheduled-current']);
    assert.equal(reclaimLogs.length, 1, 'the reclaim runs once, after the prunes');
    assert.equal(reclaimLogs[0].remaining, 0);
    store.ingestOtelEvents([event('next-day-expired', expired)]);
    await clock.advance(USAGE_SNAPSHOT_PRUNE_INTERVAL_MS);
    assert.deepEqual(pruneLogs, [{ otel_metrics: 0, otel_events: 1 }, { otel_metrics: 0, otel_events: 1 }]);
    assert.deepEqual(keys(store, 'otel_events'), ['scheduled-current']);
  } finally {
    await service.stopUsageSnapshotRetention();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('TRIPWIRE #701: a file store is converted to incremental auto_vacuum once, and freed pages come back in bounded passes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-vacuum-'));
  const file = path.join(directory, 'state.sqlite');
  try {
    // A pre-#701 file made outside the Store: default (no) auto_vacuum,
    // real rows, then a bulk delete so it carries free pages (Astra review
    // of PR #702: the earlier fixture was already converted before it held
    // any free space, so a conversion that skipped non-empty files passed).
    const legacy = new DatabaseSync(file);
    legacy.exec('PRAGMA journal_mode = WAL; CREATE TABLE filler(id INTEGER PRIMARY KEY, pad TEXT)');
    const fill = legacy.prepare('INSERT INTO filler(pad) VALUES (?)');
    legacy.exec('BEGIN');
    for (let i = 0; i < 20_000; i += 1) fill.run('x'.repeat(200));
    legacy.exec('COMMIT; DELETE FROM filler; PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(legacy.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 0);
    const legacyFree = legacy.prepare('PRAGMA freelist_count').get().freelist_count;
    assert.ok(legacyFree > 0, 'the legacy file must carry free pages');
    legacy.close();

    const converted = new Store(file);
    assert.equal(converted.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2, 'TRIPWIRE #701: the legacy file was not converted on open');
    assert.equal(converted.db.prepare('PRAGMA freelist_count').get().freelist_count, 0, 'conversion collapses the free space it found');
    assert.equal(converted.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(converted.migrateAutoVacuum(), false, 'a second open is a no-op');
    converted.close();

    const store = new Store(file);
    const pageSize = store.db.prepare('PRAGMA page_size').get().page_size;
    const bulk = new Date(NOW).toISOString();
    store.ingestOtelEvents(Array.from({ length: 40_000 }, (_, i) => event(`bulk-${i}`, bulk, { pad: 'x'.repeat(200) })));
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const fullSize = fs.statSync(file).size;
    store.db.exec('DELETE FROM otel_events');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const freeBefore = store.db.prepare('PRAGMA freelist_count').get().freelist_count;
    assert.ok(freeBefore > SQLITE_RECLAIM_PAGES_PER_PASS, `expected a large freelist, got ${freeBefore}`);

    const remaining = store.reclaimFreePages();
    const reclaimed = freeBefore - remaining;
    assert.ok(remaining > 0, 'one pass must not drain a freelist larger than its budget');
    assert.ok(reclaimed > 0 && reclaimed <= SQLITE_RECLAIM_PAGES_PER_PASS,
      `TRIPWIRE #701: one pass reclaims at most ${SQLITE_RECLAIM_PAGES_PER_PASS} pages, got ${reclaimed}`);
    while (store.reclaimFreePages() > 0) { /* drain */ }
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const finalSize = fs.statSync(file).size;
    assert.ok(finalSize < fullSize / 4, `file did not shrink: ${fullSize} -> ${finalSize} (page ${pageSize})`);
    assert.equal(store.db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
    store.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('TRIPWIRE #701: shutdown during a scheduled prune waits for the run to settle and nothing touches the store afterwards', async () => {
  // Astra review of PR #702: the reclaim is created by the schedule
  // continuation AFTER the prunes, so a shutdown snapshot of the individual
  // prune promises missed it and the Store could be closed under it. Now
  // stop awaits the whole scheduled run; a stop that lands mid-prune also
  // skips the reclaim (it is tomorrow's work, not shutdown's).
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-stop-'));
  const store = new Store(path.join(directory, 'state.sqlite'));
  const expired = new Date(Date.parse(CUTOFF) - 1).toISOString();
  store.ingestOtelEvents(Array.from({ length: OTEL_HISTORY_PRUNE_BATCH_SIZE + 1 }, (_, i) => event(`old-${i}`, expired, { pad: 'x'.repeat(300) })));
  const clock = new FakeClock();
  let releasePrune;
  const pruneGate = new Promise((resolve) => { releasePrune = resolve; });
  let yields = 0;
  const storeCalls = [];
  const service = new ModelDeckService(store, {
    demoFixtures: true,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // The first yield (between the prune's two batches) parks until the test
    // has started shutdown; later yields pass.
    yieldToServeLoop: async () => { yields += 1; if (yields === 1) await pruneGate; },
    logUsageSnapshotPrune: () => {},
    logRequestUsagePrune: () => {},
    logOtelQuarantinePrune: () => {},
    logOtelHistoryPrune: () => {},
    logFreePageReclaim: () => {},
  });
  for (const name of ['reclaimFreePages', 'pruneOtelHistoryBatch']) {
    const original = store[name].bind(store);
    store[name] = (...args) => { storeCalls.push(name); return original(...args); };
  }
  try {
    service.startUsageSnapshotRetention();
    await clock.advance(30_100);
    assert.equal(yields, 1, 'the prune is parked between batches');
    // otel_metrics found nothing (one short batch); otel_events filled a batch and parked.
    assert.deepEqual(storeCalls, ['pruneOtelHistoryBatch', 'pruneOtelHistoryBatch']);
    let stopped = false;
    const stopping = service.stopUsageSnapshotRetention().then(() => { stopped = true; });
    await clock.flush();
    assert.equal(stopped, false, 'TRIPWIRE #701: stop returned while the scheduled run was still parked');
    releasePrune();
    await stopping;
    const callsAtStop = storeCalls.slice();
    assert.deepEqual(callsAtStop, ['pruneOtelHistoryBatch', 'pruneOtelHistoryBatch', 'pruneOtelHistoryBatch'], 'the parked prune finished its tail; the reclaim was skipped');
    // The Store is only closed after stop resolves; nothing may run against it later.
    store.close();
    await clock.advance(USAGE_SNAPSHOT_PRUNE_INTERVAL_MS);
    assert.deepEqual(storeCalls, callsAtStop, 'TRIPWIRE #701: something touched the closed store after stop');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('TRIPWIRE #701: shutdown during the reclaim itself waits for the current pass and leaves the rest', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-otel-stop-reclaim-'));
  const store = new Store(path.join(directory, 'state.sqlite'));
  store.ingestOtelEvents(Array.from({ length: 40_000 }, (_, i) => event(`bulk-${i}`, new Date(NOW).toISOString(), { pad: 'x'.repeat(200) })));
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.db.exec('DELETE FROM otel_events');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const freeAtStart = store.db.prepare('PRAGMA freelist_count').get().freelist_count;
  assert.ok(freeAtStart > SQLITE_RECLAIM_PAGES_PER_PASS, `needs several reclaim passes, freelist ${freeAtStart}`);
  const clock = new FakeClock();
  let releaseReclaim;
  const reclaimGate = new Promise((resolve) => { releaseReclaim = resolve; });
  let passes = 0;
  const service = new ModelDeckService(store, {
    demoFixtures: true,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // The prunes find nothing and never yield; the first yield is the reclaim's.
    yieldToServeLoop: async () => { if (passes === 1) await reclaimGate; },
    logUsageSnapshotPrune: () => {},
    logRequestUsagePrune: () => {},
    logOtelQuarantinePrune: () => {},
    logOtelHistoryPrune: () => {},
    logFreePageReclaim: () => {},
  });
  const reclaim = store.reclaimFreePages.bind(store);
  store.reclaimFreePages = (pages) => { passes += 1; return reclaim(pages); };
  try {
    service.startUsageSnapshotRetention();
    await clock.advance(30_100);
    assert.equal(passes, 1, 'the reclaim is parked after its first pass');
    let stopped = false;
    const stopping = service.stopUsageSnapshotRetention().then(() => { stopped = true; });
    await clock.flush();
    assert.equal(stopped, false, 'TRIPWIRE #701: stop returned while the reclaim was parked');
    releaseReclaim();
    await stopping;
    assert.equal(passes, 1, 'the reclaim stops at the pass it was in; the rest waits for the next scheduled run');
    assert.ok(store.db.prepare('PRAGMA freelist_count').get().freelist_count > 0, 'free pages remain for tomorrow');
    store.close();
    await clock.advance(USAGE_SNAPSHOT_PRUNE_INTERVAL_MS);
    assert.equal(passes, 1, 'TRIPWIRE #701: the reclaim touched the closed store after stop');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('TRIPWIRE #701: the long open-time lock wait is not left on the serving connection', () => {
  // Astra round 2 on PR #702: the 30 s wait exists so a second opener sits
  // out the one-time conversion; left in place it would let a stray writer
  // freeze the serve loop for half a minute per blocked statement.
  assert.equal(SQLITE_OPEN_BUSY_TIMEOUT_MS, 30_000);
  assert.equal(SQLITE_RUNTIME_BUSY_TIMEOUT_MS, 5_000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-busy-'));
  try {
    const store = new Store(path.join(directory, 'state.sqlite'));
    assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
      'TRIPWIRE #701: the open-time busy_timeout survived construction');
    store.close();
    const memory = new Store(':memory:');
    assert.equal(memory.db.prepare('PRAGMA busy_timeout').get().timeout, SQLITE_RUNTIME_BUSY_TIMEOUT_MS);
    memory.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a one-pass reclaim reports one pass, and an empty freelist reports none', async () => {
  // Astra round 2 on PR #702: the final pass was not counted.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-reclaim-count-'));
  const store = new Store(path.join(directory, 'state.sqlite'));
  const logs = [];
  const service = new ModelDeckService(store, {
    demoFixtures: true,
    now: () => NOW,
    yieldToServeLoop: async () => {},
    logFreePageReclaim: (passes, remaining) => logs.push({ passes, remaining }),
  });
  try {
    assert.equal(await service.reclaimFreePages(), 0);
    assert.deepEqual(logs, [{ passes: 0, remaining: 0 }]);
    store.ingestOtelEvents(Array.from({ length: 300 }, (_, i) => event(`few-${i}`, new Date(NOW).toISOString(), { pad: 'x'.repeat(200) })));
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); DELETE FROM otel_events; PRAGMA wal_checkpoint(TRUNCATE)');
    const free = store.freePageCount();
    assert.ok(free > 0 && free <= SQLITE_RECLAIM_PAGES_PER_PASS, `one pass worth of free pages, got ${free}`);
    assert.equal(await service.reclaimFreePages(), 1);
    assert.deepEqual(logs.at(-1), { passes: 1, remaining: 0 });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an in-memory store is never converted (reclaim is a no-op there)', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 0);
    assert.equal(store.reclaimFreePages(), 0);
  } finally {
    store.close();
  }
});
