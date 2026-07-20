import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'modeldeck';
export const KEYCHAIN_ACCOUNT = 'mutation-token';

function keychainLookup() {
  if (process.platform !== 'darwin') return null;
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
 *      `mutation-token`) — the durable production source. Managed with
 *      `scripts/set-mutation-token.sh`.
 *   4. A random per-process token. The server still works, but the token does
 *      not survive restarts; production installs should use the Keychain.
 *
 * Set `MODELDECK_SKIP_KEYCHAIN=1` to disable the Keychain lookup (hermetic tests).
 * Returns `{ token, source }` where source is one of
 * 'option' | 'env' | 'keychain' | 'ephemeral'. The token value itself must
 * never be logged.
 */
export function resolveMutationToken({ token, env = process.env, lookup = keychainLookup } = {}) {
  if (token) return { token, source: 'option' };
  const fromEnv = env.MODELDECK_MUTATION_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  if (env.MODELDECK_SKIP_KEYCHAIN !== '1') {
    const fromKeychain = lookup();
    if (fromKeychain) return { token: fromKeychain, source: 'keychain' };
  }
  return { token: crypto.randomBytes(32).toString('base64url'), source: 'ephemeral' };
}
