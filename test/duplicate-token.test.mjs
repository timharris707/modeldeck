import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateClaudeTokenAccountIds } from '../src/service.mjs';

const weekly = (resetsAt, extra = {}) => ({ scope: 'weekly', resetsAt, ...extra });
const detect = (rows) => [...duplicateClaudeTokenAccountIds(new Map(rows))].sort();

test('duplicate-token detection flags a matching pair', () => {
  assert.deepEqual(detect([
    ['profile-a', [weekly('2026-07-25T20:00:00.000Z')]],
    ['profile-b', [weekly('2026-07-25T20:00:00.000Z')]],
  ]), ['profile-a', 'profile-b']);
});

test('duplicate-token detection flags every account in a matching triple', () => {
  assert.deepEqual(detect([
    ['profile-a', [weekly('2026-07-25T20:00:00.000Z')]],
    ['profile-b', [weekly('2026-07-25T20:00:00.000Z')]],
    ['profile-c', [weekly('2026-07-25T20:00:00.000Z')]],
  ]), ['profile-a', 'profile-b', 'profile-c']);
});

test('duplicate-token detection rounds away sub-second jitter', () => {
  assert.deepEqual(detect([
    ['profile-a', [weekly('2026-07-25T20:00:00.100Z')]],
    ['profile-b', [weekly('2026-07-25T20:00:00.400Z')]],
  ]), ['profile-a', 'profile-b']);
});

test('duplicate-token detection ignores missing, invalid, stale, and non-overall weekly data', () => {
  assert.deepEqual(detect([
    ['profile-a', [weekly(null)]],
    ['profile-b', [weekly('not-a-date')]],
    ['profile-c', [weekly('2026-07-25T20:00:00.000Z', { stale: true })]],
    ['profile-d', [{ scope: 'Fable weekly', resetsAt: '2026-07-25T20:00:00.000Z' }]],
  ]), []);
});
