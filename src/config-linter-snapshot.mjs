import fs from 'node:fs';
import path from 'node:path';
import { readCodexAccountId } from './adapters/codex.mjs';
import { inspectJsonObjectAt, inspectJsonObjectDocument, inspectTopLevelJsonObject } from './shared-scope.mjs';

const CLAUDE_BLOCK = '# >>> ModelDeck Claude identity switching >>>';
const CLAUDE_BLOCK_END = '# <<< ModelDeck Claude identity switching <<<';
const CLAUDE_ENV_SELECTOR = '_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"';
const CLAUDE_ENV_SOURCE = '. "$_modeldeck_claude_env"';
const CODEX_BLOCK = '# >>> ModelDeck Codex identity switching >>>';
const CODEX_BLOCK_END = '# <<< ModelDeck Codex identity switching <<<';
const CODEX_BLOCK_LINES = Object.freeze([
  CODEX_BLOCK,
  'if [ -z "${CODEX_HOME:-}" ]; then',
  '_modeldeck_codex_home="$(readlink ~/.codex 2>/dev/null || true)"',
  'if [ -n "$_modeldeck_codex_home" ]; then',
  'case "$_modeldeck_codex_home" in',
  '/*) ;;',
  '*) _modeldeck_codex_home="$HOME/$_modeldeck_codex_home" ;;',
  'esac',
  'export CODEX_HOME="$_modeldeck_codex_home"',
  'fi',
  'unset _modeldeck_codex_home',
  'fi',
  CODEX_BLOCK_END,
]);
const DAEMON_LABEL = 'ai.hermes.modeldeck';

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeError(error) {
  if (error?.code) return String(error.code);
  return error?.message || String(error);
}

function safeUrlOrigin(value) {
  if (typeof value !== 'string') return 'not-a-string';
  try { return new URL(value).origin; }
  catch { return 'invalid-url'; }
}

function sameFileIdentity(stat, identity) {
  return stat?.dev === identity?.dev && stat?.ino === identity?.ino;
}

function changedProfileHomeError() {
  return new Error('managed profile home changed during inspection');
}

async function lstatOrNull(file, lstat) {
  try { return await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectDirectory(file, { lstat, uid }) {
  try {
    const stat = await lstatOrNull(file, lstat);
    if (!stat) {
      return { status: 'ok', path: file, exists: false, isDirectory: false, mode: null, ownedByCurrentUser: null };
    }
    return {
      status: 'ok',
      path: file,
      exists: true,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      mode: stat.mode & 0o777,
      ownedByCurrentUser: uid == null || stat.uid === uid,
    };
  } catch (error) {
    return { status: 'unknown', path: file, reason: safeError(error) };
  }
}

async function inspectManagedProfileHome(profilePath, profilesDir, io) {
  const home = await inspectDirectory(profilePath, io);
  const unavailable = (reason) => ({
    home,
    readable: false,
    reason: `managed profile home is unavailable: ${reason}`,
  });
  if (home.status !== 'ok') return unavailable(home.reason || 'directory metadata could not be read');
  if (!home.exists || !home.isDirectory || home.isSymbolicLink) return unavailable('not a real directory');
  try {
    const initial = await io.lstat(profilePath);
    if (!initial.isDirectory() || initial.isSymbolicLink()) return unavailable('not a real directory');
    const [root, canonical] = await Promise.all([io.realpath(profilesDir), io.realpath(profilePath)]);
    if (canonical === root || !pathIsWithin(canonical, root)) return unavailable('outside the managed profiles directory');
    const inspected = {
      home,
      readable: true,
      path: profilePath,
      canonicalPath: canonical,
      canonicalRoot: root,
      identity: { dev: initial.dev, ino: initial.ino },
    };
    await assertManagedProfileHomeStable(inspected, io);
    return inspected;
  } catch (error) {
    return unavailable(safeError(error));
  }
}

async function assertManagedProfileHomeStable(profile, io) {
  const before = await io.lstat(profile.path);
  if (!before.isDirectory() || before.isSymbolicLink() || !sameFileIdentity(before, profile.identity)) {
    throw changedProfileHomeError();
  }
  const [root, canonical] = await Promise.all([
    io.realpath(profile.canonicalRoot),
    io.realpath(profile.path),
  ]);
  const after = await io.lstat(profile.path);
  if (root !== profile.canonicalRoot || canonical !== profile.canonicalPath
    || !after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(after, profile.identity)) {
    throw changedProfileHomeError();
  }
}

async function readRegularText(file, io, guard) {
  await guard?.();
  const stat = await lstatOrNull(file, io.lstat);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error('file must be a regular file');
    error.code = 'MODELDECK_NOT_REGULAR';
    throw error;
  }
  const handle = await io.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      const error = new Error('file must be a regular file');
      error.code = 'MODELDECK_NOT_REGULAR';
      throw error;
    }
    await guard?.();
    const source = await io.readOpenedFile(handle, file, 'utf8');
    await guard?.();
    return source;
  } finally {
    await handle.close();
  }
}

