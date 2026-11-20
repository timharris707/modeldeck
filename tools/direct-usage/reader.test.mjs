import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collect, readFolders, readEntryFolders, readingsFromLine, activityFromLine, KEEP_MS, MAX_READINGS,
} from './reader.mjs';

const READER = fileURLToPath(new URL('./reader.mjs', import.meta.url));
const NOW = Date.parse('2026-11-19T19:00:00.000Z');

// A saved T3 line, in the shape T3 wrote on 2026-11-19 (ids replaced).
function t3Line(at, entry, payload) {
  return `[${at}] NTIVE: ${JSON.stringify({
    provider: 'claudeAgent', protocol: 'claude-agent-sdk.query', kind: 'protocol',
    providerSessionId: `provider-session:provider-instance:${entry}:thread:mcp%3Aabc`,
    event: { direction: 'incoming', stage: 'decoded', payload },
  })}`;
}
const rateEvent = (utilization, extra = {}) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1795593600, rateLimitType: 'seven_day', isUsingOverage: false,
    unifiedWindows: { seven_day: { utilization, resetsAt: 1795593600, status: 'allowed' } },
    ...extra,
  },
  uuid: '00000000-0000-4000-8000-000000000001', session_id: '00000000-0000-4000-8000-000000000002',
});
const assistant = { type: 'assistant', message: { content: [] } };

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-direct-'));
  const accountsDir = path.join(home, '.claude-accounts');
  const t3 = path.join(home, '.t3', 'userdata');
  fs.mkdirSync(path.join(t3, 'logs', 'provider'), { recursive: true });
  for (const [name, uuid] of [['alpha', 'uuid-alpha'], ['beta', 'uuid-beta']]) {
    fs.mkdirSync(path.join(accountsDir, name), { recursive: true });
    fs.writeFileSync(path.join(accountsDir, name, '.claude.json'), JSON.stringify({
      oauthAccount: { accountUuid: uuid, emailAddress: `${name}@example.test`, planDisplayName: 'Ultra', organizationRateLimitTier: 'default_claude_max_20x' },
      mcpServers: { x: { env: { SECRET: 'not-for-output' } } },
    }));
  }
  fs.writeFileSync(path.join(t3, 'settings.json'), JSON.stringify({
    providerInstances: {
      'claude-alpha': { config: { homePath: path.join(accountsDir, 'alpha') } },
      'claude-beta': { config: {}, environment: [{ name: 'CLAUDE_CONFIG_DIR', value: path.join(accountsDir, 'beta') }] },
      'claude-pool': { config: { homePath: path.join(home, '.claude-pool') } },
    },
  }));
  const paths = {
    accountsDir,
    t3Settings: path.join(t3, 'settings.json'),
    t3Logs: path.join(t3, 'logs', 'provider'),
    cacheFile: path.join(home, '.cache', 'modeldeck', 'direct-usage', 'state.json'),
  };
  const log = (name, lines) => fs.appendFileSync(path.join(paths.t3Logs, name), `${lines.join('\n')}\n`);
  return { home, paths, log };
}

test('folders expose only the account uuid and plan, never the email or other settings', () => {
  const { paths } = fixture();
  const folders = readFolders(paths.accountsDir);
  assert.deepEqual(folders.map((f) => Object.keys(f).sort()), [
    ['accountUuid', 'folder', 'plan', 'rateLimitTier'], ['accountUuid', 'folder', 'plan', 'rateLimitTier'],
  ]);
  assert.doesNotMatch(JSON.stringify(folders), /example\.test|not-for-output/);
});

test('T3 entries map to folders directly under the accounts directory only', () => {
  const { paths } = fixture();
  const map = readEntryFolders(paths.t3Settings, paths.accountsDir);
  assert.deepEqual([...map], [['claude-alpha', 'alpha'], ['claude-beta', 'beta']]);
});

test('a rate-limit line becomes a weekly reading in percent with ISO times', () => {
  const map = new Map([['claude-alpha', 'alpha']]);
  const line = t3Line('2026-11-19T18:57:57.588Z', 'claude-alpha', rateEvent(0.86));
  assert.deepEqual(readingsFromLine(line, map), [{
    folder: 'alpha', accountUuid: null, entry: 'claude-alpha', source: 't3', scope: 'weekly', usedPercent: 86,
    resetsAt: '2026-11-25T08:00:00.000Z', status: 'allowed', observedAt: '2026-11-19T18:57:57.588Z',
  }]);
  // An unmapped entry (the retired pool) yields nothing; other lines are not readings.
  assert.deepEqual(readingsFromLine(t3Line('2026-11-19T18:57:57.588Z', 'claude-pool', rateEvent(0.5)), map), []);
  assert.equal(readingsFromLine(t3Line('2026-11-19T18:57:57.588Z', 'claude-alpha', assistant), map), null);
  assert.equal(readingsFromLine('not a log line "rate_limit_event"', map), null);
});

