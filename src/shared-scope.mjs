import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MCP_FILE = '.claude.json';
const MEMORY_DIRECTORY = 'memory';
const EMPTY_MERGED = Object.freeze({ mcpServers: 0, memoryItems: 0 });

function jsonObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function skipWhitespace(source, offset) {
  let cursor = offset;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  return cursor;
}

function stringEnd(source, offset) {
  if (source[offset] !== '"') throw new Error('expected a JSON string');
  let escaped = false;
  for (let cursor = offset + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === '"') return cursor + 1;
  }
  throw new Error('unterminated JSON string');
}

function valueEnd(source, offset) {
  const first = source[offset];
  if (first === '"') return stringEnd(source, offset);
  if (first === '{' || first === '[') {
    const open = first;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let cursor = offset; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === '"') {
        cursor = stringEnd(source, cursor) - 1;
        continue;
      }
      if (character === open) depth += 1;
      else if (character === close && --depth === 0) return cursor + 1;
    }
    throw new Error('unterminated JSON value');
  }
  let cursor = offset;
  while (cursor < source.length && !/[\s,}]/.test(source[cursor])) cursor += 1;
  return cursor;
}

// Return byte offsets for top-level JSON object properties. This deliberately
// does not stringify the whole document: .claude.json owns OAuth/account
// state whose bytes are outside ModelDeck's sharing boundary.
function topLevelObject(source) {
  let cursor = skipWhitespace(source, 0);
  if (source[cursor] !== '{') throw new Error('.claude.json must contain a JSON object');
  const open = cursor;
  cursor += 1;
  const properties = [];
  while (true) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === '}') return { open, close: cursor, properties };
    const keyStart = cursor;
    const keyEnd = stringEnd(source, keyStart);
    const key = JSON.parse(source.slice(keyStart, keyEnd));
    cursor = skipWhitespace(source, keyEnd);
    if (source[cursor] !== ':') throw new Error('invalid top-level JSON property');
    cursor = skipWhitespace(source, cursor + 1);
    const start = cursor;
    const end = valueEnd(source, start);
    properties.push({ key, start, end });
    cursor = skipWhitespace(source, end);
    if (source[cursor] === ',') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '}') return { open, close: cursor, properties };
    throw new Error('invalid top-level JSON object');
  }
}

export function replaceTopLevelJsonProperty(source, key, value) {
  const parsed = JSON.parse(source);
  if (!jsonObject(parsed)) throw new Error('.claude.json must contain a JSON object');
  const object = topLevelObject(source);
  const serialized = JSON.stringify(value);
  // JSON technically permits duplicate keys. Updating the last occurrence
  // matches JSON.parse's effective value without touching either neighbor.
  const property = object.properties.findLast((item) => item.key === key);
  if (property) {
    return `${source.slice(0, property.start)}${serialized}${source.slice(property.end)}`;
  }
  const prefix = object.properties.length ? ',' : '';
  return `${source.slice(0, object.close)}${prefix}${JSON.stringify(key)}:${serialized}${source.slice(object.close)}`;
}

function safeProfileKey(accountId) {
  const safe = String(accountId || '').replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return safe || crypto.randomUUID();
}