async function inspectActivationLink(link, profilesDir, { lstat, realpath }) {
  try {
    const stat = await lstatOrNull(link, lstat);
    if (!stat) return { state: 'missing', path: link, profilesDir };
    if (!stat.isSymbolicLink()) return { state: 'not-symlink', path: link, profilesDir };
    let target;
    try { target = await realpath(link); }
    catch (error) {
      if (error.code === 'ENOENT') return { state: 'dangling', path: link, profilesDir };
      return { state: 'unknown', path: link, profilesDir, reason: safeError(error) };
    }
    let root;
    try { root = await realpath(profilesDir); }
    catch (error) {
      return { state: 'unknown', path: link, profilesDir, target, reason: safeError(error) };
    }
    return {
      state: pathIsWithin(target, root) && target !== root ? 'ok' : 'outside-managed-profiles',
      path: link,
      profilesDir: root,
      target,
    };
  } catch (error) {
    return { state: 'unknown', path: link, profilesDir, reason: safeError(error) };
  }
}

function sanitizedSettings(source) {
  const object = inspectJsonObjectDocument(source);
  const result = {};
  if (object.properties.some((property) => property.key === 'apiKeyHelper')) result.apiKeyHelper = true;
  const env = {};
  const envProperty = object.properties.findLast((property) => property.key === 'env');
  if (!envProperty) {
    result.env = env;
    return result;
  }
  const envObject = inspectJsonObjectAt(source, envProperty.start);
  if (envObject.close + 1 !== envProperty.end) throw new Error('settings.json env must be an object');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (envObject.properties.some((property) => property.key === key)) env[key] = true;
  }
  const baseUrl = envObject.properties.findLast((property) => property.key === 'ANTHROPIC_BASE_URL');
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = source[baseUrl.start] === '"'
      ? safeUrlOrigin(JSON.parse(source.slice(baseUrl.start, baseUrl.end)))
      : 'not-a-string';
  }
  result.env = env;
  return result;
}

async function inspectSettings(file, io, guard) {
  try {
    const source = await readRegularText(file, io, guard);
    if (source == null) return { status: 'ok', path: file, value: { env: {} } };
    return { status: 'ok', path: file, value: sanitizedSettings(source) };
  } catch (error) {
    return { status: 'unknown', path: file, reason: safeError(error) };
  }
}

async function inspectClaudeJson(file, io, guard) {
  let source;
  try {
    source = await readRegularText(file, io, guard);
    if (source == null) return { status: 'missing', path: file };
  } catch (error) {
    if (error?.code === 'MODELDECK_NOT_REGULAR') {
      return { status: 'invalid', path: file, reason: 'not a regular file' };
    }
    return { status: 'unknown', path: file, reason: safeError(error) };
  }
  try {
    const inspected = inspectTopLevelJsonObject(source);
    return { status: 'ok', path: file, kind: inspected.kind, regularFile: true };
  } catch (error) {
    return { status: 'invalid', path: file, reason: safeError(error) };
  }
}

async function inspectMemory(file, { lstat, realpath }, guard) {
  try {
    await guard?.();
    const stat = await lstatOrNull(file, lstat);
    if (!stat) {
      await guard?.();
      return { status: 'ok', path: file, kind: 'missing', target: null };
    }
    if (!stat.isSymbolicLink()) {
      await guard?.();
      return { status: 'ok', path: file, kind: stat.isDirectory() ? 'directory' : 'other', target: null };
    }
    try {
      const target = await realpath(file);
      await guard?.();
      return { status: 'ok', path: file, kind: 'symlink', target };
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'ok', path: file, kind: 'symlink', target: 'unresolved' };
      throw error;
    }
  } catch (error) {
    return { status: 'unknown', path: file, reason: safeError(error) };
  }
}

async function inspectCodexIdentifier(profile, io, guard) {
  const file = path.join(profile.path, 'auth.json');
  try {
    const source = await readRegularText(file, io, guard);
    if (source == null) return { status: 'unknown', path: file, reason: 'auth.json is missing' };
    const result = await readCodexAccountId({ codexHome: profile.path, readFile: async () => source });
    return result.accountId
      ? { status: 'ok', path: file, value: result.accountId }
      : { status: 'unknown', path: file, reason: 'tokens.account_id is missing or unreadable' };
  } catch (error) {
    return { status: 'unknown', path: file, reason: safeError(error) };
  }
}

