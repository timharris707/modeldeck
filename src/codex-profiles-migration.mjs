import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function within(file, root) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function statOrNull(file, io) {
  try { return await io.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/// True when text names the legacy root itself or a path below it; a sibling
/// such as `<root>-backup` shares the prefix but is not a legacy reference.
function referencesLegacyDir(text, legacyDir) {
  const escaped = legacyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?:/|$|\\s)`).test(text);
}

/// Scan all open files/cwds below the old root, including explicitly pinned
/// CODEX_HOME sessions. Only lsof's unambiguous no-match exit means idle.
export async function legacyCodexProfilesInUse(legacyDir, exec = execFileAsync) {
  return (await legacyCodexProfilesUsage(legacyDir, exec)).inUse;
}

/// Only executable basenames leave the inspection. Command/environment output
/// is used solely for the existing blocking decision and is never reported.
export async function legacyCodexProfilesUsage(legacyDir, exec = execFileAsync) {
  const holders = new Set();
  const busy = () => ({ inUse: true, holders: [...holders] });
  // CLI sessions block even without open files. Bundled app servers only
  // block when they reference the legacy root; lsof also checks their cwd.
  let pids = [];
  try {
    const running = await exec('/usr/bin/pgrep', ['-x', 'codex'], { timeout: 10_000, maxBuffer: 1_000_000 });
    pids = String(running.stdout || '').trim().split('\n');
    if (String(running.stderr || '').trim() || !pids.every((pid) => /^[1-9]\d*$/.test(pid))) {
      throw new Error('process inspection inconclusive');
    }
  } catch (error) {
    // pgrep exits 1 with no output when nothing matches.
    if (!(error.code === 1 && !error.signal && !error.killed && !String(error.stdout || '').trim()
        && !String(error.stderr || '').trim())) {
      throw new Error('process inspection unavailable');
    }
  }
  try {
    for (const pid of pids) {
      const result = await exec('/bin/ps', ['-ww', '-o', 'comm=', '-p', pid], { timeout: 10_000, maxBuffer: 1_000_000 });
      const executable = String(result.stdout || '').trim();
      if (String(result.stderr || '').trim() || !/^\/[^\r\n]+\/codex$/.test(executable)) {
        throw new Error('process inspection inconclusive');
      }
      if (!/\.app\/Contents\/(?:Resources|Frameworks)\//.test(executable)) {
        holders.add('codex');
        continue;
      }
      // -E includes the launch environment, which lsof cannot inspect.
      // Never log this output: it may contain credentials.
      const details = await exec('/bin/ps', ['-ww', '-E', '-o', 'command=', '-p', pid], {
        timeout: 10_000, maxBuffer: 1_000_000,
      });
      const command = String(details.stdout || '').trim();
      if (String(details.stderr || '').trim() || /[\r\n]/.test(command)
          || !(command === executable || command.startsWith(`${executable} `))) {
        throw new Error('process inspection inconclusive');
      }
      if (referencesLegacyDir(executable, legacyDir) || referencesLegacyDir(command, legacyDir)) holders.add('codex');
    }
  } catch {
    if (holders.size) return busy();
    throw new Error('process inspection unavailable');
  }
  let result;
  try {
    result = await exec('/usr/sbin/lsof', ['-n', '-P', '-F', 'p', '+D', legacyDir], {
      timeout: 10_000, maxBuffer: 1_000_000,
    });
  } catch (error) {
    if (error.code === 1 && !error.signal && !error.killed && !String(error.stdout || '').trim()
        && !String(error.stderr || '').trim()) return { inUse: holders.size > 0, holders: [...holders] };
    if (holders.size) return busy();
    throw new Error('process inspection unavailable');
  }
  if (String(result.stderr || '').trim()) {
    if (holders.size) return busy();
    throw new Error('process inspection incomplete');
  }
  const openPids = [...new Set([...String(result.stdout || '').matchAll(/^p(\d+)$/gm)].map((match) => match[1]))];
  if (openPids.length) {
    for (const pid of openPids) {
      try {
        const detail = await exec('/bin/ps', ['-ww', '-o', 'comm=', '-p', pid], { timeout: 10_000, maxBuffer: 1_000_000 });
        const executable = String(detail.stdout || '').trim();
        if (!String(detail.stderr || '').trim() && /^\/[^\r\n]+$/.test(executable)) {
          holders.add(path.basename(executable));
        }
      } catch { /* An unreadable or exited holder still blocks the move. */ }
    }
    return busy();
  }
  if (holders.size) return busy();
  throw new Error('process inspection inconclusive');
}

function owned(stat, uid) {
  if (uid == null || stat.uid !== uid || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) {
    throw new Error('unsafe ownership or permissions');
  }
}

async function directoryGuard(directory, io, uid, expectedIdentity) {
  const initial = await io.lstat(directory);
  owned(initial, uid);
  const identity = expectedIdentity || { dev: initial.dev, ino: initial.ino };
  if (initial.dev !== identity.dev || initial.ino !== identity.ino) throw new Error('migration directory changed');
  const initialMode = initial.mode;
  const canonical = await io.realpath(directory);
  const check = async () => {
    const current = await io.lstat(directory);
    owned(current, uid);
    if (!current.isDirectory() || current.isSymbolicLink() || current.mode !== initialMode
        || current.dev !== identity.dev || current.ino !== identity.ino || await io.realpath(directory) !== canonical) {
      throw new Error('migration directory changed');
    }
  };
  await check();
  return Object.assign(check, { identity });
}

/// Hash regular files through no-follow handles; record symlinks without
/// reading their targets. No credential bytes or digests leave this module.
async function snapshot(root, io, uid) {
  const entries = [];
  async function visit(file, relative) {
    const stat = await io.lstat(file);
    owned(stat, uid);
    const entry = { path: relative, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) {
      entries.push({ ...entry, kind: 'link', target: await io.readlink(file) });
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, kind: 'dir' });
      for (const name of (await io.readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
    } else if (stat.isFile() && stat.nlink === 1) {
      const handle = await io.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('file changed during verification');
        const hash = crypto.createHash('sha256');
        for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error('file changed during verification');
        }
        entries.push({ ...entry, kind: 'file', size: after.size, hash: hash.digest('hex') });
      } finally { await handle.close(); }
    } else {
      throw new Error('unsupported file type or hard link');
    }
  }
  await visit(root, '');
  return entries;
}

async function verify(root, expected, io, uid) {
  if (JSON.stringify(await snapshot(root, io, uid)) !== JSON.stringify(expected)) {
    throw new Error('tree verification failed');
  }
}

async function copyVerified(from, to, expected, io, uid) {
  await io.cp(from, to, {
    recursive: true, force: false, errorOnExist: true,
    dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
  });
  await verify(to, expected, io, uid);
  await verify(from, expected, io, uid);
}

async function replaceLink(link, target, io) {
  const temporary = path.join(path.dirname(link), `.codex-migration-${crypto.randomUUID()}`);
  try {
    await io.symlink(target, temporary, 'dir');
    await io.rename(temporary, link);
  } catch (error) {
    await io.unlink(temporary).catch(() => {});
    throw error;
  }
}

/// The database publishes last: every fallible filesystem operation must
/// succeed first. Backups remain inert recovery data, never another CODEX_HOME.
export async function migrateCodexProfilesDir({
  store, legacyDir, profilesDir, activeLink, dataDir,
  io = fs.promises, isLegacyInUse = legacyCodexProfilesUsage, isDaemonBusy = () => false,
  uid = process.getuid?.(), now = () => new Date(), log = () => {},
}) {
  const report = (message) => { try { log(message); } catch { /* Logging cannot affect the transaction. */ } };
  if (!legacyDir) return {};
  let stage = 'checking directories';
  let processDeferred = false;
  let holders = [];
  let backupDir;
  let rootMoved = false;
  let movedRootIdentity;
  let aliasCreated = false;
  let createdDestination = false;
  let markerCreated = false;
  let activeChanged = false;
  let previousLink;
  let nextLink;
  let accounts = [];
  let legacyGuard;
  let destinationGuard;
  let backupGuard;
  let backupProfilesGuard;
  const guards = [];
  const checkRoots = async () => { for (const check of guards) await check(); };
  const moved = [];
  const marker = path.join(profilesDir, '.migrated-from');
  try {
    // Issue #717: an unregistered root may belong to another install, not
    // this store. The store records canonical paths, so a legacy root reached
    // through a symlinked parent (review of PR #721) is matched by its real
    // spelling too; the guard runs before any filesystem mutation.
    const registeredUnder = (root) => store.listAccounts().filter((account) => account.provider === 'codex'
      && (account.profileRef === root || within(account.profileRef, root)));
    accounts = registeredUnder(legacyDir);
    if (!accounts.length) {
      // A finished move leaves the legacy path as an alias onto the
      // destination; accounts already there are not "under the legacy root".
      const canonicalLegacy = await io.realpath(legacyDir).catch(() => null);
      const destination = path.resolve(profilesDir);
      if (canonicalLegacy && canonicalLegacy !== legacyDir
          && canonicalLegacy !== destination && !within(canonicalLegacy, destination)) {
        accounts = registeredUnder(canonicalLegacy);
      }
    }
    if (!accounts.length) {
      report(`Codex legacy profiles at ${legacyDir} are not registered to any account; leaving them in place`);
      return {};
    }
    const legacyStat = await statOrNull(legacyDir, io);
    if (!legacyStat) {
      if (accounts.length) throw new Error('registered legacy root is missing');
      return {};
    }
    if (legacyStat.isSymbolicLink()) {
      const target = await io.readlink(legacyDir);
      const destination = path.resolve(profilesDir);
      if (legacyStat.uid !== uid || path.resolve(path.dirname(legacyDir), target) !== destination) {
        throw new Error('legacy root is not a real directory');
      }
      const stat = await io.lstat(destination);
      owned(stat, uid);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error('destination is not a private directory');
      }
      const canonical = await io.realpath(destination);
      if (await io.realpath(legacyDir) !== canonical) throw new Error('legacy alias changed');
      const resolved = await io.lstat(canonical);
      if (!resolved.isDirectory() || resolved.isSymbolicLink() || resolved.dev !== stat.dev || resolved.ino !== stat.ino) {
        throw new Error('destination changed');
      }
      destinationGuard = await directoryGuard(destination, io, uid);
      if (destinationGuard.identity.dev !== stat.dev || destinationGuard.identity.ino !== stat.ino) {
        throw new Error('destination changed');
      }
      const accountMoves = [];
      for (const account of accounts) {
        const to = path.join(destination, path.relative(legacyDir, account.profileRef));
        const profile = await io.lstat(to);
        owned(profile, uid);
        if (!profile.isDirectory() || profile.isSymbolicLink() || (profile.mode & 0o077) !== 0) {
          throw new Error('registered profile unavailable');
        }
        accountMoves.push({ id: account.id, from: account.profileRef, to });
      }
      stage = 'publishing account references';
      await destinationGuard();
      if (accountMoves.length) store.repointCodexProfiles(accountMoves);
      return {};
    }
    if (!legacyStat.isDirectory()) throw new Error('legacy root is not a real directory');
    owned(legacyStat, uid);
    legacyDir = await io.realpath(legacyDir);
    legacyGuard = await directoryGuard(legacyDir, io, uid);
    guards.push(legacyGuard);
    profilesDir = path.resolve(profilesDir);
    if (profilesDir === legacyDir) return {}; // Explicit legacy env override.
    if (within(profilesDir, legacyDir) || within(legacyDir, profilesDir)) throw new Error('overlapping roots');
    let destinationStat = await statOrNull(profilesDir, io);
    accounts = store.listAccounts().filter((account) => account.provider === 'codex'
      && (account.profileRef === legacyDir || within(account.profileRef, legacyDir)));
    const names = (await io.readdir(legacyDir)).sort();
    if (destinationStat) {
      owned(destinationStat, uid);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink() || (destinationStat.mode & 0o077) !== 0) {
        throw new Error('destination is not a private directory');
      }
      destinationGuard = await directoryGuard(profilesDir, io, uid);
      guards.push(destinationGuard);
      if ((await io.readdir(profilesDir)).length) {
        if (accounts.length) throw new Error('destination already populated');
        return {};
      }
    }
    if (!names.length) {
      if (accounts.length) throw new Error('registered legacy profile is missing');
      return {};
    }
    const ensureIdle = async (inspect = isLegacyInUse) => {
      try {
        const usage = await inspect(legacyDir);
        // Keep boolean injection compatibility and fail closed on unknown results.
        if (usage === false || usage?.inUse === false) return;
        holders = [...new Set((usage?.holders || []).filter((name) => typeof name === 'string'
          && name && !/[\/\\\r\n\x00-\x1f]/.test(name) && !name.includes('CODEX_HOME')))];
        throw new Error('legacy profiles are in use');
      } catch {
        processDeferred = true;
        throw new Error('process inspection deferred');
      }
    };
    const ensureCopyIdle = async () => {
      await ensureIdle();
      await ensureIdle(isDaemonBusy);
    };
    const destinationParent = await io.realpath(path.dirname(profilesDir));
    const canonicalDestination = path.join(destinationParent, path.basename(profilesDir));
    if (canonicalDestination === legacyDir || within(canonicalDestination, legacyDir)
        || within(legacyDir, canonicalDestination)) throw new Error('overlapping canonical roots');
    renamePath: if (legacyGuard.identity.dev === (await io.lstat(destinationParent)).dev) {
      stage = 'validating profile directories';
      // CodeRabbit (PR #695): a rename would carry a non-private root mode
      // onto the destination, so it must not rename; but before #693 such an
      // install migrated through the verified copy (which recreates the root
      // owner-only), so it falls through to the copy path, never aborts.
      if ((legacyStat.mode & 0o077) !== 0) break renamePath;
      for (const name of names) {
        if (name === '.migrated-from') throw new Error('reserved migration marker at source');
        const stat = await io.lstat(path.join(legacyDir, name));
        owned(stat, uid);
        if (stat.isDirectory() && (stat.mode & 0o077) !== 0) throw new Error('profile is not a private directory');
      }
      const accountMoves = [];
      for (const account of accounts) {
        if (!names.some((name) => account.profileRef === path.join(legacyDir, name)
            || within(account.profileRef, path.join(legacyDir, name)))) {
          throw new Error('registered profile not present in legacy tree');
        }
        const stat = await io.lstat(account.profileRef);
        owned(stat, uid);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
          throw new Error('registered profile unavailable');
        }
        accountMoves.push({ id: account.id, from: account.profileRef, to: path.join(profilesDir, path.relative(legacyDir, account.profileRef)) });
      }
      const activeStat = await statOrNull(activeLink, io);
      if (activeStat?.isSymbolicLink()) {
        previousLink = await io.readlink(activeLink);
        const target = await io.realpath(activeLink);
        if (within(target, legacyDir)) nextLink = path.join(profilesDir, path.relative(legacyDir, target));
      }
      guards.push(await directoryGuard(dataDir, io, uid));
      guards.push(await directoryGuard(path.dirname(profilesDir), io, uid));
      stage = 'checking for daemon work';
      await ensureIdle(isDaemonBusy);
      await checkRoots();
      if (destinationStat) {
        await io.rmdir(profilesDir);
        guards.splice(guards.indexOf(destinationGuard), 1);
        destinationStat = null;
        destinationGuard = null;
      }
      stage = 'renaming profiles';
      await legacyGuard();
      try { await io.rename(legacyDir, profilesDir); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        break renamePath;
      }
      rootMoved = true;
      const movedRootStat = await io.lstat(profilesDir);
      movedRootIdentity = { dev: movedRootStat.dev, ino: movedRootStat.ino };
      if (movedRootStat.dev !== legacyGuard.identity.dev || movedRootStat.ino !== legacyGuard.identity.ino) {
        processDeferred = true;
        throw new Error('source directory changed during rename');
      }
      stage = 'aliasing the old location';
      try {
        // symlink is no-replace: an intervening entry must never be overwritten.
        await io.symlink(profilesDir, legacyDir, 'dir');
        aliasCreated = true;
      } catch (error) {
        if (['EEXIST', 'EISDIR', 'ENOTDIR'].includes(error.code)) processDeferred = true;
        throw error;
      }
      destinationGuard = await directoryGuard(profilesDir, io, uid, movedRootIdentity);
      await destinationGuard();
      stage = 'repointing the active link';
      if (nextLink) {
        if (await io.readlink(activeLink) !== previousLink) throw new Error('active link changed during migration');
        await replaceLink(activeLink, nextLink, io);
        activeChanged = true;
      }
      stage = 'writing the migration marker';
      await destinationGuard();
      const markerHandle = await io.open(marker, 'wx', 0o600);
      markerCreated = true;
      try {
        await markerHandle.writeFile(`${JSON.stringify({ legacyDir, migratedAt: now().toISOString(), alias: true }, null, 2)}\n`);
        await markerHandle.sync();
      } finally { await markerHandle.close(); }
      stage = 'publishing account references';
      await destinationGuard();
      store.repointCodexProfiles(accountMoves);
      report('Codex profiles moved. The old ~/.codex-profiles location now points at the new one; leave it in place while ChatGPT or Codex sessions are running.');
      return { migrated: true };
    }
    stage = 'checking for running processes';
    await ensureCopyIdle();
    stage = 'validating profile trees';
    const entries = [];
    for (const name of names) {
      if (name === '.migrated-from') throw new Error('reserved migration marker at source');
      const from = path.join(legacyDir, name);
      const stat = await io.lstat(from);
      if (stat.isDirectory() && (stat.mode & 0o077) !== 0) {
        throw new Error('profile is not a private directory');
      }
      const tree = await snapshot(from, io, uid);
      for (const item of tree.filter((entry) => entry.kind === 'link')) {
        const target = path.resolve(path.dirname(path.join(from, item.path)), item.target);
        // External absolute links and internal relative links keep their
        // meaning after the move. Refuse links whose meaning would change.
        if (path.isAbsolute(item.target) ? target === legacyDir || within(target, legacyDir) : !within(target, legacyDir)) {
          throw new Error('symlink would change meaning after migration');
        }
      }
      entries.push({ from, to: path.join(profilesDir, name), name, tree });
    }
    const accountMoves = [];
    for (const account of accounts) {
      if (!entries.some((entry) => account.profileRef === entry.from || within(account.profileRef, entry.from))) {
        throw new Error('registered profile not present in legacy tree');
      }
      const stat = await io.lstat(account.profileRef);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('registered profile unavailable');
      accountMoves.push({ id: account.id, from: account.profileRef, to: path.join(profilesDir, path.relative(legacyDir, account.profileRef)) });
    }
    const activeStat = await statOrNull(activeLink, io);
    if (activeStat?.isSymbolicLink()) {
      previousLink = await io.readlink(activeLink);
      const target = await io.realpath(activeLink);
      if (within(target, legacyDir)) nextLink = path.join(profilesDir, path.relative(legacyDir, target));
    }
    stage = 'creating and verifying recovery backup';
    guards.push(await directoryGuard(dataDir, io, uid));
    guards.push(await directoryGuard(path.dirname(profilesDir), io, uid));
    const checkedDestination = path.join(await io.realpath(path.dirname(profilesDir)), path.basename(profilesDir));
    if (checkedDestination === legacyDir || within(checkedDestination, legacyDir)
        || within(legacyDir, checkedDestination)) throw new Error('overlapping canonical roots');
    await checkRoots();
    backupDir = path.join(dataDir, `.codex-profiles-backup-${crypto.randomUUID()}`);
    await io.mkdir(backupDir, { mode: 0o700 });
    await io.mkdir(path.join(backupDir, 'profiles'), { mode: 0o700 });
    backupGuard = await directoryGuard(backupDir, io, uid);
    backupProfilesGuard = await directoryGuard(path.join(backupDir, 'profiles'), io, uid);
    guards.push(backupGuard, backupProfilesGuard);
    const migratedAt = now().toISOString();
    await io.writeFile(path.join(backupDir, 'restore.json'), `${JSON.stringify({
      legacyDir, profilesDir, activeLink, previousLink, accountMoves, migratedAt,
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    for (const entry of entries) {
      await checkRoots();
      await copyVerified(entry.from, path.join(backupDir, 'profiles', entry.name), entry.tree, io, uid);
    }
    stage = 'moving and verifying profiles';
    await ensureCopyIdle();
    await checkRoots();
    if (!destinationStat) {
      await io.mkdir(profilesDir, { mode: 0o700 });
      createdDestination = true;
      destinationGuard = await directoryGuard(profilesDir, io, uid);
      guards.push(destinationGuard);
    }
    for (const entry of entries) {
      await ensureCopyIdle();
      await verify(entry.from, entry.tree, io, uid);
      await checkRoots();
      if (await statOrNull(entry.to, io)) throw new Error('destination entry appeared during migration');
      // Record before copy/remove: even a partially failed EXDEV removal
      // must restore the original tree from the verified destination.
      try {
        await io.rename(entry.from, entry.to);
        moved.push({ ...entry, removed: true });
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        const copied = { ...entry, removed: false };
        moved.push(copied);
        await copyVerified(entry.from, entry.to, entry.tree, io, uid);
        await ensureCopyIdle();
        await checkRoots();
        copied.removed = true;
        await io.rm(entry.from, { recursive: true });
      }
      await verify(entry.to, entry.tree, io, uid);
      await checkRoots();
    }
    if ((await io.readdir(legacyDir)).length) throw new Error('legacy tree changed during migration');
    stage = 'repointing the active link';
    await checkRoots();
    if (nextLink) {
      if (await io.readlink(activeLink) !== previousLink) throw new Error('active link changed during migration');
      await replaceLink(activeLink, nextLink, io);
      activeChanged = true;
    }
    stage = 'writing the migration marker';
    await checkRoots();
    const markerHandle = await io.open(marker, 'wx', 0o600);
    markerCreated = true;
    try {
      await markerHandle.writeFile(`${JSON.stringify({ legacyDir, migratedAt, backupDir }, null, 2)}\n`);
      await markerHandle.sync();
    } finally { await markerHandle.close(); }
    stage = 'publishing account references';
    await checkRoots();
    store.repointCodexProfiles(accountMoves);
    report('Codex profiles migrated and verified. The empty ~/.codex-profiles directory can be removed; recovery backup retained in the ModelDeck data directory.');
    return { migrated: true, backupDir };
  } catch {
    let rollbackFailed = false;
    const attempt = async (task) => { try { await task(); } catch { rollbackFailed = true; } };
    if (activeChanged) await attempt(async () => {
      if (await io.readlink(activeLink) !== nextLink) throw new Error('active link changed');
      await replaceLink(activeLink, previousLink, io);
    });
    if (markerCreated) await attempt(async () => {
      await destinationGuard();
      if (await statOrNull(marker, io)) await io.unlink(marker);
    });
    if (rootMoved) await attempt(async () => {
      // Quarantine our alias by atomic rename before checking its identity. A
      // foreign replacement is left at the quarantine path and blocks recovery.
      const alias = await statOrNull(legacyDir, io);
      if (alias?.isSymbolicLink()) {
        if (!aliasCreated || alias.uid !== uid || await io.readlink(legacyDir) !== profilesDir) throw new Error('legacy alias changed');
        const quarantine = path.join(path.dirname(legacyDir), `.codex-migration-alias-${crypto.randomUUID()}`);
        await io.rename(legacyDir, quarantine);
        const quarantined = await io.lstat(quarantine);
        if (!quarantined.isSymbolicLink() || quarantined.uid !== uid || await io.readlink(quarantine) !== profilesDir) {
          throw new Error('legacy alias changed');
        }
        await io.unlink(quarantine);
      } else if (alias?.isDirectory() && alias.uid === uid && (alias.mode & 0o077) === 0
          && (await io.readdir(legacyDir)).length === 0) {
        await io.rmdir(legacyDir);
      } else if (alias) throw new Error('legacy alias changed');
      const root = await io.lstat(profilesDir);
      owned(root, uid);
      // The whole-root move preserves the guarded inode.
      if (!root.isDirectory() || root.isSymbolicLink() || !movedRootIdentity
          || root.dev !== movedRootIdentity.dev || root.ino !== movedRootIdentity.ino) throw new Error('moved root changed');
      await io.rename(profilesDir, legacyDir);
    });
    for (const entry of moved.reverse()) await attempt(async () => {
      await legacyGuard();
      let destinationSafe = true;
      try { await destinationGuard(); }
      catch { destinationSafe = false; rollbackFailed = true; }
      if (entry.removed) {
        let useBackup = !destinationSafe;
        if (destinationSafe) {
          try { await verify(entry.to, entry.tree, io, uid); }
          catch { useBackup = true; }
        }
        // rm can fail partway through an EXDEV source removal. Set that
        // partial tree aside, restore fully, then remove only our partial.
        let partial;
        if (await statOrNull(entry.from, io)) {
          partial = path.join(legacyDir, `.codex-rollback-${crypto.randomUUID()}`);
          await io.rename(entry.from, partial);
        }
        if (useBackup) {
          // The destination itself may have failed verification. Recover the
          // original bytes from the independently verified, inert backup.
          await backupGuard();
          await backupProfilesGuard();
          await copyVerified(path.join(backupDir, 'profiles', entry.name), entry.from, entry.tree, io, uid);
          if (destinationSafe) await io.rm(entry.to, { recursive: true, force: true });
        } else {
          try { await io.rename(entry.to, entry.from); }
          catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await copyVerified(entry.to, entry.from, entry.tree, io, uid);
            await io.rm(entry.to, { recursive: true });
          }
        }
        await verify(entry.from, entry.tree, io, uid);
        if (partial) await io.rm(partial, { recursive: true });
      } else {
        await verify(entry.from, entry.tree, io, uid);
        if (destinationSafe) await io.rm(entry.to, { recursive: true, force: true });
      }
    });
    if (createdDestination && !rollbackFailed) await attempt(() => io.rmdir(profilesDir));
    // Re-discover interrupted work on every start. A populated destination
    // must not turn yesterday's failed rollback into today's usable account.
    await attempt(async () => {
      if (!legacyGuard) throw new Error('legacy root unavailable');
      await legacyGuard();
      for (const account of accounts) {
        const stat = await io.lstat(account.profileRef);
        owned(stat, uid);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('legacy profile unavailable');
      }
      const active = await statOrNull(activeLink, io);
      if (active?.isSymbolicLink()) {
        const target = path.resolve(path.dirname(activeLink), await io.readlink(activeLink));
        if (target === legacyDir || within(target, legacyDir)) await io.realpath(activeLink);
      }
    });
    const retryable = processDeferred && !rollbackFailed;
    const names = holders.slice(0, 5);
    if (holders.length > 5) names.push(`${holders.length - 5} more`);
    const waitingOn = names.length ? new Intl.ListFormat('en', { type: 'conjunction' }).format(names) : 'running processes';
    const warning = retryable ? `Codex profile move is waiting on ${waitingOn}`
      : `Codex profiles migration failed or deferred while ${stage}. ${rollbackFailed
        ? 'Rollback incomplete; profile operations are blocked. Preserve the recovery backup in the ModelDeck data directory.'
        : 'Original account references retained.'}`;
    report(warning);
    return { warning, holders, retryable, blocked: rollbackFailed, ...(!rollbackFailed ? { profilesDir: legacyDir } : {}) };
  }
}
