#!/usr/bin/env node
// Version-skew check for the live-machine proxy setup (docs/live-proxy-ops.md).
// Compares the recorded known-good pair (scripts/version-pairs.json) against the
// installed Codex CLI, Claude Code CLI, live proxy binary, the bundled pin, and
// upstream CLIProxyAPI releases, and reports which process actually holds the
// proxy port and whether the launch agent is alive. Spends no provider quota,
// reads daemon settings and (in remote role) forwarder health. It executes
// nothing it finds: versions come from files and the local process table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCLIProxyPin } from './cliproxyapi-pin.mjs';

export const VERSION_PAIRS_PATH = fileURLToPath(
  new URL('./version-pairs.json', import.meta.url),
);

const UPSTREAM_REPO = 'router-for-me/CLIProxyAPI';
const PROXY_PORT = 8317;
// launchd's per-login relaunch counter never resets before logout, so the
// count alone cannot say whether an agent is looping NOW. At or above this
// many relaunches, a process younger than YOUNG_PROCESS_SECONDS is the loop;
// an older one is a settled agent that looped earlier this login.
export const RESPAWN_LOOP_RUNS = 20;
export const YOUNG_PROCESS_SECONDS = 60;
const DOTTED = /^\d+\.\d+\.\d+$/;

export function readVersionPairs(pairsPath = VERSION_PAIRS_PATH) {
  const value = JSON.parse(fs.readFileSync(pairsPath, 'utf8'));
  for (const [field, version] of [
    ['liveProxy.version', value?.liveProxy?.version],
    ['codexCli', value?.codexCli],
    ['claudeCli', value?.claudeCli],
  ]) {
    if (typeof version !== 'string' || !DOTTED.test(version)) {
      throw new Error(`version-pairs '${field}' must be a dotted version, got ${version ?? '(missing)'}`);
    }
  }
  if (typeof value?.liveProxy?.binaryPath !== 'string') {
    throw new Error("version-pairs 'liveProxy.binaryPath' is missing");
  }
  if (value.liveProxy.launchdLabel !== undefined
    && (typeof value.liveProxy.launchdLabel !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.liveProxy.launchdLabel))) {
    throw new Error("version-pairs 'liveProxy.launchdLabel' must be a launchd label (letters, digits, . _ -)");
  }
  if (value.stampedClaudeClient !== undefined) {
    for (const field of ['version', 'minRequired']) {
      const version = value.stampedClaudeClient?.[field];
      if (typeof version !== 'string' || !DOTTED.test(version)) {
        throw new Error(`version-pairs 'stampedClaudeClient.${field}' must be a dotted version, got ${version ?? '(missing)'}`);
      }
    }
  }
  return value;
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// Extract the proxy version embedded in a binary. Prefers the ldflags stamp
// (source builds); falls back to counting version-shaped strings that share
// the expected major version (upstream release binaries lack the stamp).
export function parseBinaryVersion(buffer, { majorHint }) {
  const text = buffer.toString('latin1');
  const stamped = text.match(/main\.Version=(\d+\.\d+\.\d+)/);
  if (stamped) return stamped[1];

  const counts = new Map();
  const candidate = new RegExp(`(?<![\\d.])${majorHint}\\.\\d+\\.\\d+(?![\\d.])`, 'g');
  for (const match of text.matchAll(candidate)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  let best = null;
  for (const [version, count] of counts) {
    if (!best || count > best.count) best = { version, count };
  }
  return best?.version ?? null;
}

// Pure comparison: returns [{level: 'warn'|'info', message}]. Any 'warn' means
// the recorded pair no longer describes reality and needs a re-verify.
export function evaluateSkew({ pairs, pinVersion, live, codex, claude, upstreamTags, portHolder, launchAgent, probeErrors, role = 'host', health }) {
  const findings = [];
  const warn = (message) => findings.push({ level: 'warn', message });
  const info = (message) => findings.push({ level: 'info', message });

  for (const [name, actual, recorded] of [
    ['Codex CLI', codex, pairs.codexCli],
    ['Claude Code CLI', claude, pairs.claudeCli],
    ...(role === 'remote' ? [] : [['live proxy binary', live, pairs.liveProxy.version]]),
  ]) {
    if (actual == null) {
      warn(`${name}: version could not be read; re-verify the pair by hand`);
    } else if (actual !== recorded) {
      warn(`${name} is ${actual} but the verified pair (${pairs.verifiedOn}) records ${recorded}; re-verify the pair and update scripts/version-pairs.json`);
    }
  }

  if (role === 'remote') {
    info('remote role: proxy checks run on the pool host');
    for (const message of probeErrors ?? []) warn(`probe failed: ${message}`);
    if (portHolder === null) warn('pool forwarder is missing: nothing is listening on port 8317');
    else if (!portHolder) warn('pool forwarder on port 8317 could not be checked');
    else if (!portHolder.isForwarder) warn('port 8317 is held by a process that is not the pool forwarder');
    if (health?.status !== 'ok') warn('pool forwarder healthz failed: expected status ok on port 8317');
    return findings;
  }

  // The stamped Claude client identity is compiled into the proxy, so the
  // recorded values are the check: a stamp below the recorded minimum means
  // new Anthropic models stay blocked until an upstream release bumps it
  // (which then arrives as a normal pair upgrade). Info, not warn — the
  // recorded pair still describes reality while we wait on upstream.
  const stamped = pairs.stampedClaudeClient;
  if (stamped && compareVersions(stamped.version, stamped.minRequired) < 0) {
    info(`proxy-stamped Claude client ${stamped.version} is below the ${stamped.minRequired} Anthropic requires for its newest models; blocked until an upstream release bumps the fingerprint`);
  }

  // What holds the port. The recorded binary can be upgraded and correct on
  // disk while a different executable holds the port: on 2026-09-01 the app's
  // bundled (pinned, older) proxy took port 8317 ahead of the upgraded launch
  // agent, and this check passed for two days by reading the file. The holder
  // is identified by the executable the kernel mapped into the process, and
  // its version is read from that file's bytes (or, for the app's own copy,
  // from the bundled pin); nothing found on the port is ever executed.
  // `undefined` = not probed; `null` = nothing listening.
  for (const message of probeErrors ?? []) {
    warn(`probe failed: ${message}; re-run, or check by hand with lsof`);
  }
  if (portHolder === null) {
    warn(`nothing is listening on proxy port ${PROXY_PORT}; every session routed through the proxy is down`);
  } else if (portHolder && !portHolder.matchesRecorded) {
    const what = portHolder.path ?? `pid ${portHolder.pid} (executable could not be read; it may have exited during the probe)`;
    warn(`proxy port ${PROXY_PORT} is served by ${what} (${portHolder.version ?? 'version unreadable'}), not the recorded live binary ${pairs.liveProxy.binaryPath}; the pair describes a binary nobody is using`);
  }

  // A KeepAlive agent that cannot bind exits and is relaunched every 10 s, so
  // it has a pid for a slice of every cycle and "is it running" is a coin
  // flip. A high relaunch count with a young process is the loop; the same
  // count with an old process is history (the counter only resets at logout).
  const label = pairs.liveProxy.launchdLabel;
  if (label && launchAgent === null) {
    warn(`launch agent ${label} is not loaded; nothing supervises the recorded live binary`);
  } else if (label && launchAgent) {
    const { running, runs, pidAgeSeconds } = launchAgent;
    const young = pidAgeSeconds == null || pidAgeSeconds < YOUNG_PROCESS_SECONDS;
    if (!running) {
      warn(`launch agent ${label} has no running process (relaunched ${runs} time(s) this login); something else holds the port or the binary exits on start`);
    } else if (runs >= RESPAWN_LOOP_RUNS && young) {
      warn(`launch agent ${label} has relaunched ${runs} time(s) this login and its current process is ${pidAgeSeconds ?? 'an unknown number of'} s old; a KeepAlive agent that keeps exiting means something else holds the port or the binary exits on start (if you just restarted it on purpose, re-run in a minute)`);
    } else if (runs >= RESPAWN_LOOP_RUNS) {
      info(`launch agent ${label} relaunched ${runs} time(s) this login (launchd's counter resets only at logout); its current process is ${pidAgeSeconds} s old, so it has not relaunched in the last minute (re-run and compare the count if in doubt)`);
    }
  }

  const versions = (upstreamTags ?? [])
    .map((tag) => tag.replace(/^v/, ''))
    .filter((v) => DOTTED.test(v));
  const latest = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), '0.0.0');
  if (versions.length === 0) {
    warn('upstream releases could not be listed (gh unavailable or offline); skew vs upstream is unknown');
  } else {
    if (live && compareVersions(latest, live) > 0) {
      const behind = versions.filter((v) => compareVersions(v, live) > 0).length;
      warn(`live proxy ${live} is ${behind} release(s) behind upstream ${latest}; read the release notes for security fixes, client-fingerprint bumps, and new-model/protocol support`);
    }
    if (compareVersions(latest, pinVersion) > 0) {
      const behind = versions.filter((v) => compareVersions(v, pinVersion) > 0).length;
      info(`bundled pin ${pinVersion} is ${behind} release(s) behind upstream ${latest} (the release pin-watch owns that verdict; listed for awareness)`);
    }
  }

  return findings;
}

