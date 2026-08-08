import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 5_000;
const KEYCHAIN_DIAGNOSTIC_TIMEOUT_MS = 2_000;

export function claudeCredentialServiceName(claudeConfigDir, homeDirectory) {
  if (!claudeConfigDir) throw new Error('CLAUDE_CONFIG_DIR is required');
  if (homeDirectory && path.resolve(claudeConfigDir) === path.resolve(homeDirectory, '.claude')) {
    return CLAUDE_KEYCHAIN_SERVICE;
  }
  // NFC-normalize before hashing so decomposed (NFD) path spellings derive
  // the same service name Claude Code does.
  const suffix = crypto.createHash('sha256').update(claudeConfigDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

function runKeychainServiceLookup({
  service,
  username,
  runSecurity,
  timeoutMs,
}) {
  return runSecurity('/usr/bin/security', [
    'find-generic-password',
    '-s', service,
    '-a', username,
  ], {
    env: { USER: username },
    timeout: timeoutMs,
    maxBuffer: 65_536,
  });
}

async function keychainServicePresent({ service, username, runSecurity }) {
  try {
    await runKeychainServiceLookup({
      service,
      username,
      runSecurity,
      timeoutMs: KEYCHAIN_LOOKUP_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function knownKeychainServicePresence({ service, username, runSecurity }) {
  try {
    await runKeychainServiceLookup({
      service,
      username,
      runSecurity,
      timeoutMs: KEYCHAIN_DIAGNOSTIC_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    // `security` returns errSecItemNotFound (-25300) modulo 256 as exit 44.
    // Only that result proves absence. A timeout, locked Keychain, missing
    // binary, or other failure is unknown and must suppress the diagnosis.
    if (Number(error?.code ?? error?.status) === KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE) return false;
    throw error;
  }
}

// Metadata-only diagnostic for a login that landed in Claude's plain
// Keychain service instead of the profile-hashed service ModelDeck checks.
// Both bounded lookups run concurrently. Neither uses `-w`, so no credential
// value can enter this process; anything other than a proven item-not-found
// result rejects so callers can suppress the best-effort diagnosis.
export async function claudeCredentialKeychainSlotState({
  claudeConfigDir,
  platform = process.platform,
  homeDirectory = os.homedir(),
  userInfo = os.userInfo,
  runSecurity = execFileAsync,
} = {}) {
  if (!claudeConfigDir || platform !== 'darwin') {
    return { profileScoped: false, unscoped: false };
  }

  const username = userInfo().username;
  const profileService = claudeCredentialServiceName(claudeConfigDir, homeDirectory);
  const [profileResult, unscopedResult] = await Promise.allSettled([
    knownKeychainServicePresence({ service: profileService, username, runSecurity }),
    profileService === CLAUDE_KEYCHAIN_SERVICE
      ? Promise.resolve(false)
      : knownKeychainServicePresence({
          service: CLAUDE_KEYCHAIN_SERVICE,
          username,
          runSecurity,
        }),
  ]);
  if (profileResult.status === 'rejected') throw profileResult.reason;
  if (profileResult.value || profileService === CLAUDE_KEYCHAIN_SERVICE) {
    return { profileScoped: profileResult.value, unscoped: false };
  }
  if (unscopedResult.status === 'rejected') throw unscopedResult.reason;
  return {
    profileScoped: false,
    unscoped: unscopedResult.value,
  };
}

// Metadata-only credential presence check. The Keychain lookup deliberately
// omits `-w`, so credential values can never enter this process. Claude Code
// keys items by the OS username; launchd may omit USER, so restore only that
// identity variable for `security` as the authenticated-status path does.
export async function claudeCredentialsPresent({
  claudeConfigDir,
  platform = process.platform,
  homeDirectory = os.homedir(),
  userInfo = os.userInfo,
  lstat = fs.promises.lstat,
  runSecurity = execFileAsync,
} = {}) {
  if (!claudeConfigDir) return false;

  if (platform === 'darwin') {
    const username = userInfo().username;
    if (await keychainServicePresent({
      service: claudeCredentialServiceName(claudeConfigDir, homeDirectory),
      username,
      runSecurity,
    })) return true;
    // Legacy/non-Keychain profiles retain their owner-only credential file.
  }

  try {
    const credentialStat = await lstat(path.join(claudeConfigDir, '.credentials.json'));
    return credentialStat.isFile() && !credentialStat.isSymbolicLink();
  } catch {
    return false;
  }
}
