import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DAEMON_ERROR_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_DAEMON_ERROR_LOG_CHECK_INTERVAL_MS = 30_000;

const BOOTSTRAP_PID_ENV = 'MODELDECK_DAEMON_STDERR_BOOTSTRAP_PID';
export const INTERNAL_SEA_COMMANDS = new Set([
  'modeldeck-internal-claude-usage-probe',
  'modeldeck-internal-claude-statusline',
  'modeldeck-internal-grok-usage-probe',
]);
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

function boundedSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : DEFAULT_DAEMON_ERROR_LOG_MAX_BYTES;
}

function assertRegularOrMissing(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error(`refusing non-regular daemon log: ${filePath}`);
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function openRegular(filePath, flags, mode) {
  const fd = fs.openSync(filePath, flags | O_NOFOLLOW | O_NONBLOCK, mode);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`refusing non-regular daemon log: ${filePath}`);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function closeAfter(fd, operation) {
  try {
    return operation(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(filePath, maxBytes) {
  assertRegularOrMissing(filePath);
  const fd = openRegular(filePath, fs.constants.O_RDONLY);
  return closeAfter(fd, (openFd) => {
    const size = fs.fstatSync(openFd).size;
    const length = Math.min(size, maxBytes);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(openFd, bytes, offset, length - offset, size - length + offset);
      if (read === 0) break;
      offset += read;
    }
    return offset === length ? bytes : bytes.subarray(0, offset);
  });
}

function writeRegular(filePath, bytes) {
  assertRegularOrMissing(filePath);
  const fd = openRegular(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  closeAfter(fd, (openFd) => {
    fs.fchmodSync(openFd, 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(openFd, bytes, offset);
  });
}

function ensureActiveLog(logPath) {
  assertRegularOrMissing(logPath);
  const fd = openRegular(
    logPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600,
  );
  closeAfter(fd, (openFd) => fs.fchmodSync(openFd, 0o600));
}

function truncateRegular(filePath) {
  assertRegularOrMissing(filePath);
  const fd = openRegular(filePath, fs.constants.O_WRONLY);
  closeAfter(fd, (openFd) => {
    fs.ftruncateSync(openFd, 0);
    fs.fchmodSync(openFd, 0o600);
  });
}

function tightenRegular(filePath) {
  const fd = openRegular(filePath, fs.constants.O_WRONLY);
  closeAfter(fd, (openFd) => fs.fchmodSync(openFd, 0o600));
}

export function maintainDaemonErrorLog(logPath, { maxBytes: requestedMaxBytes } = {}) {
  const maxBytes = boundedSize(requestedMaxBytes);
  const backupPath = `${logPath}.1`;
  assertRegularOrMissing(logPath);
  assertRegularOrMissing(backupPath);
  ensureActiveLog(logPath);

  const backup = assertRegularOrMissing(backupPath);
  if (backup) {
    if (backup.size > maxBytes) writeRegular(backupPath, readTail(backupPath, maxBytes));
    else tightenRegular(backupPath);
  }

  const active = assertRegularOrMissing(logPath);
  if (active.size >= maxBytes) {
    // Preserve the active inode. fd 2 stays attached to it across this
    // copy-and-truncate rotation, so later native writes still reach logPath.
    writeRegular(backupPath, readTail(logPath, maxBytes));
    truncateRegular(logPath);
    return { rotated: true, maxBytes };
  }
  return { rotated: false, maxBytes };
}

export function prepareDaemonErrorLog(logPath, options = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  return maintainDaemonErrorLog(logPath, options);
}

export function startDaemonErrorLogMaintenance({
  logPath,
  maxBytes = DEFAULT_DAEMON_ERROR_LOG_MAX_BYTES,
  intervalMs = DEFAULT_DAEMON_ERROR_LOG_CHECK_INTERVAL_MS,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  prepareDaemonErrorLog(logPath, { maxBytes });
  const timer = setIntervalFn(() => {
    try {
      maintainDaemonErrorLog(logPath, { maxBytes });
    } catch {
      // Logging maintenance must never take down the daemon. The already-open
      // fd remains usable even if a later path check refuses a replaced file.
    }
  }, intervalMs);
  timer?.unref?.();
  return () => clearIntervalFn(timer);
}

export function bootstrapDaemonStderr({
  logPath,
  maxBytes = DEFAULT_DAEMON_ERROR_LOG_MAX_BYTES,
  enabled = false,
  argv = process.argv,
  env = process.env,
  execPath = process.execPath,
  pid = process.pid,
  execve = process.execve,
} = {}) {
  if (!enabled || argv.some((value) => INTERNAL_SEA_COMMANDS.has(value))) return false;
  if (env[BOOTSTRAP_PID_ENV] === String(pid)) return false;
  if (typeof execve !== 'function') throw new Error('Node process.execve is unavailable');

  prepareDaemonErrorLog(logPath, { maxBytes });
  // Node opens ordinary file descriptors close-on-exec. Put the verified log
  // on fd 0, which execve preserves, then let the shell duplicate it to fd 2
  // before restoring the daemon's unused stdin to /dev/null. Internal SEA
  // helpers return above because their stdin belongs to their caller.
  let logFd = null;
  let bootstrapError = null;
  try {
    fs.closeSync(0);
    logFd = openRegular(
      logPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      0o600,
    );
    if (logFd !== 0) throw new Error('could not reserve inherited fd 0 for the daemon log');
    fs.fchmodSync(logFd, 0o600);
    const shellCommand = 'daemon="$1"; shift; exec "$daemon" "$@" 2>&0 0</dev/null';
    execve('/bin/sh', [
      'sh', '-c', shellCommand, 'modeldeck-daemon-bootstrap', execPath, ...argv.slice(1),
    ], {
      ...env,
      [BOOTSTRAP_PID_ENV]: String(pid),
    });
  } catch (error) {
    bootstrapError = error;
  }
  try {
    if (logFd != null) fs.closeSync(logFd);
    const restoredStdinFd = fs.openSync('/dev/null', fs.constants.O_RDONLY);
    if (restoredStdinFd !== 0) {
      fs.closeSync(restoredStdinFd);
      throw new Error('could not restore stdin after daemon stderr bootstrap');
    }
  } catch (error) {
    if (bootstrapError) bootstrapError.cause = error;
    else bootstrapError = error;
  }
  if (bootstrapError) throw bootstrapError;
  throw new Error('process.execve returned without replacing the daemon');
}
