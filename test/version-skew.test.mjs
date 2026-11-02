import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESPAWN_LOOP_RUNS,
  YOUNG_PROCESS_SECONDS,
  compareVersions,
  evaluateSkew,
  parseBinaryVersion,
  parseElapsedSeconds,
  pickPortHolder,
  readVersionPairs,
} from '../scripts/version-skew-check.mjs';

const PAIRS = {
  verifiedOn: '2026-09-01',
  liveProxy: { version: '7.2.147', binaryPath: '~/bin/cliproxyapi' },
  codexCli: '0.147.0',
  claudeCli: '2.1.258',
};

function makePairsFile(value) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'version-pairs-')), 'version-pairs.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const MATCHED = {
  pairs: PAIRS,
  pinVersion: '7.2.130',
  live: '7.2.147',
  codex: '0.147.0',
  claude: '2.1.258',
  upstreamTags: ['v7.2.147', 'v7.2.146', 'v7.2.145'],
};

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(compareVersions('7.2.147', '7.2.130'), 1);
  assert.equal(compareVersions('7.2.9', '7.2.130'), -1);
  assert.equal(compareVersions('7.2.147', '7.2.147'), 0);
});

test('parseBinaryVersion prefers the ldflags stamp', () => {
  const buffer = Buffer.from('junk -ldflags="-s -w -X main.Version=7.2.147" more 7.2.130');
  assert.equal(parseBinaryVersion(buffer, { majorHint: '7' }), '7.2.147');
});

test('parseBinaryVersion falls back to the most frequent major-matched string', () => {
  const buffer = Buffer.from('go1.26.4 x 7A7.2.130 y 7.2.130 z 1.2.3');
  assert.equal(parseBinaryVersion(buffer, { majorHint: '7' }), '7.2.130');
  assert.equal(parseBinaryVersion(Buffer.from('no versions here'), { majorHint: '7' }), null);
});

test('a matched pair with no newer upstream reports only the pin info line', () => {
  const findings = evaluateSkew(MATCHED);
  assert.deepEqual(findings.map((f) => f.level), ['info']);
  assert.match(findings[0].message, /bundled pin 7\.2\.130 is 3 release\(s\) behind/);
});

test('a CLI moving off the recorded pair warns', () => {
  const findings = evaluateSkew({ ...MATCHED, codex: '0.148.0' });
  const warns = findings.filter((f) => f.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /Codex CLI is 0\.148\.0 but the verified pair/);
});

test('upstream releases newer than the live proxy warn with a count', () => {
  const findings = evaluateSkew({ ...MATCHED, upstreamTags: ['v7.2.149', 'v7.2.148', 'v7.2.147'] });
  const warns = findings.filter((f) => f.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /live proxy 7\.2\.147 is 2 release\(s\) behind upstream 7\.2\.149/);
});

test('an unreadable version or empty upstream list warns instead of passing silently', () => {
  const noLive = evaluateSkew({ ...MATCHED, live: null });
  assert.ok(noLive.some((f) => f.level === 'warn' && /live proxy binary: version could not be read/.test(f.message)));

  const noUpstream = evaluateSkew({ ...MATCHED, upstreamTags: [] });
  assert.ok(noUpstream.some((f) => f.level === 'warn' && /upstream releases could not be listed/.test(f.message)));
});

test('a stamped Claude client below the recorded minimum reports as info, at or above it stays silent', () => {
  const blocked = evaluateSkew({
    ...MATCHED,
    pairs: { ...PAIRS, stampedClaudeClient: { version: '2.1.220', minRequired: '2.1.251' } },
  });
  const stampLines = blocked.filter((f) => /proxy-stamped Claude client/.test(f.message));
  assert.deepEqual(stampLines.map((f) => f.level), ['info']);

  const unblocked = evaluateSkew({
    ...MATCHED,
    pairs: { ...PAIRS, stampedClaudeClient: { version: '2.1.251', minRequired: '2.1.251' } },
  });
  assert.equal(unblocked.filter((f) => /proxy-stamped/.test(f.message)).length, 0);
});

// Issue #614 — TRIPWIRE #614: the check reads what serves the port, not
// only the file at the recorded path. On 2026-09-01 the app's bundled 7.2.130
// held 8317 while ~/bin/cliproxyapi was 7.2.147 on disk, and the check passed.
const APP_BUNDLE_PROXY = '/Applications/ModelDeck.app/Contents/Resources/cliproxyapi/cliproxyapi';
const SUPERVISED = { ...PAIRS, liveProxy: { ...PAIRS.liveProxy, launchdLabel: 'com.cliproxyapi.server' } };

