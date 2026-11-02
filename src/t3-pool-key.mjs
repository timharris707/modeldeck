export const T3_POOL_KEY_ERRORS = Object.freeze({
  20: 'T3 instance not routed to the local forwarder',
  21: 'invalid T3 settings or key',
  22: 'unsafe T3 secret path or owner',
  23: 'T3 settings or secret read or write failed',
  24: 'T3 instance has no stored key',
});

// Discovery has a metadata-only stdout contract. Reject malformed replies before
// using any field in output, profile records or a remote command.
export function parseT3PoolInstances(text) {
  const instances = JSON.parse(text);
  const ids = new Set();
  if (!Array.isArray(instances)) throw new Error('invalid T3 discovery');
  for (const instance of instances) {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)
      || Object.keys(instance).length !== 2
      || typeof instance.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(instance.id)
      || (Object.hasOwn(instance, 'skipped')
        ? !Number.isInteger(instance.skipped) || !Object.hasOwn(T3_POOL_KEY_ERRORS, instance.skipped)
        : typeof instance.displayName !== 'string' || instance.displayName.length > 64
          || instance.displayName.trim() !== instance.displayName || /\p{C}/u.test(instance.displayName))) throw new Error('invalid T3 discovery');
    // Several invalid source ids can share this fixed, non-identifying marker.
    if (instance.id === 'invalid-id' && instance.skipped === 21) continue;
    if (ids.has(instance.id)) throw new Error('invalid T3 discovery');
    ids.add(instance.id);
  }
  return instances;
}

