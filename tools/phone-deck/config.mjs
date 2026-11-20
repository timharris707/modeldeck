// Shared by the server and installer so invalid settings never reach launchd.
export function validateConfig(env) {
  if (env.SOURCES !== undefined && env.SOURCES !== 'local') throw new Error('SOURCES must be exactly local or unset');
  const machines = parseMachines(env);
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
  return { local, name, allowedNames, daemonPort, machines };
}

// MACHINES (#834): the Studio's several-machine mode, in display order:
// "Studio=local,Linux=linux,M5=m5". Each value is "local" (this machine) or
// the SSH host name of a machine whose daemon and direct sign-ins to read.
// "Name=host/direct" (#856) reads only that machine's direct sign-ins: for an
// account such as the Mini's agents user, whose loopback port answers with
// another user's daemon.
function parseMachines(env) {
  if (env.MACHINES === undefined) return null;
  if (env.SOURCES !== undefined || env.MACHINE_LABEL !== undefined) throw new Error('MACHINES cannot be combined with SOURCES or MACHINE_LABEL');
  const list = env.MACHINES.split(',').map((item) => {
    const m = /^([A-Za-z0-9 -]{1,24})=(local|[a-z0-9][a-z0-9.-]{0,62})(\/direct)?$/.exec(item);
    if (!m || (m[2] === 'local' && m[3])) throw new Error('MACHINES must be comma-separated Name=local, Name=ssh-host or Name=ssh-host/direct entries');
    return { name: m[1], host: m[2] === 'local' ? null : m[2], directOnly: !!m[3] };
  });
  if (list.length > 8) throw new Error('MACHINES must name 1 to 8 machines');
  if (new Set(list.map((m) => m.name)).size !== list.length) throw new Error('MACHINES names must be different');
  if (list.filter((m) => m.host == null).length > 1) throw new Error('MACHINES may name only one local machine');
  return list;
}
