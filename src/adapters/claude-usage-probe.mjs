import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { claudeCredentialServiceName } from './claude-keychain.mjs';

const execFileAsync = promisify(execFile);
const SIGN_IN_ERROR = 'stored OAuth credentials are unavailable; sign in explicitly before refreshing';

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

  try {
    const service = claudeCredentialServiceName(profile, homeDirectory);
    const username = userInfo().username;
    const result = await runSecurity('/usr/bin/security', [
      'find-generic-password', '-s', service, '-a', username, '-w',
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 2_000_000,
    });
    return JSON.parse(String(result?.stdout ?? result));
  } catch {
    // Never surface security output: it can contain the credential value.
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Claude usage probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
