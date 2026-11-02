import path from 'node:path';

// Client state supplies the daemon's root; older daemons use the standard root.
// Never normalize an untrusted path before checking for traversal or shell bytes.
export function codexPoolConfigPath(profileRef, { homeDir, profilesDir } = {}) {
  const safe = (value) => typeof value === 'string' && value.startsWith('/')
    && value.length <= 4096 && !/[^A-Za-z0-9_./ -]/.test(value)
    && !value.includes('..') && !value.split('/').slice(1).some((part) => !part || part === '.');
  const root = profilesDir ?? `${homeDir}/Library/Application Support/ModelDeck/codex-profiles`;
  if (!safe(homeDir) || !safe(profileRef)) throw new Error('invalid Codex profile path');
  const roots = [`${homeDir}/.codex-profiles`];
  // The daemon can advertise a root only inside this client's home. The
  // Python openat walk below rejects symlinks on the client, including roots.
  if (safe(root) && root.startsWith(`${homeDir}/`)) roots.push(root);
  if (!roots.some((allowed) => profileRef.startsWith(`${allowed}/`)
    && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(profileRef.slice(allowed.length + 1)))) {
    throw new Error('invalid Codex profile path');
  }
  return path.posix.join(profileRef, 'config.toml');
}

export const CODEX_POOL_KEY_ERRORS = Object.freeze({
  20: 'Codex profile not routed to the local forwarder',
  21: 'invalid Codex config or bearer',
  22: 'unsafe Codex config path',
  23: 'Codex config read or write failed',
  24: 'Codex profile has no bearer',
});

// One parser for install, routing preflight and local rollback. Python 3.9 on
// macOS has no tomllib. Scan statements outside TOML strings/arrays, then parse
// only the three relevant scalar lines; no serialization of the document.
// "check" returns only a status. "read" uses a private pipe (fd 3), never stdout.
export const CODEX_POOL_KEY_SCRIPT = String.raw`
import errno, os, re, stat, sys

def stop(code):
    raise SystemExit(code)

def statements(data):
    start = i = depth = 0
    quote = None
    triple = False
    while i < len(data):
        c = data[i:i+1]
        if quote:
            if c == b'\\' and quote == b'"':
                i += 2
                continue
            if triple and data[i:i+3] == quote * 3:
                i += 3
                while i < len(data) and data[i:i+1] == quote:
                    i += 1
                quote = None
                continue
            if not triple and c == quote:
                quote = None
            elif not triple and c in (b'\r', b'\n'):
                stop(21)
        elif c == b'#':
            end = data.find(b'\n', i)
            i = len(data) if end < 0 else end
            continue
        elif c in (b'"', b"'"):
            quote = c
            triple = data[i:i+3] == c * 3
            if triple:
                i += 3
                continue
        elif c in (b'[', b'{'):
            depth += 1
        elif c in (b']', b'}'):
            depth -= 1
            if depth < 0:
                stop(21)
        if c == b'\n' and not quote and depth == 0:
            yield start, i + 1
            start = i + 1
        i += 1
    if quote or depth:
        stop(21)
    if start < len(data):
        yield start, len(data)

def key_name(raw):
    if raw.startswith(b"'"):
        return raw[1:-1]
    if not raw.startswith(b'"'):
        return raw
    escapes = {b'b': b'\b', b't': b'\t', b'n': b'\n', b'f': b'\f', b'r': b'\r', b'"': b'"', b'\\': b'\\'}
    def unescape(match):
        value = match[1]
        if value in escapes:
            return escapes[value]
        if value[:1] in (b'u', b'U') and len(value) in (5, 9):
            try:
                return chr(int(value[1:], 16)).encode('utf-8')
            except (ValueError, UnicodeError):
                pass
        stop(21)
    return re.sub(rb'\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)', unescape, raw[1:-1])

def bearer_span(data):
    table = b''
    seen_table = False
    fields = {}
    table_end = len(data)
    newline = b'\n'
    for start, end in statements(data):
        line = data[start:end]
        if line.lstrip().startswith(b'['):
            if table == b'cliproxyapi':
                table_end = start
            target = re.fullmatch(rb'[ \t]*\[model_providers\.cliproxyapi\][ \t]*(?:#[^\r\n]*)?(?:\r?\n)?', line)
            table = b'cliproxyapi' if target else b'other'
            if target:
                if seen_table:
                    stop(21)
                seen_table = True
                newline = b'\r\n' if line.endswith(b'\r\n') else b'\n'
            continue
        key = re.match(rb'''[ \t]*([A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\[^\r\n])*"|'[^'\r\n]*')[ \t]*=''', line)
        if not key:
            continue
        name = key_name(key[1])
        wanted = (not table and name == b'model_provider') or (table == b'cliproxyapi' and name in (b'base_url', b'experimental_bearer_token'))
        if not wanted:
            continue
        if name in fields:
            stop(21)
        value = re.fullmatch(rb'''[ \t]*("(?:[^"\\\r\n]|\\[^\r\n])*"|'[^'\r\n]*')[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?''', line[key.end():])
        if not value:
            stop(21)
        a = start + key.end() + value.start(1) + 1
        b = start + key.end() + value.end(1) - 1
        fields[name] = (a, b)
    def field(name):
        span = fields.get(name)
        return data[span[0]:span[1]] if span else None
    if field(b'model_provider') != b'cliproxyapi' or not seen_table or field(b'base_url') != b'http://127.0.0.1:8317/v1':
        stop(20)
    return fields.get(b'experimental_bearer_token'), table_end, newline

def main():
    filename = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) == 3 else 'install'
    if mode not in ('install', 'check', 'read'):
        stop(21)
    parts = filename.split('/')
    if not filename.startswith('/') or any(part in ('', '.', '..') for part in parts[1:]):
        stop(22)
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    temporary = None
    try:
        # Walk with openat + NOFOLLOW: neither the file nor a parent may redirect
        # the write outside the validated profile. No secret-bearing backup.
        try:
            for part in parts[1:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            if mode in ('check', 'read'):
                stop(20)
            raise
        with os.fdopen(fd, 'rb') as source:
            original = os.fstat(source.fileno())
            if not stat.S_ISREG(original.st_mode):
                stop(22)
            data = source.read(2_000_001)
        if len(data) > 2_000_000:
            stop(21)
        span, end, newline = bearer_span(data)
        if mode == 'check':
            return
        if mode == 'read':
            if not span:
                stop(24)
            key = data[span[0]:span[1]]
        else:
            key = sys.stdin.buffer.read(4097)
        if len(key) > 4096 or not re.fullmatch(rb'[A-Za-z0-9_-]+', key):
            stop(21)
        if mode == 'read':
            with os.fdopen(3, 'wb') as output:
                output.write(key)
            return
        if span:
            updated = data[:span[0]] + key + data[span[1]:]
        else:
            separator = newline if end and not data[:end].endswith(b'\n') else b''
            updated = data[:end] + separator + b'experimental_bearer_token = "' + key + b'"' + newline + data[end:]
        temporary = '.codex-pool-key-' + os.urandom(12).hex()
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
        with os.fdopen(fd, 'wb') as output:
            output.write(updated)
            output.flush()
            os.fchmod(output.fileno(), stat.S_IMODE(original.st_mode))
            os.fsync(output.fileno())
        current = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
        if (current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size) != (original.st_dev, original.st_ino, original.st_mtime_ns, original.st_size):
            stop(23)
        os.replace(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
        os.fsync(directory)
    finally:
        if temporary:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)

try:
    main()
except OSError as error:
    stop(22 if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM) else 23)
except Exception:
    stop(23)
`;
