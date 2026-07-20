import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResetTime } from '../public/usage-view.js';

test('formats reset timestamps with weekday, date, time, and timezone', () => {
  const formatted = formatResetTime('2026-07-25T03:29:38.000Z', 'en-US');
  assert.match(formatted, /Fri|Sat/);
  assert.match(formatted, /Jul 24|Jul 25/);
  assert.match(formatted, /\d{1,2}:29/);
  assert.match(formatted, /UTC|GMT|[A-Z]{2,5}/);
});
