import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.mjs';
import { weeklyResetFingerprint } from '../src/service.mjs';
import { evaluateWorstCapacity } from '../src/capacity.mjs';

// Issue #175 — honest idle rollforward is PRESENTATION-ONLY. The Swift app
// derives "window reset since last use" copy at render time from the latest
// STORED snapshots; the daemon side must never roll anything forward. These
// tests pin the boundary: stored rows pass through the daemon verbatim after
// their resetsAt passes, the weeklyResetFingerprint duplicate-token basis
// (#65/#108) stays keyed on the STORED weekly resetsAt, /api/capacity keeps
// evaluating stored percents, and no rollforward derivation or copy exists
// anywhere in src/.

const past = '2026-07-20T10:00:00.000Z'; // long past by the fixture clock
const observed = '2026-07-19T09:00:00.000Z';
const now = Date.parse('2026-07-23T18:00:00.000Z');

test('daemon serves stored snapshots verbatim after resetsAt passes — no server-side rollforward (#175)', () => {
  const store = new Store(':memory:');
  try {
    const account = store.saveAccount({ provider: 'claude', label: 'Idle Claude', profileRef: '/tmp/idle-claude' });
    store.recordUsage(account.id, {
      scope: '5-hour', usedPercent: 72, resetsAt: past, observedAt: observed, source: 'claude-cli',
    });
    store.recordUsage(account.id, {
      scope: 'weekly', usedPercent: 39, resetsAt: past, observedAt: observed, source: 'claude-cli',
    });
    const rows = store.latestUsage();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      // Stored values byte-for-byte: no derived percent, no advanced
      // observedAt, no rolled-forward resetsAt.
      assert.equal(row.resetsAt, past);
      assert.equal(row.observedAt, observed);
    }
    assert.equal(rows.find((r) => r.scope === '5-hour').usedPercent, 72);
    assert.equal(rows.find((r) => r.scope === 'weekly').usedPercent, 39);
  } finally { store.close(); }
});

test('weeklyResetFingerprint stays keyed on the STORED weekly resetsAt after the window closes (#65/#108)', () => {
  const snapshots = [
    { scope: 'weekly', resetsAt: past, stale: false },
    { scope: '5-hour', resetsAt: past, stale: false },
  ];
  // The fingerprint is a pure function of the stored resetsAt — presentation
  // time never enters, so an idle-rolled window cannot corrupt duplicate
  // detection: same stored row, same fingerprint, forever.
  assert.equal(weeklyResetFingerprint(snapshots), Math.round(Date.parse(past) / 1_000));
  assert.equal(weeklyResetFingerprint(snapshots), weeklyResetFingerprint(snapshots));
});

test('capacity evaluation keeps consuming stored percents for past-reset windows (#175)', () => {
  const roster = [{ id: 'a1', label: 'Idle Claude', provider: 'claude', enabled: true }];
  const usage = [
    { accountId: 'a1', scope: 'weekly', usedPercent: 82, remainingPercent: 18, resetsAt: past, observedAt: observed },
  ];
  const result = evaluateWorstCapacity(usage, roster, { now, thresholdPercent: 25 });
  // The stored 18% left still drives the evaluation — the daemon neither
  // fabricates a fresh window nor drops the row because its reset passed.
  assert.equal(result.worst.remainingPercent, 18);
  assert.equal(result.status, 'warn');
});

test('the rollforward copy and derivation live ONLY in the presentation layer — never in src/ (#175)', () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  walk(srcDir);
  assert.ok(files.length > 5, 'expected to scan the daemon source tree');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // The pinned #175 row copy must never appear daemon-side: if a derived
    // row ever headed for recordUsage, this is the tripwire.
    assert.ok(!source.includes('reset since last use'),
      `${file} carries #175 rollforward copy — derivation must stay app-side presentation`);
    assert.ok(!/rollforward/i.test(source),
      `${file} mentions rollforward — derivation must stay app-side presentation`);
  }
});
