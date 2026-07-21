import crypto from 'node:crypto';
import { activeLinkBlockedError } from './adapters/provider-profile.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  activateClaudeProfile,
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
  readCodexLoginStatus,
  readCodexPlan,
  validateCodexProfileHome,
} from './adapters/codex.mjs';
import { evaluateWorstCapacity } from './capacity.mjs';
import { scanProjectRoot } from './projects.mjs';

const execFileAsync = promisify(execFile);

// Active sessions throttle scheduled polling, but never for long enough to
// let a continuously open provider session make the deck silently stale.
const ACTIVE_SESSION_REFRESH_CAP_MS = 30 * 60_000;

// Claude Code 2.1.215 is the first version verified against the undocumented
// CLAUDE_SECURESTORAGE_CONFIG_DIR scoped-Keychain behavior.
export const CLAUDE_SECURESTORAGE_MIN_VERSION = '2.1.215';

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
    if (!settings.autoRefreshEnabled || !settings.pauseWhileActive) {
      this.pausedForActiveSessions = false;
      this.activeProviderSessionPresent = false;
    }
    if (settings.autoRefreshEnabled) {
      if (this.lastCompletedRefreshAt == null) this.lastCompletedRefreshAt = this.now();
      this.armAutoRefresh(this.autoRefreshDelay(settings), generation);
    }
  }

  autoRefreshDelay(settings) {
    const intervalMs = settings.autoRefreshIntervalSeconds * 1_000;
    if (!settings.pauseWhileActive || !this.activeProviderSessionPresent) return intervalMs;
    const elapsedSinceRefresh = this.lastCompletedRefreshAt == null
      ? ACTIVE_SESSION_REFRESH_CAP_MS
      : this.now() - this.lastCompletedRefreshAt;
    return Math.min(intervalMs, Math.max(0, ACTIVE_SESSION_REFRESH_CAP_MS - elapsedSinceRefresh));
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
    if (settings.pauseWhileActive) {
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

    const elapsedSinceRefresh = this.lastCompletedRefreshAt == null
      ? ACTIVE_SESSION_REFRESH_CAP_MS
      : this.now() - this.lastCompletedRefreshAt;
    if (activeSessionPresent && elapsedSinceRefresh < ACTIVE_SESSION_REFRESH_CAP_MS) {
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

  async refreshClaude() {
    const accounts = this.store.listAccounts().filter((account) => account.provider === 'claude' && account.enabled);
    return Promise.all(accounts.map(async (account) => {
      await this.refreshClaudeProfileMetadata(account).catch(() => {});
      try {
        const snapshots = await this.fetchClaude({ claudeConfigDir: account.profileRef, profilesDir: this.claudeProfilesDir });
        for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
        return { accountId: account.id, ok: true, snapshotCount: snapshots.length };
      } catch (error) {
        return { accountId: account.id, ok: false, error: error.message };
      }
    }));
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

  // Issue #8, step 2: the exact provider-owned login command for one account,
  // for the app to run in the user's own terminal. ModelDeck never performs
  // the login itself and never sees credentials. Known pitfall
  // (docs/HANDOFF.md): this must never construct a `logout` invocation.
  loginSpec(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('account not found');
    if (!account.enabled) throw new Error('account is disabled');
    if (account.provider === 'claude') {
      const profileRef = managedClaudeProfile(account.profileRef, this.claudeProfilesDir);
      return {
        provider: 'claude',
        account,
        command: this.claudePath,
        args: ['auth', 'login'],
        env: { CLAUDE_CONFIG_DIR: profileRef },
        preview: `CLAUDE_CONFIG_DIR=${shellQuote(profileRef)} ${shellQuote(this.claudePath)} auth login`,
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
      try {
        const snapshots = await this.fetchCodex({ binary: this.codexPath, codexHome: account.profileRef });
        for (const snapshot of snapshots) this.store.recordUsage(account.id, snapshot);
        return { accountId: account.id, ok: true, snapshotCount: snapshots.length };
      } catch (error) {
        return { accountId: account.id, ok: false, error: error.message };
      }
    }));
    return results;
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

    if (account.provider === 'claude') {
      await this.activateClaude({ profileRef: account.profileRef, activeLink: this.claudeActiveLink, profilesDir: this.claudeProfilesDir });
      await this.scopeClaudeSecureStorage(account.profileRef);
    } else {
      if (!this.codexActiveLink) throw new Error('Codex active profile link is not configured');
      await this.activateCodexProfile(account.profileRef);
    }

    return this.setDefaultAccount(account.provider, account.id);
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
    if (this.platform !== 'darwin') {
      this.claudeSecureStorage = { value, status: 'not-applicable' };
      return this.claudeSecureStorage;
    }
    if (!(await this.claudeScopingSupported())) {
      this.claudeSecureStorage = { value, status: 'unsupported-cli' };
      return this.claudeSecureStorage;
    }
    try {
      await this.exec('/bin/launchctl', ['setenv', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value], { timeout: 5_000, maxBuffer: 65_536 });
      this.claudeSecureStorage = { value, status: 'active' };
    } catch (error) {
      this.claudeSecureStorage = { value, status: 'degraded', error: errorMessage(error) };
    }
    return this.claudeSecureStorage;
  }

  setDefaultAccount(provider, accountId) {
    const account = this.store.setDefault(provider, accountId);
    this.invalidateToolProbe();
    return account;
  }

  deleteAccount(accountId) {
    const account = this.store.getAccount(accountId);
    const deleted = this.store.deleteAccount(accountId);
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
    if (account.provider === 'claude') return this.claudeProfileAuthState(account.profileRef);
    if (account.provider === 'codex') {
      return fs.existsSync(path.join(account.profileRef, 'auth.json')) ? 'ok' : 'signin-required';
    }
    return 'unknown';
  }

  async accountsWithAuthState(accounts = this.store.listAccounts()) {
    return Promise.all(accounts.map(async (account) => ({
      ...account,
      authState: await this.accountAuthState(account),
    })));
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
      scheduler: { pausedForActiveSessions: this.pausedForActiveSessions },
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
        env: { CLAUDE_CONFIG_DIR: profileRef },
        preview: `cd ${shellQuote(cwd)} && CLAUDE_CONFIG_DIR=${shellQuote(profileRef)} ${shellQuote(this.claudePath)}${extraArgs.length ? ` ${extraArgs.map(shellQuote).join(' ')}` : ''}`,
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
