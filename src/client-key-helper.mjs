// Issue #522 — per-profile client-key helper wiring (design §2.5, decision 0036).
//
// The `apiKeyHelper` string, the pinned shell env block and the launch preview
// all point at ONE Keychain item. Before #520 that item was the shared
// `cli-proxy-api-client`; per-profile provisioning gives each profile its own
// `cli-proxy-api-client.<slug>` item, where the slug is the account's stable
// machine id — never its free-text label.
//
// The slug is the only value this module ever interpolates into a shell
// command string, and `assertClientKeySlug` restricts it to `[a-z0-9-]`, so
// command injection through a profile name is structurally impossible
// (design §3.5). Account ids are `crypto.randomUUID()` values, which already
// satisfy that charset.
//
// #808: off macOS there is no Keychain. The legacy shared service maps to the
// machine's one client-key file, `pool-client-key` in the secrets directory
// (decision 0046; per-machine keys on Linux, Tim's decision 4 on #783), and
// per-profile services are refused. The directory path is single-quoted.
import path from 'node:path';
import { SECRETS_DIR } from './paths.mjs';
import { readSecretFile } from './secret-file.mjs';

/// The pre-#522 shared item. Reserved EXCLUSIVELY for the legacy shared key:
/// `find-generic-password -s cli-proxy-api-client` without `-a` returns the
/// FIRST match, so per-profile items must never share this service name or a
/// stale shell could fetch another profile's key (security review of #506,
/// blocker 1). The dot-prefixed per-profile names cannot collide with it.
export const LEGACY_CLIENT_KEY_SERVICE = 'cli-proxy-api-client';
export const CLIENT_KEY_SERVICE_PREFIX = `${LEGACY_CLIENT_KEY_SERVICE}.`;

const CLIENT_KEY_SLUG_PATTERN = /^[a-z0-9-]+$/;
const CLIENT_KEY_SLUG_MAX_LENGTH = 128;

export function assertClientKeySlug(slug) {
  if (typeof slug !== 'string' || !slug || slug.length > CLIENT_KEY_SLUG_MAX_LENGTH
    || !CLIENT_KEY_SLUG_PATTERN.test(slug)) {
    throw new Error('client key profile slug must match [a-z0-9-] and be non-empty');
  }
  return slug;
}

export function clientKeyService(slug) {
  return `${CLIENT_KEY_SERVICE_PREFIX}${assertClientKeySlug(slug)}`;
}

/// Every service name that may reach a generated command string: the legacy
/// shared item, or one well-formed per-profile item. Anything else throws
/// rather than being quoted — the writers have no reason to emit a name
/// ModelDeck did not derive, and a throw is louder than an escape.
export function assertClientKeyService(service) {
  if (service === LEGACY_CLIENT_KEY_SERVICE) return service;
  if (typeof service === 'string' && service.startsWith(CLIENT_KEY_SERVICE_PREFIX)) {
    assertClientKeySlug(service.slice(CLIENT_KEY_SERVICE_PREFIX.length));
    return service;
  }
  throw new Error('client key Keychain service name is not a ModelDeck client-key service');
}

export const POOL_CLIENT_KEY_FILE = 'pool-client-key';

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/// Off macOS: the key file a service maps to. Only the legacy service has one.
export function clientKeyFile(service, { secretsDir = SECRETS_DIR } = {}) {
  if (assertClientKeyService(service) !== LEGACY_CLIENT_KEY_SERVICE) {
    throw new Error('per-profile client keys are macOS-only; this machine uses its one pool-client-key file');
  }
  return path.join(secretsDir, POOL_CLIENT_KEY_FILE);
}

