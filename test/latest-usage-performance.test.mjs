import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/db.mjs';

test('store reserves a 64 MiB SQLite page cache for the large usage indexes', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.db.prepare('PRAGMA cache_size').get().cache_size, -65_536);
  } finally { store.close(); }
});

test('latestUsage reads 500000 snapshots across 47 pairs in bounded time with observation and id ordering', (t) => {
  const store = new Store(':memory:');
  try {
    const accounts = Array.from({ length: 7 }, (_, index) => store.saveAccount({
      provider: 'claude', label: `placeholder-${index}`, profileRef: `/tmp/placeholder-usage-${index}`,
    }));
    const scopes = ['', '5-hour', 'weekly', 'monthly', 'custom/a', 'with space', 'custom-weekly'];
    const pairs = Array.from({ length: 47 }, (_, index) => ({
      accountId: accounts[Math.floor(index / scopes.length)].id,
      scope: scopes[index % scopes.length],
    }));
    const insert = store.db.prepare(`
      INSERT INTO usage_snapshots(account_id, scope, used_percent, observed_at, source)
      VALUES (?, ?, ?, ?, 'performance-fixture')
    `);
    store.db.exec('BEGIN');
    try {
      for (let index = 0; index < 500_000; index += 1) {
        const pair = pairs[index % pairs.length];
        insert.run(pair.accountId, pair.scope, index % 100, '2026-09-01T00:00:00.000Z');
      }
      for (const pair of pairs) {
        insert.run(pair.accountId, pair.scope, 70, '2026-09-12T00:00:00.000Z');
        insert.run(pair.accountId, pair.scope, 71, '2026-09-12T00:00:00.000Z');
        insert.run(pair.accountId, pair.scope, 99, '2026-09-11T00:00:00.000Z');
      }
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }

    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const actual = store.latestUsage();
    const cpu = process.cpuUsage(cpuStarted);
    const elapsed = performance.now() - started;
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    t.diagnostic(`500000-row latestUsage: ${elapsed.toFixed(1)} ms elapsed, ${cpuMs.toFixed(1)} ms CPU`);
    assert.equal(actual.length, 47);
    const expected = pairs.map((pair) => ({
      ...pair,
      usedPercent: 71,
      remainingPercent: 29,
      resetsAt: null,
      observedAt: '2026-09-12T00:00:00.000Z',
      source: 'performance-fixture',
      stale: false,
      detail: {},
    })).sort((left, right) => {
      const a = `${left.accountId}\t${left.scope}`;
      const b = `${right.accountId}\t${right.scope}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    assert.deepEqual(actual, expected);
    assert.ok(elapsed < 750, `latestUsage took ${elapsed.toFixed(1)} ms; must stay well below 1 second`);
    // CPU time catches a warm full-index scan without mistaking other parallel
    // test files' scheduling delays for work performed by this query.
    assert.ok(cpuMs < 20, `latestUsage consumed ${cpuMs.toFixed(1)} ms CPU; history must not be scanned`);
  } finally { store.close(); }
});

test('latestUsage discovers arbitrary new pairs and reflects removals without stale cached rows', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.latestUsage(), []);
    const account = store.saveAccount({ provider: 'codex', label: 'placeholder', profileRef: '/tmp/placeholder-latest' });
    store.recordUsage(account.id, {
      scope: 'unknown-scope', source: 'fixture', observedAt: '2026-09-12T00:00:00.000Z',
      usedPercent: null, stale: true, detail: { placeholder: 'detail' },
    });
    assert.deepEqual(store.latestUsage(), [store.latestUsageRow(account.id, 'unknown-scope')]);
    store.recordUsage(account.id, { scope: '', source: 'fixture', usedPercent: 15 });
    assert.deepEqual(store.latestUsage().map((row) => row.scope), ['', 'unknown-scope']);
    store.db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
    assert.deepEqual(store.latestUsage(), []);
  } finally { store.close(); }
});
