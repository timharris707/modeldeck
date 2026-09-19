import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createProviderProfileHelpers } from './provider-profile.mjs';

// Decision 0035, stage two — the daemon half of the Grok quota probe.
//
// Shape mirrors the Claude adapter deliberately: validate the profile home,
// hand the credential to an isolated child process, parse its stdout into the
// SAME `{ scope, usedPercent, resetsAt, source, detail }` snapshots every
// other provider records. Nothing about scheduling, caching, or storage is
// Grok-specific — refreshGrok rides the existing refresh pass.

const execFileAsync = promisify(execFile);
const usageProbePath = isSea() ? null : fileURLToPath(new URL('./grok-usage-probe.mjs', import.meta.url));
export const GROK_SEA_PROBE_COMMAND = 'modeldeck-internal-grok-usage-probe';
export const GROK_SNAPSHOT_SOURCE = 'grok-billing-api';

const grokProfile = createProviderProfileHelpers({
  envVar: 'MODELDECK_GROK_HOME',
  envRequiredError: 'Grok profile home is required',
  invalidProfileNameError: 'Grok profile name is invalid',
  profilesDirRequiredError: 'ModelDeck Grok profiles directory is required',
  profilesDirMissingLabel: 'ModelDeck Grok profiles directory',
  profilesDirLabel: 'ModelDeck Grok profiles directory',
  profileHomeRequiredError: 'Grok profile home is required',
  profileHomeLabel: 'Grok profile home',
  destinationExistsLabel: 'Grok profile destination already exists',
  containmentErrorPrefix: "Grok profile home must be inside ModelDeck's profiles directory",
});

function errorMessage(error) {
  return error?.stderr?.trim() || error?.message || String(error);
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/// The window this percent belongs to. `current_period.type` states it
/// outright ("USAGE_PERIOD_TYPE_WEEKLY" / "…_MONTHLY"); when the field is
/// absent the period's own length is still evidence, so a stated start/end
/// pair decides it. With neither, the window stays honestly unnamed rather
/// than guessed — the percent is real either way.
export function grokPeriodScope(period) {
  const stated = String(period?.type ?? period?.periodType ?? period?.period_type ?? '').toLowerCase();
  if (stated.includes('week')) return 'weekly';
  if (stated.includes('month')) return 'monthly';
  const start = isoOrNull(period?.start ?? period?.startTime ?? period?.start_time);
  const end = isoOrNull(period?.end ?? period?.endTime ?? period?.end_time);
  if (start && end) {
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (days > 0) return days >= 27 ? 'monthly' : 'weekly';
  }
  return 'usage period';
}

/// `GET {base}/billing?format=credits` → deck snapshots.
export function parseGrokBilling(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) throw new Error('Grok usage output was empty');
    try { data = JSON.parse(trimmed); }
    catch { throw new Error('Grok usage output was not valid JSON'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Grok usage output did not contain a credit usage percent');
  }
  // The live `GET /billing?format=credits` reply nests the percent and period
  // under `config` (public issue #9, confirmed against the real endpoint);
  // `billing` and the bare object are the earlier guesses, still accepted.
  const carriesPercent = (value) => value && typeof value === 'object' && !Array.isArray(value)
    && (value.credit_usage_percent != null || value.creditUsagePercent != null);
  const billing = [data.config, data.billing].find(carriesPercent) ?? data;
  const percent = number(billing.credit_usage_percent ?? billing.creditUsagePercent);
  if (percent == null) throw new Error('Grok usage output did not contain a credit usage percent');
  const period = billing.current_period ?? billing.currentPeriod ?? null;
  const detail = {};
  const tier = text(billing.subscription_tier ?? billing.subscriptionTier);
  if (tier) detail.planType = tier;
  const periodType = text(period?.type ?? period?.periodType ?? period?.period_type);
  if (periodType) detail.periodType = periodType;
  return [{
    scope: grokPeriodScope(period),
    // Clamped: a provider that reports 104% of a pool must not render as a
    // negative "% left" on the card.
    usedPercent: Math.min(100, Math.max(0, percent)),
    resetsAt: isoOrNull(period?.end ?? period?.endTime ?? period?.end_time),
    source: GROK_SNAPSHOT_SOURCE,
    detail,
  }];
}

export function grokProfileEnv(grokHome, sourceEnv = process.env) {
  const env = grokProfile.profileEnv(grokHome, sourceEnv);
  // Test/staging override for the billing base; absent in every normal run.
  if (sourceEnv.MODELDECK_GROK_BILLING_BASE) {
    env.MODELDECK_GROK_BILLING_BASE = sourceEnv.MODELDECK_GROK_BILLING_BASE;
  }
  return env;
}

/// A real directory the current user owns, that nobody else can WRITE.
///
/// The threat CodeRabbit named (PR #559, CWE-732) is credential planting:
/// rejecting a symlinked `auth.json` buys nothing if another local user can
/// write the directory, because they can replace the credential with a
/// regular file of their own and the probe would send THEIR token.
///
/// Planting needs write access, and only write access — so that is what this
/// rejects. It deliberately does NOT demand chmod 700 the way Claude and
/// Codex profiles do, because ModelDeck creates those homes and merely reads
/// this one: a stock `~/.grok` ships 0755 with `auth.json` at 0600 (measured
/// on the maintainer's machine). World-READABLE is the grok CLI's own choice
/// and discloses nothing — the secret is already owner-only — so demanding
/// 0700 would refuse every stock install and buy nothing against planting.
export async function inspectGrokHomeDirectory(grokHome, {
  lstat = fs.promises.lstat,
  uid = process.getuid?.(),
} = {}) {
  let homeStat;
  try {
    homeStat = await lstat(grokHome);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      exists: false,
      isDirectory: false,
      ownedByCurrentUser: false,
      writableByOthers: false,
      permissionsOk: false,
    };
  }
  const isDirectory = homeStat.isDirectory() && !homeStat.isSymbolicLink();
  const ownedByCurrentUser = uid == null || homeStat.uid === uid;
  const writableByOthers = (homeStat.mode & 0o022) !== 0;
  return {
    exists: true,
    isDirectory,
    ownedByCurrentUser,
    writableByOthers,
    permissionsOk: isDirectory && ownedByCurrentUser && !writableByOthers,
  };
}

