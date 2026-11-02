import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { assertClientKeySlug, clientKeyService } from './client-key-helper.mjs';
import { codexPoolConfigPath, CODEX_POOL_KEY_ERRORS, CODEX_POOL_KEY_SCRIPT } from './codex-pool-key.mjs';
import { parseT3PoolInstances, T3_POOL_KEY_ERRORS, T3_POOL_KEY_SCRIPT } from './t3-pool-key.mjs';

const EMPTY_KEY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

class PoolClientKeyError extends Error {}

function invalid(message) {
  return Object.assign(new PoolClientKeyError(message), { statusCode: 400 });
}

export function assertPoolKeyHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || value === EMPTY_KEY_HASH) {
    throw invalid('keySha256 must be 64 lowercase hex characters and not the empty-key hash');
  }
  return value;
}

export function assertPoolMachine(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) {
    throw invalid('machine must be 1–64 characters from [a-z0-9-]');
  }
  return value;
}

export function poolKeyEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('pool key entry must be an object');
  const keySha256 = assertPoolKeyHash(input.keySha256);
  const machine = assertPoolMachine(input.machine);
  let profileSlug = null;
  if (input.profileSlug != null) {
    try { profileSlug = slug(input.profileSlug); }
    catch { throw invalid('profileSlug must be a profile id or t3-<instanceId>'); }
  }
  const profileLabel = input.profileLabel ?? null;
  if (profileLabel != null && (typeof profileLabel !== 'string' || profileLabel.length > 128 || /[\p{Cc}\p{Cf}]/u.test(profileLabel))) {
    throw invalid('profileLabel must be at most 128 characters and free of control or format characters');
  }
  return { keySha256, machine, profileSlug, profileLabel };
}

export function poolKeySelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['machine', 'profileSlug', 'keySha256s', 'hashPrefixes'].includes(key))
    || !Array.isArray(input.keySha256s) || !Array.isArray(input.hashPrefixes)) {
    throw invalid('invalid pool key selection');
  }
  const machine = assertPoolMachine(input.machine);
  const keySha256s = input.keySha256s.map(assertPoolKeyHash);
  if (input.hashPrefixes.some((prefix) => typeof prefix !== 'string' || !/^[a-f0-9]{8}$/.test(prefix))) {
    throw invalid('hashPrefixes must contain 8 lowercase hex characters each');
  }
  const selection = { machine, keySha256s, hashPrefixes: [...input.hashPrefixes] };
  if (Object.hasOwn(input, 'profileSlug')) selection.profileSlug = input.profileSlug === null ? null : slug(input.profileSlug);
  return selection;
}

