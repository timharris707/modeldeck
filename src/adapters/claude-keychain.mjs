import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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
    try {
      await runSecurity('/usr/bin/security', [
        'find-generic-password',
        '-s', claudeCredentialServiceName(claudeConfigDir, homeDirectory),
        '-a', username,
      ], {
        env: { USER: username },
        timeout: 5_000,
        maxBuffer: 65_536,
      });
      return true;
    } catch {
      // Legacy/non-Keychain profiles retain their owner-only credential file.
    }
  }

  try {
    const credentialStat = await lstat(path.join(claudeConfigDir, '.credentials.json'));
    return credentialStat.isFile() && !credentialStat.isSymbolicLink();
  } catch {
    return false;
  }
}
