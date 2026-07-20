import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractIdentity } from './identity.mjs';
import { claudeCredentialsPresent } from './claude-keychain.mjs';
import { createProviderProfileHelpers, activeLinkBlockedError } from './provider-profile.mjs';

const execFileAsync = promisify(execFile);
const usageProbePath = fileURLToPath(new URL('./claude-usage-probe.mjs', import.meta.url));
const claudeProfile = createProviderProfileHelpers({
  envVar: 'CLAUDE_CONFIG_DIR',
  envRequiredError: 'CLAUDE_CONFIG_DIR is required',
  invalidProfileNameError: 'migration profile name is invalid',
  profilesDirRequiredError: 'ModelDeck Claude profiles directory is required',
  profilesDirMissingLabel: 'ModelDeck Claude profiles directory',
  profilesDirLabel: 'ModelDeck Claude profiles directory',
  profileHomeRequiredError: 'Claude profile home is required',
  profileHomeLabel: 'Claude profile home',
  destinationExistsLabel: 'Claude profile destination already exists',
  containmentErrorPrefix: "Claude profile home must be inside ModelDeck's profiles directory",
});
function errorMessage(error) {
  return error?.stderr?.trim() || error?.message || String(error);
}

// /api/oauth/usage rate-limits generic user agents into a stricter 429
// bucket; requests must identify as claude-code/<version>.
export const CLAUDE_CODE_UA_FALLBACK_VERSION = '2.1.83';
let cachedClaudeCodeVersion;
export async function resolveClaudeCodeVersion(run = execFileAsync) {
  if (cachedClaudeCodeVersion !== undefined) return cachedClaudeCodeVersion;
  try {
    const result = await run('claude', ['--version'], { timeout: 3_000, maxBuffer: 65_536 });
    cachedClaudeCodeVersion = String(result?.stdout ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    cachedClaudeCodeVersion = null;
  }
  return cachedClaudeCodeVersion;
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function resetIso(window) {
  const value = window?.resetsAt ?? window?.resets_at ?? window?.resetAt ?? window?.reset_at;
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function usedPercent(window) {
  if (!window || typeof window !== 'object') return null;
  return number(window.usedPercent ?? window.used_percent ?? window.utilization ?? window.percent ?? window.pct ?? window.usage);
}

function windowLabel(key, window) {
  const label = window?.label ?? window?.displayName ?? window?.display_name ?? window?.name ?? key;
  const normalized = String(label).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (['five_hour', '5_hour', 'session', 'primary'].includes(normalized)) return '5-hour';
  if (['seven_day', '7_day', 'weekly', 'week', 'secondary'].includes(normalized)) return 'weekly';
  const model = normalized.match(/(?:seven_day|7_day|weekly)_(.+)|(.+)_(?:seven_day|7_day|weekly)/)?.slice(1).find(Boolean);
  if (model) return `${model[0].toUpperCase()}${model.slice(1)} weekly`;
  return String(label).replaceAll('_', ' ');
}

// Issue #28: the payload's `limits` array carries kind-tagged entries —
// "session" (5-hour), "weekly_all", and model-scoped "weekly_scoped" whose
// model comes from scope.model.display_name. The scoped weekly is often the
// user's binding constraint, so it must not be dropped. Model names are
// never hardcoded — whatever the payload says is displayed.
function limitEntryScope(entry) {
  const kind = String(entry.kind ?? entry.group ?? '').toLowerCase();
  if (kind === 'weekly_scoped') {
    const model = entry.scope?.model?.display_name ?? entry.scope?.model?.displayName ?? entry.scope?.model?.id;
    if (model == null || model === '') return null;
    const label = String(model);
    return `${label[0].toUpperCase()}${label.slice(1)} weekly`;
  }
  if (['session', 'five_hour', '5_hour', 'primary'].includes(kind)) return '5-hour';
  if (['weekly_all', 'weekly', 'seven_day', '7_day', 'week', 'secondary'].includes(kind)) return 'weekly';
  return kind ? kind.replaceAll('_', ' ') : null;
}

function parseLimitEntries(limits, snapshots) {
  for (const entry of limits) {
    if (!entry || typeof entry !== 'object') continue;
    const percent = number(entry.percent) ?? usedPercent(entry);
    if (percent == null) continue;
    const scope = limitEntryScope(entry);
    if (!scope) continue;
    snapshots.push({
      scope,
      usedPercent: percent,
      resetsAt: resetIso(entry),
      source: 'claude-oauth-api',
      detail: {},
    });
  }
}

function unwrapUsage(payload) {
  if (typeof payload !== 'string') return payload;
  const trimmed = payload.trim();
  if (!trimmed) throw new Error('Claude usage output was empty');
  try { return JSON.parse(trimmed); }
  catch { throw new Error('Claude usage output was not valid JSON'); }
}

export function parseClaudeUsage(payload) {
  const data = unwrapUsage(payload);
  const usage = data?.usage ?? data?.rateLimits ?? data?.rate_limits ?? data;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('Claude usage output did not contain usage windows');
  }
  const ignored = new Set(['extra_usage', 'extraUsage', 'plan', 'organization', 'account', 'status', 'limits']);
  const snapshots = [];
  const limits = [data?.limits, usage?.limits].find(Array.isArray);
  if (limits) parseLimitEntries(limits, snapshots);
  for (const [key, window] of Object.entries(usage)) {
    if (ignored.has(key) || !window || typeof window !== 'object') continue;
    if (key === 'weekly_scoped' || key === 'weeklyScoped') {
      const rows = Array.isArray(window)
        ? window
        : Object.entries(window).map(([name, value]) => ({ name, ...value }));
      for (const row of rows) {
        const percent = usedPercent(row);
        const name = row.model ?? row.name ?? row.label ?? row.display_name ?? row.displayName;
        if (percent == null || !name) continue;
        const label = String(name);
        snapshots.push({
          scope: `${label[0].toUpperCase()}${label.slice(1)} weekly`,
          usedPercent: percent,
          resetsAt: resetIso(row),
          source: 'claude-oauth-api',
          detail: {},
        });
      }
      continue;
    }
    const percent = usedPercent(window);
    if (percent == null) continue;
    snapshots.push({
      scope: windowLabel(key, window),
      usedPercent: percent,
      resetsAt: resetIso(window),
      source: 'claude-oauth-api',
      detail: {},
    });
  }
  const unique = snapshots.filter((snapshot, index, all) => all.findIndex((item) => item.scope === snapshot.scope) === index);
  if (!unique.length) throw new Error('Claude usage output did not contain usage windows');
  return unique;
}

const assertOwnerOnlyDirectory = claudeProfile.assertOwnerOnlyDirectory;

export function claudeProfileEnv(claudeConfigDir, sourceEnv = process.env) {
  return claudeProfile.profileEnv(claudeConfigDir, sourceEnv);
}

export async function validateClaudeProfileHome({ profileRef, profilesDir } = {}) {
  return claudeProfile.validateProfileHome({ profileRef, profilesDir });
}

export async function fetchClaudeUsage({
  claudeConfigDir,
  profilesDir,
  timeoutMs = 20_000,
  run = execFileAsync,
  lstat = fs.promises.lstat,
  platform = process.platform,
} = {}) {
  if (!claudeConfigDir) throw new Error('CLAUDE_CONFIG_DIR is required');
  if (profilesDir) await validateClaudeProfileHome({ profileRef: claudeConfigDir, profilesDir });
  else await assertOwnerOnlyDirectory(claudeConfigDir, 'Claude profile home');
  const credentialsPath = path.join(claudeConfigDir, '.credentials.json');
  let credentialStat = null;
  try {
    credentialStat = await lstat(credentialsPath);
  } catch (error) {
    if (platform === 'darwin') {
      // Native Claude profiles store credentials in the login Keychain. The
      // isolated usage probe resolves that item without exposing it here.
    } else if (error.code === 'ENOENT') {
      throw new Error('Claude profile does not contain stored OAuth credentials; sign in explicitly before refreshing');
    } else {
      throw error;
    }
  }
  if (credentialStat && (!credentialStat.isFile() || credentialStat.isSymbolicLink())) {
    throw new Error('Claude profile credentials must be a regular file inside the selected profile home');
  }
  let result;
  try {
    const env = claudeProfileEnv(claudeConfigDir);
    env.MODELDECK_CLAUDE_UA_VERSION = (await resolveClaudeCodeVersion()) ?? CLAUDE_CODE_UA_FALLBACK_VERSION;
    result = await run(process.execPath, [usageProbePath], {
      env,
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
    });
  } catch (error) {
    throw new Error(`Claude usage refresh failed: ${errorMessage(error)}`);
  }
  return parseClaudeUsage(result?.stdout ?? result);
}

async function lstatOrNull(target) {
  try { return await fs.promises.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function activateClaudeProfile({ profileRef, activeLink, profilesDir } = {}) {
  if (!profileRef) throw new Error('Claude profile home is required');
  if (!activeLink) throw new Error('Claude active profile link is not configured');
  if (profilesDir) await validateClaudeProfileHome({ profileRef, profilesDir });
  else await assertOwnerOnlyDirectory(profileRef, 'Claude profile home');

  const activeStat = await lstatOrNull(activeLink);
  if (activeStat && !activeStat.isSymbolicLink()) {
    throw activeLinkBlockedError('Claude', activeLink);
  }

  await fs.promises.mkdir(path.dirname(activeLink), { recursive: true });
  const temporaryLink = path.join(
    path.dirname(activeLink),
    `.${path.basename(activeLink)}.modeldeck-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await fs.promises.symlink(await fs.promises.realpath(profileRef), temporaryLink, 'dir');
    await fs.promises.rename(temporaryLink, activeLink);
  } catch (error) {
    await fs.promises.unlink(temporaryLink).catch(() => {});
    throw new Error(`Claude account activation failed: ${errorMessage(error)}`);
  }
}

const safeProfileName = claudeProfile.safeProfileName;

export async function createClaudeProfileHome({ profilesDir, profileName } = {}) {
  return claudeProfile.createProfileHome({ profilesDir, profileName });
}

async function rejectSymlinks(directory) {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`approved cswap profile home contains a symbolic link: ${entryPath}`);
    if (entry.isDirectory()) await rejectSymlinks(entryPath);
  }
}

async function enforceOwnerOnlyTree(directory) {
  await fs.promises.chmod(directory, 0o700);
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await enforceOwnerOnlyTree(entryPath);
    else await fs.promises.chmod(entryPath, 0o600);
  }
}

async function copyApprovedHome(sourceDir, destination) {
  const source = await fs.promises.lstat(sourceDir);
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error(`approved cswap profile home must be a real directory: ${sourceDir}`);
  await rejectSymlinks(sourceDir);
  await fs.promises.cp(sourceDir, destination, { recursive: true, dereference: false, errorOnExist: true, force: false });
  await rejectSymlinks(destination);
  // cp preserves source mode bits; a permissive legacy home must not leak
  // group/world access into the ModelDeck-owned profile.
  await enforceOwnerOnlyTree(destination);
}

export async function importClaudeSwapProfiles({ selections, profilesDir } = {}) {
  if (!Array.isArray(selections) || !selections.length) throw new Error('at least one user-approved cswap profile home is required');
  if (!profilesDir) throw new Error('ModelDeck Claude profiles directory is required');
  await fs.promises.mkdir(profilesDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(profilesDir, 0o700);
  const root = await fs.promises.realpath(profilesDir);
  const names = new Set();
  const planned = selections.map((selection) => {
    if (!selection?.sourceDir) throw new Error('each migration selection requires a sourceDir');
    const name = safeProfileName(selection.profileName ?? selection.label);
    if (names.has(name)) throw new Error(`duplicate migration profile name: ${name}`);
    names.add(name);
    return { selection, name, destination: path.join(root, name) };
  });
  for (const item of planned) {
    if (await lstatOrNull(item.destination)) throw new Error(`Claude profile destination already exists: ${item.destination}`);
  }

  const imported = [];
  try {
    for (const item of planned) {
      const temporary = path.join(root, `.${item.name}.modeldeck-import-${crypto.randomUUID()}`);
      try {
        await copyApprovedHome(path.resolve(item.selection.sourceDir), temporary);
        await fs.promises.rename(temporary, item.destination);
      } catch (error) {
        await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      imported.push({
        label: item.selection.label || item.name,
        profileRef: item.destination,
        sourceDir: path.resolve(item.selection.sourceDir),
      });
    }
    return imported;
  } catch (error) {
    for (const item of imported) await fs.promises.rm(item.profileRef, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Claude profile migration failed: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Issue #8 — add-account flow, step 3: read back the authenticated identity
// from the provider's own status command. This extends the #17 adapter seam
// without touching its core logic. Known pitfall (docs/HANDOFF.md /
// docs/ACCOUNT_ONBOARDING.md): NEVER run `claude auth logout` between
// captures — this module only ever invokes `auth status`.

/// Issue #26 (Claude half) — plan/tier facts captured with zero extra
/// provider calls: `subscriptionType` from the `claude auth status` JSON
/// output and `organizationRateLimitTier` from the profile's local
/// `.claude.json` (`oauthAccount.organizationRateLimitTier`, e.g.
/// "default_claude_max_20x"). Both best-effort; absent fields stay null.
export function extractClaudeSubscriptionType(output) {
  const text = String(output ?? '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  const search = (value, depth = 0) => {
    if (depth > 4 || value == null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = search(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const direct = value.subscriptionType ?? value.subscription_type;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    for (const item of Object.values(value)) {
      const found = search(item, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return search(parsed);
}

/// Reads `oauthAccount.organizationRateLimitTier` from the profile's
/// `.claude.json`. Local file read only — never a provider call, never the
/// credentials file. Returns null on any miss (absent file, bad JSON,
/// missing field).
export async function readClaudeRateLimitTier({ claudeConfigDir, readFile = fs.promises.readFile } = {}) {
  if (!claudeConfigDir) return null;
  let parsed;
  try { parsed = JSON.parse(await readFile(path.join(claudeConfigDir, '.claude.json'), 'utf8')); }
  catch { return null; }
  const tier = parsed?.oauthAccount?.organizationRateLimitTier;
  return typeof tier === 'string' && tier.trim() ? tier.trim() : null;
}

/// `claude auth status` under the profile's CLAUDE_CONFIG_DIR.
/// `authenticated` is true when the status command succeeds; if the command
/// fails for a reason other than a missing CLI, we fall back to credential
/// presence. On macOS that is a metadata-only Keychain lookup: no credential
/// value is requested, read, copied, or logged. The result also carries
/// `plan` (subscriptionType + rateLimitTier) for issue #26's tier line.
export async function readClaudeAuthStatus({
  claudePath = 'claude',
  claudeConfigDir,
  profilesDir,
  timeoutMs = 20_000,
  run = execFileAsync,
  lstat = fs.promises.lstat,
  securityRun = execFileAsync,
  platform = process.platform,
  homeDirectory = os.homedir(),
  userInfo = os.userInfo,
  readFile = fs.promises.readFile,
} = {}) {
  if (!claudeConfigDir) throw new Error('CLAUDE_CONFIG_DIR is required');
  if (profilesDir) await validateClaudeProfileHome({ profileRef: claudeConfigDir, profilesDir });
  else await assertOwnerOnlyDirectory(claudeConfigDir, 'Claude profile home');

  const username = userInfo().username;
  const credentialsPresent = await claudeCredentialsPresent({
    claudeConfigDir,
    platform,
    homeDirectory,
    userInfo,
    lstat,
    runSecurity: securityRun,
  });

  const rateLimitTier = await readClaudeRateLimitTier({ claudeConfigDir, readFile });
  try {
    const env = claudeProfileEnv(claudeConfigDir);
    // Native Claude resolves the Keychain item's account from USER. launchd
    // does not supply it, and the normal adapter allowlist intentionally
    // strips ambient identity variables, so restore only the OS username.
    env.USER = username;
    const result = await run(claudePath, ['auth', 'status'], {
      env,
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
    });
    const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
    return {
      authenticated: true,
      identity: extractIdentity(output),
      plan: { subscriptionType: extractClaudeSubscriptionType(result?.stdout ?? ''), rateLimitTier },
    };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Claude CLI is not installed');
    return {
      authenticated: credentialsPresent,
      identity: extractIdentity(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`),
      plan: { subscriptionType: extractClaudeSubscriptionType(error?.stdout ?? ''), rateLimitTier },
      detail: error?.stderr?.trim() || error?.message || null,
    };
  }
}