async function inspectShell(zshenvPath, claudeShellEnvFile, io) {
  let zshenv;
  try {
    const raw = await readRegularText(zshenvPath, io) || '';
    const blockStart = raw.indexOf(CLAUDE_BLOCK);
    const blockEnd = blockStart < 0 ? -1 : raw.indexOf(CLAUDE_BLOCK_END, blockStart + CLAUDE_BLOCK.length);
    const claudeBlock = blockEnd < 0 ? '' : raw.slice(blockStart, blockEnd + CLAUDE_BLOCK_END.length);
    const blockLines = claudeBlock.split(/\r?\n/).map((line) => line.trim());
    const codexStart = raw.indexOf(CODEX_BLOCK);
    const codexEnd = codexStart < 0 ? -1 : raw.indexOf(CODEX_BLOCK_END, codexStart + CODEX_BLOCK.length);
    const codexLines = codexEnd < 0
      ? []
      : raw.slice(codexStart, codexEnd + CODEX_BLOCK_END.length)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    zshenv = {
      status: 'ok',
      path: zshenvPath,
      hasClaudeBlock: blockLines.includes(CLAUDE_ENV_SELECTOR) && blockLines.includes(CLAUDE_ENV_SOURCE),
      hasCodexBlock: codexLines.length === CODEX_BLOCK_LINES.length
        && codexLines.every((line, index) => line === CODEX_BLOCK_LINES[index]),
    };
  } catch (error) {
    zshenv = { status: 'unknown', path: zshenvPath, reason: safeError(error) };
  }

  let claudeEnv;
  try {
    const raw = await readRegularText(claudeShellEnvFile, io) || '';
    const readExport = (name) => {
      const match = raw.match(new RegExp(`^export ${name}=(.*)$`, 'm'));
      if (!match) return null;
      const encoded = match[1].trim();
      if (encoded.startsWith("'") && encoded.endsWith("'")) {
        return encoded.slice(1, -1).replaceAll("'\\''", "'");
      }
      if (encoded.startsWith('"') && encoded.endsWith('"')) return encoded.slice(1, -1);
      return encoded;
    };
    const canonical = async (value) => {
      if (!value) return null;
      try { return await io.realpath(value); }
      catch { return value; }
    };
    claudeEnv = {
      status: 'ok',
      path: claudeShellEnvFile,
      configDir: await canonical(readExport('CLAUDE_CONFIG_DIR')),
      secureStorageConfigDir: await canonical(readExport('CLAUDE_SECURESTORAGE_CONFIG_DIR')),
    };
  } catch (error) {
    claudeEnv = { status: 'unknown', path: claudeShellEnvFile, reason: safeError(error) };
  }
  return { zshenv, claudeEnv };
}

async function inspectManagementKey(file, { lstat }) {
  try {
    const stat = await lstatOrNull(file, lstat);
    return stat
      ? { status: 'ok', path: file, exists: stat.isFile() && !stat.isSymbolicLink(), mode: stat.mode & 0o777 }
      : { status: 'ok', path: file, exists: false, mode: null };
  } catch (error) {
    return { status: 'unknown', path: file, reason: safeError(error) };
  }
}

// Issue #785: CLIProxyAPI drops a usage record left unread longer than
// redis-usage-queue-retention-seconds (absent or <= 0 means 60, capped at
// 3600). Proxy v8 also reads it from observability.usage, and that spelling
// wins when both exist. Only that one integer leaves this function; the rest
// of config.yaml, which holds secrets, is never kept.
const RETENTION_KEY = 'redis-usage-queue-retention-seconds';
const RETENTION_PATHS = Object.freeze([`observability.usage.${RETENTION_KEY}`, RETENTION_KEY]);
const YAML_KEY_LINE = /^( *)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+|<<))[ \t]*:(?:[ \t]+(.*))?$/;