/// The shell command that prints a client key: the Keychain on macOS, the
/// key file elsewhere. Used as the Claude `apiKeyHelper`. Off macOS it prints
/// the file only if it and its folder are not symlinks, are ours and have no
/// group or other bits (special bits allowed, as readClientKey), with
/// absolute tools, never a PATH lookup (#813 reviews).
export function clientKeyHelperCommand(service, { platform = process.platform, secretsDir } = {}) {
  if (platform !== 'darwin') {
    const keyFile = clientKeyFile(service, { secretsDir });
    const ownerOnly = (target) => `[ ! -L ${target} ] && case "$(/usr/bin/stat -c %u:%a -- ${target})" in "$(/usr/bin/id -u)":[1-7]00|"$(/usr/bin/id -u)":[1-7][1-7]00) true ;; *) false ;; esac`;
    const file = shellQuote(keyFile);
    return `${ownerOnly(shellQuote(path.dirname(keyFile)))} && ${ownerOnly(file)} && /bin/cat -- ${file}`;
  }
  return `security find-generic-password -s ${assertClientKeyService(service)} -w`;
}

/// The same lookup for generated shell snippets. On macOS it keeps the
/// absolute `security` path with its test override (MODELDECK_SECURITY_BIN).
export function clientKeyShellFetch(service, { platform = process.platform, secretsDir } = {}) {
  if (platform !== 'darwin') return clientKeyHelperCommand(service, { platform, secretsDir });
  return `"\${MODELDECK_SECURITY_BIN:-/usr/bin/security}" find-generic-password -s ${assertClientKeyService(service)} -w`;
}

/// Reads a client key in-process; '' when absent or unreadable. Off macOS
/// the file must pass the owner-only checks (decision 0046).
export function readClientKey(service, {
  platform = process.platform, secretsDir, execFileSync, securityBin = process.env.MODELDECK_SECURITY_BIN || '/usr/bin/security',
} = {}) {
  try {
    if (platform !== 'darwin') return readSecretFile(clientKeyFile(service, { secretsDir })) ?? '';
    return execFileSync(securityBin, ['find-generic-password', '-s', assertClientKeyService(service), '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/// The exact string every ModelDeck release before #522 wrote into
/// `settings.json` on macOS, or this machine's key-file helper elsewhere. It
/// is a CONSTANT, not a pattern — see `classifyClaudeHelper`.
export const LEGACY_CLIENT_KEY_HELPER = clientKeyHelperCommand(LEGACY_CLIENT_KEY_SERVICE);

/// The Keychain service a profile's wiring must point at, from the recorded
/// helper state ModelDeck keeps for it. No record — an install that never
/// migrated, or a profile a user routed by hand — means the legacy shared
/// item, which is exactly the pre-#522 behaviour.
export function clientKeyServiceForRecord(record) {
  return record?.mode === 'per-profile' && typeof record.service === 'string'
    ? assertClientKeyService(record.service)
    : LEGACY_CLIENT_KEY_SERVICE;
}

/// The foreign-helper guard (design §2.5, security review should-fix 7 as
/// sharpened by CodeRabbit).
///
/// Recognition as "ours" is PROVEN OWNERSHIP, never pattern inference. A
/// helper is ours only when it is byte-identical to the string this profile's
/// own record says ModelDeck last wrote. A string that merely LOOKS generated
/// — right shape, even a real account's slug — has no ownership record behind
/// it and may be the user's own hand-authored wiring (including deliberate
/// cross-profile wiring), so it is refused, never overwritten or deleted.
///
/// The one accepted string with no per-profile record is the legacy shared
/// helper. That is not a pattern match either: it is equality against the
/// single fixed string every prior release wrote, which is why an install
/// that predates per-profile keys keeps working (design §2.5, D6).
///
/// Returns 'absent' | 'recorded' | 'legacy' | 'foreign'.
export function classifyClaudeHelper(helper, record) {
  if (typeof helper !== 'string' || !helper.trim()) return 'absent';
  const recorded = typeof record?.helper === 'string' && record.helper ? record.helper : null;
  if (recorded) return helper === recorded ? 'recorded' : 'foreign';
  return helper === LEGACY_CLIENT_KEY_HELPER ? 'legacy' : 'foreign';
}

export function claudeHelperIsOurs(helper, record) {
  const verdict = classifyClaudeHelper(helper, record);
  return verdict === 'recorded' || verdict === 'legacy';
}
