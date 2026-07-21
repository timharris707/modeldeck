import crypto from 'node:crypto';
import { activeLinkBlockedError } from './adapters/provider-profile.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  activateClaudeProfile,
  claudePinnedEnvFileContent,
  createClaudeProfileHome,
  fetchClaudeUsage,
  importClaudeSwapProfiles as migrateClaudeSwapProfiles,
  readClaudeAuthStatus,
  readClaudeProfileIdentity,
  readClaudeRateLimitTier,
  validateClaudeProfileHome,
} from './adapters/claude.mjs';
import { claudeCredentialsPresent } from './adapters/claude-keychain.mjs';
import {
  createCodexProfileHome,
  fetchCodexRateLimits,
  readCodexAccountId,
  readCodexLoginStatus,
  readCodexPlan,
  validateCodexProfileHome,
} from './adapters/codex.mjs';
import { evaluateWorstCapacity } from './capacity.mjs';
import { scanProjectRoot } from './projects.mjs';

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

// Issue #99: from 2.1.216 on, Claude Code keys Keychain CREDENTIAL storage
// off the resolved (realpath) ~/.claude — CLAUDE_CONFIG_DIR and
// CLAUDE_SECURESTORAGE_CONFIG_DIR no longer steer where a login lands, even
// though config writes (.claude.json) still respect CLAUDE_CONFIG_DIR. An
// env-scoped `claude auth login` on such a version silently overwrites the
// ACTIVE profile's credential slot with a different account's token.
export const CLAUDE_RESOLVED_HOME_CREDENTIALS_MIN_VERSION = '2.1.216';

// Issue #89: refresh failures whose message carries this phrase mean the
// stored credentials are unusable (missing or expired) — the account needs a
// fresh provider login, no matter what the presence probe says. Expired OAuth
// still LOOKS present to the Keychain/file probe, which is exactly how the
// chip stayed "Healthy" while the card rendered fossils.
export const SIGN_IN_REQUIRED_ERROR_PATTERN = /sign in explicitly before refreshing/i;

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

class ToolUpdateConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
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