export function parseUsageQueueRetention(source) {
  const found = new Map();
  const stack = [];
  for (const line of source.split(/\r?\n/)) {
    const match = YAML_KEY_LINE.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const parentPath = stack.map((entry) => entry.key).join('.');
    const key = match[2] ?? match[3] ?? match[4];
    const keyPath = parentPath ? `${parentPath}.${key}` : key;
    const value = (match[5] ?? '').replace(/(^|[ \t])#.*$/, '').trim();
    // A merge key, or a flow mapping, anchor, alias or tag on a parent of the
    // setting, could hide its value from this line reader (CodeRabbit, #803).
    const leadsToRetention = (prefix) => !prefix || RETENTION_PATHS.some((wanted) => wanted.startsWith(`${prefix}.`));
    if (key === '<<' && leadsToRetention(parentPath)) return null;
    if (value && leadsToRetention(keyPath)) return null;
    if (!value) stack.push({ indent, key });
    if (!RETENTION_PATHS.includes(keyPath)) continue;
    if (found.has(keyPath)) return null;
    found.set(keyPath, value);
  }
  const chosen = RETENTION_PATHS.find((wanted) => found.has(wanted));
  if (!chosen) return { seconds: 60, source: 'default' };
  // Leading zeros are left to the proxy's YAML reader (possibly octal).
  if (!/^-?(0|[1-9]\d*)$/.test(found.get(chosen))) return null;
  const value = Number(found.get(chosen));
  return { seconds: value <= 0 ? 60 : Math.min(value, 3600), source: 'config' };
}

async function inspectUsageQueueRetention(consumerEnabled, cliproxyConfigDir, io) {
  if (!consumerEnabled) return { status: 'ok', consumerEnabled: false };
  if (!cliproxyConfigDir) return { status: 'unknown', reason: 'proxy config directory is not configured' };
  const file = path.join(cliproxyConfigDir, 'config.yaml');
  try {
    const source = await readRegularText(file, io);
    if (source == null) return { status: 'unknown', path: file, reason: 'proxy config.yaml not found' };
    const retention = parseUsageQueueRetention(source);
    if (!retention) return { status: 'unknown', path: file, reason: 'usage-queue retention is not one whole number' };
    return { status: 'ok', consumerEnabled: true, path: file, retentionSeconds: retention.seconds, retentionSource: retention.source };
  } catch (error) {
    return { status: 'unknown', path: file, reason: safeError(error) };
  }
}

async function sharedScopeConsistency({ enabled, sharedScopeDir, accounts, io }) {
  const manifestPath = path.join(sharedScopeDir, 'manifest.json');
  let manifest;
  try {
    const source = await readRegularText(manifestPath, io);
    if (source == null) {
      return enabled
        ? { status: 'ok', issues: ['shared-scope is enabled but manifest.json is missing'] }
        : { status: 'ok', issues: [] };
    }
    const object = inspectJsonObjectDocument(source);
    const readProperty = (name) => {
      const property = object.properties.findLast((item) => item.key === name);
      return property ? JSON.parse(source.slice(property.start, property.end)) : undefined;
    };
    manifest = {
      mergedProfiles: readProperty('mergedProfiles'),
      memoryEnabled: readProperty('memoryEnabled'),
    };
  } catch (error) {
    return { status: 'unknown', path: manifestPath, reason: safeError(error) };
  }

  const issues = [];
  const accountIds = new Set(accounts.filter((account) => account.provider === 'claude').map((account) => account.id));
  const merged = Array.isArray(manifest.mergedProfiles)
    ? [...new Set(manifest.mergedProfiles)].sort((left, right) => String(left).localeCompare(String(right)))
    : [];
  const backupRoot = path.resolve(sharedScopeDir, 'backups');
  for (const accountId of merged) {
    if (typeof accountId !== 'string' || !accountIds.has(accountId)) {
      issues.push(`manifest names unknown profile ${String(accountId)}`);
      continue;
    }
    const backup = path.resolve(backupRoot, accountId);
    if (backup === backupRoot || !pathIsWithin(backup, backupRoot)) {
      issues.push(`manifest profile ${accountId} has an invalid backup path`);
      continue;
    }
    let markerPath = path.join(backup, '.claude.json');
    try {
      const mcp = await lstatOrNull(markerPath, io.lstat);
      markerPath = path.join(backup, '.claude.json.absent');
      const mcpAbsent = await lstatOrNull(markerPath, io.lstat);
      if (!mcp && !mcpAbsent) issues.push(`profile ${accountId} has no .claude.json backup marker`);
      if (manifest.memoryEnabled) {
        markerPath = path.join(backup, 'memory');
        const memory = await lstatOrNull(markerPath, io.lstat);
        markerPath = path.join(backup, 'memory.absent');
        const memoryAbsent = await lstatOrNull(markerPath, io.lstat);
        if (!memory && !memoryAbsent) issues.push(`profile ${accountId} has no memory backup marker`);
      }
    } catch (error) {
      return { status: 'unknown', path: markerPath, reason: safeError(error) };
    }
  }
  return { status: 'ok', issues };
}

async function pathExecutables({ pathValue, configuredClaudePath, cachedVersion, io }) {
  const candidates = [];
  for (const directory of String(pathValue || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, 'claude'));
  }
  if (path.isAbsolute(configuredClaudePath || '')) candidates.push(configuredClaudePath);
  const items = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await io.access(candidate, fs.constants.X_OK);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) continue;
      return { status: 'unknown', path: candidate, reason: safeError(error) };
    }
    try {
      const stat = await io.lstat(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      items.push({ path: candidate, realpath: await io.realpath(candidate), version: null });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) continue;
      return { status: 'unknown', path: candidate, reason: safeError(error) };
    }
  }
  items.sort((left, right) => left.path.localeCompare(right.path));
  if (items.length && cachedVersion) {
    let selected = 0;
    if (path.isAbsolute(configuredClaudePath || '')) {
      let configuredRealpath = configuredClaudePath;
      try { configuredRealpath = await io.realpath(configuredClaudePath); } catch { /* use configured spelling */ }
      const match = items.findIndex((item) => item.realpath === configuredRealpath);
      if (match >= 0) selected = match;
    }
    items[selected].version = cachedVersion;
  }
  return { status: 'ok', items };
}

