import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  buildStatuslineCommand,
  chainCommandFromStatuslineCommand,
  execPathFromStatuslineCommand,
  isModelDeckStatuslineCommand,
  parseStatuslineRateLimits,
  runStatuslineCli,
  statuslineSnapshotsFromCapture,
  STATUSLINE_SEA_COMMAND,
} from '../src/adapters/claude-statusline.mjs';
import { Store } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { ModelDeckService } from '../src/service.mjs';

// All identities/paths below are synthetic fixtures — never real accounts.

const STATUSLINE_STDIN = JSON.stringify({
  session_id: 'fixture-session',
  model: { display_name: 'Fixture' },
  rate_limits: {
    five_hour: { used_percentage: 12.5, resets_at: '2026-07-24T18:00:00Z' },
    seven_day: { used_percentage: 40, resets_at: '2026-07-29T07:00:00Z' },
  },
});

function collector() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

async function runCli({ input, argv = [], spawnSync, now = () => new Date('2026-07-24T12:00:00Z') }) {
  const stdout = collector();
  const captures = [];
  const code = await runStatuslineCli({
    argv,
    stdin: Readable.from([Buffer.from(input)]),
    stdout,
    spawnSync: spawnSync || (() => { throw new Error('no chain expected'); }),
    writeCapture: (file, payload) => captures.push({ file, payload }),
    now,
  });
  return { code, stdout: stdout.text(), captures };
}

// ---------------------------------------------------------------------------
// Script behavior

test('statusline script upserts five_hour and seven_day from the official payload', async () => {
  const { code, captures } = await runCli({ input: STATUSLINE_STDIN, argv: ['--out', '/tmp/fixture.json'] });
  assert.equal(code, 0);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].file, '/tmp/fixture.json');
  assert.deepEqual(captures[0].payload, {
    five_hour: { used_percentage: 12.5, resets_at: '2026-07-24T18:00:00.000Z' },
    seven_day: { used_percentage: 40, resets_at: '2026-07-29T07:00:00.000Z' },
    observedAt: '2026-07-24T12:00:00.000Z',
  });
});

test('missing rate_limits is normal: no capture write, exit 0 (Pro/Max-only field)', async () => {
  const { code, captures } = await runCli({
    input: JSON.stringify({ session_id: 'fixture', model: { display_name: 'Fixture' } }),
    argv: ['--out', '/tmp/fixture.json'],
  });
  assert.equal(code, 0);
  assert.equal(captures.length, 0);
});

test('malformed stdin never errors and writes nothing', async () => {
  const { code, captures, stdout } = await runCli({ input: 'not json {{{', argv: ['--out', '/tmp/fixture.json'] });
  assert.equal(code, 0);
  assert.equal(captures.length, 0);
  assert.equal(stdout, '');
});

test('chained user statusline receives the same stdin and its output passes through untouched', async () => {
  const chain = 'printf "%s" my-custom-statusline';
  const chainB64 = Buffer.from(chain, 'utf8').toString('base64');
  const seen = [];
  const { code, stdout, captures } = await runCli({
    input: STATUSLINE_STDIN,
    argv: ['--out', '/tmp/fixture.json', '--chain-b64', chainB64],
    spawnSync: (cmd, args, options) => {
      seen.push({ cmd, args, input: options.input.toString('utf8') });
      return { stdout: Buffer.from('⚡ user line') };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [{ cmd: '/bin/sh', args: ['-c', chain], input: STATUSLINE_STDIN }]);
  assert.equal(stdout, '⚡ user line');
  assert.equal(captures.length, 1); // capture still happens after the chain
});

test('a failing chain command never blocks the capture or the exit code', async () => {
  const chainB64 = Buffer.from('exit 1', 'utf8').toString('base64');
  const { code, captures } = await runCli({
    input: STATUSLINE_STDIN,
    argv: ['--out', '/tmp/fixture.json', '--chain-b64', chainB64],
    spawnSync: () => { throw new Error('spawn failed'); },
  });
  assert.equal(code, 0);
  assert.equal(captures.length, 1);
});

test('a real capture write is atomic, owner-only, and parseable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-statusline-'));
  const out = path.join(dir, 'capture', 'account.json');
  const code = await runStatuslineCli({
    argv: ['--out', out],
    stdin: Readable.from([Buffer.from(STATUSLINE_STDIN)]),
    stdout: collector(),
    now: () => new Date('2026-07-24T12:00:00Z'),
  });
  assert.equal(code, 0);
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.five_hour.used_percentage, 12.5);
  assert.equal(fs.statSync(out).mode & 0o077, 0);
});

