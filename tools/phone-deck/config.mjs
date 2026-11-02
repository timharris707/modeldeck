// Shared by the server and installer so invalid settings never reach launchd.
export function validateConfig(env) {
  if (env.SOURCES !== undefined && env.SOURCES !== 'local') throw new Error('SOURCES must be exactly local or unset');
  const local = env.SOURCES === 'local';
  if (env.MACHINE_LABEL !== undefined && !local) throw new Error('MACHINE_LABEL needs SOURCES=local');
  const name = env.MACHINE_LABEL ?? 'Studio';
  if (name.length < 1 || name.length > 24 || /[^A-Za-z0-9 -]/.test(name)) throw new Error('MACHINE_LABEL must be 1-24 letters, digits, spaces or hyphens');
  const allowedNames = env.ALLOWED_NAMES ? env.ALLOWED_NAMES.split(',') : [];
  if (allowedNames.some((n) => !/^[a-z0-9-]+$/.test(n))) throw new Error('ALLOWED_NAMES must be comma-separated names using a-z, 0-9 or hyphens');
  // DAEMON_PORT points the page at a daemon on another loopback port, for a
  // scratch hub (#809); 3867 is the installed daemon.
  const daemonPort = env.DAEMON_PORT === undefined ? 3867 : Number(env.DAEMON_PORT);
  if (!/^\d+$/.test(env.DAEMON_PORT ?? '3867') || daemonPort < 1 || daemonPort > 65535) throw new Error('DAEMON_PORT must be a port number');
  return { local, name, allowedNames, daemonPort };
}
