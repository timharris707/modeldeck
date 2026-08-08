import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Store,
  USAGE_SNAPSHOT_PRUNE_BATCH_SIZE,
  USAGE_SNAPSHOT_RETENTION_DAYS,
} from '../src/db.mjs';
import {
  ModelDeckService,
  USAGE_SNAPSHOT_PRUNE_INTERVAL_MS,
  weeklyResetFingerprint,
} from '../src/service.mjs';

function account(store, id = 'account-a') {
  return store.saveAccount({
    provider: 'claude',
    label: id,
    profileRef: `/tmp/modeldeck-retention-${id}`,
  });
}

function snapshot(store, accountId, scope, observedAt, usedPercent, resetsAt = null) {
  store.recordUsage(accountId, {
    scope,
    observedAt,
    usedPercent,
    resetsAt,
    source: 'retention-fixture',
  });
}

function rawSnapshots(store) {
  return store.db.prepare(`
    SELECT account_id, scope, used_percent, resets_at, observed_at
    FROM usage_snapshots
    ORDER BY account_id, scope, observed_at, id
  `).all();
}

test('retention preserves the newest rows consumed by statusline guards and delta current state', () => {
  const store = new Store(':memory:');
  try {
    const first = account(store, 'account-a');
    const second = account(store, 'account-b');

    snapshot(store, first.id, 'weekly', '2025-01-01T00:00:00.000Z', 10, '2025-01-08T00:00:00.000Z');
    snapshot(store, first.id, 'weekly', '2025-02-01T00:00:00.000Z', 20, '2025-02-08T00:00:00.000Z');
    snapshot(store, first.id, '5-hour', '2025-03-01T00:00:00.000Z', 30); // sole ancient row
    snapshot(store, first.id, 'tie', '2025-04-01T00:00:00.000Z', 40);
    snapshot(store, first.id, 'tie', '2025-04-01T00:00:00.000Z', 41); // id breaks tie
    // Insert out of observation order: retention follows observed_at, not id.
    snapshot(store, second.id, 'weekly', '2026-07-02T00:00:00.000Z', 70);
    snapshot(store, second.id, 'weekly', '2025-01-01T00:00:00.000Z', 50);
    snapshot(store, second.id, 'weekly', '2026-07-01T00:00:00.000Z', 60);

    assert.equal(store.pruneUsageSnapshotsBatch({
      cutoff: '2026-05-03T00:00:00.000Z',
    }), 3);

    // Statusline idempotency asks latestUsageRow before every insert.
    assert.equal(store.latestUsageRow(first.id, 'tie').usedPercent, 41);
    // /api/state exposes latestUsage only; the app keeps its own previous-open
    // baseline for delta rendering, so its current side remains intact here.
    const current = store.state().usage.filter((row) => row.accountId === first.id);
    assert.equal(current.find((row) => row.scope === 'weekly').usedPercent, 20);
    // The pure fingerprint value of that latest row remains intact too. The
    // live duplicate detector's fresh-probe evidence is covered separately.
    assert.equal(
      weeklyResetFingerprint(current),
      Math.round(Date.parse('2025-02-08T00:00:00.000Z') / 1_000),
    );

    const labels = new Map([[first.id, 'account-a'], [second.id, 'account-b']]);
    assert.deepEqual(rawSnapshots(store)
      .map((row) => [labels.get(row.account_id), row.scope, row.used_percent])
      .sort((left, right) => left[0].localeCompare(right[0])
        || left[1].localeCompare(right[1]) || left[2] - right[2]), [
      ['account-a', '5-hour', 30],
      ['account-a', 'tie', 41],
      ['account-a', 'weekly', 20],
      ['account-b', 'weekly', 60],
      ['account-b', 'weekly', 70],
    ]);
  } finally { store.close(); }
});

test('pruning database history leaves fresh-probe duplicate fingerprint evidence intact', () => {
  const store = new Store(':memory:');
  try {
    const first = account(store, 'fingerprint-a');
    const second = account(store, 'fingerprint-b');
    const reset = '2026-08-08T00:00:00.000Z';
    const service = new ModelDeckService(store);
    service.updateClaudeWeeklyFingerprints([first, second], new Map([
      [first.id, [{ scope: 'weekly', resetsAt: reset, stale: false }]],
      [second.id, [{ scope: 'weekly', resetsAt: reset, stale: false }]],
    ]));
    assert.deepEqual([...service.duplicateClaudeTokenAccountIds].sort(), [first.id, second.id].sort());

    for (const saved of [first, second]) {
      snapshot(store, saved.id, 'weekly', '2025-01-01T00:00:00.000Z', 10);
      snapshot(store, saved.id, 'weekly', '2025-02-01T00:00:00.000Z', 20);
    }
    assert.equal(store.pruneUsageSnapshotsBatch({
      cutoff: '2026-05-03T00:00:00.000Z',
    }), 2);
    // Fingerprints are fresh provider evidence held in service memory; the DB
    // has no older-row fallback and retention cannot erase the live evidence.
    assert.deepEqual([...service.duplicateClaudeTokenAccountIds].sort(), [first.id, second.id].sort());
    assert.equal(service.claudeWeeklyFingerprints.size, 2);
  } finally { store.close(); }
});