test('TRIPWIRE #614: the port held by a binary other than the recorded one warns', () => {
  const findings = evaluateSkew({
    ...MATCHED,
    portHolder: { pid: '12680', path: APP_BUNDLE_PROXY, version: '7.2.130', matchesRecorded: false },
  });
  const warns = findings.filter((f) => f.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /proxy port 8317 is served by \/Applications\/ModelDeck\.app.* \(7\.2\.130\), not the recorded live binary ~\/bin\/cliproxyapi/);
});

test('TRIPWIRE #614: the recorded binary on the port with a live launch agent adds nothing', () => {
  const findings = evaluateSkew({
    ...MATCHED,
    pairs: SUPERVISED,
    portHolder: { pid: '4242', path: '/Users/tim/bin/cliproxyapi', version: '7.2.147', matchesRecorded: true },
    launchAgent: { running: true, runs: 3 },
  });
  assert.deepEqual(findings.map((f) => f.level), ['info']);
});

test('TRIPWIRE #614: nothing listening on the port warns', () => {
  const findings = evaluateSkew({ ...MATCHED, portHolder: null });
  assert.ok(findings.some((f) => f.level === 'warn' && /nothing is listening on proxy port 8317/.test(f.message)));
});

test('TRIPWIRE #614: a launch agent with no running process warns, whatever its relaunch count', () => {
  for (const runs of [3, 5138]) {
    const findings = evaluateSkew({ ...MATCHED, pairs: SUPERVISED, launchAgent: { running: false, runs, pidAgeSeconds: null } });
    const warns = findings.filter((f) => f.level === 'warn');
    assert.equal(warns.length, 1, `runs=${runs}`);
    assert.match(warns[0].message, new RegExp(`launch agent com\\.cliproxyapi\\.server has no running process \\(relaunched ${runs} time\\(s\\) this login\\)`));
  }
});

test('TRIPWIRE #614: a respawn loop caught mid-cycle (young pid, high relaunch count) warns', () => {
  const findings = evaluateSkew({
    ...MATCHED,
    pairs: SUPERVISED,
    launchAgent: { running: true, runs: RESPAWN_LOOP_RUNS, pidAgeSeconds: 4 },
  });
  const warns = findings.filter((f) => f.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /has relaunched 20 time\(s\) this login and its current process is 4 s old; a KeepAlive agent that keeps exiting/);

  const unknownAge = evaluateSkew({
    ...MATCHED,
    pairs: SUPERVISED,
    launchAgent: { running: true, runs: RESPAWN_LOOP_RUNS, pidAgeSeconds: null },
  });
  assert.ok(unknownAge.some((f) => f.level === 'warn' && /an unknown number of s old/.test(f.message)));

  const fewRelaunches = evaluateSkew({
    ...MATCHED,
    pairs: SUPERVISED,
    launchAgent: { running: true, runs: RESPAWN_LOOP_RUNS - 1, pidAgeSeconds: 4 },
  });
  assert.equal(fewRelaunches.filter((f) => /launch agent/.test(f.message)).length, 0);
});

test('TRIPWIRE #614: a recovered agent (old pid) with a high relaunch count is history, not a warning', () => {
  // launchd's counter never resets before logout: after the documented
  // recovery the count stays in the thousands while the process settles.
  const findings = evaluateSkew({
    ...MATCHED,
    pairs: SUPERVISED,
    portHolder: { pid: '4242', path: '/Users/tim/bin/cliproxyapi', version: '7.2.147', matchesRecorded: true },
    launchAgent: { running: true, runs: 5371, pidAgeSeconds: YOUNG_PROCESS_SECONDS },
  });
  assert.equal(findings.filter((f) => f.level === 'warn').length, 0);
  const agentLines = findings.filter((f) => /launch agent/.test(f.message));
  assert.deepEqual(agentLines.map((f) => f.level), ['info']);
  assert.match(agentLines[0].message, /relaunched 5371 time\(s\) this login .* is 60 s old, so it has not relaunched in the last minute/);
});

test('TRIPWIRE #614: a failed probe warns as a failed probe, never as an outage', () => {
  const findings = evaluateSkew({ ...MATCHED, portHolder: undefined, probeErrors: ['lsof could not list port 8317: boom'] });
  const warns = findings.filter((f) => f.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /probe failed: lsof could not list port 8317: boom/);
  assert.equal(findings.filter((f) => /nothing is listening/.test(f.message)).length, 0);
});

