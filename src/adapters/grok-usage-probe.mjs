import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { assertGrokProfileHome } from './grok.mjs';

// Decision 0035, stage two — the Grok quota probe.
//
// The grok CLI's own `/usage` command reads ground-truth credit usage from
// `GET {cli_chat_proxy_base}/billing?format=credits` (evidence:
// docs/research/grok-xai-feasibility-2026-08-17.md §Unknown 1). That is a
// BILLING/METADATA read, not inference: it sends no prompt and consumes no
// subscription credits, which is what keeps it inside decision 0032 — the
// same justification the Claude `oauth/usage` probe and the Codex
// `account/rateLimits/read` probe stand on.
//
// This runs as a SEPARATE PROCESS (mirroring claude-usage-probe.mjs) so the
// stored Grok token is read, used, and discarded outside the daemon: the
// daemon only ever sees the parsed percent.
//
// Read-only, always: this module opens `auth.json` and nothing else, and
// never writes anywhere under the Grok home.

export const GROK_BILLING_BASE_FALLBACK = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_SIGN_IN_ERROR = 'stored Grok credentials are unavailable; sign in explicitly before refreshing';
// Matches SIGN_IN_EXPIRED_ERROR_PATTERN in src/service.mjs, so an idle-decayed
// credential renders as the calm "expired" reason rather than a full sign-out.
export const GROK_EXPIRED_ERROR = 'stored OAuth credentials have expired; sign in explicitly before refreshing';

function finiteNumber(value) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/// Expiry as epoch milliseconds, or null. The real file stores an ISO string
/// (`"expires_at": "2026-09-16T02:20:15.967754Z"`); the earlier guesses were
/// epoch seconds or milliseconds, and all three are still accepted.
function expiryMs(value) {
  const numeric = finiteNumber(value);
  if (numeric != null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/// Where a token may live. The real `~/.grok/auth.json` (public issue #9,
/// shape confirmed by two reporters against the current Grok Build CLI) has
/// exactly one top-level key, `<issuer-url>::<client-id>` — for example
/// `https://auth.x.ai::<uuid>` — and the bearer token sits under `key` inside
/// it. The fixed roots below predate that and are kept so an older or future
/// layout still parses.
function tokenRoots(credentials) {
  const roots = [credentials?.oauth, credentials?.tokens, credentials?.auth, credentials];
  if (isObject(credentials)) {
    for (const [name, value] of Object.entries(credentials)) {
      if (/^https?:\/\/.+::.+$/.test(name)) roots.push(value);
    }
  }
  return roots.filter(isObject);
}

/// Anything that does not carry a token is reported as "sign in" rather than
/// crashing the refresh pass.
export function grokAccess(credentials) {
  for (const root of tokenRoots(credentials)) {
    const token = text(root.accessToken ?? root.access_token ?? root.token ?? root.key);
    if (!token) continue;
    const expiresAt = expiryMs(root.expiresAt ?? root.expires_at);
    if (expiresAt && expiresAt <= Date.now()) throw new Error(GROK_EXPIRED_ERROR);
    return {
      token,
      // Sent as `x-userid` when present; the CLI's billing handler forwards it.
      userId: text(root.userId ?? root.user_id ?? credentials?.userId ?? credentials?.user_id),
      expiresAt: expiresAt ?? null,
    };
  }
  throw new Error(GROK_SIGN_IN_ERROR);
}

// Loopback is the one place a plaintext hop is not a disclosure: the request
// never leaves the machine. Everything else carries the bearer token over the
// wire and must be TLS.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/// The billing URL for a configured base, or a thrown error.
///
/// CodeRabbit (PR #559): `MODELDECK_GROK_BILLING_BASE` exists so tests and
/// staging can point the probe somewhere else, and it was accepted verbatim —
/// including `http://`, which would put `Authorization: Bearer <token>` on the
/// wire in plaintext. The check runs before the fetcher is ever called, so a
/// bad base fails as a refresh error rather than a silent disclosure.
export function billingUrl(base) {
  let url;
  try {
    url = new URL(`${String(base).replace(/\/+$/, '')}/billing`);
  } catch {
    throw new Error(`Grok billing base is not a valid URL: ${base}`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      `Grok billing base must use https (http is allowed only for loopback): ${url.protocol}//${url.host}`,
    );
  }
  url.search = 'format=credits';
  return url.toString();
}

export async function readGrokCredentials({
  home,
  readFile = fs.promises.readFile,
  lstat = fs.promises.lstat,
} = {}) {
  if (!home) throw new Error('MODELDECK_GROK_HOME is required');
  const credentialPath = path.join(home, 'auth.json');
  // Everything the parent checked is a moment in the past by the time we get
  // here, so re-assert ALL of it in the process that is about to do the read,
  // immediately before the read.
  //
  // Re-checking only the credential's file TYPE was not enough (security
  // confirm on PR #559): an attacker who can write the home's PARENT can
  // rename `~/.grok` aside and put their own directory in its place, and a
  // type-only check happily accepts the substitute's perfectly ordinary
  // regular file. Re-running the full assertion — ownership, the directory's
  // write mask, the file's type, the file's write mask — is what makes the
  // substituted home fail. (We deliberately do NOT walk up and police the
  // parent directory's own mode; the re-assertion here is the close.)
  await assertGrokProfileHome(home, { lstat });
  let raw;
  try {
    raw = await readFile(credentialPath, 'utf8');
  } catch {
    throw new Error(GROK_SIGN_IN_ERROR);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('stored Grok credentials are not valid JSON');
  }
}

export async function main({
  env = process.env,
  fetcher = globalThis.fetch,
  stdout = process.stdout,
  ...credentialOptions
} = {}) {
  const home = env.MODELDECK_GROK_HOME;
  // Resolve and vet the destination BEFORE reading the credential, so a
  // misconfigured base can never get as far as holding a token.
  const url = billingUrl(text(env.MODELDECK_GROK_BILLING_BASE) || GROK_BILLING_BASE_FALLBACK);
  const credentials = await readGrokCredentials({ home, ...credentialOptions });
  const { token, userId } = grokAccess(credentials);
  const response = await fetcher(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(userId ? { 'x-userid': userId } : {}),
    },
    // A redirect off this endpoint is never something to follow: fetch would
    // carry Authorization and x-userid to the new origin, and whatever JSON
    // came back would be parsed as billing truth. Refuse instead — the deck
    // shows a refresh error, which is the honest outcome.
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    // 401/403 on this endpoint means the stored session no longer
    // authenticates — only a fresh sign-in revives it. (402/403 also carry the
    // CLI's own "you hit your limit" copy, but a limit hit still returns the
    // percent on 200; a non-OK body here is an auth problem.)
    if (response.status === 401 || response.status === 403) throw new Error(GROK_SIGN_IN_ERROR);
    throw new Error(`provider returned HTTP ${response.status}`);
  }
  stdout.write(await response.text());
}

/// The ONE probe CLI error shape (mirrors the #114 rule on the Claude probe):
/// every failure reaches the parent as `Grok usage probe failed: <reason>`
/// regardless of launch mode, so the service-layer patterns and humans
/// reading /api/state always see the same message.
export async function runProbeCli({ stderr = process.stderr, probe = main } = {}) {
  try {
    await probe();
    return 0;
  } catch (error) {
    stderr.write(`Grok usage probe failed: ${error.message}\n`);
    return 1;
  }
}

const isMain = !isSea() && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runProbeCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