test('retention removes only rows strictly older than the policy cutoff', () => {
  const store = new Store(':memory:');
  try {
    const saved = account(store);
    snapshot(store, saved.id, 'weekly', '2026-05-02T23:59:59.999Z', 10);
    snapshot(store, saved.id, 'weekly', '2026-05-03T00:00:00.000Z', 20);
    snapshot(store, saved.id, 'weekly', '2026-07-01T00:00:00.000Z', 30);

    assert.throws(() => store.pruneUsageSnapshotsBatch({
      cutoff: 'May 3, 2026',
    }), /canonical ISO timestamp/);
    assert.equal(store.pruneUsageSnapshotsBatch({
      cutoff: '2026-05-03T00:00:00.000Z',
    }), 1);
    assert.deepEqual(rawSnapshots(store).map((row) => row.observed_at), [
      '2026-05-03T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
  } finally { store.close(); }
});

test('expired candidate discovery range-searches both retention indexes', () => {
  const store = new Store(':memory:');
  try {
    const plan = store.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT old.id
      FROM usage_snapshots AS old INDEXED BY usage_observed
      WHERE old.observed_at < ?
        AND EXISTS (
          SELECT 1
          FROM usage_snapshots AS newer INDEXED BY usage_account_scope_observed
          WHERE newer.account_id = old.account_id
            AND newer.scope = old.scope
            AND (newer.observed_at, newer.id) > (old.observed_at, old.id)
        )
      ORDER BY old.observed_at, old.id
      LIMIT ?
    `).all('2026-05-03T00:00:00.000Z', USAGE_SNAPSHOT_PRUNE_BATCH_SIZE);

    const oldSearch = plan.find((row) => row.detail.startsWith('SEARCH old '));
    const newerSearch = plan.find((row) => row.detail.startsWith('SEARCH newer '));
    assert.match(oldSearch?.detail || '', /^SEARCH old USING (?:COVERING )?INDEX usage_observed \(observed_at<\?\)/);
    assert.match(newerSearch?.detail || '', /^SEARCH newer .*INDEX usage_account_scope_observed /);
  } finally { store.close(); }
});

test('a large backlog drains in bounded batches and yields to the serve loop', async () => {
  const store = new Store(':memory:');
  const saved = account(store);
  const base = Date.parse('2025-01-01T00:00:00.000Z');
  for (let index = 0; index < 1_206; index += 1) {
    snapshot(store, saved.id, 'weekly', new Date(base + index * 1_000).toISOString(), index);
  }

  let passes = 0;
  let yields = 0;
  const originalBatch = store.pruneUsageSnapshotsBatch.bind(store);
  store.pruneUsageSnapshotsBatch = (options) => {
    passes += 1;
    const count = originalBatch(options);
    assert.ok(count <= USAGE_SNAPSHOT_PRUNE_BATCH_SIZE);
    return count;
  };
  const logs = [];
  const service = new ModelDeckService(store, {
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    yieldToServeLoop: async () => { yields += 1; },
    logUsageSnapshotPrune: (count) => logs.push(count),
  });
  try {
    assert.equal(USAGE_SNAPSHOT_RETENTION_DAYS, 90);
    assert.equal(await service.pruneUsageSnapshots(), 1_205);
    assert.equal(passes, 3);
    assert.equal(yields, 2);
    assert.deepEqual(logs, [1_205]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_snapshots').get().count, 1);
    assert.equal(store.latestUsage()[0].usedPercent, 1_205);
  } finally { store.close(); }
});

test('a newer observation inserted between prune batches becomes the protected row', async () => {
  const store = new Store(':memory:');
  const saved = account(store);
  const base = Date.parse('2025-01-01T00:00:00.000Z');
  for (let index = 0; index < USAGE_SNAPSHOT_PRUNE_BATCH_SIZE + 2; index += 1) {
    snapshot(store, saved.id, 'weekly', new Date(base + index * 1_000).toISOString(), index);
  }

  let yields = 0;
  const service = new ModelDeckService(store, {
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    yieldToServeLoop: async () => {
      yields += 1;
      snapshot(store, saved.id, 'weekly', '2026-07-31T23:59:00.000Z', 77);
    },
    logUsageSnapshotPrune: () => {},
  });
  try {
    assert.equal(await service.pruneUsageSnapshots(), USAGE_SNAPSHOT_PRUNE_BATCH_SIZE + 2);
    assert.equal(yields, 1);
    assert.deepEqual(rawSnapshots(store).map((row) => [row.observed_at, row.used_percent]), [
      ['2026-07-31T23:59:00.000Z', 77],
    ]);
  } finally { store.close(); }
});

test('retention prunes on startup and schedules one pass every 24 hours', async () => {
  class FakeClock {
    time = Date.parse('2026-08-01T00:00:00.000Z');
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

  const store = new Store(':memory:');
  const saved = account(store, 'scheduled-account');
  snapshot(store, saved.id, 'weekly', '2025-01-01T00:00:00.000Z', 10);
  snapshot(store, saved.id, 'weekly', '2025-02-01T00:00:00.000Z', 20);
  const clock = new FakeClock();
  const logs = [];
  const service = new ModelDeckService(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logUsageSnapshotPrune: (count) => logs.push(count),
  });
  try {
    service.startUsageSnapshotRetention();
    service.startUsageSnapshotRetention(); // lifecycle start is idempotent
    await clock.flush();
    assert.deepEqual(logs, [1]);
    assert.equal(rawSnapshots(store).length, 1);
    assert.equal(clock.timers.size, 1);

    // A newer-but-still-expired row makes the startup survivor eligible for
    // the next scheduled pass; this proves the periodic path deletes too.
    snapshot(store, saved.id, 'weekly', '2025-03-01T00:00:00.000Z', 30);
    await clock.advance(USAGE_SNAPSHOT_PRUNE_INTERVAL_MS - 1);
    assert.deepEqual(logs, [1]);
    await clock.advance(1);
    assert.deepEqual(logs, [1, 1]);
    assert.deepEqual(rawSnapshots(store).map((row) => row.used_percent), [30]);
    assert.equal(clock.timers.size, 1);

    await service.stopUsageSnapshotRetention();
    assert.equal(clock.timers.size, 0);
  } finally { store.close(); }
});
