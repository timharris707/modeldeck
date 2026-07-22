import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { claudeCredentialServiceName } from './claude-keychain.mjs';

const execFileAsync = promisify(execFile);
const SIGN_IN_ERROR = 'stored OAuth credentials are unavailable; sign in explicitly before refreshing';
// Issue #98: a dismissed/denied macOS Keychain prompt is NOT a sign-out —
// the credential item exists but the daemon isn't in its ACL yet. Surfacing
// it as "sign in again" sent hand-test users down the wrong recovery path.
// This message rides the per-account refresh-error channel (issue #89) up to
// the app, which matches it (see KEYCHAIN_DENIED_ERROR_PATTERN in
// src/service.mjs) to render the honest "click Refresh and choose Always
// Allow" recovery state. Deliberately free of the "sign in explicitly before
// refreshing" phrase so it can never trip the signin-required chip.
export const KEYCHAIN_DENIED_ERROR = "macOS Keychain blocked ModelDeck's background service from reading this account's stored sign-in (a dismissed permission prompt does this); click Refresh and choose Always Allow when macOS asks again";

function finiteNumber(value) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function accessToken(credentials) {
  const oauth = credentials?.claudeAiOauth ?? credentials?.oauth ?? credentials;
  const token = oauth?.accessToken ?? oauth?.access_token;
  if (typeof token !== 'string' || !token) throw new Error('stored OAuth credentials are unavailable; sign in explicitly before refreshing');
  const rawExpiresAt = finiteNumber(oauth?.expiresAt ?? oauth?.expires_at);
  const expiresAt = rawExpiresAt && rawExpiresAt < 10_000_000_000 ? rawExpiresAt * 1000 : rawExpiresAt;
  if (expiresAt && expiresAt <= Date.now()) throw new Error('stored OAuth credentials have expired; sign in explicitly before refreshing');
  return token;
}

export async function readClaudeCredentials({
  profile,
  platform = process.platform,
  homeDirectory = os.homedir(),
  userInfo = os.userInfo,
  readFile = fs.promises.readFile,
  runSecurity = execFileAsync,
} = {}) {
  if (!profile) throw new Error('CLAUDE_CONFIG_DIR is required');
  try {
    return JSON.parse(await readFile(path.join(profile, '.credentials.json'), 'utf8'));
  } catch (fileError) {
    if (platform !== 'darwin') {
      if (fileError instanceof SyntaxError) throw new Error('stored OAuth credentials are not valid JSON');
      throw new Error('stored OAuth credentials could not be read');
    }
  }

  const service = claudeCredentialServiceName(profile, homeDirectory);
  const username = userInfo().username;
  let result;
  try {
    result = await runSecurity('/usr/bin/security', [
      'find-generic-password', '-s', service, '-a', username, '-w',
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 2_000_000,
    });
  } catch {
    // Never surface security output: it can contain the credential value.
    // Issue #98: distinguish a denied read from a missing item. A metadata
    // lookup (no `-w`) needs no ACL approval and never prompts, so its
    // success while the value read failed means the item EXISTS and macOS
    // refused the secret — the dismissed-prompt state, not a sign-out.
    let itemExists = false;
    try {
      await runSecurity('/usr/bin/security', [
        'find-generic-password', '-s', service, '-a', username,
      ], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 65_536,
      });
      itemExists = true;
    } catch {
      // Item absent (or Keychain wholly unavailable): genuine sign-in state.
    }
    throw new Error(itemExists ? KEYCHAIN_DENIED_ERROR : SIGN_IN_ERROR);
  }
  try {
    return JSON.parse(String(result?.stdout ?? result));
  } catch {
    // Readable but unparseable is a credential problem, not an ACL one.
    throw new Error(SIGN_IN_ERROR);
  }
}

export async function main({ env = process.env, fetcher = globalThis.fetch, ...credentialOptions } = {}) {
  const profile = env.CLAUDE_CONFIG_DIR;
  const credentials = await readClaudeCredentials({ profile, ...credentialOptions });
  const response = await fetcher('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken(credentials)}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      // Generic user agents land in a stricter 429 bucket on this endpoint.
      'User-Agent': `claude-code/${env.MODELDECK_CLAUDE_UA_VERSION || '2.1.83'}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`provider returned HTTP ${response.status}`);
  const text = await response.text();
  JSON.parse(text);
  process.stdout.write(text);
}

// Issue #114: the ONE probe CLI error shape, shared by both launch modes.
// The SEA binary dispatches the probe through src/server.mjs's main(), whose
// generic catch used to stamp probe failures "ModelDeck failed to start:" —
// on Tim's machine that read as a daemon crash and sent the #114
// investigation toward the wrong subsystem. Every probe failure must reach
// the parent process as `Claude usage probe failed: <reason>` so the
// service-layer patterns (and humans reading /api/state) see the same
// message regardless of how the probe was launched.
export async function runProbeCli({ stderr = process.stderr, probe = main } = {}) {
  try {
    await probe();
    return 0;
  } catch (error) {
    stderr.write(`Claude usage probe failed: ${error.message}\n`);
    return 1;
  }
}

const isMain = !isSea() && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runProbeCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