export const POOL_CLIENT_KEYS_USAGE = `Usage:
  node scripts/pool-client-keys.mjs add --machine <label> --ssh <destination>
    [--per-machine] [--platform darwin|linux] [--profiles id,id] [--keychain <path>]
    [--no-codex] [--no-t3] [--enable-key-checking]
  node scripts/pool-client-keys.mjs revoke --machine <label> [--profile <id>]
  node scripts/pool-client-keys.mjs list

Options:
  --proxy-base <url>          Host proxy (default http://127.0.0.1:8317)
  --daemon-base <url>         Host daemon (default http://127.0.0.1:3867)
  --management-key-file <path>  Override the host management-key file
  --client-daemon-port <port> Client daemon over SSH (default 3867)
  --no-codex                 Skip Codex profiles in per-profile mode
  --no-t3                    Skip T3 Claude instances in per-profile mode
  --enable-key-checking      Allow the first key in an empty proxy list
  --help                     Show this help

Run on the pool host. Linux requires --per-machine; darwin is the default.
Per-machine installs need no client daemon and skip client state/role/profile checks.
Per-profile installs require a client daemon in remote role. By default add selects
Claude and Codex profiles and T3 Claude instances routed to the local forwarder.
--profiles accepts profile ids and t3-<instanceId> (max 32 total).
--no-codex skips Codex; --no-t3 skips T3 instances.
Codex installs change only experimental_bearer_token in config.toml's
[model_providers.cliproxyapi] table, preserving other bytes and file permissions.
They require top-level model_provider = "cliproxyapi" and the table's base_url
exactly "http://127.0.0.1:8317/v1". Symlinked paths are refused; no backup is made.
T3 installs replace only an existing, user-owned secret file under
~/.t3/userdata/secrets with mode 0600; settings.json is never changed.
Instances must use claudeAgent, be enabled, have ANTHROPIC_BASE_URL exactly
"http://127.0.0.1:8317" (optional trailing /), and a sensitive ANTHROPIC_AUTH_TOKEN.
Instance ids match [A-Za-z0-9_-]{1,64}. Symlinked paths are refused; no backup is made.
Absent T3 settings are silently ignored. Failed optional checks skip by id;
explicit selections and SSH connection failures stop the run.
Selected profile labels must be at most 128 characters, without control or Unicode
format characters; validation errors name the account id.
The first key turns key checking on; keyless clients will get 401s. It requires
--enable-key-checking. Revoke and rollback refuse to empty the list because an
empty list lets every request in.
Add rotates active keys for the same machine/profile after install (and Claude wiring).
Codex and T3 have no wire step. Restart open Codex sessions and the T3 server
after installing their keys. Per-profile summaries show provider, label and
8-char hash prefix, including T3 instance labels.
An install failure keeps old and new keys live and reports:
"install unconfirmed: re-run add". It fails; only failures before install starts
roll back the new key.
An installed-but-not-wired key stays live alongside old keys; rerun add to finish.
Per-machine installs print the Keychain helper command or Linux key file path.
--keychain must name an existing file on the client.
Host mutation token: MODELDECK_MUTATION_TOKEN, otherwise the modeldeck Keychain item (macOS) or ~/.config/modeldeck/mutation-token (Linux).
Keys travel only in proxy request bodies and install stdin; list shows hash prefixes.
Revoke sends only matched hashes and initially listed prefixes absent from the proxy;
ambiguous prefixes are refused. No matching rows reports
"nothing to revoke for <machine>[/<profile>]" and succeeds.
Unexpected api-keys changes stop the run with vanished/appeared hash prefixes:
"another writer changed api-keys during this run; check them". Other writers' keys
are never restored. If deletion leaves an empty list, the script attempts to restore
only our key to keep key checking on, and the run still fails.`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function loopbackBase(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('base URL must be loopback HTTP'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw invalid('base URL must be loopback HTTP with no credentials, path, query or fragment');
  }
  return url.origin;
}