test('parseStatuslineRateLimits accepts one-window payloads and rejects empty ones', () => {
  assert.deepEqual(parseStatuslineRateLimits(JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 3 } },
  })), { five_hour: { used_percentage: 3, resets_at: null } });
  assert.equal(parseStatuslineRateLimits(JSON.stringify({ rate_limits: {} })), null);
  assert.equal(parseStatuslineRateLimits(JSON.stringify({ rate_limits: { five_hour: { resets_at: 'x' } } })), null);
});

test('capture-to-snapshot mapping labels provenance claude-statusline with probe-matching scopes', () => {
  const snapshots = statuslineSnapshotsFromCapture({
    five_hour: { used_percentage: 12.5, resets_at: '2026-07-24T18:00:00.000Z' },
    seven_day: { used_percentage: 40, resets_at: '2026-07-29T07:00:00.000Z' },
    observedAt: '2026-07-24T12:00:00.000Z',
  });
  assert.deepEqual(snapshots.map((row) => [row.scope, row.source, row.usedPercent]), [
    ['5-hour', 'claude-statusline', 12.5],
    ['weekly', 'claude-statusline', 40],
  ]);
  // No observedAt → no snapshots: precedence needs a real observation time.
  assert.deepEqual(statuslineSnapshotsFromCapture({ five_hour: { used_percentage: 1 } }), []);
});

test('command builder and detector round-trip in both launch modes', () => {
  const source = buildStatuslineCommand({
    execPath: '/usr/local/bin/node',
    scriptPath: "/data/it's/claude-statusline.mjs",
    captureFile: '/data/statusline/acct.json',
    chainCommand: 'echo "hi there"',
    sea: false,
  });
  assert.ok(isModelDeckStatuslineCommand(source));
  assert.equal(chainCommandFromStatuslineCommand(source), 'echo "hi there"');
  assert.equal(execPathFromStatuslineCommand(source), '/usr/local/bin/node');
  const sea = buildStatuslineCommand({
    execPath: '/Applications/ModelDeck.app/Contents/MacOS/modeldeckd',
    captureFile: '/data/statusline/acct.json',
    sea: true,
  });
  assert.ok(sea.includes(STATUSLINE_SEA_COMMAND));
  assert.ok(isModelDeckStatuslineCommand(sea));
  assert.equal(chainCommandFromStatuslineCommand(sea), null);
  assert.equal(isModelDeckStatuslineCommand('~/.claude/statusline.sh'), false);
  assert.equal(execPathFromStatuslineCommand(sea), '/Applications/ModelDeck.app/Contents/MacOS/modeldeckd');
  // Quotes and spaces in the bundle path survive the round-trip (issue #189).
  const awkward = buildStatuslineCommand({
    execPath: "/Volumes/Tim's Mac/Model Deck.app/modeldeckd",
    captureFile: '/data/statusline/acct.json',
    sea: true,
  });
  assert.equal(execPathFromStatuslineCommand(awkward), "/Volumes/Tim's Mac/Model Deck.app/modeldeckd");
  // Not our tee → never a path.
  assert.equal(execPathFromStatuslineCommand('~/.claude/statusline.sh'), null);
  assert.equal(execPathFromStatuslineCommand(null), null);
});

// ---------------------------------------------------------------------------
// Daemon ingest + Settings install/uninstall fixture

