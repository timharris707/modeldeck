import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_ENV = Object.freeze([
  'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
]);

/// Activation clobber-guard refusal, shared by the service and the Claude
/// adapter so the message + machine-readable code can never drift (#55).
export function activeLinkBlockedError(provider, activeLink) {
  const error = new Error(
    `${provider} activation requires a one-time migration: move the existing directory aside at a quiet moment before activating: ${activeLink}`,
  );
  error.code = 'active-link-blocked';
  return error;
}

export function createProviderProfileHelpers({
  envVar,
  envRequiredError,
  invalidProfileNameError,
  profilesDirRequiredError,
  profilesDirMissingLabel,
  profilesDirLabel,
  profileHomeRequiredError,
  profileHomeLabel,
  destinationExistsLabel,
  containmentErrorPrefix,
}) {
  function profileEnv(profileHome, sourceEnv = process.env) {
    if (envRequiredError && !profileHome) throw new Error(envRequiredError);
    const env = Object.fromEntries(ALLOWED_ENV.filter((key) => sourceEnv[key]).map((key) => [key, sourceEnv[key]]));
    env[envVar] = profileHome;
    return env;
  }

  function safeProfileName(value) {
    const name = String(value || '').trim().toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '');
    if (!name || name === '.' || name === '..') throw new Error(invalidProfileNameError);
    return name;
  }

  // The directory name is an internal identifier derived from the label —
  // the account's display label lives in the store, not on disk. A leftover
  // directory (an interrupted earlier add, an account deleted from the
  // roster, a reinstall) must never dead-end account creation, so a taken
  // name falls through to the next free suffixed one. Each mkdir stays
  // exclusive: two accounts can never share a profile home.
  const MAX_PROFILE_NAME_ATTEMPTS = 50;

  async function createProfileHome({ profilesDir, profileName } = {}) {
    if (!profilesDir) throw new Error(profilesDirRequiredError);
    const name = safeProfileName(profileName);
    await fs.promises.mkdir(profilesDir, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(profilesDir, 0o700);
    const root = await fs.promises.realpath(profilesDir);
    for (let attempt = 1; attempt <= MAX_PROFILE_NAME_ATTEMPTS; attempt += 1) {
      const profileRef = path.join(root, attempt === 1 ? name : `${name}-${attempt}`);
      try {
        await fs.promises.mkdir(profileRef, { mode: 0o700 });
        return profileRef;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`${destinationExistsLabel}: ${path.join(root, name)}`);
  }

  async function assertOwnerOnlyDirectory(directory, label = profileHomeLabel, stat = fs.promises.lstat) {
    const profileStat = await stat(directory).catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${directory}`);
      throw error;
    });
    if (!profileStat.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
    if (process.getuid && profileStat.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
    if ((profileStat.mode & 0o077) !== 0) throw new Error(`${label} must use owner-only permissions (chmod 700 ${directory})`);
  }

  async function validateProfileHome({ profileRef, profilesDir } = {}) {
    if (!profileRef) throw new Error(profileHomeRequiredError);
    if (!profilesDir) throw new Error(profilesDirRequiredError);
    const root = await fs.promises.realpath(profilesDir).catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`${profilesDirMissingLabel} does not exist: ${profilesDir}`);
      throw error;
    });
    await assertOwnerOnlyDirectory(root, profilesDirLabel);
    await assertOwnerOnlyDirectory(profileRef);
    const canonical = await fs.promises.realpath(profileRef);
    const relative = path.relative(root, canonical);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${containmentErrorPrefix}: ${root}`);
    }
    return canonical;
  }

  return {
    assertOwnerOnlyDirectory,
    createProfileHome,
    profileEnv,
    safeProfileName,
    validateProfileHome,
  };
}