test('a five-hour window is read when Claude Code reports one, and the older top-level shape still works', () => {
  const map = new Map([['claude-alpha', 'alpha']]);
  const both = rateEvent(0.1, { unifiedWindows: {
    seven_day: { utilization: 0.1, resetsAt: 1795593600 }, five_hour: { utilization: 0.42, resetsAt: 1795500000 },
  } });
  assert.deepEqual(readingsFromLine(t3Line('2026-11-19T18:00:00.000Z', 'claude-alpha', both), map).map((r) => [r.scope, r.usedPercent]),
    [['weekly', 10], ['5-hour', 42]]);
  const old = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1794988800, rateLimitType: 'seven_day', utilization: 0.86 } };
  assert.deepEqual(readingsFromLine(t3Line('2026-11-17T23:00:49.234Z', 'claude-alpha', old), map).map((r) => [r.scope, r.usedPercent, r.status]),
    [['weekly', 86, 'allowed_warning']]);
});

test('collect reads only new bytes on the next run and keeps earlier readings', () => {
  const { paths, log } = fixture();
  log('events.a.log', [
    t3Line('2026-11-19T18:00:00.000Z', 'claude-alpha', assistant),
    t3Line('2026-11-19T18:00:01.000Z', 'claude-alpha', rateEvent(0.08)),
  ]);
  let out = collect({ paths, now: NOW });
  assert.deepEqual(out.readings.map((r) => r.usedPercent), [8]);
  const cache = JSON.parse(fs.readFileSync(paths.cacheFile, 'utf8'));
  assert.equal(cache.files['events.a.log'].offset, fs.statSync(path.join(paths.t3Logs, 'events.a.log')).size);
  assert.equal(fs.statSync(paths.cacheFile).mode & 0o777, 0o600);

  log('events.a.log', [t3Line('2026-11-19T18:30:00.000Z', 'claude-alpha', rateEvent(0.09))]);
  out = collect({ paths, now: NOW });
  assert.deepEqual(out.readings.map((r) => r.usedPercent), [8, 9]);
  // The log is pruned by T3: the reading survives in the cache.
  fs.rmSync(path.join(paths.t3Logs, 'events.a.log'));
  out = collect({ paths, now: NOW });
  assert.deepEqual(out.readings.map((r) => r.usedPercent), [8, 9]);
});

test('a half-written last line waits for its newline', () => {
  const { paths } = fixture();
  const file = path.join(paths.t3Logs, 'events.b.log');
  const line = t3Line('2026-11-19T18:00:01.000Z', 'claude-beta', rateEvent(0.2));
  fs.writeFileSync(file, line.slice(0, 40));
  assert.deepEqual(collect({ paths, now: NOW }).readings, []);
  fs.appendFileSync(file, `${line.slice(40)}\n`);
  assert.deepEqual(collect({ paths, now: NOW }).readings.map((r) => [r.folder, r.usedPercent]), [['beta', 20]]);
});

test('readings older than the keep window are dropped', () => {
  const { paths, log } = fixture();
  const old = new Date(NOW - KEEP_MS - 60_000).toISOString();
  log('events.c.log', [t3Line(old, 'claude-alpha', rateEvent(0.5)), t3Line('2026-11-19T18:00:00.000Z', 'claude-alpha', rateEvent(0.6))]);
  assert.deepEqual(collect({ paths, now: NOW }).readings.map((r) => r.usedPercent), [60]);
});

test('format warning: conversations reached Claude but none left a reading', () => {
  const { paths, log } = fixture();
  log('events.d.log', [t3Line('2026-11-19T18:00:00.000Z', 'claude-alpha', assistant)]);
  log('events.e.log', [t3Line('2026-11-19T18:10:00.000Z', 'claude-beta', assistant)]);
  let health = collect({ paths, now: NOW }).health;
  assert.equal(health.conversationsLastDay, 2);
  assert.equal(health.formatWarning, true);
  log('events.e.log', [t3Line('2026-11-19T18:10:01.000Z', 'claude-beta', rateEvent(0.1))]);
  health = collect({ paths, now: NOW }).health;
  assert.equal(health.formatWarning, false);
  assert.equal(health.withoutReadingLastDay, 1);
});