function makeFixture({ fetchClaude, serviceOptions } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-statusline-svc-'));
  const profilesDir = path.join(root, 'claude-profiles');
  const profileA = path.join(profilesDir, 'work');
  const profileB = path.join(profilesDir, 'personal');
  fs.mkdirSync(profileA, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profileB, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);
  const store = new Store(':memory:');
  const accountA = store.saveAccount({ provider: 'claude', label: 'Work', profileRef: profileA, isDefault: true });
  const accountB = store.saveAccount({ provider: 'claude', label: 'Personal', profileRef: profileB });
  const statuslineDir = path.join(root, 'statusline');
  // The #189 reconcile tests simulate a daemon RESTART from a different
  // location: makeService builds another service over the same store and
  // dirs, differing only in the overridden statusline paths.
  const makeService = (overrides = {}) => new ModelDeckService(store, {
    claudeProfilesDir: profilesDir,
    claudeStatuslineDir: statuslineDir,
    claudeActiveLink: path.join(root, 'active', '.claude'),
    codexActiveLink: path.join(root, 'active', '.codex'),
    codexProfilesDir: path.join(root, 'codex-profiles'),
    fetchClaude: fetchClaude || (async () => []),
    fetchCodex: async () => [],
    readClaudeTier: async () => null,
    readClaudeIdentity: async () => null,
    setTimeout: () => 0,
    clearTimeout: () => {},
    platform: 'linux',
    listProviderProcesses: async () => [],
    statuslineExecPath: '/usr/local/bin/node',
    statuslineScriptPath: '/opt/modeldeck/claude-statusline.mjs',
    statuslineSea: false,
    ...overrides,
  });
  const service = makeService(serviceOptions);
  const writeCapture = (account, payload) => {
    fs.mkdirSync(statuslineDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(service.claudeStatuslineCaptureFile(account.id), `${JSON.stringify(payload)}\n`);
  };
  return { root, store, service, makeService, accountA, accountB, profileA, profileB, statuslineDir, writeCapture };
}

const CAPTURE = (observedAt, fiveHour = 20, weekly = 55) => ({
  five_hour: { used_percentage: fiveHour, resets_at: '2026-07-24T18:00:00.000Z' },
  seven_day: { used_percentage: weekly, resets_at: '2026-07-29T07:00:00.000Z' },
  observedAt,
});

test('ingest records capture windows as claude-statusline snapshots', async () => {
  const { store, service, accountA, writeCapture } = makeFixture();
  writeCapture(accountA, CAPTURE('2026-07-24T12:00:00.000Z'));
  const ingested = await service.ingestClaudeStatuslineCaptures();
  assert.equal(ingested.length, 2);
  const usage = store.latestUsage().filter((row) => row.accountId === accountA.id);
  assert.deepEqual(usage.map((row) => [row.scope, row.usedPercent, row.source, row.observedAt]).sort(), [
    ['5-hour', 20, 'claude-statusline', '2026-07-24T12:00:00.000Z'],
    ['weekly', 55, 'claude-statusline', '2026-07-24T12:00:00.000Z'],
  ]);
});

test('ingest is idempotent and skips captures older than the stored row (newest observedAt wins)', async () => {
  const { store, service, accountA, writeCapture } = makeFixture();
  // A probe snapshot observed later than the capture.
  store.recordUsage(accountA.id, {
    scope: '5-hour', usedPercent: 30, resetsAt: '2026-07-24T18:00:00.000Z',
    observedAt: '2026-07-24T13:00:00.000Z', source: 'claude-oauth-api',
  });
  writeCapture(accountA, CAPTURE('2026-07-24T12:00:00.000Z'));
  await service.ingestClaudeStatuslineCaptures();
  // 5-hour keeps the newer probe row; weekly (no stored row) ingests.
  const latest = Object.fromEntries(store.latestUsage()
    .filter((row) => row.accountId === accountA.id)
    .map((row) => [row.scope, row]));
  assert.equal(latest['5-hour'].source, 'claude-oauth-api');
  assert.equal(latest['5-hour'].usedPercent, 30);
  assert.equal(latest.weekly.source, 'claude-statusline');
  // Re-ingesting the same capture inserts nothing new.
  const again = await service.ingestClaudeStatuslineCaptures();
  assert.deepEqual(again, []);
});

test('a newer capture supersedes an older probe row', async () => {
  const { store, service, accountA, writeCapture } = makeFixture();
  store.recordUsage(accountA.id, {
    scope: 'weekly', usedPercent: 10, resetsAt: '2026-07-29T07:00:00.000Z',
    observedAt: '2026-07-24T10:00:00.000Z', source: 'claude-oauth-api',
  });
  writeCapture(accountA, CAPTURE('2026-07-24T12:00:00.000Z'));
  await service.ingestClaudeStatuslineCaptures();
  const weekly = store.latestUsage().find((row) => row.accountId === accountA.id && row.scope === 'weekly');
  assert.equal(weekly.source, 'claude-statusline');
  assert.equal(weekly.usedPercent, 55);
});

test('malformed or absent capture files are silently skipped', async () => {
  const { store, service, accountA, statuslineDir } = makeFixture();
  fs.mkdirSync(statuslineDir, { recursive: true });
  fs.writeFileSync(service.claudeStatuslineCaptureFile(accountA.id), 'not json');
  assert.deepEqual(await service.ingestClaudeStatuslineCaptures(), []);
  assert.deepEqual(store.latestUsage(), []);
});

// The #65/#108 regression the issue demands: statusline-derived weekly rows
// must NEVER feed weeklyResetFingerprint duplicate detection. Two accounts
// whose captures share the same weekly resets_at (a common real state — the
// same plan tier resets on the hour) must not be flagged duplicate-token.
test('regression: statusline ingest never poisons weeklyResetFingerprint duplicate detection', async () => {
  const { store, service, accountA, accountB, writeCapture } = makeFixture({
    // Probe: distinct weekly resets → genuinely different accounts.
    fetchClaude: async ({ claudeConfigDir }) => [{
      scope: 'weekly',
      usedPercent: 5,
      resetsAt: claudeConfigDir.endsWith('work') ? '2026-07-28T00:00:00.000Z' : '2026-07-30T00:00:00.000Z',
      source: 'claude-oauth-api',
    }],
  });
  // Identical weekly resets_at in BOTH captures, observed after any probe row.
  const capture = CAPTURE('2026-09-01T00:00:00.000Z');
  writeCapture(accountA, capture);
  writeCapture(accountB, capture);
  await service.refreshClaude();
  assert.deepEqual([...service.duplicateClaudeTokenAccountIds], []);
  assert.deepEqual(
    [...service.claudeWeeklyFingerprints.values()].sort(),
    [Math.round(Date.parse('2026-07-28T00:00:00.000Z') / 1000), Math.round(Date.parse('2026-07-30T00:00:00.000Z') / 1000)].sort(),
  );
  // The statusline rows DID land — with their own provenance — they just
  // never entered the fingerprint map.
  const weeklyRows = store.latestUsage().filter((row) => row.scope === 'weekly');
  assert.deepEqual(weeklyRows.map((row) => row.source), ['claude-statusline', 'claude-statusline']);
  const state = await service.accountsWithAuthState();
  assert.ok(state.every((account) => account.authState !== 'duplicate-token'));
});

test('refreshClaude ingests captures as part of the pass', async () => {
  const { store, service, accountA, writeCapture } = makeFixture();
  writeCapture(accountA, CAPTURE('2026-07-24T12:00:00.000Z'));
  await service.refreshClaude();
  assert.ok(store.latestUsage().some((row) => row.source === 'claude-statusline'));
});

// ---------------------------------------------------------------------------
// Settings install / uninstall

test('install writes a chained tee, uninstall restores settings.json byte-for-byte', async () => {
  const { service, accountA, profileA } = makeFixture();
  const settingsPath = path.join(profileA, 'settings.json');
  const original = '{\n  "model": "opus",\n  "statusLine": {\n    "type": "command",\n    "command": "~/bin/my-statusline.sh",\n    "padding": 0\n  }\n}\n';
  fs.writeFileSync(settingsPath, original);

  const installed = await service.installClaudeStatusline(accountA.id);
  assert.deepEqual(installed, { installed: true, chained: true });
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(written.model, 'opus'); // non-destructive: other keys survive
  assert.equal(written.statusLine.type, 'command');
  assert.equal(written.statusLine.padding, 0);
  assert.ok(isModelDeckStatuslineCommand(written.statusLine.command));
  assert.equal(chainCommandFromStatuslineCommand(written.statusLine.command), '~/bin/my-statusline.sh');
  assert.equal(await service.claudeStatuslineInstalled(profileA), true);

  const uninstalled = await service.uninstallClaudeStatusline(accountA.id);
  assert.deepEqual(uninstalled, { installed: false });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original); // byte-for-byte
  assert.equal(await service.claudeStatuslineInstalled(profileA), false);
  assert.equal(fs.existsSync(service.claudeStatuslineBackupFile(accountA.id)), false);
});