export function classifyLaunchdPrint({ exitCode, output = '', error } = {}) {
  if (error || !Number.isInteger(exitCode)) return { status: 'unknown', label: DAEMON_LABEL, reason: error || 'launchctl did not return an exit code' };
  if (exitCode === 3 || exitCode === 113) return { status: 'ok', label: DAEMON_LABEL, state: 'not-found', lastExitCode: null, needsLwcrUpdate: false };
  if (exitCode !== 0) return { status: 'unknown', label: DAEMON_LABEL, reason: `launchctl exited ${exitCode}` };
  const stateMatch = String(output).match(/(?:^|\n)\s*state\s*=\s*([^\r\n]+)/i);
  if (!stateMatch) return { status: 'unknown', label: DAEMON_LABEL, reason: 'launchctl output did not contain a job state' };
  const state = stateMatch[1].trim().toLowerCase().split(/\s+/).join('-');
  const normalized = String(output).toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const exitMatch = normalized.match(/last exit code = (-?\d+)/);
  return {
    status: 'ok',
    label: DAEMON_LABEL,
    state,
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
    needsLwcrUpdate: normalized.includes('needs lwcr update'),
  };
}

async function launchdState({ launchctlPath, readLaunchd, service, uid }) {
  try {
    const result = readLaunchd
      ? await readLaunchd()
      : await service.exec(launchctlPath, ['print', `gui/${uid}/${DAEMON_LABEL}`], { timeout: 5_000, maxBuffer: 1_000_000 });
    return classifyLaunchdPrint({
      exitCode: result.exitCode ?? 0,
      output: String(result.output ?? result.stdout ?? ''),
    });
  } catch (error) {
    return classifyLaunchdPrint({
      exitCode: Number.isInteger(error?.code) ? error.code : undefined,
      output: String(error?.stdout || ''),
      error: Number.isInteger(error?.code) ? null : safeError(error),
    });
  }
}