function cliVersion(command, args = ['--version']) {
  try {
    const out = execFileSync(command, args, { encoding: 'utf8', timeout: 15_000 });
    return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// Pids listening on the port, from the process table (lsof sends nothing to
// the port). `null` when nothing listens; throws when lsof itself failed, so
// a broken probe never reads as an outage. Non-root lsof sees only this
// user's processes, which covers the gui/ launch agent and the app.
function listeningPids(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const pids = out.split('\n').filter(Boolean);
    return pids.length > 0 ? pids : null;
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    if (error.status === 1 && !stderr) return null; // lsof: no matching process
    throw new Error(`lsof could not list port ${port}: ${stderr || error.code || `exit ${error.status}`}`);
  }
}

// The executable mapped into a process, from the kernel's open-file table
// (the first program-text entry). argv[0], which `ps -o comm=` reports, is a
// value the process chose for itself and is never trusted here.
function executablePath(pid) {
  try {
    const out = execFileSync('lsof', ['-p', pid, '-a', '-d', 'txt', '-Fn'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? null;
  } catch {
    return null; // exited between the two lsof calls
  }
}

function isRegularFile(path) {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// The process holding the proxy port: `null` when nothing listens. Its
// version comes from the executable's bytes, or from the bundled pin when the
// executable is the app's own copy (that binary carries no scannable version
// string). Nothing found here is executed (decision 0010).
export function probePortHolder(port, { recordedBinaryPath, pin, majorHint, role = 'host' }) {
  const pids = listeningPids(port);
  if (pids === null) return null;
  return pickPortHolder(pids.map((pid) => {
    const path = executablePath(pid);
    if (path === null) return { pid, path: null, version: null, matchesRecorded: false };
    if (role === 'remote') {
      let commandLine = '';
      try {
        commandLine = execFileSync('ps', ['-ww', '-o', 'args=', '-p', pid], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { /* The process may have exited between probes. */ }
      return { pid, path, isForwarder: isPoolForwarder(path, commandLine), matchesRecorded: false };
    }
    const matchesRecorded = samePath(path, recordedBinaryPath);
    let version = null;
    if (pin && path.endsWith(`/${pin.bundlePath}`)) {
      // The app's copy carries no scannable version string, and this is a
      // path-shape match, not an identity check: name the pin, not the file.
      version = `an app bundle's copy; no scannable version, the current pin is ${pin.version}`;
    } else if (isRegularFile(path)) {
      try {
        version = parseBinaryVersion(fs.readFileSync(path), { majorHint });
      } catch {
        version = null; // unreadable (e.g. execute-only); the path still stands
      }
    }
    return { pid, path, version, matchesRecorded };
  }), role);
}

// Every listener is examined; the one reported is the first that is NOT the
// recorded binary, so a recorded listener can never mask a foreign one.
export function pickPortHolder(holders, role = 'host') {
  return holders.find((holder) => role === 'remote' ? !holder.isForwarder : !holder.matchesRecorded) ?? holders[0] ?? null;
}

// The installer launches Node with just the script path. Do not accept an
// arbitrary command merely mentioning the forwarder (e.g. node -e or a shell).
export function isPoolForwarder(executable, commandLine) {
  if (!executable || !path.isAbsolute(executable) || !samePath(executable, process.execPath)) return false;
  const command = commandLine.trim();
  // ps does not quote argv: try the separator positions so paths with spaces
  // and Homebrew's node symlink still resolve to the two exact files.
  for (const separator of command.matchAll(/\s+/g)) {
    const node = command.slice(0, separator.index);
    const script = command.slice(separator.index + separator[0].length);
    if (path.isAbsolute(node) && path.isAbsolute(script) && samePath(node, executable)
      && samePath(script, fileURLToPath(new URL('../tools/pool-forwarder/forwarder.mjs', import.meta.url)))) return true;
  }
  return false;
}

export async function probeClientRole({ fetchImpl = fetch, daemonUrl = 'http://127.0.0.1:3867', log = console.log } = {}) {
  try {
    const response = await fetchImpl(`${daemonUrl}/api/settings`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (response.ok) {
      const settings = await response.json();
      return settings?.proxyRole === 'remote' ? 'remote' : 'host';
    }
  } catch { /* An older or stopped daemon keeps the existing host checks. */ }
  log('role unknown (daemon not answering); checks assume host');
  return 'host';
}

export async function probeForwarderHealth({ fetchImpl = fetch, healthUrl = 'http://127.0.0.1:8317/healthz' } = {}) {
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

// `ps -o etime=` renders [[dd-]hh:]mm:ss.
export function parseElapsedSeconds(etime) {
  const match = String(etime).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

// The launch agent's state from launchd: `null` when the label is not
// loaded; otherwise whether it has a live pid, how old that process is, and
// how many times launchd has started it this login.
export function probeLaunchAgent(label) {
  let out;
  try {
    out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  const pid = out.match(/^\s*pid = (\d+)/m)?.[1] ?? null;
  let pidAgeSeconds = null;
  if (pid) {
    try {
      pidAgeSeconds = parseElapsedSeconds(execFileSync('ps', ['-o', 'etime=', '-p', pid], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch {
      pidAgeSeconds = null;
    }
  }
  return {
    running: pid !== null,
    pid,
    pidAgeSeconds,
    runs: Number(out.match(/^\s*runs = (\d+)/m)?.[1] ?? 0),
  };
}

function upstreamReleaseTags() {
  try {
    const out = execFileSync(
      'gh',
      ['release', 'list', '-R', UPSTREAM_REPO, '--limit', '30', '--json', 'tagName', '--jq', '.[].tagName'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const role = await probeClientRole();
  const pairs = readVersionPairs();
  const pin = role === 'remote' ? null : readCLIProxyPin();
  const binaryPath = pairs.liveProxy.binaryPath.replace(/^~(?=\/)/, os.homedir());

  const majorHint = pairs.liveProxy.version.split('.')[0];
  let live = null;
  if (role !== 'remote' && fs.existsSync(binaryPath)) {
    live = parseBinaryVersion(fs.readFileSync(binaryPath), { majorHint });
  }

  const probeErrors = [];
  let portHolder;
  try {
    portHolder = probePortHolder(PROXY_PORT, { recordedBinaryPath: binaryPath, pin, majorHint, role });
  } catch (error) {
    probeErrors.push(error.message);
  }

  const findings = evaluateSkew({
    pairs,
    role,
    health: role === 'remote' ? await probeForwarderHealth() : undefined,
    pinVersion: pin?.version,
    live,
    codex: cliVersion('codex'),
    claude: cliVersion('claude'),
    upstreamTags: role === 'remote' ? [] : upstreamReleaseTags(),
    portHolder,
    launchAgent: role !== 'remote' && pairs.liveProxy.launchdLabel ? probeLaunchAgent(pairs.liveProxy.launchdLabel) : undefined,
    probeErrors,
  });

  if (findings.length === 0) {
    console.log(`version-skew-check: all clear (pair verified ${pairs.verifiedOn})`);
    return;
  }
  for (const { level, message } of findings) {
    console.log(`${level.toUpperCase()}: ${message}`);
  }
  if (findings.some((f) => f.level === 'warn')) process.exitCode = 1;
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    await main();
  } catch (error) {
    console.error(`version-skew-check.mjs: ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