test('install without an existing settings.json creates one; uninstall removes it again', async () => {
  const { service, accountA, profileA } = makeFixture();
  const settingsPath = path.join(profileA, 'settings.json');
  const installed = await service.installClaudeStatusline(accountA.id);
  assert.deepEqual(installed, { installed: true, chained: false });
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.ok(isModelDeckStatuslineCommand(written.statusLine.command));
  assert.equal(chainCommandFromStatuslineCommand(written.statusLine.command), null);
  await service.uninstallClaudeStatusline(accountA.id);
  assert.equal(fs.existsSync(settingsPath), false);
});

test('repeated install is idempotent: no double chain, original backup preserved', async () => {
  const { service, accountA, profileA } = makeFixture();
  const settingsPath = path.join(profileA, 'settings.json');
  const original = '{"statusLine":{"type":"command","command":"echo mine"}}\n';
  fs.writeFileSync(settingsPath, original);
  await service.installClaudeStatusline(accountA.id);
  const firstCommand = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command;
  await service.installClaudeStatusline(accountA.id);
  const secondCommand = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command;
  assert.equal(secondCommand, firstCommand);
  assert.equal(chainCommandFromStatuslineCommand(secondCommand), 'echo mine');
  await service.uninstallClaudeStatusline(accountA.id);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
});

