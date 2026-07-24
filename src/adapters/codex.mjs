import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractIdentity } from './identity.mjs';
import { createProviderProfileHelpers } from './provider-profile.mjs';

const execFileAsync = promisify(execFile);
const codexProfile = createProviderProfileHelpers({
  envVar: 'CODEX_HOME',
  invalidProfileNameError: 'profile name is invalid',
  profilesDirRequiredError: 'ModelDeck Codex profiles directory is required',
  profilesDirMissingLabel: 'ModelDeck Codex profiles directory',
  profilesDirLabel: 'ModelDeck Codex profiles directory',
  profileHomeRequiredError: 'Codex profile home is required',
  profileHomeLabel: 'CODEX_HOME',
  destinationExistsLabel: 'Codex profile destination already exists',
  containmentErrorPrefix: "Codex profile home must be inside ModelDeck's profiles directory",
});
const codexProfileEnv = codexProfile.profileEnv;

function toIso(value) {
  if (!value) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function labelForWindow(window, fallback) {
  if (window?.windowDurationMins === 300) return '5-hour';
  if (window?.windowDurationMins === 10080) return 'weekly';
  if (window?.windowDurationMins) return `${window.windowDurationMins}-minute`;
  return fallback;
}

export function parseCodexRateLimits(result) {
  const payload = result?.rateLimits ? result : result?.result || result;
  const buckets = payload?.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? Object.values(payload.rateLimitsByLimitId)
    : [payload?.rateLimits || payload].filter(Boolean);
  const snapshots = [];
  for (const bucket of buckets) {
    const prefix = bucket.limitName && bucket.limitName.toLowerCase() !== 'codex' ? `${bucket.limitName} ` : '';
    for (const [key, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]]) {
      if (!window || window.usedPercent == null) continue;
      snapshots.push({
        scope: `${prefix}${labelForWindow(window, key)}`.trim(),
        usedPercent: Number(window.usedPercent),
        resetsAt: toIso(window.resetsAt),
        source: 'codex-app-server',
        detail: {
          planType: bucket.planType || null,
          limitId: bucket.limitId || null,
          windowDurationMins: window.windowDurationMins || null,
          credits: bucket.credits || null,
        },
      });
    }
  }
  return snapshots.filter((snapshot, index, all) => all.findIndex((item) => item.scope === snapshot.scope) === index);
}

// ---------------------------------------------------------------------------
// Issue #164: provider error codes that unambiguously mean the stored
// credential is DEAD — the provider itself refused it and only a fresh
// sign-in can revive the account. Matching is on the STRUCTURED `code`
// field of the provider's error body, never on prose, so message wording
// drift can only ever fail toward today's behavior (stale chip), never
// toward a false "Sign in needed" alarm.
//
//   token_invalidated  — the live #164 forensics: the token family was
//                        rotated server-side (re-logging the #108
//                        duplicate's other half), invalidating this copy.
//   token_revoked      — an explicit server-side revocation of the token.
//   invalid_grant      — RFC 6749 §5.2: the refresh token is invalid,
//                        expired, or revoked at the token endpoint; the
//                        standard OAuth code for "re-authenticate".
//
// Deliberately NOT in this set (they keep the stale chip + lastRefreshError):
//   - any 401/403 without a recognized structured code (transient auth
//     hiccups, proxies, clock skew) — no false alarms;
//   - account_deactivated / plan or permission errors — a new sign-in
//     cannot fix them, so a "Sign in needed" CTA would be dishonest;
//   - rate-limit and server errors — not credential states at all.
export const CODEX_DEAD_CREDENTIAL_CODES = Object.freeze(['token_invalidated', 'token_revoked', 'invalid_grant']);

// Pinned suffix contract (#89/#149): the daemon's
// SIGN_IN_REQUIRED_ERROR_PATTERN keys on "sign in explicitly before
// refreshing", and the message must NEVER contain the #149 idle-decay
// prefix "stored OAuth credentials have expired" — this is a genuine
// server-side sign-out, so signinReason stays "missing" and the deck
// renders the amber "Sign in needed" + one-click path, not the calm moon.
export function codexDeadCredentialError(code) {
  return new Error(`Codex invalidated this account's stored sign-in (${code}); sign in explicitly before refreshing`);
}