export class ModelDeckService {
  constructor(store, options = {}) {
    this.store = store;
    this.projectsRoot = options.projectsRoot;
    this.claudePath = options.claudePath || 'claude';
    this.claudeProfilesDir = options.claudeProfilesDir || path.join(os.homedir(), 'Library', 'Application Support', 'ModelDeck', 'claude-profiles');
    this.claudeActiveLink = options.claudeActiveLink || path.join(os.homedir(), '.claude');
    // Issue #66: shell snippet sourced by the install-shell-env.sh block so
    // new terminal sessions launch pinned to the active profile real path.
    // Defaults next to the profiles directory (production: the ModelDeck
    // Application Support directory) so test fixtures stay inside their roots.
    this.claudeShellEnvFile = options.claudeShellEnvFile
      || path.join(path.dirname(this.claudeProfilesDir), 'claude-env.sh');
    this.codexPath = options.codexPath || 'codex';
    this.codexActiveLink = options.codexActiveLink || path.join(os.homedir(), '.codex');
    this.codexProfilesDir = options.codexProfilesDir || path.join(os.homedir(), '.codex-profiles');
    this.fetchClaude = options.fetchClaude || fetchClaudeUsage;
    this.fetchCodex = options.fetchCodex || fetchCodexRateLimits;
    this.activateClaude = options.activateClaude || activateClaudeProfile;
    this.createClaudeProfile = options.createClaudeProfile || createClaudeProfileHome;
    this.createCodexProfile = options.createCodexProfile || createCodexProfileHome;
    this.readClaudeAuth = options.readClaudeAuth || readClaudeAuthStatus;
    this.readClaudeTier = options.readClaudeTier || readClaudeRateLimitTier;
    this.readClaudeIdentity = options.readClaudeIdentity || readClaudeProfileIdentity;
    this.readCodexAuth = options.readCodexAuth || readCodexLoginStatus;
    this.readCodexPlan = options.readCodexPlan || readCodexPlan;
    this.readCodexAccountId = options.readCodexAccountId || readCodexAccountId;
    this.claudeCredentialsPresent = options.claudeCredentialsPresent || claudeCredentialsPresent;
    this.migrateClaude = options.migrateClaude || migrateClaudeSwapProfiles;
    this.exec = options.exec || options.execFile || options.run || execFileAsync;
    this.listProviderProcesses = options.listProviderProcesses || (async () => {
      const result = await this.exec('/bin/ps', ['-U', os.userInfo().username, '-o', 'comm='], {
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      return String(result?.stdout ?? result)
        .split(/\r?\n/)
        .map((command) => path.basename(command.trim()))
        .filter((command) => command === 'claude' || command === 'codex');
    });
    this.registryFetch = options.registryFetch || options.fetcher || globalThis.fetch;
    this.toolProbeTtlMs = Number(options.toolProbeTtlMs ?? 30 * 60_000);
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.autoRefreshInitialDelayMs = Number(options.autoRefreshInitialDelayMs ?? 1_000);
    this.autoRefreshTimer = null;
    this.autoRefreshGeneration = 0;
    this.autoRefreshStarted = false;
    this.lastCompletedRefreshAt = null;
    this.pausedForActiveSessions = false;
    this.activeProviderSessionPresent = false;
    this.refreshPromise = null;
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
    this.duplicateClaudeTokenAccountIds = new Set();
    this.claudeWeeklyFingerprints = new Map();
    // Issue #108: Codex twin of the Claude pair above. Values are
    // `tokens.account_id` identifiers read from each profile's auth.json —
    // identifiers only, never token values — remembered until fresh readable
    // evidence replaces them (same PR #77 evidence-memory rule).
    this.duplicateCodexTokenAccountIds = new Set();
    this.codexAccountIdentifiers = new Map();
    this.toolUpdatePromises = new Map();
    this.realpath = options.realpath || fs.promises.realpath;
    this.platform = options.platform || process.platform;
    this.claudeSecureStorage = { value: null, status: this.platform === 'darwin' ? 'inactive' : 'not-applicable' };
    this.claudeSecureStorageSupported = null;
  }

  startAutoRefresh() {
    if (this.autoRefreshStarted) return;
    this.autoRefreshStarted = true;
    // Local, credential-free startup migration for pre-#62 Claude rows.
    void this.backfillClaudeIdentities();
    const generation = ++this.autoRefreshGeneration;
    const settings = this.store.getSettings();
    if (settings.autoRefreshEnabled) {
      if (this.lastCompletedRefreshAt == null) this.lastCompletedRefreshAt = this.now();
      this.armAutoRefresh(this.autoRefreshInitialDelayMs, generation);
    }
  }

  stopAutoRefresh() {
    this.autoRefreshStarted = false;
    this.autoRefreshGeneration += 1;
    if (this.autoRefreshTimer != null) this.clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
    this.pausedForActiveSessions = false;
    this.activeProviderSessionPresent = false;
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

      this.runAutoRefreshTick(settings, generation).catch((error) => {
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
      await this.refreshAll();
    } finally {
      this.lastCompletedRefreshAt = this.now();
    }
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
  // them (success clears; failure records message + timestamp). The tool
  // probe payload caches provider-level authState for up to toolProbeTtlMs;
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
    const accounts = this.store.listAccounts().filter((account) => account.provider === 'claude' && account.enabled);
    const refreshedSnapshots = new Map();
    const results = await Promise.all(accounts.map(async (account) => {
      await this.refreshClaudeProfileMetadata(account).catch(() => {});
      try {
        const snapshots = await this.fetchClaude({ claudeConfigDir: account.profileRef, profilesDir: this.claudeProfilesDir });
        for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
        refreshedSnapshots.set(account.id, snapshots);
        return { accountId: account.id, ok: true, snapshotCount: snapshots.length };
      } catch (error) {
        return { accountId: account.id, ok: false, error: error.message };
      }
    }));
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
    this.recordAccountRefreshResults(results);
    return results;
  }

  async refreshClaudeProfileMetadata(account) {
    const [rateLimitTier, profileIdentity] = await Promise.all([
      this.readClaudeTier({ claudeConfigDir: account.profileRef }),
      this.readClaudeIdentity({ claudeConfigDir: account.profileRef }),
    ]);
    // Rebase on the freshest record after the awaits: a reset-identity that
    // landed mid-read must not be undone by saving a pre-reset snapshot.
    const latest = this.store.getAccount(account.id) ?? account;
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
    if (identity === latest.identity && JSON.stringify(metadata) === JSON.stringify(latest.metadata)) return latest;
    return this.store.saveAccount({
      id: latest.id, provider: latest.provider, label: latest.label,
      profileRef: latest.profileRef, identity, color: latest.color,
      enabled: latest.enabled, metadata,
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
    const imported = await this.migrateClaude({ selections, profilesDir: this.claudeProfilesDir });
    const saved = [];
    try {
      for (const profile of imported) {
        if (this.store.findAccount('claude', profile.profileRef)) throw new Error(`Claude profile is already registered: ${profile.profileRef}`);
        let account = this.store.saveAccount({
          provider: 'claude',
          label: profile.label,
          profileRef: profile.profileRef,
          metadata: { migratedFromClaudeSwap: true },
        });
        account = await this.refreshClaudeProfileMetadata(account);
        saved.push(account);
      }
      return saved;
    } catch (error) {
      for (const account of saved) this.store.deleteAccount(account.id);
      for (const profile of imported) await fs.promises.rm(profile.profileRef, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async createClaudeAccount({ label, identity, purpose = '', color, isDefault = false } = {}) {
    if (!label?.trim()) throw new Error('account label is required');
    const profileRef = await this.createClaudeProfile({ profilesDir: this.claudeProfilesDir, profileName: label });
    let account;
    try {
      account = this.store.saveAccount({ provider: 'claude', label, identity, purpose, color, profileRef });
      account = await this.refreshClaudeProfileMetadata(account);
      return isDefault ? this.setDefaultAccount('claude', account.id) : account;
    } catch (error) {
      if (account) this.store.deleteAccount(account.id);
      await fs.promises.rmdir(profileRef).catch(() => {});
      throw error;
    }
  }

  // Issue #8, step 1 mirror of createClaudeAccount: the app supplies
  // provider + label + purpose + color and ModelDeck creates the isolated
  // owner-only CODEX_HOME. Login stays with the provider (step 2).
  async createCodexAccount({ label, identity, purpose = '', color, isDefault = false } = {}) {
    if (!label?.trim()) throw new Error('account label is required');
    const profileRef = await this.createCodexProfile({ profilesDir: this.codexProfilesDir, profileName: label });
    let account;
    try {
      account = this.store.saveAccount({ provider: 'codex', label, identity, purpose, color, profileRef });
      return isDefault ? this.setDefaultAccount('codex', account.id) : account;
    } catch (error) {
      if (account) this.store.deleteAccount(account.id);
      await fs.promises.rmdir(profileRef).catch(() => {});
      throw error;
    }
  }

  // Daemon-owned metadata keys are written by verify/refresh, never by API
  // callers — an edit that re-sends a stale metadata object must not clobber
  // them (CodeRabbit, PR #29).
  static DAEMON_OWNED_METADATA = ['claudePlan', 'claudeAccountUuid', 'identitySource', 'codexPlan', 'migratedFromClaudeSwap'];

  preserveDaemonMetadata(input) {
    if (!input?.id || input.metadata == null) return input;
    const existing = this.store.getAccount(input.id);
    if (!existing?.metadata) return input;
    const kept = {};
    for (const key of ModelDeckService.DAEMON_OWNED_METADATA) {
      if (existing.metadata[key] !== undefined) kept[key] = existing.metadata[key];
    }
    return { ...input, metadata: { ...input.metadata, ...kept } };
  }

  async saveAccount(input) {
    input = this.preserveDaemonMetadata(input);
    if (input.provider === 'codex') {
      if (!input.profileRef) return this.createCodexAccount(input);
      // Caller-supplied Codex homes get the same containment contract as
      // Claude: they must live inside ModelDeck's managed profiles directory.
      const profileRef = await validateCodexProfileHome({ profileRef: input.profileRef, profilesDir: this.codexProfilesDir });
      const account = this.store.saveAccount({ ...input, profileRef });
      if (input.isDefault) this.invalidateToolProbe();
      return account;
    }
    if (input.provider !== 'claude') {
      const account = this.store.saveAccount(input);
      if (input.isDefault) this.invalidateToolProbe();
      return account;
    }
    if (!input.profileRef) return this.createClaudeAccount(input);
    const profileRef = await validateClaudeProfileHome({ profileRef: input.profileRef, profilesDir: this.claudeProfilesDir });
    let account = this.store.saveAccount({ ...input, profileRef });
    account = await this.refreshClaudeProfileMetadata(account);
    if (input.isDefault) this.invalidateToolProbe();
    return account;
  }

  // Issue #99: which sign-in mechanism actually steers where the Claude
  // credential lands, decided from the installed CLI version.
  //   'config-dir'  (< 2.1.216): CLAUDE_CONFIG_DIR +
  //     CLAUDE_SECURESTORAGE_CONFIG_DIR scope the Keychain entry, so an
  //     env-scoped login lands in the profile's own slot.
  //   'activation'  (>= 2.1.216): credentials key off realpath(~/.claude)
  //     regardless of environment. The only known-good steering (validated
  //     2026-07-21) is activating the target profile FIRST — so ~/.claude
  //     resolves to it — then running a plain `claude /login`. A fake-HOME
  //     variant does NOT work: claude treats it as a fresh install and
  //     resets the profile's .claude.json.
  // An undetectable version fails toward 'activation': that flow steers
  // correctly on every known version, while 'config-dir' silently
  // cross-wires accounts on current CLIs.
  async claudeLoginFlow() {
    let version;
    try {
      version = await this.installedToolVersion(this.claudePath);
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
      const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
      const flow = await this.claudeLoginFlow();
      if (flow === 'activation') {
        // Issue #99 fix direction 1: the caller must activate this account
        // first (requiresActivation) so ~/.claude resolves to the target
        // profile, then run the plain login below — no env override, because
        // the environment no longer steers credential storage. Verify the
        // identity while the target is still active; only then optionally
        // restore the previously active account.
        return {
          provider: 'claude',
          account,
          flow,
          requiresActivation: true,
          command: this.claudePath,
          args: ['/login'],
          env: {},
          preview: `${shellQuote(this.claudePath)} /login`,
        };
      }
      return {
        provider: 'claude',
        account,
        flow,
        requiresActivation: false,
        command: this.claudePath,
        args: ['auth', 'login'],
        // Issue #66: both vars pinned to the same canonical profile path so
        // the login session cannot pair one profile's storage with another's
        // credential scope.
        env: { CLAUDE_CONFIG_DIR: profileRef, CLAUDE_SECURESTORAGE_CONFIG_DIR: profileRef },
        preview: `CLAUDE_CONFIG_DIR=${shellQuote(profileRef)} CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellQuote(profileRef)} ${shellQuote(this.claudePath)} auth login`,
      };
    }
    const profileRef = managedCodexProfile(account.profileRef, this.codexProfilesDir);
    return {
      provider: 'codex',
      account,
      command: this.codexPath,
      args: ['login'],
      env: { CODEX_HOME: profileRef },
      preview: `CODEX_HOME=${shellQuote(profileRef)} ${shellQuote(this.codexPath)} login`,
    };
  }

  // Issue #8, step 3: read back the authenticated identity via the provider's
  // own status command (never a logout, never credential files) and persist
  // it on the account so the roster can show "Signed in as …".
  async verifyAccount(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    const result = account.provider === 'claude'
      ? await this.readClaudeAuth({ claudePath: this.claudePath, claudeConfigDir: account.profileRef, profilesDir: this.claudeProfilesDir })
      : await this.readCodexAuth({ binary: this.codexPath, codexHome: account.profileRef, profilesDir: this.codexProfilesDir });
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
    let saved = account;
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
    if (identityChanged || planChanged) {
      const metadata = { ...account.metadata };
      if (claudePlan) metadata.claudePlan = claudePlan;
      if (account.provider === 'codex') {
        if (codexPlan) metadata.codexPlan = codexPlan;
        else delete metadata.codexPlan;
      }
      saved = this.store.saveAccount({
        id: account.id,
        provider: account.provider,
        label: account.label,
        profileRef: account.profileRef,
        identity: identityChanged ? result.identity : account.identity,
        color: account.color,
        enabled: account.enabled,
        metadata: planChanged ? metadata : account.metadata,
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
    };
  }

  async refreshCodex() {
    const accounts = this.store.listAccounts().filter((account) => account.provider === 'codex' && account.enabled);
    const results = await Promise.all(accounts.map(async (account) => {
      await this.refreshCodexPlanTier(account).catch(() => {});
      await this.refreshCodexAccountIdentifier(account).catch(() => {});
      try {
        const snapshots = await this.fetchCodex({ binary: this.codexPath, codexHome: account.profileRef });
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
    const next = codexPlanMetadata(plan?.planType);
    const current = account.metadata?.codexPlan || null;
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const metadata = { ...account.metadata };
    if (next) metadata.codexPlan = next;
    else delete metadata.codexPlan;
    this.store.saveAccount({
      id: account.id,
      provider: account.provider,
      label: account.label,
      profileRef: account.profileRef,
      identity: account.identity,
      color: account.color,
      enabled: account.enabled,
      metadata,
    });
  }

  async refreshAll() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const result = { claude: null, codex: null, checkedAt: new Date().toISOString() };
      try {
        result.claude = { ok: true, profiles: await this.refreshClaude() };
        if (result.claude.profiles.some((item) => !item.ok)) result.claude.ok = false;
      }
      catch (error) { result.claude = { ok: false, error: error.message }; }
      result.codex = { ok: true, profiles: await this.refreshCodex() };
      if (result.codex.profiles.some((item) => !item.ok)) result.codex.ok = false;
      return result;
    })();
    try { return await this.refreshPromise; }
    finally {
      this.refreshPromise = null;
      this.lastCompletedRefreshAt = this.now();
    }
  }

  async activateAccount(id) {
    const account = this.store.getAccount(id);
    if (!account) throw new Error('account not found');
    if (!account.enabled) throw new Error('account is disabled');

    let warnings = [];
    if (account.provider === 'claude') {
      // Pre-flip honesty (issue #66): sessions launched before the pinned
      // env existed still resolve storage through the ~/.claude symlink and
      // can silently lose transcript history when it flips. Detect them
      // before the flip so the response can say so; best-effort only —
      // detection failure must never block activation.
      warnings = await this.claudeRunningSessionWarnings();
      await this.activateClaude({ profileRef: account.profileRef, activeLink: this.claudeActiveLink, profilesDir: this.claudeProfilesDir });
      await this.scopeClaudeSecureStorage(account.profileRef);
    } else {
      if (!this.codexActiveLink) throw new Error('Codex active profile link is not configured');
      await this.activateCodexProfile(account.profileRef);
    }

    return { account: this.setDefaultAccount(account.provider, account.id), warnings };
  }

  // Issue #66: counts running `claude` processes at activation time. Pinned
  // sessions (launched with CLAUDE_CONFIG_DIR exported) are insulated from
  // the flip, but the daemon cannot distinguish pinned from unpinned
  // processes cheaply, so the warning is phrased conditionally.
  async claudeRunningSessionWarnings() {
    let running = 0;
    try {
      running = (await this.listProviderProcesses()).filter((command) => command === 'claude').length;
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

  async scopeClaudeSecureStorage(profileRef) {
    const value = await fs.promises.realpath(profileRef);
    // Issue #66: refresh the shell pin first so new terminal sessions export
    // CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR (always the same
    // string) resolved from ModelDeck's records at activation time — never a
    // launch-time readlink of the symlink. Failure degrades verification but
    // never blocks the home switch.
    let shellPinError = null;
    try {
      await this.writeClaudeShellEnvFile(value);
    } catch (error) {
      shellPinError = errorMessage(error);
    }
    if (this.platform !== 'darwin') {
      this.claudeSecureStorage = { value, status: 'not-applicable', ...(shellPinError ? { error: shellPinError } : {}) };
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
  async writeClaudeShellEnvFile(profileRealPath) {
    const file = this.claudeShellEnvFile;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.modeldeck-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(temporary, claudePinnedEnvFileContent(profileRealPath), { mode: 0o600 });
      await fs.promises.rename(temporary, file);
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  setDefaultAccount(provider, accountId) {
    const account = this.store.setDefault(provider, accountId);
    this.invalidateToolProbe();
    return account;
  }

  deleteAccount(accountId) {
    const account = this.store.getAccount(accountId);
    const deleted = this.store.deleteAccount(accountId);
    if (deleted) this.accountRefreshErrors.delete(accountId);
    if (deleted && account?.isDefault) this.invalidateToolProbe();
    return deleted;
  }

  async activateCodexProfile(profileRef) {
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
    const result = await this.exec(binary, ['--version'], { timeout: 10_000, maxBuffer: 1_000_000 });
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
    return 'unknown';
  }

  async accountsWithAuthState(accounts = this.store.listAccounts()) {
    return Promise.all(accounts.map(async (account) => {
      // Issue #89: surface the per-account refresh failure refreshAll used
      // to drop, so the deck and Settings can render honest staleness.
      const lastRefreshError = this.accountRefreshErrors.get(account.id) || null;
      return {
        ...account,
        authState: await this.accountAuthState(account),
        ...(lastRefreshError ? { lastRefreshError } : {}),
      };
    }));
  }

  async providerActivationState(provider, activeLink, accounts) {
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
    return {
      ...value,
      accounts,
      activation: { claude: claudeActivation, codex: codexActivation },
      claudeSecureStorage,
      scheduler: this.refreshSchedulerStatus(),
    };
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
      // Issue #99 (natural fallout of the same version read): which
      // mechanism scopes CREDENTIAL storage on the installed CLI.
      // 'resolved-home' means env-scoped sign-ins are broken and login
      // guidance must be activation-driven; null when not installed.
      claude.credentialScoping = claude.version
        ? (compareSemver(claude.version, CLAUDE_RESOLVED_HOME_CREDENTIALS_MIN_VERSION) >= 0
          ? 'resolved-home'
          : 'config-dir')
        : null;
      const value = { tools: { claude, codex }, checkedAt: new Date(this.now()).toISOString() };
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
    const result = await this.exec('/usr/bin/which', [binary], { timeout: 10_000, maxBuffer: 65_536 });
    const resolved = String(result?.stdout ?? result).trim().split(/\r?\n/, 1)[0];
    if (!resolved) throw new Error(`${binary} is not installed`);
    return resolved;
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
    return evaluateWorstCapacity(this.store.latestUsage(), this.store.listAccounts(), {
      thresholdPercent: settings.notificationThresholdPercent,
      criticalPercent: options.criticalPercent ?? 10,
      now: options.now ?? this.now(),
    });
  }

  launchSpec(provider, projectPath, extraArgs = []) {
    if (!['claude', 'codex'].includes(provider)) throw new Error('provider must be claude or codex');
    const resolvedPath = path.resolve(projectPath || process.cwd());
    const { project, account } = accountFor(this.store, provider, resolvedPath);
    if (!account) throw new Error(`no enabled ${provider} account is mapped or set as default`);
    const cwd = project?.path || resolvedPath;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`launch directory does not exist: ${cwd}`);

    if (provider === 'claude') {
      const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
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
        preview: `cd ${shellQuote(cwd)} && CLAUDE_CONFIG_DIR=${shellQuote(profileRef)} CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellQuote(profileRef)} ${shellQuote(this.claudePath)}${extraArgs.length ? ` ${extraArgs.map(shellQuote).join(' ')}` : ''}`,
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