test('uninstall after user edits keeps the edits and surgically restores only statusLine', async () => {
  const { service, accountA, profileA } = makeFixture();
  const settingsPath = path.join(profileA, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: 'echo mine' },
  }, null, 2));
  await service.installClaudeStatusline(accountA.id);
  // The user edits an unrelated key AFTER install.
  const edited = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  edited.theme = 'dark';
  fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
  await service.uninstallClaudeStatusline(accountA.id);
  const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(restored.theme, 'dark'); // the edit survives
  assert.deepEqual(restored.statusLine, { type: 'command', command: 'echo mine' });
});

test('uninstall leaves settings.json alone when the user already replaced the tee', async () => {
  const { service, accountA, profileA } = makeFixture();
  const settingsPath = path.join(profileA, 'settings.json');
  fs.writeFileSync(settingsPath, '{}');
  await service.installClaudeStatusline(accountA.id);
  const replaced = '{\n  "statusLine": {\n    "type": "command",\n    "command": "my-new-thing"\n  }\n}\n';
  fs.writeFileSync(settingsPath, replaced);
  await service.uninstallClaudeStatusline(accountA.id);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), replaced);
});

test('install refuses malformed settings.json rather than clobbering it', async () => {
  const { service, accountA, profileA } = makeFixture();
  const settingsPath = path.join(profileA, 'settings.json');
  fs.writeFileSync(settingsPath, 'not valid json');
  await assert.rejects(() => service.installClaudeStatusline(accountA.id), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), 'not valid json');
});

