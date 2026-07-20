import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapacity, evaluateWorstCapacity } from '../src/capacity.mjs';

const now = Date.parse('2026-07-19T18:00:00.000Z');
const accounts = [{ id: 'main', label: 'LoanMeld main' }];

test('capacity guard distinguishes low, stale, healthy, and unknown snapshots', () => {
  let result = evaluateCapacity([], accounts, { now });
  assert.equal(result.status, 'unknown');

  result = evaluateCapacity([{ accountId: 'main', scope: 'Fable weekly', remainingPercent: 18, observedAt: '2026-07-19T17:58:00.000Z' }], accounts, { now, threshold: 25 });
  assert.equal(result.status, 'critical');
  assert.equal(result.low[0].accountLabel, 'LoanMeld main');

  result = evaluateCapacity([{ accountId: 'main', scope: 'weekly', remainingPercent: 80, observedAt: '2026-07-19T17:00:00.000Z' }], accounts, { now, maxAgeMinutes: 15 });
  assert.equal(result.status, 'stale');

  result = evaluateCapacity([{ accountId: 'main', scope: 'weekly', remainingPercent: 80, observedAt: '2026-07-19T17:58:00.000Z' }], accounts, { now });
  assert.equal(result.status, 'ok');
});

test('worst-capacity evaluation distinguishes warn, critical, ok, and unknown without zero-filling null usage', () => {
  const roster = [
    { id: 'first', label: 'First', provider: 'claude', enabled: true },
    { id: 'second', label: 'Second', provider: 'codex', enabled: true },
    { id: 'disabled', label: 'Disabled', provider: 'claude', enabled: false },
  ];
  const usage = [
    { accountId: 'first', scope: 'weekly', usedPercent: 70, remainingPercent: 30, resetsAt: null, observedAt: '2026-07-19T17:58:00.000Z' },
    { accountId: 'second', scope: '5-hour', usedPercent: 82, remainingPercent: 18, resetsAt: '2026-07-19T20:00:00.000Z', observedAt: '2026-07-19T17:59:00.000Z' },
    { accountId: 'first', scope: 'unknown', usedPercent: null, remainingPercent: null, resetsAt: null, observedAt: '2026-07-19T17:59:00.000Z' },
    { accountId: 'disabled', scope: 'weekly', usedPercent: 99, remainingPercent: 1, resetsAt: null, observedAt: '2026-07-19T17:59:00.000Z' },
  ];

  let result = evaluateWorstCapacity(usage, roster, { now, thresholdPercent: 25 });
  assert.equal(result.status, 'warn');
  assert.equal(result.iconState, 'gold');
  assert.equal(result.notify, true);
  assert.equal(result.worst.accountId, 'second');
  assert.equal(result.accountsEvaluated, 2);
  assert.equal(result.windowsEvaluated, 2);
  assert.deepEqual(result.excluded, [
    { accountId: 'first', scope: 'unknown', reason: 'usage unavailable' },
    { accountId: 'disabled', scope: 'weekly', reason: 'account disabled' },
  ]);

  result = evaluateWorstCapacity([{ ...usage[0], usedPercent: 91, remainingPercent: 9 }], roster, { now });
  assert.equal(result.status, 'critical');
  assert.equal(result.iconState, 'red');

  result = evaluateWorstCapacity([{ ...usage[0], usedPercent: 40, remainingPercent: 60 }], roster, { now });
  assert.equal(result.status, 'ok');
  assert.equal(result.iconState, 'plain');
  assert.equal(result.notify, false);

  result = evaluateWorstCapacity([{ ...usage[2] }], roster, { now });
  assert.equal(result.status, 'unknown');
  assert.equal(result.iconState, 'plain');
  assert.equal(result.worst, null);
  assert.equal(result.accountsEvaluated, 0);
});

// Issue #28: spend is deprioritized — it never drives worst-capacity
// (headline / icon severity), and only counts when nothing else exists.
test('spend never wins worst-capacity while any rate-limit scope exists', () => {
  const roster = [{ id: 'main', label: 'Main', provider: 'claude', enabled: true }];
  const usage = [
    { accountId: 'main', scope: 'spend', usedPercent: 100, remainingPercent: 0, resetsAt: null, observedAt: '2026-07-19T17:59:00.000Z' },
    { accountId: 'main', scope: '5-hour', usedPercent: 29, remainingPercent: 71, resetsAt: '2026-07-19T20:00:00.000Z', observedAt: '2026-07-19T17:59:00.000Z' },
    { accountId: 'main', scope: 'weekly', usedPercent: 50, remainingPercent: 50, resetsAt: '2026-07-25T20:00:00.000Z', observedAt: '2026-07-19T17:59:00.000Z' },
  ];

  const result = evaluateWorstCapacity(usage, roster, { now });
  // A 0%-left spend row must not headline critical while the rate-limit
  // windows are healthy.
  assert.equal(result.worst.scope, 'weekly');
  assert.equal(result.worst.remainingPercent, 50);
  assert.equal(result.status, 'ok');
  assert.equal(result.iconState, 'plain');
  assert.equal(result.notify, false);
  assert.equal(result.windowsEvaluated, 2);
  assert.deepEqual(result.excluded, [
    { accountId: 'main', scope: 'spend', reason: 'spend scope deprioritized' },
  ]);
});

test('worst-capacity falls back to spend when no other scope exists', () => {
  const roster = [{ id: 'main', label: 'Main', provider: 'claude', enabled: true }];
  const usage = [
    { accountId: 'main', scope: 'spend', usedPercent: 92, remainingPercent: 8, resetsAt: null, observedAt: '2026-07-19T17:59:00.000Z' },
  ];

  const result = evaluateWorstCapacity(usage, roster, { now });
  assert.equal(result.worst.scope, 'spend');
  assert.equal(result.status, 'critical');
  assert.deepEqual(result.excluded, []);
});

test('a rate-limit scope with unavailable usage still blocks the spend fallback', () => {
  // CodeRabbit (PR #29): weekly present but usage unknown + spend 0% must
  // yield "unknown", never a spend takeover of status/notifications.
  const roster = [{ id: 'main', label: 'Main', provider: 'claude', enabled: true }];
  const usage = [
    { accountId: 'main', scope: 'weekly', usedPercent: null, remainingPercent: null, resetsAt: null, observedAt: '2026-07-19T17:59:00.000Z' },
    { accountId: 'main', scope: 'spend', usedPercent: 100, remainingPercent: 0, resetsAt: null, observedAt: '2026-07-19T17:59:00.000Z' },
  ];

  const result = evaluateWorstCapacity(usage, roster, { now });
  assert.equal(result.worst, null);
  assert.equal(result.status, 'unknown');
  assert.equal(result.notify, false);
});