function structuredErrorCode(value) {
  if (!value || typeof value !== 'object') return null;
  for (const candidate of [value.code, value.error?.code, value.detail?.code]) {
    // String-only on purpose: JSON-RPC numeric codes (-32603 …) are
    // transport plumbing, never a credential verdict.
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/// Extracts a recognized dead-credential code from a Codex app-server
/// JSON-RPC error: from `error.data` when the server passes the provider
/// body through structurally, or from the JSON object the server embeds in
/// its `error.message` string. A message that merely MENTIONS a code in
/// prose (no parseable JSON body with a `code` field) never matches.
export function codexDeadCredentialCode(rpcError) {
  if (!rpcError || typeof rpcError !== 'object') return null;
  let code = structuredErrorCode(rpcError) || structuredErrorCode(rpcError.data);
  if (!code && typeof rpcError.message === 'string') {
    const start = rpcError.message.indexOf('{');
    const end = rpcError.message.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { code = structuredErrorCode(JSON.parse(rpcError.message.slice(start, end + 1))); }
      catch { /* prose-only message: no structured verdict, no flip */ }
    }
  }
  return code && CODEX_DEAD_CREDENTIAL_CODES.includes(code) ? code : null;
}

export function fetchCodexRateLimits({ binary = 'codex', codexHome, timeoutMs = 20_000, spawnImpl = spawn } = {}) {
  if (!codexHome) return Promise.reject(new Error('CODEX_HOME is required'));
  return new Promise((resolve, reject) => {
    const allowedEnv = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
    const env = Object.fromEntries(allowedEnv.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    env.CODEX_HOME = codexHome;
    const child = spawnImpl(binary, ['app-server', '--stdio'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGTERM');
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Codex app-server timed out')), timeoutMs);
    child.on('error', (error) => finish(reject, error.code === 'ENOENT' ? new Error('Codex CLI is not installed') : error));
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-65_536);
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1_048_576) return finish(reject, new Error('Codex app-server output exceeded 1 MiB'));
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            // Issue #164: a dead credential can surface at either request;
            // classify structurally before falling back to the raw message.
            const deadCode = codexDeadCredentialCode(message.error);
            return finish(reject, deadCode
              ? codexDeadCredentialError(deadCode)
              : new Error(message.error.message || 'Codex app-server initialization failed'));
          }
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null })}\n`);
        }
        if (message.id === 2) {
          if (message.error) {
            // Issue #164: `401 token_invalidated` (and its siblings) left
            // authState "ok" behind a stale-data chip — reject with the
            // pinned sign-in message so the service-layer pattern (#89)
            // flips the account to signin-required. Unrecognized errors
            // keep exactly the previous shape: staleness, no false alarm.
            const deadCode = codexDeadCredentialCode(message.error);
            finish(reject, deadCode
              ? codexDeadCredentialError(deadCode)
              : new Error(message.error.message || 'Codex rate-limit request failed'));
          } else finish(resolve, parseCodexRateLimits(message.result));
        }
      }
    });
    child.on('exit', (code) => {
      if (!settled) finish(reject, new Error(`Codex app-server exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'modeldeck', title: 'ModelDeck', version: '0.1.0' }, capabilities: {} } })}\n`);
  });
}

// ---------------------------------------------------------------------------
// Issue #8 — add-account flow support. ModelDeck creates the isolated
// owner-only CODEX_HOME (step 1) and reads back the authenticated identity
// via the provider's own status command (step 3). It never runs a logout and
// never copies auth.json (docs/ACCOUNT_ONBOARDING.md). Issue #26 additionally
// reads only the id_token's non-authoritative plan claim for display metadata.

/// Step 1: create `<profilesDir>/<name>` with owner-only permissions. Fails
/// rather than reuses an existing directory so two accounts can never share a
/// CODEX_HOME.
export async function createCodexProfileHome({ profilesDir, profileName } = {}) {
  return codexProfile.createProfileHome({ profilesDir, profileName });
}

const assertOwnerOnlyCodexHome = codexProfile.assertOwnerOnlyDirectory;

/// Reads the display-only ChatGPT plan claim from CODEX_HOME/auth.json.
/// The id_token signature is intentionally not verified: this metadata is
/// never used for authentication or authorization. Every malformed/missing
/// input is treated as an absent plan so account probes cannot fail because
/// of stale or partially-written local auth state.
export async function readCodexPlan({ codexHome, readFile = fs.promises.readFile } = {}) {
  if (!codexHome) return { planType: null };
  try {
    const auth = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8'));
    const token = auth?.tokens?.id_token;
    if (typeof token !== 'string') return { planType: null };
    const segments = token.split('.');
    if (segments.length !== 3 || !segments[1] || !/^[A-Za-z0-9_-]+$/.test(segments[1])) return { planType: null };
    const remainder = segments[1].length % 4;
    if (remainder === 1) return { planType: null };
    const padded = segments[1]
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(segments[1].length + ((4 - remainder) % 4), '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const planType = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type;
    return { planType: typeof planType === 'string' && planType.trim() ? planType.trim() : null };
  } catch {
    return { planType: null };
  }
}

/// Issue #108: reads ONLY the `tokens.account_id` IDENTIFIER from
/// CODEX_HOME/auth.json so the service can detect two profiles holding the
/// same account (duplicate-credential detection). Token values are never
/// read into the result, logged, stored, or transmitted — the parsed object
/// is discarded after the identifier is extracted. Every malformed/missing
/// input (no home, unreadable file, invalid JSON, absent or blank
/// account_id) is `{ accountId: null }`: absence of evidence, never a crash.
export async function readCodexAccountId({ codexHome, readFile = fs.promises.readFile } = {}) {
  if (!codexHome) return { accountId: null };
  try {
    const auth = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8'));
    const accountId = auth?.tokens?.account_id;
    return { accountId: typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null };
  } catch {
    return { accountId: null };
  }
}

/// Containment check mirroring the Claude adapter's
/// `validateClaudeProfileHome`: the CODEX_HOME must be an owner-only real
/// directory inside ModelDeck's managed Codex profiles directory. Returns the
/// canonical path.
export async function validateCodexProfileHome({ profileRef, profilesDir } = {}) {
  return codexProfile.validateProfileHome({ profileRef, profilesDir });
}

/// Step 3: `codex login status` under the profile's CODEX_HOME. Exit 0 means
/// the profile is authenticated; a non-zero exit means "not signed in yet"
/// (returned, not thrown, so the UI can keep the user on the sign-in step).
/// Identity comes only from what the CLI prints. Plan display metadata comes
/// from the id_token already stored in auth.json; no credential value is
/// returned, persisted, or used for authorization.
/// With `profilesDir` set, the home must also live inside ModelDeck's
/// managed Codex profiles directory (same contract as the Claude reader).
export async function readCodexLoginStatus({
  binary = 'codex',
  codexHome,
  profilesDir,
  timeoutMs = 20_000,
  run = execFileAsync,
  readFile = fs.promises.readFile,
} = {}) {
  if (!codexHome) throw new Error('CODEX_HOME is required');
  if (profilesDir) await validateCodexProfileHome({ profileRef: codexHome, profilesDir });
  else await assertOwnerOnlyCodexHome(codexHome);
  const plan = await readCodexPlan({ codexHome, readFile });
  try {
    const result = await run(binary, ['login', 'status'], {
      env: codexProfileEnv(codexHome),
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
    });
    return { authenticated: true, identity: extractIdentity(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`), plan };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Codex CLI is not installed');
    return { authenticated: false, identity: null, plan, detail: error?.stderr?.trim() || error?.message || null };
  }
}