test('TRIPWIRE #614: a holder whose executable could not be read still warns, naming the pid', () => {
  const findings = evaluateSkew({ ...MATCHED, portHolder: { pid: '777', path: null, version: null, matchesRecorded: false } });
  assert.ok(findings.some((f) => f.level === 'warn' && /served by pid 777 \(executable could not be read/.test(f.message)));
});

// Issue #614 review blocker: the check once executed whatever binary held the
// port (picked by name) for its version, with the caller's environment. The
// script may run only the fixed local tools it names, never a path it found.
test('TRIPWIRE #614: the skew check executes nothing it finds on the port', () => {
  const source = fs.readFileSync(new URL('../scripts/version-skew-check.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g)].map((m) => m[1].trim());
  assert.deepEqual(imports, ['execFileSync'], 'only execFileSync may come from child_process');
  assert.doesNotMatch(source, /\b(spawn|spawnSync|exec|execSync|execFile|fork)\s*\(/, 'no other process-spawning call');
  const commands = [...source.matchAll(/execFileSync\(\s*([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(commands.length >= 4, `expected the known execFileSync call sites, found ${commands.length}`);
  for (const command of commands) {
    assert.ok(
      ["'lsof'", "'ps'", "'launchctl'", "'gh'", 'command'].includes(command),
      `execFileSync runs a fixed tool, never a discovered path: ${command}`,
    );
  }
  // `command` is cliVersion's parameter, called only with the two CLIs.
  const cliCalls = [...source.matchAll(/cliVersion\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(cliCalls.sort(), ['claude', 'codex']);
});

test('TRIPWIRE #614: with several listeners, a recorded one never masks a foreign one', () => {
  const recorded = { pid: '1', path: '/Users/tim/bin/cliproxyapi', version: '7.2.147', matchesRecorded: true };
  const foreign = { pid: '2', path: APP_BUNDLE_PROXY, version: null, matchesRecorded: false };
  assert.equal(pickPortHolder([recorded, foreign]), foreign);
  assert.equal(pickPortHolder([foreign, recorded]), foreign);
  assert.equal(pickPortHolder([recorded]), recorded);
  assert.equal(pickPortHolder([]), null);
});

test('parseElapsedSeconds reads every ps etime shape', () => {
  assert.equal(parseElapsedSeconds('15:26:01'), 55561);
  assert.equal(parseElapsedSeconds('1-02:03:04'), 93784);
  assert.equal(parseElapsedSeconds('05:07'), 307);
  assert.equal(parseElapsedSeconds('  00:04\n'), 4);
  assert.equal(parseElapsedSeconds('junk'), null);
});

test('TRIPWIRE #614: a launch agent that is not loaded warns; no recorded label means no launchd opinion', () => {
  const notLoaded = evaluateSkew({ ...MATCHED, pairs: SUPERVISED, launchAgent: null });
  assert.ok(notLoaded.some((f) => f.level === 'warn' && /launch agent com\.cliproxyapi\.server is not loaded/.test(f.message)));

  const unlabelled = evaluateSkew({ ...MATCHED, launchAgent: null });
  assert.equal(unlabelled.filter((f) => /launch agent/.test(f.message)).length, 0);
});

test('a launchdLabel that is not a launchd label fails validation', () => {
  for (const launchdLabel of [7, '', 'com.x; touch /tmp/pwn', 'gui/501/com.x']) {
    assert.throws(
      () => readVersionPairs(makePairsFile({ ...PAIRS, liveProxy: { ...PAIRS.liveProxy, launchdLabel } })),
      /liveProxy\.launchdLabel/,
      JSON.stringify(launchdLabel),
    );
  }
});

test('a malformed stampedClaudeClient block fails validation', () => {
  assert.throws(
    () => readVersionPairs(makePairsFile({ ...PAIRS, stampedClaudeClient: { version: '2.1.220' } })),
    /stampedClaudeClient\.minRequired/,
  );
});

test('the checked-in pairs file parses and validates', () => {
  const pairs = readVersionPairs();
  assert.match(pairs.codexCli, /^\d+\.\d+\.\d+$/);
});

const REMOTE = { ...MATCHED, role: 'remote', live: null, upstreamTags: [], launchAgent: null,
  portHolder: { pid: '123', path: '/opt/node/bin/node', isForwarder: true, matchesRecorded: false }, health: { status: 'ok' } };
test('healthy remote client skips host proxy checks but retains CLI pair checks', () => {
  const findings = evaluateSkew(REMOTE);
  assert.deepEqual(findings, [{ level: 'info', message: 'remote role: proxy checks run on the pool host' }]);
  assert.ok(evaluateSkew({ ...REMOTE, codex: '0.0.1' }).some((f) => f.level === 'warn' && /Codex CLI/.test(f.message)));
});
test('remote client with missing forwarder fails plainly', () => {
  assert.ok(evaluateSkew({ ...REMOTE, portHolder: null }).some((f) => f.level === 'warn' && /forwarder.*missing/.test(f.message)));
});
test('remote client with failed healthz or wrong listener fails plainly', () => {
  for (const health of [null, {}, { status: 'bad' }]) assert.ok(evaluateSkew({ ...REMOTE, health }).some((f) => f.level === 'warn' && /healthz/.test(f.message)));
  assert.ok(evaluateSkew({ ...REMOTE, portHolder: { ...REMOTE.portHolder, isForwarder: false } }).some((f) => f.level === 'warn' && /not the pool forwarder/.test(f.message)));
});
test('explicit host role keeps existing skew behavior', () => {
  assert.deepEqual(evaluateSkew({ ...MATCHED, role: 'host' }), evaluateSkew(MATCHED));
});

import { isPoolForwarder, probeClientRole, probeForwarderHealth } from '../scripts/version-skew-check.mjs';
test('forwarder identity requires the mapped Node executable and the actual script argument', (t) => {
  const script = fs.realpathSync(fileURLToPath(new URL('../tools/pool-forwarder/forwarder.mjs', import.meta.url)));
  const node = fs.realpathSync(process.execPath);
  assert.equal(isPoolForwarder(node, `${process.execPath} ${script}`), true);
  assert.equal(isPoolForwarder(node, 'node tools/pool-forwarder/forwarder.mjs'), false);
  assert.equal(isPoolForwarder(node, `${node} /other/tools/pool-forwarder/forwarder.mjs`), false);
  assert.equal(isPoolForwarder(node, `relative/node ${script}`), false);
  assert.equal(isPoolForwarder('/other/node', `${node} ${script}`), false);
  assert.equal(isPoolForwarder('node', `${node} ${script}`), false);
  const aliases = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarder identity '));
  t.after(() => fs.rmSync(aliases, { recursive: true, force: true }));
  fs.symlinkSync(node, path.join(aliases, 'node'));
  fs.symlinkSync(script, path.join(aliases, 'forwarder.mjs'));
  assert.equal(isPoolForwarder(node, `${path.join(aliases, 'node')} ${path.join(aliases, 'forwarder.mjs')}`), true);
  for (const [executable, args] of [
    ['/bin/sh', `node ${script}`], ['/opt/bin/not-node', `node ${script}`],
    ['/opt/bin/node', `node -e ${script}`], ['/opt/bin/node', `node /other.mjs ${script}`],
    ['/opt/bin/node', `node ${script}.bak`], ['/opt/bin/node', 'node /other.mjs'],
  ]) assert.equal(isPoolForwarder(executable, args), false, args);
  const forwarder = { isForwarder: true };
  const other = { isForwarder: false };
  assert.equal(pickPortHolder([forwarder, other], 'remote'), other);
});

test('role and health reads are injectable and daemon failure retains host behavior', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ proxyRole: 'remote', status: 'ok' }) }; };
  assert.equal(await probeClientRole({ fetchImpl, daemonUrl: 'http://test-daemon' }), 'remote');
  assert.equal((await probeForwarderHealth({ fetchImpl, healthUrl: 'http://test-proxy/healthz' })).status, 'ok');
  assert.deepEqual(calls, ['http://test-daemon/api/settings', 'http://test-proxy/healthz']);
  const failed = async () => { throw Error('offline'); };
  assert.equal(await probeClientRole({ fetchImpl: failed }), 'host');
  assert.equal(await probeForwarderHealth({ fetchImpl: failed }), null);
  assert.equal(await probeClientRole({ fetchImpl: async () => ({ ok: false }) }), 'host');
});


test('failed role reads announce unknown role while retaining host checks', async () => {
  for (const fetchImpl of [async () => { throw Error('offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw Error('bad json'); } })]) {
    const lines = [];
    assert.equal(await probeClientRole({ fetchImpl, log: line => lines.push(line) }), 'host');
    assert.deepEqual(lines, ['role unknown (daemon not answering); checks assume host']);
  }
  const lines = [];
  assert.equal(await probeClientRole({ fetchImpl: async () => ({ ok: true, json: async () => ({ proxyRole: 'host' }) }), log: line => lines.push(line) }), 'host');
  assert.deepEqual(lines, []);
});