test('install rejects non-claude accounts and writes only inside the profile home (#66)', async () => {
  const { store, service } = makeFixture();
  const codexHome = path.join(path.dirname(service.codexProfilesDir), 'codex-profiles', 'work');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(codexHome), 0o700);
  const codex = store.saveAccount({ provider: 'codex', label: 'Codex', profileRef: codexHome });
  await assert.rejects(() => service.installClaudeStatusline(codex.id), /only supported for claude/);
  await assert.rejects(() => service.uninstallClaudeStatusline(codex.id), /only supported for claude/);
});

test('accountsWithAuthState carries the additive claudeStatusline opt-in state', async () => {
  const { service, accountA } = makeFixture();
  let state = await service.accountsWithAuthState();
  assert.deepEqual(state.find((row) => row.id === accountA.id).claudeStatusline, { installed: false });
  await service.installClaudeStatusline(accountA.id);
  state = await service.accountsWithAuthState();
  assert.deepEqual(state.find((row) => row.id === accountA.id).claudeStatusline, { installed: true });
});

test('statusline install/uninstall endpoints are token-gated and round-trip', async () => {
  const { store, service, accountA, profileA } = makeFixture();
  const app = createApp({ store, service, host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => app.listen(resolve));
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const session = await (await fetch(`${base}/api/session`)).json();
    const mutate = (pathName) => fetch(`${base}${pathName}`, {
      method: 'POST',
      headers: {
        'x-modeldeck-token': session.token,
        cookie: `modeldeck_session=${encodeURIComponent(session.token)}`,
      },
    });
    // Missing token → rejected like every mutation.
    const denied = await fetch(`${base}/api/accounts/${accountA.id}/statusline/install`, { method: 'POST' });
    assert.equal(denied.status, 403);

    const installed = await mutate(`/api/accounts/${accountA.id}/statusline/install`);
    assert.equal(installed.status, 200);
    assert.deepEqual((await installed.json()).statusline, { installed: true, chained: false });
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.accounts.find((row) => row.id === accountA.id).claudeStatusline, { installed: true });

    const uninstalled = await mutate(`/api/accounts/${accountA.id}/statusline/uninstall`);
    assert.equal(uninstalled.status, 200);
    assert.deepEqual((await uninstalled.json()).statusline, { installed: false });
    assert.equal(fs.existsSync(path.join(profileA, 'settings.json')), false);

    const missing = await mutate('/api/accounts/nope/statusline/install');
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Issue #189 — startup reconcile of tees pointing at a dead/moved daemon
// (same bug class as #185's deleted release-worktree binary).

test('reconcile repoints a tee whose executable is gone, preserving chain and original backup', async () => {
  const { makeService, service, accountA, profileA } = makeFixture({
    // The install-time daemon ran from a location that has been deleted
    // (#185: a temp release worktree).
    serviceOptions: { statuslineExecPath: '/tmp/deleted-release-worktree/dist/node' },
  });
  const settingsPath = path.join(profileA, 'settings.json');
  const original = '{\n  "statusLine": {\n    "type": "command",\n    "command": "echo mine"\n  }\n}\n';
  fs.writeFileSync(settingsPath, original);
  await service.installClaudeStatusline(accountA.id);

  // The daemon restarts from its repaired install path (#185 recovery).
  const restarted = makeService({ statuslineExecPath: '/usr/local/bin/node-current' });
  const repaired = await restarted.reconcileClaudeStatuslineInstalls();
  assert.deepEqual(repaired, [accountA.id]);

  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command;
  assert.equal(execPathFromStatuslineCommand(command), '/usr/local/bin/node-current');
  assert.equal(chainCommandFromStatuslineCommand(command), 'echo mine'); // user chain survives
  // The ORIGINAL pre-install backup survived the rewrite: uninstall still
  // restores the user's own statusLine, not a stale tee.
  await restarted.uninstallClaudeStatusline(accountA.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine,
    { type: 'command', command: 'echo mine' });
});

test('reconcile in SEA mode repoints on any exec path mismatch, even when the old binary still exists', async () => {
  const { root, makeService, accountA, profileA } = makeFixture();
  const oldBinary = path.join(root, 'old-bundle-modeldeckd');
  fs.writeFileSync(oldBinary, '#!/bin/sh\n'); // still on disk — a moved, not deleted, bundle
  const installer = makeService({ statuslineExecPath: oldBinary, statuslineSea: true, statuslineScriptPath: null });
  await installer.installClaudeStatusline(accountA.id);

  const restarted = makeService({
    statuslineExecPath: path.join(root, 'new-bundle-modeldeckd'),
    statuslineSea: true,
    statuslineScriptPath: null,
  });
  assert.deepEqual(await restarted.reconcileClaudeStatuslineInstalls(), [accountA.id]);
  const command = JSON.parse(fs.readFileSync(path.join(profileA, 'settings.json'), 'utf8')).statusLine.command;
  assert.equal(execPathFromStatuslineCommand(command), path.join(root, 'new-bundle-modeldeckd'));
  assert.ok(command.includes(STATUSLINE_SEA_COMMAND));
});

test('reconcile leaves healthy tees, foreign statusLines, and tee-less profiles untouched', async () => {
  const { makeService, service, accountA, profileA, profileB } = makeFixture();
  // accountA: our tee, exec path matches the running daemon (fixture default
  // path does not exist on disk — same-path must short-circuit regardless).
  await service.installClaudeStatusline(accountA.id);
  const installedBytes = fs.readFileSync(path.join(profileA, 'settings.json'), 'utf8');
  // accountB: the user's own statusLine, never ours.
  const foreign = '{\n  "statusLine": {\n    "type": "command",\n    "command": "~/bin/my-statusline.sh"\n  }\n}\n';
  fs.writeFileSync(path.join(profileB, 'settings.json'), foreign);

  assert.deepEqual(await service.reconcileClaudeStatuslineInstalls(), []);
  assert.equal(fs.readFileSync(path.join(profileA, 'settings.json'), 'utf8'), installedBytes);
  assert.equal(fs.readFileSync(path.join(profileB, 'settings.json'), 'utf8'), foreign);

  // Non-SEA with a DIFFERENT but still-existing interpreter (e.g. node moved
  // homes but the old one still runs): the tee works, so leave it alone.
  const teed = JSON.parse(installedBytes).statusLine.command;
  fs.writeFileSync(path.join(profileA, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: teed.replace("'/usr/local/bin/node'", `'${process.execPath}'`) } }));
  const other = makeService({ statuslineExecPath: '/somewhere/else/node' });
  assert.deepEqual(await other.reconcileClaudeStatuslineInstalls(), []);
  assert.equal(execPathFromStatuslineCommand(
    JSON.parse(fs.readFileSync(path.join(profileA, 'settings.json'), 'utf8')).statusLine.command,
  ), process.execPath);
});

test('reconcile skips missing or malformed settings.json without touching them', async () => {
  const { service, profileA, profileB } = makeFixture({
    serviceOptions: { statuslineExecPath: '/definitely/gone/node' },
  });
  fs.writeFileSync(path.join(profileB, 'settings.json'), 'not valid json');
  assert.deepEqual(await service.reconcileClaudeStatuslineInstalls(), []);
  assert.equal(fs.existsSync(path.join(profileA, 'settings.json')), false); // never creates one
  assert.equal(fs.readFileSync(path.join(profileB, 'settings.json'), 'utf8'), 'not valid json');
});

test('the statusline command pins the daemon executable and per-account capture file', async () => {
  const { service, accountA, profileA } = makeFixture();
  await service.installClaudeStatusline(accountA.id);
  const command = JSON.parse(fs.readFileSync(path.join(profileA, 'settings.json'), 'utf8')).statusLine.command;
  assert.ok(command.startsWith("'/usr/local/bin/node' '/opt/modeldeck/claude-statusline.mjs'"));
  assert.ok(command.includes(`'${service.claudeStatuslineCaptureFile(accountA.id)}'`));
});