export async function assertGrokHomeDirectory(grokHome, {
  lstat = fs.promises.lstat,
  inspection = null,
} = {}) {
  const inspected = inspection || await inspectGrokHomeDirectory(grokHome, { lstat });
  if (!inspected.exists) throw new Error(`Grok profile home does not exist: ${grokHome}`);
  if (!inspected.isDirectory) {
    throw new Error(`Grok profile home must be a directory: ${grokHome}`);
  }
  if (!inspected.ownedByCurrentUser) {
    throw new Error('Grok profile home must be owned by the current user');
  }
  if (inspected.writableByOthers) {
    throw new Error(
      `Grok profile home must not be writable by anyone else (chmod g-w,o-w ${grokHome})`,
    );
  }
  return inspected;
}

/// The full gate: a home nobody else can write, holding a credential that is
/// a regular file nobody else can write either.
///
/// The file mask is the symmetric half of the directory mask (security
/// confirm on PR #559). Refusing a writable DIRECTORY stops a credential
/// being swapped by replacing the directory entry; it does nothing about a
/// world-writable `auth.json` inside a perfectly ordinary 0755 home, which
/// can be overwritten IN PLACE with no directory write at all. Same attack,
/// same outcome — the probe sends someone else's token — so the same rule.
///
/// As with the directory, only WRITABILITY is refused. A 0644 credential is
/// readable by other local users, which is the grok CLI's own choice to make
/// and not ours to police; we refuse only the bits that let someone change
/// what we are about to send.
///
/// Re-run on every refresh AND by the probe child immediately before reading,
/// so a home or credential loosened after registration is still caught.
export async function assertGrokProfileHome(grokHome, { lstat = fs.promises.lstat } = {}) {
  await assertGrokHomeDirectory(grokHome, { lstat });
  const credentialPath = path.join(grokHome, 'auth.json');
  const credentialStat = await lstat(credentialPath).catch((error) => {
    if (error.code === 'ENOENT') {
      throw new Error('Grok profile does not contain stored credentials; sign in explicitly before refreshing');
    }
    throw error;
  });
  if (!credentialStat.isFile() || credentialStat.isSymbolicLink()) {
    throw new Error('Grok credentials must be a regular file inside the selected profile home');
  }
  if ((credentialStat.mode & 0o022) !== 0) {
    throw new Error(`Grok credentials must not be writable by anyone else (chmod 600 ${credentialPath})`);
  }
}

export async function fetchGrokUsage({
  grokHome,
  timeoutMs = 20_000,
  run = execFileAsync,
  lstat = fs.promises.lstat,
  sea = isSea(),
} = {}) {
  if (!grokHome) throw new Error('Grok profile home is required');
  await assertGrokProfileHome(grokHome, { lstat });
  let result;
  try {
    const probeArgs = sea ? [GROK_SEA_PROBE_COMMAND] : [usageProbePath];
    result = await run(process.execPath, probeArgs, {
      env: grokProfileEnv(grokHome),
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
    });
  } catch (error) {
    throw new Error(`Grok usage refresh failed: ${errorMessage(error)}`);
  }
  return parseGrokBilling(result?.stdout ?? result);
}