// Runs on the client, with the client's HOME. No settings or secret directory is
// ever created. Every operation rechecks routing and walks without symlinks;
// read sends the current key only through the caller's private fd 3 pipe.
export const T3_POOL_KEY_SCRIPT = String.raw`
import base64, errno, json, os, re, stat, sys, unicodedata

def stop(code):
    raise SystemExit(code)

def file_error(error):
    if error.errno == errno.ENOENT:
        return 24
    return 22 if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM) else 23

def directory_at(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

def userdata_directory():
    home = os.path.expanduser('~')
    parts = (home + '/.t3/userdata').split('/')
    if not home.startswith('/') or any(part in ('', '.', '..') for part in parts[1:]):
        stop(22)
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:]:
            child = directory_at(directory, part)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise

def regular_file(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(fd)
        stop(22)
    return fd, info

def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            stop(21)
        result[key] = value
    return result

def instances_at(directory):
    fd, _ = regular_file(directory, 'settings.json')
    with os.fdopen(fd, 'rb') as source:
        data = source.read(2_000_001)
    if len(data) > 2_000_000:
        stop(21)
    try:
        settings = json.loads(data, object_pairs_hook=unique_fields)
    except (ValueError, UnicodeError):
        stop(21)
    if not isinstance(settings, dict) or not isinstance(settings.get('providerInstances', {}), dict):
        stop(21)
    return settings.get('providerInstances', {})

# T3 keeps an explicit disable from either flag; a missing flag means on.
def claude_enabled(instance):
    config = instance.get('config') if isinstance(instance, dict) else None
    return (isinstance(instance, dict) and instance.get('driver') == 'claudeAgent' and instance.get('enabled') is not False
            and not (isinstance(config, dict) and config.get('enabled') is False))

def routed(instance):
    if not claude_enabled(instance):
        return False
    environment = instance.get('environment')
    if not isinstance(environment, list):
        return False
    bases = [item for item in environment if isinstance(item, dict) and item.get('name') == 'ANTHROPIC_BASE_URL']
    tokens = [item for item in environment if isinstance(item, dict) and item.get('name') == 'ANTHROPIC_AUTH_TOKEN']
    return (len(bases) == 1 and bases[0].get('value') in ('http://127.0.0.1:8317', 'http://127.0.0.1:8317/')
            and len(tokens) == 1 and tokens[0].get('sensitive') is True)

def secret_name(instance_id):
    def encode(value):
        return base64.urlsafe_b64encode(value.encode('utf-8')).decode('ascii').rstrip('=')
    return 'provider-env-' + encode(instance_id) + '-' + encode('ANTHROPIC_AUTH_TOKEN') + '.bin'

def open_secret(userdata, instance_id):
    directory = directory_at(userdata, 'secrets')
    try:
        fd, info = regular_file(directory, secret_name(instance_id))
        return directory, fd, info
    except BaseException:
        os.close(directory)
        raise

def display_name(instance, instance_id):
    name = instance.get('displayName', instance_id)
    if not isinstance(name, str):
        name = instance_id
    name = ''.join(char for char in name if not unicodedata.category(char).startswith('C')).strip()[:64]
    # Bound the JS consumer's UTF-16 length too, without splitting a character.
    while len(name.encode('utf-16-le')) > 128:
        name = name[:-1]
    return name.strip()

def identity(info):
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns, info.st_size, info.st_mode, info.st_uid, info.st_gid)

def unique_secret(directory, instance_id, original, instances):
    # Base64url is case-sensitive; a Mac's filesystem may not be. Include every
    # provider id, even direct or disabled entries, to protect their secrets too.
    folded = secret_name(instance_id).lower()
    for other_id in instances:
        if other_id == instance_id:
            continue
        name = secret_name(other_id)
        if name.lower() != folded:
            continue
        try:
            other = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            continue
        if (other.st_dev, other.st_ino) == (original.st_dev, original.st_ino):
            stop(22)

def plain_token(source):
    key = source.read(513)
    if not re.fullmatch(rb'[A-Za-z0-9._~+/=-]{16,512}', key):
        stop(21)
    return key

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode not in ('list', 'check', 'install', 'read') or len(sys.argv) != (2 if mode == 'list' else 3):
        stop(21)
    instance_id = sys.argv[2] if mode != 'list' else None
    if instance_id is not None and not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', instance_id):
        stop(21)
    userdata = None
    try:
        try:
            userdata = userdata_directory()
            instances = instances_at(userdata)
        except FileNotFoundError:
            if mode == 'list':
                print('[]')
                return
            stop(20)
        if mode == 'list':
            found = []
            for name, instance in instances.items():
                if not claude_enabled(instance):
                    continue
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', name):
                    found.append({'id': 'invalid-id', 'skipped': 21})
                    continue
                try:
                    if not routed(instance):
                        stop(20)
                    directory, fd, original = open_secret(userdata, name)
                    try:
                        with os.fdopen(fd, 'rb') as source:
                            unique_secret(directory, name, original, instances)
                            plain_token(source)
                    finally:
                        os.close(directory)
                except (OSError, SystemExit) as error:
                    found.append({'id': name, 'skipped': error.code if isinstance(error, SystemExit) else file_error(error)})
                    continue
                found.append({'id': name, 'displayName': display_name(instance, name)})
            print(json.dumps(found, ensure_ascii=True))
            return
        if not routed(instances.get(instance_id)):
            stop(20)
        try:
            directory, fd, original = open_secret(userdata, instance_id)
        except FileNotFoundError:
            stop(24)
        temporary = None
        try:
            with os.fdopen(fd, 'rb') as source:
                unique_secret(directory, instance_id, original, instances)
                current_key = plain_token(source)
                if mode == 'check':
                    return
                key = current_key if mode == 'read' else sys.stdin.buffer.read(129)
            if not re.fullmatch(rb'[A-Za-z0-9_-]{32,128}', key):
                stop(21)
            if mode == 'read':
                with os.fdopen(3, 'wb') as output:
                    output.write(key)
                return
            temporary = '.t3-pool-key-' + os.urandom(12).hex()
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
            with os.fdopen(fd, 'wb') as output:
                output.write(key)
                output.flush()
                os.fchmod(output.fileno(), 0o600)
                os.fsync(output.fileno())
            current = os.stat(secret_name(instance_id), dir_fd=directory, follow_symlinks=False)
            if identity(current) != identity(original):
                stop(23)
            os.replace(temporary, secret_name(instance_id), src_dir_fd=directory, dst_dir_fd=directory)
            temporary = None
            os.fsync(directory)
        finally:
            if temporary:
                os.unlink(temporary, dir_fd=directory)
            os.close(directory)
    finally:
        if userdata is not None:
            os.close(userdata)

try:
    main()
except OSError as error:
    stop(22 if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM) else 23)
except Exception:
    stop(23)
`;
