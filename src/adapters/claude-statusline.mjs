import { spawnSync as nodeSpawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Issue #174 — statusline rate-limits capture (winner of spike #173).
//
// Claude Code >= 2.1 pipes a JSON payload to the user-configured statusLine
// command on every render; for Claude.ai subscribers (Pro/Max) it includes
// `rate_limits.five_hour/{used_percentage,resets_at}` and
// `rate_limits.seven_day.{...}` — server-truth window data, credential-free,
// with zero extra API calls (official field table:
// code.claude.com/docs/en/statusline). ModelDeck's opt-in tee:
//
//   statusline stdin ──> [chain the user's own statusLine, output untouched]
//                    └─> [upsert a per-profile capture file under DATA_DIR]
//
// Safety contract (issue #174): this script never sees or touches
// credentials, never makes a network call, and treats an absent
// `rate_limits` object as NORMAL (non-Pro/Max plans, and the moments before
// the first API response of a session) — it writes nothing and never errors.
// A statusline that exits non-zero would degrade the user's own statusline
// experience, so the CLI entry point below always exits 0.
// ---------------------------------------------------------------------------

// The SEA daemon binary doubles as the statusline executable via this argv
// marker (same pattern as modeldeck-internal-claude-usage-probe); it is also
// the substring install/uninstall use to recognize ModelDeck's own command in
// a profile's settings.json.
export const STATUSLINE_SEA_COMMAND = 'modeldeck-internal-claude-statusline';

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function resetIso(value) {
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function captureWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const usedPercentage = number(window.used_percentage ?? window.usedPercentage ?? window.utilization);
  if (usedPercentage == null) return null;
  return {
    used_percentage: usedPercentage,
    resets_at: resetIso(window.resets_at ?? window.resetsAt),
  };
}

/// Extract the two documented windows from the statusline stdin payload.
/// Returns null when the payload carries no usable rate-limit data — which
/// is a NORMAL state, never an error (Pro/Max-only field; absent before the
/// session's first API response).
export function parseStatuslineRateLimits(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload); } catch { return null; }
  }
  const rateLimits = data?.rate_limits ?? data?.rateLimits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const fiveHour = captureWindow(rateLimits.five_hour ?? rateLimits.fiveHour);
  const sevenDay = captureWindow(rateLimits.seven_day ?? rateLimits.sevenDay);
  if (!fiveHour && !sevenDay) return null;
  return {
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
}

/// Convert a capture-file document into ModelDeck usage snapshots. Scope
/// labels match the probe parser's exactly ('5-hour' / 'weekly',
/// src/adapters/claude.mjs windowLabel) so the deck renders one continuous
/// window regardless of which source observed it — but `source` is always
/// 'claude-statusline', the provenance label the #65/#108 fingerprint
/// machinery and the presentation layer key off.
export function statuslineSnapshotsFromCapture(capture) {
  if (!capture || typeof capture !== 'object') return [];
  const observedAt = typeof capture.observedAt === 'string' && !Number.isNaN(Date.parse(capture.observedAt))
    ? new Date(Date.parse(capture.observedAt)).toISOString()
    : null;
  if (!observedAt) return [];
  const snapshots = [];
  for (const [key, scope] of [['five_hour', '5-hour'], ['seven_day', 'weekly']]) {
    const window = captureWindow(capture[key]);
    if (!window) continue;
    snapshots.push({
      scope,
      usedPercent: window.used_percentage,
      resetsAt: window.resets_at,
      observedAt,
      source: 'claude-statusline',
      detail: {},
    });
  }
  return snapshots;
}

/// The statusLine command string written into a profile's settings.json.
/// Absolute paths only — the statusline runs inside Claude Code's shell with
/// an unknown PATH. `chainCommand` is the user's pre-existing statusLine
/// command, carried as base64 so its own quoting survives ours untouched.
export function buildStatuslineCommand({ execPath, scriptPath, captureFile, chainCommand, sea = isSea() } = {}) {
  if (!execPath) throw new Error('statusline executable path is required');
  if (!captureFile) throw new Error('statusline capture file path is required');
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  const parts = [quote(execPath)];
  if (sea) parts.push(STATUSLINE_SEA_COMMAND);
  else {
    if (!scriptPath) throw new Error('statusline script path is required outside SEA mode');
    parts.push(quote(scriptPath));
  }
  parts.push('--out', quote(captureFile));
  if (chainCommand) parts.push('--chain-b64', quote(Buffer.from(chainCommand, 'utf8').toString('base64')));
  return parts.join(' ');
}

/// Whether a settings.json statusLine command is ModelDeck's own tee (either
/// launch mode). Uninstall and idempotent re-install both key off this.
export function isModelDeckStatuslineCommand(command) {
  if (typeof command !== 'string') return false;
  return command.includes(STATUSLINE_SEA_COMMAND) || command.includes('claude-statusline.mjs');
}

/// The user's original chained command out of a ModelDeck tee command, or
/// null when the tee has no chain.
export function chainCommandFromStatuslineCommand(command) {
  const match = typeof command === 'string' && command.match(/--chain-b64 '([A-Za-z0-9+/=]+)'/);
  if (!match) return null;
  try { return Buffer.from(match[1], 'base64').toString('utf8'); } catch { return null; }
}

function argvValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/// Atomic (temp + rename) owner-only write, mirroring the daemon's shell-env
/// file discipline: a daemon read racing a statusline render never sees a
/// half-written capture.
function writeCaptureFileSync(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.modeldeck-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

/// The statusline tee entry point. Contract:
///   1. Chain first: when the user had their own statusLine command, run it
///      with the SAME stdin bytes and pass its stdout through UNTOUCHED —
///      opting into ModelDeck capture must never change what the user sees.
///   2. Then upsert: when the payload carries rate_limits windows, write the
///      per-profile capture file; otherwise leave it exactly as it was.
///   3. Never fail: malformed stdin, a broken chain command, or an
///      unwritable capture file must not surface as a statusline error.
/// Always returns 0.
export async function runStatuslineCli({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  spawnSync = nodeSpawnSync,
  writeCapture = writeCaptureFileSync,
  now = () => new Date(),
} = {}) {
  let input = Buffer.alloc(0);
  try { input = await readAll(stdin); } catch { /* no stdin: still exit 0 */ }

  const chainB64 = argvValue(argv, '--chain-b64');
  if (chainB64) {
    try {
      const chainCommand = Buffer.from(chainB64, 'base64').toString('utf8');
      const result = spawnSync('/bin/sh', ['-c', chainCommand], {
        input,
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      if (result?.stdout?.length) stdout.write(result.stdout);
    } catch { /* the chain is best-effort; capture continues below */ }
  }

  try {
    const out = argvValue(argv, '--out');
    if (!out) return 0;
    const rateLimits = parseStatuslineRateLimits(input.toString('utf8'));
    // Absence of rate_limits is normal (non-Pro/Max plans; first API
    // response pending) — write nothing, never error.
    if (!rateLimits) return 0;
    writeCapture(out, { ...rateLimits, observedAt: now().toISOString() });
  } catch { /* capture is best-effort; the statusline must never break */ }
  return 0;
}

const isMain = !isSea() && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runStatuslineCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
