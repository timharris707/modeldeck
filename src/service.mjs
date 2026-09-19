import crypto from 'node:crypto';
import { updateProviderShellHook } from './provider-shell-env.mjs';
import { activeLinkBlockedError, moveLegacyHome, safeProfileName } from './adapters/provider-profile.mjs';
import { execFile, spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  activateClaudeProfile,
  adoptLegacyClaudeHome,
  claudePinnedEnvFileContent,
  claudeProxyPointerShellSnippet,
  createClaudeProfileHome,
  fetchClaudeUsage,
  importClaudeSwapProfiles as migrateClaudeSwapProfiles,
  readClaudeAuthStatus,
  readClaudeProfileIdentity,
  readClaudeRateLimitTier,
  validateClaudeProfileHome,
} from './adapters/claude.mjs';
import {
  claudeCredentialKeychainSlotState,
  claudeCredentialsPresent,
} from './adapters/claude-keychain.mjs';
import { reconcileClaudeProfileExplainer } from './adapters/claude-profile-explainer.mjs';
import { reconcileSharedTranscripts, sharedTranscriptState } from './shared-transcripts.mjs';
import {
  assertGrokHomeDirectory,
  fetchGrokUsage,
  inspectGrokHomeDirectory,
} from './adapters/grok.mjs';
import {
  buildStatuslineCommand,
  chainCommandFromStatuslineCommand,
  execPathFromStatuslineCommand,
  isModelDeckStatuslineCommand,
  STATUSLINE_SESSION_MARKER_TTL_MS,
  statuslineSessionDir,
  statuslineSnapshotsFromCapture,
} from './adapters/claude-statusline.mjs';
import {
  LEGACY_CLIENT_KEY_HELPER,
  classifyClaudeHelper,
  clientKeyHelperCommand,
  clientKeyService,
  clientKeyServiceForRecord,
} from './client-key-helper.mjs';
import { claudeModelTier, isModelDowngrade, isModelRecovery } from './model-tier.mjs';
import {
  createCodexProfileHome,
  fetchCodexRateLimits,
  readCodexAccountId,
  readCodexLoginStatus,
  readCodexPlan,
  validateCodexProfileHome,
} from './adapters/codex.mjs';
import { evaluateWorstCapacity } from './capacity.mjs';
import {
  decideProxyReloginAvailability,
  isSettledProxyReloginPhase,
  PROXY_CREDENTIAL_HEALTH_TTL_MS,
  PROXY_RELOGIN_SESSION_TTL_MS,
  proxyCredentialHealthFromAuthFiles,
  ProxyReloginDriver,
  ProxyReloginError,
  proxyReloginFailureText,
  proxyReloginNextPhase,
} from './proxy-relogin.mjs';
import {
  OTEL_QUARANTINE_PRUNE_BATCH_SIZE,
  OTEL_QUARANTINE_RETENTION_DAYS,
  REQUEST_USAGE_PRUNE_BATCH_SIZE,
  REQUEST_USAGE_RETENTION_DAYS,
  USAGE_SNAPSHOT_PRUNE_BATCH_SIZE,
  USAGE_SNAPSHOT_RETENTION_DAYS,
} from './db.mjs';
import { scanProjectRoot } from './projects.mjs';
import { inspectJsonObjectAt, inspectJsonObjectDocument, SharedScopeEngine } from './shared-scope.mjs';
import {
  UsageQueueConsumer,
  USAGE_QUEUE_CONSUMER_INTERVAL_MS,
  usageQueueWarningCount,
} from './usage-queue-consumer.mjs';
import {
  detectForeignUsageConsumers,
  RETIRED_USAGE_CONSUMER_LABELS,
} from './usage-queue-guard.mjs';
import { ingestTranscriptArchive } from './transcript-ingest.mjs';
import { ingestCodexRollouts } from './codex-rollout-ingest.mjs';
import { ingestGrokSessions } from './grok-session-ingest.mjs';
import { runDiagnostician as scanDiagnostician } from './diagnostician.mjs';
import { refitUsageEstimates } from './usage-estimate.mjs';
import { collectConfigLintSnapshot, configLintSnapshotOptions } from './config-linter-snapshot.mjs';
import { configLintFailureFindings, evaluateConfigLint } from './config-linter.mjs';
import { CODEX_PROFILES_DIR } from './paths.mjs';
import { migrateCodexProfilesDir, legacyCodexProfilesUsage } from './codex-profiles-migration.mjs';

const execFileAsync = promisify(execFile);

// Active sessions throttle scheduled polling, but never for long enough to
// let a continuously open provider session make the deck silently stale.
//
// Issue #90 (Tim's design call, 2026-07-21): this cap applies ONLY while the
// user has never customized autoRefreshIntervalSeconds. An explicitly
// configured interval always wins — it was set for a reason, and the account
// being actively burned is precisely the one whose data must stay fresh.
// Whenever the cap slows the effective cadence below the configured setting,
// /api/state says so (scheduler.effectiveRefreshReason) so the deck can be
// honest about it instead of silently starving.
const ACTIVE_SESSION_REFRESH_CAP_MS = 30 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
export const USAGE_SNAPSHOT_PRUNE_INTERVAL_MS = DAY_MS;
const USAGE_SNAPSHOT_FIRST_PRUNE_DELAY_MS = 30_000;
const OTEL_QUARANTINE_PRUNE_PAUSE_MS = 25;
const OTEL_QUARANTINE_CHECKPOINT_BATCHES = 20;
export const WAREHOUSE_INGEST_INTERVAL_MS = 15 * 60_000;
export const CONFIG_LINT_INTERVAL_MS = DAY_MS;

// Three consecutive routed failures suppress isolated provider/network blips
// while exposing a deterministic expired credential on its third attempted
// request. This is request-count based, so sparse and busy members get the
// same evidence bar without adding a clock or polling loop.
export const MEMBER_BLACKOUT_FAILURE_THRESHOLD = 3;
const MEMBER_BLACKOUT_REMEDY = 'Sign in again to restore proxy routing.';
// Issue #572: an overload-class streak (5xx incl. Anthropic's 529, plus
// timeout/rate-limit) is the provider's problem, not the credential's —
// telling the user to sign in again is the wrong remedy, and the live
// incident wore it for a day. Classified on the streak's latest status code.
const MEMBER_BLACKOUT_TRANSIENT_REMEDY = 'No action needed because a successful request through this subscription clears the alert.';

export function memberBlackoutTransientStatus(statusCode) {
  return statusCode != null && ((statusCode >= 500 && statusCode <= 599) || statusCode === 408 || statusCode === 429);
}

/// Issue #539: the pool identities the proxy reports as `active` — a finished
/// sign-in, not a refresh in progress. Keyed exactly like
/// `proxyCredentialHealthFromAuthFiles` (Claude by lowercased email, Codex by
/// remembered account id) so membership, health, and this can never disagree
/// about who they describe. Healthy-wins, the same as the health fold: one
/// live active file for an identity is enough.
function proxyCredentialActiveIdentities(entries) {
  const active = new Set();
  for (const entry of entries) {
    if (entry.disabled || entry.unavailable || entry.status !== 'active') continue;
    if ((entry.provider === 'claude' || entry.provider === 'anthropic') && entry.email) {
      active.add(`claude:${entry.email}`);
    } else if ((entry.provider === 'codex' || entry.provider === 'openai') && entry.codexAccountId) {
      active.add(`codex:${entry.codexAccountId}`);
    }
  }
  return active;
}

/// True when both instants parse and `later` is strictly after `earlier`.
/// Anything unparseable answers false, so a comparison that cannot be made
/// never softens an alert.
function isLaterInstant(later, earlier) {
  const a = Date.parse(later ?? '');
  const b = Date.parse(earlier ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

// Issue #377. A model-scoped weekly window this used is the reason the
// session fell off that model. Not 100: the window observation is at most one
// statusline render old, and Claude Code stops routing the model a shade
// before the window reads exactly full. Below this the drop is reported with
// its cause honestly unknown rather than guessed.
export const MODEL_DROP_QUOTA_PERCENT = 95;

const CLAUDE_RENEWAL_TIMEOUT_MS = 60_000;
// Issue #484: the longest existing credential budget is the five-minute
// browser OAuth watcher, and renewal can stack several bounded 60-second
// CLI/probe stages close to that. Six minutes preserves the established auth
// ceiling plus one minute of cleanup margin while guaranteeing a deadline.
const DEFAULT_CLAUDE_ACTIVATION_OPERATION_TIMEOUT_MS = 6 * 60_000;
// The Mac client's plain activation request has a five-second transport
// timeout. Fail a starved queue one second earlier so the daemon can return a
// typed response instead of making the app guess from a network timeout.
const DEFAULT_CLAUDE_ACTIVATION_QUEUE_TIMEOUT_MS = 4_000;
const CLAUDE_RENEWAL_BACKOFF_MS = 30 * 60_000;
const CLAUDE_RENEWAL_DAY_MS = 24 * 60 * 60_000;
const CLAUDE_RENEWAL_DAILY_LIMIT = 6;
const CLAUDE_RENEWAL_MODEL = 'claude-haiku-4-5-20251001';
// Issue #251 (Tim field report): the busy deferral must READ as what it is —
// queued automation, nothing for the user to do. The promise leads so the
// deck card's one-line truncation can never cut it ("Will renew
// automatically…" survives; the old order truncated to "…ModelDeck will
// renew…", which read as a failed to-do).
const CLAUDE_RENEWAL_BUSY_DETAIL = 'Will renew automatically at the next quiet moment — a Claude session is running right now.';
const CLAUDE_RENEWAL_BUDGET_OUTCOMES = new Set(['renewed', 'failed']);
const CLAUDE_AUTH_OVERRIDE_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
];
// Issue #224: only the credential keys make renewal meaningless — a profile
// whose settings env sets ANTHROPIC_BASE_URL alone (the CLIProxyAPI route)
// still authenticates with the stored OAuth ModelDeck manages, so renewal
// proceeds with the base URL pinned back to Anthropic for the renewal child.
const CLAUDE_AUTH_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];
const CLAUDE_RENEWAL_SETTINGS_OVERRIDE = JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
});
const CLAUDE_AUTH_OVERRIDE_ABSENT = Object.freeze({
  authOverride: false,
  proxyRouted: false,
  cliproxyRouted: false,
  helperRouted: false,
});

/// Issue #522: the pre-per-profile shared helper, kept under its historic
/// export name because it is still what an un-migrated profile is wired to
/// and what the guard admits without an ownership record.
export const CLIPROXY_API_KEY_HELPER = LEGACY_CLIENT_KEY_HELPER;
export const DEFAULT_CLIPROXY_BASE_URL = 'http://127.0.0.1:8317';
const DEFAULT_PROXY_JOIN_POLL_INTERVAL_MS = 2_000;
const DEFAULT_PROXY_JOIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PROXY_JOIN_TERMINATION_GRACE_MS = 2_000;

// A CLIProxyAPI instance is local by definition; anything else (corporate
// gateway, an explicit api.anthropic.com) must never receive the client key.
function isLoopbackUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

const CLAUDE_RENEWAL_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const CLAUDE_RENEWAL_EMAIL_KEYS = new Set([
  'email', 'emailaddress', 'email_address', 'signedinas', 'signed_in_as',
]);
const CLAUDE_RENEWAL_UUID_KEYS = new Set(['accountuuid', 'account_uuid']);
const CLAUDE_RENEWAL_AUTHENTICATED_KEYS = new Set([
  'authenticated', 'isauthenticated', 'is_authenticated', 'loggedin', 'logged_in',
]);

// Issue #199: `claude auth status --json` is allowed to authorize a renewal
// without flipping ~/.claude only when the command itself names the intended
// account. Keep this parser deliberately stricter than the onboarding status
// parser: no plain-text fallback, and no search for arbitrary email-shaped
// strings or generic IDs elsewhere in the payload.
function claudeRenewalStatusIdentity(output) {
  const text = String(output ?? '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (parsed == null || typeof parsed !== 'object') return null;

  const identity = {
    emails: new Set(),
    accountUuids: new Set(),
    malformed: false,
    explicitlyUnauthenticated: false,
  };
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (CLAUDE_RENEWAL_EMAIL_KEYS.has(normalizedKey) && typeof item === 'string' && item.trim()) {
        const email = item.trim().toLowerCase();
        if (CLAUDE_RENEWAL_EMAIL_PATTERN.test(email)) identity.emails.add(email);
        else identity.malformed = true;
      }
      if (CLAUDE_RENEWAL_UUID_KEYS.has(normalizedKey) && typeof item === 'string' && item.trim()) {
        identity.accountUuids.add(item.trim());
      }
      if (CLAUDE_RENEWAL_AUTHENTICATED_KEYS.has(normalizedKey)
        && (item === false || (typeof item === 'string' && item.trim().toLowerCase() === 'false'))) {
        identity.explicitlyUnauthenticated = true;
      }
      visit(item, depth + 1);
    }
  };
  visit(parsed);
  return identity.emails.size || identity.accountUuids.size ? identity : null;
}

function claudeRenewalIdentityMatches(account, reported) {
  if (!reported || reported.malformed || reported.explicitlyUnauthenticated) return false;
  const expectedEmail = account?.identity?.trim().toLowerCase() || null;
  const expectedAccountUuid = typeof account?.metadata?.claudeAccountUuid === 'string'
    ? account.metadata.claudeAccountUuid.trim() || null
    : null;
  const comparisons = [];
  if (expectedEmail && reported.emails.size) {
    comparisons.push(...[...reported.emails].map((email) => email === expectedEmail));
  }
  if (expectedAccountUuid && reported.accountUuids.size) {
    comparisons.push(...[...reported.accountUuids].map((uuid) => uuid === expectedAccountUuid));
  }
  return comparisons.length > 0 && comparisons.every(Boolean);
}

// Issue #90 provenance: "customized" is the persisted change-event flag
// (db.mjs saveSettings flips it — permanently — when a write CHANGES the
// interval or the app asserts an explicit picker selection). Comparing the
// value against the default would strand users whose deliberate choice IS
// 300s (the issue's reporter) under the cap forever.
function autoRefreshIntervalCustomized(settings) {
  return settings.autoRefreshIntervalCustomized === true;
}

// Claude Code 2.1.215 is the first version verified against the undocumented
// CLAUDE_SECURESTORAGE_CONFIG_DIR scoped-Keychain behavior.
export const CLAUDE_SECURESTORAGE_MIN_VERSION = '2.1.215';

// Issue #99 historical boundary: 2.1.216 introduced resolved-home Keychain
// credential storage. Claude Code later reverted that behavior, but there is
// no trustworthy version-only transition to replace this gate. Issue #300
// therefore keeps the conservative flow selection while pinning the version
// probe and served login command to one canonical executable.
export const CLAUDE_RESOLVED_HOME_CREDENTIALS_MIN_VERSION = '2.1.216';

// Additive POST /verify diagnostic only. This describes metadata-only slot
// presence; it contains no credential value and is never persisted or copied
// into /api/state.
export const CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT = "A Claude credential exists in the default Keychain slot, but none was found for this ModelDeck profile. Run this account's login command again, then verify.";

// Additive POST /verify diagnostic only (issue #596): names where a stray
// login landed, same contract as the Keychain hint above. Fixed non-secret
// string — carries no identity or credential values and is never persisted
// or copied into /api/state. (PR #597 shipped a 30-minute-mtime variant of
// this; the review-hardening pass replaced the time window with the
// serve-time baseline below because unrelated config writes refresh the
// file's mtime constantly.)
export const CLAUDE_STRAY_LOGIN_VERIFY_HINT = "That sign-in went to a different Claude profile, not this one. Use the sign-in button on this card (not a plain terminal), then verify.";

// Issue #89: refresh failures whose message carries this phrase mean the
// stored credentials are unusable (missing or expired) — the account needs a
// fresh provider login, no matter what the presence probe says. Expired OAuth
// still LOOKS present to the Keychain/file probe, which is exactly how the
// chip stayed "Healthy" while the card rendered fossils.
// Issue #164 rides the same channel: both probes classify a provider-side
// dead-credential rejection (Codex app-server structured `code` in
// CODEX_DEAD_CREDENTIAL_CODES, Claude 401 `authentication_error`) into a
// message carrying this exact suffix, so authState flips to signin-required
// with signinReason "missing" — the amber "Sign in needed" + one-click
// path (#114/#118), never the calm #149 idle notice.
// Issue #636: the shell env writer exports ModelDeck's proxy client key
// into every fresh terminal of a proxy-routed profile (#277). A login run
// with that key in scope shows "API Usage Billing" and takes the
// paste-the-code path instead of the plain browser handoff. Both the
// session launcher and the login command drop OUR key first; a key the
// user set for their own tooling (no marker) is left alone.
export const CLAUDE_MANAGED_KEY_UNSET_FRAGMENT = 'if [ "${MODELDECK_MANAGED_ANTHROPIC_API_KEY:-}" = "1" ]; then unset ANTHROPIC_API_KEY MODELDECK_MANAGED_ANTHROPIC_API_KEY; fi';

export const SIGN_IN_REQUIRED_ERROR_PATTERN = /sign in explicitly before refreshing/i;

// Issue #149: the Claude probe emits two DISTINCT failures that both end in
// the suffix above — "stored OAuth credentials are unavailable; …" (genuine
// sign-out) vs "stored OAuth credentials have expired; …" (idle-decay: the
// credentials still exist and Claude Code renews them the next time the
// account is used). This prefix tells the expired case apart so the account
// payload can carry an ADDITIVE `signinReason: "missing" | "expired"`
// alongside the unchanged authState — old apps ignore the extra field, old
// daemons omit it (#65 honest-Unknown compat story). Never feeds authState.
export const SIGN_IN_EXPIRED_ERROR_PATTERN = /stored oauth credentials have expired/i;

// Issue #98: a refresh that failed because macOS refused the daemon's read of
// an EXISTING Claude Keychain item (the dismissed first-run prompt). Matches
// KEYCHAIN_DENIED_ERROR from src/adapters/claude-usage-probe.mjs as it
// arrives via the probe's stderr wrapping. Distinct from signin-required on
// purpose — the account IS signed in; the fix is "Refresh → Always Allow",
// never a new provider login.
export const KEYCHAIN_DENIED_ERROR_PATTERN = /keychain blocked modeldeck/i;

export function weeklyResetFingerprint(snapshots) {
  const weekly = snapshots.find((snapshot) => snapshot.scope === 'weekly');
  if (!weekly?.resetsAt || weekly.stale) return null;
  const resetMs = Date.parse(weekly.resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  return Math.round(resetMs / 1_000);
}

export function duplicateAccountIdsByFingerprint(fingerprints) {
  const accountsByResetSecond = new Map();
  for (const [accountId, resetSecond] of fingerprints) {
    const accountIds = accountsByResetSecond.get(resetSecond) || [];
    accountIds.push(accountId);
    accountsByResetSecond.set(resetSecond, accountIds);
  }
  return new Set([...accountsByResetSecond.values()].filter((ids) => ids.length > 1).flat());
}

export function duplicateClaudeTokenAccountIds(accountSnapshots) {
  const fingerprints = new Map();
  for (const [accountId, snapshots] of accountSnapshots) {
    const fingerprint = weeklyResetFingerprint(snapshots);
    if (fingerprint !== null) fingerprints.set(accountId, fingerprint);
  }
  return duplicateAccountIdsByFingerprint(fingerprints);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function jsonStringHasNonWhitespace(source, property) {
  if (!property || source[property.start] !== '"') return false;
  const simpleEscapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  for (let cursor = property.start + 1; cursor < property.end - 1; cursor += 1) {
    let character = source[cursor];
    if (character === '\\') {
      const escape = source[++cursor];
      if (escape === 'u') {
        character = String.fromCharCode(Number.parseInt(source.slice(cursor + 1, cursor + 5), 16));
        cursor += 4;
      } else {
        character = simpleEscapes[escape] ?? escape;
      }
    }
    if (!/\s/u.test(character)) return true;
  }
  return false;
}

function accountFor(store, provider, projectPath) {
  const project = store.resolveProject(projectPath);
  const mappedId = provider === 'claude' ? project?.claudeAccountId : project?.codexAccountId;
  const accounts = store.listAccounts().filter((account) => account.provider === provider && account.enabled);
  const account = (mappedId && accounts.find((item) => item.id === mappedId)) || accounts.find((item) => item.isDefault);
  return { project, account: account || null };
}

function semver(value) {
  const match = String(value || '').match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1] || null;
}

function compareSemver(left, right) {
  const parse = (value) => {
    const hyphen = value.indexOf('-');
    const core = hyphen === -1 ? value : value.slice(0, hyphen);
    const prerelease = hyphen === -1 ? undefined : value.slice(hyphen + 1);
    return { core: core.split('.').map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease == null) return 1;
  if (b.prerelease == null) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function errorMessage(error) {
  return error?.stderr?.trim() || error?.message || String(error);
}

function outputTail(result, limit = 8_000) {
  const output = `${result?.stdout ?? ''}${result?.stderr ? `\n${result.stderr}` : ''}`.trim();
  return output.length > limit ? output.slice(-limit) : output;
}

function updaterEnv(extra = {}, sourceEnv = process.env) {
  const allowed = [
    'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  ];
  return {
    ...Object.fromEntries(allowed.filter((key) => sourceEnv[key]).map((key) => [key, sourceEnv[key]])),
    ...extra,
  };
}

function proxyLoginEnv(sourceEnv = process.env) {
  const identity = ['USER', 'LOGNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
  return updaterEnv(
    Object.fromEntries(identity.filter((key) => sourceEnv[key]).map((key) => [key, sourceEnv[key]])),
    sourceEnv,
  );
}

class ToolUpdateConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

class ClaudeRenewalConflictError extends Error {
  constructor() {
    super('a Claude account renewal is already in progress');
    this.statusCode = 409;
  }
}

class ClaudeIdentityVerificationConflictError extends Error {
  constructor() {
    super('Claude identity verification conflicts with an in-flight operation for this account');
    this.statusCode = 409;
  }
}

class ProxyPoolJoinConflictError extends Error {
  constructor(provider) {
    super(`a ${provider} proxy-pool join is already in progress`);
    this.statusCode = 409;
  }
}

class ClaudeProxyRoutingConflictError extends Error {
  constructor(operation) {
    super(`cannot change proxy routing while this account's Claude ${operation} is in progress`);
    this.statusCode = 409;
  }
}

class ClaudeActivationQueueTimeoutError extends Error {
  constructor() {
    super('This Claude activation request timed out while queued behind earlier account work. It did not start; retry after the earlier operation finishes.');
    this.statusCode = 503;
    this.code = 'claude-activation-queue-timeout';
  }
}

class ClaudeActivationOperationTimeoutError extends Error {
  constructor() {
    super('Claude account work exceeded its safety limit. The underlying operation may still be running, so ModelDeck is refusing overlapping credential changes until it stops.');
    this.statusCode = 504;
    this.code = 'claude-activation-operation-timeout';
  }
}

class ClaudeActivationOperationStillRunningError extends Error {
  constructor() {
    super('A timed-out Claude account operation is still running. This request did not start because overlapping credential changes are unsafe; retry after the earlier operation stops.');
    this.statusCode = 503;
    this.code = 'claude-activation-operation-still-running';
  }
}

class ClaudeProfileSettingsOperationTimeoutError extends Error {
  constructor() {
    super('Claude profile settings work exceeded its safety limit. The underlying settings operation may still be running; retry later.');
    this.statusCode = 504;
    this.code = 'claude-profile-settings-operation-timeout';
  }
}

function logClaudeActivationWatchdog(message) {
  try {
    console.error(message);
  } catch {
    // A broken stderr sink must not change lock safety or the API response.
  }
}

// Issue #520 bounds for the app's client-key report. The entry cap is a
// structural bound on a token-gated but still untrusted body; the empty-key
// hash is refused because a keyless proxy request reports `api_key: ""`
// (recon V1) and must always resolve to honest NULL.
const CLIENT_KEY_REPORT_MAX_ENTRIES = 1000;
// The generation ratchet's ceiling, and how far ahead of the applied value a
// single report may jump. The ceiling alone would only move the poisoning
// problem to a lower number; the jump bound is what makes it unreachable,
// since the counter can never be pushed far past reality in one step. Both
// are astronomically above real use: the app bumps once per provisioning.
const CLIENT_KEY_REPORT_MAX_GENERATION = 1_000_000_000;
export const CLIENT_KEY_REPORT_MAX_GENERATION_JUMP = 1_000_000;
const SHA256_OF_EMPTY_STRING = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const CLAUDE_UNMANAGE_UNAVAILABLE_REASON = 'Turning off account switching for Claude is not available yet. Your accounts and history are unchanged.';

function serviceError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function grokForeignHomeMessage(provider) {
  return `this directory is already registered as a ${provider} subscription's home; a Grok subscription needs its own`;
}

function unavailableGrokProfileInspection(requested, resolved = requested) {
  return {
    requested,
    path: resolved,
    exists: false,
    isDirectory: false,
    ownedByCurrentUser: false,
    writableByOthers: false,
    permissionsOk: false,
    alreadyRegisteredAs: null,
  };
}

const DEFAULT_GROK_HOME_DISCOVERY_ENTRY_LIMIT = 10_000;

async function grokCredentialsPresent(grokHome) {
  try {
    const credential = await fs.promises.lstat(path.join(grokHome, 'auth.json'));
    return credential.isFile() && !credential.isSymbolicLink();
  } catch {
    return false;
  }
}

async function openReadableDirectory(directory) {
  try {
    return await fs.promises.opendir(directory);
  } catch {
    return null;
  }
}

async function latestGrokSessionAt(sessionsRoot, entryLimit) {
  const cwdEntries = await openReadableDirectory(sessionsRoot);
  if (!cwdEntries) return null;
  let latestMtime = null;
  let entriesSeen = 0;
  for await (const cwd of cwdEntries) {
    entriesSeen += 1;
    if (entriesSeen > entryLimit) return null;
    if (!cwd.isDirectory() || cwd.isSymbolicLink()) continue;
    const cwdPath = path.join(sessionsRoot, cwd.name);
    const sessionEntries = await openReadableDirectory(cwdPath);
    if (!sessionEntries) continue;
    for await (const session of sessionEntries) {
      entriesSeen += 1;
      if (entriesSeen > entryLimit) return null;
      if (!session.isDirectory() || session.isSymbolicLink()) continue;
      const updatesPath = path.join(cwdPath, session.name, 'updates.jsonl');
      try {
        const updates = await fs.promises.lstat(updatesPath);
        if (!updates.isFile() || updates.isSymbolicLink()) continue;
        if (latestMtime == null || updates.mtimeMs > latestMtime) latestMtime = updates.mtimeMs;
      } catch { /* Missing or unreadable session metadata has no last-used time. */ }
    }
  }
  return latestMtime == null ? null : new Date(latestMtime).toISOString();
}

// JSON numbers are not all exactly representable as JavaScript Numbers. The
// routing mutation must preserve every untouched value, including large
// integers, -0, and deliberately formatted exponents. Node >=24 supplies the
// source token to the reviver and JSON.rawJSON lets stringify emit it without
// rounding; other JSON values retain their normal parsed semantics.
function parseJsonPreservingNumberValues(raw) {
  return JSON.parse(raw, (_key, value, context) => (
    typeof value === 'number' && typeof context?.source === 'string'
      ? JSON.rawJSON(context.source)
      : value
  ));
}

function isJsonObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(value));
}

function codexPlanMetadata(planType) {
  if (typeof planType !== 'string' || !planType.trim()) return null;
  const raw = planType.trim();
  const known = { pro: 'Pro', plus: 'Plus', team: 'Team', free: 'Free' };
  return {
    planType: raw,
    displayName: known[raw.toLowerCase()] || `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`,
  };
}

function managedProfile(profileRef, profilesDir, providerLabel) {
  const root = fs.realpathSync(profilesDir);
  const rootStat = fs.lstatSync(root);
  const profileStat = fs.lstatSync(profileRef);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) throw new Error(`ModelDeck ${providerLabel} profiles directory must use owner-only permissions`);
  if (!profileStat.isDirectory() || (profileStat.mode & 0o077) !== 0) throw new Error(`${providerLabel} profile home must use owner-only permissions`);
  if (process.getuid && (rootStat.uid !== process.getuid() || profileStat.uid !== process.getuid())) throw new Error(`${providerLabel} profile directories must be owned by the current user`);
  const canonical = fs.realpathSync(profileRef);
  const relative = path.relative(root, canonical);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${providerLabel} profile home must be inside ModelDeck's profiles directory: ${root}`);
  }
  return canonical;
}

function managedClaudeProfile(profileRef, profilesDir) {
  return managedProfile(profileRef, profilesDir, 'Claude');
}

function managedCodexProfile(profileRef, profilesDir) {
  return managedProfile(profileRef, profilesDir, 'Codex');
}

function isIso8601Timestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, zoneHourText, zoneMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const zoneHour = Number(zoneHourText);
    const zoneMinute = Number(zoneMinuteText);
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function managedProxyAppReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('managed proxy report must be an object');
  }
  const { managed, phase, pid, restartCount, appVersion, reportedAt } = input;
  if (typeof managed !== 'boolean') throw new Error('managed must be a boolean');
  if (typeof phase !== 'string' || phase.trim() === '') throw new Error('phase must be a non-empty string');
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('pid must be a positive integer or null');
  }
  if (restartCount !== null && (!Number.isSafeInteger(restartCount) || restartCount < 0)) {
    throw new Error('restartCount must be a non-negative integer or null');
  }
  if (appVersion !== null && (typeof appVersion !== 'string' || appVersion.trim() === '')) {
    throw new Error('appVersion must be a non-empty string or null');
  }
  if (!isIso8601Timestamp(reportedAt)) {
    throw new Error('reportedAt must be an ISO-8601 timestamp');
  }
  // Issue #432: discard fields a newer app adds rather than echoing facts
  // this daemon version does not understand.
  return { managed, phase, pid, restartCount, appVersion, reportedAt };
}

export class ModelDeckService {
  constructor(store, options = {}) {
    this.store = store;
    this.projectsRoot = options.projectsRoot;
    this.claudePath = options.claudePath || 'claude';
    this.claudeProfilesDir = options.claudeProfilesDir || path.join(os.homedir(), 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
    this.claudeActiveLink = options.claudeActiveLink || path.join(os.homedir(), '.claude');
    // Issue #596: where an UNPINNED `claude` writes its default .claude.json.
    // Defaults to the active link's parent (production: the user's home).
    // Note the coincidence is deliberate but not guaranteed — a nonstandard
    // MODELDECK_CLAUDE_ACTIVE_LINK override should override this too.
    this.claudeDefaultHome = options.claudeDefaultHome || path.dirname(this.claudeActiveLink);
    // Issue #596: per-account snapshot of the default home's identity, taken
    // when a login command is served, compared on signed-out verifies. Memory
    // only — never persisted, cleared on a successful verify.
    this.claudeStrayLoginBaseline = new Map();
    this.configLintZshenvPath = options.zshenvPath || path.join(os.homedir(), '.zshenv');
    this.configLintLaunchctlPath = options.launchctlPath || '/bin/launchctl';
    // Issue #66: shell snippet sourced by the install-shell-env.sh block so
    // new terminal sessions launch pinned to the active profile real path.
    // Defaults next to the profiles directory (production: the ModelDeck
    // Application Support directory) so test fixtures stay inside their roots.
    this.claudeShellEnvFile = options.claudeShellEnvFile
      || path.join(path.dirname(this.claudeProfilesDir), 'claude-env.sh');
    // Issue #174: per-profile statusline capture files live under ModelDeck's
    // own data dir (default: sibling of the profiles directory, matching
    // CLAUDE_STATUSLINE_DIR in src/paths.mjs) — never inside a provider
    // directory. The statusline command embeds the daemon's own executable:
    // the SEA binary re-enters through the argv marker; source mode runs the
    // adapter script with the same Node.
    this.claudeStatuslineDir = options.claudeStatuslineDir
      || path.join(path.dirname(this.claudeProfilesDir), 'statusline');
    // CLIProxyAPI auth dir (external tool; ModelDeck reads metadata only). No
    // homedir default here: only the production server wires the real path
    // (CLIPROXY_AUTH_DIR), so test fixtures can never accidentally read a
    // developer's live proxy files. Null = enrichment off.
    this.cliproxyAuthDir = options.cliproxyAuthDir || null;
    this.proxyAuthOpen = options.proxyAuthOpen || fs.promises.open;
    // CLIProxyAPI login owns browser OAuth. ModelDeck only starts it and
    // watches the configured auth directory for matching identity evidence.
    // Keep the binary/base URL configurable like claudePath/codexPath so a
    // packaged daemon never relies on a particular interactive shell PATH.
    this.cliproxyPath = options.cliproxyPath || options.cliproxyBin || 'cliproxyapi';
    this.cliproxyBaseUrl = options.cliproxyBaseUrl || DEFAULT_CLIPROXY_BASE_URL;
    // Issue #421: the proxy's shared state dir, for the observed-facts block
    // in /api/state. Same no-homedir-default rule as cliproxyAuthDir — only
    // the production server wires the real path, so a fixture can never
    // report on a developer's live proxy install. Null = nothing observed.
    this.cliproxyConfigDir = options.cliproxyConfigDir || null;
    this.cliproxyPathExists = options.cliproxyPathExists || ((target) => fs.existsSync(target));
    // Issue #625: the pool sign-in runs the binary that is actually serving
    // the proxy port, found through lsof. Unset = /usr/sbin/lsof on macOS and
    // no probe elsewhere; an explicit null disables the probe (tests inject
    // a path plus an `exec` double, so no fixture reaches the real lsof).
    this.lsofPath = options.lsofPath;
    this.processUid = options.processUid || (() => (typeof process.getuid === 'function' ? process.getuid() : null));
    // Issue #396: the in-app repair for an expired pool credential. Same
    // no-homedir-default rule — a fixture never receives a live key path, and
    // without one the repair reports itself unavailable WITH the reason
    // rather than failing at the first 401.
    this.cliproxyManagementKeyPath = options.cliproxyManagementKeyPath ?? null;
    this.proxyReloginDriver = options.proxyReloginDriver || new ProxyReloginDriver({
      baseUrl: this.cliproxyBaseUrl,
      managementKeyPath: this.cliproxyManagementKeyPath,
      fetcher: options.proxyReloginFetch || globalThis.fetch,
      readFile: options.proxyReloginReadFile || fs.promises.readFile,
      requestTimeoutMs: options.proxyReloginRequestTimeoutMs,
    });
    // One in-flight sign-in per account; the proxy's own waiter expires after
    // five minutes, so a session outliving that is reported as expired.
    this.proxyReloginSessions = new Map();
    // CodeRabbit (PR #435): the session record lands only after the driver's
    // start round trip, so the already-in-progress guard cannot span the
    // await on its own — the in-flight start is registered synchronously,
    // same discipline as proxyJoinPromises.
    this.proxyReloginStarts = new Map();
    this.proxyReloginNow = options.proxyReloginNow || (() => Date.now());
    this.proxyCredentialHealthCache = null;
    // Issue #539: the last credential verdict this daemon saw per pool
    // identity, and when that verdict last CHANGED to ok. Presentation
    // metadata only — it never enters the streak math (doctrine 0034).
    this.proxyCredentialObservations = new Map();
    // A plain service fixture never receives a live management-key path. The
    // production server wires src/paths.mjs explicitly; tests wire only temp
    // key files and loopback stubs. Credential material is read inside pull().
    this.usageQueueConsumer = options.usageQueueConsumer || new UsageQueueConsumer({
      store: this.store,
      managementKeyPath: options.cliproxyManagementKeyPath ?? null,
      baseUrl: options.usageQueueBaseUrl || this.cliproxyBaseUrl,
      machine: options.usageQueueMachine || 'studio',
      fetcher: options.usageQueueFetch || globalThis.fetch,
      readFile: options.usageQueueReadFile || fs.promises.readFile,
      warn: options.warnUsageQueue,
      log: options.logUsageQueue,
      requestTimeoutMs: options.usageQueueRequestTimeoutMs,
    });
    this.detectForeignUsageConsumers = options.detectForeignUsageConsumers
      || ((guardOptions) => (options.platform || process.platform) === 'darwin'
        ? detectForeignUsageConsumers({
          exec: this.exec,
          uid: options.uid,
          ...guardOptions,
        })
        : Promise.resolve({ checked: true, consumers: [], probe: 'ok' }));
    this.logUsageQueueGuard = options.logUsageQueueGuard
      || ((message) => console.error(`[modeldeck] ${message}`));
    this.spawn = options.spawn || spawnChild;
    const proxyJoinPollIntervalMs = Number(options.proxyJoinPollIntervalMs ?? DEFAULT_PROXY_JOIN_POLL_INTERVAL_MS);
    const proxyJoinTimeoutMs = Number(options.proxyJoinTimeoutMs ?? DEFAULT_PROXY_JOIN_TIMEOUT_MS);
    const proxyJoinTerminationGraceMs = Number(options.proxyJoinTerminationGraceMs ?? DEFAULT_PROXY_JOIN_TERMINATION_GRACE_MS);
    this.proxyJoinPollIntervalMs = Number.isFinite(proxyJoinPollIntervalMs) && proxyJoinPollIntervalMs > 0
      ? proxyJoinPollIntervalMs
      : DEFAULT_PROXY_JOIN_POLL_INTERVAL_MS;
    this.proxyJoinTimeoutMs = Number.isFinite(proxyJoinTimeoutMs) && proxyJoinTimeoutMs > 0
      ? proxyJoinTimeoutMs
      : DEFAULT_PROXY_JOIN_TIMEOUT_MS;
    this.proxyJoinTerminationGraceMs = Number.isFinite(proxyJoinTerminationGraceMs) && proxyJoinTerminationGraceMs > 0
      ? proxyJoinTerminationGraceMs
      : DEFAULT_PROXY_JOIN_TERMINATION_GRACE_MS;
    this.proxyJoinWait = options.proxyJoinWait || ((signal, duration) => new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => resolve(false), duration);
      signal.then(() => {
        globalThis.clearTimeout(timer);
        resolve(true);
      });
    }));
    this.proxyJoinNow = options.proxyJoinNow || (() => globalThis.performance.now());
    this.proxyJoinPromises = new Map();
    this.dataDir = options.dataDir || path.dirname(this.claudeProfilesDir);
    this.configLintDbPath = options.dbPath || path.join(this.dataDir, 'modeldeck.sqlite');
    this.claudeRenewalScratchDir = options.claudeRenewalScratchDir
      || path.join(this.dataDir, 'claude-renewal');
    this.statuslineExecPath = options.statuslineExecPath || process.execPath;
    this.statuslineSea = options.statuslineSea ?? isSea();
    // Issue #185: the daemon can outlive its own executable — a staged
    // release bundle (temp worktree) registers launchd, the worktree is
    // deleted, and the running process keeps answering /api/state while
    // every SEA self-spawn (the Claude usage probe) fails ENOENT. The app
    // can only repair what the daemon admits, so /api/state self-reports
    // whether the executable still exists on disk.
    this.daemonExecPath = options.daemonExecPath || process.execPath;
    this.daemonExecPathExists = options.daemonExecPathExists
      || ((execPath) => fs.existsSync(execPath));
    this.daemonSea = options.daemonSea ?? isSea();
    // Build commit the running process was compiled from (server.mjs inlines
    // it at SEA build time). Self-reported so the app can tell a stale
    // still-running daemon apart from the build it just registered.
    this.daemonGitCommit = options.daemonGitCommit || null;
    this.statuslineScriptPath = options.statuslineScriptPath
      || (this.statuslineSea ? null : fileURLToPath(new URL('./adapters/claude-statusline.mjs', import.meta.url)));
    this.statuslineWatcher = null;
    this.statuslineIngestTimer = null;
    this.codexPath = options.codexPath || 'codex';
    this.codexActiveLink = options.codexActiveLink || path.join(os.homedir(), '.codex');
    this.codexProfilesDir = options.codexProfilesDir || CODEX_PROFILES_DIR;
    // Only the production composition root supplies the legacy home. Isolated
    // services must never discover or migrate a developer's live credentials.
    this.codexLegacyProfilesDir = options.codexLegacyProfilesDir || null;
    this.codexMigrationOptions = options.codexMigrationOptions || {};
    this.logCodexMigration = options.logCodexMigration || ((message) => console.error(`[modeldeck] ${message}`));
    this.codexProfilesMigrationWarning = null;
    this.codexProfilesMigrationBlocked = false;
    this.codexProfilesMigrationPromise = null;
    this.codexProfilesMigrationTimer = null;
    this.codexProfilesMigrationStopped = false;
    this.codexProfilesMigration = null;
    this.codexProfilesMigrationReaders = 0;
    this.codexShellEnvFile = options.codexShellEnvFile || path.join(this.dataDir, 'codex-env.sh');
    this.providerManagementOperations = new Set();
    this.providerTakeovers = new Set();
    this.codexActivationCount = 0;
    this.moveLegacyHome = options.moveLegacyHome || moveLegacyHome;
    this.initializeProviderManagement();
    // External Grok data is opt-in at this seam. The production composition
    // root passes GROK_SESSIONS_DIR; isolated service fixtures therefore cannot
    // fall through to the user's real ~/.grok store.
    this.grokSessionsDir = options.grokSessionsDir || null;
    this.grokHome = options.grokHome || (this.grokSessionsDir ? path.dirname(this.grokSessionsDir) : null);
    const grokHomeDiscoveryEntryLimit = Number(
      options.grokHomeDiscoveryEntryLimit ?? DEFAULT_GROK_HOME_DISCOVERY_ENTRY_LIMIT,
    );
    this.grokHomeDiscoveryEntryLimit = Number.isSafeInteger(grokHomeDiscoveryEntryLimit)
      && grokHomeDiscoveryEntryLimit > 0
      ? grokHomeDiscoveryEntryLimit
      : DEFAULT_GROK_HOME_DISCOVERY_ENTRY_LIMIT;
    this.fetchClaude = options.fetchClaude || fetchClaudeUsage;
    this.fetchCodex = options.fetchCodex || fetchCodexRateLimits;
    this.fetchGrok = options.fetchGrok || fetchGrokUsage;
    this.activateClaude = (...args) => {
      this.requireManaged('claude');
      return (options.activateClaude || activateClaudeProfile)(...args);
    };
    this.sharedTranscriptWarnings = new Map();
    this.sharedTranscriptTasks = new Map();
    this.sharedTranscriptCounts = new Map();
    this.createClaudeProfile = options.createClaudeProfile || createClaudeProfileHome;
    // A numbered fresh home can be another add's base name. Reserve the
    // provider through creation and rollback so neither can adopt it early.
    this.accountProfileCreations = new Set();
    this.ensureClaudeProfileExplainer = options.reconcileClaudeProfileExplainer
      || reconcileClaudeProfileExplainer;
    this.createCodexProfile = options.createCodexProfile || createCodexProfileHome;
    this.readClaudeAuth = options.readClaudeAuth || readClaudeAuthStatus;
    this.readClaudeTier = options.readClaudeTier || readClaudeRateLimitTier;
    this.readClaudeIdentity = options.readClaudeIdentity || readClaudeProfileIdentity;
    this.readCodexAuth = options.readCodexAuth || readCodexLoginStatus;
    this.readCodexPlan = options.readCodexPlan || readCodexPlan;
    this.readCodexAccountId = options.readCodexAccountId || readCodexAccountId;
    this.claudeCredentialsPresent = options.claudeCredentialsPresent || claudeCredentialsPresent;
    this.claudeCredentialKeychainSlotState = options.claudeCredentialKeychainSlotState
      || claudeCredentialKeychainSlotState;
    this.migrateClaude = options.migrateClaude || migrateClaudeSwapProfiles;
    this.adoptClaudeLegacy = options.adoptClaudeLegacy || adoptLegacyClaudeHome;
    this.exec = options.exec || options.execFile || options.run || execFileAsync;
    // Issue #2 (public tracker): the bundled daemon's launchd plist carries a
    // static PATH, and launchd never expands $HOME — so PATH alone cannot see
    // home-relative install directories like ~/.local/bin, where Anthropic's
    // native installer puts `claude`. These directories are probed by
    // absolute path whenever PATH resolution comes up empty.
    this.toolPathFallbackDirs = options.toolPathFallbackDirs || [
      path.join(os.homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    this.childEnv = options.childEnv || process.env;
    this.configLintEnabled = options.configLintEnabled === true;
    this.userInfo = options.userInfo || os.userInfo;
    this.listProviderProcesses = options.listProviderProcesses || (async () => {
      const result = await this.exec('/bin/ps', ['-U', os.userInfo().username, '-o', 'comm='], {
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      return String(result?.stdout ?? result)
        .split(/\r?\n/)
        .map((command) => path.basename(command.trim()))
        // Decision 0022's pause/cap discipline covers every provider the deck
        // refreshes — a live grok session is exactly as much "active" as a
        // live claude or codex one.
        .filter((command) => command === 'claude' || command === 'codex' || command === 'grok');
    });
    this.registryFetch = options.registryFetch || options.fetcher || globalThis.fetch;
    this.toolProbeTtlMs = Number(options.toolProbeTtlMs ?? 30 * 60_000);
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.yieldToServeLoop = options.yieldToServeLoop
      || (() => new Promise((resolve) => setImmediate(resolve)));
    this.logUsageSnapshotPrune = options.logUsageSnapshotPrune
      || ((count) => {
        if (count > 0) console.log(`[modeldeck] usage snapshots pruned: ${count}`);
      });
    this.logRequestUsagePrune = options.logRequestUsagePrune
      || ((count) => console.log(`[modeldeck] request usage pruned: ${count}`));
    this.logOtelQuarantinePrune = options.logOtelQuarantinePrune
      || ((count, elapsedMs) => console.log(`[modeldeck] OTLP quarantine pruned: ${count} rows in ${(elapsedMs / 1_000).toFixed(2)} s`));
    this.usageSnapshotPruneTimer = null;
    this.usageSnapshotPrunePromise = null;
    this.requestUsagePrunePromise = null;
    this.otelQuarantinePrunePromise = null;
    this.usageSnapshotPruneStarted = false;
    this.usageSnapshotPruneWaitingForState = false;
    this.usageSnapshotPruneGeneration = 0;
    this.usageQueueConsumerTimer = null;
    this.usageQueueConsumerPromise = null;
    this.usageQueueConsumerStarted = false;
    this.usageQueueConsumerGeneration = 0;
    this.usageQueueConsumerScheduledEnabled = null;
    this.usageQueueGuard = {
      status: 'not-checked',
      checkedAt: null,
      foreignConsumers: [],
      message: null,
    };
    this.usageQueueGuardPromise = null;
    this.usageQueueLastPull = null;
    // Issue #432: app-owned process state is memory-only. A daemon restart
    // honestly forgets it until the app reports another lifecycle transition.
    this.managedProxyAppReport = null;
    this.ingestTranscriptArchive = options.ingestTranscriptArchive || ingestTranscriptArchive;
    this.ingestCodexRollouts = options.ingestCodexRollouts || ingestCodexRollouts;
    this.ingestGrokSessions = options.ingestGrokSessions || ingestGrokSessions;
    this.runDiagnostician = options.runDiagnostician || scanDiagnostician;
    this.refitUsageEstimates = options.refitUsageEstimates || refitUsageEstimates;
    this.warehouseIngestMachine = options.warehouseIngestMachine || 'studio';
    this.logWarehouseIngest = options.logWarehouseIngest
      || ((message) => console.error(`[modeldeck] ${message}`));
    this.warehouseIngestTimer = null;
    this.warehouseIngestPromise = null;
    this.warehouseIngestActive = false;
    this.warehouseIngestStarted = false;
    this.warehouseIngestGeneration = 0;
    this.warehouseIngestScheduledEnabled = null;
    this.warehouseIngestLastPass = null;
    this.autoRefreshInitialDelayMs = Number(options.autoRefreshInitialDelayMs ?? 1_000);
    this.autoRefreshTimer = null;
    this.autoRefreshGeneration = 0;
    this.autoRefreshStarted = false;
    this.autoRefreshStartupTasks = new Set();
    this.autoRefreshTickTasks = new Set();
    this.lastCompletedRefreshAt = null;
    this.pausedForActiveSessions = false;
    this.activeProviderSessionPresent = false;
    this.refreshPromise = null;
    // Issue #176: every operation that flips ~/.claude shares this queue.
    // Renewal additionally has an immediate conflict guard because its HTTP
    // contract returns 409 for a second renewal instead of silently queuing it.
    const activationOperationTimeoutMs = Number(
      options.claudeActivationOperationTimeoutMs ?? DEFAULT_CLAUDE_ACTIVATION_OPERATION_TIMEOUT_MS,
    );
    const activationQueueTimeoutMs = Number(
      options.claudeActivationQueueTimeoutMs ?? DEFAULT_CLAUDE_ACTIVATION_QUEUE_TIMEOUT_MS,
    );
    this.claudeActivationOperationTimeoutMs = Number.isFinite(activationOperationTimeoutMs)
      && activationOperationTimeoutMs > 0
      ? activationOperationTimeoutMs
      : DEFAULT_CLAUDE_ACTIVATION_OPERATION_TIMEOUT_MS;
    this.claudeActivationQueueTimeoutMs = Number.isFinite(activationQueueTimeoutMs)
      && activationQueueTimeoutMs > 0
      ? activationQueueTimeoutMs
      : DEFAULT_CLAUDE_ACTIVATION_QUEUE_TIMEOUT_MS;
    const profileSettingsOperationTimeoutMs = Number(
      options.claudeProfileSettingsOperationTimeoutMs ?? this.claudeActivationOperationTimeoutMs,
    );
    this.claudeProfileSettingsOperationTimeoutMs = Number.isFinite(profileSettingsOperationTimeoutMs)
      && profileSettingsOperationTimeoutMs > 0
      ? profileSettingsOperationTimeoutMs
      : this.claudeActivationOperationTimeoutMs;
    // Dedicated clock: many service fixtures replace the scheduler timer with
    // an inert stub. That must never disable this safety boundary by accident.
    this.claudeActivationSetTimeout = options.claudeActivationSetTimeout || globalThis.setTimeout;
    this.claudeActivationClearTimeout = options.claudeActivationClearTimeout || globalThis.clearTimeout;
    this.claudeActivationTail = Promise.resolve();
    // A watchdog can stop waiting, but JavaScript cannot cancel arbitrary
    // credential work. Keep newer work fenced until the timed-out operation
    // itself settles so serialization never degrades into overlap.
    this.claudeActivationSafetyFence = null;
    this.claudeRenewalPromise = null;
    this.claudeRenewalAccountId = null;
    // Issues #265/#564: credential expiry is deliberately ephemeral. It must
    // reach the renewal scheduler's validity check, but never account
    // metadata, usage detail, logs, or API state. (#564 second pass removed
    // pre-expiry renewal outright: the CLI only refreshes a stored sign-in
    // within its own ~5-minute pre-expiry margin, so a 45-minute-early
    // invoke could never renew and each lifetime burned two budget attempts.)
    this.claudeCredentialExpiries = new Map();
    this.claudeActivationAccountCounts = new Map();
    this.claudeIdentityVerificationPromises = new Map();
    this.claudeProfileSettingsTails = new Map();
    this.toolProbeCache = null;
    this.toolProbePromise = null;
    this.toolProbePromiseGeneration = null;
    this.toolProbeGeneration = 0;
    this.authPresenceTtlMs = Number(options.authPresenceTtlMs ?? 5_000);
    this.authPresenceCache = new Map();
    // Issue #89: last failed refresh per account id ({ message, at }); an
    // entry is deleted the moment that account refreshes successfully.
    // refreshAll used to compute exactly these errors and drop them.
    this.accountRefreshErrors = new Map();
    const configLintFacts = this.store.getConfigLintFacts?.() || {
      installedCliVersions: {}, claudeWeeklyFingerprints: {},
    };
    this.configLintInstalledCliVersions = configLintFacts.installedCliVersions || {};
    const managedClaudeIds = new Set(this.store.listAccounts()
      .filter((account) => account.provider === 'claude')
      .map((account) => account.id));
    this.claudeWeeklyFingerprints = new Map(Object.entries(configLintFacts.claudeWeeklyFingerprints || {})
      .filter(([accountId, value]) => managedClaudeIds.has(accountId) && Number.isSafeInteger(value)));
    this.duplicateClaudeTokenAccountIds = duplicateAccountIdsByFingerprint(this.claudeWeeklyFingerprints);
    // Issue #108: Codex twin of the Claude pair above. Values are
    // `tokens.account_id` identifiers read from each profile's auth.json —
    // identifiers only, never token values — remembered until fresh readable
    // evidence replaces them (same PR #77 evidence-memory rule).
    this.duplicateCodexTokenAccountIds = new Set();
    this.codexAccountIdentifiers = new Map();
    this.toolUpdatePromises = new Map();
    this.realpath = options.realpath || fs.promises.realpath;
    this.uid = options.uid ?? process.getuid?.();
    this.platform = options.platform || process.platform;
    // DEMO/DEV ONLY (issue #129): when true, seeded fixture usage snapshots
    // are authoritative. refreshAll() is a no-op (no provider calls, so
    // fabricated demo accounts can never accumulate refresh errors that
    // degrade their auth chips) and the auto-refresh scheduler never arms.
    // Production installs never set this; scripts/demo-daemon.sh does.
    this.demoFixtures = options.demoFixtures === true;
    this.claudeSecureStorage = { value: null, status: this.platform === 'darwin' ? 'inactive' : 'not-applicable' };
    this.claudeSecureStorageSupported = null;
    this.sharedScope = options.sharedScopeEngine || new SharedScopeEngine(this.store, {
      profilesDir: this.claudeProfilesDir,
      sharedDir: options.sharedScopeDir || path.join(this.dataDir, 'shared'),
      watch: options.sharedScopeWatch,
      setTimeout: options.sharedScopeSetTimeout,
      clearTimeout: options.sharedScopeClearTimeout,
      debounceMs: options.sharedScopeDebounceMs,
      beforeAtomicRename: options.sharedScopeBeforeAtomicRename,
      afterMcpRead: options.sharedScopeAfterMcpRead,
      afterUndoQuarantine: options.sharedScopeAfterUndoQuarantine,
    });
    this.configLintSnapshotCollector = options.configLintSnapshotCollector || collectConfigLintSnapshot;
    this.configLintEvaluate = options.configLintEvaluate || evaluateConfigLint;
    this.configLintSetTimeout = options.configLintSetTimeout || globalThis.setTimeout;
    this.configLintClearTimeout = options.configLintClearTimeout || globalThis.clearTimeout;
    this.configLintLatest = null;
    this.configLintPromise = null;
    this.configLintActive = false;
    this.configLintTimer = null;
    this.configLintStarted = false;
    this.configLintGeneration = 0;
  }

  configLintStatus() {
    return this.configLintLatest || { generatedAt: null, findings: [] };
  }

  async runConfigLint() {
    if (this.configLintPromise) return this.configLintPromise;
    const task = (async () => {
      if (this.codexProfilesMigrationPromise) await this.codexProfilesMigrationPromise;
      if (this.codexProfilesMigrationBlocked) return this.configLintStatus();
      this.configLintActive = true;
      let findings;
      try {
        const snapshot = await this.configLintSnapshotCollector(configLintSnapshotOptions(this));
        findings = this.configLintEvaluate(snapshot);
      } catch (error) {
        findings = configLintFailureFindings(error?.code || error?.message || 'configuration snapshot collection failed');
      }
      const report = {
        generatedAt: new Date(this.now()).toISOString(),
        findings,
      };
      this.configLintLatest = report;
      return report;
    })();
    this.configLintPromise = task;
    try { return await task; }
    finally {
      if (this.configLintPromise === task) { this.configLintPromise = null; this.configLintActive = false; }
    }
  }

  async runScheduledConfigLint(generation) {
    const report = await this.runConfigLint();
    if (!this.configLintStarted || generation !== this.configLintGeneration) return report;
    const timer = this.configLintSetTimeout(async () => {
      if (this.configLintTimer === timer) this.configLintTimer = null;
      return this.runScheduledConfigLint(generation);
    }, CONFIG_LINT_INTERVAL_MS);
    timer?.unref?.();
    this.configLintTimer = timer;
    return report;
  }

  startConfigLint() {
    if (!this.configLintEnabled) return Promise.resolve(this.configLintStatus());
    if (this.configLintStarted) return this.configLintPromise || Promise.resolve(this.configLintStatus());
    this.configLintStarted = true;
    const generation = ++this.configLintGeneration;
    return this.runScheduledConfigLint(generation);
  }

  async stopConfigLint() {
    this.configLintStarted = false;
    this.configLintGeneration += 1;
    if (this.configLintTimer != null) this.configLintClearTimeout(this.configLintTimer);
    this.configLintTimer = null;
    await this.configLintPromise?.catch(() => {});
  }

  migrateCodexProfilesDir() {
    if (this.codexProfilesMigrationPromise) return this.codexProfilesMigrationPromise;
    if (this.demoFixtures || this.codexProfilesMigrationStopped) return Promise.resolve({});
    if (this.codexProfilesMigrationTimer != null) this.clearTimeout(this.codexProfilesMigrationTimer);
    this.codexProfilesMigrationTimer = null;
    this.codexProfilesMigrationTarget ??= this.codexProfilesDir;
    this.codexProfilesMigrationPromise = migrateCodexProfilesDir({
      now: () => new Date(this.now()),
      ...this.codexMigrationOptions,
      isLegacyInUse: async (legacyDir) => {
        const usage = await (this.codexMigrationOptions.isLegacyInUse || legacyCodexProfilesUsage)(legacyDir);
        if (usage !== false && usage?.inUse !== false) return usage;
        // Startup used to be the only attempt. Runtime moves also wait for
        // daemon work that could still hold an old account reference.
        // A queued lint or ingest pass is WAITING for this migration (its
        // promise field is set while it awaits us): counting it as a holder
        // would defer the move against our own waiter and roll back entries
        // already moved (CodeRabbit, PR #680). Only a pass that has passed
        // the migration await holds anything.
        if (this.codexProfilesMigrationReaders || this.refreshPromise || this.warehouseIngestActive
            || this.configLintActive || this.autoRefreshStartupTasks.size
            || this.providerManagementOperations.size || this.codexActivationCount) {
          return { inUse: true, holders: [path.basename(this.daemonExecPath)] };
        }
        return usage;
      },
      store: this.store, legacyDir: this.codexLegacyProfilesDir,
      profilesDir: this.codexProfilesMigrationTarget, activeLink: this.codexActiveLink,
      dataDir: this.dataDir, log: this.logCodexMigration,
    }).then(async (result) => {
      // A busy, untouched legacy install must remain usable. New accounts
      // also stay there so they cannot fill the destination and defeat retry.
      this.codexProfilesDir = result.profilesDir || this.codexProfilesMigrationTarget;
      this.initializeProviderManagement();
      // A deferred migration can leave a terminal pin on the legacy root.
      // Retry after an already-completed migration too, if its pin write failed.
      if (this.codexLegacyProfilesDir && !result.blocked && this.isProviderManaged('codex')) {
        try {
          const envStat = await fs.promises.lstat(this.codexShellEnvFile).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (envStat) {
            if (!envStat.isFile() || !fs.lstatSync(this.codexActiveLink).isSymbolicLink()) throw new Error('Unsafe Codex terminal pin');
            const target = fs.realpathSync(this.codexActiveLink);
            const account = this.store.listAccounts().find((item) => item.provider === 'codex' && path.resolve(item.profileRef) === target);
            if (!account) throw new Error('Unregistered Codex terminal pin');
            await this.writeCodexShellEnvFile(this.providerProfileRef(account));
          }
        } catch {
          result = { ...result, retryable: false, blocked: true, warning: 'The Codex terminal environment could not be updated. Restart ModelDeck to retry.' };
        }
      }
      this.codexProfilesMigrationWarning = result.warning || null;
      this.codexProfilesMigrationBlocked = result.blocked === true;
      if (result.migrated) {
        this.codexProfilesMigration = { status: 'done', movedAt: new Date(this.now()).toISOString() };
      } else if (result.warning) {
        this.codexProfilesMigration = {
          status: 'deferred', holders: result.holders || [],
          since: this.codexProfilesMigration?.since || new Date(this.now()).toISOString(),
        };
      } else if (this.codexProfilesMigration?.status !== 'done') {
        this.codexProfilesMigration = null;
      }
      if (result.retryable && !result.blocked && !this.codexProfilesMigrationStopped) {
        const delay = 10 * 60_000 + (Math.random() * 4 - 2) * 60_000;
        this.codexProfilesMigrationTimer = this.setTimeout(() => {
          this.codexProfilesMigrationTimer = null;
          return this.migrateCodexProfilesDir();
        }, delay);
        this.codexProfilesMigrationTimer?.unref?.();
      }
      return result;
    }).finally(() => { this.codexProfilesMigrationPromise = null; });
    return this.codexProfilesMigrationPromise;
  }

  async stopCodexProfilesMigration() {
    this.codexProfilesMigrationStopped = true;
    if (this.codexProfilesMigrationTimer != null) this.clearTimeout(this.codexProfilesMigrationTimer);
    this.codexProfilesMigrationTimer = null;
    await this.codexProfilesMigrationPromise;
  }

  startAutoRefresh() {
    if (this.autoRefreshStarted) return;
    // Demo fixture mode: fixtures never refresh, so never arm the scheduler.
    if (this.demoFixtures) return;
    this.autoRefreshStarted = true;
    // Local, credential-free startup migration for pre-#62 Claude rows.
    void this.trackAutoRefreshStartup(this.backfillClaudeIdentities()).catch(() => {});
    // Issue #203: every managed Claude home carries the same inert profile
    // explainer. Reconcile alongside the #190/#189 statusline startup repair
    // so upgrades to the pinned block reach profiles created by older builds.
    void this.trackAutoRefreshStartup(this.reconcileClaudeProfileExplainers()).catch(() => {});
    void this.trackAutoRefreshStartup(this.reconcileActiveTranscripts()).catch(() => {});
    // Issue #189: before anything else statusline, repair tees still
    // pointing at a daemon binary that has since moved or been deleted
    // (same bug class as #185's dead release-worktree daemon).
    void this.trackAutoRefreshStartup(this.reconcileClaudeStatuslineInstalls()).catch(() => {});
    // Issue #174: pick up statusline captures written while the daemon was
    // down, then watch for new ones — server-truth windows should not wait
    // for the next scheduled provider refresh.
    void this.trackAutoRefreshStartup(this.ingestClaudeStatuslineCaptures()).catch(() => {});
    // Issue #377: same for the per-session model markers, so a drop that
    // happened while the daemon was down is still on the deck at startup.
    void this.trackAutoRefreshStartup(this.ingestClaudeStatuslineSessionModels()).catch(() => {});
    // #282 adversarial review, major 2: a crash between the settings.json
    // write and the shell pin write leaves the two split-brained until the
    // next activation or routing change. Reconcile the pin from the active
    // profile's ACTUAL routing state at startup, like the other repairs
    // above — the write path is idempotent, so a consistent state is a
    // no-op.
    void this.trackAutoRefreshStartup(this.reconcileClaudeShellEnvFile()).catch(() => {});
    this.startClaudeStatuslineWatcher();
    const generation = ++this.autoRefreshGeneration;
    const settings = this.store.getSettings();
    if (settings.sharedUserScopeEnabled && this.isProviderManaged('claude')) {
      void this.trackAutoRefreshStartup(this.sharedScope.start()).catch(() => {
        // Provider paths can contain account labels; never echo them into the
        // daemon log from a filesystem exception.
        console.error('[modeldeck] shared-scope startup reconcile failed');
      });
    }
    if (settings.autoRefreshEnabled) {
      if (this.lastCompletedRefreshAt == null) this.lastCompletedRefreshAt = this.now();
      this.armAutoRefresh(this.autoRefreshInitialDelayMs, generation);
    }
  }

  trackAutoRefreshStartup(task) {
    const tracked = Promise.resolve(task);
    this.autoRefreshStartupTasks.add(tracked);
    const clear = () => this.autoRefreshStartupTasks.delete(tracked);
    void tracked.then(clear, clear);
    return tracked;
  }

  stopAutoRefresh() {
    this.autoRefreshStarted = false;
    this.autoRefreshGeneration += 1;
    if (this.autoRefreshTimer != null) this.clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
    this.pausedForActiveSessions = false;
    this.activeProviderSessionPresent = false;
    if (this.statuslineIngestTimer != null) this.clearTimeout(this.statuslineIngestTimer);
    this.statuslineIngestTimer = null;
    if (this.statuslineWatcher) {
      try { this.statuslineWatcher.close(); } catch { /* already closed */ }
      this.statuslineWatcher = null;
    }
    this.sharedScope.stopWatchers();
    const pendingTasks = [...this.autoRefreshStartupTasks, ...this.autoRefreshTickTasks]
      .map((task) => task.catch(() => {}));
    return Promise.all([...pendingTasks, this.sharedScope.stop()]).finally(() => {
      // A startup shared-scope pass may have reached startWatchers() while
      // shutdown was draining it. Close that late watcher before returning.
      this.sharedScope.stopWatchers();
    });
  }

  // -------------------------------------------------------------------------
  // Issue #181/#499 — bounded usage retention.

  /// Start independently of provider auto-refresh: maintenance must still run
  /// when polling is disabled and in credential-free demo fixture mode. Store
  /// construction has completed schema migration before server.listen calls it.
  startUsageSnapshotRetention() {
    if (this.usageSnapshotPruneStarted) return;
    this.usageSnapshotPruneStarted = true;
    const generation = ++this.usageSnapshotPruneGeneration;
    this.usageSnapshotPruneWaitingForState = true;
    this.scheduleUsageSnapshotPrune(USAGE_SNAPSHOT_FIRST_PRUNE_DELAY_MS, generation);
  }

  scheduleUsageSnapshotPrune(delay, generation = this.usageSnapshotPruneGeneration) {
    if (this.usageSnapshotPruneTimer != null) this.clearTimeout(this.usageSnapshotPruneTimer);
    this.usageSnapshotPruneTimer = this.setTimeout(() => {
      this.usageSnapshotPruneTimer = null;
      if (!this.usageSnapshotPruneStarted || generation !== this.usageSnapshotPruneGeneration) return;
      this.usageSnapshotPruneWaitingForState = false;
      this.runScheduledUsageSnapshotPrune(generation);
    }, delay);
    this.usageSnapshotPruneTimer?.unref?.();
  }

  async stopUsageSnapshotRetention() {
    this.usageSnapshotPruneStarted = false;
    this.usageSnapshotPruneWaitingForState = false;
    this.usageSnapshotPruneGeneration += 1;
    if (this.usageSnapshotPruneTimer != null) this.clearTimeout(this.usageSnapshotPruneTimer);
    this.usageSnapshotPruneTimer = null;
    // The Store is closed immediately after app.close(), so let a batch already
    // in progress finish before the caller can close its SQLite connection.
    await Promise.all([
      (this.usageSnapshotPrunePromise || Promise.resolve()).catch(() => {}),
      (this.requestUsagePrunePromise || Promise.resolve()).catch(() => {}),
      (this.otelQuarantinePrunePromise || Promise.resolve()).catch(() => {}),
    ]);
  }

  runScheduledUsageSnapshotPrune(generation) {
    void Promise.all([
      this.pruneUsageSnapshots(),
      this.pruneRequestUsage(),
      this.pruneOtelQuarantine(),
    ]).catch((error) => {
      console.error(`[modeldeck] usage retention prune failed: ${error?.message || error}`);
    }).finally(() => {
      if (!this.usageSnapshotPruneStarted || generation !== this.usageSnapshotPruneGeneration) return;
      this.scheduleUsageSnapshotPrune(USAGE_SNAPSHOT_PRUNE_INTERVAL_MS, generation);
    });
  }

  /// Drain expired history through bounded synchronous DELETEs, yielding
  /// between full batches so a startup backlog cannot monopolize the serve
  /// loop. Concurrent scheduled/manual requests coalesce with the active run.
  pruneUsageSnapshots() {
    if (this.usageSnapshotPrunePromise) return this.usageSnapshotPrunePromise;
    const cutoff = new Date(this.now() - USAGE_SNAPSHOT_RETENTION_DAYS * DAY_MS).toISOString();
    const promise = (async () => {
      let total = 0;
      while (true) {
        const pruned = this.store.pruneUsageSnapshotsBatch({
          cutoff,
          batchSize: USAGE_SNAPSHOT_PRUNE_BATCH_SIZE,
        });
        total += pruned;
        if (pruned < USAGE_SNAPSHOT_PRUNE_BATCH_SIZE) break;
        await this.yieldToServeLoop();
      }
      this.logUsageSnapshotPrune(total);
      return total;
    })();
    this.usageSnapshotPrunePromise = promise;
    const clear = () => {
      if (this.usageSnapshotPrunePromise === promise) this.usageSnapshotPrunePromise = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  /// Drain request evidence older than the settled 400-day policy through the
  /// same bounded, yielding shape as usage snapshot retention.
  pruneRequestUsage() {
    if (this.requestUsagePrunePromise) return this.requestUsagePrunePromise;
    const cutoff = new Date(this.now() - REQUEST_USAGE_RETENTION_DAYS * DAY_MS).toISOString();
    const promise = (async () => {
      let total = 0;
      try {
        while (true) {
          const pruned = this.store.pruneRequestUsageBatch({
            cutoff,
            batchSize: REQUEST_USAGE_PRUNE_BATCH_SIZE,
          });
          total += pruned;
          if (pruned < REQUEST_USAGE_PRUNE_BATCH_SIZE) break;
          await this.yieldToServeLoop();
        }
      } finally {
        this.logRequestUsagePrune(total);
      }
      return total;
    })();
    this.requestUsagePrunePromise = promise;
    const clear = () => {
      if (this.requestUsagePrunePromise === promise) this.requestUsagePrunePromise = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  /// Quarantine has no historical timestamp index. Scan at most one batch of
  /// receipts per turn, including survivors, so upgrading never needs a large
  /// index build or a single transaction over the old raw-JSON backlog.
  pruneOtelQuarantine() {
    if (this.otelQuarantinePrunePromise) return this.otelQuarantinePrunePromise;
    const cutoff = new Date(this.now() - OTEL_QUARANTINE_RETENTION_DAYS * DAY_MS).toISOString();
    const promise = (async () => {
      const startedAt = this.now();
      const autoCheckpointPages = this.store.walAutoCheckpointPages();
      let total = 0;
      let cursor = {};
      let batches = 0;
      try {
        // A DELETE must not synchronously checkpoint a large upgrade backlog.
        // Give reads a timer turn before each batch and each passive checkpoint.
        this.store.setWalAutoCheckpointPages(0);
        while (true) {
          cursor = this.store.pruneOtelQuarantineBatch({ cutoff, ...cursor });
          total += cursor.deleted;
          batches += 1;
          if (cursor.scanned < OTEL_QUARANTINE_PRUNE_BATCH_SIZE) break;
          await new Promise((resolve) => this.setTimeout(resolve, OTEL_QUARANTINE_PRUNE_PAUSE_MS));
          if (batches % OTEL_QUARANTINE_CHECKPOINT_BATCHES === 0) {
            this.store.checkpointWal();
            await new Promise((resolve) => this.setTimeout(resolve, OTEL_QUARANTINE_PRUNE_PAUSE_MS));
          }
        }
        if (total > 0) {
          await new Promise((resolve) => this.setTimeout(resolve, OTEL_QUARANTINE_PRUNE_PAUSE_MS));
          this.store.checkpointWal();
        }
      } finally {
        this.store.setWalAutoCheckpointPages(autoCheckpointPages);
      }
      this.logOtelQuarantinePrune(total, this.now() - startedAt);
      return total;
    })();
    this.otelQuarantinePrunePromise = promise;
    const clear = () => {
      if (this.otelQuarantinePrunePromise === promise) this.otelQuarantinePrunePromise = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Issue #338 — sole CLIProxyAPI usage-queue consumer.

  /// This lifecycle is independent of provider auto-refresh. Enabling starts
  /// with one immediate pull, then schedules from completion so slow pulls or
  /// machine sleep never creates overlap/catch-up bursts. Startup always
  /// probes both retired launchd jobs; an enabled consumer stays blocked until
  /// the legacy poller and interim ingest job are confirmed absent.
  async startUsageQueueConsumer() {
    if (this.usageQueueConsumerStarted || this.demoFixtures) return;
    this.usageQueueConsumerStarted = true;
    this.usageQueueConsumerScheduledEnabled = null;
    // Detect and surface a stale foreign job even before the operator enables
    // the daemon consumer. The probe is read-only; queue access remains gated.
    await this.refreshUsageQueueGuard();
    if (!this.usageQueueConsumerStarted) return;
    // A settings PUT can complete while launchctl is answering. Re-read after
    // the await so startup cannot undo a newer operator cutover.
    return this.rescheduleUsageQueueConsumer(this.store.getSettings(), { guardChecked: true });
  }

  async rescheduleUsageQueueConsumer(settings = this.store.getSettings(), { guardChecked = false } = {}) {
    if (!this.usageQueueConsumerStarted) return;
    const enabled = settings.usageQueueConsumerEnabled === true;
    // Ordinary settings PUTs must not create extra destructive reads.
    if (enabled === this.usageQueueConsumerScheduledEnabled) {
      // A blocked/unknown enable can be retried after the operator unloads
      // the foreign job without first toggling the stored kill switch off.
      if (enabled && this.usageQueueGuard.status !== 'clear') {
        const guard = await this.refreshUsageQueueGuard();
        if (guard.status !== 'clear') return;
        this.usageQueueConsumerScheduledEnabled = null;
      } else {
        return enabled
          ? undefined
          : (this.usageQueueConsumerPromise || Promise.resolve()).catch(() => {});
      }
    }
    const generation = ++this.usageQueueConsumerGeneration;
    if (this.usageQueueConsumerTimer != null) this.clearTimeout(this.usageQueueConsumerTimer);
    this.usageQueueConsumerTimer = null;
    if (enabled) {
      const guard = guardChecked ? this.usageQueueGuard : await this.refreshUsageQueueGuard();
      if (!this.usageQueueConsumerStarted || generation !== this.usageQueueConsumerGeneration) return;
      if (guard.status !== 'clear') {
        this.usageQueueConsumerScheduledEnabled = false;
        return;
      }
      // A release helper must observe this arming's first pull, never a clean
      // result retained from an earlier enable/disable cycle.
      this.usageQueueLastPull = null;
      this.logUsageQueueGuard('USAGE QUEUE DAEMON CONSUMER ARMED: retired launchd consumers confirmed absent');
      this.usageQueueConsumerScheduledEnabled = true;
      this.runScheduledUsageQueuePull(generation, { guardChecked: true });
      return;
    }
    this.usageQueueConsumerScheduledEnabled = false;
    // Disabling is an operator handoff boundary. Never abort a response that
    // may already have drained the queue, but do not report the consumer OFF
    // until that response has completed its allowlisted ingest either.
    return enabled
      ? undefined
      : (this.usageQueueConsumerPromise || Promise.resolve()).catch(() => {});
  }

  async stopUsageQueueConsumer() {
    this.usageQueueConsumerStarted = false;
    this.usageQueueConsumerScheduledEnabled = false;
    this.usageQueueConsumerGeneration += 1;
    if (this.usageQueueConsumerTimer != null) this.clearTimeout(this.usageQueueConsumerTimer);
    this.usageQueueConsumerTimer = null;
    // A response may already have drained the queue. Let its allowlisted ingest
    // finish before the Store closes; generation only prevents re-arming.
    await (this.usageQueueConsumerPromise || Promise.resolve()).catch(() => {});
  }

  async refreshUsageQueueGuard() {
    if (this.usageQueueGuardPromise) return this.usageQueueGuardPromise;
    const check = (async () => {
      const previousMessage = this.usageQueueGuard.message;
      let result;
      try {
        result = await this.detectForeignUsageConsumers({ labels: RETIRED_USAGE_CONSUMER_LABELS });
      } catch {
        result = { checked: true, consumers: [], probe: 'unknown' };
      }
      const checkedAt = new Date(this.now()).toISOString();
      let status = 'clear';
      let message = null;
      if (result.consumers?.length) {
        status = 'blocked';
        message = `USAGE QUEUE FOREIGN CONSUMER DETECTED: still loaded: ${result.consumers.join(', ')}; daemon consumer blocked`;
      } else if (result.probe !== 'ok') {
        status = 'unknown';
        message = 'USAGE QUEUE FOREIGN-CONSUMER CHECK UNKNOWN: could not verify retired launchd consumers are absent; daemon consumer blocked';
      }
      this.usageQueueGuard = {
        status,
        checkedAt,
        foreignConsumers: result.consumers || [],
        message,
      };
      // Log on every newly detected conflict/unknown state, including startup,
      // without repeating the same alarm on each five-minute guard recheck.
      if (message && message !== previousMessage) this.logUsageQueueGuard(message);
      return this.usageQueueGuard;
    })();
    this.usageQueueGuardPromise = check;
    try {
      return await check;
    } finally {
      if (this.usageQueueGuardPromise === check) this.usageQueueGuardPromise = null;
    }
  }

  usageQueueStatus(settings = this.store.getSettings()) {
    return {
      configured: settings.usageQueueConsumerEnabled === true,
      running: this.usageQueueConsumerScheduledEnabled === true,
      inFlight: this.usageQueueConsumerPromise != null,
      guard: { ...this.usageQueueGuard },
      lastPull: this.usageQueueLastPull,
    };
  }

  async runScheduledUsageQueuePull(generation, { guardChecked = false } = {}) {
    // Re-read the persisted gate at the moment of every destructive pull. The
    // API normally calls rescheduleUsageQueueConsumer immediately, but this
    // guard also makes direct Store changes fail closed.
    if (!this.store.getSettings().usageQueueConsumerEnabled) {
      this.usageQueueConsumerScheduledEnabled = false;
      return;
    }
    if (!guardChecked) {
      const guard = await this.refreshUsageQueueGuard();
      if (!this.usageQueueConsumerStarted
        || generation !== this.usageQueueConsumerGeneration) return;
      if (guard.status !== 'clear') {
        this.usageQueueConsumerScheduledEnabled = false;
        return;
      }
    }
    void this.pullUsageQueue().catch(() => {
      // pull() already converts operational failures to counted warnings. This
      // fixed fallback protects the daemon without exposing credential context.
      console.warn('[modeldeck] usage queue pull failed (warnings=1)');
    }).finally(() => {
      if (!this.usageQueueConsumerStarted
        || generation !== this.usageQueueConsumerGeneration) return;
      const settings = this.store.getSettings();
      if (!settings.usageQueueConsumerEnabled) {
        this.usageQueueConsumerScheduledEnabled = false;
        return;
      }
      this.usageQueueConsumerTimer = this.setTimeout(() => {
        this.usageQueueConsumerTimer = null;
        if (!this.usageQueueConsumerStarted
          || generation !== this.usageQueueConsumerGeneration) return;
        void this.runScheduledUsageQueuePull(generation);
      }, USAGE_QUEUE_CONSUMER_INTERVAL_MS);
      this.usageQueueConsumerTimer?.unref?.();
    });
  }

  pullUsageQueue() {
    if (this.usageQueueConsumerPromise) return this.usageQueueConsumerPromise;
    const promise = Promise.resolve().then(async () => {
      const result = await this.usageQueueConsumer.pull();
      this.usageQueueLastPull = {
        at: new Date(this.now()).toISOString(),
        records: Number(result?.records || 0),
        inserted: Number(result?.inserted || 0),
        riderRejections: Number(result?.riderRejections || 0),
        warnings: usageQueueWarningCount(result),
      };
      return result;
    });
    this.usageQueueConsumerPromise = promise;
    const clear = () => {
      if (this.usageQueueConsumerPromise === promise) this.usageQueueConsumerPromise = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Issue #388 — daemon-owned recurring warehouse ingest.

  /// Preserve the retired launchd job's 15-minute cadence. Like the usage
  /// queue consumer, each timeout is armed only after the preceding pass has
  /// completed, so slow local-file scans or machine sleep cannot overlap or
  /// create catch-up bursts.
  startWarehouseIngest() {
    if (this.warehouseIngestStarted || this.demoFixtures) return;
    this.warehouseIngestStarted = true;
    this.warehouseIngestScheduledEnabled = null;
    return this.rescheduleWarehouseIngest(this.store.getSettings());
  }

  async rescheduleWarehouseIngest(settings = this.store.getSettings()) {
    if (!this.warehouseIngestStarted) return;
    const enabled = settings.usageAnalyticsEnabled === true;
    // Unrelated settings writes must not create an extra warehouse pass.
    if (enabled === this.warehouseIngestScheduledEnabled) {
      return enabled
        ? undefined
        : (this.warehouseIngestPromise || Promise.resolve()).catch(() => {});
    }
    const generation = ++this.warehouseIngestGeneration;
    if (this.warehouseIngestTimer != null) this.clearTimeout(this.warehouseIngestTimer);
    this.warehouseIngestTimer = null;
    if (enabled) {
      this.warehouseIngestScheduledEnabled = true;
      this.runScheduledWarehouseIngest(generation);
      return;
    }
    this.warehouseIngestScheduledEnabled = false;
    // Let a local-file/SQLite pass already in flight finish before settings
    // reports the analytics machinery disabled; generation prevents re-arming.
    await (this.warehouseIngestPromise || Promise.resolve()).catch(() => {});
  }

  async stopWarehouseIngest() {
    this.warehouseIngestStarted = false;
    this.warehouseIngestScheduledEnabled = false;
    this.warehouseIngestGeneration += 1;
    if (this.warehouseIngestTimer != null) this.clearTimeout(this.warehouseIngestTimer);
    this.warehouseIngestTimer = null;
    // The Store closes immediately after app.close(), so an active pass must
    // finish its transactions first. The generation only prevents re-arming.
    await (this.warehouseIngestPromise || Promise.resolve()).catch(() => {});
  }

  runScheduledWarehouseIngest(generation) {
    // Re-read the persisted kill switch at every pass. The settings API also
    // reschedules immediately, but a direct Store change must fail closed.
    if (!this.store.getSettings().usageAnalyticsEnabled) {
      this.warehouseIngestScheduledEnabled = false;
      return;
    }
    void this.runWarehouseIngestPass().catch((error) => {
      // Each configured job is isolated below. This fallback covers an
      // unexpected scheduler-level failure without losing the recurring loop.
      try {
        this.logWarehouseIngest(`warehouse ingest pass failed: ${errorMessage(error)}`);
      } catch { /* Logging cannot prevent the next tick. */ }
    }).finally(() => {
      if (!this.warehouseIngestStarted
        || generation !== this.warehouseIngestGeneration) return;
      if (!this.store.getSettings().usageAnalyticsEnabled) {
        this.warehouseIngestScheduledEnabled = false;
        return;
      }
      this.warehouseIngestTimer = this.setTimeout(() => {
        this.warehouseIngestTimer = null;
        if (!this.warehouseIngestStarted
          || generation !== this.warehouseIngestGeneration) return;
        this.runScheduledWarehouseIngest(generation);
      }, WAREHOUSE_INGEST_INTERVAL_MS);
      this.warehouseIngestTimer?.unref?.();
    });
  }

  runWarehouseIngestPass() {
    if (this.warehouseIngestPromise) return this.warehouseIngestPromise;
    const promise = (async () => {
      if (this.codexProfilesMigrationPromise) await this.codexProfilesMigrationPromise;
      if (this.codexProfilesMigrationBlocked) return;
      this.warehouseIngestActive = true;
      const startedAt = new Date(this.now()).toISOString();
      const jobs = [
        ['transcriptArchive', () => this.ingestTranscriptArchive({
          store: this.store,
          directory: this.claudeProfilesDir,
          extraRoots: [
            ...this.store.getSettings().extraClaudeScanRoots,
            ...(!this.isProviderManaged('claude') ? this.store.listAccounts().filter((account) => account.provider === 'claude')
              .map((account) => ({ path: this.providerProfileRef(account), profileSlug: account.id })) : []),
          ],
          machine: this.warehouseIngestMachine,
        })],
        ['codexRollouts', () => this.ingestCodexRollouts({
          store: this.store,
          profilesRoot: this.codexProfilesDir,
          profileHomes: !this.isProviderManaged('codex') ? this.store.listAccounts().filter((account) => account.provider === 'codex')
            .map((account) => ({ path: this.providerProfileRef(account), profileSlug: account.id })) : [],
          machine: this.warehouseIngestMachine,
        })],
        ...(this.grokSessionsDir ? [['grokSessions', () => this.ingestGrokSessions({
          store: this.store,
          sessionsRoot: this.grokSessionsDir,
          machine: this.warehouseIngestMachine,
        })]] : []),
        ['diagnostician', () => this.runDiagnostician({
          store: this.store,
          logger: (message) => this.logWarehouseIngest(message),
          yieldToServeLoop: this.yieldToServeLoop,
        })],
        ['usageEstimateRefit', () => this.refitUsageEstimates(this.store)],
      ];
      const outcomes = {};
      for (const [name, run] of jobs) {
        try {
          const result = await run();
          const warnings = name === 'transcriptArchive'
            ? Number(result?.warnings || 0)
            : ['codexRollouts', 'grokSessions'].includes(name)
              ? Object.values(result?.warnings || {}).reduce((total, count) => total + Number(count || 0), 0)
              : 0;
          outcomes[name] = { ok: true, warnings };
        } catch (error) {
          outcomes[name] = { ok: false, warnings: 0 };
          try {
            this.logWarehouseIngest(`warehouse ingest ${name} failed: ${errorMessage(error)}`);
          } catch { /* Logging cannot stop the remaining jobs or the next tick. */ }
        }
      }
      this.warehouseIngestLastPass = {
        startedAt,
        at: new Date(this.now()).toISOString(),
        jobs: outcomes,
      };
      return outcomes;
    })();
    this.warehouseIngestPromise = promise;
    const clear = () => {
      if (this.warehouseIngestPromise === promise) { this.warehouseIngestPromise = null; this.warehouseIngestActive = false; }
    };
    void promise.then(clear, clear);
    return promise;
  }

  warehouseIngestStatus(settings = this.store.getSettings()) {
    return {
      configured: settings.usageAnalyticsEnabled === true,
      running: this.warehouseIngestScheduledEnabled === true,
      inFlight: this.warehouseIngestPromise != null,
      intervalSeconds: WAREHOUSE_INGEST_INTERVAL_MS / 1_000,
      lastPass: this.warehouseIngestLastPass,
    };
  }

  // -------------------------------------------------------------------------
  // Issue #203 — managed Claude profile explainer.

  /// Best-effort per account: one missing or malformed profile never prevents
  /// the remaining managed profiles from reconciling. Errors contain only the
  /// account id and filesystem diagnosis; profile document bytes are never
  /// returned or logged.
  async reconcileClaudeProfileExplainers() {
    if (!this.isProviderManaged('claude')) return [];
    const reconciled = [];
    for (const account of this.store.listAccounts()) {
      if (account.provider !== 'claude') continue;
      try {
        const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
        const result = await this.ensureClaudeProfileExplainer({ profileRef });
        if (result.changed) reconciled.push(account.id);
      } catch (error) {
        console.error(`[modeldeck] profile explainer reconcile failed for account ${account.id}: ${error?.message || error}`);
      }
    }
    return reconciled;
  }

  // -------------------------------------------------------------------------
  // Issue #174 — statusline rate-limits capture ingest.

  claudeStatuslineCaptureFile(accountId) {
    return path.join(this.claudeStatuslineDir, `${accountId}.json`);
  }

  claudeStatuslineBackupFile(accountId) {
    return path.join(this.claudeStatuslineDir, 'backups', `${accountId}.settings-backup.json`);
  }

  /// Watch the capture directory so a statusline render lands on the deck
  /// within about a second, not at the next scheduled refresh. Best-effort:
  /// a watch failure degrades to refresh-tick ingest, never to a crash.
  startClaudeStatuslineWatcher() {
    if (this.statuslineWatcher) return;
    try {
      fs.mkdirSync(this.claudeStatuslineDir, { recursive: true, mode: 0o700 });
      const onChange = () => {
        if (this.statuslineIngestTimer != null) return;
        this.statuslineIngestTimer = this.setTimeout(() => {
          this.statuslineIngestTimer = null;
          void this.ingestClaudeStatuslineCaptures().catch((error) => {
            console.error(`[modeldeck] statusline ingest failed: ${error?.message || error}`);
          });
          // Issue #377: the per-session model markers live one level down
          // (statusline/sessions/<accountId>/), hence the recursive watch.
          void this.ingestClaudeStatuslineSessionModels().catch((error) => {
            console.error(`[modeldeck] statusline session-model ingest failed: ${error?.message || error}`);
          });
        }, 1_000);
      };
      // Recursive watch is macOS/Windows-only; elsewhere a flat watch still
      // catches the #174 captures, and the #377 markers fall back to the
      // startup and refresh-tick reads instead of degrading the whole watcher.
      try { this.statuslineWatcher = fs.watch(this.claudeStatuslineDir, { recursive: true }, onChange); }
      catch { this.statuslineWatcher = fs.watch(this.claudeStatuslineDir, onChange); }
      this.statuslineWatcher.on?.('error', () => {});
      // The watcher must never keep the daemon process alive on its own.
      this.statuslineWatcher.unref?.();
    } catch (error) {
      console.error(`[modeldeck] statusline watcher unavailable: ${error?.message || error}`);
    }
  }

  /// Read every enabled Claude account's capture file and record the windows
  /// as usage snapshots with `source: 'claude-statusline'`.
  ///
  /// Precedence contract (issue #174): newest observedAt wins. A capture row
  /// is recorded only when its observedAt is strictly newer than the newest
  /// stored row for that (account, scope) — so a fresher probe result is
  /// never shadowed, and re-reading the same capture is idempotent. Probe
  /// rows are stamped at insert time, so a later probe always outranks an
  /// older capture on its own.
  ///
  /// Fingerprint safety (#65/#108 — the spike's HARD RULE): this path writes
  /// through recordUsage with its own provenance label but NEVER touches
  /// claudeWeeklyFingerprints or the duplicate-token sets. Those update
  /// exclusively from probe results inside refreshClaude, so statusline data
  /// can never poison weeklyResetFingerprint duplicate detection.
  async ingestClaudeStatuslineCaptures() {
    const accounts = this.store.listAccounts()
      .filter((account) => account.provider === 'claude' && account.enabled);
    const ingested = [];
    for (const account of accounts) {
      let capture;
      try {
        capture = JSON.parse(await fs.promises.readFile(this.claudeStatuslineCaptureFile(account.id), 'utf8'));
      } catch {
        continue; // absent or malformed capture: normal, never an error state
      }
      for (const snapshot of statuslineSnapshotsFromCapture(capture)) {
        const latest = this.store.latestUsageRow(account.id, snapshot.scope);
        const latestMs = latest?.observedAt ? Date.parse(latest.observedAt) : null;
        if (latestMs != null && !(Date.parse(snapshot.observedAt) > latestMs)) continue;
        this.store.recordUsage(account.id, snapshot);
        ingested.push({ accountId: account.id, scope: snapshot.scope, observedAt: snapshot.observedAt });
      }
    }
    return ingested;
  }

  // -------------------------------------------------------------------------
  // Issue #377 — mid-session model drops.

  claudeStatuslineSessionDir(accountId) {
    return statuslineSessionDir(this.claudeStatuslineCaptureFile(accountId));
  }

  /// Read every enabled Claude account's per-session model markers and fold
  /// each one into `session_model_state`. Detection is a pure comparison of
  /// two observations of the SAME session:
  ///
  ///   previous rankable, current weaker  → a drop opens (or an open drop
  ///                                        keeps its ORIGINAL from-model)
  ///   current at least as strong as the  → the open drop clears
  ///   model the drop was from
  ///
  /// Nothing here reads, signals, or otherwise touches the running session —
  /// the marker file is the only channel, written by the session's own
  /// statusline render.
  async ingestClaudeStatuslineSessionModels() {
    const accounts = this.store.listAccounts()
      .filter((account) => account.provider === 'claude' && account.enabled);
    const changes = [];
    for (const account of accounts) {
      const directory = this.claudeStatuslineSessionDir(account.id);
      let entries;
      try { entries = await fs.promises.readdir(directory); }
      catch { continue; } // no markers yet: normal, never an error state
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        let marker;
        try { marker = JSON.parse(await fs.promises.readFile(path.join(directory, entry), 'utf8')); }
        catch { continue; }
        const change = this.recordSessionModelObservation(account.id, marker);
        if (change) changes.push(change);
      }
    }
    // Sessions that stopped reporting age out of the table on the same bound
    // the notice uses (CodeRabbit, PR #472) — no separate timer, no growth.
    try { this.store.pruneSessionModelState(this.sessionModelStateCutoff()); }
    catch { /* housekeeping never fails an ingest pass */ }
    return changes;
  }

  /// Fold one marker into the stored state. Returns the transition when the
  /// model changed, otherwise null. Split out from the reader above so the
  /// transition rules are testable without a filesystem.
  recordSessionModelObservation(accountId, marker) {
    const sessionId = typeof marker?.sessionId === 'string' ? marker.sessionId : null;
    const model = typeof marker?.model === 'string' ? marker.model : null;
    const observedAt = typeof marker?.observedAt === 'string' && !Number.isNaN(Date.parse(marker.observedAt))
      ? new Date(Date.parse(marker.observedAt)).toISOString()
      : null;
    if (!sessionId || !model || !observedAt) return null;
    const previous = this.store.sessionModelState(accountId, sessionId);
    // Re-reading the same marker (a watcher fires per write, and every
    // startup re-reads them all) must be idempotent.
    if (previous && !(Date.parse(observedAt) > Date.parse(previous.observedAt))) return null;

    const base = {
      accountId,
      sessionId,
      model,
      modelDisplay: typeof marker.modelDisplayName === 'string' ? marker.modelDisplayName : null,
      cwd: typeof marker.cwd === 'string' ? marker.cwd : null,
      observedAt,
    };
    if (!previous || previous.model === model) {
      this.store.saveSessionModelState({
        ...base,
        droppedFrom: previous?.droppedFrom ?? null,
        droppedFromDisplay: previous?.droppedFromDisplay ?? null,
        droppedAt: previous?.droppedAt ?? null,
      });
      return null;
    }

    const standingFrom = previous.droppedFrom;
    if (standingFrom && isModelRecovery(standingFrom, model)) {
      this.store.saveSessionModelState(base);
      return { kind: 'recovered', accountId, sessionId, from: standingFrom, to: model, at: observedAt };
    }
    if (standingFrom) {
      // A further downgrade while a drop stands: same story, deeper.
      this.store.saveSessionModelState({
        ...base,
        droppedFrom: standingFrom,
        droppedFromDisplay: previous.droppedFromDisplay,
        droppedAt: previous.droppedAt,
      });
      return null;
    }
    if (!isModelDowngrade(previous.model, model)) {
      this.store.saveSessionModelState(base);
      return null;
    }
    this.store.saveSessionModelState({
      ...base,
      droppedFrom: previous.model,
      droppedFromDisplay: previous.modelDisplay,
      droppedAt: observedAt,
    });
    return { kind: 'dropped', accountId, sessionId, from: previous.model, to: model, at: observedAt };
  }

  /// The `why` and `when` half of the notice. The dropped-from model's own
  /// weekly window is already on the deck as a model-scoped scope ("Fable
  /// weekly", src/adapters/claude.mjs); when that window is spent, it IS the
  /// reason, and its reset is when the model comes back. When no such window
  /// is observed the cause is reported as unknown — never guessed.
  modelDropCause(accountId, droppedFrom, usage) {
    const family = claudeModelTier(droppedFrom)?.family;
    if (!family) return { reason: 'unknown', windowScope: null, windowUsedPercent: null, returnsAt: null };
    const window = usage.find((row) => (
      row.accountId === accountId
      && /^(.+) weekly$/u.test(row.scope)
      && row.scope.toLowerCase().startsWith(`${family} `)
    ));
    if (!window || window.usedPercent == null || window.usedPercent < MODEL_DROP_QUOTA_PERCENT) {
      return {
        reason: 'unknown',
        windowScope: window?.scope ?? null,
        windowUsedPercent: window?.usedPercent ?? null,
        returnsAt: null,
      };
    }
    return {
      reason: 'quota-exhausted',
      windowScope: window.scope,
      windowUsedPercent: window.usedPercent,
      returnsAt: window.resetsAt ?? null,
    };
  }

  /// The instant before which a session counts as gone (CodeRabbit, PR #472).
  /// A drop only ever clears when the SAME session reports getting back on the
  /// model — but a session the user has closed never renders another
  /// statusline, so without a bound its notice stood forever and every ended
  /// session added one more permanent header line.
  ///
  /// The rule: a drop is reported for exactly as long as its session's own
  /// statusline marker lives, because a drop in a session nobody can return to
  /// is not actionable and must stop alarming. One constant bounds the marker
  /// on disk and the row in the database, so the two cannot drift apart.
  sessionModelStateCutoff() {
    return new Date(this.now() - STATUSLINE_SESSION_MARKER_TTL_MS).toISOString();
  }

  /// `/api/state.modelDrop`. Every LIVE session with a standing drop, each one
  /// carrying what it dropped from, why, and when that model returns.
  ///
  /// Switching the session BACK is deliberately advice, not an action: the
  /// safety contract forbids touching a running Claude session, so the remedy
  /// names the command the user runs in their own session (issue #377,
  /// recorded on the PR).
  modelDropStatus(accounts, usage) {
    const enabled = new Map(accounts
      .filter((account) => account.provider === 'claude' && account.enabled)
      .map((account) => [account.id, account]));
    const drops = [];
    for (const row of this.store.listSessionModelDrops({ since: this.sessionModelStateCutoff() })) {
      const account = enabled.get(row.accountId);
      if (!account) continue;
      const cause = this.modelDropCause(row.accountId, row.droppedFrom, usage);
      const available = cause.reason !== 'quota-exhausted'
        || (cause.returnsAt != null && Date.parse(cause.returnsAt) <= this.now());
      drops.push({
        sessionId: row.sessionId,
        accountId: row.accountId,
        accountLabel: account.label,
        fromModel: row.droppedFrom,
        fromModelDisplay: row.droppedFromDisplay,
        toModel: row.model,
        toModelDisplay: row.modelDisplay,
        droppedAt: row.droppedAt,
        cwd: row.cwd,
        ...cause,
        available,
        remedy: available
          ? `Run /model ${row.droppedFrom} in that session to switch back.`
          : `Run /model ${row.droppedFrom} in that session once the window resets.`,
      });
    }
    return { quotaPercent: MODEL_DROP_QUOTA_PERCENT, drops };
  }

  /// Whether a profile's settings.json currently carries ModelDeck's
  /// statusline tee. Local file read only; any miss reads as false.
  async claudeStatuslineInstalled(profileRef) {
    if (!profileRef) return false;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(profileRef, 'settings.json'), 'utf8'));
      return isModelDeckStatuslineCommand(parsed?.statusLine?.command);
    } catch {
      return false;
    }
  }

  /// Startup reconcile (issue #189, same bug class as #185): a tee written
  /// by a daemon that has since moved or been deleted — the #185 incident
  /// was a temp release worktree — keeps spawning the dead binary on every
  /// statusline render, silently breaking the user's statusline (their own
  /// chained command included) even after the daemon itself is repaired,
  /// because nothing ever rewrote the settings.json command. For every
  /// Claude profile carrying our tee, rewrite it with the CURRENT paths
  /// when the embedded executable differs from ours in SEA mode (the daemon
  /// binary IS the statusline executable, so any other path is wrong) or no
  /// longer exists on disk in either mode. Re-install is idempotent: the
  /// user's chained statusLine and the original pre-install backup survive.
  /// Per-account best effort — one unreadable profile never blocks the rest.
  async reconcileClaudeStatuslineInstalls() {
    if (!this.isProviderManaged('claude')) return [];
    const repaired = [];
    for (const account of this.store.listAccounts()) {
      if (account.provider !== 'claude') continue;
      let command;
      try {
        const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
        const parsed = JSON.parse(await fs.promises.readFile(path.join(profileRef, 'settings.json'), 'utf8'));
        command = parsed?.statusLine?.command;
      } catch {
        continue; // no profile, no settings.json, or unparseable: nothing of ours to repair
      }
      if (!isModelDeckStatuslineCommand(command)) continue;
      const embedded = execPathFromStatuslineCommand(command);
      if (!embedded || embedded === this.statuslineExecPath) continue;
      if (!this.statuslineSea && fs.existsSync(embedded)) continue;
      try {
        await this.installClaudeStatusline(account.id);
        repaired.push(account.id);
        console.error(`[modeldeck] statusline tee for account ${account.id} repointed from stale executable ${embedded}`);
      } catch (error) {
        console.error(`[modeldeck] statusline tee reconcile failed for account ${account.id}: ${error?.message || error}`);
      }
    }
    return repaired;
  }

  /// Opt-in install (issue #174): write ModelDeck's statusline tee into the
  /// profile's OWN settings.json — profile-scoped path only (#66: never the
  /// active ~/.claude symlink), non-destructive (an existing user statusLine
  /// is chained, its output passing through untouched), reversible (the
  /// pre-install settings.json bytes are backed up before any change), and
  /// idempotent (re-install refreshes paths without stacking tees or
  /// clobbering the original backup).
  async installClaudeStatusline(accountId) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    if (account.provider !== 'claude') {
      const error = new Error('statusline capture is only supported for claude accounts');
      error.statusCode = 400;
      throw error;
    }
    const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
    return this.withClaudeProfileSettingsLock(
      profileRef,
      () => this.performInstallClaudeStatusline(account, profileRef),
    );
  }

  async performInstallClaudeStatusline(account, profileRef) {
    const settingsPath = path.join(profileRef, 'settings.json');
    let raw = null;
    try { raw = await fs.promises.readFile(settingsPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let parsed = {};
    if (raw != null) {
      try { parsed = JSON.parse(raw); }
      catch { throw new Error('Claude profile settings.json is not valid JSON; fix it before enabling statusline capture'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Claude profile settings.json must contain a JSON object');
      }
    }
    const existingStatusLine = parsed.statusLine;
    const existingCommand = typeof existingStatusLine?.command === 'string' ? existingStatusLine.command : null;
    const alreadyOurs = isModelDeckStatuslineCommand(existingCommand);
    // Re-install keeps the ORIGINAL user command from the previous install's
    // tee — chaining our own tee would stack wrappers forever.
    const chainCommand = alreadyOurs
      ? chainCommandFromStatuslineCommand(existingCommand)
      : existingCommand;
    const padding = existingStatusLine?.padding;
    const command = buildStatuslineCommand({
      execPath: this.statuslineExecPath,
      scriptPath: this.statuslineScriptPath,
      captureFile: this.claudeStatuslineCaptureFile(account.id),
      chainCommand,
      sea: this.statuslineSea,
    });
    const nextSettings = {
      ...parsed,
      statusLine: {
        type: 'command',
        command,
        ...(typeof padding === 'number' ? { padding } : {}),
      },
    };
    const written = `${JSON.stringify(nextSettings, null, 2)}\n`;
    const backupFile = this.claudeStatuslineBackupFile(account.id);
    let backup = null;
    if (alreadyOurs) {
      try { backup = JSON.parse(await fs.promises.readFile(backupFile, 'utf8')); }
      catch { backup = null; }
    }
    // The pre-install truth is captured ONCE — a re-install must never
    // replace the original bytes with an already-teed document.
    if (!backup) {
      backup = {
        accountId: account.id,
        settingsPath,
        existed: raw != null,
        content: alreadyOurs ? null : raw,
        originalStatusLine: alreadyOurs
          ? (chainCommand ? { type: 'command', command: chainCommand } : null)
          : (existingStatusLine ?? null),
        installedAt: new Date(this.now()).toISOString(),
      };
    }
    backup.writtenContent = written;
    await fs.promises.mkdir(path.dirname(backupFile), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(backupFile, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
    await this.writeClaudeProfileSettings(settingsPath, written);
    await fs.promises.mkdir(this.claudeStatuslineDir, { recursive: true, mode: 0o700 });
    this.startClaudeStatuslineWatcher();
    return { installed: true, chained: Boolean(chainCommand) };
  }

  /// Opt-out (issue #174): restore the profile's settings.json — byte for
  /// byte when the file is exactly what install wrote (unlink when it did
  /// not exist before), surgically (only the statusLine key reverts) when
  /// the user edited other settings since, and hands-off entirely when the
  /// user already replaced our tee themselves. The capture file and backup
  /// are removed either way; stored snapshots stay (history is history).
  async uninstallClaudeStatusline(accountId) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    if (account.provider !== 'claude') {
      const error = new Error('statusline capture is only supported for claude accounts');
      error.statusCode = 400;
      throw error;
    }
    const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
    return this.withClaudeProfileSettingsLock(
      profileRef,
      () => this.performUninstallClaudeStatusline(account, profileRef),
    );
  }

  async performUninstallClaudeStatusline(account, profileRef) {
    const settingsPath = path.join(profileRef, 'settings.json');
    const backupFile = this.claudeStatuslineBackupFile(account.id);
    let backup = null;
    try { backup = JSON.parse(await fs.promises.readFile(backupFile, 'utf8')); }
    catch { backup = null; }
    let raw = null;
    try { raw = await fs.promises.readFile(settingsPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let parsed = null;
    if (raw != null) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    const command = parsed?.statusLine?.command;
    if (raw != null && parsed && isModelDeckStatuslineCommand(command)) {
      if (backup?.writtenContent === raw && backup.content !== undefined) {
        // Untouched since install: byte-for-byte restore.
        if (backup.existed && typeof backup.content === 'string') {
          await this.writeClaudeProfileSettings(settingsPath, backup.content);
        } else if (!backup.existed) {
          await fs.promises.unlink(settingsPath).catch(() => {});
        } else {
          // existed but original bytes unknown (backup from a re-install
          // without the original): fall through to the surgical path.
          await this.surgicallyRestoreStatusline(settingsPath, parsed, backup, command);
        }
      } else {
        await this.surgicallyRestoreStatusline(settingsPath, parsed, backup, command);
      }
    }
    // Not ours (or settings.json is gone/unreadable): leave the user's
    // config alone — never guess.
    await fs.promises.unlink(this.claudeStatuslineCaptureFile(account.id)).catch(() => {});
    await fs.promises.unlink(backupFile).catch(() => {});
    return { installed: false };
  }

  /// Surgical uninstall path: the rest of the document is the user's — only
  /// statusLine reverts, to the backed-up original (or the chain embedded in
  /// our own tee command when no backup survived), else the key is removed.
  async surgicallyRestoreStatusline(settingsPath, parsed, backup, command) {
    const next = { ...parsed };
    const chained = chainCommandFromStatuslineCommand(command);
    const original = backup?.originalStatusLine
      ?? (chained ? { type: 'command', command: chained } : null);
    if (original) next.statusLine = original;
    else delete next.statusLine;
    await this.writeClaudeProfileSettings(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  /// Atomic settings.json write preserving the file's existing mode (0600
  /// for a fresh file) — a statusline render sourcing settings mid-write
  /// must never see a torn document.
  async writeClaudeProfileSettings(settingsPath, content) {
    this.requireManaged('claude');
    let mode = 0o600;
    try { mode = (await fs.promises.stat(settingsPath)).mode & 0o777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${settingsPath}.modeldeck-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(temporary, content, { mode });
      // writeFile's creation mode is filtered through the process umask.
      // Preserve the existing file's exact mode as promised, including bits
      // the daemon's umask would otherwise silently remove.
      await fs.promises.chmod(temporary, mode);
      await fs.promises.rename(temporary, settingsPath);
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async withClaudeProfileSettingsLock(profileRef, operation) {
    const previous = this.claudeProfileSettingsTails.get(profileRef) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    this.claudeProfileSettingsTails.set(profileRef, current);
    await previous.catch(() => {});
    const operationPromise = Promise.resolve().then(operation);
    const releaseWhenSettled = () => {
      release();
      if (this.claudeProfileSettingsTails.get(profileRef) === current) {
        this.claudeProfileSettingsTails.delete(profileRef);
      }
    };
    void operationPromise.finally(releaseWhenSettled).catch(() => {});
    return this.awaitClaudeActivationBound(
      operationPromise,
      this.claudeProfileSettingsOperationTimeoutMs,
      () => new ClaudeProfileSettingsOperationTimeoutError(),
    );
  }

  // Issue #204 — shared Claude user scope. The engine owns the operation
  // guard, filesystem transaction discipline, and persisted outcome; these
  // service methods keep the HTTP layer free of storage knowledge.
  enableSharedScope(options) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    return this.sharedScope.enable(options);
  }

  disableSharedScope(options) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    return this.sharedScope.disable(options);
  }

  applySharedScopeSettings(previous, settings) {
    if (previous.sharedUserScopeEnabled !== settings.sharedUserScopeEnabled) {
      this.requireManaged('claude');
      this.assertNoProviderManagement('claude');
    }
    return this.sharedScope.applySettings(previous, settings);
  }

  reconcileSharedScope(options) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    return this.sharedScope.reconcile(options);
  }

  async accountProfileSetChanged() {
    if (!this.isProviderManaged('claude') || this.providerTakeovers.has('claude')) return;
    try { return await this.sharedScope.profileSetChanged(); }
    catch (error) {
      if (error?.statusCode !== 409) throw error;
      return this.sharedScope.deferProfileSetChanged();
    }
  }

  async accountDetachProfile(account) {
    if (!this.isProviderManaged(account?.provider)) return;
    try { return await this.sharedScope.detachProfile(account); }
    catch (error) {
      if (error?.statusCode !== 409) throw error;
      return this.sharedScope.deferDetachProfile(account);
    }
  }

  rescheduleAutoRefresh(settings = this.store.getSettings()) {
    if (!this.autoRefreshStarted) return;
    const generation = ++this.autoRefreshGeneration;
    if (this.autoRefreshTimer != null) this.clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
    // A stale pause flag must not outlive the setting that produced it —
    // /api/state would keep reporting a pause until the next tick fires.
    // Issue #90: a customized interval lifts the cap immediately, so the
    // pause flag (and the deck's slowed-cadence indicator) clears here too.
    if (!settings.autoRefreshEnabled || !settings.pauseWhileActive
      || autoRefreshIntervalCustomized(settings)) {
      this.pausedForActiveSessions = false;
      this.activeProviderSessionPresent = false;
    }
    if (settings.autoRefreshEnabled) {
      if (this.lastCompletedRefreshAt == null) this.lastCompletedRefreshAt = this.now();
      this.armAutoRefresh(this.autoRefreshDelay(settings), generation);
    }
  }

  // Issue #90 (CodeRabbit, PR #111): the SINGLE source of truth for the
  // cadence the scheduler actually runs — the delay computation, the tick's
  // skip decision, and /api/state's reported effective interval all derive
  // from this one function, so report and reality can never diverge.
  //
  // Semantics while the cap applies (flag false + pauseWhileActive + session
  // running): effective = max(configured, cap). The cap SLOWS a fast
  // never-customized interval to 30 minutes; it never accelerates a slow
  // one — ModelDeck never polls providers faster than configured (a 3600s
  // interval persisted by a pre-#90 install stays 3600s, not 1800s).
  effectiveAutoRefreshIntervalMs(settings, activeSessionPresent = this.activeProviderSessionPresent) {
    const intervalMs = settings.autoRefreshIntervalSeconds * 1_000;
    // An explicitly chosen interval always wins — the active-session cap
    // only steers the never-customized cadence.
    if (!settings.pauseWhileActive || autoRefreshIntervalCustomized(settings)
      || !activeSessionPresent) return intervalMs;
    return Math.max(intervalMs, ACTIVE_SESSION_REFRESH_CAP_MS);
  }

  autoRefreshDelay(settings) {
    const intervalMs = settings.autoRefreshIntervalSeconds * 1_000;
    const effectiveMs = this.effectiveAutoRefreshIntervalMs(settings);
    if (effectiveMs === intervalMs) return intervalMs;
    const elapsedSinceRefresh = this.lastCompletedRefreshAt == null
      ? effectiveMs
      : this.now() - this.lastCompletedRefreshAt;
    // Wake at the configured interval to re-probe session presence, but
    // never past the effective due time.
    return Math.min(intervalMs, Math.max(0, effectiveMs - elapsedSinceRefresh));
  }

  armAutoRefresh(delayMs, generation, dueAt = this.now() + delayMs) {
    const run = () => {
      if (!this.autoRefreshStarted || generation !== this.autoRefreshGeneration) return;
      const remainingMs = dueAt - this.now();
      if (remainingMs > 0) {
        this.autoRefreshTimer = this.setTimeout(run, remainingMs);
        return;
      }

      this.autoRefreshTimer = null;
      const settings = this.store.getSettings();
      if (!settings.autoRefreshEnabled) return;

      const tick = this.runAutoRefreshTick(settings, generation);
      this.autoRefreshTickTasks.add(tick);
      const clearTick = () => this.autoRefreshTickTasks.delete(tick);
      void tick.then(clearTick, clearTick);
      void tick.catch((error) => {
        console.error(`[modeldeck] scheduled refresh failed: ${error?.message || error}`);
      }).finally(() => {
        if (!this.autoRefreshStarted || generation !== this.autoRefreshGeneration) return;
        const latest = this.store.getSettings();
        if (latest.autoRefreshEnabled) {
          // Schedule from completion time: missed ticks are dropped instead of
          // becoming provider-polling catch-up bursts after sleep or a slow pass.
          this.armAutoRefresh(this.autoRefreshDelay(latest), generation);
        }
      });
    };
    this.autoRefreshTimer = this.setTimeout(run, Math.max(0, dueAt - this.now()));
  }

  async runAutoRefreshTick(settings, generation) {
    let activeSessionPresent = false;
    // Issue #90: with a customized interval the cap never applies, so the
    // process probe is skipped entirely — the configured cadence is honored
    // as-is and no pause state can arise from it.
    if (settings.pauseWhileActive && !autoRefreshIntervalCustomized(settings)) {
      try {
        activeSessionPresent = (await this.listProviderProcesses()).length > 0;
      } catch (error) {
        // Failure to inspect presence must not become another silent-staleness
        // path. Poll normally and leave the provider processes untouched.
        console.error(`[modeldeck] active-session check failed: ${error?.message || error}`);
      }
    }
    if (!this.autoRefreshStarted || generation !== this.autoRefreshGeneration) return;
    this.activeProviderSessionPresent = activeSessionPresent;

    // Same shared cadence source as autoRefreshDelay and /api/state.
    const effectiveMs = this.effectiveAutoRefreshIntervalMs(settings, activeSessionPresent);
    const elapsedSinceRefresh = this.lastCompletedRefreshAt == null
      ? effectiveMs
      : this.now() - this.lastCompletedRefreshAt;
    if (activeSessionPresent && elapsedSinceRefresh < effectiveMs) {
      this.pausedForActiveSessions = true;
      return;
    }

    this.pausedForActiveSessions = false;
    try {
      const refresh = await this.refreshAll();
      // A settings change or shutdown can invalidate this generation while
      // the provider refresh is in flight. Do not begin a new CLI mutation
      // after the scheduled work that authorized it has been cancelled.
      if (this.autoRefreshStarted && generation === this.autoRefreshGeneration) {
        await this.runScheduledClaudeRenewals(refresh);
      }
    } finally {
      this.lastCompletedRefreshAt = this.now();
    }
  }

  async runningClaudeProcessCount() {
    return (await this.listProviderProcesses()).filter((command) => command === 'claude').length;
  }

  scanProjects(root = this.projectsRoot) {
    const detected = scanProjectRoot(root);
    return detected.map((project) => this.store.saveProject(project));
  }

  // Issue #89: which accounts' last refresh failure demands a fresh login.
  // Issue #98: keychain-denied failures ride along — either kind flips the
  // account's chip, so a transition in either must invalidate the cached
  // tool probe the same way (recordAccountRefreshResults diffs this set).
  signInRequiredByRefreshError() {
    return new Set([...this.accountRefreshErrors]
      .filter(([, entry]) => SIGN_IN_REQUIRED_ERROR_PATTERN.test(entry.message)
        || KEYCHAIN_DENIED_ERROR_PATTERN.test(entry.message))
      .map(([accountId]) => accountId));
  }

  // Issue #89: persist per-account refresh outcomes so /api/state can surface
  // them. Success clears; failure records message + timestamp. The
  // tool probe payload caches provider-level authState for up to toolProbeTtlMs;
  // a credentials-expired transition must not hide behind it — mirror the
  // duplicate-token invalidation.
  recordAccountRefreshResults(results) {
    const before = this.signInRequiredByRefreshError();
    const at = new Date(this.now()).toISOString();
    // Mirror the claudeWeeklyFingerprints pruning: a disabled or removed
    // account drops out of the refresh list, so a success can never clear
    // its entry — without this prune the stale error (and any derived
    // signin-required chip) would persist forever. Runs in the shared
    // helper, so both refreshClaude and refreshCodex prune; keyed on the
    // full enabled roster because the error map spans both providers.
    const enabledIds = new Set(this.store.listAccounts()
      .filter((account) => account.enabled)
      .map((account) => account.id));
    for (const accountId of [...this.accountRefreshErrors.keys()]) {
      if (!enabledIds.has(accountId)) this.accountRefreshErrors.delete(accountId);
    }
    for (const result of results) {
      if (result.ok) this.accountRefreshErrors.delete(result.accountId);
      else this.accountRefreshErrors.set(result.accountId, { message: result.error, at });
    }
    const after = this.signInRequiredByRefreshError();
    const changed = after.size !== before.size || [...after].some((id) => !before.has(id));
    if (changed) this.invalidateToolProbe();
  }

  async refreshClaude() {
    // Issue #174: fold in any statusline captures first. Probe rows are
    // stamped at insert time below, so this ordering can never let an older
    // capture shadow the fresh probe result.
    await this.ingestClaudeStatuslineCaptures().catch(() => {});
    const accounts = this.store.listAccounts().filter((account) => account.provider === 'claude' && account.enabled);
    const refreshedSnapshots = new Map();
    const results = await Promise.all(accounts.map(async (account) => {
      await this.refreshClaudeProfileMetadata(account).catch(() => {});
      try {
        this.requireClaudeHomeVerified(account);
        const snapshots = await this.fetchClaude({ claudeConfigDir: account.profileRef, ...this.providerReadOptions(account) });
        this.requireClaudeHomeVerified(account);
        this.rememberClaudeCredentialExpiry(account.id, snapshots);
        for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
        refreshedSnapshots.set(account.id, snapshots);
        return { accountId: account.id, ok: true, snapshotCount: snapshots.length };
      } catch (error) {
        return { accountId: account.id, ok: false, error: error.message };
      }
    }));
    const enabledIds = new Set(accounts.map((account) => account.id));
    for (const accountId of [...this.claudeCredentialExpiries.keys()]) {
      if (!enabledIds.has(accountId)) this.claudeCredentialExpiries.delete(accountId);
    }
    this.updateClaudeWeeklyFingerprints(accounts, refreshedSnapshots);
    this.recordAccountRefreshResults(results);
    return results;
  }

  updateClaudeWeeklyFingerprints(accounts, refreshedSnapshots) {
    // Fingerprints update only on usable evidence: a failed fetch or a
    // missing/stale/invalid weekly leaves the prior fingerprint — and any
    // duplicate-token flag — in place rather than silently clearing it.
    const enabledIds = new Set(accounts.map((account) => account.id));
    for (const accountId of [...this.claudeWeeklyFingerprints.keys()]) {
      if (!enabledIds.has(accountId)) this.claudeWeeklyFingerprints.delete(accountId);
    }
    for (const [accountId, snapshots] of refreshedSnapshots) {
      const fingerprint = weeklyResetFingerprint(snapshots);
      if (fingerprint !== null) this.claudeWeeklyFingerprints.set(accountId, fingerprint);
    }
    const next = duplicateAccountIdsByFingerprint(this.claudeWeeklyFingerprints);
    const previous = this.duplicateClaudeTokenAccountIds;
    this.duplicateClaudeTokenAccountIds = next;
    // The tool probe payload caches provider-level authState for up to
    // toolProbeTtlMs; a duplicate-token transition must not hide behind it.
    const changed = next.size !== previous.size || [...next].some((id) => !previous.has(id));
    if (changed) this.invalidateToolProbe();
    try {
      this.store.saveConfigLintFacts?.({
        claudeWeeklyFingerprints: Object.fromEntries([...this.claudeWeeklyFingerprints].sort()),
      });
    } catch { /* The linter reports an unavailable stored fact instead of breaking refresh. */ }
  }

  async refreshClaudeAccount(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account || account.provider !== 'claude' || !account.enabled) return null;
    await this.refreshClaudeProfileMetadata(account).catch(() => {});
    let result;
    const refreshedSnapshots = new Map();
    try {
      this.requireClaudeHomeVerified(account);
      const snapshots = await this.fetchClaude({
        claudeConfigDir: account.profileRef,
        ...this.providerReadOptions(account),
      });
      this.requireClaudeHomeVerified(account);
      this.rememberClaudeCredentialExpiry(account.id, snapshots);
      for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
      refreshedSnapshots.set(account.id, snapshots);
      result = { accountId: account.id, ok: true, snapshotCount: snapshots.length };
    } catch (error) {
      result = { accountId: account.id, ok: false, error: error.message };
    }
    const enabled = this.store.listAccounts()
      .filter((item) => item.provider === 'claude' && item.enabled);
    this.updateClaudeWeeklyFingerprints(enabled, refreshedSnapshots);
    this.recordAccountRefreshResults([result]);
    return result;
  }

  rememberClaudeCredentialExpiry(accountId, snapshots) {
    const expiresAt = snapshots?.expiresAt;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
      this.claudeCredentialExpiries.set(accountId, expiresAt);
    } else {
      this.claudeCredentialExpiries.delete(accountId);
    }
  }

  claudePostExpiryRenewalEligible(accountId, timestamp = this.now()) {
    // An expired-pattern refresh error can outlive the credential read it came
    // from; a still-future observed expiry means the account is not actually
    // dead, so a renewal attempt would be spent on nothing.
    const expiresAt = this.claudeCredentialExpiries.get(accountId);
    return !(expiresAt != null && expiresAt > timestamp);
  }

  async refreshClaudeProfileMetadata(account) {
    const [rateLimitTier, profileIdentity] = await Promise.all([
      this.readClaudeTier({ claudeConfigDir: account.profileRef }),
      this.readClaudeIdentity({ claudeConfigDir: account.profileRef }),
    ]);
    // Rebase on the freshest record after the awaits: a reset-identity that
    // landed mid-read must not be undone by saving a pre-reset snapshot.
    const latest = this.store.getAccount(account.id);
    if (!latest || latest.profileRef !== account.profileRef) return latest ?? account;
    const metadata = { ...latest.metadata };
    const currentPlan = metadata.claudePlan || {};
    if (rateLimitTier) metadata.claudePlan = {
      subscriptionType: currentPlan.subscriptionType ?? null,
      rateLimitTier,
    };
    // Backfill only: a recorded identity is the onboarding-time truth the
    // verifier checks against. Overwriting it from the live profile would
    // launder a real identity-mismatch into 'effective' on the next refresh.
    // The first capture needs the same care: an active, unscoped profile can
    // contain identity residue from the old shared-Keychain login.
    const identitySource = !latest.identity && profileIdentity?.identity
      ? await this.claudeIdentitySeedSource(latest.profileRef)
      : null;
    if (identitySource) {
      if (profileIdentity.accountUuid) metadata.claudeAccountUuid = profileIdentity.accountUuid;
      metadata.identitySource = identitySource;
    }
    const identity = latest.identity || (identitySource ? profileIdentity.identity : '');
    // The identity-seed lookup above is another await AFTER the rebase, so
    // rebase once more on the freshest row for every daemon-owned key this
    // call does not author — #522's ownership record, and the narrow
    // claudeRenewal/claudePlan windows for free.
    const authored = [];
    if (rateLimitTier) authored.push('claudePlan');
    if (identitySource) authored.push('claudeAccountUuid', 'identitySource');
    const current = this.store.getAccount(account.id);
    if (!current || current.profileRef !== account.profileRef) return current ?? account;
    const rebased = this.mergeDaemonMetadataAtPersist(latest.id, metadata, authored);
    if (identity === latest.identity && JSON.stringify(rebased) === JSON.stringify(latest.metadata)) return latest;
    return this.store.saveAccount({
      ...current, identity, metadata: rebased,
    });
  }

  async backfillClaudeIdentities() {
    const accounts = this.store.listAccounts().filter((account) => account.provider === 'claude');
    return Promise.all(accounts.map((account) => this.refreshClaudeProfileMetadata(account).catch(() => account)));
  }

  async claudeIdentitySeedSource(profileRef) {
    const profileRealPath = await this.realpath(profileRef);
    let activeRealPath = null;
    try {
      const stat = await fs.promises.lstat(this.claudeActiveLink);
      if (stat.isSymbolicLink()) activeRealPath = await this.realpath(this.claudeActiveLink);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (activeRealPath !== profileRealPath) return 'seed';

    return this.claudeSecureStorage.status === 'active'
      && this.claudeSecureStorage.value === profileRealPath
      ? 'verified'
      : null;
  }

  resetClaudeIdentity(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    if (account.provider !== 'claude') {
      const error = new Error('identity reset is only supported for claude accounts');
      error.statusCode = 400;
      throw error;
    }
    const metadata = { ...account.metadata };
    delete metadata.claudeAccountUuid;
    delete metadata.identitySource;
    return this.store.saveAccount({
      id: account.id, provider: account.provider, label: account.label,
      profileRef: account.profileRef, identity: '', purpose: account.purpose,
      color: account.color, enabled: account.enabled, metadata,
    });
  }

  async importClaudeSwapProfiles(selections) {
    this.requireManaged('claude');
    const imported = await this.migrateClaude({ selections, profilesDir: this.claudeProfilesDir });
    const saved = [];
    try {
      for (const profile of imported) {
        if (this.store.findAccount('claude', profile.profileRef)) throw new Error(`Claude profile is already registered: ${profile.profileRef}`);
        try {
          await this.ensureClaudeProfileExplainer({ profileRef: profile.profileRef });
        } catch (error) {
          console.error(`[modeldeck] profile explainer install failed during Claude profile import: ${error?.message || error}`);
        }
        let account = this.store.saveAccount({
          provider: 'claude',
          label: profile.label,
          profileRef: profile.profileRef,
          metadata: { migratedFromClaudeSwap: true },
        });
        account = await this.refreshClaudeProfileMetadata(account);
        saved.push(account);
      }
      await this.accountProfileSetChanged();
      for (const account of saved) await this.reconcileCreatedProfileTranscripts(account);
      return saved;
    } catch (error) {
      for (const account of saved) this.store.deleteAccount(account.id);
      for (const profile of imported) await fs.promises.rm(profile.profileRef, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // Issue #586 — the other first-run trap seen in the field: a real legacy
  // `~/.claude` blocks activation (the clobber guard, correctly), which used
  // to dead-end the add flow's step 1 with a raw error and no path forward.
  // This is the in-app resolution the sheet offers instead. Two modes:
  //   adopt — copy the legacy home into the account's (empty) profile home so
  //           the existing sign-in and settings carry over, then proceed;
  //   fresh — keep the profile home empty; the normal login follows.
  // Both then move the legacy directory aside to a timestamped backup (never
  // deleted) and flip the activation symlink. Ordering is non-destructive
  // first: copy, then backup rename, then symlink — with a rename rollback if
  // the flip fails, so no failure strands the machine without a `~/.claude`.
  // Round 2 (N1): shared scope writes into a brand-new profile home before
  // the adoption offer ever runs, which the emptiness guard must not read as
  // "populated". Replaceability is proven from the on-disk record, never the
  // file name alone (defect-class rule): `.claude.json` only while it is
  // exactly the shared-scope-generated mcp document (an object holding
  // nothing but an mcpServers object), `memory` only while it is ModelDeck's
  // own shared-memory symlink. Both are regenerated post-swap by the
  // profile-set-changed reconcile.
  async claudeAdoptionReplaceableEntries(profileRef) {
    const entries = [];
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(profileRef, '.claude.json'), 'utf8'));
      // Review #590 (CodeRabbit, thread on the round-1 diff): the absence of
      // a signed-in identity proves nothing about AUTHORSHIP — a user's own
      // .claude.json (theme, customApiKeyResponses, hand-written servers)
      // has no oauthAccount either, and the swap would destroy it. The only
      // .claude.json ModelDeck itself writes into a fresh profile home is
      // the shared-scope mcp document: a JSON object with exactly one
      // top-level property, mcpServers, holding an object — writeMcpDocument
      // always emits that key, so a bare {} is not provably ModelDeck's
      // (CodeRabbit follow-up) and counts as user content like any other
      // unrecognized shape. No ModelDeck path writes {} into a profile home:
      // creation makes a bare directory, and the reconcile either skips the
      // write or emits the mcpServers key.
      const isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
      const keys = isPlainObject(parsed) ? Object.keys(parsed) : null;
      if (keys && keys.length === 1 && keys[0] === 'mcpServers' && isPlainObject(parsed.mcpServers)) {
        entries.push('.claude.json');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return entries;
    }
    try {
      const memoryPath = path.join(profileRef, 'memory');
      const stat = await fs.promises.lstat(memoryPath);
      if (stat.isSymbolicLink()) {
        const [target, shared] = await Promise.all([
          fs.promises.realpath(memoryPath).catch(() => null),
          fs.promises.realpath(this.sharedScope.sharedMemoryDir).catch(() => null),
        ]);
        if (target && shared && target === shared) entries.push('memory');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return entries;
    }
    return entries;
  }

  async adoptClaudeLegacyHome(accountId, { mode = 'adopt' } = {}) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    if (mode !== 'adopt' && mode !== 'fresh') {
      const error = new Error(`unknown legacy adoption mode: ${mode}`);
      error.statusCode = 400;
      throw error;
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    if (account.provider !== 'claude') {
      const error = new Error('legacy home adoption is only supported for claude accounts');
      error.statusCode = 400;
      throw error;
    }
    this.beginClaudeActivation(accountId);
    let adopted;
    try {
      adopted = await this.withClaudeActivationLock(async () => {
        const latest = this.store.getAccount(accountId);
        if (!latest) throw new Error('account not found');
        if (!latest.enabled) throw new Error('account is disabled');
        let legacyStat;
        try {
          legacyStat = await fs.promises.lstat(this.claudeActiveLink);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          legacyStat = null;
        }
        if (legacyStat?.isSymbolicLink()) {
          const error = new Error(`there is no legacy Claude directory to adopt — ${this.claudeActiveLink} is already managed`);
          error.statusCode = 409;
          throw error;
        }
        const warnings = await this.claudeRunningSessionWarnings();
        // Review #590 (delete race): the copy below can run for minutes, and
        // deleteAccount is deliberately lock-free — so the account is
        // re-read after every long await. A vanished account aborts before
        // the store write (saveAccount would otherwise INSERT a zombie under
        // a fresh id) and before the point of no return (the backup rename).
        // In adopt mode the abort also removes the freshly copied contents,
        // so no credential copy outlives its deleted account.
        const requireAliveAccount = async ({ cleanupCopy = false, outcome = '; your existing Claude setup was not touched' } = {}) => {
          const current = this.store.getAccount(accountId);
          const refuse = async (why) => {
            if (cleanupCopy) {
              await fs.promises.rm(latest.profileRef, { recursive: true, force: true }).catch(() => {});
            }
            const error = new Error(`${why} while the adoption was running${outcome}`);
            error.statusCode = 409;
            throw error;
          };
          if (!current || !current.enabled) await refuse('account was removed or disabled');
          // Review #590 round 2 (CodeRabbit stale-account finding): an
          // update repointing the account's profile home mid-adoption would
          // otherwise let this flow activate a profile the record no
          // longer names.
          if (current.profileRef !== latest.profileRef) await refuse("the account's profile home was repointed");
          return current;
        };
        // Review #590 round 2 (N3): a MISSING active link is not "already
        // managed" — nothing pins new sessions yet, and calling it managed
        // would let the sheet skip activation and recreate the original
        // trap on the next plain login. Degenerate to a plain activation.
        if (!legacyStat) {
          await this.activateClaude({ profileRef: latest.profileRef, activeLink: this.claudeActiveLink, profilesDir: this.claudeProfilesDir });
          const previousPins = await this.captureClaudeScopePins();
          await this.scopeClaudeSecureStorage(latest.profileRef);
          try {
            await requireAliveAccount();
          } catch (error) {
            // Round 3 (R3-A): pre-call state was "no active link", so
            // restoring it means unlinking the symlink this call just
            // created — never leave ~/.claude pointing at a dead account.
            // Round 7 (pin rollback): the scope call above re-aimed the
            // shell pin and launchd values at the dead account's home; put
            // the pre-call pin state back too, and say so when that fails.
            await fs.promises.unlink(this.claudeActiveLink).catch(() => {});
            try {
              await this.restoreClaudeScopePins(previousPins);
            } catch (pinError) {
              error.message += `; ModelDeck could not restore the previous terminal environment pins (${errorMessage(pinError)})`;
            }
            throw error;
          }
          return { account: this.setDefaultAccount('claude', accountId), warnings, backupPath: null };
        }
        if (mode === 'adopt') {
          await this.adoptClaudeLegacy({
            sourceDir: this.claudeActiveLink,
            profileRef: latest.profileRef,
            profilesDir: this.claudeProfilesDir,
            replaceableEntries: await this.claudeAdoptionReplaceableEntries(latest.profileRef),
          });
          try {
            await this.ensureClaudeProfileExplainer({ profileRef: latest.profileRef });
          } catch (error) {
            console.error(`[modeldeck] profile explainer install failed during legacy home adoption: ${error?.message || error}`);
          }
          await requireAliveAccount({ cleanupCopy: true });
          // Round 2 (N1): shared scope's artifacts were verified-replaceable
          // and discarded by the swap — re-reconcile so the memory link and
          // the mcpServers merge land on the ADOPTED home (mirrors the
          // cswap import path). Round 3 (R3-B): the merge record from the
          // pre-adoption empty home is forgotten first, so the adopted
          // memory is backed up and merged like a newly arriving profile's.
          // Round 3 (R3-C): a reconcile failure restores an empty home so
          // the retry is never bricked by the emptiness guard — and the
          // adoption stamp lands only after this block, so metadata never
          // claims an adoption that didn't finish.
          try {
            await this.sharedScope.resetProfileMemoryMerge(this.store.getAccount(accountId));
            await this.accountProfileSetChanged();
          } catch (error) {
            // Round 4 (CodeRabbit): items the failed reconcile already
            // copied into shared memory are removed too — left behind, the
            // retry would re-copy them under collision-renamed duplicates.
            await this.sharedScope.undoProfileMemoryMerge(this.store.getAccount(accountId)).catch(() => {});
            await fs.promises.rm(latest.profileRef, { recursive: true, force: true }).catch(() => {});
            await fs.promises.mkdir(latest.profileRef, { recursive: true, mode: 0o700 }).catch(() => {});
            throw new Error(
              'adoption could not finish while shared settings were being reapplied — '
              + 'nothing was activated, and your existing Claude setup was not touched. '
              + `Start Fresh is still available. (${errorMessage(error)})`,
            );
          }
          const alive = await requireAliveAccount({ cleanupCopy: true });
          // Daemon-authored metadata rides the repo's rebase discipline
          // (mirrors refreshClaudeProfileMetadata) so a concurrent writer's
          // keys are never clobbered by this save.
          this.store.saveAccount({
            id: alive.id, provider: alive.provider, label: alive.label,
            profileRef: alive.profileRef, identity: alive.identity,
            purpose: alive.purpose, color: alive.color, enabled: alive.enabled,
            metadata: this.mergeDaemonMetadataAtPersist(
              alive.id,
              { ...alive.metadata, adoptedLegacyHome: true },
              ['adoptedLegacyHome'],
            ),
          });
        }
        await requireAliveAccount({ cleanupCopy: mode === 'adopt' });
        const backupPath = `${this.claudeActiveLink}.pre-modeldeck-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        if (await fs.promises.lstat(backupPath).then(() => true, () => false)) {
          throw new Error(`legacy Claude backup destination already exists: ${backupPath}`);
        }
        await this.moveLegacyHome(this.claudeActiveLink, backupPath);
        try {
          await this.activateClaude({ profileRef: latest.profileRef, activeLink: this.claudeActiveLink, profilesDir: this.claudeProfilesDir });
        } catch (error) {
          // Review #590 (live-session race): a rollback that fails (e.g. a
          // running session recreated a non-empty ~/.claude in the window,
          // making the rename ENOTEMPTY) must never be swallowed — the
          // user's real home is sitting at the backup path and the error is
          // the only place that can say so.
          try {
            await this.moveLegacyHome(backupPath, this.claudeActiveLink);
          } catch {
            throw new Error(
              `${errorMessage(error)} — your previous Claude setup is preserved at ${backupPath}; `
              + 'ModelDeck could not move it back automatically.',
            );
          }
          throw error;
        }
        const previousPins = await this.captureClaudeScopePins();
        await this.scopeClaudeSecureStorage(latest.profileRef);
        if (mode === 'adopt') {
          const refreshed = this.store.getAccount(accountId);
          if (refreshed) await this.refreshClaudeProfileMetadata(refreshed).catch(() => {});
        }
        // Deleted after the flip landed: undo the flip so ~/.claude never
        // points at a dead account's home, then report honestly. Round 2
        // (N2): renaming a DIRECTORY over a symlink is ENOTDIR, so the
        // symlink is unlinked first; only then can the backup move home —
        // and either undo step failing must name where the data sits
        // instead of being swallowed. Round 7 (pin rollback): the scope call
        // above re-aimed the shell pin and launchd values at a profile home
        // this branch may just have deleted — the pin restore runs after the
        // filesystem rollback on BOTH of its outcomes, and a pin failure is
        // surfaced on the same error instead of masking it.
        try {
          await requireAliveAccount({ cleanupCopy: mode === 'adopt', outcome: '' });
        } catch (raceError) {
          let filesystemRestored = true;
          try {
            await fs.promises.unlink(this.claudeActiveLink);
            await this.moveLegacyHome(backupPath, this.claudeActiveLink);
          } catch {
            filesystemRestored = false;
          }
          let pinFailure = null;
          try {
            await this.restoreClaudeScopePins(previousPins);
          } catch (error) {
            pinFailure = errorMessage(error);
          }
          raceError.message += filesystemRestored
            ? '; your previous Claude setup was restored'
            : `; your previous Claude setup is preserved at ${backupPath} — ModelDeck could not move it back automatically`;
          if (pinFailure) {
            raceError.message += `; ModelDeck could not restore the previous terminal environment pins (${pinFailure})`;
          }
          throw raceError;
        }
        return { account: this.setDefaultAccount('claude', accountId), warnings, backupPath };
      }, { queueTimeoutMs: this.claudeActivationQueueTimeoutMs });
    } finally {
      this.endClaudeActivation(accountId);
    }
    adopted.warnings.push(...await this.reconcileAccountTranscripts(adopted.account));
    return adopted;
  }

  // First-run trap seen in the field: with no provider CLI installed, step 1
  // used to succeed (profile home + account created), then step 2 exploded in
  // Terminal with "command not found" — leaving partial state and a user with
  // no path forward. Creation now refuses up front with the install command.
  // Only a definitive missing binary (ENOENT) blocks; any other version-read
  // failure fails open so a flaky read can never lock out account creation.
  async requireProviderCli(provider) {
    const spec = provider === 'claude'
      ? { binary: this.claudePath, label: 'Claude Code', packageName: '@anthropic-ai/claude-code' }
      : { binary: this.codexPath, label: 'the Codex CLI', packageName: '@openai/codex' };
    try {
      await this.installedToolVersion(spec.binary);
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
      throw new Error(
        `${spec.label} is not installed on this Mac. Install it first `
        + `(npm install -g ${spec.packageName}), then add this account.`,
      );
    }
  }

  initializeProviderManagement() {
    for (const provider of ['claude', 'codex']) {
      if (this.store.getSettings()[`${provider}Managed`] !== null) continue;
      const home = this[`${provider}ActiveLink`];
      try {
        if (!fs.lstatSync(home).isSymbolicLink()) continue;
        const root = fs.realpathSync(this[`${provider}ProfilesDir`]);
        const target = fs.realpathSync(home);
        const relative = path.relative(root, target);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          this.store.saveSettings({ [`${provider}Managed`]: true });
        }
      } catch { /* Unknown ownership never grants permission to manage a home. */ }
    }
  }

  isProviderManaged(provider) {
    return this.store.getSettings()[`${provider}Managed`] === true;
  }

  requireManaged(provider) {
    if (!this.isProviderManaged(provider)) {
      throw Object.assign(new Error(`ModelDeck does not manage ~/.${provider}. Turn on Manage account switching in Settings first.`), {
        code: 'not-managed', statusCode: 409,
      });
    }
  }

  providerProfileRef(account) {
    if (this.isProviderManaged(account.provider)) {
      return managedProfile(account.profileRef, this[`${account.provider}ProfilesDir`], account.provider);
    }
    const home = this[`${account.provider}ActiveLink`];
    let canonicalHome = path.resolve(home);
    try {
      if (!fs.lstatSync(home).isDirectory()) throw new Error('The provider home must be a real directory.');
      canonicalHome = fs.realpathSync(home);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const reference = fs.existsSync(account.profileRef) ? fs.realpathSync(account.profileRef) : path.resolve(account.profileRef);
    if (reference !== canonicalHome) {
      throw Object.assign(new Error('This account does not use the provider’s home folder.'), { code: 'not-managed', statusCode: 409 });
    }
    return canonicalHome;
  }

  providerReadOptions(account) {
    if (!this.isProviderManaged(account.provider)) this.providerProfileRef(account);
    return this.isProviderManaged(account.provider)
      ? { profilesDir: this[`${account.provider}ProfilesDir`] }
      : { unmanagedHome: this[`${account.provider}ActiveLink`] };
  }

  requireClaudeHomeVerified(account) {
    this.assertNoProviderManagement('claude');
    if (this.store.getAccount(account.id)?.metadata?.claudeHomeNeedsVerification) {
      throw new Error('The Claude folder moved. Check this subscription’s sign-in before reading usage; sign in explicitly before refreshing.');
    }
  }

  // A folder move changes Claude's macOS Keychain namespace. The provider's
  // own sign-in verification must establish identity in the destination.
  accountAfterHomeMove(account, profileRef) {
    return { ...account, profileRef, metadata: {
      ...account.metadata,
      ...(account.provider === 'claude' && this.platform === 'darwin' ? { claudeHomeNeedsVerification: true } : {}),
    } };
  }

  assertNoProviderManagement(provider) {
    if (this.providerTakeovers.has(provider)) {
      throw Object.assign(new Error('Account switching is being changed. Please wait for it to finish.'), { code: 'management-in-progress', statusCode: 409 });
    }
  }

  assertProviderIdle(provider) {
    if (this.providerManagementOperations.has(provider) || this.providerTakeovers.size > 0
        || (provider === 'codex' && this.codexActivationCount > 0)
        || (provider === 'claude' && (this.claudeRenewalPromise || this.claudeActivationAccountCounts.size
          || this.claudeActivationSafetyFence || this.claudeProfileSettingsTails.size || this.sharedScope.operation))) {
      throw Object.assign(new Error('Account work is in progress. Please wait for it to finish.'), { code: 'management-in-progress', statusCode: 409 });
    }
  }

  async captureProviderEnvironment(provider) {
    const files = {};
    for (const file of [this[`${provider}ShellEnvFile`], this.configLintZshenvPath]) {
      try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile()) throw new Error('The terminal environment must be a real file.');
        files[file] = { bytes: await fs.promises.readFile(file), mode: stat.mode & 0o777 };
      } catch (error) { if (error.code !== 'ENOENT') throw error; files[file] = null; }
    }
    const pins = provider === 'claude' ? await this.captureClaudeScopePins() : null;
    if (pins && (pins.shellPin === undefined || Object.values(pins.launchd ?? {}).some((value) => value === undefined))) {
      throw new Error('The existing terminal environment could not be read. Account switching was not changed.');
    }
    return { files, pins };
  }

  async restoreProviderEnvironment(provider, captured) {
    this.requireManaged(provider);
    for (const [file, original] of Object.entries(captured.files)) {
      if (original === null) await fs.promises.rm(file, { force: true });
      else {
        const temporary = `${file}.modeldeck-${crypto.randomUUID()}`;
        try {
          await fs.promises.writeFile(temporary, original.bytes, { mode: 0o600, flag: 'wx' });
          await fs.promises.chmod(temporary, original.mode);
          await fs.promises.rename(temporary, file);
        } finally { await fs.promises.rm(temporary, { force: true }); }
      }
    }
    // The file snapshot above already restored the shell pin, including its mode.
    if (captured.pins) await this.restoreClaudeScopePins({ ...captured.pins, shellPin: undefined });
  }

  // Hold the provider reservation until both filesystem and record rollback finish.
  async takeOverProvider(provider, continuation = async () => undefined) {
    const accounts = this.store.listAccounts().filter((account) => account.provider === provider);
    if (accounts.length > 1) throw Object.assign(new Error('Keep one registered account before enabling account switching.'), { statusCode: 409 });
    if (!accounts.length) {
      const previous = this.store.getSettings()[`${provider}Managed`];
      this.store.saveSettings({ [`${provider}Managed`]: true });
      try { return await continuation(); }
      catch (error) { this.store.saveSettings({ [`${provider}Managed`]: previous }); throw error; }
    }
    const account = accounts[0];
    this.providerProfileRef(account);
    const home = this[`${provider}ActiveLink`];
    const previous = this.store.getSettings()[`${provider}Managed`];
    const environment = await this.captureProviderEnvironment(provider);
    let profileRef;
    let moved = false;
    let originalMode;
    let linked = false;
    this.providerTakeovers.add(provider);
    this.store.saveSettings({ [`${provider}Managed`]: true });
    try {
      profileRef = await (provider === 'claude' ? this.createClaudeProfile : this.createCodexProfile)({
        profilesDir: this[`${provider}ProfilesDir`], profileName: account.label,
      });
      let exists = true;
      try { await fs.promises.lstat(home); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
      if (exists) {
        originalMode = (await fs.promises.lstat(home)).mode & 0o777;
        await fs.promises.rmdir(profileRef);
        await this.moveLegacyHome(home, profileRef);
        moved = true;
        await fs.promises.chmod(profileRef, 0o700);
      }
      if (provider === 'claude') await this.activateClaude({ profileRef, activeLink: home, profilesDir: this.claudeProfilesDir });
      else await this.activateCodexProfile(profileRef);
      linked = true;
      this.store.saveAccount({ ...this.accountAfterHomeMove(account, profileRef), isDefault: true });
      if (provider === 'claude') {
        const pins = await this.scopeClaudeSecureStorage(profileRef);
        if (pins.error) throw new Error(pins.error);
      } else await this.writeCodexShellEnvFile(profileRef);
      await this.installProviderShellHook(provider);
      return await continuation();
    } catch (error) {
      try {
        const currentLink = await fs.promises.lstat(home).catch((statError) => { if (statError.code !== 'ENOENT') throw statError; return null; });
        if (linked || currentLink?.isSymbolicLink()) {
          if (!currentLink?.isSymbolicLink() || fs.realpathSync(home) !== profileRef) throw new Error('The provider home changed during setup.');
          await fs.promises.unlink(home);
        }
        if (moved) {
          await this.moveLegacyHome(profileRef, home);
          await fs.promises.chmod(home, originalMode);
        }
        else if (profileRef) await fs.promises.rmdir(profileRef).catch((cleanupError) => { if (cleanupError.code !== 'ENOENT') throw cleanupError; });
        await this.restoreProviderEnvironment(provider, environment);
        this.store.saveSettings({ [`${provider}Managed`]: previous });
        this.store.saveAccount(account);
      } catch (rollbackError) {
        throw new Error(`Account switching could not be restored. Your files are preserved at ${moved ? profileRef : home}. ${rollbackError.message}`, { cause: error });
      }
      throw error;
    } finally { this.providerTakeovers.delete(provider); }
  }

  async releaseProviderHome(provider) {
    this.requireManaged(provider);
    if (provider === 'claude') {
      throw Object.assign(serviceError(CLAUDE_UNMANAGE_UNAVAILABLE_REASON, 409), { code: 'claude-unmanage-unavailable' });
    }
    const accounts = this.store.listAccounts().filter((account) => account.provider === provider);
    if (accounts.length !== 1) throw Object.assign(new Error('Keep exactly one account to turn off account switching.'), { statusCode: 409 });
    const account = accounts[0];
    const profileRef = this.providerProfileRef(account);
    const home = this[`${provider}ActiveLink`];
    if (!fs.lstatSync(home).isSymbolicLink() || fs.realpathSync(home) !== profileRef) {
      throw Object.assign(new Error('Activate the remaining account before turning off account switching.'), { statusCode: 409 });
    }
    const environment = await this.captureProviderEnvironment(provider);
    let unlinked = false;
    let moved = false;
    try {
      await fs.promises.unlink(home);
      unlinked = true;
      await this.moveLegacyHome(profileRef, home);
      moved = true;
      await updateProviderShellHook({ target: this.configLintZshenvPath, provider, remove: true });
      await fs.promises.rm(this[`${provider}ShellEnvFile`], { force: true });
      if (provider === 'claude') {
        const launchd = environment.pins.launchd && Object.fromEntries(Object.keys(environment.pins.launchd).map((key) => [key, null]));
        await this.restoreClaudeScopePins({ shellPin: null, secureStorage: { value: null, status: 'inactive' }, launchd });
      }
      this.store.saveAccount(this.accountAfterHomeMove(account, home));
      this.store.saveSettings({ [`${provider}Managed`]: false });
    } catch (error) {
      try {
        if (moved) await this.moveLegacyHome(home, profileRef);
        if (unlinked) await fs.promises.symlink(profileRef, home, 'dir');
        await this.restoreProviderEnvironment(provider, environment);
        this.store.saveAccount(account);
      } catch (rollbackError) {
        throw new Error(`Account switching could not be restored. Your files remain at ${moved ? home : profileRef}. ${rollbackError.message}`, { cause: error });
      }
      throw error;
    }
  }

  async updateSettings(input) {
    // Validate the whole document before starting any filesystem operation.
    this.store.validateSettings(input);
    const previous = this.store.getSettings();
    if (previous.claudeManaged === true && input.claudeManaged === false) {
      throw Object.assign(serviceError(CLAUDE_UNMANAGE_UNAVAILABLE_REASON, 409), { code: 'claude-unmanage-unavailable' });
    }
    const changes = ['claude', 'codex'].filter((provider) => Object.hasOwn(input, `${provider}Managed`)
      && input[`${provider}Managed`] !== previous[`${provider}Managed`]);
    const differs = (key) => JSON.stringify(input[key]) !== JSON.stringify(previous[key]);
    if (changes.length && Object.keys(input).some((key) => !key.endsWith('Managed') && differs(key))) {
      throw Object.assign(new Error('Change account switching separately from other settings.'), { statusCode: 400 });
    }
    if (changes.length > 1) throw Object.assign(new Error('Change account switching for one provider at a time.'), { statusCode: 400 });
    for (const provider of changes) {
      const value = input[`${provider}Managed`];
      if (provider === 'claude' && previous.sharedUserScopeEnabled) {
        throw Object.assign(new Error('Turn off shared Claude settings before changing account switching.'), { statusCode: 409 });
      }
      if (value === null) throw Object.assign(new Error('Choose whether ModelDeck manages account switching.'), { statusCode: 400 });
      this.assertProviderIdle(provider);
      this.providerManagementOperations.add(provider);
      this.providerTakeovers.add(provider);
      try {
        if (value === true) await this.takeOverProvider(provider);
        else if (this.isProviderManaged(provider)) await this.releaseProviderHome(provider);
      } finally {
        this.providerManagementOperations.delete(provider);
        this.providerTakeovers.delete(provider);
      }
    }
    return this.store.saveSettings(input);
  }

  async createClaudeAccount(input = {}) {
    return this.createProviderAccount('claude', input);
  }

  async createCodexAccount(input = {}) {
    return this.createProviderAccount('codex', input);
  }

  async createProviderAccount(provider, input) {
    if (!input.label?.trim()) throw new Error('account label is required');
    this.assertNoProviderManagement(provider);
    if (this.accountProfileCreations.has(provider)) throw serviceError('Another account is being added. Try again in a moment.', 409);
    if (!this.isProviderManaged(provider) && input.manageProvider === true) this.assertProviderIdle(provider);
    if (this.providerManagementOperations.has(provider)) this.assertProviderIdle(provider);
    this.providerManagementOperations.add(provider);
    try {
      if (!this.isProviderManaged(provider)) {
        const accounts = this.store.listAccounts().filter((account) => account.provider === provider);
        if (accounts.length) {
          if (input.manageProvider !== true) {
            throw Object.assign(new Error(`Switching between accounts needs ModelDeck to manage ~/.${provider}.`), { code: 'manage-required', statusCode: 409 });
          }
          this.providerTakeovers.add(provider);
          return await this.takeOverProvider(provider, () => this.createManagedProviderAccount(provider, input));
        }
        await this.requireProviderCli(provider);
        const profileRef = this.providerProfileRef({ provider, profileRef: this[`${provider}ActiveLink`] });
        return this.store.saveAccount({ provider, label: input.label, identity: input.identity, purpose: input.purpose, color: input.color, profileRef, isDefault: true });
      }
      return await this.createManagedProviderAccount(provider, input);
    } finally {
      this.providerManagementOperations.delete(provider);
      this.providerTakeovers.delete(provider);
    }
  }

  createManagedProviderAccount(provider, input) {
    return provider === 'claude' ? this.createManagedClaudeAccount(input) : this.createManagedCodexAccount(input);
  }

  profileIsRegistered(profileRef) {
    let target;
    try { target = fs.statSync(profileRef); } catch {}
    return this.store.listAccounts().some((account) => {
      if (!account.profileRef) return false;
      if (path.resolve(account.profileRef) === profileRef) return true;
      if (!target) return false;
      try {
        const registered = fs.statSync(account.profileRef);
        return registered.dev === target.dev && registered.ino === target.ino;
      } catch { return false; }
    });
  }

  // Inspect only the derived base name, without opening any user files.
  // An explicit choice is required before an orphan is reused or bypassed.
  async accountProfileForCreation(provider, label, existingProfile) {
    if (existingProfile !== undefined && !['adopt', 'fresh'].includes(existingProfile)) {
      throw serviceError('existingProfile must be adopt or fresh', 400);
    }
    const profilesDir = provider === 'claude' ? this.claudeProfilesDir : this.codexProfilesDir;
    const root = await fs.promises.realpath(profilesDir).catch((error) => {
      if (error.code === 'ENOENT') return path.resolve(profilesDir);
      throw error;
    });
    const name = safeProfileName(label);
    const existingPath = path.join(root, name);
    const stat = await fs.promises.lstat(existingPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const registered = this.profileIsRegistered(existingPath);
    if (existingProfile === 'adopt') {
      if (registered) throw serviceError('This profile is already used by another account.', 409);
      if (!stat?.isDirectory()) throw serviceError('The existing profile must be a real directory.', 400);
      if (process.getuid && stat.uid !== process.getuid()) {
        throw serviceError('The existing profile must be owned by the current user.', 400);
      }
      const entries = await fs.promises.readdir(existingPath, { withFileTypes: true });
      if (entries.some((entry) => entry.isSymbolicLink())) {
        throw serviceError('The existing profile contains a symbolic link. Choose Start fresh instead.', 400);
      }
      await fs.promises.chmod(existingPath, 0o700);
      return { profileRef: existingPath, adopted: true };
    }
    if (stat && !registered && existingProfile !== 'fresh') {
      // Best-effort summary for the prompt: a directory the daemon cannot read
      // is skipped rather than failing the whole choice, and the walk stops at
      // a bound so a huge projects tree cannot stall the add (CodeRabbit #649).
      let transcripts = 0;
      let visited = 0;
      const countTranscripts = async (directory) => {
        if (visited >= 2000) return;
        visited += 1;
        const directoryStat = await fs.promises.lstat(directory).catch(() => null);
        if (!directoryStat?.isDirectory()) return;
        const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isDirectory()) await countTranscripts(path.join(directory, entry.name));
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) transcripts += 1;
        }
      };
      if (provider === 'claude' && stat.isDirectory()) await countTranscripts(path.join(existingPath, 'projects'));
      const error = serviceError(`A profile named ${name} already exists. Adopt it or start fresh.`, 409);
      error.code = 'profile-exists';
      error.profile = { path: existingPath, name, transcripts, lastModified: stat.mtime.toISOString() };
      if (provider === 'codex') {
        error.profile.hasCredential = stat.isDirectory() && await fs.promises.lstat(path.join(existingPath, 'auth.json'))
          .then((authStat) => authStat.isFile(), (error) => { if (error.code === 'ENOENT') return false; throw error; });
      }
      throw error;
    }
    const create = provider === 'claude' ? this.createClaudeProfile : this.createCodexProfile;
    const profileRef = await create({ profilesDir, profileName: label });
    const profileNote = stat && existingProfile === 'fresh'
      ? `Created a new profile at ${profileRef}. The old folder was left at ${existingPath}.`
      : undefined;
    return { profileRef, adopted: false, profileNote };
  }

  async createManagedClaudeAccount({ label, identity, purpose = '', color, isDefault = false, existingProfile } = {}) {
    this.requireManaged('claude');
    if (!label?.trim()) throw new Error('account label is required');
    await this.requireProviderCli('claude');
    if (this.accountProfileCreations.has('claude')) throw serviceError('Another account is being added. Try again in a moment.', 409);
    this.accountProfileCreations.add('claude');
    let profileRef, adopted, profileNote;
    let account;
    try {
      ({ profileRef, adopted, profileNote } = await this.accountProfileForCreation('claude', label, existingProfile));
      try {
        await this.ensureClaudeProfileExplainer({ profileRef });
      } catch (error) {
        console.error(`[modeldeck] profile explainer install failed during Claude account creation: ${error?.message || error}`);
      }
      // Recheck after filesystem awaits: two concurrent adopters cannot
      // attach the same folder to different accounts.
      if (adopted && this.profileIsRegistered(profileRef)) throw serviceError('This profile is already used by another account.', 409);
      account = this.store.saveAccount({ provider: 'claude', label, identity, purpose, color, profileRef });
      account = await this.refreshClaudeProfileMetadata(account);
      account = isDefault ? this.setDefaultAccount('claude', account.id) : account;
      await this.accountProfileSetChanged();
      await this.reconcileCreatedProfileTranscripts(account);
      return profileNote ? { ...account, profileNote } : account;
    } catch (error) {
      if (account) this.store.deleteAccount(account.id);
      if (profileRef && !adopted) await fs.promises.rm(profileRef, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      this.accountProfileCreations.delete('claude');
    }
  }

  // Issue #8, step 1 mirror of createClaudeAccount: the app supplies
  // provider + label + purpose + color and ModelDeck creates the isolated
  // owner-only CODEX_HOME. Login stays with the provider (step 2).
  async createManagedCodexAccount({ label, identity, purpose = '', color, isDefault = false, existingProfile } = {}) {
    this.requireManaged('codex');
    if (!label?.trim()) throw new Error('account label is required');
    await this.requireProviderCli('codex');
    if (this.accountProfileCreations.has('codex')) throw serviceError('Another account is being added. Try again in a moment.', 409);
    this.accountProfileCreations.add('codex');
    let profileRef, adopted, profileNote;
    let account;
    try {
      ({ profileRef, adopted, profileNote } = await this.accountProfileForCreation('codex', label, existingProfile));
      if (adopted && this.profileIsRegistered(profileRef)) throw serviceError('This profile is already used by another account.', 409);
      account = this.store.saveAccount({ provider: 'codex', label, identity, purpose, color, profileRef });
      account = isDefault ? this.setDefaultAccount('codex', account.id) : account;
      await this.reconcileCreatedProfileTranscripts(account);
      return profileNote ? { ...account, profileNote } : account;
    } catch (error) {
      if (account) this.store.deleteAccount(account.id);
      if (profileRef && !adopted) await fs.promises.rmdir(profileRef).catch(() => {});
      throw error;
    } finally {
      this.accountProfileCreations.delete('codex');
    }
  }

  // Daemon-owned metadata keys are written by verify/refresh, never by API
  // callers — an edit that re-sends a stale metadata object must not clobber
  // them (CodeRabbit, PR #29).
  //
  // Issue #522: `clientKeyHelper` is the foreign-helper guard's ownership
  // record, and it is daemon-owned in BOTH directions. A stale re-send that
  // dropped it would leave settings.json on the per-profile helper while the
  // shell env re-pinned the legacy item — two surfaces fetching different
  // profiles' keys, the exact mis-attribution this record exists to prevent —
  // and would then 409 every wire and unwire. A caller-SUPPLIED value is
  // equally dangerous in reverse: it would let an API client declare an
  // arbitrary helper "ours" and have ModelDeck overwrite or delete it. The
  // stored value therefore always wins over whatever the input carries.
  static DAEMON_OWNED_METADATA = ['claudePlan', 'claudeAccountUuid', 'identitySource', 'claudeRenewal', 'codexPlan', 'migratedFromClaudeSwap', 'clientKeyHelper', 'claudeHomeNeedsVerification', 'sharedTranscriptLinks'];

  /// Must be applied at the PERSISTENCE POINT, not on entry to an async
  /// caller. It reads the stored row and returns the merged input
  /// synchronously, so a call adjacent to `store.saveAccount` is atomic
  /// against the event loop; a snapshot taken before an `await` is not.
  /// `saveAccount` awaits profile validation and the explainer install
  /// between the two, and a client-key migration landing in that window would
  /// otherwise be erased by the pending save committing its stale snapshot —
  /// the same wipe the daemon-owned list exists to prevent, arriving by
  /// timing instead of by stale re-send (CodeRabbit, PR #532).
  /// Rebase daemon-owned metadata on the FRESHEST stored row, for a caller
  /// about to persist. `authored` names the daemon-owned keys this particular
  /// call legitimately writes — a verify refreshing `claudePlan`, say — and
  /// those are left alone; every other daemon-owned key is taken from the
  /// fresh row, or dropped when the fresh row has none.
  ///
  /// Call it IMMEDIATELY before the write. Read-merge-write is synchronous
  /// and therefore atomic against the event loop; a snapshot taken before an
  /// `await` is not, and every clobber in this class came from exactly that.
  mergeDaemonMetadataAtPersist(accountId, metadata, authored = []) {
    const freshest = this.store.getAccount(accountId);
    const merged = { ...metadata };
    for (const key of ModelDeckService.DAEMON_OWNED_METADATA) {
      if (authored.includes(key)) continue;
      // The STORED value always wins: present, it is restored over whatever
      // the caller sent; absent, a caller-supplied value is dropped rather
      // than adopted. Restoring alone would still let an API client mint
      // daemon-owned state on an account that has none — for #522's
      // `clientKeyHelper` that means declaring an arbitrary helper "ours"
      // and having ModelDeck overwrite or delete it.
      const stored = freshest?.metadata?.[key];
      if (stored !== undefined) merged[key] = stored;
      else delete merged[key];
    }
    return merged;
  }

  preserveDaemonMetadata(input) {
    if (input?.metadata && Object.hasOwn(input.metadata, 'sharedTranscriptLinks')) {
      const metadata = { ...input.metadata };
      delete metadata.sharedTranscriptLinks;
      input = { ...input, metadata };
    }
    if (!input?.id || input.metadata == null) return input;
    const existing = this.store.getAccount(input.id);
    if (!existing?.metadata) return input;
    // An API caller authors none of these keys.
    return { ...input, metadata: this.mergeDaemonMetadataAtPersist(input.id, input.metadata) };
  }

  /// Shared by discovery and registration: a Grok home must not already
  /// belong to any other account. At refresh time duplicate Grok accounts
  /// would both poll xAI for the same folder, while a Claude or Codex match
  /// would send that provider's bearer token to xAI. Both sides are
  /// canonicalized so symlinks and `..` cannot bypass the comparison.
  async grokHomeRegisteredProvider(canonical, accountId = null) {
    for (const account of this.store.listAccounts()) {
      if (account.id === accountId) continue;
      const other = await this.realpath(account.profileRef).catch(() => null);
      if (other === canonical) return account.provider;
    }
    return null;
  }

  async inspectGrokProfileRef(input) {
    if (!input.profileRef?.trim()) throw new Error('Grok profile home is required');
    const requested = path.resolve(input.profileRef.trim());
    let canonical;
    try {
      canonical = await this.realpath(requested);
    } catch {
      return unavailableGrokProfileInspection(requested);
    }
    let inspection;
    try {
      inspection = await inspectGrokHomeDirectory(canonical, { uid: this.uid });
    } catch {
      return unavailableGrokProfileInspection(requested, canonical);
    }
    const alreadyRegisteredAs = inspection.isDirectory
      ? await this.grokHomeRegisteredProvider(canonical, input.id)
      : null;
    return { requested, path: canonical, ...inspection, alreadyRegisteredAs };
  }

  async validatedGrokProfileRef(input) {
    const inspected = await this.inspectGrokProfileRef(input);
    // CodeRabbit (PR #559): registration used to accept any directory and
    // leave permissions to refresh time. A group- or other-WRITABLE home lets
    // another local user swap in their own `auth.json` — a regular file, so
    // the symlink guard never fires — and the probe would send that token
    // instead. Refuse at the door, and again on every refresh
    // (`assertGrokProfileHome`) in case it is made writable later. Read
    // access is not the vector and is not policed: a stock `~/.grok` is 0755
    // with the credential itself at 0600.
    await assertGrokHomeDirectory(inspected.path, { inspection: inspected });
    if (inspected.alreadyRegisteredAs) {
      throw serviceError(grokForeignHomeMessage(inspected.alreadyRegisteredAs), 400);
    }
    return inspected.path;
  }

  async grokHomeCandidate(candidatePath) {
    const selected = candidatePath?.trim() || this.grokHome;
    if (!selected) throw serviceError('Grok home discovery is not configured', 500);
    const inspected = await this.inspectGrokProfileRef({ profileRef: selected });
    const resolvedDefault = this.grokHome ? path.resolve(this.grokHome) : null;
    const canonicalDefault = resolvedDefault
      ? await fs.promises.realpath(resolvedDefault).catch(() => resolvedDefault)
      : null;
    const isDefault = inspected.path === canonicalDefault;
    let sessionsRoot = path.join(inspected.path, 'sessions');
    if (isDefault && this.grokSessionsDir) {
      const configuredSessions = path.resolve(this.grokSessionsDir);
      sessionsRoot = await fs.promises.realpath(configuredSessions).catch(() => path.resolve(
        inspected.path,
        path.relative(resolvedDefault, configuredSessions),
      ));
    }
    const [hasCredentials, lastSessionAt] = await Promise.all([
      inspected.isDirectory ? grokCredentialsPresent(inspected.path) : false,
      inspected.permissionsOk && !inspected.alreadyRegisteredAs
        ? latestGrokSessionAt(sessionsRoot, this.grokHomeDiscoveryEntryLimit)
        : null,
    ]);
    let hint = null;
    if (!inspected.exists) {
      hint = `No Grok home found at ${inspected.path}. Run grok to create it and sign in.`;
    } else {
      try {
        await assertGrokHomeDirectory(inspected.path, { inspection: inspected });
      } catch (error) {
        hint = error.message;
      }
      if (!hint && inspected.alreadyRegisteredAs) {
        hint = grokForeignHomeMessage(inspected.alreadyRegisteredAs);
      }
      if (!hint && !hasCredentials) {
        hint = 'Grok profile does not contain stored credentials. Run grok to sign in before connecting this folder.';
      }
    }
    return {
      path: inspected.path,
      exists: inspected.exists,
      isDirectory: inspected.isDirectory,
      ownedByCurrentUser: inspected.ownedByCurrentUser,
      writableByOthers: inspected.writableByOthers,
      permissionsOk: inspected.permissionsOk,
      hasCredentials,
      alreadyRegisteredAs: inspected.alreadyRegisteredAs,
      lastSessionAt,
      hint,
      readFiles: [
        path.join(inspected.path, 'auth.json'),
        path.join(sessionsRoot, '*', '*', 'updates.jsonl'),
      ],
    };
  }

  async saveAccount(input) {
    if (['claude', 'codex'].includes(input.provider)) {
      const existing = input.id ? this.store.getAccount(input.id) : null;
      if (!this.isProviderManaged(input.provider)) {
        if (!existing) {
          if (input.profileRef && path.resolve(input.profileRef) !== path.resolve(this[`${input.provider}ActiveLink`])) this.requireManaged(input.provider);
          return this.createProviderAccount(input.provider, this.preserveDaemonMetadata(input));
        }
        this.assertNoProviderManagement(input.provider);
        this.providerProfileRef({ ...existing, ...input });
        return this.store.saveAccount(this.preserveDaemonMetadata({ ...existing, ...input, profileRef: existing.profileRef }));
      }
      this.assertNoProviderManagement(input.provider);
    }
    // Every `store.saveAccount` below re-reads the daemon-owned keys
    // IMMEDIATELY before writing, so nothing that lands during the awaits in
    // between can be clobbered by a stale snapshot. The create paths get the
    // same treatment through their own delegation.
    if (input.provider === 'codex') {
      if (!input.profileRef) return this.createCodexAccount(this.preserveDaemonMetadata(input));
      // Caller-supplied Codex homes get the same containment contract as
      // Claude: they must live inside ModelDeck's managed profiles directory.
      const profileRef = await validateCodexProfileHome({ profileRef: input.profileRef, profilesDir: this.codexProfilesDir });
      const account = this.store.saveAccount(this.preserveDaemonMetadata({ ...input, profileRef }));
      if (input.isDefault) this.invalidateToolProbe();
      await this.reconcileCreatedProfileTranscripts(account);
      return account;
    }
    if (input.provider === 'grok') {
      const profileRef = await this.validatedGrokProfileRef(input);
      const account = this.store.saveAccount(this.preserveDaemonMetadata({ ...input, profileRef }));
      if (input.isDefault) this.invalidateToolProbe();
      return account;
    }
    if (input.provider !== 'claude') {
      const account = this.store.saveAccount(this.preserveDaemonMetadata(input));
      if (input.isDefault) this.invalidateToolProbe();
      return account;
    }
    if (!input.profileRef) return this.createClaudeAccount(this.preserveDaemonMetadata(input));
    const profileRef = await validateClaudeProfileHome({ profileRef: input.profileRef, profilesDir: this.claudeProfilesDir });
    try {
      await this.ensureClaudeProfileExplainer({ profileRef });
    } catch (error) {
      console.error(`[modeldeck] profile explainer install failed during Claude profile registration: ${error?.message || error}`);
    }
    let account = this.store.saveAccount(this.preserveDaemonMetadata({ ...input, profileRef }));
    if (!account.enabled) {
      this.claudeCredentialExpiries.delete(account.id);
    }
    account = await this.refreshClaudeProfileMetadata(account);
    if (input.isDefault) this.invalidateToolProbe();
    await this.accountProfileSetChanged();
    await this.reconcileCreatedProfileTranscripts(account);
    return account;
  }

  // Issue #99: historical version-based flow selection for steering where a
  // Claude credential lands.
  //   'config-dir'  (< 2.1.216): CLAUDE_CONFIG_DIR +
  //     CLAUDE_SECURESTORAGE_CONFIG_DIR scope the Keychain entry, so an
  //     env-scoped login lands in the profile's own slot.
  //   'activation'  (>= 2.1.216): affected releases key credentials off
  //     realpath(~/.claude) regardless of environment. Activate the target
  //     profile FIRST, then run a plain `claude /login`. A fake-HOME variant
  //     does NOT work: claude treats it as a fresh install and resets the
  //     profile's .claude.json.
  // Claude later reverted the resolved-home behavior without a dependable
  // version boundary. Keep this conservative, compatible selection: the
  // activation path remains valid with the shell's active-profile pins, and
  // guessing a second transition would re-expose affected intermediate CLIs.
  // An undetectable version fails toward 'activation': that flow steers
  // correctly on every known version, while 'config-dir' silently
  // cross-wires accounts on the affected releases.
  async claudeLoginFlow(claudeExecutable = this.claudePath) {
    let version;
    try {
      version = await this.installedToolVersion(claudeExecutable);
    } catch {
      return 'activation';
    }
    return compareSemver(version, CLAUDE_RESOLVED_HOME_CREDENTIALS_MIN_VERSION) >= 0
      ? 'activation'
      : 'config-dir';
  }

  // Issue #8, step 2: the exact provider-owned login command for one account,
  // for the app to run in the user's own terminal. ModelDeck never performs
  // the login itself and never sees credentials. Known pitfall
  // (docs/HANDOFF.md): this must never construct a `logout` invocation.
  async loginSpec(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    if (!account.enabled) throw new Error('account is disabled');
    if (account.provider === 'claude') {
      const profileRef = this.providerProfileRef(account);
      // Issue #300: Terminal inherits the user's PATH, which may resolve a
      // different bare `claude` than the daemon probed. Resolve through the
      // daemon's PATH first, dereference the result, then use that exact file
      // for both the version decision and the command served to Terminal.
      const claudeExecutable = await this.realpath(
        await this.toolExecutablePath(this.claudePath),
      );
      const flow = this.isProviderManaged('claude') ? await this.claudeLoginFlow(claudeExecutable) : 'config-dir';
      // Issue #596 detector, half 1: snapshot the default home's identity at
      // serve time so a signed-out verify can tell "a login landed in the
      // default home during this attempt" apart from long-standing unmanaged
      // state. First snapshot per attempt wins: re-serving the command (the
      // sheet's Copy refetch, an out-of-band GET) must never overwrite a
      // baseline after a stray login already landed, or the re-serve would
      // disarm the very diagnostic this exists for. Only a clean
      // authenticated verify or account deletion concludes the attempt.
      // The PROMISE is stored, not the value: check-and-set stays atomic
      // (no await between them), so concurrent serves cannot both capture
      // and a later capture can never replace the first.
      if (this.isProviderManaged('claude') && !this.claudeStrayLoginBaseline.has(account.id)) {
        this.claudeStrayLoginBaseline.set(account.id, this.claudeDefaultHomeIdentitySnapshot());
      }
      if (flow === 'activation') {
        // Issue #99 fix direction 1: the caller must activate this account
        // first (requiresActivation) so ~/.claude resolves to the target
        // profile — on affected releases the credential keys off that
        // resolved home and the environment cannot steer it. The env pin
        // below is still required (issue #596): the identity file
        // .claude.json is a SIBLING of the symlink, so in an unpinned shell
        // the login writes it to the default home where the profile
        // read-back never looks; where the ~/.zshenv shell pins exist it is
        // redundant-but-harmless, both sources resolving to the same
        // activation-recorded real path. Within the app flow, activation and
        // the pin name the same profile and cannot disagree the way the
        // pre-#99 env-only guidance could. Residual hazard, accepted
        // (decision 0038): a COPY of this command replayed after a later
        // account switch disagrees with the then-active home, and on the
        // 2.1.216-era builds that splits identity and credential across
        // profiles (docs/CLAUDE_IDENTITY.md scopes it; the verify mismatch
        // refusal remains the backstop). Verify the identity while the
        // target is still active; only then optionally restore the
        // previously active account.
        return {
          provider: 'claude',
          account,
          flow,
          requiresActivation: true,
          command: claudeExecutable,
          args: ['/login'],
          env: { CLAUDE_CONFIG_DIR: profileRef, CLAUDE_SECURESTORAGE_CONFIG_DIR: profileRef },
          preview: `${CLAUDE_MANAGED_KEY_UNSET_FRAGMENT}; CLAUDE_CONFIG_DIR=${shellQuote(profileRef)} CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellQuote(profileRef)} ${shellQuote(claudeExecutable)} /login`,
        };
      }
      return {
        provider: 'claude',
        account,
        flow,
        requiresActivation: false,
        command: claudeExecutable,
        args: ['auth', 'login'],
        // Issue #66: both vars pinned to the same canonical profile path so
        // the login session cannot pair one profile's storage with another's
        // credential scope.
        env: { CLAUDE_CONFIG_DIR: profileRef, CLAUDE_SECURESTORAGE_CONFIG_DIR: profileRef },
        preview: `${CLAUDE_MANAGED_KEY_UNSET_FRAGMENT}; CLAUDE_CONFIG_DIR=${shellQuote(profileRef)} CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellQuote(profileRef)} ${shellQuote(claudeExecutable)} auth login`,
      };
    }
    const profileRef = this.providerProfileRef(account);
    return {
      provider: 'codex',
      account,
      command: this.codexPath,
      args: ['login'],
      env: { CODEX_HOME: profileRef },
      preview: `CODEX_HOME=${shellQuote(profileRef)} ${shellQuote(this.codexPath)} login`,
    };
  }

  // Issue #596: identity snapshot of the DEFAULT home's .claude.json —
  // the file an UNPINNED `claude` writes. `known: false` means the read
  // failed for any reason other than the file not existing (mid-rewrite
  // truncation, a non-regular file, an oversized file): the state is
  // unknown, which must never be conflated with "no identity" — a null
  // baseline over a real long-standing identity would flag every later
  // signed-out verify as a stray login. Metadata read only, never a
  // credential; normalization mirrors readClaudeProfileIdentity so
  // baseline and verify-time reads always compare like with like.
  async claudeDefaultHomeIdentitySnapshot() {
    const file = path.join(this.claudeDefaultHome, '.claude.json');
    let raw;
    try {
      const stat = await fs.promises.lstat(file);
      // Regular files only, size-bounded: a FIFO here would hang the read
      // (and the daemon's fs threadpool) and this is an unmanaged path.
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return { known: false };
      raw = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { known: true, identity: null, accountUuid: null };
      return { known: false };
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { known: false }; }
    const email = parsed?.oauthAccount?.emailAddress;
    const uuid = parsed?.oauthAccount?.accountUuid;
    return {
      known: true,
      identity: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null,
      accountUuid: typeof uuid === 'string' && uuid.trim() ? uuid.trim() : null,
    };
  }

  // Issue #596 detector, half 2: on a signed-out verify, an oauthAccount in
  // the DEFAULT home's .claude.json that CHANGED since this account's login
  // command was served is a login that escaped the profile during this
  // attempt. Comparing against the serve-time baseline (not file mtime) is
  // what keeps long-standing pre-adoption identities — whose file Claude
  // Code rewrites constantly for history and project trust — from flagging
  // every ordinary signed-out verify. Either side unknown → no claim. The
  // baseline lives in memory only, so a daemon restart mid-attempt merely
  // degrades this hint to the generic result.
  async claudeStrayDefaultLogin(accountId) {
    // The map holds the snapshot promise (see loginSpec); it never rejects.
    const baseline = await this.claudeStrayLoginBaseline.get(accountId);
    if (!baseline?.known) return null;
    const current = await this.claudeDefaultHomeIdentitySnapshot();
    if (!current.known) return null;
    if (!current.identity && !current.accountUuid) return null;
    if (current.identity === baseline.identity && current.accountUuid === baseline.accountUuid) return null;
    return { strayed: true };
  }

  // Issue #8, step 3: read back the authenticated identity via the provider's
  // own status command (never a logout, never credential files) and persist
  // it on the account so the roster can show "Signed in as …".
  async verifyAccount(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    this.assertNoProviderManagement(account.provider);
    const result = account.provider === 'claude'
      // Public issue #2, second sighting: the login step resolved the CLI
      // through the install-dir fallback, but this read-back spawned the
      // bare name under the daemon's static PATH — so a native-installer
      // claude in ~/.local/bin signed in fine and then "wasn't installed"
      // at verify. Both steps must resolve the executable the same way.
      ? await this.readClaudeAuth({ claudePath: await this.spawnableToolPath(this.claudePath), claudeConfigDir: account.profileRef, ...this.providerReadOptions(account) })
      : await this.readCodexAuth({ binary: await this.spawnableToolPath(this.codexPath), codexHome: account.profileRef, ...this.providerReadOptions(account) });
    let verifyHint;
    if (account.provider === 'claude' && !result.authenticated && this.isProviderManaged('claude')) {
      // Issue #596: an unpinned shell writes the login identity to the
      // DEFAULT ~/.claude.json — a sibling of the active-profile symlink,
      // which the flip cannot steer. When the profile reads signed-out but
      // the default home's identity changed since this account's login
      // command was served, name what happened instead of the generic "not
      // signed in yet" — it pinpoints WHY the profile is empty, which the
      // bare Keychain-slot observation cannot. Metadata only (identity
      // fields, never credential values), and best effort like the Keychain
      // diagnostic below.
      const stray = await this.claudeStrayDefaultLogin(account.id).catch(() => null);
      if (stray) {
        verifyHint = CLAUDE_STRAY_LOGIN_VERIFY_HINT;
      } else {
        // Best effort only: a denied/unavailable Keychain diagnostic must not
        // turn an ordinary signed-out result into a verification error.
        const slots = await this.claudeCredentialKeychainSlotState({
          claudeConfigDir: account.profileRef,
          platform: this.platform,
        }).catch(() => null);
        if (slots?.profileScoped === false && slots.unscoped === true) {
          verifyHint = CLAUDE_DEFAULT_KEYCHAIN_VERIFY_HINT;
        }
      }
    }
    this.assertNoProviderManagement(account.provider);
    const latest = this.store.getAccount(account.id);
    if (!latest || latest.profileRef !== account.profileRef) {
      throw Object.assign(new Error('The account folder changed during verification. Please verify again.'), {
        code: 'management-in-progress', statusCode: 409,
      });
    }
    // Issue #99 fix direction 2 (the #65 blind spot's enforcement teeth):
    // compare the read-back identity against the intended account BEFORE
    // persisting anything. On mismatch, refuse: persisting would launder the
    // wrong login into a recorded identity, and a bare success would leave
    // the deck showing wrong data behind all-Healthy chips. The response
    // names the mismatch explicitly so every caller can alert.
    if (account.provider === 'claude' && result.authenticated) {
      const expected = account.identity?.trim().toLowerCase() || null;
      const actual = result.identity?.trim().toLowerCase() || null;
      if (expected && actual && expected !== actual) {
        // Credential presence did change even though nothing is recorded.
        this.authPresenceCache.delete(`claude:${account.profileRef}`);
        this.invalidateToolProbe();
        return {
          account,
          authenticated: true,
          identity: result.identity,
          identityMismatch: { expected: account.identity, actual: result.identity },
        };
      }
    }
    const confirmsMovedHome = latest.metadata?.claudeHomeNeedsVerification && result.authenticated;
    if (confirmsMovedHome && !result.identity?.trim()) {
      return { account: latest, authenticated: false, verifyHint: 'Claude did not identify this sign-in after the folder moved. Sign in to this subscription, then verify again.' };
    }
    // Issue #596: a clean authenticated verify ends the login attempt this
    // account's baseline was tracking.
    if (account.provider === 'claude' && result.authenticated) {
      this.claudeStrayLoginBaseline.delete(account.id);
    }
    let saved = latest;
    // Issue #26: persist the plan facts the status read surfaced alongside
    // the identity — same call, no extra provider work.
    const claudePlan = account.provider === 'claude' && result.plan
      && (result.plan.subscriptionType || result.plan.rateLimitTier)
      ? {
          subscriptionType: result.plan.subscriptionType || account.metadata?.claudePlan?.subscriptionType || null,
          rateLimitTier: result.plan.rateLimitTier || account.metadata?.claudePlan?.rateLimitTier || null,
        }
      : null;
    const codexPlan = account.provider === 'codex' ? codexPlanMetadata(result.plan?.planType) : null;
    const identityChanged = result.authenticated && result.identity && result.identity !== account.identity;
    const planChanged = result.authenticated && (
      (claudePlan && JSON.stringify(claudePlan) !== JSON.stringify(account.metadata?.claudePlan || null))
      || (account.provider === 'codex'
        && JSON.stringify(codexPlan) !== JSON.stringify(account.metadata?.codexPlan || null))
    );
    if (identityChanged || planChanged || confirmsMovedHome) {
      const metadata = { ...account.metadata };
      if (confirmsMovedHome) delete metadata.claudeHomeNeedsVerification;
      if (claudePlan) metadata.claudePlan = claudePlan;
      if (account.provider === 'codex') {
        if (codexPlan) metadata.codexPlan = codexPlan;
        else delete metadata.codexPlan;
      }
      // The provider auth probe above spawns the provider CLI and can run for
      // seconds; `account` is the pre-probe snapshot. Rebase the daemon-owned
      // keys this call does NOT author immediately before writing, or a
      // client-key migration that landed during the probe is erased — the
      // record rolls back to legacy, unwire 409-wedges, and the next
      // shell-env write splits the two surfaces onto different profiles'
      // keys (security re-review of PR #532).
      const authored = account.provider === 'codex' ? ['codexPlan'] : [];
      if (claudePlan) authored.push('claudePlan');
      if (confirmsMovedHome) authored.push('claudeHomeNeedsVerification');
      saved = this.store.saveAccount({
        ...latest,
        identity: identityChanged ? result.identity : account.identity,
        metadata: this.mergeDaemonMetadataAtPersist(
          account.id,
          planChanged || confirmsMovedHome ? metadata : account.metadata,
          authored,
        ),
      });
    }
    // Login runs outside the daemon. A verification is the authoritative
    // signal that credential presence may have changed, so do not retain the
    // pre-login account or provider auth result.
    if (account.provider === 'claude') this.authPresenceCache.delete(`claude:${account.profileRef}`);
    // Issue #89: an authenticated verify supersedes the recorded refresh
    // failure — the chip must flip back without waiting for the next tick.
    if (result.authenticated) this.accountRefreshErrors.delete(account.id);
    this.invalidateToolProbe();
    return {
      account: saved,
      authenticated: Boolean(result.authenticated),
      identity: (result.authenticated && (result.identity || saved.identity)) || null,
      ...(verifyHint ? { verifyHint } : {}),
    };
  }

  async refreshCodex() {
    const accounts = this.store.listAccounts().filter((account) => account.provider === 'codex' && account.enabled);
    const results = await Promise.all(accounts.map(async (account) => {
      await this.refreshCodexPlanTier(account).catch(() => {});
      await this.refreshCodexAccountIdentifier(account).catch(() => {});
      try {
        const snapshots = await this.fetchCodex({ binary: this.codexPath, codexHome: account.profileRef, ...this.providerReadOptions(account) });
        for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
        return { accountId: account.id, ok: true, snapshotCount: snapshots.length };
      } catch (error) {
        return { accountId: account.id, ok: false, error: error.message };
      }
    }));
    // Issue #108 — mirror of the Claude fingerprint block in refreshClaude:
    // prune identifiers for accounts no longer enabled, then recompute the
    // duplicate set. Two enabled profiles whose auth.json carries the same
    // tokens.account_id hold the same real account, so every member of a
    // matching group is flagged.
    const enabledIds = new Set(accounts.map((account) => account.id));
    for (const accountId of [...this.codexAccountIdentifiers.keys()]) {
      if (!enabledIds.has(accountId)) this.codexAccountIdentifiers.delete(accountId);
    }
    const next = duplicateAccountIdsByFingerprint(this.codexAccountIdentifiers);
    const previous = this.duplicateCodexTokenAccountIds;
    this.duplicateCodexTokenAccountIds = next;
    // The tool probe payload caches provider-level authState for up to
    // toolProbeTtlMs; a duplicate-token transition must not hide behind it.
    const changed = next.size !== previous.size || [...next].some((id) => !previous.has(id));
    if (changed) this.invalidateToolProbe();
    this.recordAccountRefreshResults(results);
    return results;
  }

  // Decision 0035, stage two. Deliberately the plainest of the three refresh
  // passes: no plan side-read, no duplicate-token fingerprint, no activation —
  // none of that exists for Grok yet. It records the same usage snapshots and
  // the same per-account refresh outcomes, and it runs inside the SAME pass
  // as the other two, so it adds no background polling of its own.
  async refreshGrok() {
    const accounts = this.store.listAccounts().filter((account) => account.provider === 'grok' && account.enabled);
    // Accounts with no Grok profile can't be probed; skipping the whole pass
    // keeps refreshAll's shape identical for the (overwhelmingly common)
    // no-Grok install.
    if (!accounts.length) return [];
    const results = await Promise.all(accounts.map(async (account) => {
      try {
        const snapshots = await this.fetchGrok({ grokHome: account.profileRef });
        for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
        return { accountId: account.id, ok: true, snapshotCount: snapshots.length };
      } catch (error) {
        return { accountId: account.id, ok: false, error: error.message };
      }
    }));
    this.recordAccountRefreshResults(results);
    return results;
  }

  // Issue #108: refresh one account's remembered auth.json identifier.
  // Evidence memory (the PR #77 lesson): a missing/unreadable auth.json or an
  // absent account_id is NOT evidence a duplicate resolved — the prior
  // identifier (and any live duplicate-token flag) stays until a readable
  // auth.json provides fresh evidence. A re-login writes a new auth.json, so
  // the flag clears exactly when the credentials actually separate.
  async refreshCodexAccountIdentifier(account) {
    const { accountId } = await this.readCodexAccountId({ codexHome: account.profileRef });
    if (accountId != null) this.codexAccountIdentifiers.set(account.id, accountId);
  }

  // Reads only the profile's existing auth.json during the normal refresh
  // pass. This does not alter refresh scheduling or the usage probe request.
  async refreshCodexPlanTier(account) {
    const plan = await this.readCodexPlan({ codexHome: account.profileRef });
    const latest = this.store.getAccount(account.id);
    if (!latest || latest.profileRef !== account.profileRef) return;
    const next = codexPlanMetadata(plan?.planType);
    const current = latest.metadata?.codexPlan || null;
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const metadata = { ...latest.metadata };
    if (next) metadata.codexPlan = next;
    else delete metadata.codexPlan;
    // Rebase daemon-owned keys at the persistence point so a concurrent
    // transcript reconcile cannot be erased by this stale snapshot.
    const rebased = this.mergeDaemonMetadataAtPersist(account.id, metadata, ['codexPlan']);
    this.store.saveAccount({
      ...latest,
      metadata: rebased,
    });
  }

  async refreshAll() {
    if (this.codexProfilesMigrationPromise) await this.codexProfilesMigrationPromise;
    if (this.codexProfilesMigrationBlocked) throw serviceError(this.codexProfilesMigrationWarning, 503);
    // Demo fixture mode: the seeded snapshots ARE the data — a provider
    // refresh could only fail (placeholder accounts hold no credentials)
    // and would wrongly degrade auth chips. Report a truthful no-op.
    if (this.demoFixtures) {
      return { demoFixtures: true, claude: null, codex: null, grok: null, checkedAt: new Date().toISOString() };
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const result = { claude: null, codex: null, grok: null, checkedAt: new Date().toISOString() };
      // Issue #377: a local file read, no provider traffic. The recursive
      // watcher above is the fast path (about a second); this is the backstop
      // for platforms without recursive fs.watch and for a watcher that died.
      await this.ingestClaudeStatuslineSessionModels().catch(() => {});
      try {
        result.claude = { ok: true, profiles: await this.refreshClaude() };
        if (result.claude.profiles.some((item) => !item.ok)) result.claude.ok = false;
      }
      catch (error) { result.claude = { ok: false, error: error.message }; }
      result.codex = { ok: true, profiles: await this.refreshCodex() };
      if (result.codex.profiles.some((item) => !item.ok)) result.codex.ok = false;
      // Decision 0035: additive and last. A Grok failure can never change what
      // the other two report, and an install with no Grok accounts leaves the
      // key null — exactly what an older app already ignores.
      try {
        const profiles = await this.refreshGrok();
        if (profiles.length) {
          result.grok = { ok: !profiles.some((item) => !item.ok), profiles };
        }
      } catch (error) { result.grok = { ok: false, error: error.message }; }
      return result;
    })();
    try { return await this.refreshPromise; }
    finally {
      this.refreshPromise = null;
      this.lastCompletedRefreshAt = this.now();
    }
  }

  async claudeAuthOverrideState(profileRef) {
    let raw;
    try {
      raw = await fs.promises.readFile(path.join(profileRef, 'settings.json'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ...CLAUDE_AUTH_OVERRIDE_ABSENT, readable: true };
      return { ...CLAUDE_AUTH_OVERRIDE_ABSENT, readable: false };
    }
    let settings;
    try {
      settings = JSON.parse(raw);
    } catch {
      return { ...CLAUDE_AUTH_OVERRIDE_ABSENT, readable: false };
    }
    const object = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : null;
    const env = object && object.env && typeof object.env === 'object' && !Array.isArray(object.env)
      ? object.env
      : null;
    const present = (key) => Boolean(env && Object.hasOwn(env, key));
    return {
      authOverride: CLAUDE_AUTH_CREDENTIAL_KEYS.some(present),
      proxyRouted: present('ANTHROPIC_BASE_URL'),
      // Issue #277 adversarial review: injecting the CLIProxy client key must
      // not key off base-URL PRESENCE — a corporate gateway or an explicit
      // api.anthropic.com URL is not CLIProxy, and handing it ModelDeck's
      // client key would be wrong. Only a loopback base URL qualifies.
      cliproxyRouted: isLoopbackUrl(env ? env.ANTHROPIC_BASE_URL : null),
      // Issue #263: reported, deliberately NOT treated as an auth override.
      // An apiKeyHelper is what BLINDED renewal (it outranks the stored OAuth
      // in `claude auth status`, so the CLI named nobody) — but the renewal
      // child no longer reads this file at all, so these accounts stay
      // renewable. Marking them overridden here would take away the very
      // capability this issue restores. DaemonModels.swift has documented
      // renew.authOverride as covering "an apiKeyHelper/env override" since
      // #225 while nothing in the daemon read the key; this closes that gap
      // on the reporting side only.
      helperRouted: Boolean(object && typeof object.apiKeyHelper === 'string' && object.apiKeyHelper.trim()),
      readable: true,
    };
  }

  renewalAttemptHistory(account, timestamp = this.now()) {
    const stored = account?.metadata?.claudeRenewal?.attempts;
    if (!Array.isArray(stored)) return [];
    const cutoff = timestamp - CLAUDE_RENEWAL_DAY_MS;
    return stored.filter((at) => {
      const parsed = Date.parse(at);
      return Number.isFinite(parsed) && parsed > cutoff && parsed <= timestamp;
    });
  }

  recordClaudeRenewalAttempt(accountId, attempt) {
    const account = this.store.getAccount(accountId);
    if (!account) return attempt;
    const timestamp = Date.parse(attempt.at);
    const attempts = this.renewalAttemptHistory(account, Number.isFinite(timestamp) ? timestamp : this.now());
    if (CLAUDE_RENEWAL_BUDGET_OUTCOMES.has(attempt.outcome)) attempts.push(attempt.at);
    const claudeRenewal = {
      ...account.metadata?.claudeRenewal,
      attempts,
      lastAttempt: attempt,
    };
    // Leftovers from the removed pre-expiry renewal path (#564): prune them
    // from stored metadata as attempts land so old rows converge clean.
    delete claudeRenewal.lastPreExpiryAttemptAt;
    delete claudeRenewal.postExpiryGuardUntil;
    const metadata = {
      ...account.metadata,
      claudeRenewal,
    };
    this.store.saveAccount({
      id: account.id,
      provider: account.provider,
      label: account.label,
      identity: account.identity,
      purpose: account.purpose,
      profileRef: account.profileRef,
      color: account.color,
      enabled: account.enabled,
      metadata,
    });
    return attempt;
  }

  renewalAttemptAllowed(account) {
    const timestamp = this.now();
    const history = this.renewalAttemptHistory(account, timestamp);
    if (history.length >= CLAUDE_RENEWAL_DAILY_LIMIT) return false;
    const lastAt = history.reduce((latest, at) => Math.max(latest, Date.parse(at)), Number.NEGATIVE_INFINITY);
    return timestamp - lastAt >= CLAUDE_RENEWAL_BACKOFF_MS;
  }

  // Issue #263. A CLIProxyAPI-routed profile's settings.json carries a
  // top-level `apiKeyHelper`, and the CLI resolves that helper BEFORE the
  // stored OAuth credential — so `claude auth status --json` answers
  // `{"loggedIn":true,"authMethod":"api_key_helper"}` with NO email and NO
  // orgId. claudeRenewalIdentityMatches is fail-closed, so it declines, every
  // attempt falls through to the flip rung, and an always-on user's sessions
  // defer that rung forever. Four of Tim's six accounts had ZERO completed
  // renewals in 24h while the two profiles without an apiKeyHelper renewed
  // themselves on the no-flip rung with the same sessions running.
  //
  // The fix rests on a hand-test — the one #176 specified and closed
  // "by construction" without ever running — against CLI 2.1.223 on
  // 2026-08-05: CLAUDE_CONFIG_DIR (which supplies settings.json) and
  // CLAUDE_SECURESTORAGE_CONFIG_DIR (which selects the Keychain item) are
  // INDEPENDENT knobs. Pointing the config dir at a scratch directory that
  // holds only a link to the profile's .claude.json — no settings.json,
  // therefore no apiKeyHelper and no proxy base URL — while the securestorage
  // dir stays on the real profile turned all four accounts from
  // `authMethod:"api_key_helper"` with no identity into `authMethod:"claude.ai"`
  // reporting their own email, org and Max tier.
  //
  // .claude.json is LINKED rather than copied so the CLI's writes still reach
  // the profile exactly as they do today. The link is re-asserted on every
  // call: if the CLI ever replaces it with a regular file (an atomic
  // write-then-rename would), the next renewal restores the link, so the
  // profile's own file can go one run stale but can never be clobbered.
  async claudeRenewalConfigDir(profileRef) {
    if (!this.isProviderManaged('claude')) return this.providerProfileRef({ provider: 'claude', profileRef });
    try {
      const suffix = crypto.createHash('sha256').update(String(profileRef).normalize('NFC'))
        .digest('hex').slice(0, 12);
      const dir = path.join(this.claudeRenewalScratchDir, `cfg-${suffix}`);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      // The whole point of the scratch dir is that NO settings reach the
      // child. Nothing ModelDeck runs writes these, but assert the invariant
      // rather than trust it: a stray file here silently restores the exact
      // blindness this issue exists to remove. Failures are NOT swallowed —
      // a settings file we could not clear must abort the renewal, not run
      // the CLI against it.
      for (const name of ['settings.json', 'settings.local.json']) {
        await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
      }

      const target = path.resolve(profileRef, '.claude.json');
      const link = path.join(dir, '.claude.json');
      let targetExists = true;
      try {
        await fs.promises.access(target, fs.constants.F_OK);
      } catch {
        targetExists = false;
      }
      let current = null;
      try {
        current = await fs.promises.readlink(link);
      } catch {
        // Absent, or present as a regular file — either way it is replaced below.
      }
      if (!targetExists) {
        // No identity to carry. The matcher stays fail-closed, exactly as
        // before this change; leaving a dangling link would only confuse it.
        await fs.promises.rm(link, { recursive: true, force: true });
        return dir;
      }
      if (current !== target) {
        await fs.promises.rm(link, { recursive: true, force: true });
        await fs.promises.symlink(target, link);
      }
      return dir;
    } catch (error) {
      // Adversarial review of #263: without this marker a failure of
      // ModelDeck's OWN setup reaches performClaudeRenewal as "the CLI named
      // nobody" — indistinguishable from the bug being fixed, which is the
      // one confusion this issue must not reintroduce.
      error.modeldeckRenewalStage = 'config-dir';
      throw error;
    }
  }

  claudeRenewalEnv(profileRef, configDir) {
    // Required, deliberately: a default of `profileRef` would let a future
    // caller silently hand the profile's settings.json — and its
    // apiKeyHelper — back to the renewal child, reinstating #263.
    if (!configDir) throw new Error('claudeRenewalEnv requires an explicit renewal config dir');
    const env = { ...this.childEnv };
    for (const key of CLAUDE_AUTH_OVERRIDE_KEYS) delete env[key];
    // #263: settings come from the scratch dir, credentials from the profile.
    env.CLAUDE_CONFIG_DIR = configDir;
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = profileRef;
    // Native Claude resolves its Keychain item from USER. launchd does not
    // reliably supply it, so restore only the OS username just as the normal
    // auth-status adapter does.
    env.USER = this.userInfo().username;
    return env;
  }

  async runClaudeRenewalCli(args, profileRef) {
    await fs.promises.mkdir(this.claudeRenewalScratchDir, { recursive: true, mode: 0o700 });
    const configDir = await this.claudeRenewalConfigDir(profileRef);
    // Issue #224 pinned the base URL back to Anthropic for proxy-routed
    // profiles, but only on the `-p` rung, because `claude auth status`
    // rejects the flag outright (`error: unknown option '--settings'` — now
    // hand-verified, #263). The scratch config dir above already withholds
    // the profile's settings.json from BOTH rungs, so this pin is no longer
    // load-bearing; it is kept as an explicit belt-and-braces assertion that
    // the renewal request goes to Anthropic and not through the pool.
    if (args[0] === '-p') {
      const override = await this.claudeAuthOverrideState(profileRef);
      if (override.proxyRouted) args = [...args, '--settings', CLAUDE_RENEWAL_SETTINGS_OVERRIDE];
    }
    // Public issue #2: renewal spawns the CLI from the daemon too. Like
    // installedToolVersion, the bare name goes first and the install-dir
    // fallback answers only an ENOENT — so a PATH-visible CLI spawns
    // exactly once, and a native-installer one in ~/.local/bin still runs.
    const spawn = (binary) => this.exec(binary, args, {
      // cwd stays the shared scratch ROOT, unchanged from before #263. Only
      // the env moves. Pointing cwd at the per-account config dir would have
      // made it a project path for the CLI (a second settings search location)
      // and scattered the CLI's transcript spill across one directory per
      // account, for no benefit — CLAUDE_CONFIG_DIR is explicit.
      cwd: this.claudeRenewalScratchDir,
      env: this.claudeRenewalEnv(profileRef, configDir),
      timeout: CLAUDE_RENEWAL_TIMEOUT_MS,
      maxBuffer: 1_000_000,
    });
    try {
      return await spawn(this.claudePath);
    } catch (error) {
      if (error?.code !== 'ENOENT' || path.isAbsolute(this.claudePath)) throw error;
      const fallback = await this.toolPathFallback(this.claudePath);
      if (!fallback) throw error;
      return spawn(fallback);
    }
  }

  // Issue #280: the renewal identity rung and the on-demand verifier must be
  // the SAME cheap provider read. Keeping the fixed auth-status argv here
  // makes the verifier's no-inference contract structural: unlike
  // finishClaudeRenewal, this helper has no path to the `-p` rung.
  async readScopedClaudeAuthStatus(profileRef) {
    let invocation;
    let failed = false;
    try {
      invocation = await this.runClaudeRenewalCli(['auth', 'status', '--json'], profileRef);
    } catch (error) {
      invocation = error;
      failed = true;
    }
    return {
      invocation,
      failed,
      reportedIdentity: claudeRenewalStatusIdentity(invocation?.stdout),
    };
  }

  // Promotion is deliberately a conditional metadata mutation, not a
  // refresh-time rewrite. Re-read after the provider await so reset-identity
  // or an identity edit that landed meanwhile cannot be resurrected or
  // certified from stale evidence.
  promoteSeededClaudeIdentity(accountId, profileRef, reportedIdentity) {
    const account = this.store.getAccount(accountId);
    if (!account
      || account.provider !== 'claude'
      || account.profileRef !== profileRef
      || account.metadata?.identitySource !== 'seed'
      || !claudeRenewalIdentityMatches(account, reportedIdentity)) {
      return account;
    }

    const metadata = { ...account.metadata, identitySource: 'verified' };
    const storedUuid = typeof metadata.claudeAccountUuid === 'string'
      ? metadata.claudeAccountUuid.trim()
      : '';
    if (!storedUuid && reportedIdentity.accountUuids.size === 1) {
      metadata.claudeAccountUuid = [...reportedIdentity.accountUuids][0];
    }
    return this.store.saveAccount({
      id: account.id,
      provider: account.provider,
      label: account.label,
      identity: account.identity,
      purpose: account.purpose,
      profileRef: account.profileRef,
      color: account.color,
      enabled: account.enabled,
      metadata,
    });
  }

  claudeModelRejected(error) {
    const output = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
    return /(?:model.*(?:invalid|unknown|not found|unsupported|does not exist)|invalid.*--model|--model.*(?:invalid|unknown))/i.test(output);
  }

  async probeClaudeRenewal(account) {
    try {
      const snapshots = await this.fetchClaude({
        claudeConfigDir: account.profileRef,
        ...this.providerReadOptions(account),
      });
      const latestAccount = this.store.getAccount(account.id);
      if (!latestAccount
        || latestAccount.provider !== 'claude'
        || !latestAccount.enabled
        || latestAccount.profileRef !== account.profileRef) {
        return { ok: false, expired: false };
      }
      this.rememberClaudeCredentialExpiry(account.id, snapshots);
      for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
      this.updateClaudeWeeklyFingerprints(
        this.store.listAccounts().filter((item) => item.provider === 'claude' && item.enabled),
        new Map([[account.id, snapshots]]),
      );
      this.authPresenceCache.delete(`claude:${account.profileRef}`);
      this.recordAccountRefreshResults([{ accountId: account.id, ok: true, snapshotCount: snapshots.length }]);
      return { ok: true, expired: false };
    } catch (error) {
      return {
        ok: false,
        expired: SIGN_IN_REQUIRED_ERROR_PATTERN.test(error.message)
          && SIGN_IN_EXPIRED_ERROR_PATTERN.test(error.message),
      };
    }
  }

  async priorClaudeActivation() {
    let stat;
    try {
      stat = await fs.promises.lstat(this.claudeActiveLink);
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'unlinked' };
      throw error;
    }
    if (!stat.isSymbolicLink()) throw activeLinkBlockedError('Claude', this.claudeActiveLink);
    return { state: 'linked', profileRef: await fs.promises.realpath(this.claudeActiveLink) };
  }

  async restoreClaudeActivation(previous) {
    this.requireManaged('claude');
    if (previous.state === 'linked') {
      await this.activateClaude({
        profileRef: previous.profileRef,
        activeLink: this.claudeActiveLink,
        profilesDir: this.claudeProfilesDir,
      });
      return;
    }
    let stat;
    try {
      stat = await fs.promises.lstat(this.claudeActiveLink);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isSymbolicLink()) throw new Error('Claude active profile link changed during renewal');
    await fs.promises.unlink(this.claudeActiveLink);
  }

  async finishClaudeRenewal(account, at, renewalPath) {
    let result = {
      at,
      outcome: 'failed',
      mechanism: 'auth-status',
      detail: 'Claude did not refresh this account’s expired stored sign-in.',
      path: renewalPath,
    };
    let verified = await this.probeClaudeRenewal(account);
    if (verified.ok) {
      return {
        at,
        outcome: 'renewed',
        mechanism: 'auth-status',
        detail: 'Claude refreshed this account’s stored sign-in without an inference request.',
        path: renewalPath,
      };
    }
    if (!verified.expired) return result;

    result.mechanism = 'invoke';
    try {
      await this.runClaudeRenewalCli(['-p', 'ok', '--model', CLAUDE_RENEWAL_MODEL], account.profileRef);
    } catch (error) {
      if (this.claudeModelRejected(error)) {
        try {
          await this.runClaudeRenewalCli(['-p', 'ok'], account.profileRef);
        } catch {
          // Verification, not CLI exit status, decides the outcome.
        }
      }
    }
    verified = await this.probeClaudeRenewal(account);
    if (verified.ok) {
      result = {
        at,
        outcome: 'renewed',
        mechanism: 'invoke',
        detail: 'Claude refreshed this account’s stored sign-in with the minimal renewal request.',
        path: renewalPath,
      };
    }
    return result;
  }

  async performClaudeFlipRenewal(account, at) {
    this.requireManaged('claude');
    let previous;
    let activated = false;
    let result = {
      at,
      outcome: 'failed',
      mechanism: null,
      detail: 'Claude did not refresh this account’s expired stored sign-in.',
      path: 'flip',
    };
    try {
      previous = await this.priorClaudeActivation();
      if (previous.state === 'linked') {
        try {
          await validateClaudeProfileHome({
            profileRef: previous.profileRef,
            profilesDir: this.claudeProfilesDir,
          });
        } catch {
          const error = new Error('unsafe Claude renewal restore path');
          error.code = 'claude-renewal-restore-unsafe';
          throw error;
        }
      }
      await this.activateClaude({
        profileRef: account.profileRef,
        activeLink: this.claudeActiveLink,
        profilesDir: this.claudeProfilesDir,
      });
      activated = true;

      try {
        await this.runClaudeRenewalCli(['auth', 'status', '--json'], account.profileRef);
      } catch {
        // The provider command is only a trigger. Its exit status is never
        // renewal evidence; the target profile's probe below is authoritative.
      }
      result = await this.finishClaudeRenewal(account, at, 'flip');
    } catch (error) {
      if (error?.code === 'claude-renewal-restore-unsafe') {
        result.detail = 'ModelDeck could not safely verify the previously active Claude profile, so renewal was not attempted.';
      }
      // Keep the stable, non-sensitive failure sentence above. Child output
      // and profile paths are intentionally never copied into API state.
    } finally {
      if (activated) {
        try {
          await this.restoreClaudeActivation(previous);
        } catch {
          result = {
            at,
            outcome: 'failed',
            mechanism: result.mechanism,
            detail: 'ModelDeck could not restore the previously active Claude profile after renewal.',
            path: 'flip',
            restoreFailed: true,
          };
        }
      }
    }
    return result;
  }

  async performClaudeRenewal(accountId) {
    const account = this.store.getAccount(accountId);
    if (account && account.provider !== 'claude') {
      throw new Error('Claude renewal provider mismatch: this account is not a Claude account.');
    }
    const at = new Date(this.now()).toISOString();
    const decided = (outcome, mechanism, detail, extra = {}) => this.recordClaudeRenewalAttempt(accountId, {
      at, outcome, mechanism, detail, ...extra,
    });
    if (!account || !account.enabled) {
      return decided('signin-required', null, 'This account requires an explicit Claude sign-in; automatic renewal was not attempted.');
    }
    let authState;
    try {
      authState = await this.accountAuthState(account);
    } catch {
      return decided('signin-required', null, 'This account requires an explicit Claude sign-in; automatic renewal was not attempted.');
    }
    const postExpiryAuthorized = this.signinReason(account, authState) === 'expired'
      && this.claudePostExpiryRenewalEligible(accountId);
    if (!postExpiryAuthorized) {
      return decided('signin-required', null, 'This account requires an explicit Claude sign-in; automatic renewal was not attempted.');
    }

    const override = await this.claudeAuthOverrideState(account.profileRef);
    if (override.authOverride) {
      return decided('auth-overridden', null, 'This profile sets an Anthropic authentication override, so renewal was not attempted.');
    }
    if (!override.readable) {
      return decided('failed', null, 'ModelDeck could not safely inspect this profile’s Claude settings, so renewal was not attempted.');
    }

    const authStatus = await this.readScopedClaudeAuthStatus(account.profileRef);
    const { reportedIdentity } = authStatus;
    const latestAccount = this.store.getAccount(accountId);
    if (!latestAccount || !latestAccount.enabled) {
      return decided('signin-required', null, 'This account requires an explicit Claude sign-in; automatic renewal was not attempted.');
    }
    if (latestAccount.provider !== 'claude' || latestAccount.profileRef !== account.profileRef) {
      return decided('failed', null, 'This account changed while ModelDeck was checking its Claude identity, so renewal was not attempted.');
    }
    if (claudeRenewalIdentityMatches(latestAccount, reportedIdentity)) {
      this.promoteSeededClaudeIdentity(account.id, account.profileRef, reportedIdentity);
      const result = await this.finishClaudeRenewal(latestAccount, at, 'no-flip');
      return this.recordClaudeRenewalAttempt(accountId, result);
    }

    // Issue #263: WHY the cheap rung was declined is the single fact that
    // would have exposed this defect four releases ago. Every stuck account
    // recorded a bare `busy`, which read as "a session is in the way" when the
    // truth was "the CLI named nobody, so we never even tried the cheap path".
    // Carry the reason onto whatever the flip rung decides.
    //
    // The four cases are kept distinct because collapsing them is the very
    // mistake being corrected. Note an exec failure can still carry usable
    // stdout (the CLI exits non-zero having printed its status), so a reported
    // identity always wins over the error.
    let identityDecline;
    if (reportedIdentity) identityDecline = 'mismatched';
    else if (authStatus.invocation?.modeldeckRenewalStage === 'config-dir') identityDecline = 'setup-failed';
    else if (authStatus.failed) identityDecline = 'error';
    else identityDecline = 'absent';

    try {
      if (await this.runningClaudeProcessCount()) {
        return decided('busy', null, CLAUDE_RENEWAL_BUSY_DETAIL, { path: 'flip', identityDecline });
      }
    } catch {
      return decided('failed', null, 'ModelDeck could not confirm that Claude was idle, so renewal was not attempted.', { path: 'flip', identityDecline });
    }

    this.requireManaged('claude');
    const result = await this.performClaudeFlipRenewal(latestAccount, at);
    return this.recordClaudeRenewalAttempt(accountId, { ...result, identityDecline });
  }

  async renewClaudeAccount(accountId) {
    if (this.providerManagementOperations.has('claude')) this.assertProviderIdle('claude');
    if (this.claudeRenewalPromise) throw new ClaudeRenewalConflictError();
    const account = this.store.getAccount(accountId);
    if (account?.provider === 'claude'
      && this.renewalAttemptHistory(account).length >= CLAUDE_RENEWAL_DAILY_LIMIT) {
      return this.recordClaudeRenewalAttempt(account.id, {
        at: new Date(this.now()).toISOString(),
        outcome: 'rate-limited',
        mechanism: null,
        detail: 'This account has reached the Claude renewal limit for the last 24 hours; try again later.',
      });
    }
    const promise = this.withClaudeActivationLock(() => this.performClaudeRenewal(accountId));
    this.claudeRenewalPromise = promise;
    this.claudeRenewalAccountId = account?.provider === 'claude' ? accountId : null;
    try {
      return await promise;
    } finally {
      if (this.claudeRenewalPromise === promise) {
        this.claudeRenewalPromise = null;
        this.claudeRenewalAccountId = null;
      }
    }
  }

  assertClaudeIdentityVerificationProviderIdle(accountId) {
    if (this.claudeRenewalAccountId === accountId
      || this.claudeActivationAccountCounts.has(accountId)) {
      throw new ClaudeIdentityVerificationConflictError();
    }
  }

  async performClaudeIdentityVerification(accountId) {
    // Re-check after waiting behind unrelated Claude work. Activation marks
    // its account before queueing and renewal records its account while
    // queued, so same-account work that arrived meanwhile becomes an honest
    // conflict instead of overlapping this provider read.
    this.assertClaudeIdentityVerificationProviderIdle(accountId);
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    if (account.provider !== 'claude') {
      throw serviceError('identity verification is only supported for claude accounts', 400);
    }

    const authStatus = await this.readScopedClaudeAuthStatus(account.profileRef);
    if (authStatus.failed) {
      return {
        outcome: 'unavailable',
        detail: 'ModelDeck could not read this account\u2019s Claude identity.',
      };
    }

    const reported = authStatus.reportedIdentity;
    const latest = this.store.getAccount(accountId);
    if (!latest) throw serviceError('account not found', 404);
    if (latest.provider !== 'claude' || latest.profileRef !== account.profileRef) {
      return {
        outcome: 'unavailable',
        detail: 'This account changed while ModelDeck was checking its Claude identity.',
      };
    }
    if (claudeRenewalIdentityMatches(latest, reported)) {
      this.promoteSeededClaudeIdentity(accountId, account.profileRef, reported);
      return { outcome: 'verified' };
    }

    const reportedEmails = reported
      && !reported.malformed
      && !reported.explicitlyUnauthenticated
      ? [...reported.emails]
      : [];
    const expectedEmail = latest.identity?.trim().toLowerCase() || null;
    if (expectedEmail && reportedEmails.length === 1 && reportedEmails[0] !== expectedEmail) {
      return { outcome: 'mismatch', reported: reportedEmails[0] };
    }
    let detail = 'This account has no stored Claude identity to verify.';
    if (expectedEmail) {
      detail = reported
        ? 'Claude reported conflicting identity details for this account.'
        : 'Claude did not report an identity for this account.';
    }
    return {
      outcome: 'unavailable',
      detail,
    };
  }

  async verifyClaudeIdentity(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    if (account.provider !== 'claude') {
      throw serviceError('identity verification is only supported for claude accounts', 400);
    }
    this.assertClaudeIdentityVerificationProviderIdle(accountId);
    if (this.claudeIdentityVerificationPromises.has(accountId)) {
      throw new ClaudeIdentityVerificationConflictError();
    }

    const promise = this.withClaudeActivationLock(
      () => this.performClaudeIdentityVerification(accountId),
    );
    this.claudeIdentityVerificationPromises.set(accountId, promise);
    try {
      return await promise;
    } finally {
      if (this.claudeIdentityVerificationPromises.get(accountId) === promise) {
        this.claudeIdentityVerificationPromises.delete(accountId);
      }
    }
  }

  async runScheduledClaudeRenewals(refresh) {
    const currentSettings = this.store.getSettings();
    if (!currentSettings.autoRefreshEnabled || !currentSettings.autoRenewEnabled || this.claudeRenewalPromise) return [];
    const candidates = (refresh?.claude?.profiles || []).filter((item) => !item.ok
      && SIGN_IN_REQUIRED_ERROR_PATTERN.test(item.error)
      && SIGN_IN_EXPIRED_ERROR_PATTERN.test(item.error)
      && this.claudePostExpiryRenewalEligible(item.accountId));
    const outcomes = [];
    for (const candidate of candidates) {
      const settings = this.store.getSettings();
      if (!settings.autoRefreshEnabled || !settings.autoRenewEnabled) break;
      const account = this.store.getAccount(candidate.accountId);
      if (!account || account.provider !== 'claude' || !account.enabled || !this.renewalAttemptAllowed(account)) continue;
      try {
        const renew = await this.renewClaudeAccount(account.id);
        outcomes.push({ accountId: account.id, ...renew });
        await this.refreshClaudeAccount(account.id);
      } catch (error) {
        if (error?.statusCode === 409) break;
        // The caught error may someday carry scheduler context. Keep this log
        // fixed so a credential-derived expiry can never be copied verbatim.
        console.error('[modeldeck] scheduled Claude renewal failed');
      }
    }
    return outcomes;
  }

  async awaitClaudeActivationBound(promise, timeoutMs, timeoutError) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = this.claudeActivationSetTimeout(() => reject(timeoutError()), timeoutMs);
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      if (timer != null) this.claudeActivationClearTimeout(timer);
    }
  }

  async withClaudeActivationLock(
    operation,
    { queueTimeoutMs = this.claudeActivationOperationTimeoutMs } = {},
  ) {
    const previous = this.claudeActivationTail;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.claudeActivationTail = previous.catch(() => {}).then(() => gate);
    try {
      await this.awaitClaudeActivationBound(
        previous.catch(() => {}),
        queueTimeoutMs,
        () => new ClaudeActivationQueueTimeoutError(),
      );
      if (this.claudeActivationSafetyFence) {
        throw new ClaudeActivationOperationStillRunningError();
      }
      const operationPromise = Promise.resolve().then(operation);
      try {
        return await this.awaitClaudeActivationBound(
          operationPromise,
          this.claudeActivationOperationTimeoutMs,
          () => new ClaudeActivationOperationTimeoutError(),
        );
      } catch (error) {
        if (error instanceof ClaudeActivationOperationTimeoutError) {
          const fence = { operationPromise };
          this.claudeActivationSafetyFence = fence;
          const clearFence = () => {
            if (this.claudeActivationSafetyFence !== fence) return;
            this.claudeActivationSafetyFence = null;
            logClaudeActivationWatchdog('[modeldeck] Timed-out Claude account operation settled; serialized account work is eligible again');
          };
          void operationPromise.then(clearFence, clearFence);
          // Stable and credential-free. The installed daemon redirects stderr
          // to its bounded managed log, so this field failure survives launchd.
          logClaudeActivationWatchdog(
            `[modeldeck] Claude account operation timed out after ${this.claudeActivationOperationTimeoutMs}ms; refusing overlapping account work until it settles`,
          );
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  beginClaudeActivation(accountId) {
    this.claudeActivationAccountCounts.set(
      accountId,
      (this.claudeActivationAccountCounts.get(accountId) || 0) + 1,
    );
  }

  endClaudeActivation(accountId) {
    const remaining = (this.claudeActivationAccountCounts.get(accountId) || 1) - 1;
    if (remaining > 0) this.claudeActivationAccountCounts.set(accountId, remaining);
    else this.claudeActivationAccountCounts.delete(accountId);
  }

  assertClaudeProxyRoutingIdle(accountId) {
    if (this.claudeRenewalAccountId === accountId) {
      throw new ClaudeProxyRoutingConflictError('renewal');
    }
    if (this.claudeActivationAccountCounts.has(accountId)) {
      throw new ClaudeProxyRoutingConflictError('activation');
    }
  }

  async activateAccount(id) {
    const account = this.store.getAccount(id);
    if (!account) throw new Error('account not found');
    if (!account.enabled) throw new Error('account is disabled');
    this.requireManaged(account.provider);
    this.assertNoProviderManagement(account.provider);

    let warnings = [];
    if (account.provider === 'claude') {
      this.beginClaudeActivation(id);
      let activated;
      try {
        activated = await this.withClaudeActivationLock(async () => {
          // Re-read after waiting: a queued activation must not revive a deleted
          // or newly disabled account.
          const latest = this.store.getAccount(id);
          if (!latest) throw new Error('account not found');
          if (!latest.enabled) throw new Error('account is disabled');
          // Pre-flip honesty (issue #66): sessions launched before the pinned
          // env existed still resolve storage through the ~/.claude symlink and
          // can silently lose transcript history when it flips. Detect them
          // before the flip so the response can say so; best-effort only —
          // detection failure must never block activation.
          warnings = await this.claudeRunningSessionWarnings();
          await this.activateClaude({ profileRef: latest.profileRef, activeLink: this.claudeActiveLink, profilesDir: this.claudeProfilesDir });
          await this.scopeClaudeSecureStorage(latest.profileRef);
          return { account: this.setDefaultAccount(latest.provider, latest.id), warnings };
        }, { queueTimeoutMs: this.claudeActivationQueueTimeoutMs });
      } finally {
        this.endClaudeActivation(id);
      }
      activated.warnings.push(...await this.reconcileAccountTranscripts(activated.account));
      return activated;
    } else {
      if (!this.codexActiveLink) throw new Error('Codex active profile link is not configured');
      this.codexActivationCount += 1;
      try {
        await this.activateCodexProfile(account.profileRef);
        const activated = this.setDefaultAccount(account.provider, account.id);
        warnings.push(...await this.reconcileAccountTranscripts(activated));
        return { account: activated, warnings };
      } finally { this.codexActivationCount -= 1; }
    }
  }

  async reconcileAccountTranscripts(account) {
    // Only Claude and Codex resume by transcript path (CodeRabbit #652: a
    // Grok activation would otherwise cache an unsafe-path warning forever).
    if (account.provider !== 'claude' && account.provider !== 'codex') return [];
    // Older Codex registrations can point outside the managed directory.
    // They still activate, but sharing must never traverse those homes.
    if (account.provider === 'codex') {
      try {
        if (fs.realpathSync(path.dirname(account.profileRef)) !== fs.realpathSync(this.codexProfilesDir)) return [];
      } catch { return []; }
    }
    const previous = this.sharedTranscriptTasks.get(account.profileRef) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const latest = this.store.getAccount(account.id);
      if (!latest || latest.profileRef !== account.profileRef) return [];
      const result = await reconcileSharedTranscripts({
        profilesDir: account.provider === 'claude' ? this.claudeProfilesDir : this.codexProfilesDir,
        profileRef: account.profileRef, provider: account.provider,
        ownedLinks: latest.metadata?.sharedTranscriptLinks,
      });
      const current = this.store.getAccount(account.id);
      if (result.ownedLinks && current?.profileRef === account.profileRef) {
        try {
          this.store.saveAccount({ ...current, metadata: {
            ...current.metadata, sharedTranscriptLinks: result.ownedLinks,
          } });
        } catch {
          result.warning = 'Some transcript links could not be recorded. Retry account activation to reconcile them.';
        }
      }
      if (result.warning) this.sharedTranscriptWarnings.set(account.profileRef, result.warning);
      else this.sharedTranscriptWarnings.delete(account.profileRef);
      this.sharedTranscriptCounts.delete(account.profileRef);
      if (result.sharedTranscripts != null) {
        this.sharedTranscriptCounts.set(account.profileRef, {
          at: this.now(), value: { sharedTranscripts: result.sharedTranscripts },
        });
      }
      try {
        const log = result.warning ? console.error : console.log;
        log(`[modeldeck] shared transcripts: examined=${result.examined} created=${result.created} pruned=${result.pruned}`
          + (result.warning ? `; ${result.warning}` : ` present=${result.sharedTranscripts}`));
      } catch { /* Logging cannot undo a successful activation. */ }
      return result.warning ? [result.warning] : [];
    });
    this.sharedTranscriptTasks.set(account.profileRef, task);
    try { return await task; }
    finally {
      if (this.sharedTranscriptTasks.get(account.profileRef) === task) this.sharedTranscriptTasks.delete(account.profileRef);
    }
  }

  async reconcileActiveTranscripts(provider = null) {
    for (const [name, activeLink] of [['claude', this.claudeActiveLink], ['codex', this.codexActiveLink]]) {
      if (provider && name !== provider) continue;
      try {
        if (!(await fs.promises.lstat(activeLink)).isSymbolicLink()) continue;
        const target = path.resolve(path.dirname(activeLink), await fs.promises.readlink(activeLink));
        const account = this.store.listAccounts().find((item) => item.provider === name && path.resolve(item.profileRef) === target);
        if (account) await this.reconcileAccountTranscripts(account);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          try { console.error('[modeldeck] shared transcripts: active profile could not be inspected'); } catch { /* Best effort. */ }
        }
      }
    }
  }

  async reconcileCreatedProfileTranscripts(account) {
    // Legacy adoption needs an empty destination. Defer until its successful
    // flip; that path calls the same reconciler after the rollback boundary.
    if (account.provider === 'claude') {
      try {
        if (!(await fs.promises.lstat(this.claudeActiveLink)).isSymbolicLink()) return;
      } catch (error) { if (error.code !== 'ENOENT') return; }
    }
    await this.reconcileAccountTranscripts(account);
    await this.reconcileActiveTranscripts(account.provider);
  }

  async accountSharedTranscriptState(account) {
    const cached = this.sharedTranscriptCounts.get(account.profileRef);
    if (cached && this.now() - cached.at < 30_000) return cached.value;
    const entry = {
      at: this.now(),
      value: sharedTranscriptState({ profilesDir: this.claudeProfilesDir, profileRef: account.profileRef }),
    };
    this.sharedTranscriptCounts.set(account.profileRef, entry);
    return entry.value;
  }

  // Issue #66: counts running `claude` processes at activation time. Pinned
  // sessions (launched with CLAUDE_CONFIG_DIR exported) are insulated from
  // the flip, but the daemon cannot distinguish pinned from unpinned
  // processes cheaply, so the warning is phrased conditionally.
  async claudeRunningSessionWarnings() {
    let running = 0;
    try {
      running = await this.runningClaudeProcessCount();
    } catch {
      return [];
    }
    if (!running) return [];
    return [
      `${running} running Claude ${running === 1 ? 'session' : 'sessions'} may lose session storage if launched without ModelDeck's pinned environment. Pinned sessions are unaffected.`,
    ];
  }

  async claudeScopingSupported() {
    if (this.claudeSecureStorageSupported != null) return this.claudeSecureStorageSupported;
    try {
      const version = await this.installedToolVersion(this.claudePath);
      this.claudeSecureStorageSupported = compareSemver(version, CLAUDE_SECURESTORAGE_MIN_VERSION) >= 0;
    } catch {
      this.claudeSecureStorageSupported = false;
    }
    return this.claudeSecureStorageSupported;
  }

  // Review #590 (CodeRabbit pin-rollback finding): activation pins are
  // global mutable state — the shell pin file plus, on macOS, the two
  // launchd variables — and the adoption flow's rollback branches used to
  // restore only ~/.claude, leaving every pin aimed at a profile home the
  // rollback may have just deleted. Capture reads the pre-operation state;
  // restore puts it back exactly (absent stays absent, a value stays that
  // value). A piece captured as undefined was unreadable and is left alone
  // rather than guessed at. Capture itself never throws: pin handling is
  // best-effort everywhere in this file and must not block the operation.
  async captureClaudeScopePins() {
    const captured = { secureStorage: this.claudeSecureStorage ?? null };
    try {
      captured.shellPin = await fs.promises.readFile(this.claudeShellEnvFile, 'utf8');
    } catch (error) {
      captured.shellPin = error?.code === 'ENOENT' ? null : undefined;
    }
    // Mirrors the guards under which scopeClaudeSecureStorage mutates
    // launchd: never on other platforms, never from a demo instance.
    if (this.platform === 'darwin' && !this.demoFixtures) {
      captured.launchd = {};
      for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
        try {
          const { stdout } = await this.exec('/bin/launchctl', ['getenv', name], { timeout: 5_000, maxBuffer: 65_536 });
          const value = String(stdout ?? '').replace(/\n+$/, '');
          captured.launchd[name] = value === '' ? null : value;
        } catch (error) {
          // launchctl exits 1 with empty output when the variable is absent.
          captured.launchd[name] = error.code === 1 && error.stdout === '' && error.stderr === '' ? null : undefined;
        }
      }
    }
    return captured;
  }

  async restoreClaudeScopePins(captured) {
    this.requireManaged('claude');
    if (!captured) return;
    const failures = [];
    if (captured.shellPin === null) {
      try { await fs.promises.rm(this.claudeShellEnvFile, { force: true }); }
      catch (error) { failures.push(`shell pin: ${errorMessage(error)}`); }
    } else if (typeof captured.shellPin === 'string') {
      // temp + rename, mirroring writeClaudeShellEnvFile's atomicity.
      const temporary = `${this.claudeShellEnvFile}.modeldeck-${process.pid}-${crypto.randomUUID()}`;
      try {
        await fs.promises.mkdir(path.dirname(this.claudeShellEnvFile), { recursive: true });
        await fs.promises.writeFile(temporary, captured.shellPin, { mode: 0o600 });
        await fs.promises.rename(temporary, this.claudeShellEnvFile);
      } catch (error) {
        await fs.promises.unlink(temporary).catch(() => {});
        failures.push(`shell pin: ${errorMessage(error)}`);
      }
    }
    if (captured.launchd && this.platform === 'darwin' && !this.demoFixtures) {
      for (const [name, value] of Object.entries(captured.launchd)) {
        if (value === undefined) continue;
        try {
          if (value === null) await this.exec('/bin/launchctl', ['unsetenv', name], { timeout: 5_000, maxBuffer: 65_536 });
          else await this.exec('/bin/launchctl', ['setenv', name, value], { timeout: 5_000, maxBuffer: 65_536 });
        } catch (error) {
          failures.push(`${name}: ${errorMessage(error)}`);
        }
      }
    }
    this.claudeSecureStorage = captured.secureStorage;
    if (failures.length) throw new Error(failures.join('; '));
  }

  async scopeClaudeSecureStorage(profileRef) {
    this.requireManaged('claude');
    const value = await fs.promises.realpath(profileRef);
    // Issue #66: refresh the shell pin first so new terminal sessions export
    // CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR (always the same
    // string) resolved from ModelDeck's records at activation time — never a
    // launch-time readlink of the symlink. Failure degrades verification but
    // never blocks the home switch.
    let shellPinError = null;
    try {
      // cliproxyRouted, not proxyRouted: the Keychain client key goes only to
      // profiles whose base URL is actually a local CLIProxy (#277 review).
      const { cliproxyRouted } = await this.claudeAuthOverrideState(value);
      await this.writeClaudeShellEnvFile(value, cliproxyRouted);
    } catch (error) {
      shellPinError = errorMessage(error);
    }
    if (this.platform !== 'darwin') {
      this.claudeSecureStorage = { value, status: 'not-applicable', ...(shellPinError ? { error: shellPinError } : {}) };
      return this.claudeSecureStorage;
    }
    if (this.demoFixtures) {
      // DEMO/DEV ONLY (issue #129): never mutate the user-global launchd
      // environment from a demo instance — `launchctl setenv` below would
      // steer every subsequently GUI-launched real Claude process at the
      // demo profile. The shell env file written above is already pinned
      // inside the demo dir by scripts/demo-daemon.sh, and the seeded
      // active link fully establishes fixture state.
      this.claudeSecureStorage = { value, status: 'inactive', ...(shellPinError ? { error: shellPinError } : {}) };
      return this.claudeSecureStorage;
    }
    if (!(await this.claudeScopingSupported())) {
      this.claudeSecureStorage = { value, status: 'unsupported-cli', ...(shellPinError ? { error: shellPinError } : {}) };
      return this.claudeSecureStorage;
    }
    try {
      // GUI-launched apps inherit the launchd environment: pin both vars
      // there too, and always together — a secure-storage scope diverging
      // from the config dir would store session data under one profile while
      // authenticating as another (issue #66 spike caveat).
      //
      // Known, accepted ordering window: launchctl cannot set two variables
      // atomically, so a GUI app spawned between these two adjacent calls
      // could observe a mixed pair (new config dir + previous scope). A real
      // fix needs a different launch mechanism and is out of scope here.
      // Terminal sessions are unaffected — they source the temp+rename
      // atomic env file — so GUI-launch pinning is documented as
      // best-effort (docs/CLAUDE_IDENTITY.md, "What is NOT protected").
      await this.exec('/bin/launchctl', ['setenv', 'CLAUDE_CONFIG_DIR', value], { timeout: 5_000, maxBuffer: 65_536 });
      await this.exec('/bin/launchctl', ['setenv', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value], { timeout: 5_000, maxBuffer: 65_536 });
      this.claudeSecureStorage = shellPinError
        ? { value, status: 'degraded', error: shellPinError }
        : { value, status: 'active' };
    } catch (error) {
      this.claudeSecureStorage = { value, status: 'degraded', error: errorMessage(error) };
    }
    return this.claudeSecureStorage;
  }

  // Atomic write (temp + rename) so a shell sourcing the snippet mid-switch
  // never sees a half-written file.
  /// #282 adversarial review, major 2: startup repair for the two-file
  /// routing state. settings.json and the shell pin cannot be written
  /// atomically together; a crash between them leaves a shell that still
  /// exports (or lacks) the proxy key against what settings.json says.
  /// Recomputing the pin from the ACTIVE profile's actual routing state is
  /// idempotent, so a consistent pair is untouched. No active profile (no
  /// symlink yet) means no pin to repair.
  async reconcileClaudeShellEnvFile() {
    this.requireManaged('claude');
    let activeRealPath;
    try { activeRealPath = await this.realpath(this.claudeActiveLink); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const { cliproxyRouted } = await this.claudeAuthOverrideState(activeRealPath);
    await this.writeClaudeShellEnvFile(activeRealPath, cliproxyRouted);
  }

  async writeClaudeShellEnvFile(profileRealPath, proxyRouted = false) {
    this.requireManaged('claude');
    const file = this.claudeShellEnvFile;
    // Issue #522: the Keychain service is resolved HERE, from the profile's
    // own recorded helper state, rather than passed by each caller — the
    // three call sites (activation, startup reconcile, routing change) cannot
    // then disagree about which profile's key a shell will fetch.
    const keychainService = await this.claudeClientKeyServiceFor(profileRealPath);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.modeldeck-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(temporary, claudePinnedEnvFileContent(profileRealPath, proxyRouted, keychainService), { mode: 0o600 });
      await fs.promises.rename(temporary, file);
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async writeCodexShellEnvFile(profileRealPath) {
    this.requireManaged('codex');
    const file = this.codexShellEnvFile;
    const temporary = `${file}.modeldeck-${crypto.randomUUID()}`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(temporary, `if [ -z "${'${CODEX_HOME:-}'}" ]; then\n  export CODEX_HOME=${shellQuote(profileRealPath)}\nfi\n`, { mode: 0o600 });
      await fs.promises.rename(temporary, file);
    } finally { await fs.promises.rm(temporary, { force: true }); }
  }

  async installProviderShellHook(provider) {
    this.requireManaged(provider);
    return updateProviderShellHook({ target: this.configLintZshenvPath, provider, envFile: this[`${provider}ShellEnvFile`] });
  }

  setDefaultAccount(provider, accountId) {
    const account = this.store.setDefault(provider, accountId);
    this.invalidateToolProbe();
    return account;
  }

  async deleteAccount(accountId) {
    const account = this.store.getAccount(accountId);
    if (account) this.assertNoProviderManagement(account.provider);
    await this.accountDetachProfile(account);
    const deleted = this.store.deleteAccount(accountId);
    if (deleted) {
      this.accountRefreshErrors.delete(accountId);
      this.claudeCredentialExpiries.delete(accountId);
      this.claudeStrayLoginBaseline.delete(accountId);
    }
    if (deleted && account?.isDefault) this.invalidateToolProbe();
    if (deleted) await this.accountProfileSetChanged();
    return deleted;
  }

  async activateCodexProfile(profileRef) {
    this.requireManaged('codex');
    let activeStat = null;
    try { activeStat = await fs.promises.lstat(this.codexActiveLink); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (activeStat && !activeStat.isSymbolicLink()) {
      throw activeLinkBlockedError('Codex', this.codexActiveLink);
    }

    await fs.promises.mkdir(path.dirname(this.codexActiveLink), { recursive: true });
    const temporaryLink = path.join(
      path.dirname(this.codexActiveLink),
      `.${path.basename(this.codexActiveLink)}.modeldeck-${process.pid}-${crypto.randomUUID()}`,
    );
    try {
      await fs.promises.symlink(profileRef, temporaryLink, 'dir');
      await fs.promises.rename(temporaryLink, this.codexActiveLink);
    } catch (error) {
      await fs.promises.unlink(temporaryLink).catch(() => {});
      throw new Error(`Codex account activation failed: ${errorMessage(error)}`);
    }
    await this.writeCodexShellEnvFile(await fs.promises.realpath(profileRef));
  }

  async latestToolVersion(url) {
    const response = await this.registryFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response?.ok === false) throw new Error(`npm registry returned HTTP ${response.status}`);
    const payload = typeof response?.json === 'function' ? await response.json() : response;
    const version = semver(payload?.version);
    if (!version) throw new Error('npm registry response did not contain a version');
    return version;
  }

  async installedToolVersion(binary) {
    let result;
    try {
      result = await this.exec(binary, ['--version'], { timeout: 10_000, maxBuffer: 1_000_000 });
    } catch (error) {
      // Issue #2: ENOENT on a bare name means the daemon's PATH missed it.
      // Retry via the known install directories before reporting the CLI
      // missing — a native-installer claude lives in ~/.local/bin, which the
      // bundled launchd PATH cannot include.
      if (error?.code !== 'ENOENT' || path.isAbsolute(binary)) throw error;
      const fallback = await this.toolPathFallback(binary);
      if (!fallback) throw error;
      result = await this.exec(fallback, ['--version'], { timeout: 10_000, maxBuffer: 1_000_000 });
    }
    const version = semver(result?.stdout ?? result) || semver(result?.stderr);
    if (!version) throw new Error('version output did not contain a semantic version');
    return version;
  }

  async claudeProfileAuthState(profileRef) {
    if (!profileRef) return 'unknown';
    const cacheKey = `claude:${profileRef}`;
    const cached = this.authPresenceCache.get(cacheKey);
    if (cached && this.now() < cached.expiresAt) return cached.authState;
    if (cached?.promise) return cached.promise;
    const promise = (async () => {
      const present = await this.claudeCredentialsPresent({ claudeConfigDir: profileRef });
      const authState = present ? 'ok' : 'signin-required';
      // Only cache if this probe still owns the entry — an invalidation (e.g.
      // verifyAccount after a fresh login) must not be clobbered by a stale
      // result that was already in flight. Mirrors the catch-path check.
      if (this.authPresenceCache.get(cacheKey)?.promise === promise) {
        this.authPresenceCache.set(cacheKey, {
          authState,
          expiresAt: this.now() + this.authPresenceTtlMs,
        });
      }
      return authState;
    })();
    this.authPresenceCache.set(cacheKey, { promise, expiresAt: 0 });
    try { return await promise; }
    catch (error) {
      if (this.authPresenceCache.get(cacheKey)?.promise === promise) this.authPresenceCache.delete(cacheKey);
      throw error;
    }
  }

  async accountAuthState(account) {
    if (!account?.profileRef) return 'unknown';
    if (account.metadata?.claudeHomeNeedsVerification) return 'signin-required';
    if (account.provider === 'claude' && this.duplicateClaudeTokenAccountIds.has(account.id)) {
      return 'duplicate-token';
    }
    // Issue #108: same precedence as the Claude branch — a confirmed shared
    // credential outranks signin-required and the presence probe, because it
    // is the state that explains why every other signal looks healthy.
    if (account.provider === 'codex' && this.duplicateCodexTokenAccountIds.has(account.id)) {
      return 'duplicate-token';
    }
    // Issue #89: a refresh that failed because the stored credentials are
    // unusable outranks the presence probe — expired OAuth still passes the
    // presence check, which left the chip "Healthy" on a dead account.
    const lastError = account.id != null && this.accountRefreshErrors.get(account.id);
    // Issue #98: a denied Keychain read outranks both the sign-in check and
    // the presence probe — the item exists (presence says "ok") and no
    // re-login can fix an ACL denial, so any other chip would mislead.
    if (lastError && KEYCHAIN_DENIED_ERROR_PATTERN.test(lastError.message)) return 'keychain-denied';
    if (lastError && SIGN_IN_REQUIRED_ERROR_PATTERN.test(lastError.message)) return 'signin-required';
    if (account.provider === 'claude') {
      return this.claudeProfileAuthState(account.profileRef);
    }
    if (account.provider === 'codex') {
      return fs.existsSync(path.join(account.profileRef, 'auth.json')) ? 'ok' : 'signin-required';
    }
    // Decision 0035: same presence-only check as Codex. The grok CLI stores
    // its OAuth tokens in `<home>/auth.json`; ModelDeck never opens it here.
    if (account.provider === 'grok') {
      return fs.existsSync(path.join(account.profileRef, 'auth.json')) ? 'ok' : 'signin-required';
    }
    return 'unknown';
  }

  // Issue #149: WHY an account is signin-required — "expired" (stored
  // credentials present but idle-decayed; Claude Code renews them the next
  // time the account is used) vs "missing" (the only genuine sign-out).
  // Derived from the probe's distinct message prefixes; an unrecognized
  // signin-required message stays "missing" so the alarming treatment is the
  // conservative default. Null for every other authState — precedence
  // (keychain-denied #98, duplicate-token #65/#108) is decided by
  // accountAuthState and never revisited here.
  signinReason(account, authState) {
    if (authState !== 'signin-required') return null;
    if (account.metadata?.claudeHomeNeedsVerification) return 'missing';
    const lastError = account.id != null && this.accountRefreshErrors.get(account.id);
    if (lastError && SIGN_IN_REQUIRED_ERROR_PATTERN.test(lastError.message)) {
      return SIGN_IN_EXPIRED_ERROR_PATTERN.test(lastError.message) ? 'expired' : 'missing';
    }
    // Presence-probe path: the credential item / auth.json is simply absent.
    return 'missing';
  }

  // CLIProxyAPI pool/weight display: reads ONLY the non-secret identity,
  // weight, and model-exclusion fields from auth files. Credential values are
  // never accessed. Join keys mirror what each side reliably has — Claude by
  // identity email, Codex by the `tokens.account_id` identifier the #108
  // duplicate detection already remembers (Codex daemon identities are
  // empty). A recognized identity remains membership evidence before the
  // external rebalance job adds a valid weight.
  //
  // Null deliberately means "pool state unavailable": no configured/readable
  // directory, or no parseable JSON auth object. Once any parseable auth file
  // exists, absence of an account identity is affirmative `absent` state.
  async readProxyWeights({ includeEmpty = false } = {}) {
    if (!this.cliproxyAuthDir) return null;
    let names;
    try { names = await fs.promises.readdir(this.cliproxyAuthDir); }
    catch { return null; }
    const byClaudeEmail = new Map();
    const byCodexAccountId = new Map();
    const files = [];
    const issues = [];
    let parseableFiles = 0;
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.cliproxyAuthDir, name);
      let handle;
      try {
        handle = await (this.proxyAuthOpen || fs.promises.open)(
          file,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        const stat = await handle.stat();
        if (!stat.isFile()) {
          issues.push({ path: file, reason: 'auth metadata is not a regular file' });
          continue;
        }
        const source = await handle.readFile('utf8');
        const object = inspectJsonObjectDocument(source);
        const property = (key) => object.properties.findLast((item) => item.key === key);
        const stringValue = (key) => {
          const item = property(key);
          return item && source[item.start] === '"' ? JSON.parse(source.slice(item.start, item.end)) : null;
        };
        const integerValue = (key) => {
          const item = property(key);
          if (!item) return null;
          const encoded = source.slice(item.start, item.end);
          if (!/^-?(?:0|[1-9]\d*)$/.test(encoded)) return null;
          const value = Number(encoded);
          return Number.isInteger(value) ? value : null;
        };
        const stringArrayValue = (key) => {
          const item = property(key);
          if (!item || source[item.start] !== '[') return [];
          const value = JSON.parse(source.slice(item.start, item.end));
          return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
        };
        const hasNonEmptyString = (key) => jsonStringHasNonWhitespace(source, property(key));
        parseableFiles += 1;
        const type = stringValue('type');
        const weight = integerValue('weight');
        // CLIProxyAPI >= v7.2.140 canonicalizes this key to snake_case on
        // load and rewrites the file (pin-bump finding, v7.2.149): read both
        // spellings so a bench written as `excluded-models` still reads as
        // benched after the proxy has renamed it to `excluded_models`.
        const excluded = [...stringArrayValue('excluded_models'), ...stringArrayValue('excluded-models')];
        // #282 adversarial review, minor: an identity alone is not
        // membership. The login child writes tokens with the identity; a
        // parseable {type,email} torso (partial write, hand-made file)
        // must not satisfy a join before the child fails. Presence-only —
        // token VALUES are never read past this boolean.
        const hasClaudeCredential = hasNonEmptyString('access_token') || hasNonEmptyString('refresh_token');
        const rawEmail = stringValue('email');
        if (type === 'claude') {
          const email = typeof rawEmail === 'string' && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null;
          files.push({
            path: file,
            provider: 'claude',
            identity: email,
            ...(Number.isInteger(weight) && weight >= 0 ? { weight } : {}),
            excludedModels: excluded,
          });
          if (!email || !hasClaudeCredential) continue;
          // Issue #272: the two-tier rebalance policy benches a Fable-drained
          // account via per-credential `excluded-models` while its `weight`
          // switches to general-pace duty. One number, two meanings — so the
          // exclusion travels with the weight, letting the deck show the
          // EFFECTIVE weight for whichever window a card is describing.
          // Prefix match: the policy writes the exact model id, which is
          // versioned; the meaning is "the premium Fable family".
          const fableExcluded = excluded.some((model) => model.startsWith('claude-fable'));
          const seen = byClaudeEmail.get(email) || {};
          byClaudeEmail.set(email, {
            ...seen,
            ...(Number.isInteger(weight) && weight >= 0 ? { weight } : {}),
            // CodeRabbit (PR #282): OR, never overwrite. Two auth files can
            // carry the same identity (a re-login leaves the old one behind),
            // and readdir order then decided the answer — a benched account
            // could read as routable purely because its unbenched sibling
            // was parsed second. Benched wins, which is the direction #272
            // exists to protect: the badge must never OVERSTATE Fable
            // routing. It can understate in this anomalous mixed state, and
            // that is the safe side of the trade.
            fableExcluded: Boolean(seen.fableExcluded) || fableExcluded,
          });
        } else if (type === 'codex') {
          const rawAccountId = stringValue('account_id');
          const accountId = typeof rawAccountId === 'string' && rawAccountId.trim() ? rawAccountId.trim() : null;
          files.push({
            path: file,
            provider: 'codex',
            identity: accountId,
            ...(Number.isInteger(weight) && weight >= 0 ? { weight } : {}),
            excludedModels: excluded,
          });
          if (!accountId) continue;
          byCodexAccountId.set(accountId, {
            ...(byCodexAccountId.get(accountId) || {}),
            ...(Number.isInteger(weight) && weight >= 0 ? { weight } : {}),
            fableExcluded: false,
          });
        } else {
          files.push({
            path: file,
            provider: typeof type === 'string' && type ? type : 'unknown',
            identity: null,
            ...(Number.isInteger(weight) && weight >= 0 ? { weight } : {}),
            excludedModels: excluded,
          });
        }
      } catch (error) {
        issues.push({
          path: file,
          reason: error?.code ? String(error.code) : 'auth metadata is not valid JSON',
        });
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return parseableFiles > 0 || includeEmpty ? { byClaudeEmail, byCodexAccountId, files, issues } : null;
  }

  proxyPoolIdentityFor(account) {
    if (account.provider === 'claude') {
      const email = account.identity?.trim().toLowerCase();
      return email ? { provider: 'claude', value: email } : null;
    }
    if (account.provider === 'codex') {
      const identifier = this.codexAccountIdentifiers.get(account.id);
      return identifier ? { provider: 'codex', value: identifier } : null;
    }
    return null;
  }

  proxyPoolRecordFor(account, weights) {
    if (!weights) return null;
    const identity = this.proxyPoolIdentityFor(account);
    if (!identity) return null;
    const records = identity.provider === 'claude'
      ? weights.byClaudeEmail
      : weights.byCodexAccountId;
    return records.has(identity.value) ? records.get(identity.value) : null;
  }

  proxyPoolFor(account, weights) {
    if (!weights) return null;
    return this.proxyPoolRecordFor(account, weights) ? 'member' : 'absent';
  }

  // Weight 0 is a real value (the proxy stops routing there). Membership and
  // weight are separate: a fresh auth file can prove membership while weight
  // remains absent until the external rebalance job runs.
  proxyWeightFor(account, weights) {
    const record = this.proxyPoolRecordFor(account, weights);
    return Number.isInteger(record?.weight) && record.weight >= 0 ? record : null;
  }

  // Issue #396 — CREDENTIAL HEALTH, the proxy's own verdict on its pool.
  //
  // The daemon has never had an expiry signal for pool members: it reads the
  // auth files for identity and weight only, and a token's VALUE is never
  // parsed. The honest source is CLIProxyAPI itself, which marks a credential
  // whose refresh was rejected upstream `status: error / unavailable: true`
  // and clears it back to active on a successful sign-in. That flip is what
  // makes "the member is broken" and "the member recovered" both observable.
  //
  // Cheap by construction: one cached loopback GET, never per account. On any
  // failure — no key, proxy down, unknown shape — the answer is null, meaning
  // UNKNOWN, and every downstream key is omitted so the UI renders nothing.
  async proxyCredentialHealth({ force = false } = {}) {
    if (!this.cliproxyManagementKeyPath) return null;
    const now = this.proxyReloginNow();
    const cached = this.proxyCredentialHealthCache;
    if (!force && cached && now - cached.at < PROXY_CREDENTIAL_HEALTH_TTL_MS) {
      return cached.pending ? cached.pending : cached.value;
    }
    // Issue #539: the observation needs the proxy's raw `status` as well as
    // the health word, because only `active` is a finished sign-in.
    // The extra read uses the same already-allowlisted fields.
    const probe = (async () => {
      try {
        const entries = await this.proxyReloginDriver.authFiles();
        return {
          health: proxyCredentialHealthFromAuthFiles(entries, now),
          active: proxyCredentialActiveIdentities(entries),
        };
      } catch {
        return null;
      }
    })();
    const pending = probe.then((result) => result?.health ?? null);
    // Concurrent /api/state reads share one probe rather than each dialing.
    this.proxyCredentialHealthCache = { at: now, value: null, pending };
    const value = await pending;
    if (this.proxyCredentialHealthCache?.pending === pending) {
      this.proxyCredentialHealthCache = { at: this.proxyReloginNow(), value, pending: null };
      this.observeProxyCredentialHealth(await probe);
    }
    return value;
  }

  // Issue #539 (RULED by Tim, 2026-08-19) — WHEN the proxy's verdict flipped
  // back to ok, recorded beside the measured streak and never inside it.
  //
  // Doctrine 0034 still decides red versus clear: only a routed request can
  // do that. This exists because the state in between was unspeakable. Tim
  // repaired a credential, the proxy marked it active again, and the banner
  // kept shouting that the last N requests had failed — which reads as "the
  // sign-in didn't take". With this fact the daemon can say instead: signed
  // in again, waiting for the next request.
  //
  // A flip is a CHANGE. A verdict first SEEN as ok — a restarted daemon, a
  // member that was never broken — is not a repair and marks nothing, so the
  // soft state can only ever follow an observed recovery.
  //
  // TWO RULES THE REVIEW OF PR #543 BOUGHT, both about not overclaiming:
  //
  // 1. The repair is stamped with the LAST MOMENT THE DAEMON KNEW THE
  //    CREDENTIAL WAS BROKEN, never with the probe that noticed the recovery.
  //    The probe is cached for 15s and only runs on a state read, so "now"
  //    could be long after the real sign-in — and a request that failed in
  //    that gap would have been softened by a repair it actually preceded.
  //    Dating the repair to the last bad observation makes every failure the
  //    daemon cannot place before the sign-in keep the alert red.
  // 2. Only `active` is a finished sign-in. `refreshing` and `pending` map to
  //    the same `ok` health (nothing is broken yet), but claiming
  //    "signed in again" for a refresh nobody performed is exactly the false
  //    reassurance this issue exists to remove.
  observeProxyCredentialHealth(probe) {
    if (!probe?.health) return; // unknown: remember nothing rather than invent a flip
    const seenAt = new Date(this.proxyReloginNow()).toISOString();
    const record = (provider, records) => {
      for (const [value, entry] of records) {
        const key = `${provider}:${value}`;
        // A rate-limit reset is not a sign-in. Resting must not leave a
        // broken observation that a later active verdict calls a repair.
        if (entry.health === 'resting') {
          this.proxyCredentialObservations.delete(key);
          continue;
        }
        const seen = this.proxyCredentialObservations.get(key);
        let lastBrokenAt = seen?.lastBrokenAt ?? null;
        let repairedAt = seen?.repairedAt ?? null;
        if (entry.health !== 'ok') {
          lastBrokenAt = seenAt;
          repairedAt = null;
        } else if (repairedAt == null && lastBrokenAt != null && probe.active.has(key)) {
          repairedAt = lastBrokenAt;
        }
        this.proxyCredentialObservations.set(key, { lastBrokenAt, repairedAt });
      }
    };
    record('claude', probe.health.byClaudeEmail);
    record('codex', probe.health.byCodexAccountId);
  }

  /// When this account's proxy credential was last observed flipping from
  /// broken to ok, or null when this daemon has never seen that happen.
  proxyCredentialRepairedAt(account) {
    const identity = this.proxyPoolIdentityFor(account);
    if (!identity) return null;
    const key = `${identity.provider}:${identity.value}`;
    return this.proxyCredentialObservations.get(key)?.repairedAt || null;
  }

  /// Join an account to its health record using the SAME identity keys the
  /// pool reader uses, so membership and health can never disagree about who
  /// they are describing.
  proxyCredentialFor(account, health) {
    if (!health) return null;
    const identity = this.proxyPoolIdentityFor(account);
    if (!identity) return null;
    const records = identity.provider === 'claude'
      ? health.byClaudeEmail
      : health.byCodexAccountId;
    return records.get(identity.value) || null;
  }

  /// The live session for this account, or null. Expiry is evaluated here so
  /// a session the proxy has already abandoned (its waiter stops at five
  /// minutes) can never read as still pending.
  activeProxyReloginSession(accountId) {
    const session = this.proxyReloginSessions.get(accountId);
    if (!session || isSettledProxyReloginPhase(session.phase)) return null;
    if (this.proxyReloginNow() - session.startedAt >= PROXY_RELOGIN_SESSION_TTL_MS) {
      session.phase = proxyReloginNextPhase(session.phase, 'expired');
      session.detail = proxyReloginFailureText('expired');
      return null;
    }
    return session;
  }

  proxyReloginPayload(session) {
    return {
      accountId: session.accountId,
      provider: session.provider,
      phase: session.phase,
      // The authorize URL is returned ONCE, by start(). It is never logged,
      // never stored, and never repeated on a poll.
      ...(session.detail ? { detail: session.detail } : {}),
    };
  }

  proxyReloginAvailabilityFor(account, managementKeyPresent) {
    return decideProxyReloginAvailability({
      provider: account.provider,
      baseUrl: this.cliproxyBaseUrl,
      managementKeyPresent,
    });
  }

  /// Ask the PROXY to start its own OAuth for this account's provider and
  /// hand back the authorize URL for the app to open. ModelDeck performs no
  /// login, holds no credential, and writes no auth file (#398): the proxy
  /// binds the provider's callback port itself (`is_webui=1`), completes the
  /// exchange, and saves its own file.
  async startProxyRelogin(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    const availability = this.proxyReloginAvailabilityFor(
      account,
      await this.proxyReloginDriver.managementKeyPresent(),
    );
    if (!availability.available) throw serviceError(availability.reason, 409);
    if (this.activeProxyReloginSession(accountId) || this.proxyReloginStarts.has(accountId)) {
      throw serviceError('a proxy sign-in is already in progress for this account', 409);
    }
    let started;
    const inFlight = this.proxyReloginDriver.start(account.provider);
    this.proxyReloginStarts.set(accountId, inFlight);
    try {
      started = await inFlight;
    } catch (error) {
      const reason = error instanceof ProxyReloginError ? error.reason : null;
      throw serviceError(
        proxyReloginFailureText(reason, { status: error?.status ?? null }),
        reason === 'unsupported-provider' ? 400 : 502,
      );
    } finally {
      if (this.proxyReloginStarts.get(accountId) === inFlight) {
        this.proxyReloginStarts.delete(accountId);
      }
    }
    const session = {
      accountId: account.id,
      provider: account.provider,
      state: started.state,
      startedAt: this.proxyReloginNow(),
      phase: proxyReloginNextPhase(proxyReloginNextPhase('idle', 'start'), 'started'),
      detail: null,
    };
    this.proxyReloginSessions.set(account.id, session);
    return { ...this.proxyReloginPayload(session), url: started.url };
  }

  /// Poll the proxy for the outcome of the sign-in it is running. Every
  /// answer is a phase the UI already has copy for; nothing is inferred.
  async proxyReloginState(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    const session = this.proxyReloginSessions.get(accountId);
    if (!session) {
      const availability = this.proxyReloginAvailabilityFor(
        account,
        await this.proxyReloginDriver.managementKeyPresent(),
      );
      return {
        accountId: account.id,
        provider: account.provider,
        phase: 'idle',
        available: availability.available,
        ...(availability.reason ? { reason: availability.reason } : {}),
      };
    }
    // Re-reading through activeProxyReloginSession applies the expiry rule.
    if (!this.activeProxyReloginSession(accountId)) return this.proxyReloginPayload(session);

    let status;
    try {
      status = await this.proxyReloginDriver.status(session.state);
    } catch (error) {
      session.phase = proxyReloginNextPhase(session.phase, 'transport-error');
      session.detail = proxyReloginFailureText(
        error instanceof ProxyReloginError ? error.reason : null,
        { status: error?.status ?? null },
      );
      return this.proxyReloginPayload(session);
    }
    if (status.status === 'ok') {
      session.phase = proxyReloginNextPhase(session.phase, 'poll-ok');
      session.detail = null;
      // The recovery signal, immediately: re-read the proxy's own health so
      // the restored member is visible on the very next state read rather
      // than after the cache expires.
      await this.proxyCredentialHealth({ force: true });
    } else if (status.status === 'error') {
      session.phase = proxyReloginNextPhase(session.phase, 'poll-error');
      // The proxy's own reason, verbatim and length-capped — it names the
      // real failure ("unknown or expired state", a failed code exchange)
      // far better than any sentence ModelDeck could guess.
      session.detail = status.error
        ? `CLIProxyAPI could not finish the sign-in: ${status.error}`
        : proxyReloginFailureText(null);
    } else {
      session.phase = proxyReloginNextPhase(session.phase, 'poll-wait');
    }
    return this.proxyReloginPayload(session);
  }

  /// Stop the sign-in. Honest by construction: this asks the PROXY to drop
  /// its own pending session, so unlike the pool-join wait there is nothing
  /// still running server-side afterwards. A proxy that refuses is not an
  /// error the user can act on — its session expires on its own either way.
  async cancelProxyRelogin(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    const session = this.activeProxyReloginSession(accountId);
    if (!session) throw serviceError(proxyReloginFailureText('no-session'), 409);
    let cancelledUpstream = false;
    try { cancelledUpstream = await this.proxyReloginDriver.cancel(session.state); }
    catch { cancelledUpstream = false; }
    session.phase = proxyReloginNextPhase(session.phase, 'cancel');
    session.detail = null;
    return { ...this.proxyReloginPayload(session), cancelledUpstream };
  }

  async joinProxyPool(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    if (account.provider !== 'claude' && account.provider !== 'codex') {
      throw serviceError('proxy-pool login is only supported for claude and codex accounts', 400);
    }
    if (this.proxyJoinPromises.has(account.provider)) {
      throw new ProxyPoolJoinConflictError(account.provider);
    }
    const promise = this.performProxyPoolJoin(account);
    this.proxyJoinPromises.set(account.provider, promise);
    try {
      return await promise;
    } finally {
      if (this.proxyJoinPromises.get(account.provider) === promise) {
        this.proxyJoinPromises.delete(account.provider);
      }
    }
  }

  async performProxyPoolJoin(account) {
    if (!this.cliproxyAuthDir) {
      throw serviceError('CLIProxyAPI auth directory is not configured', 409);
    }
    if (!this.proxyPoolIdentityFor(account)) {
      const evidence = account.provider === 'claude'
        ? 'identity email'
        : 'remembered account_id';
      throw serviceError(`cannot join this ${account.provider} account until its ${evidence} is available; refresh the account first`, 409);
    }
    try { await fs.promises.readdir(this.cliproxyAuthDir); }
    catch (error) {
      // A first login may create the auth directory. Every other failure means
      // there is no directory the bounded watcher can honestly observe.
      if (error.code !== 'ENOENT') {
        const code = typeof error.code === 'string'
          ? error.code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
          : '';
        throw serviceError(`CLIProxyAPI auth directory is not readable${code ? ` (${code})` : ''}`, 409);
      }
    }

    const initial = await this.readProxyWeights();
    if (this.proxyPoolFor(account, initial) === 'member') {
      return {
        accountId: account.id,
        provider: account.provider,
        proxyPool: 'member',
        alreadyMember: true,
      };
    }

    // Issue #625: without `-config`, the login helper reads ./config.yaml from
    // the daemon's cwd (`/`), finds nothing, and exits 0 with no auth file.
    // The same config the serving proxy runs on is the only sensible one.
    if (!this.cliproxyConfigDir) {
      throw serviceError('CLIProxyAPI config directory is not configured', 409);
    }
    const configFile = path.join(this.cliproxyConfigDir, 'config.yaml');
    let configStat = null;
    try { configStat = await fs.promises.stat(configFile); } catch { configStat = null; }
    if (!configStat?.isFile()) {
      throw serviceError("The proxy's config.yaml is missing from its config directory, so the sign-in cannot start", 409);
    }
    const binary = await this.cliproxyLoginBinary();
    if (!binary) {
      throw serviceError("Couldn't find the cliproxyapi program to run the sign-in", 409);
    }

    const args = ['-config', configFile, account.provider === 'claude' ? '-claude-login' : '-codex-login'];
    let child;
    try {
      child = this.spawn(binary, args, {
        // Browser OAuth needs process basics, not the daemon's provider keys,
        // mutation token, or unrelated ambient credentials.
        env: proxyLoginEnv(this.childEnv),
        shell: false,
        // OAuth URLs can contain tokens. Never capture, log, or return either
        // stream; process status below is the complete public failure detail.
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      const code = typeof error?.code === 'string'
        ? error.code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
        : '';
      throw serviceError(`CLIProxyAPI ${account.provider} login could not start${code ? ` (${code})` : ''}`, 502);
    }
    if (!child || typeof child.once !== 'function') {
      throw serviceError(`CLIProxyAPI ${account.provider} login did not start a watchable child process`, 502);
    }

    let childOutcome = null;
    let resolveChild;
    const childSettled = new Promise((resolve) => { resolveChild = resolve; });
    const settleChild = (outcome) => {
      if (childOutcome) return;
      childOutcome = outcome;
      resolveChild();
    };
    const onError = (error) => settleChild({
      kind: 'error',
      code: typeof error?.code === 'string'
        ? error.code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
        : null,
    });
    const onExit = (code, signal) => settleChild({ kind: 'exit', code, signal });
    const onClose = (code, signal) => settleChild({ kind: 'exit', code, signal });
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
    if (child.exitCode != null || child.signalCode != null) {
      settleChild({ kind: 'exit', code: child.exitCode, signal: child.signalCode });
    }

    const startedAt = this.proxyJoinNow();
    while (true) {
      const pool = await this.readProxyWeights();
      if (this.proxyPoolFor(account, pool) === 'member') {
        return {
          accountId: account.id,
          provider: account.provider,
          proxyPool: 'member',
          alreadyMember: false,
        };
      }
      if (childOutcome?.kind === 'error') {
        throw serviceError(
          `CLIProxyAPI ${account.provider} login failed to start${childOutcome.code ? ` (${childOutcome.code})` : ''}; no matching auth file appeared`,
          502,
        );
      }
      if (childOutcome?.kind === 'exit') {
        const exitDetail = childOutcome.signal
          ? `signal ${String(childOutcome.signal).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)}`
          : `exit code ${Number.isInteger(childOutcome.code) ? childOutcome.code : 'unknown'}`;
        throw serviceError(
          `CLIProxyAPI ${account.provider} login exited before a matching auth file appeared (${exitDetail})`,
          502,
        );
      }
      const elapsed = Math.max(0, this.proxyJoinNow() - startedAt);
      if (elapsed >= this.proxyJoinTimeoutMs) {
        try { child.kill?.('SIGTERM'); } catch { /* best-effort cleanup */ }
        await this.proxyJoinWait(childSettled, this.proxyJoinTerminationGraceMs);
        if (!childOutcome) {
          try { child.kill?.('SIGKILL'); } catch { /* best-effort cleanup */ }
          await this.proxyJoinWait(childSettled, this.proxyJoinTerminationGraceMs);
        }
        const termination = childOutcome?.kind === 'exit'
          ? (childOutcome.signal
            ? `terminated by ${String(childOutcome.signal).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)}`
            : `exited with code ${Number.isInteger(childOutcome.code) ? childOutcome.code : 'unknown'}`)
          : childOutcome?.kind === 'error'
            ? `reported ${childOutcome.code || 'a process error'}`
            : 'did not exit after termination';
        throw serviceError(
          `CLIProxyAPI ${account.provider} login timed out without a matching auth file; child ${termination}`,
          504,
        );
      }
      const remaining = this.proxyJoinTimeoutMs - elapsed;
      const interval = Math.max(1, Math.min(this.proxyJoinPollIntervalMs, remaining));
      await this.proxyJoinWait(childSettled, interval);
    }
  }

  // Issue #625 — which `cliproxyapi` runs the pool sign-in. An absolute
  // configured path (MODELDECK_CLIPROXY_BIN) is the operator's word and wins.
  // A bare name is resolved first to the executable of the process serving
  // the proxy port: under coexist that is the user's launch agent's binary,
  // under a managed proxy the app's bundled copy, and either way the version
  // the pool actually runs. Only then does PATH (plus the #2 fallback dirs)
  // get a turn. `null` means nothing usable was found; the caller says so
  // instead of letting spawn fail with a bare ENOENT.
  async cliproxyLoginBinary() {
    if (path.isAbsolute(this.cliproxyPath)) return this.cliproxyPath;
    const serving = await this.servingProxyExecutable();
    if (serving) return serving;
    try { return await this.toolExecutablePath(this.cliproxyPath); }
    catch { return null; }
  }

  // The executable mapped into the process listening on the proxy's
  // loopback port, per decision 0010: identity is the kernel's program-text
  // entry (never argv[0]), the process must belong to this user, and the
  // file must be a regular executable whose name is `cliproxyapi`. Anything
  // short of all four is not the proxy, and the probe answers `null`.
  async servingProxyExecutable() {
    const lsof = this.lsofPath === undefined
      ? (this.platform === 'darwin' ? '/usr/sbin/lsof' : null)
      : this.lsofPath;
    const uid = this.processUid();
    if (!lsof || uid == null) return null;
    let url;
    try { url = new URL(this.cliproxyBaseUrl); } catch { return null; }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    const run = async (args) => {
      const result = await this.exec(lsof, args, { timeout: 10_000, maxBuffer: 65_536 });
      return String(result?.stdout ?? result ?? '');
    };
    let pids;
    try {
      pids = (await run(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-a', '-u', String(uid), '-t']))
        .split(/\s+/).filter((pid) => /^\d+$/.test(pid));
    } catch {
      return null; // lsof exits non-zero when nothing listens
    }
    for (const pid of pids) {
      let executable;
      try {
        executable = (await run(['-p', pid, '-a', '-d', 'txt', '-Fn']))
          .split('\n').find((line) => line.startsWith('n'))?.slice(1);
      } catch {
        continue; // exited between the two calls
      }
      if (!executable || !path.isAbsolute(executable)) continue;
      if (path.basename(executable).toLowerCase() !== 'cliproxyapi') continue;
      try {
        const stat = await fs.promises.stat(executable);
        if (!stat.isFile()) continue;
        await fs.promises.access(executable, fs.constants.X_OK);
      } catch {
        continue;
      }
      return executable;
    }
    return null;
  }

  // Issue #522 — per-profile client-key helper wiring (design §2.5).
  //
  // ModelDeck records, per profile, the EXACT `apiKeyHelper` string it last
  // wrote. That record is the only thing that makes a helper "ours"
  // (`classifyClaudeHelper`), the only thing that decides which Keychain
  // service the shell env and launch preview point at, and the thing that
  // makes the legacy→per-profile migration resumable.
  claudeClientKeyRecord(account) {
    const record = account?.metadata?.clientKeyHelper;
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  }

  /// The Claude account owning this profile directory. Callers pass either the
  /// managed profile path or its resolved target, so both sides are
  /// realpath'd. No owning account (a directory ModelDeck does not track)
  /// keeps the pre-#522 legacy service, which is exactly today's behaviour.
  async claudeAccountForProfile(profileRef) {
    let target;
    try { target = await this.realpath(profileRef); }
    catch { return null; }
    for (const account of this.store.listAccounts()) {
      if (account.provider !== 'claude') continue;
      let candidate;
      try { candidate = await this.realpath(account.profileRef); }
      catch { continue; }
      if (candidate === target) return account;
    }
    return null;
  }

  async claudeClientKeyServiceFor(profileRef) {
    return clientKeyServiceForRecord(this.claudeClientKeyRecord(await this.claudeAccountForProfile(profileRef)));
  }

  /// Persist (or clear) the recorded written helper state. Follows the
  /// renewal-metadata pattern: a full saveAccount with the account's own
  /// current fields, so no unrelated column is rewritten.
  saveClaudeClientKeyRecord(accountId, record) {
    const account = this.store.getAccount(accountId);
    if (!account) return null;
    const metadata = { ...account.metadata };
    if (record) metadata.clientKeyHelper = record;
    else delete metadata.clientKeyHelper;
    this.store.saveAccount({
      id: account.id,
      provider: account.provider,
      label: account.label,
      identity: account.identity,
      purpose: account.purpose,
      profileRef: account.profileRef,
      color: account.color,
      enabled: account.enabled,
      metadata,
    });
    return record;
  }

  /// The helper this profile SHOULD carry when routed: the per-profile item
  /// once migration has provisioned one, the legacy shared item otherwise.
  claudeDesiredHelper(account) {
    const record = this.claudeClientKeyRecord(account);
    return record?.mode === 'per-profile'
      ? clientKeyHelperCommand(clientKeyServiceForRecord(record))
      : LEGACY_CLIENT_KEY_HELPER;
  }

  /// Honest, read-only report of where this profile's wiring actually stands —
  /// including a migration that stopped between its two files.
  async claudeClientKeyWiring(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    if (account.provider !== 'claude') {
      throw serviceError('client key wiring is only supported for claude accounts', 400);
    }
    const record = this.claudeClientKeyRecord(account);
    const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
    let settingsHelper = null;
    try {
      const parsed = parseJsonPreservingNumberValues(await fs.promises.readFile(path.join(profileRef, 'settings.json'), 'utf8'));
      if (isJsonObject(parsed) && typeof parsed.apiKeyHelper === 'string') settingsHelper = parsed.apiKeyHelper;
    } catch { /* absent or unparseable settings reports as not wired */ }
    const service = clientKeyServiceForRecord(record);
    const active = await this.claudeProfileIsActive(profileRef).catch(() => false);
    let shellEnvWired = null;
    if (active) {
      try {
        shellEnvWired = (await fs.promises.readFile(this.claudeShellEnvFile, 'utf8'))
          .includes(`find-generic-password -s ${service} -w`);
      } catch { shellEnvWired = false; }
    }
    // The two writes are separate files and cannot be atomic together, so
    // each is reported on its own evidence rather than inferred from the
    // other (the #282 major-2 discipline).
    //
    // `settingsWired` deliberately means "settings.json carries the exact
    // helper ModelDeck recorded writing", not merely "some helper is
    // present". A pre-#522 install that was wired before this record existed
    // therefore reports false until its next wire or migration records the
    // string — honest ("we cannot prove we wrote this") rather than a claim
    // of ownership the guard itself would refuse to make.
    const settingsWired = Boolean(record?.helper) && settingsHelper === record.helper;
    return {
      accountId: account.id,
      mode: record?.mode === 'per-profile' ? 'per-profile' : 'legacy',
      service,
      stage: record?.migration?.stage ?? null,
      settingsWired,
      shellEnvWired,
      // D6/§2.5: the shared item is left in place and its value stays in
      // `api-keys`, so live shells that read it at startup keep working —
      // their requests attribute as honest NULL, never guessed.
      legacySharedKeyStillAdmitted: record?.mode === 'per-profile',
      // Computed from EVIDENCE, never from the recorded stage alone. A stage
      // left over from an earlier migration — after an unwire removed the
      // helper, say — must not report a profile as wired when neither file
      // carries the helper any more.
      complete: record?.migration?.stage === 'complete'
        && settingsWired
        && (shellEnvWired ?? true),
    };
  }

  /// The legacy→per-profile migration, daemon half (design §2.5).
  ///
  /// The app owns raw keys and the proxy config: it provisions the profile's
  /// Keychain item (#520) and appends the key — plus the legacy value, for
  /// live-session continuity — through the consented write path (#521). This
  /// method performs the third stage only, the two files the daemon owns, and
  /// REFUSES until the app reports the consented config write landed: wiring
  /// a helper to a key `api-keys` does not carry would 401 every request.
  ///
  /// Resumable: each stage is persisted as it completes, so a crash between
  /// settings.json and the shell env file is picked up by the next call
  /// instead of being redone or silently left half-applied.
  async migrateClaudeClientKeyHelper(accountId, input = {}) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    if (account.provider !== 'claude') {
      throw serviceError('client key wiring is only supported for claude accounts', 400);
    }
    if (input?.configWriteVerified !== true) {
      throw serviceError(
        'per-profile client key migration needs the consented config write to have landed first; '
        + 'the proxy would reject a key its api-keys list does not carry',
        409,
      );
    }
    const service = clientKeyService(account.id);
    await this.assertClientKeyItemPresent(service);
    return this.withClaudeActivationLock(async () => {
      const latest = this.store.getAccount(accountId);
      if (!latest) throw serviceError('account not found', 404);
      const profileRef = managedClaudeProfile(latest.profileRef, this.claudeProfilesDir);
      return this.withClaudeProfileSettingsLock(
        profileRef,
        () => this.applyClaudeClientKeyMigration(latest, profileRef, service),
      );
    });
  }

  /// Metadata-only Keychain presence check — deliberately WITHOUT `-w`, so no
  /// key value can enter the daemon process (design §2.1: the daemon never
  /// retains a raw client key). Only a proven item-not-found refuses; any
  /// other failure is unknown state and refuses too, because wiring a helper
  /// at an item that may not exist would leave sessions unauthenticated.
  async assertClientKeyItemPresent(service) {
    // Off darwin there is no Keychain to probe, so this check is a deliberate
    // no-op rather than a refusal: `security` does not exist, and failing
    // closed would make the migration impossible on the platforms the test
    // fixtures and the Linux daemon build run on. The gate that actually
    // matters — the consented config write — is platform-independent and
    // still applies.
    if (this.platform !== 'darwin') return;
    try {
      await this.exec('/usr/bin/security', ['find-generic-password', '-s', service], {
        timeout: 5_000,
        maxBuffer: 65_536,
      });
    } catch {
      throw serviceError(
        `the per-profile client key for ${service} is not in the Keychain; provision it before wiring the helper`,
        409,
      );
    }
  }

  async applyClaudeClientKeyMigration(account, profileRef, service) {
    // Same conflict rule as a routing change: never mutate settings behind a
    // renewal or activation whose assumptions this would change.
    this.assertClaudeProxyRoutingIdle(account.id);
    const record = this.claudeClientKeyRecord(account);
    if (record?.migration?.stage === 'complete' && record.service === service) {
      // Idempotent: a re-run of a FINISHED migration reports state, never
      // rewrites files. "Finished" is the evidence-backed `complete`, not the
      // recorded stage — a stage whose files no longer carry the helper must
      // fall through and be re-applied, or the migration could never be
      // re-run after an unwire.
      const state = await this.claudeClientKeyWiring(account.id);
      if (state.complete) return state;
    }
    const helper = clientKeyHelperCommand(service);
    const at = new Date(this.now()).toISOString();
    const migration = {
      from: 'legacy',
      startedAt: record?.migration?.startedAt ?? at,
      updatedAt: at,
      stage: 'settings',
    };

    const settingsPath = path.join(profileRef, 'settings.json');
    let raw = null;
    try { raw = await fs.promises.readFile(settingsPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let settings = {};
    if (raw != null) {
      try { settings = parseJsonPreservingNumberValues(raw); }
      catch { throw serviceError('Claude profile settings.json is not valid JSON; fix it before migrating the client key helper', 400); }
      if (!isJsonObject(settings)) {
        throw serviceError('Claude profile settings.json must contain a JSON object', 400);
      }
    }
    // Design §2.5 migrates ROUTED profiles. An apiKeyHelper outranks the
    // profile's stored OAuth, so adding one to a profile that does not talk
    // to the local proxy would break it outright — the same predicate the
    // shell pointer uses (#277 review), refused rather than assumed.
    const baseUrl = isJsonObject(settings.env) ? settings.env.ANTHROPIC_BASE_URL : undefined;
    if (!isLoopbackUrl(baseUrl)) {
      throw serviceError(
        'per-profile client keys apply only to profiles routed through the local proxy; '
        + 'route this profile before migrating its helper',
        409,
      );
    }
    // The same ownership guard the wire path uses: a helper ModelDeck cannot
    // prove it wrote is the user's, and migration overwrites nothing.
    this.assertClaudeHelperIsOurs(settings.apiKeyHelper, record, 'migrating');

    const next = { ...settings, apiKeyHelper: helper };
    const written = `${JSON.stringify(next, null, 2)}\n`;
    const wroteSettings = raw !== written;
    if (wroteSettings) await this.writeClaudeProfileSettings(settingsPath, written);
    this.saveClaudeClientKeyRecord(account.id, {
      mode: 'per-profile', service, helper, writtenAt: at, migration,
    });

    try {
      if (await this.claudeProfileIsActive(profileRef)) {
        const { cliproxyRouted } = await this.claudeAuthOverrideState(profileRef);
        await this.writeClaudeShellEnvFile(profileRef, cliproxyRouted);
      }
    } catch (error) {
      // Partial state, recorded and reported honestly rather than rolled
      // back: settings.json already points at the per-profile item, and the
      // next call resumes from the recorded `settings` stage.
      throw serviceError(
        `client key helper migration wrote settings.json but could not refresh the shell environment: ${errorMessage(error)}`,
        500,
      );
    }
    this.saveClaudeClientKeyRecord(account.id, {
      mode: 'per-profile',
      service,
      helper,
      writtenAt: at,
      migration: { ...migration, stage: 'complete', updatedAt: new Date(this.now()).toISOString() },
    });
    return this.claudeClientKeyWiring(account.id);
  }

  /// The foreign-helper guard's refusal half (design §2.5, should-fix 7).
  assertClaudeHelperIsOurs(helper, record, action) {
    if (classifyClaudeHelper(helper, record) !== 'foreign') return;
    throw serviceError(
      "this profile's settings.json carries an apiKeyHelper that ModelDeck did not write; "
      + `remove it yourself before ${action} sessions through the proxy`,
      409,
    );
  }

  wireProxyRouting(accountId) {
    return this.setProxyRouting(accountId, true);
  }

  unwireProxyRouting(accountId) {
    return this.setProxyRouting(accountId, false);
  }

  async setProxyRouting(accountId, enabled) {
    this.requireManaged('claude');
    this.assertNoProviderManagement('claude');
    const account = this.store.getAccount(accountId);
    if (!account) throw serviceError('account not found', 404);
    if (account.provider !== 'claude') {
      throw serviceError('proxy session routing is only supported for claude accounts', 400);
    }
    // Immediate account-specific conflict: do not queue a settings mutation
    // behind a renewal/activation whose assumptions it would change.
    this.assertClaudeProxyRoutingIdle(accountId);
    return this.withClaudeActivationLock(async () => {
      // Re-check after waiting behind unrelated Claude work. A same-account
      // operation may have arrived while this request was queued.
      this.assertClaudeProxyRoutingIdle(accountId);
      const latest = this.store.getAccount(accountId);
      if (!latest) throw serviceError('account not found', 404);
      if (latest.provider !== 'claude') {
        throw serviceError('proxy session routing is only supported for claude accounts', 400);
      }
      const profileRef = managedClaudeProfile(latest.profileRef, this.claudeProfilesDir);
      return this.withClaudeProfileSettingsLock(
        profileRef,
        () => this.updateClaudeProxyRoutingSettings(latest, profileRef, enabled),
      );
    });
  }

  async updateClaudeProxyRoutingSettings(account, profileRef, enabled) {
    this.requireManaged('claude');
    this.assertClaudeProxyRoutingIdle(account.id);
    const settingsPath = path.join(profileRef, 'settings.json');
    let raw = null;
    try { raw = await fs.promises.readFile(settingsPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    let settings = {};
    if (raw != null) {
      try { settings = parseJsonPreservingNumberValues(raw); }
      catch { throw serviceError('Claude profile settings.json is not valid JSON; fix it before changing proxy routing', 400); }
      if (!isJsonObject(settings)) {
        throw serviceError('Claude profile settings.json must contain a JSON object', 400);
      }
    }
    if (Object.hasOwn(settings, 'env')
      && !isJsonObject(settings.env)) {
      throw serviceError('Claude profile settings.json env must contain a JSON object', 400);
    }

    // #282 adversarial review, major 4: ModelDeck only manages its OWN
    // routing values. A base URL that is not a local CLIProxy, or a helper
    // that is not ModelDeck's, is the user's configuration — wire refuses
    // to overwrite it and unwire refuses to delete it, with an error that
    // says exactly what is in the way. Without this, "Stop routing" on a
    // corporate-gateway profile silently destroyed user settings.
    const existingBase = isJsonObject(settings.env) ? settings.env.ANTHROPIC_BASE_URL : undefined;
    const foreignBase = typeof existingBase === 'string'
      && existingBase !== this.cliproxyBaseUrl
      && !isLoopbackUrl(existingBase);
    // Issue #522: ownership is PROVEN, not inferred. A helper is ModelDeck's
    // only when it exactly matches this profile's recorded written state —
    // or, for a profile that predates per-profile keys, the one fixed legacy
    // string every earlier release wrote. A helper that merely LOOKS
    // generated, even carrying a real account's slug, has no record behind it
    // and may be the user's own deliberate wiring: it gets this 409, never an
    // overwrite or a delete (should-fix 7, sharpened by CodeRabbit).
    const helperRecord = this.claudeClientKeyRecord(account);
    const foreignHelper = classifyClaudeHelper(settings.apiKeyHelper, helperRecord) === 'foreign';
    if (foreignBase || foreignHelper) {
      const inTheWay = [
        ...(foreignBase ? [`env.ANTHROPIC_BASE_URL (${existingBase})`] : []),
        ...(foreignHelper ? ['apiKeyHelper'] : []),
      ].join(' and ');
      throw serviceError(
        `this profile's settings.json carries ${inTheWay} that ModelDeck did not write; `
        + `remove it yourself before ${enabled ? 'routing' : 'un-routing'} sessions through the proxy`,
        409,
      );
    }

    const next = { ...settings };
    // Issue #522: a migrated profile is re-wired to its OWN item; one that
    // never migrated keeps the shared item, unchanged from before.
    const desiredHelper = this.claudeDesiredHelper(account);
    if (enabled) {
      next.env = {
        ...(settings.env || {}),
        ANTHROPIC_BASE_URL: this.cliproxyBaseUrl,
      };
      next.apiKeyHelper = desiredHelper;
    } else {
      delete next.apiKeyHelper;
      if (settings.env) {
        next.env = { ...settings.env };
        delete next.env.ANTHROPIC_BASE_URL;
        if (Object.keys(next.env).length === 0) delete next.env;
      }
    }

    const written = `${JSON.stringify(next, null, 2)}\n`;
    const settingsChanged = raw == null
      ? enabled || Object.keys(next).length > 0
      : raw !== written;
    const active = await this.claudeProfileIsActive(profileRef);
    let wroteSettings = false;
    try {
      if (settingsChanged) {
        await this.writeClaudeProfileSettings(settingsPath, written);
        wroteSettings = true;
      }
      // Issue #522: record the exact string we just wrote (or that we no
      // longer carry a helper) BEFORE the shell env is written — the shell
      // writer reads the record to pick its Keychain service, and the guard
      // reads it on every later wire/unwire.
      const nextRecord = {
        ...(helperRecord || {}),
        mode: helperRecord?.mode === 'per-profile' ? 'per-profile' : 'legacy',
        service: clientKeyServiceForRecord(helperRecord),
        helper: enabled ? desiredHelper : null,
        writtenAt: new Date(this.now()).toISOString(),
      };
      // Unwiring removes the helper, so any recorded migration is spent: a
      // stale `complete` stage would otherwise make the state report claim a
      // finished migration with nothing wired, and would make the POST's
      // idempotency short-circuit turn re-migration into a permanent no-op.
      // The provisioning (mode/service) survives; the migration does not.
      if (!enabled) delete nextRecord.migration;
      this.saveClaudeClientKeyRecord(account.id, nextRecord);
      const routing = await this.claudeAuthOverrideState(profileRef);
      if (active) {
        // cliproxyRouted, not proxyRouted: the shell key pointer goes only
        // to profiles whose base URL is actually a local CLIProxy (#277
        // review) — same predicate the activation path uses.
        await this.writeClaudeShellEnvFile(profileRef, routing.cliproxyRouted);
      }
      return {
        accountId: account.id,
        provider: 'claude',
        proxyRouted: routing.proxyRouted,
        cliproxyRouted: routing.cliproxyRouted,
        helperRouted: routing.helperRouted,
      };
    } catch (error) {
      // settings.json and the active shell pin are two files, so the last
      // rename cannot be globally atomic. If the pin write fails, restore
      // the exact pre-action settings bytes and best-effort restore its pin.
      if (wroteSettings) {
        try {
          // The recorded helper state is part of the pre-action snapshot: a
          // record naming a helper the restored settings.json does not carry
          // would make the next wire refuse its own profile.
          this.saveClaudeClientKeyRecord(account.id, helperRecord);
          if (raw == null) await fs.promises.unlink(settingsPath).catch((unlinkError) => {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          });
          else await this.writeClaudeProfileSettings(settingsPath, raw);
          if (active) {
            const restored = await this.claudeAuthOverrideState(profileRef);
            await this.writeClaudeShellEnvFile(profileRef, restored.cliproxyRouted);
          }
        } catch (rollbackError) {
          throw serviceError(
            `proxy routing update failed and settings rollback also failed: ${errorMessage(rollbackError)}`,
            500,
          );
        }
      }
      throw error;
    }
  }

  async claudeProfileIsActive(profileRef) {
    const profileRealPath = await this.realpath(profileRef);
    let activeRealPath;
    try { activeRealPath = await this.realpath(this.claudeActiveLink); }
    catch (error) {
      // Unlinked/dangling is affirmative inactive state. Permission or I/O
      // failures are unknown state and must abort before settings change; a
      // false "inactive" would skip #277's required active shell-pin rewrite.
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    return profileRealPath === activeRealPath;
  }

  async accountsWithAuthState(accounts = this.store.listAccounts()) {
    // Issue #396: health and repair-availability are resolved ONCE per state
    // read, never per account. Both answer "unknown" (null / false) without a
    // management key, which is exactly the state a fixture — and a fresh
    // managed install awaiting #431 — is in.
    const [proxyWeights, proxyHealth, proxyManagementKeyPresent] = await Promise.all([
      this.readProxyWeights(),
      this.proxyCredentialHealth(),
      this.proxyReloginDriver.managementKeyPresent(),
    ]);
    return Promise.all(accounts.map(async (account) => {
      // Issue #89: surface the per-account refresh failure refreshAll used
      // to drop, so the deck and Settings can render honest staleness.
      const lastRefreshError = this.accountRefreshErrors.get(account.id) || null;
      const authState = await this.accountAuthState(account);
      // Issue #149: additive reason field — present only alongside
      // signin-required, so every other payload byte stays identical.
      const signinReason = this.signinReason(account, authState);
      // Issue #174: additive statusline opt-in state for Claude accounts —
      // truth read from the profile's own settings.json, so a tee removed
      // out-of-band renders honestly as not installed.
      const claudeStatusline = account.provider === 'claude'
        ? { installed: await this.claudeStatuslineInstalled(account.profileRef) }
        : null;
      let renew = null;
      let claudeRouting = null;
      if (account.provider === 'claude') {
        const override = await this.claudeAuthOverrideState(account.profileRef);
        claudeRouting = {
          proxyRouted: override.proxyRouted,
          // #282 review, major 4 (UI half): loopback-verified, so the app
          // can gate its "Stop routing" offer on ModelDeck's OWN routing
          // rather than any base URL's mere presence.
          cliproxyRouted: override.cliproxyRouted,
          helperRouted: override.helperRouted,
        };
        const storedAttempt = account.metadata?.claudeRenewal?.lastAttempt;
        const lastAttempt = storedAttempt?.at && storedAttempt?.outcome
          ? {
            at: storedAttempt.at,
            outcome: storedAttempt.outcome,
            mechanism: storedAttempt.mechanism ?? null,
            // Issue #263, additive: why the cheap no-flip rung was declined.
            // A bare `busy` hid this defect for four releases — it read as
            // "a session is in the way" when the truth was "the CLI named
            // nobody, so the cheap path was never tried".
            ...(storedAttempt.identityDecline ? { identityDecline: storedAttempt.identityDecline } : {}),
            ...(storedAttempt.path ? { path: storedAttempt.path } : {}),
          }
          : null;
        renew = {
          // Busy is deliberately excluded: `available` describes whether the
          // account is intrinsically renewable, even while a running Claude
          // process makes this particular moment unsuitable.
          available: account.enabled && signinReason === 'expired'
            && !override.authOverride && override.readable,
          authOverride: override.authOverride,
          // Issue #263, additive: this profile authenticates its normal
          // traffic through an apiKeyHelper (the CLIProxyAPI route). It is
          // NOT an auth override — renewal still works, because the renewal
          // child reads a scratch settings context that has no helper.
          ...(override.helperRouted ? { helperRouted: true } : {}),
          lastAttempt,
          ...(storedAttempt?.restoreFailed ? { error: storedAttempt.detail } : {}),
        };
      }
      // Additive (the #149/#174 discipline): accounts the proxy doesn't
      // have emit `absent` only when at least one parseable auth object made
      // pool state knowable. A machine without the proxy omits the key.
      const proxyRouting = this.proxyWeightFor(account, proxyWeights);
      const proxyPool = this.proxyPoolFor(account, proxyWeights);
      // Additive Codex identity evidence: the #108 remembered
      // `tokens.account_id` IDENTIFIER (never a token value). Codex daemon
      // identities are empty, so external tools joining accounts to their
      // own records (the CLIProxyAPI rebalance job) need this or must read
      // profile files themselves. Absent until the first refresh remembers
      // it — evidence, never a guess.
      const codexAccountId = account.provider === 'codex'
        ? this.codexAccountIdentifiers.get(account.id)
        : null;
      // Issue #396, additive and gated on a real pool existing here (the
      // #149/#174 discipline): the proxy's verdict on this member's
      // credential, and whether the in-app repair can run — with the reason
      // when it cannot, so "unavailable" is never silent.
      const proxyCredentialRecord = proxyPool === 'member'
        ? this.proxyCredentialFor(account, proxyHealth)
        : null;
      const proxyRelogin = proxyPool
        ? this.proxyReloginAvailabilityFor(account, proxyManagementKeyPresent)
        : null;
      const publicAccount = this.accountForPublicResponse(account);
      const transcripts = account.provider === 'claude'
        ? await this.accountSharedTranscriptState(account) : {};
      const transcriptWarning = this.sharedTranscriptWarnings.get(account.profileRef);
      return {
        ...publicAccount,
        ...transcripts,
        ...(transcriptWarning ? { sharedTranscriptsWarning: transcriptWarning } : {}),
        authState,
        ...(signinReason ? { signinReason } : {}),
        ...(lastRefreshError ? { lastRefreshError } : {}),
        ...(claudeStatusline ? { claudeStatusline } : {}),
        ...(renew ? { renew } : {}),
        ...(claudeRouting || {}),
        ...(proxyPool ? { proxyPool } : {}),
        ...(proxyRouting != null ? { proxyWeight: proxyRouting.weight } : {}),
        // Issue #272, additive and Claude-only in practice: true when the
        // proxy's auth file benches this account for the Fable family via
        // `excluded-models` — its weight then routes only OTHER models.
        ...(proxyRouting?.fableExcluded ? { proxyFableExcluded: true } : {}),
        ...(codexAccountId ? { codexAccountId } : {}),
        ...(proxyCredentialRecord ? { proxyCredential: proxyCredentialRecord.health } : {}),
        ...(proxyCredentialRecord?.detail ? { proxyCredentialDetail: proxyCredentialRecord.detail } : {}),
        ...(proxyRelogin
          ? {
            proxyRelogin: {
              available: proxyRelogin.available,
              ...(proxyRelogin.reason ? { reason: proxyRelogin.reason } : {}),
            },
          }
          : {}),
      };
    }));
  }

  accountForPublicResponse(account) {
    const metadata = { ...account.metadata };
    delete metadata.sharedTranscriptLinks;
    if (metadata.claudeRenewal && typeof metadata.claudeRenewal === 'object') {
      metadata.claudeRenewal = { ...metadata.claudeRenewal };
      delete metadata.claudeRenewal.postExpiryGuardUntil;
    }
    return { ...account, metadata };
  }

  async providerActivationState(provider, activeLink, accounts) {
    if (!this.isProviderManaged(provider)) return { state: 'unmanaged' };
    let activeStat;
    try { activeStat = await fs.promises.lstat(activeLink); }
    catch (error) {
      if (error.code === 'ENOENT') return { state: 'unlinked' };
      throw error;
    }
    if (!activeStat.isSymbolicLink()) return { state: 'blocked' };

    const linkTarget = await fs.promises.readlink(activeLink);
    const linkedProfileRef = path.resolve(path.dirname(activeLink), linkTarget);
    let resolvedProfileRef;
    let linkResolved = true;
    try {
      resolvedProfileRef = await fs.promises.realpath(linkedProfileRef);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      linkResolved = false;
      resolvedProfileRef = linkedProfileRef;
    }

    const defaultAccount = accounts.find((account) => account.provider === provider && account.isDefault);
    let defaultProfileRef = defaultAccount?.profileRef;
    let defaultProfileResolved = Boolean(defaultProfileRef);
    if (defaultProfileRef) {
      try { defaultProfileRef = await fs.promises.realpath(defaultProfileRef); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        defaultProfileResolved = false;
      }
    }
    if (!(linkResolved && defaultProfileResolved && defaultProfileRef === resolvedProfileRef)) {
      return { state: 'mismatched', resolvedProfileRef };
    }
    if (provider !== 'claude') return { state: 'effective', resolvedProfileRef };
    const guidance = defaultAccount
      ? `log out and run /login as ${defaultAccount.label}`
      : 'run one Claude session then refresh, or run /login';
    if (this.claudeSecureStorage.status === 'degraded' || this.claudeSecureStorage.status === 'unsupported-cli') {
      return { state: 'identity-unverified', resolvedProfileRef, guidance, secureStorage: this.claudeSecureStorage };
    }
    const actual = await this.readClaudeIdentity({ claudeConfigDir: resolvedProfileRef });
    const expected = defaultAccount?.identity?.trim().toLowerCase() || null;
    if (!expected || !actual?.identity) {
      return {
        state: 'identity-unverified', resolvedProfileRef,
        guidance: 'run one Claude session then refresh, or run /login',
        secureStorage: this.claudeSecureStorage,
      };
    }
    return actual.identity === expected
      ? { state: 'effective', resolvedProfileRef, secureStorage: this.claudeSecureStorage }
      : { state: 'identity-mismatch', resolvedProfileRef, guidance, secureStorage: this.claudeSecureStorage };
  }

  // Issue #90: the honest scheduler surface for /api/state. Reports the
  // configured cadence, the EFFECTIVE cadence the scheduler is actually
  // running, and why they differ when they do — so the deck can show a calm
  // "auto-refresh slowed" indicator instead of silently starving. The only
  // slowdown source today is the active-session cap on the never-customized
  // default interval ('active-session-cap'); effective is null while
  // auto-refresh is disabled (there is no cadence to report).
  refreshSchedulerStatus(settings = this.store.getSettings()) {
    const configured = settings.autoRefreshIntervalSeconds;
    // Same shared cadence source the scheduler itself runs on (CodeRabbit,
    // PR #111): what this reports is exactly what autoRefreshDelay and
    // runAutoRefreshTick execute, in every branch.
    const effective = settings.autoRefreshEnabled
      ? this.effectiveAutoRefreshIntervalMs(settings) / 1_000
      : null;
    return {
      pausedForActiveSessions: this.pausedForActiveSessions,
      configuredRefreshIntervalSeconds: configured,
      effectiveRefreshIntervalSeconds: effective,
      effectiveRefreshReason: effective != null && effective > configured ? 'active-session-cap' : null,
    };
  }

  // Issue #185: the daemon's runtime self-report for /api/state. A daemon
  // launched from a since-deleted bundle keeps running (the process holds
  // its text pages) but can never again spawn its own binary — the Claude
  // usage probe re-exec fails ENOENT while everything else looks healthy.
  // `binaryPresent: false` is the app's cue to re-register the service from
  // its own (installed) bundle. Cheap: one existsSync per state read.
  daemonRuntimeStatus() {
    let binaryPresent;
    try {
      binaryPresent = Boolean(this.daemonExecPathExists(this.daemonExecPath));
    } catch {
      binaryPresent = false;
    }
    return { execPath: this.daemonExecPath, binaryPresent, sea: this.daemonSea, MDGitCommit: this.daemonGitCommit };
  }

  // Issue #421/#432 — the managed-proxy block. Base fields remain facts the
  // daemon observes directly about the shared ~/.config/cliproxyapi state
  // dir (#398). App-owned process facts appear only after an explicit report:
  // never inferred, never persisted, and never assigned daemon-side freshness.
  // Presence checks only — auth contents stay CLIProxyAPI's business. Cheap:
  // two existsSync per state read, no network, no timer, no polling.
  managedProxyStatus() {
    const configDir = this.cliproxyConfigDir;
    if (!configDir) {
      return {
        baseUrl: this.cliproxyBaseUrl,
        configDir: null,
        configPresent: null,
        authDirPresent: null,
        lastQueueContactAt: this.usageQueueLastPull?.at ?? null,
        ...(this.managedProxyAppReport ? { appReport: this.managedProxyAppReport } : {}),
      };
    }
    const exists = (target) => {
      try {
        return Boolean(this.cliproxyPathExists(target));
      } catch {
        return false;
      }
    };
    return {
      baseUrl: this.cliproxyBaseUrl,
      configDir,
      configPresent: exists(path.join(configDir, 'config.yaml')),
      authDirPresent: exists(path.join(configDir, 'auth')),
      lastQueueContactAt: this.usageQueueLastPull?.at ?? null,
      ...(this.managedProxyAppReport ? { appReport: this.managedProxyAppReport } : {}),
    };
  }

  // Issue #520 — the app's hash→profile client-key mapping (design §2.1,
  // decision 0036 D1). Full-state and idempotent: the app re-reports the
  // complete mapping on every launch/handshake and the store applies it in
  // one transaction as a replacement, so a rebuilt daemon DB or a report lost
  // in flight self-heals instead of leaving requests unattributed.
  //
  // Everything crossing this boundary is treated as untrusted input even
  // though the channel is token-gated: hashes must be 64 lowercase hex, and
  // the hash of the empty string is refused outright because a keyless
  // request's usage record carries `api_key: ""` (recon V1) and would
  // otherwise attribute every unauthenticated request to a real profile.
  reportClientKeys(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw serviceError('client key report must be a JSON object', 400);
    }
    const generation = input.generation;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw serviceError('client key report generation must be a positive integer', 400);
    }
    // Bounded ABOVE as well as below (CodeRabbit, PR #529). The generation is
    // a one-way ratchet, so a single report claiming MAX_SAFE_INTEGER would
    // persist a value no honest successor can exceed — every later report
    // rejected as stale, forever, and the app's resync would adopt the
    // poisoned number and make it permanent. A mutation-token holder can do
    // worse things, but a buggy caller must not be able to brick attribution.
    if (generation > CLIENT_KEY_REPORT_MAX_GENERATION) {
      throw serviceError(`client key report generation exceeds ${CLIENT_KEY_REPORT_MAX_GENERATION}`, 400);
    }
    const rawEntries = input.entries;
    if (!Array.isArray(rawEntries)) throw serviceError('client key report entries must be an array', 400);
    if (rawEntries.length > CLIENT_KEY_REPORT_MAX_ENTRIES) {
      throw serviceError(`client key report carries more than ${CLIENT_KEY_REPORT_MAX_ENTRIES} entries`, 400);
    }
    const entries = [];
    const seenHashes = new Set();
    const seenLabels = new Set();
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw serviceError('each client key entry must be a JSON object', 400);
      }
      const keySha256 = String(raw.key_sha256 ?? '');
      if (!/^[0-9a-f]{64}$/.test(keySha256)) {
        throw serviceError('client key entry hash must be 64 lowercase hex characters', 400);
      }
      if (keySha256 === SHA256_OF_EMPTY_STRING) {
        throw serviceError('client key entry hash is the empty-key hash', 400);
      }
      if (seenHashes.has(keySha256)) throw serviceError('client key report repeats a hash', 400);
      seenHashes.add(keySha256);
      const rawProfileId = String(raw.profile_id ?? '');
      const profileId = rawProfileId.trim();
      if (!profileId || rawProfileId.length > 128 || /\p{Cc}/u.test(rawProfileId)) {
        throw serviceError('client key entry profile_id must be a non-empty string of at most 128 characters, free of control characters', 400);
      }
      const profileLabel = raw.profile_label == null ? null : String(raw.profile_label);
      if (profileLabel != null && (profileLabel.length > 128 || /\p{Cc}/u.test(profileLabel))) {
        throw serviceError('client key entry profile_label must be at most 128 characters and free of control characters', 400);
      }
      // Design §2.2: receipts store the label only, so two key-enabled
      // profiles sharing one would be indistinguishable. The app refuses this
      // at provisioning; the daemon refuses it again rather than trusting a
      // client to have done so.
      //
      // Blank labels are NOT exempt (CodeRabbit, PR #529). Two rows both
      // labelled "" are exactly as indistinguishable on a receipt as two
      // labelled "Work", and the app-side gate already collides them — it
      // inserts the normalized label unconditionally. Exempting them here
      // would have let a report the app would never build slip through the
      // check this comment claims to make. One blank label is fine; a second
      // is a collision.
      const normalizedLabel = (profileLabel ?? '').trim().toLowerCase();
      if (seenLabels.has(normalizedLabel)) {
        throw serviceError('client key report repeats a profile label', 400);
      }
      seenLabels.add(normalizedLabel);
      entries.push({ keySha256, profileId, profileLabel });
    }
    return this.store.replaceClientKeyMap({
      generation,
      entries,
      maximumGenerationJump: CLIENT_KEY_REPORT_MAX_GENERATION_JUMP,
    });
  }

  reportManagedProxy(input) {
    const report = managedProxyAppReport(input);
    this.managedProxyAppReport = {
      ...report,
      receivedAt: new Date(this.now()).toISOString(),
    };
    return this.managedProxyAppReport;
  }

  // Issue #395: the queue consumer already persists per-request member,
  // outcome, status, and time facts. Derive the live alert from that archive
  // so daemon restarts and out-of-order archive replays cannot reset or inflate
  // a streak. An explicitly absent/zero-weight or disabled member is benched,
  // so a historical failure tail must not alarm for it. CodeRabbit (PR #434):
  // membership must be CONFIRMED, not merely un-contradicted — when proxy
  // state is unknowable (no parseable auth files) `proxyPool` is omitted and
  // the account is benched; the alert's recorded scope is pool members only.
  memberBlackoutStatus(accounts) {
    const alerts = [];
    for (const account of accounts) {
      if (!account.enabled || account.proxyPool !== 'member' || account.proxyWeight === 0) continue;
      const selector = account.provider === 'claude'
        ? { accountId: account.id }
        : account.provider === 'codex' && account.codexAccountId
          ? { provider: 'codex', source: account.codexAccountId }
          : null;
      if (!selector) continue;
      const streak = this.store.requestFailureStreak(selector);
      if (streak.consecutiveFailures < MEMBER_BLACKOUT_FAILURE_THRESHOLD) continue;
      // Issue #539, additive (the #149/#174 discipline — an older daemon
      // simply omits it): the credential this streak blames has since been
      // signed in again, and no request has been through to prove it either
      // way. The streak above is untouched. A NEW measured failure moves
      // lastFailureAt past the repair and the mark disappears by arithmetic;
      // a measured success clears the whole alert, as it always did. No
      // timer ever changes it.
      const repairedAt = account.proxyCredential === 'ok'
        ? this.proxyCredentialRepairedAt(account)
        : null;
      const repairedPending = isLaterInstant(repairedAt, streak.lastFailureAt);
      // Issue #572, additive (the #149/#174 discipline — an older app simply
      // keeps the red state): overload-class failures get the honest remedy
      // and a marker the app renders in the #539 quiet style. Evidence
      // clearing is untouched — no timer, a routed success still clears it.
      const transient = memberBlackoutTransientStatus(streak.statusCode);
      alerts.push({
        accountId: account.id,
        provider: account.provider,
        label: account.label,
        ...streak,
        ...(repairedPending ? { repairedPending: true, repairedAt } : {}),
        ...(transient ? { transient: true } : {}),
        remedy: transient ? MEMBER_BLACKOUT_TRANSIENT_REMEDY : MEMBER_BLACKOUT_REMEDY,
      });
    }
    alerts.sort((left, right) => (
      right.consecutiveFailures - left.consecutiveFailures
      || left.label.localeCompare(right.label)
    ));
    return { threshold: MEMBER_BLACKOUT_FAILURE_THRESHOLD, alerts };
  }

  providerManagementBlocked() {
    const reasons = {};
    for (const provider of ['claude', 'codex']) {
      if (provider === 'claude' && this.isProviderManaged(provider)) {
        reasons[provider] = CLAUDE_UNMANAGE_UNAVAILABLE_REASON;
        continue;
      }
      try { this.assertProviderIdle(provider); }
      catch (error) { reasons[provider] = error.message; continue; }
      if (provider === 'claude' && this.store.getSettings().sharedUserScopeEnabled) {
        reasons[provider] = 'Turn off shared Claude settings before changing account switching.';
      } else if (this.isProviderManaged(provider)) {
        const accounts = this.store.listAccounts().filter((account) => account.provider === provider);
        if (accounts.length !== 1) reasons[provider] = 'Keep one account to turn off account switching.';
        else {
          try {
            const home = this[`${provider}ActiveLink`];
            if (!fs.lstatSync(home).isSymbolicLink() || fs.realpathSync(home) !== fs.realpathSync(accounts[0].profileRef)) {
              reasons[provider] = 'Activate the remaining account before turning off account switching.';
            }
          } catch { reasons[provider] = 'Activate the remaining account before turning off account switching.'; }
        }
      }
    }
    return reasons;
  }

  async state() {
    const value = this.store.state();
    const [accounts, claudeActivation, codexActivation] = await Promise.all([
      this.accountsWithAuthState(value.accounts),
      this.providerActivationState('claude', this.claudeActiveLink, value.accounts),
      this.providerActivationState('codex', this.codexActiveLink, value.accounts),
    ]);
    const claudeSecureStorage = this.claudeSecureStorage.value == null && claudeActivation.resolvedProfileRef
      ? { ...this.claudeSecureStorage, value: claudeActivation.resolvedProfileRef }
      : this.claudeSecureStorage;
    const result = {
      ...value,
      accounts,
      activation: { claude: claudeActivation, codex: codexActivation },
      managed: { claude: this.isProviderManaged('claude'), codex: this.isProviderManaged('codex') },
      managementBlocked: this.providerManagementBlocked(),
      claudeSecureStorage,
      scheduler: this.refreshSchedulerStatus(),
      usageQueue: this.usageQueueStatus(),
      warehouseIngest: this.warehouseIngestStatus(),
      daemon: this.daemonRuntimeStatus(),
      ...(this.codexProfilesMigration ? { codexProfilesMigration: this.codexProfilesMigration } : {}),
      managedProxy: this.managedProxyStatus(),
      memberBlackout: this.memberBlackoutStatus(accounts),
      modelDrop: this.modelDropStatus(accounts, value.usage),
      sharedScope: this.sharedScope.status(),
    };
    if (this.usageSnapshotPruneWaitingForState) {
      this.usageSnapshotPruneWaitingForState = false;
      // Let the first response leave before starting synchronous maintenance.
      this.scheduleUsageSnapshotPrune(0);
    }
    return result;
  }

  async providerAuthState(provider, activeLink) {
    const accounts = this.store.listAccounts().filter((account) => account.provider === provider);
    if (!accounts.length) return { authState: 'unknown', error: null };
    const active = accounts.find((account) => account.isDefault)
      || { provider, profileRef: activeLink };
    return { authState: await this.accountAuthState(active), error: null };
  }

  claudeAuthState() {
    return this.providerAuthState('claude', this.claudeActiveLink);
  }

  codexAuthState() {
    return this.providerAuthState('codex', this.codexActiveLink);
  }

  async probeTool({ binary, registryUrl, auth }) {
    const errors = [];
    let installedVersion = null;
    let latestVersion = null;
    try { installedVersion = await this.installedToolVersion(binary); }
    catch (error) {
      errors.push(error.code === 'ENOENT' ? `${binary} is not installed` : errorMessage(error));
    }
    try { latestVersion = await this.latestToolVersion(registryUrl); }
    catch (error) { errors.push(errorMessage(error)); }
    const authResult = await auth();
    if (authResult.error) errors.push(authResult.error);
    const checkedAt = new Date(this.now()).toISOString();
    return {
      installed: installedVersion != null,
      version: installedVersion,
      latestVersion,
      updateAvailable: installedVersion && latestVersion ? compareSemver(latestVersion, installedVersion) > 0 : null,
      authState: authResult.authState,
      error: errors.length ? [...new Set(errors)].join('; ') : null,
      checkedAt,
    };
  }

  invalidateToolProbe() {
    this.toolProbeGeneration += 1;
    this.toolProbeCache = null;
  }

  async probeTools({ refresh = false } = {}) {
    if (refresh) this.invalidateToolProbe();
    const timestamp = this.now();
    if (!refresh && this.toolProbeCache && timestamp < this.toolProbeCache.expiresAt) return this.toolProbeCache.value;
    const generation = this.toolProbeGeneration;
    if (this.toolProbePromise && this.toolProbePromiseGeneration === generation) return this.toolProbePromise;
    const promise = (async () => {
      const [claude, codex] = await Promise.all([
        this.probeTool({
          binary: this.claudePath,
          registryUrl: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
          auth: async () => this.claudeAuthState(),
        }),
        this.probeTool({
          binary: this.codexPath,
          registryUrl: 'https://registry.npmjs.org/@openai/codex/latest',
          auth: async () => this.codexAuthState(),
        }),
      ]);
      claude.secureStorageScopingSupported = claude.version
        ? compareSemver(claude.version, CLAUDE_SECURESTORAGE_MIN_VERSION) >= 0
        : false;
      this.claudeSecureStorageSupported = claude.secureStorageScopingSupported;
      // Issue #99 compatibility field: the historical mechanism inferred by
      // the login-flow boundary. Upstream later reverted the behavior without
      // a dependable version transition, so this now describes ModelDeck's
      // conservative flow choice rather than claiming current CLI internals;
      // null when not installed.
      claude.credentialScoping = claude.version
        ? (compareSemver(claude.version, CLAUDE_RESOLVED_HOME_CREDENTIALS_MIN_VERSION) >= 0
          ? 'resolved-home'
          : 'config-dir')
        : null;
      const value = { tools: { claude, codex }, checkedAt: new Date(this.now()).toISOString() };
      this.configLintInstalledCliVersions = Object.fromEntries(
        Object.entries({ claude: claude.version, codex: codex.version }).filter(([, version]) => version),
      );
      try {
        this.store.saveConfigLintFacts?.({ installedCliVersions: this.configLintInstalledCliVersions });
      } catch { /* Tool diagnostics remain available even if the fact row cannot be saved. */ }
      if (this.toolProbeGeneration === generation) {
        this.toolProbeCache = { value, expiresAt: this.now() + this.toolProbeTtlMs };
      }
      return value;
    })();
    this.toolProbePromise = promise;
    this.toolProbePromiseGeneration = generation;
    try { return await promise; }
    finally {
      if (this.toolProbePromise === promise) {
        this.toolProbePromise = null;
        this.toolProbePromiseGeneration = null;
      }
    }
  }

  toolUpdateConfig(tool) {
    if (tool === 'claude') {
      return { binary: this.claudePath, packageName: '@anthropic-ai/claude-code', formula: 'claude-code' };
    }
    if (tool === 'codex') {
      return { binary: this.codexPath, packageName: '@openai/codex', formula: 'codex' };
    }
    throw new ToolUpdateConflictError(`unsupported CLI tool: ${tool}`);
  }

  async toolExecutablePath(binary) {
    if (path.isAbsolute(binary)) return binary;
    let resolved = '';
    try {
      const result = await this.exec('/usr/bin/which', [binary], { timeout: 10_000, maxBuffer: 65_536 });
      resolved = String(result?.stdout ?? result).trim().split(/\r?\n/, 1)[0];
    } catch {
      // `which` exits non-zero for a binary the daemon's PATH cannot see;
      // that is the fallback-probe case below, not an error to surface.
    }
    if (!resolved) resolved = await this.toolPathFallback(binary);
    if (!resolved) throw new Error(`${binary} is not installed`);
    return resolved;
  }

  // Public issue #2: the path every daemon-side spawn of a provider CLI
  // should use. Absolute when PATH or the install-dir fallback can see the
  // binary; otherwise the bare name unchanged, so the caller's own ENOENT
  // handling still produces its "<CLI> is not installed" message rather
  // than a resolver error the UI does not know how to word.
  async spawnableToolPath(binary) {
    try {
      return await this.toolExecutablePath(binary);
    } catch {
      return binary;
    }
  }

  // Issue #2: the first executable match for `binary` in the known install
  // directories the daemon's static PATH cannot express, or '' when none.
  async toolPathFallback(binary) {
    for (const dir of this.toolPathFallbackDirs) {
      const candidate = path.join(dir, binary);
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* not in this directory — keep probing */ }
    }
    return '';
  }

  async detectToolInstall(tool) {
    const config = this.toolUpdateConfig(tool);
    let executable;
    try {
      executable = await this.toolExecutablePath(config.binary);
    } catch (error) {
      throw new ToolUpdateConflictError(
        `cannot update ${tool}: detected install method is unknown/not-installed (${errorMessage(error)})`,
      );
    }
    const canonical = await this.realpath(executable).catch(() => executable);
    const normalized = canonical.split(path.sep).join('/');
    if (normalized.includes(`/node_modules/${config.packageName}/`)) {
      return { ...config, method: 'npm global', executable, canonical };
    }
    if (normalized.includes(`/Cellar/${config.formula}/`)
      || normalized.includes(`/Caskroom/${config.formula}/`)
      || normalized.includes(`/opt/${config.formula}/`)) {
      return { ...config, method: 'Homebrew', executable, canonical };
    }
    throw new ToolUpdateConflictError(
      `cannot update ${tool}: detected unsupported direct/native install method at ${canonical}`,
    );
  }

  async performToolUpdate(tool) {
    const install = await this.detectToolInstall(tool);
    const previousVersion = await this.installedToolVersion(install.binary);
    const command = install.method === 'npm global' ? 'npm' : 'brew';
    const args = install.method === 'npm global'
      ? ['i', '-g', `${install.packageName}@latest`]
      : ['upgrade', install.formula];
    const env = install.method === 'npm global'
      ? updaterEnv({ CI: '1', NO_UPDATE_NOTIFIER: '1' })
      : updaterEnv({ HOMEBREW_NO_AUTO_UPDATE: '1' });
    let updateResult;
    let updateError = null;
    try {
      updateResult = await this.exec(command, args, { env, timeout: 10 * 60_000, maxBuffer: 2_000_000 });
    } catch (error) {
      updateError = error;
      updateResult = error;
    }

    // A generation bump prevents this refresh from joining, or being
    // overwritten by, a probe that began before installation completed.
    const refreshed = await this.probeTools({ refresh: true }).catch(() => null);
    const newVersion = refreshed?.tools?.[tool]?.version
      || await this.installedToolVersion(install.binary).catch(() => previousVersion);
    return {
      ok: updateError == null,
      previousVersion,
      newVersion,
      'output-tail': outputTail(updateResult) || (updateError ? errorMessage(updateError) : ''),
    };
  }

  updateTool(tool) {
    this.toolUpdateConfig(tool);
    if (this.toolUpdatePromises.has(tool)) return this.toolUpdatePromises.get(tool);
    const promise = this.performToolUpdate(tool);
    this.toolUpdatePromises.set(tool, promise);
    promise.finally(() => this.toolUpdatePromises.delete(tool)).catch(() => {});
    return promise;
  }

  worstCapacity(options = {}) {
    const settings = this.store.getSettings();
    // Issue #264 (bonus fix): mark accounts whose remembered refresh error
    // says they CANNOT refresh (sign-in required / Keychain denied — the
    // same patterns accountAuthState keys on) so evaluateWorstCapacity can
    // keep their frozen rows out of the headline while still counting rows
    // a live session keeps fresh (statusline captures). Presentation-only:
    // the remembered error itself is untouched, so signinReason and renewal
    // candidacy are exactly what they were.
    const accounts = this.store.listAccounts().map((account) => {
      const lastError = this.accountRefreshErrors.get(account.id);
      const authFlagged = Boolean(lastError && (
        SIGN_IN_REQUIRED_ERROR_PATTERN.test(lastError.message)
        || KEYCHAIN_DENIED_ERROR_PATTERN.test(lastError.message)
      ));
      return authFlagged ? { ...account, authFlagged } : account;
    });
    return evaluateWorstCapacity(this.store.latestUsage(), accounts, {
      thresholdPercent: settings.notificationThresholdPercent,
      criticalPercent: options.criticalPercent ?? 10,
      now: options.now ?? this.now(),
    });
  }

  async launchSpec(provider, projectPath, extraArgs = []) {
    if (!['claude', 'codex'].includes(provider)) throw new Error('provider must be claude or codex');
    const resolvedPath = path.resolve(projectPath || process.cwd());
    const { project, account } = accountFor(this.store, provider, resolvedPath);
    if (!account) throw new Error(`no enabled ${provider} account is mapped or set as default`);
    const cwd = project?.path || resolvedPath;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`launch directory does not exist: ${cwd}`);

    if (provider === 'claude') {
      const profileRef = this.providerProfileRef(account);
      // Adversarial review of #278, blocker 1: the MAPPED account decides
      // the credential, not the shell the launch happens from. A proxied
      // shell launching a direct account must not carry ModelDeck's proxy
      // key into it (the key would override that profile's stored OAuth);
      // a clean shell launching a cliproxy-routed account needs the #277
      // key pointer or its headless children can't authenticate. The spec
      // carries a DIRECTIVE — never a credential value: `resolve` prints
      // specs as JSON, and the launcher resolves the pointer at spawn.
      const { cliproxyRouted } = await this.claudeAuthOverrideState(profileRef);
      const credential = cliproxyRouted ? 'cliproxy-pointer' : 'clear-managed';
      const pins = `CLAUDE_CONFIG_DIR=${shellQuote(profileRef)} CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellQuote(profileRef)}`;
      const invocation = `${shellQuote(this.claudePath)}${extraArgs.length ? ` ${extraArgs.map(shellQuote).join(' ')}` : ''}`;
      // The routed preview reuses the env file's exact guarded fragment
      // (CodeRabbit, PR #301): a pasted preview run under `zsh -x` must be
      // as trace-safe as the generated shell env, and must resolve
      // `security` the same way.
      // Issue #522: the preview points at the MAPPED account's own Keychain
      // item — the same record the shell env writer reads — so a pasted
      // preview and a fresh terminal fetch the identical key.
      const previewService = clientKeyServiceForRecord(this.claudeClientKeyRecord(account));
      const preview = cliproxyRouted
        ? `cd ${shellQuote(cwd)} && ${claudeProxyPointerShellSnippet(previewService)}; ${pins} ${invocation}`
        : `cd ${shellQuote(cwd)} && ${CLAUDE_MANAGED_KEY_UNSET_FRAGMENT}; ${pins} ${invocation}`;
      return {
        provider,
        account,
        project,
        cwd,
        command: this.claudePath,
        args: extraArgs,
        // Issue #66: pinned pair — see loginSpec. Resumes re-apply the same
        // env so `claude -r` finds the transcript under the same pin.
        env: { CLAUDE_CONFIG_DIR: profileRef, CLAUDE_SECURESTORAGE_CONFIG_DIR: profileRef },
        credential,
        // Issue #522: the launcher resolves the pointer itself at spawn, so
        // it needs the SAME item the preview names — a directive, never a
        // credential value. Null when the account is not cliproxy-routed.
        keychainService: cliproxyRouted ? previewService : null,
        preview,
      };
    }

    return {
      provider,
      account,
      project,
      cwd,
      command: this.codexPath,
      args: extraArgs,
      env: { CODEX_HOME: account.profileRef },
      preview: `cd ${shellQuote(cwd)} && CODEX_HOME=${shellQuote(account.profileRef)} ${shellQuote(this.codexPath)}${extraArgs.length ? ` ${extraArgs.map(shellQuote).join(' ')}` : ''}`,
    };
  }

  recordLaunch(spec, dryRun) {
    this.store.recordLaunch({
      accountId: spec.account.id,
      projectId: spec.project?.id,
      provider: spec.provider,
      commandPreview: spec.preview,
      dryRun,
    });
  }
}

export { shellQuote };