function collisionName(name, accountId, occupied) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const suffix = safeProfileKey(accountId).slice(0, 12);
  let candidate = `${stem}.modeldeck-${suffix}${extension}`;
  let sequence = 2;
  while (occupied.has(candidate)) {
    candidate = `${stem}.modeldeck-${suffix}-${sequence}${extension}`;
    sequence += 1;
  }
  return candidate;
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sameFileVersion(left, right) {
  return left == null
    ? right == null
    : right != null && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function emptyOutcome(enabled, skipped = []) {
  return { enabled, merged: { ...EMPTY_MERGED }, conflicts: [], skipped };
}

class SharedScopeOperationConflictError extends Error {
  constructor() {
    super('a shared-scope operation is already in progress');
    this.statusCode = 409;
  }
}

export class SharedScopeEngine {
  constructor(store, options = {}) {
    this.store = store;
    this.profilesDir = options.profilesDir;
    this.sharedDir = options.sharedDir;
    this.canonicalMcpFile = path.join(this.sharedDir, 'mcp-servers.json');
    this.sharedMemoryDir = path.join(this.sharedDir, MEMORY_DIRECTORY);
    this.backupsDir = path.join(this.sharedDir, 'backups');
    this.manifestFile = path.join(this.sharedDir, 'manifest.json');
    this.outcomeFile = path.join(this.sharedDir, 'last-outcome.json');
    this.watch = options.watch || fs.watch;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.debounceMs = Number(options.debounceMs ?? 250);
    this.beforeAtomicRename = options.beforeAtomicRename || null;
    this.afterMcpRead = options.afterMcpRead || null;
    this.watchers = new Map();
    this.reconcileTimer = null;
    this.operation = null;
    this.deferredTail = Promise.resolve();
    this.reconcilePromise = null;
    this.lastOutcome = this.readJsonSync(this.outcomeFile, null);
  }

  readJsonSync(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
  }

  async atomicWrite(file, content, mode = 0o600, expectedStat = undefined) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let existingMode = mode;
    try { existingMode = (await fs.promises.stat(file)).mode & 0o777; } catch { /* fresh file */ }
    const temporary = `${file}.modeldeck-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(temporary, content, { mode: existingMode, flag: 'wx' });
      if (this.beforeAtomicRename) await this.beforeAtomicRename({ file, temporary });
      if (expectedStat !== undefined) {
        let currentStat = null;
        try { currentStat = await fs.promises.lstat(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const unchanged = expectedStat == null
          ? currentStat == null
          : currentStat != null
            && currentStat.mtimeMs === expectedStat.mtimeMs
            && currentStat.size === expectedStat.size;
        if (!unchanged) {
          await fs.promises.unlink(temporary).catch(() => {});
          return false;
        }
      }
      await fs.promises.rename(temporary, file);
      return true;
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async atomicWriteJson(file, value) {
    await this.atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  async atomicWriteJsonIfChanged(file, value) {
    try {
      const current = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (isDeepStrictEqual(current, value)) return false;
    } catch { /* absent or malformed canonical data is replaced atomically */ }
    await this.atomicWriteJson(file, value);
    return true;
  }

  managedProfiles() {
    let root;
    try { root = fs.realpathSync(this.profilesDir); }
    catch { return []; }
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) return [];
    if (process.getuid && rootStat.uid !== process.getuid()) return [];
    const profiles = [];
    for (const account of this.store.listAccounts().filter((item) => item.provider === 'claude')) {
      try {
        const home = fs.realpathSync(account.profileRef);
        const relative = path.relative(root, home);
        const stat = fs.lstatSync(home);
        if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
          || (process.getuid && stat.uid !== process.getuid())
          || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        profiles.push({ account, home, key: safeProfileKey(account.id) });
      } catch { /* A stale account is not a filesystem mutation target. */ }
    }
    return profiles.sort((left, right) => left.account.id.localeCompare(right.account.id));
  }

  async readMcpDocument(profile) {
    const file = path.join(profile.home, MCP_FILE);
    let raw;
    let statBefore = null;
    let statAfter = null;
    try {
      statBefore = await fs.promises.lstat(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try { raw = await fs.promises.readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      raw = '{}\n';
    }
    if (this.afterMcpRead) await this.afterMcpRead({ file, raw, stat: statBefore });
    try { statAfter = await fs.promises.lstat(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!sameFileVersion(statBefore, statAfter)) {
      this.scheduleReconcile();
      throw new Error('.claude.json changed while it was being read');
    }
    const stat = statAfter;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('.claude.json is not valid JSON'); }
    if (!jsonObject(parsed)) throw new Error('.claude.json must contain a JSON object');
    if (stat && !stat.isFile()) throw new Error('.claude.json must be a regular file');
    const mcpServers = parsed.mcpServers ?? {};
    if (!jsonObject(mcpServers)) throw new Error('.claude.json mcpServers must be an object');
    const lastApplied = await this.readLastApplied(profile);
    return { profile, file, raw, stat, mcpServers, lastApplied };
  }

  async readableMcpDocuments(profiles, skipped) {
    const documents = [];
    for (const profile of profiles) {
      try { documents.push(await this.readMcpDocument(profile)); }
      catch (error) {
        skipped.push({ what: 'mcpServers', reason: `profile ${profile.key} skipped: ${error.message}` });
      }
    }
    return documents;
  }

  async writeMcpDocument(document, mcpServers) {
    if (isDeepStrictEqual(document.mcpServers, mcpServers)) {
      await this.writeLastApplied(document.profile, mcpServers);
      return false;
    }
    const next = replaceTopLevelJsonProperty(document.raw, 'mcpServers', mcpServers);
    const written = await this.atomicWrite(
      document.file,
      next,
      document.stat ? document.stat.mode & 0o777 : 0o600,
      document.stat,
    );
    if (!written) this.scheduleReconcile();
    else await this.writeLastApplied(document.profile, mcpServers);
    return written;
  }

  backupDirectory(profile) {
    return path.join(this.backupsDir, profile.key);
  }

  lastAppliedFile(profile) {
    return path.join(this.backupDirectory(profile), 'last-applied.json');
  }

  async readLastApplied(profile) {
    try {
      const value = JSON.parse(await fs.promises.readFile(this.lastAppliedFile(profile), 'utf8'));
      return jsonObject(value) ? value : null;
    } catch {
      // An absent or unreadable snapshot is conservative: the profile can
      // contribute values, but cannot delete anything from the canonical set.
      return null;
    }
  }

  async writeLastApplied(profile, mcpServers) {
    await this.atomicWriteJsonIfChanged(this.lastAppliedFile(profile), mcpServers);
  }

  async backupFile(document) {
    const directory = this.backupDirectory(document.profile);
    const backup = path.join(directory, MCP_FILE);
    const absent = path.join(directory, `${MCP_FILE}.absent`);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(backup) || fs.existsSync(absent)) return;
    if (document.stat) await fs.promises.copyFile(document.file, backup, fs.constants.COPYFILE_EXCL);
    else await fs.promises.writeFile(absent, '', { mode: 0o600, flag: 'wx' });
  }

  async backupMemory(profile, memoryStat) {
    const directory = this.backupDirectory(profile);
    const backup = path.join(directory, MEMORY_DIRECTORY);
    const absent = path.join(directory, `${MEMORY_DIRECTORY}.absent`);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(backup) || fs.existsSync(absent)) return;
    if (memoryStat) {
      await fs.promises.cp(path.join(profile.home, MEMORY_DIRECTORY), backup, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    } else {
      await fs.promises.writeFile(absent, '', { mode: 0o600, flag: 'wx' });
    }
  }

  async memoryLayout(profiles) {
    const entries = [];
    let directDirectories = 0;
    let projectMemoryFound = false;
    for (const profile of profiles) {
      const memoryPath = path.join(profile.home, MEMORY_DIRECTORY);
      let stat = null;
      try { stat = await fs.promises.lstat(memoryPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) {
        return { enabled: false, reason: 'top-level user-memory path is already an unrelated symlink' };
      }
      if (stat && !stat.isDirectory()) {
        return { enabled: false, reason: 'top-level user-memory path is not a directory' };
      }
      if (stat?.isDirectory()) directDirectories += 1;
      entries.push({ profile, path: memoryPath, stat });

      const projects = path.join(profile.home, 'projects');
      let projectEntries = [];
      try { projectEntries = await fs.promises.readdir(projects, { withFileTypes: true }); }
      catch { projectEntries = []; }
      for (const project of projectEntries) {
        if (!project.isDirectory()) continue;
        try {
          if ((await fs.promises.stat(path.join(projects, project.name, MEMORY_DIRECTORY))).isDirectory()) {
            projectMemoryFound = true;
            break;
          }
        } catch { /* no project memory at this path */ }
      }
    }
    if (directDirectories === 0) {
      return {
        enabled: false,
        reason: projectMemoryFound
          ? 'only project-scoped memory paths were found; the user-memory layout is ambiguous'
          : 'no top-level user-memory layout was found in the managed profiles',
      };
    }
    return { enabled: true, entries };
  }

  mergeMcpDocuments(documents) {
    const byName = new Map();
    for (const document of documents) {
      for (const [name, value] of Object.entries(document.mcpServers)) {
        const candidates = byName.get(name) || [];
        candidates.push({ document, value });
        byName.set(name, candidates);
      }
    }
    const mergedEntries = [];
    const conflicts = [];
    for (const name of [...byName.keys()].sort()) {
      const candidates = byName.get(name).sort((left, right) => {
        const mtime = (right.document.stat?.mtimeMs || 0) - (left.document.stat?.mtimeMs || 0);
        return mtime || left.document.profile.account.id.localeCompare(right.document.profile.account.id);
      });
      const winner = candidates[0];
      mergedEntries.push([name, winner.value]);
      if (candidates.some((candidate) => !isDeepStrictEqual(candidate.value, winner.value))) {
        conflicts.push({ name, winner: winner.document.profile.account.id });
      }
    }
    // Object.fromEntries treats names such as "__proto__" as ordinary own
    // properties; assignment into {} would mutate its prototype instead.
    return { mcpServers: Object.fromEntries(mergedEntries), conflicts };
  }

  mergeMcpChanges(documents, canonical) {
    const changes = new Map();
    for (const document of documents) {
      const hasSnapshot = document.lastApplied != null;
      const names = hasSnapshot
        ? new Set([...Object.keys(document.lastApplied), ...Object.keys(document.mcpServers)])
        : new Set(Object.keys(document.mcpServers));
      for (const name of names) {
        const baselineHas = hasSnapshot && Object.hasOwn(document.lastApplied, name);
        const documentHas = Object.hasOwn(document.mcpServers, name);
        if (hasSnapshot) {
          if (baselineHas === documentHas
            && (!baselineHas || isDeepStrictEqual(document.lastApplied[name], document.mcpServers[name]))) continue;
        } else if (Object.hasOwn(canonical, name)
          && isDeepStrictEqual(canonical[name], document.mcpServers[name])) continue;
        const candidates = changes.get(name) || [];
        candidates.push({
          document,
          deleted: !documentHas,
          value: document.mcpServers[name],
        });
        changes.set(name, candidates);
      }
    }

    const merged = new Map(Object.entries(canonical));
    for (const [name, candidates] of changes) {
      candidates.sort((left, right) => {
        const mtime = (right.document.stat?.mtimeMs || 0) - (left.document.stat?.mtimeMs || 0);
        return mtime || left.document.profile.account.id.localeCompare(right.document.profile.account.id);
      });
      const winner = candidates[0];
      if (winner.deleted) merged.delete(name);
      else merged.set(name, winner.value);
    }
    return Object.fromEntries(merged);
  }

  async mergeMemory(layout, conflicts) {
    const stage = path.join(this.sharedDir, `.memory-stage-${crypto.randomUUID()}`);
    await fs.promises.mkdir(stage, { recursive: true, mode: 0o700 });
    let itemCount = 0;
    try {
      const byName = new Map();
      for (const entry of layout.entries.filter((item) => item.stat?.isDirectory())) {
        for (const item of await fs.promises.readdir(entry.path, { withFileTypes: true })) {
          const source = path.join(entry.path, item.name);
          const stat = await fs.promises.lstat(source);
          const candidates = byName.get(item.name) || [];
          candidates.push({ entry, source, stat });
          byName.set(item.name, candidates);
        }
      }
      // Reserve every original name up front so a generated collision suffix
      // can never steal a real item name that sorts later in the merge.
      const occupied = new Set(byName.keys());
      for (const name of [...byName.keys()].sort()) {
        const candidates = byName.get(name).sort((left, right) => {
          const mtime = right.stat.mtimeMs - left.stat.mtimeMs;
          return mtime || left.entry.profile.account.id.localeCompare(right.entry.profile.account.id);
        });
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          const targetName = index === 0
            ? name
            : collisionName(name, candidate.entry.profile.account.id, occupied);
          occupied.add(targetName);
          await fs.promises.cp(candidate.source, path.join(stage, targetName), {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
          });
          itemCount += 1;
          if (index > 0) {
            conflicts.push({ name: `${MEMORY_DIRECTORY}/${name}`, winner: candidates[0].entry.profile.account.id });
          }
        }
      }

      const prior = path.join(this.sharedDir, `.memory-prior-${crypto.randomUUID()}`);
      let hadPrior = false;
      try {
        await fs.promises.rename(this.sharedMemoryDir, prior);
        hadPrior = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await fs.promises.rename(stage, this.sharedMemoryDir);
      } catch (error) {
        if (hadPrior) await fs.promises.rename(prior, this.sharedMemoryDir).catch(() => {});
        throw error;
      }
      if (hadPrior) await fs.promises.rm(prior, { recursive: true, force: true });
      return itemCount;
    } catch (error) {
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async linkMemory(entry) {
    const directory = this.backupDirectory(entry.profile);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    let prior = path.join(directory, `memory-prior-${Date.now()}`);
    let sequence = 2;
    while (fs.existsSync(prior)) {
      prior = path.join(directory, `memory-prior-${Date.now()}-${sequence}`);
      sequence += 1;
    }
    let moved = false;
    try {
      if (entry.stat) {
        await fs.promises.rename(entry.path, prior);
        moved = true;
      }
      await fs.promises.symlink(this.sharedMemoryDir, entry.path, 'dir');
    } catch (error) {
      await fs.promises.unlink(entry.path).catch(() => {});
      if (moved) await fs.promises.rename(prior, entry.path).catch(() => {});
      throw error;
    }
  }

  async materializeMemory(profile) {
    const memoryPath = path.join(profile.home, MEMORY_DIRECTORY);
    let stat = null;
    try { stat = await fs.promises.lstat(memoryPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      const target = await fs.promises.realpath(memoryPath).catch(() => null);
      const shared = await fs.promises.realpath(this.sharedMemoryDir).catch(() => null);
      if (!shared || target !== shared) throw new Error('managed user-memory symlink no longer points to the shared directory');
    }
    const stage = `${memoryPath}.modeldeck-materialize-${crypto.randomUUID()}`;
    await fs.promises.cp(this.sharedMemoryDir, stage, { recursive: true, dereference: false });
    const prior = `${memoryPath}.modeldeck-prior-${crypto.randomUUID()}`;
    let moved = false;
    try {
      if (stat) {
        await fs.promises.rename(memoryPath, prior);
        moved = true;
      }
      await fs.promises.rename(stage, memoryPath);
      if (moved) await fs.promises.rm(prior, { recursive: true, force: true });
    } catch (error) {
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (moved) await fs.promises.rename(prior, memoryPath).catch(() => {});
      throw error;
    }
  }

  async restoreMemoryWithoutManifest(profiles) {
    let restored = 0;
    let usedShared = false;
    let usedBackup = false;
    let usedEmpty = false;
    let sharedMemoryStat = null;
    try { sharedMemoryStat = await fs.promises.lstat(this.sharedMemoryDir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const profile of profiles) {
      const memoryPath = path.join(profile.home, MEMORY_DIRECTORY);
      let stat = null;
      try { stat = await fs.promises.lstat(memoryPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!stat?.isSymbolicLink()) continue;

      const link = await fs.promises.readlink(memoryPath);
      const configuredTarget = path.resolve(path.dirname(memoryPath), link);
      const target = await fs.promises.realpath(memoryPath).catch(() => null);
      const shared = await fs.promises.realpath(this.sharedDir).catch(() => null);
      const managed = target != null && shared != null
        ? pathIsWithin(target, shared)
        : pathIsWithin(configuredTarget, path.resolve(this.sharedDir));
      if (!managed) continue;

      const backup = path.join(this.backupDirectory(profile), MEMORY_DIRECTORY);
      const stage = `${memoryPath}.modeldeck-materialize-${crypto.randomUUID()}`;
      let backupStat = null;
      try { backupStat = await fs.promises.lstat(backup); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (sharedMemoryStat?.isDirectory()) {
        await fs.promises.cp(this.sharedMemoryDir, stage, { recursive: true, dereference: false });
        usedShared = true;
      } else if (backupStat?.isDirectory()) {
        await fs.promises.cp(backup, stage, { recursive: true, dereference: false });
        usedBackup = true;
      } else {
        await fs.promises.mkdir(stage, { mode: 0o700 });
        usedEmpty = true;
      }

      const prior = `${memoryPath}.modeldeck-prior-${crypto.randomUUID()}`;
      let moved = false;
      try {
        await fs.promises.rename(memoryPath, prior);
        moved = true;
        await fs.promises.rename(stage, memoryPath);
        await fs.promises.unlink(prior);
        restored += 1;
      } catch (error) {
        await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
        if (moved) await fs.promises.rename(prior, memoryPath).catch(() => {});
        throw error;
      }
    }
    return { restored, usedShared, usedBackup, usedEmpty };
  }

  async attachMemoryProfiles(profiles) {
    const manifest = this.readJsonSync(this.manifestFile, {});
    if (!manifest.memoryEnabled) return;
    const mergedProfiles = new Set(Array.isArray(manifest.mergedProfiles) ? manifest.mergedProfiles : []);
    await fs.promises.mkdir(this.sharedMemoryDir, { recursive: true, mode: 0o700 });
    for (const profile of profiles) {
      const memoryPath = path.join(profile.home, MEMORY_DIRECTORY);
      let stat = null;
      try { stat = await fs.promises.lstat(memoryPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) {
        const target = await fs.promises.realpath(memoryPath).catch(() => null);
        const shared = await fs.promises.realpath(this.sharedMemoryDir).catch(() => null);
        if (target === shared) continue;
        throw new Error('top-level user-memory path is an unrelated symlink');
      }
      if (stat && !stat.isDirectory()) throw new Error('top-level user-memory path is not a directory');
      await this.backupMemory(profile, stat);
      if (stat?.isDirectory() && !mergedProfiles.has(profile.account.id)) {
        const occupied = new Set(await fs.promises.readdir(this.sharedMemoryDir));
        for (const item of await fs.promises.readdir(memoryPath, { withFileTypes: true })) {
          const targetName = occupied.has(item.name)
            ? collisionName(item.name, profile.account.id, occupied)
            : item.name;
          occupied.add(targetName);
          const target = path.join(this.sharedMemoryDir, targetName);
          const temporary = `${target}.modeldeck-${crypto.randomUUID()}`;
          try {
            await fs.promises.cp(path.join(memoryPath, item.name), temporary, {
              recursive: true,
              dereference: false,
              errorOnExist: true,
              force: false,
            });
            await fs.promises.rename(temporary, target);
          } catch (error) {
            await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
            throw error;
          }
        }
      }
      if (!mergedProfiles.has(profile.account.id)) {
        mergedProfiles.add(profile.account.id);
        await this.atomicWriteJson(this.manifestFile, {
          ...manifest,
          mergedProfiles: [...mergedProfiles].sort(),
        });
      }
      await this.linkMemory({ profile, path: memoryPath, stat });
    }
  }

  async detachProfile(account) {
    if (!account || account.provider !== 'claude') return;
    if (this.operation) throw new SharedScopeOperationConflictError();
    if (!this.store.getSettings().sharedUserScopeEnabled) return;
    const profile = this.managedProfiles().find((item) => item.account.id === account.id);
    if (!profile) return;
    await this.detachManagedProfile(profile);
  }

  async detachManagedProfile(profile) {
    const manifest = this.readJsonSync(this.manifestFile, {});
    if (manifest.memoryEnabled) await this.materializeMemory(profile);
  }

  async profileSetChanged() {
    if (this.operation) throw new SharedScopeOperationConflictError();
    await this.profileSetChangedUnlocked();
  }

  async profileSetChangedUnlocked() {
    if (!this.store.getSettings().sharedUserScopeEnabled) return;
    await this.reconcile({ force: true });
    this.startWatchers();
  }

  deferProfileSetChanged() {
    return this.deferUntilOperationCompletes(() => this.profileSetChangedUnlocked());
  }

  deferDetachProfile(account) {
    const profile = this.managedProfiles().find((item) => item.account.id === account?.id);
    if (!profile) return Promise.resolve();
    return this.deferUntilOperationCompletes(() => this.detachManagedProfile(profile));
  }

  deferUntilOperationCompletes(task) {
    const deferred = this.deferredTail.then(async () => {
      // A second enable/disable can claim the guard after the operation that
      // caused this deferral. Wait until the guard is genuinely free, then
      // hold it for the deferred filesystem work as well.
      while (this.operation) await this.operation;
      return this.runOperation(task);
    });
    this.deferredTail = deferred.catch(() => {});
    return deferred;
  }

  async persistOutcome(outcome) {
    this.lastOutcome = outcome;
    await this.atomicWriteJson(this.outcomeFile, outcome);
  }

  async runOperation(operation) {
    if (this.operation) throw new SharedScopeOperationConflictError();
    let markComplete;
    const completion = new Promise((resolve) => { markComplete = resolve; });
    this.operation = completion;
    try { return await operation(); }
    finally {
      if (this.operation === completion) this.operation = null;
      markComplete();
    }
  }

  initialized() {
    return fs.existsSync(this.canonicalMcpFile) && fs.existsSync(this.manifestFile);
  }

  async enable({ persistSetting = true } = {}) {
    return this.runOperation(async () => {
      if (this.store.getSettings().sharedUserScopeEnabled && persistSetting && this.initialized()) {
        await this.reconcile({ force: true });
        this.startWatchers();
        return this.lastOutcome || emptyOutcome(true);
      }
      await fs.promises.mkdir(this.sharedDir, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(this.sharedDir, 0o700);
      const profiles = this.managedProfiles();
      const skipped = [];
      const documents = await this.readableMcpDocuments(profiles, skipped);
      const layout = await this.memoryLayout(profiles);
      if (!layout.enabled) skipped.push({ what: 'memory', reason: layout.reason });

      // Complete the backup phase for every file we may touch before the
      // first canonical/profile mutation begins.
      for (const document of documents) await this.backupFile(document);
      if (layout.enabled) {
        for (const entry of layout.entries) await this.backupMemory(entry.profile, entry.stat);
      }

      const mergedMcp = this.mergeMcpDocuments(documents);
      const conflicts = [...mergedMcp.conflicts];
      await this.atomicWriteJsonIfChanged(this.canonicalMcpFile, mergedMcp.mcpServers);
      const memoryItems = layout.enabled ? await this.mergeMemory(layout, conflicts) : 0;
      for (const document of documents) await this.writeMcpDocument(document, mergedMcp.mcpServers);
      // Persist recovery intent before replacing the first profile directory.
      // If the process stops mid-loop, startup knows these profiles were
      // already included in shared/memory and links them without duplicating
      // their items into the canonical directory.
      await this.atomicWriteJson(this.manifestFile, {
        memoryEnabled: layout.enabled,
        memoryPath: MEMORY_DIRECTORY,
        mergedProfiles: layout.enabled
          ? layout.entries.map((entry) => entry.profile.account.id).sort()
          : [],
      });
      // From this point the canonical files contain a recoverable enabled
      // state. Persist the opt-in before the first directory replacement so
      // startup will finish a partially completed link loop after a crash.
      if (persistSetting) this.store.saveSettings({ sharedUserScopeEnabled: true });
      if (layout.enabled) {
        for (const entry of layout.entries) await this.linkMemory(entry);
      }
      const outcome = {
        enabled: true,
        merged: { mcpServers: Object.keys(mergedMcp.mcpServers).length, memoryItems },
        conflicts,
        skipped,
      };
      await this.persistOutcome(outcome);
      this.startWatchers();
      return outcome;
    });
  }

  async disable({ persistSetting = true } = {}) {
    return this.runOperation(async () => {
      if (!this.store.getSettings().sharedUserScopeEnabled && persistSetting) {
        return this.lastOutcome?.enabled === false ? this.lastOutcome : emptyOutcome(false);
      }
      // Close the debounce race: an edit immediately followed by Disable is
      // still part of the live shared set and must reach the canonical copy
      // before every profile is materialized independently.
      await this.reconcile({ force: true });
      this.stopWatchers();
      const skipped = [];
      const profiles = this.managedProfiles();
      const documents = await this.readableMcpDocuments(profiles, skipped);
      let canonical = {};
      try {
        canonical = JSON.parse(await fs.promises.readFile(this.canonicalMcpFile, 'utf8'));
        if (!jsonObject(canonical)) throw new Error('canonical mcpServers must be an object');
      } catch (error) {
        if (error.code !== 'ENOENT') skipped.push({ what: 'mcpServers', reason: 'canonical mcpServers could not be read during disable' });
      }
      for (const document of documents) await this.writeMcpDocument(document, canonical);
      let manifest = null;
      try {
        manifest = JSON.parse(await fs.promises.readFile(this.manifestFile, 'utf8'));
        if (!jsonObject(manifest)) throw new Error('shared-scope manifest must be an object');
      } catch {
        const recovery = await this.restoreMemoryWithoutManifest(profiles);
        if (recovery.usedBackup || recovery.usedEmpty) {
          skipped.push({
            what: 'memory',
            reason: `shared-scope manifest missing or unreadable during disable; restored ${recovery.restored} managed profile${recovery.restored === 1 ? '' : 's'} from backups or empty directories`,
          });
        }
      }
      if (manifest?.memoryEnabled) {
        // Do not claim sharing is disabled while even one managed profile is
        // still a shared symlink. A filesystem failure leaves the opt-in bit
        // enabled so the operation can be retried safely.
        for (const profile of profiles) await this.materializeMemory(profile);
      }
      if (persistSetting) this.store.saveSettings({ sharedUserScopeEnabled: false });
      const outcome = emptyOutcome(false, skipped);
      await this.persistOutcome(outcome);
      return outcome;
    });
  }

  async applySettings(previous, settings) {
    if (previous.sharedUserScopeEnabled !== settings.sharedUserScopeEnabled) {
      return settings.sharedUserScopeEnabled
        ? this.enable({ persistSetting: false })
        : this.disable({ persistSetting: false });
    }
    if (settings.sharedUserScopeEnabled) {
      if (this.operation) throw new SharedScopeOperationConflictError();
      await this.reconcile({ force: true });
      this.startWatchers();
    }
    return null;
  }

  async reconcile({ force = false } = {}) {
    if (!force && !this.store.getSettings().sharedUserScopeEnabled) return null;
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = (async () => {
      const skipped = [];
      const documents = await this.readableMcpDocuments(this.managedProfiles(), skipped);
      let canonical = null;
      try {
        canonical = JSON.parse(await fs.promises.readFile(this.canonicalMcpFile, 'utf8'));
        if (!jsonObject(canonical)) canonical = null;
      } catch { /* enable creates the canonical copy; startup may predate it */ }
      const merged = canonical == null
        ? this.mergeMcpDocuments(documents).mcpServers
        : this.mergeMcpChanges(documents, canonical);
      if (!isDeepStrictEqual(canonical, merged)) await this.atomicWriteJson(this.canonicalMcpFile, merged);
      // A profile registered after sharing was enabled gets the same backup-
      // before-touch guarantee as profiles present during the enable merge.
      for (const document of documents) await this.backupFile(document);
      for (const document of documents) await this.writeMcpDocument(document, merged);
      await this.attachMemoryProfiles(documents.map((document) => document.profile));
      return merged;
    })();
    try { return await this.reconcilePromise; }
    finally { this.reconcilePromise = null; }
  }

  scheduleReconcile() {
    if (this.reconcileTimer != null) this.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = this.setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile().catch(() => {
        // Do not put provider paths (which may contain account labels) into
        // daemon logs. The API operation surfaces actionable errors directly.
        console.error('[modeldeck] shared-scope reconcile failed');
      });
    }, this.debounceMs);
    this.reconcileTimer?.unref?.();
  }

  startWatchers() {
    if (!this.store.getSettings().sharedUserScopeEnabled) return;
    const profiles = this.managedProfiles();
    const current = new Set(profiles.map((profile) => profile.home));
    for (const [home, watcher] of this.watchers) {
      if (current.has(home)) continue;
      try { watcher.close(); } catch { /* already closed */ }
      this.watchers.delete(home);
    }
    for (const profile of profiles) {
      if (this.watchers.has(profile.home)) continue;
      try {
        const watcher = this.watch(profile.home, (_event, filename) => {
          if (filename == null || path.basename(String(filename)) === MCP_FILE) this.scheduleReconcile();
        });
        watcher.on?.('error', () => {});
        watcher.unref?.();
        this.watchers.set(profile.home, watcher);
      } catch {
        // Startup and settings reconciliation remain available if watching is
        // unsupported for an individual profile.
      }
    }
  }

  async start() {
    if (!this.store.getSettings().sharedUserScopeEnabled) return;
    // A crash after the PUT persisted its opt-in bit but before enable wrote
    // the canonical files must resume the union/backup phase, not choose one
    // newest whole section and discard unique servers from other profiles.
    if (!this.initialized()) {
      await this.enable({ persistSetting: false });
      return;
    }
    await this.reconcile({ force: true });
    this.startWatchers();
  }

  stopWatchers() {
    if (this.reconcileTimer != null) this.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    this.watchers.clear();
  }

  status() {
    return {
      enabled: this.store.getSettings().sharedUserScopeEnabled,
      lastOutcome: this.lastOutcome,
    };
  }
}
