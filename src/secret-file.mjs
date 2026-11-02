import fs from 'node:fs';
import path from 'node:path';

// Decision 0046: where there is no Keychain (Linux), each secret is one file
// the user alone can read, in a directory only the user can change. A file
// that fails these checks is refused, never read: the error names the path
// and the problem, never the value.

// A secret is one short line; anything bigger is not ours.
const MAX_SECRET_BYTES = 4096;

function assertOwnerOnly(stat, what, uid) {
  if (stat.uid !== uid) throw new Error(`${what} is not owned by this user`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${what} is readable or writable by other users; chmod it to owner-only`);
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/// Reads a secret file. Returns null when it does not exist; throws when it
/// exists but is unsafe (symlink, not a regular file, wrong owner, group or
/// world bits, or the same problems on its directory), is too big, or holds
/// more than one line. The file is opened without following links and
/// checked through the open descriptor; afterwards the directory and the path
/// must still be the ones checked, so a swap between check and open is
/// refused. The trimmed value is returned; an empty file reads as null.
export function readSecretFile(file, { uid = process.getuid?.(), fsImpl = fs } = {}) {
  const dir = path.dirname(file);
  let dirStat;
  try {
    dirStat = fsImpl.lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`${dir} is not a directory`);
  assertOwnerOnly(dirStat, dir, uid);
  let fd;
  try {
    fd = fsImpl.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new Error(`${file} is not a regular file`);
    throw error;
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    assertOwnerOnly(stat, file, uid);
    if (!sameInode(fsImpl.lstatSync(dir), dirStat) || !sameInode(fsImpl.lstatSync(file), stat)) {
      throw new Error(`${file} changed while it was being checked`);
    }
    if (stat.size > MAX_SECRET_BYTES) throw new Error(`${file} is larger than a secret should be`);
    const value = fsImpl.readFileSync(fd, 'utf8').trim();
    if (/[\r\n]/.test(value)) throw new Error(`${file} must hold a single line`);
    return value || null;
  } finally {
    fsImpl.closeSync(fd);
  }
}
