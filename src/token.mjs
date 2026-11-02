import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { SECRETS_DIR } from './paths.mjs';
import { readSecretFile } from './secret-file.mjs';

export const KEYCHAIN_SERVICE = 'modeldeck';
export const KEYCHAIN_ACCOUNT = 'mutation-token';

export const MUTATION_TOKEN_FILE = path.join(SECRETS_DIR, KEYCHAIN_ACCOUNT);

/// Off macOS the token lives in an owner-only file (decision 0046). An unsafe
/// file is refused with one stderr line naming the problem, and the daemon
/// falls back to an ephemeral token, so mutations fail closed.
export function secretFileLookup({ file = MUTATION_TOKEN_FILE, read = readSecretFile, warn = console.error } = {}) {
  try {
    return read(file);
  } catch (error) {
    warn(`ModelDeck: ignoring the mutation token file: ${error.message}`);
    return null;
  }
}

function keychainLookup() {
  if (process.platform !== 'darwin') return secretFileLookup();
  try {
    const value = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the mutation token used to authorize non-GET API requests.
 *
 * Resolution order:
 *   1. Explicit `token` option (used by embedding code/tests).
 *   2. `MODELDECK_MUTATION_TOKEN` environment variable — documented fallback
 *      for tests and CI; never put real production tokens in plaintext env files.
 *   3. macOS Keychain generic password (service `modeldeck`, account
 *      `mutation-token`) — the durable production source. Elsewhere, the
 *      owner-only file `~/.config/modeldeck/mutation-token`
 *      (decision 0046), reported as source 'file'. Both are managed with
 *      `scripts/set-mutation-token.sh`.
 *   4. A random per-process token. The server still works, but the token does
 *      not survive restarts; production installs should use the Keychain.
 *
 * Set `MODELDECK_SKIP_KEYCHAIN=1` to disable the Keychain lookup (hermetic tests).
 * Returns `{ token, source }` where source is one of
 * 'option' | 'env' | 'keychain' | 'file' | 'ephemeral'. The token value itself must
 * never be logged.
 */
export function resolveMutationToken({
  token, env = process.env, lookup = keychainLookup, platform = process.platform,
} = {}) {
  if (token) return { token, source: 'option' };
  const fromEnv = env.MODELDECK_MUTATION_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  if (env.MODELDECK_SKIP_KEYCHAIN !== '1') {
    const fromKeychain = lookup();
    if (fromKeychain) return { token: fromKeychain, source: platform === 'darwin' ? 'keychain' : 'file' };
  }
  return { token: crypto.randomBytes(32).toString('base64url'), source: 'ephemeral' };
}