async function canonicalConfiguredPath(value, realpath) {
  const resolved = path.resolve(value);
  const suffix = [];
  let candidate = resolved;
  while (true) {
    try {
      return path.join(await realpath(candidate), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return resolved;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function runtimeOverrides({
  runtimeEnv,
  dataDir,
  dbPath,
  claudeProfilesDir,
  codexProfilesDir,
  claudeShellEnvFile,
  cliproxyConfigDir,
  cliproxyAuthDir,
  cliproxyManagementKeyPath,
  realpath,
}) {
  const names = [
    'MODELDECK_DATA_DIR',
    'MODELDECK_DB_PATH',
    'MODELDECK_CLAUDE_PROFILES_DIR',
    'MODELDECK_CLAUDE_SHELL_ENV_FILE',
    'MODELDECK_CODEX_PROFILES_DIR',
    'MODELDECK_CLIPROXY_CONFIG_DIR',
    'MODELDECK_CLIPROXY_AUTH_DIR',
    'MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH',
  ];
  const active = Object.fromEntries(names.filter((name) => runtimeEnv?.[name]).map((name) => [name, runtimeEnv[name]]));
  const splits = [];
  try {
    const canonicalDataDir = await canonicalConfiguredPath(dataDir, realpath);
    for (const [name, value] of [
      ['MODELDECK_DB_PATH', dbPath],
      ['MODELDECK_CLAUDE_PROFILES_DIR', claudeProfilesDir],
      ['MODELDECK_CODEX_PROFILES_DIR', codexProfilesDir],
      ['MODELDECK_CLAUDE_SHELL_ENV_FILE', claudeShellEnvFile],
    ]) {
      if (!active.MODELDECK_DATA_DIR && !active[name]) continue;
      const canonicalValue = await canonicalConfiguredPath(value, realpath);
      if (!pathIsWithin(canonicalValue, canonicalDataDir)) {
        splits.push({
          base: 'MODELDECK_DATA_DIR',
          path: name,
          basePath: dataDir,
          observedPath: value,
        });
      }
    }

    const proxyPairs = cliproxyConfigDir ? [
      ['MODELDECK_CLIPROXY_AUTH_DIR', cliproxyAuthDir, path.join(cliproxyConfigDir, 'auth')],
      ['MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH', cliproxyManagementKeyPath, path.join(cliproxyConfigDir, '.mgmt-key')],
    ] : [];
    for (const [name, value, expected] of proxyPairs) {
      if (!active.MODELDECK_CLIPROXY_CONFIG_DIR && !active[name]) continue;
      if (!value) continue;
      const [canonicalValue, canonicalExpected] = await Promise.all([
        canonicalConfiguredPath(value, realpath),
        canonicalConfiguredPath(expected, realpath),
      ]);
      if (canonicalValue !== canonicalExpected) {
        splits.push({
          base: 'MODELDECK_CLIPROXY_CONFIG_DIR',
          path: name,
          basePath: cliproxyConfigDir,
          observedPath: value,
          expectedPath: expected,
        });
      }
    }
    return { status: 'ok', active, splits };
  } catch (error) {
    return { status: 'unknown', active, reason: safeError(error) };
  }
}

async function proxySnapshot({ service, accounts, codexProfiles, cliproxyConfigDir, cliproxyAuthDir, cliproxyManagementKeyPath, usageQueueConsumerEnabled, io }) {
  const remote = service?.proxyRoleRemote?.();
  if (remote) {
    // 'remote' is not 'unknown': the rules that read the local pool do not
    // apply on a client of another Mac's pool, so they report nothing.
    const unavailable = { status: 'remote', ...remote };
    return {
      expectedOrigin: safeUrlOrigin(service.cliproxyBaseUrl),
      managed: false,
      roster: unavailable,
      authFiles: unavailable,
      managementKey: unavailable,
      usageQueue: unavailable,
      ...remote,
    };
  }
  let weights = null;
  let readError = null;
  try { weights = await service?.readProxyWeights?.({ includeEmpty: true }); }
  catch (error) { readError = safeError(error); }
  let authFiles;
  let roster;
  if (weights) {
    const claudeAccounts = new Map(accounts
      .filter((account) => account.provider === 'claude' && account.identity)
      .map((account) => [account.identity.trim().toLowerCase(), account.id]));
    const codexAccounts = new Map(codexProfiles
      .filter((profile) => profile.accountId && profile.authAccountId.status === 'ok')
      .map((profile) => [profile.authAccountId.value, profile.accountId]));
    const files = (weights.files || []).map((file) => ({
      ...file,
      claimedAccountId: file.provider === 'claude'
        ? claudeAccounts.get(file.identity) || null
        : codexAccounts.get(file.identity) || null,
    }));
    authFiles = { status: 'ok', files, issues: weights.issues || [] };
    roster = { status: 'ok', accountIds: [...new Set(files.map((file) => file.claimedAccountId).filter(Boolean))].sort() };
  } else {
    const directory = await inspectDirectory(cliproxyAuthDir, { lstat: io.lstat, uid: io.uid });
    if (directory.status === 'ok' && !directory.isDirectory) {
      authFiles = { status: 'not-installed', path: cliproxyAuthDir };
      roster = { status: 'ok', accountIds: [] };
    } else {
      authFiles = { status: 'unknown', path: cliproxyAuthDir, reason: readError || 'no readable proxy auth metadata' };
      roster = { status: 'unknown', reason: authFiles.reason };
    }
  }
  const config = await inspectDirectory(cliproxyConfigDir, { lstat: io.lstat, uid: io.uid });
  const reportedManaged = service?.managedProxyAppReport?.managed;
  return {
    expectedOrigin: safeUrlOrigin(service?.cliproxyBaseUrl || 'http://127.0.0.1:8317'),
    managed: typeof reportedManaged === 'boolean'
      ? reportedManaged
      : config.status === 'ok' && !config.isDirectory ? false : null,
    roster,
    authFiles,
    managementKey: await inspectManagementKey(cliproxyManagementKeyPath, io),
    usageQueue: await inspectUsageQueueRetention(usageQueueConsumerEnabled, cliproxyConfigDir, io),
  };
}

async function codexProfileEntries(codexAccounts, codexProfilesDir, root, io) {
  const entries = new Map();
  for (const account of codexAccounts) {
    let key = path.resolve(account.profileRef);
    try { key = await io.realpath(account.profileRef); } catch { /* The profile inspection reports the unavailable path. */ }
    entries.set(key, { accountId: account.id, path: account.profileRef });
  }
  if (root.status !== 'ok') {
    return { entries: [...entries.values()], discovery: { status: 'unknown', path: codexProfilesDir, reason: root.reason } };
  }
  if (!root.exists) {
    return { entries: [...entries.values()], discovery: { status: 'ok', path: codexProfilesDir } };
  }
  if (!root.isDirectory || root.isSymbolicLink) {
    return {
      entries: [...entries.values()],
      discovery: { status: 'unknown', path: codexProfilesDir, reason: 'Codex profiles root is not a real directory' },
    };
  }
  try {
    const children = await io.readdir(codexProfilesDir, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      const childPath = path.resolve(codexProfilesDir, child.name);
      let key = child.isSymbolicLink() ? `symlink:${childPath}` : childPath;
      if (child.isDirectory()) {
        try { key = await io.realpath(childPath); } catch { /* The profile inspection reports the unavailable path. */ }
      }
      if (!entries.has(key)) entries.set(key, { accountId: null, path: childPath });
    }
    return {
      entries: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path)),
      discovery: { status: 'ok', path: codexProfilesDir },
    };
  } catch (error) {
    return {
      entries: [...entries.values()],
      discovery: { status: 'unknown', path: codexProfilesDir, reason: safeError(error) },
    };
  }
}

export function configLintSnapshotOptions(service) {
  return {
    store: service.store,
    service,
    claudeProfilesDir: service.claudeProfilesDir,
    claudeActiveLink: service.claudeActiveLink,
    codexProfilesDir: service.codexProfilesDir,
    codexActiveLink: service.codexActiveLink,
    claudeShellEnvFile: service.claudeShellEnvFile,
    zshenvPath: service.configLintZshenvPath,
    sharedScopeDir: service.sharedScope.sharedDir,
    dataDir: service.dataDir,
    dbPath: service.configLintDbPath,
    cliproxyConfigDir: service.cliproxyConfigDir,
    cliproxyAuthDir: service.cliproxyAuthDir,
    cliproxyManagementKeyPath: service.cliproxyManagementKeyPath,
    launchctlPath: service.configLintLaunchctlPath,
  };
}

export async function collectConfigLintSnapshot({
  store,
  service,
  claudeProfilesDir,
  claudeActiveLink,
  codexProfilesDir,
  codexActiveLink,
  claudeShellEnvFile,
  zshenvPath,
  sharedScopeDir,
  dataDir = service?.dataDir || path.dirname(claudeProfilesDir),
  dbPath = service?.configLintDbPath || path.join(dataDir, 'modeldeck.sqlite'),
  cliproxyConfigDir,
  cliproxyAuthDir,
  cliproxyManagementKeyPath,
  launchctlPath = '/bin/launchctl',
  readLaunchd,
  readFile = fs.promises.readFile,
  readManagedFile = (handle, _file, encoding) => handle.readFile(encoding),
  lstat = fs.promises.lstat,
  realpath = fs.promises.realpath,
  access = fs.promises.access,
  open = fs.promises.open,
  readdir = fs.promises.readdir,
  runtimeEnv = service?.childEnv || process.env,
  uid = service?.uid ?? process.getuid?.(),
} = {}) {
  const io = { readFile, readOpenedFile: readManagedFile, lstat, realpath, access, open, readdir, uid };
  const accounts = store.listAccounts().map((account) => ({
    id: account.id,
    provider: account.provider,
    enabled: account.enabled,
    identity: account.identity,
    profileRef: account.profileRef,
  }));
  const claudeAccounts = accounts.filter((account) => account.provider === 'claude');
  const codexAccounts = accounts.filter((account) => account.provider === 'codex');
  const profileRoots = {
    claude: await inspectDirectory(claudeProfilesDir, { lstat, uid }),
    codex: await inspectDirectory(codexProfilesDir, { lstat, uid }),
  };
  const codexRoster = await codexProfileEntries(codexAccounts, codexProfilesDir, profileRoots.codex, io);
  let sharedMemoryDir = path.join(sharedScopeDir, 'memory');
  try { sharedMemoryDir = await realpath(sharedMemoryDir); }
  catch { /* A missing canonical directory remains comparable by configured path. */ }
  const claudeProfiles = await Promise.all(claudeAccounts.map(async (account) => {
    const inspected = await inspectManagedProfileHome(account.profileRef, claudeProfilesDir, io);
    if (!inspected.readable) {
      const unavailable = (name) => ({ status: 'unknown', path: path.join(account.profileRef, name), reason: inspected.reason });
      return {
        accountId: account.id,
        path: account.profileRef,
        home: inspected.home,
        settings: unavailable('settings.json'),
        claudeJson: unavailable('.claude.json'),
        memory: unavailable('memory'),
      };
    }
    const guard = () => assertManagedProfileHomeStable(inspected, io);
    return {
      accountId: account.id,
      path: account.profileRef,
      home: inspected.home,
      settings: await inspectSettings(path.join(inspected.canonicalPath, 'settings.json'), io, guard),
      claudeJson: await inspectClaudeJson(path.join(inspected.canonicalPath, '.claude.json'), io, guard),
      memory: await inspectMemory(path.join(inspected.canonicalPath, 'memory'), io, guard),
    };
  }));
  const codexProfiles = await Promise.all(codexRoster.entries.map(async (entry) => {
    const inspected = await inspectManagedProfileHome(entry.path, codexProfilesDir, io);
    const profile = {
      accountId: entry.accountId,
      path: entry.path,
      home: inspected.home,
    };
    if (!inspected.readable) {
      return {
        ...profile,
        authAccountId: { status: 'unknown', path: path.join(entry.path, 'auth.json'), reason: inspected.reason },
      };
    }
    const guard = () => assertManagedProfileHomeStable(inspected, io);
    const readProfile = { ...profile, path: inspected.canonicalPath };
    return { ...profile, authAccountId: await inspectCodexIdentifier(readProfile, io, guard) };
  }));
  const settings = store.getSettings?.() || {};
  const cachedTools = service?.toolProbeCache?.value?.tools || {};
  const recordedVersions = service?.configLintInstalledCliVersions || {};
  const proxy = await proxySnapshot({
    service, accounts, codexProfiles, cliproxyConfigDir, cliproxyAuthDir, cliproxyManagementKeyPath, io,
    usageQueueConsumerEnabled: settings.usageQueueConsumerEnabled === true,
  });
  return {
    accounts,
    installedCliVersions: {
      claude: cachedTools.claude?.version
        ? { status: 'ok', version: cachedTools.claude.version }
        : recordedVersions.claude
          ? { status: 'ok', version: recordedVersions.claude }
        : { status: 'unknown', reason: 'daemon has not detected a Claude version' },
      codex: cachedTools.codex?.version
        ? { status: 'ok', version: cachedTools.codex.version }
        : recordedVersions.codex
          ? { status: 'ok', version: recordedVersions.codex }
        : { status: 'unknown', reason: 'daemon has not detected a Codex version' },
    },
    profileRoots,
    profileDiscovery: { codex: codexRoster.discovery },
    claudeProfiles,
    codexProfiles,
    activation: {
      claude: await inspectActivationLink(claudeActiveLink, claudeProfilesDir, io),
      codex: await inspectActivationLink(codexActiveLink, codexProfilesDir, io),
    },
    shell: await inspectShell(zshenvPath, claudeShellEnvFile, io),
    proxy,
    sharedScope: {
      enabled: settings.sharedUserScopeEnabled === true,
      sharedMemoryDir,
      consistency: await sharedScopeConsistency({
        enabled: settings.sharedUserScopeEnabled === true,
        sharedScopeDir,
        accounts,
        io,
      }),
    },
    pathExecutables: await pathExecutables({
      pathValue: runtimeEnv?.PATH,
      configuredClaudePath: service?.claudePath,
      cachedVersion: cachedTools.claude?.version,
      io,
    }),
    launchd: {
      daemon: await launchdState({ launchctlPath, readLaunchd, service, uid }),
      proxy: service?.managedProxyAppReport?.managed === true
        ? { status: 'ok', state: 'not-launchd-managed', source: 'managed proxy app report' }
        : {
          status: 'unknown',
          reason: 'proxy LaunchAgent label is not recorded; executable-name matching is unsafe',
        },
    },
    runtimeOverrides: await runtimeOverrides({
      runtimeEnv,
      dataDir,
      dbPath,
      claudeProfilesDir,
      codexProfilesDir,
      claudeShellEnvFile,
      // Remote clients retain these paths for rollback, not pool inspection.
      cliproxyConfigDir: service?.proxyRoleRemote?.() ? null : cliproxyConfigDir,
      cliproxyAuthDir,
      cliproxyManagementKeyPath,
      realpath,
    }),
    daemonFacts: {
      duplicateClaudeAccountIds: claudeAccounts.length < 2
        || (service?.claudeWeeklyFingerprints instanceof Map
          && claudeAccounts.every((account) => service.claudeWeeklyFingerprints.has(account.id)))
        ? { status: 'ok', value: [...(service?.duplicateClaudeTokenAccountIds || [])].sort() }
        : { status: 'unknown', reason: 'no completed Claude refresh in this daemon process' },
    },
  };
}