test('activity counts only assistant lines on mapped entries', () => {
  const map = new Map([['claude-alpha', 'alpha']]);
  assert.deepEqual(activityFromLine(t3Line('2026-11-19T18:00:00.000Z', 'claude-alpha', assistant), map),
    { at: Date.parse('2026-11-19T18:00:00.000Z'), folder: 'alpha' });
  assert.equal(activityFromLine(t3Line('2026-11-19T18:00:00.000Z', 'claude-pool', assistant), map), null);
});

test('no-cache mode writes nothing', () => {
  const { paths, log } = fixture();
  log('events.f.log', [t3Line('2026-11-19T18:00:01.000Z', 'claude-alpha', rateEvent(0.08))]);
  assert.equal(collect({ paths, now: NOW, useCache: false }).readings.length, 1);
  assert.equal(fs.existsSync(paths.cacheFile), false);
});

test('piped over stdin as the page does over SSH, it prints one JSON object', () => {
  const { home, paths, log } = fixture();
  log('events.g.log', [t3Line(new Date().toISOString(), 'claude-alpha', rateEvent(0.08))]);
  const run = spawnSync(process.execPath, ['--input-type=module'], {
    input: fs.readFileSync(READER),
    env: { PATH: process.env.PATH, HOME: home, MD_DIRECT_READER_MAIN: '1', MD_DIRECT_NO_CACHE: '1' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.folders.map((f) => f.folder), ['alpha', 'beta']);
  assert.deepEqual(out.readings.map((r) => [r.folder, r.usedPercent]), [['alpha', 8]]);
  assert.equal(fs.existsSync(paths.cacheFile), false);
});

// Tripwire for the safety contract (#834): the reader must never reach for a
// sign-in token or the network. A change that needs any of these is a design
// change, not a fix.
test('the reader never names a credential store or a network API', () => {
  const src = fs.readFileSync(READER, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of [/credentials/i, /keychain/i, /security\s/, /\bfetch\s*\(/, /node:https?/, /node:net/, /child_process/, /accessToken|refreshToken/]) {
    assert.doesNotMatch(src, banned, `reader.mjs must not use ${banned}`);
  }
});

// #834 review (CodeRabbit): an unreadable accounts folder is a failed read,
// not "no accounts", so the page keeps its last cards and warns.
test('an unreadable accounts folder fails the read; a missing one is just empty', { skip: process.getuid?.() === 0 ? 'root reads anything' : false }, () => {
  const { paths } = fixture();
  fs.chmodSync(paths.accountsDir, 0o000);
  try {
    assert.throws(() => collect({ paths, now: NOW, useCache: false }), /EACCES|EPERM/);
  } finally {
    fs.chmodSync(paths.accountsDir, 0o700);
  }
  fs.rmSync(paths.accountsDir, { recursive: true });
  assert.deepEqual(collect({ paths, now: NOW, useCache: false }).folders, []);
});

test('a folder signed in to another account drops the old account\'s readings', () => {
  const { paths, log } = fixture();
  log('events.h.log', [t3Line('2026-11-19T18:00:01.000Z', 'claude-alpha', rateEvent(0.4))]);
  assert.deepEqual(collect({ paths, now: NOW }).readings.map((r) => [r.folder, r.accountUuid]), [['alpha', 'uuid-alpha']]);
  const file = path.join(paths.accountsDir, 'alpha', '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-other', planDisplayName: 'Pro' } }));
  assert.deepEqual(collect({ paths, now: NOW }).readings, []);
  log('events.h.log', [t3Line('2026-11-19T18:30:00.000Z', 'claude-alpha', rateEvent(0.05))]);
  assert.deepEqual(collect({ paths, now: NOW }).readings.map((r) => [r.accountUuid, r.usedPercent]), [['uuid-other', 5]]);
});

test('the history cap never drops a quiet account\'s latest reading', () => {
  const { paths, log } = fixture();
  const lines = [t3Line('2026-11-18T00:00:00.000Z', 'claude-alpha', rateEvent(0.3))];
  for (let i = 0; i < MAX_READINGS; i++) {
    lines.push(t3Line(new Date(Date.parse('2026-11-18T01:00:00.000Z') + i * 1000).toISOString(), 'claude-beta', rateEvent((i % 100) / 100)));
  }
  log('events.i.log', lines);
  const out = collect({ paths, now: NOW });
  assert.ok(out.readings.some((r) => r.folder === 'alpha' && r.usedPercent === 30));
  assert.equal(out.readings.length, MAX_READINGS + 1);
});