function slug(value) {
  if (typeof value === 'string' && /^t3-[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  try { return assertClientKeySlug(value); }
  catch { throw invalid('profile id must match [a-z0-9-] and be at most 128 characters'); }
}

function optionsFor(argv, effects) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      machine: { type: 'string' }, ssh: { type: 'string' }, 'per-machine': { type: 'boolean' },
      platform: { type: 'string', default: 'darwin' }, profiles: { type: 'string' }, profile: { type: 'string' },
      keychain: { type: 'string' }, 'proxy-base': { type: 'string', default: 'http://127.0.0.1:8317' },
      'daemon-base': { type: 'string', default: 'http://127.0.0.1:3867' },
      'management-key-file': { type: 'string' }, 'client-daemon-port': { type: 'string', default: '3867' },
      help: { type: 'boolean' }, 'enable-key-checking': { type: 'boolean' }, 'no-codex': { type: 'boolean' }, 'no-t3': { type: 'boolean' },
    } });
  } catch { throw invalid('invalid command line; use --help'); }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const command = positionals[0];
  if (positionals.length !== 1 || !['add', 'revoke', 'list'].includes(command)) throw invalid('choose add, revoke or list; use --help');
  const machine = command === 'list' ? null : assertPoolMachine(values.machine);
  const profiles = values.profiles === undefined ? null : values.profiles.split(',').map(slug);
  const profile = values.profile === undefined ? null : slug(values.profile);
  if (!['darwin', 'linux'].includes(values.platform)) throw invalid('platform must be darwin or linux');
  if (command === 'add' && values.platform === 'linux' && !values['per-machine']) throw invalid('Linux requires --per-machine');
  if (profiles && values['per-machine']) throw invalid('--profiles cannot be combined with --per-machine');
  if (profiles && new Set(profiles).size !== profiles.length) throw invalid('--profiles repeats an id');
  if (profiles?.length > 32) throw invalid('select at most 32 profiles');
  if (command === 'add' && (typeof values.ssh !== 'string' || values.ssh.startsWith('-')
    || !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9_.-]+$/.test(values.ssh))) throw invalid('invalid SSH destination');
  if (!/^\d+$/.test(values['client-daemon-port']) || Number(values['client-daemon-port']) < 1
    || Number(values['client-daemon-port']) > 65535) throw invalid('invalid client daemon port');
  // security's interactive parser is not a shell. Match the app's bounded
  // path grammar rather than relying on shell escapes inside its stdin.
  if (values.keychain !== undefined && (!values.keychain.startsWith('/')
    || /["\\\p{Cc}\p{Cf}]/u.test(values.keychain))) throw invalid('keychain must be an absolute path without quotes, backslashes or control/format characters');
  // A per-profile helper reads the default search list, so a named keychain
  // only makes sense for a per-machine item (CodeRabbit, PR #792).
  if ((command !== 'add' && (values.ssh || profiles || values['per-machine'] || values.keychain || values['enable-key-checking'] || values['no-codex']))
    || (values['no-t3'] && command !== 'add')
    || ((values['no-codex'] || values['no-t3']) && values['per-machine'])
    || (values.keychain && !values['per-machine'])
    || (command !== 'revoke' && profile) || (values.platform === 'linux' && values.keychain)) throw invalid('option does not apply to this command');
  return { command, machine, profiles, profile, destination: values.ssh,
    enableKeyChecking: values['enable-key-checking'] === true,
    noCodex: values['no-codex'] === true,
    noT3: values['no-t3'] === true,
    perMachine: values['per-machine'] === true, platform: values.platform, keychain: values.keychain,
    clientBase: `http://127.0.0.1:${Number(values['client-daemon-port'])}`,
    proxyBase: loopbackBase(values['proxy-base']), daemonBase: loopbackBase(values['daemon-base']),
    managementKeyFile: values['management-key-file'] ?? effects.managementKeyFile };
}

function daemonEntries(body) {
  if (!Array.isArray(body?.keys)) throw new PoolClientKeyError('invalid daemon key list');
  return body.keys.map((row) => {
    if (!row || typeof row.hashPrefix !== 'string' || !/^[a-f0-9]{8}$/.test(row.hashPrefix)
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || (row.revokedAt != null && (typeof row.revokedAt !== 'string' || !Number.isFinite(Date.parse(row.revokedAt))))) {
      throw new PoolClientKeyError('invalid daemon key list');
    }
    const entry = poolKeyEntry({ ...row, keySha256: '0'.repeat(64) });
    return { machine: entry.machine, profileSlug: entry.profileSlug, profileLabel: entry.profileLabel,
      createdAt: new Date(row.createdAt).toISOString(), revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
      hashPrefix: row.hashPrefix };
  });
}

// Every effect is supplied by the caller. In particular, no default fetch,
// SSH runner, credential read, randomness or output is reachable in tests.
export async function runPoolClientKeys(argv, effects) {
  const options = optionsFor(argv, effects);
  if (options.help) { effects.output(POOL_CLIENT_KEYS_USAGE); return; }
  let step = 'preflight';
  try {
    const request = async (base, route, method = 'GET', body, headers = {}) => {
      const response = await effects.fetch(`${base}${route}`, { method, redirect: 'error', headers: {
        ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error('request failed');
      return response.json();
    };
    const daemonRoute = '/api/pool-client-keys';
    const listed = daemonEntries(await request(options.daemonBase, daemonRoute));
    if (options.command === 'list') {
      effects.output('Machine\tProfile\tCreated\tRevoked\tHash');
      for (const row of listed) effects.output([row.machine, row.profileLabel ?? row.profileSlug ?? '-',
        row.createdAt, row.revokedAt ?? '-', row.hashPrefix].join('\t'));
      return listed;
    }

    const selected = options.command === 'revoke' ? listed.filter((row) => row.machine === options.machine
      && (!options.profile || row.profileSlug === options.profile)) : [];
    if (options.command === 'revoke' && !selected.length) {
      effects.output(`nothing to revoke for ${options.machine}${options.profile ? `/${options.profile}` : ''}`);
      return;
    }

    const managementKey = String(await effects.readFile(options.managementKeyFile, 'utf8')).trim();
    const token = String(await effects.readMutationToken()).trim();
    if (!managementKey || !token || /[\r\n]/.test(managementKey + token)) throw new Error('missing credential');
    const proxyRoute = '/v0/management/api-keys';
    const proxy = (method = 'GET', body, suffix = '') => request(options.proxyBase, proxyRoute + suffix, method, body,
      { Authorization: `Bearer ${managementKey}` });
    const daemon = async (body) => daemonEntries(await request(options.daemonBase, daemonRoute, 'POST', body, {
      'x-modeldeck-token': token, Cookie: `modeldeck_session=${encodeURIComponent(token)}`, Origin: options.daemonBase,
    }));
    const proxyKeys = async () => {
      const body = await proxy();
      if (!Array.isArray(body?.['api-keys']) || body['api-keys'].some((key) => typeof key !== 'string')) throw new Error('invalid proxy list');
      return body['api-keys'];
    };
    const append = async (key, existing) => {
      let sentinel = `modeldeck-unused-${sha256(key)}`;
      while (existing.includes(sentinel)) sentinel += '-';
      await proxy('PATCH', { old: sentinel, new: key });
    };
    const refuseEmpty = (keys, hashes) => {
      if (keys.length && keys.every((key) => hashes.includes(sha256(key)))) {
        throw new PoolClientKeyError('removal refused: an empty list lets every request in');
      }
    };
    const sameList = (left, right) => left.length === right.length && left.every((key, index) => key === right[index]);
    const remove = async (hash) => {
      // Index deletes can race other writers. Never restore their removals.
      // Any unexpected result, including our key reappearing, stops the run.
      const before = await proxyKeys();
      const index = before.findIndex((key) => sha256(key) === hash);
      if (index < 0) return;
      refuseEmpty(before, [hash]);
      const expected = before.toSpliced(index, 1);
      try { await proxy('DELETE', undefined, `?index=${index}`); } catch { /* Verify even a lost response. */ }
      const after = await proxyKeys();
      if (sameList(after, expected)) {
        // A duplicate copy of our own key (a hand-edited config) is ours to remove too.
        if (after.some((key) => sha256(key) === hash)) return remove(hash);
        return;
      }
      const remaining = [...after];
      const vanished = expected.filter((key) => {
        const found = remaining.indexOf(key);
        if (found < 0) return true;
        remaining.splice(found, 1);
        return false;
      });
      const prefixes = (keys) => keys.map((key) => sha256(key).slice(0, 8)).join(', ') || 'none';
      let safety = '';
      if (!after.length) {
        // Empty api-keys admits everyone. Restore only our own key, never
        // a bystander that another writer may have deliberately revoked.
        safety = `; empty list; restoration of our key ${hash.slice(0, 8)} unconfirmed`;
        try {
          try { await append(before[index], after); } catch { /* Verify even a lost PATCH response. */ }
          if ((await proxyKeys()).some((key) => sha256(key) === hash)) {
            safety = `; empty list; restored our key ${hash.slice(0, 8)} to keep key checking on`;
          }
        } catch { /* Report the unconfirmed safety restore without external error text. */ }
      }
      throw new PoolClientKeyError(`another writer changed api-keys during this run; check them; vanished: ${prefixes(vanished)}; appeared: ${prefixes(remaining)}${safety}`);
    };
    const display = (entry) => `${entry.machine} ${entry.profileSlug ?? '-'} ${(entry.keySha256 ?? entry.hashPrefix).slice(0, 8)}`;
    const removalPlan = (selected, keys) => {
      const hashes = [...new Set(keys.map(sha256))];
      const plan = selected.map((row) => {
        const matches = hashes.filter((hash) => hash.startsWith(row.hashPrefix));
        if (listed.filter((other) => other.hashPrefix === row.hashPrefix).length > 1 || matches.length > 1) {
          throw new PoolClientKeyError(`ambiguous hash prefix ${row.hashPrefix}; no keys removed`);
        }
        return { row, hash: matches[0] };
      });
      refuseEmpty(keys, plan.map(({ hash }) => hash));
      return plan;
    };
    const revokeSelection = async (where, plan) => {
      const result = await daemon({ revokeWhere: { ...where,
        keySha256s: plan.filter(({ hash }) => hash).map(({ hash }) => hash),
        hashPrefixes: plan.filter(({ hash }) => !hash).map(({ row }) => row.hashPrefix),
      } });
      if (plan.some(({ row }) => !result.some((entry) => entry.hashPrefix === row.hashPrefix
        && entry.machine === row.machine && entry.profileSlug === row.profileSlug && entry.revokedAt))) {
        throw new Error('revocation unconfirmed');
      }
    };

    if (options.command === 'revoke') {
      step = 'revoke matching';
      const plan = removalPlan(selected, await proxyKeys());
      for (const { hash } of plan) {
        if (hash) { step = 'proxy removal'; await remove(hash); }
      }
      step = 'daemon revoke';
      await revokeSelection({ machine: options.machine, ...(options.profile ? { profileSlug: options.profile } : {}) }, plan);
      for (const row of selected) effects.output(`${row.revokedAt ? 'already revoked' : 'Revoked'} ${display(row)}`);
      return;
    }

    const ssh = (command, stdin = '', captureStdout = false) => effects.ssh(
      ['-T', '-o', 'BatchMode=yes', '--', options.destination, command], { stdin, captureStdout },
    );
    const codexCommand = (config, mode = '') => `/usr/bin/python3 -I -c ${shellQuote(CODEX_POOL_KEY_SCRIPT)} ${shellQuote(config)}${mode ? ` ${mode}` : ''}`;
    const codexFailure = (error) => Object.hasOwn(CODEX_POOL_KEY_ERRORS, error?.exitCode)
      ? CODEX_POOL_KEY_ERRORS[error.exitCode] : 'Codex config command failed';
    const t3Command = (mode, id) => `/usr/bin/python3 -I -c ${shellQuote(T3_POOL_KEY_SCRIPT)} ${mode}${id === undefined ? '' : ` ${shellQuote(id)}`}`;
    const t3Failure = (error) => Object.hasOwn(T3_POOL_KEY_ERRORS, error?.exitCode)
      ? T3_POOL_KEY_ERRORS[error.exitCode] : 'T3 instance command failed';
    let profiles = [{ id: null, label: null }];
    if (!options.perMachine) {
      step = 'client preflight';
      const state = JSON.parse(await ssh(`/usr/bin/curl -q -fsS --max-time 15 ${shellQuote(`${options.clientBase}/api/state`)}`, '', true));
      if (state?.proxy?.role !== 'remote') throw new PoolClientKeyError('flip the client to remote role first');
      if (!Array.isArray(state.accounts)) throw new Error('invalid accounts');
      const accounts = state.accounts.filter((account) => account?.provider === 'claude'
        || (!options.noCodex && account?.provider === 'codex'));
      const ids = new Set();
      for (const account of accounts) {
        assertClientKeySlug(account.id);
        if (ids.has(account.id)) throw new Error('duplicate account');
        ids.add(account.id);
      }
      if (options.profiles?.some((id) => accounts.find((account) => account.id === id)?.provider === 'claude'
        && accounts.find((account) => account.id === id).cliproxyRouted !== true)) {
        throw new PoolClientKeyError('wire refused: profile not routed');
      }
      for (const account of accounts.filter((account) => account.provider === 'claude' && account.cliproxyRouted !== true)) {
        effects.output(`Skipped ${account.id}: profile not routed to the local forwarder`);
      }
      profiles = accounts.filter((account) => (account.provider === 'codex' || account.cliproxyRouted === true)
        && (!options.profiles || options.profiles.includes(account.id)));
      let routedCount = profiles.filter((account) => account.provider === 'claude').length;
      if (routedCount > 32) throw new PoolClientKeyError('select at most 32 profiles');
      for (const account of profiles.filter((account) => account.provider === 'claude')) {
        try { poolKeyEntry({ keySha256: '0'.repeat(64), machine: options.machine, profileSlug: account.id, profileLabel: account.label }); }
        catch (error) { throw new PoolClientKeyError(`account ${account.id}: ${error.message}`); }
      }
      const codexProfiles = profiles.filter((account) => account.provider === 'codex');
      if (codexProfiles.length) {
        let homeDir;
        // The SSH link itself failing is never a per-profile skip (#791 re-check).
        try { homeDir = (await ssh('/usr/bin/printenv HOME', '', true)).trim(); }
        catch (error) {
          if (error?.exitCode === 255 || !Number.isInteger(error?.exitCode)) {
            throw new PoolClientKeyError('ssh to the client failed reading its home; nothing was minted');
          }
          // An unknown home makes each Codex path ineligible below.
        }
        const configs = new Map();
        for (const account of codexProfiles) {
          try { configs.set(account.id, codexPoolConfigPath(account.profileRef, { homeDir, profilesDir: state.codexProfilesDir })); }
          catch {
            if (options.profiles?.includes(account.id)) throw new PoolClientKeyError(`account ${account.id}: invalid Codex profile path`);
            effects.output(`Skipped Codex ${account.id}: invalid Codex profile path`);
            profiles = profiles.filter((profile) => profile.id !== account.id);
          }
        }
        for (const candidate of codexProfiles.filter((account) => configs.has(account.id))) {
          const account = { ...candidate, configPath: configs.get(candidate.id) };
          try { await ssh(codexCommand(account.configPath, 'check')); }
          catch (error) {
            // 255 is ssh's own failure and no exit code means the call was
            // killed: the link broke, so stop rather than skip a routed profile.
            if (error?.exitCode === 255 || !Number.isInteger(error?.exitCode)) {
              throw new PoolClientKeyError('ssh to the client failed during the Codex check; nothing was minted');
            }
            if (options.profiles?.includes(account.id)) throw new PoolClientKeyError(`account ${account.id}: ${codexFailure(error)}`);
            effects.output(`Skipped Codex ${account.id}: ${codexFailure(error)}`);
            profiles = profiles.filter((profile) => profile.id !== account.id);
            continue;
          }
          try { poolKeyEntry({ keySha256: '0'.repeat(64), machine: options.machine, profileSlug: account.id, profileLabel: account.label }); }
          catch {
            if (options.profiles?.includes(account.id)) throw new PoolClientKeyError(`account ${account.id}: invalid Codex profile label`);
            effects.output(`Skipped Codex ${account.id}: invalid Codex profile label`);
            profiles = profiles.filter((profile) => profile.id !== account.id);
            continue;
          }
          if (++routedCount > 32) throw new PoolClientKeyError('select at most 32 profiles');
          profiles = profiles.map((profile) => profile.id === account.id ? account : profile);
        }
      }
      if (!options.noT3 && (!options.profiles || options.profiles.some((id) => id.startsWith('t3-')))) {
        let instances = [];
        let discovery;
        const skipDiscovery = (reason) => {
          if (options.profiles?.some((id) => id.startsWith('t3-'))) throw new PoolClientKeyError(`T3 discovery: ${reason}`);
          effects.output(`Skipped T3 discovery: ${reason}`);
        };
        try { discovery = await ssh(t3Command('list'), '', true); }
        catch (error) {
          if (error?.exitCode === 255 || !Number.isInteger(error?.exitCode)) {
            throw new PoolClientKeyError('ssh to the client failed during T3 discovery; nothing was minted');
          }
          skipDiscovery(t3Failure(error));
        }
        if (discovery !== undefined) {
          try { instances = parseT3PoolInstances(discovery); }
          catch { skipDiscovery('invalid T3 discovery'); }
        }
        for (const instance of instances) {
          const id = `t3-${instance.id}`;
          if (instance.skipped !== undefined) {
            const reason = T3_POOL_KEY_ERRORS[instance.skipped];
            if (options.profiles?.includes(id)) throw new PoolClientKeyError(`T3 ${instance.id}: ${reason}`);
            effects.output(`Skipped T3 ${instance.id}: ${reason}`);
            continue;
          }
          if (state.accounts.some((account) => account?.id === id)) throw new PoolClientKeyError(`T3 ${instance.id}: profile id conflicts with a ModelDeck account`);
          ids.add(id);
          if (options.profiles && !options.profiles.includes(id)) continue;
          try { await ssh(t3Command('check', instance.id)); }
          catch (error) {
            if (error?.exitCode === 255 || !Number.isInteger(error?.exitCode)) {
              throw new PoolClientKeyError('ssh to the client failed during the T3 check; nothing was minted');
            }
            if (options.profiles?.includes(id)) throw new PoolClientKeyError(`T3 ${instance.id}: ${t3Failure(error)}`);
            effects.output(`Skipped T3 ${instance.id}: ${t3Failure(error)}`);
            continue;
          }
          const label = `T3 ${instance.displayName}`;
          poolKeyEntry({ keySha256: '0'.repeat(64), machine: options.machine, profileSlug: id, profileLabel: label });
          if (++routedCount > 32) throw new PoolClientKeyError('select at most 32 profiles');
          profiles.push({ id, label, provider: 't3-claude', instanceId: instance.id });
        }
      }
      if (options.profiles?.some((id) => !ids.has(id))) throw new PoolClientKeyError('wire refused: profile not found');
      if (!profiles.length) throw new PoolClientKeyError('nothing to key: every selected profile was skipped');
    }
    if (options.keychain) {
      try { await ssh(`test -f ${shellQuote(options.keychain)}`); }
      catch { throw new PoolClientKeyError('keychain path must name an existing file on the client'); }
    }
    const checkAdmission = (keys) => {
      if (!keys.length && !options.enableKeyChecking) {
        throw new PoolClientKeyError('the first key turns key checking on and keyless clients will get 401s; use --enable-key-checking');
      }
    };
    checkAdmission(await proxyKeys());
    let user;
    if (options.platform === 'darwin' && (options.perMachine || profiles.some((profile) => profile.provider === 'claude'))) {
      step = 'client username';
      user = (await ssh('/usr/bin/id -un', '', true)).trim();
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(user)) throw new Error('invalid username');
    }
    const completed = [];
    let restartPrinted = false;
    for (const profile of profiles) {
      step = 'mint';
      const bytes = await effects.randomBytes(32);
      if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('invalid randomness');
      const key = Buffer.from(bytes).toString('base64url');
      const entry = poolKeyEntry({ keySha256: sha256(key), machine: options.machine, profileSlug: profile.id, profileLabel: profile.label });
      let appendAttempted = false;
      let registerAttempted = false;
      let installStarted = false;
      let installed = false;
      let wired = false;
      try {
        step = 'admission preflight';
        const existing = await proxyKeys();
        checkAdmission(existing);
        if (existing.some((value) => sha256(value) === entry.keySha256)
          || listed.some((row) => row.hashPrefix === entry.keySha256.slice(0, 8))) throw new Error('generated key collision');
        const previous = listed.filter((row) => !row.revokedAt && row.machine === options.machine && row.profileSlug === profile.id);
        removalPlan(previous, [...existing, key]); // Refuse ambiguous rotation before touching the client.
        step = 'register';
        registerAttempted = true; // Registration may succeed even if its response is lost.
        const registeredRows = await daemon({ add: [entry] });
        if (!registeredRows.some((row) => row.hashPrefix === entry.keySha256.slice(0, 8) && row.machine === entry.machine
          && row.profileSlug === entry.profileSlug && row.profileLabel === entry.profileLabel && !row.revokedAt)) throw new Error('registration unconfirmed');
        step = 'proxy-add';
        const current = await proxyKeys();
        checkAdmission(current);
        appendAttempted = true;
        await append(key, current);
        step = 'verify';
        if (!(await proxyKeys()).some((value) => sha256(value) === entry.keySha256)) throw new Error('key absent');
        step = 'install';
        installStarted = true; // A failed SSH call cannot prove the remote write did not run.
        if (profile.provider === 'codex') {
          try { await ssh(codexCommand(profile.configPath), key); }
          catch (error) { throw new PoolClientKeyError(codexFailure(error)); }
        } else if (profile.provider === 't3-claude') {
          try { await ssh(t3Command('install', profile.instanceId), key); }
          catch (error) { throw new PoolClientKeyError(t3Failure(error)); }
        } else if (options.platform === 'darwin') {
          const service = clientKeyService(profile.id ?? `machine-${options.machine}`);
          const keychain = options.keychain ? ` ${shellQuote(options.keychain)}` : '';
          // Remove all duplicates, accepting ONLY not-found as convergence.
          // The final delete/add pair uses security's stdin grammar, as in
          // the app. Its stderr echoes stdin, so both remote and local discard it.
          const pathCheck = options.keychain ? `test -f ${shellQuote(options.keychain)} || exit 66; ` : '';
          const cleanup = `set +x; ${pathCheck}n=0; while [ "$n" -lt 64 ]; do /usr/bin/security delete-generic-password -s ${shellQuote(service)}${keychain} >/dev/null 2>&1; status=$?; [ "$status" -eq 44 ] && break; [ "$status" -eq 0 ] || exit 1; n=$((n + 1)); done; [ "$n" -lt 64 ] || exit 1; exec /usr/bin/security -i >/dev/null 2>/dev/null`;
          const pathArg = options.keychain ? ` "${options.keychain}"` : '';
          await ssh(`/bin/sh -c ${shellQuote(cleanup)}`,
            `delete-generic-password -s "${service}"${pathArg}\nadd-generic-password -s "${service}" -a "${user}" -T /usr/bin/security -w "${key}"${pathArg}\n`);
        } else {
          const install = 'set +x; umask 077; mkdir -p ~/.config/modeldeck && test ! -L ~/.config/modeldeck/pool-client-key && touch ~/.config/modeldeck/pool-client-key && chmod 600 ~/.config/modeldeck/pool-client-key && cat > ~/.config/modeldeck/pool-client-key';
          await ssh(`/bin/sh -c ${shellQuote(install)}`, key);
        }
        installed = true;
        if (['codex', 't3-claude'].includes(profile.provider) && !restartPrinted) {
          effects.output(`Restart open Codex sessions and the T3 server on ${options.machine} so they read the new key.`);
          restartPrinted = true;
        }
        if (options.perMachine) effects.output(options.platform === 'darwin'
          ? `Client helper: security find-generic-password -s ${clientKeyService(`machine-${options.machine}`)} -w`
          : 'Client key file: ~/.config/modeldeck/pool-client-key');
        if (!options.perMachine && profile.provider === 'claude') {
          step = 'wire';
          const url = `${options.clientBase}/api/accounts/${slug(profile.id)}/client-key-helper`;
          // The client's token stays on the client: shell-local, never an
          // exported variable, command argument, or SSH response to this host.
          const wire = `set +x; /usr/bin/security find-generic-password -s modeldeck -a mutation-token -w 2>/dev/null | { IFS= read -r token && [ -n "$token" ] && printf 'x-modeldeck-token: %s\\nCookie: modeldeck_session=%s\\n' "$token" "$token" | /usr/bin/curl -q -sS --max-time 15 --header @- --header 'Content-Type: application/json' --header ${shellQuote(`Origin: ${options.clientBase}`)} --data '{"poolHostVerified":true}' --output /dev/null --write-out '%{http_code}' ${shellQuote(url)} 2>/dev/null; }`;
          let status;
          try { status = (await ssh(`/bin/sh -c ${shellQuote(wire)}`, '', true)).trim(); }
          catch { throw new PoolClientKeyError('wire request failed'); }
          if (status !== '200') {
            const reasons = { 400: 'invalid request', 401: 'authentication required', 403: 'authentication refused',
              404: 'profile not found', 409: 'conflict', 500: 'client daemon failure', 503: 'client daemon unavailable' };
            throw new PoolClientKeyError(Object.hasOwn(reasons, status) ? `wire refused: ${reasons[status]}` : 'invalid wire response');
          }
        }
        wired = true;
        step = 'rotation';
        if (previous.length) {
          const plan = removalPlan(previous, await proxyKeys());
          for (const { hash } of plan) if (hash) await remove(hash);
          await revokeSelection({ machine: options.machine, profileSlug: profile.id }, plan);
        }
        completed.push(entry);
        listed.push({ ...entry, hashPrefix: entry.keySha256.slice(0, 8) });
        effects.output(options.perMachine ? `Added ${display(entry)}`
          : `Added ${profile.provider === 't3-claude' ? '' : profile.provider === 'codex' ? 'Codex ' : 'Claude '}${entry.profileLabel ?? entry.profileSlug} ${entry.keySha256.slice(0, 8)}`);
      } catch (error) {
        const failedAt = step;
        const reason = error instanceof PoolClientKeyError ? error.message : `${failedAt} failed`;
        if (installed) {
          throw new PoolClientKeyError(`${display(entry)}: ${wired ? 'installed; rotation incomplete' : 'installed but not wired'}: ${reason}`);
        }
        if (installStarted) throw new PoolClientKeyError(`${display(entry)}: install unconfirmed: re-run add${['codex', 't3-claude'].includes(profile.provider) ? `; ${reason}` : ''}`);
        const rollbackFailures = [];
        if (appendAttempted) {
          try { await remove(entry.keySha256); }
          catch (failure) { rollbackFailures.push(failure instanceof PoolClientKeyError ? failure.message : 'proxy removal unconfirmed'); }
        }
        if (registerAttempted && !rollbackFailures.length) {
          try {
            const revoked = await daemon({ revoke: [entry.keySha256] });
            if (revoked.some((row) => row.hashPrefix === entry.keySha256.slice(0, 8) && !row.revokedAt)) throw new Error('revocation unconfirmed');
          } catch { rollbackFailures.push('daemon revocation unconfirmed'); }
        }
        const upgradeHint = failedAt === 'register' && profile.id?.startsWith('t3-')
          ? "; the pool host's ModelDeck may be older than this tool, update it and re-run" : '';
        throw new PoolClientKeyError(`${display(entry)}: ${reason}; ${rollbackFailures.length
          ? `rollback incomplete: ${rollbackFailures.join(', ')}` : registerAttempted ? 'rollback complete' : 'no key added'}${upgradeHint}`);
      }
    }
    return completed;
  } catch (error) {
    // Fetch/SSH errors can embed complete request bodies, stdin and stderr.
    // Never propagate an external error, its cause, or its enumerable fields.
    if (error instanceof PoolClientKeyError) throw error;
    throw new PoolClientKeyError(`${step} failed`);
  }
}
