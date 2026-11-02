#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { codexPoolConfigPath, CODEX_POOL_KEY_ERRORS, CODEX_POOL_KEY_SCRIPT } from '../../src/codex-pool-key.mjs';
import { parseT3PoolInstances, T3_POOL_KEY_ERRORS, T3_POOL_KEY_SCRIPT } from '../../src/t3-pool-key.mjs';
import { readSecretFile } from '../../src/secret-file.mjs';

// Both endpoints are local. Secrets exist only in this process's memory and
// curl's stdin; child errors and management responses must never reach logs.
try {
  const daemon = new URL(process.argv[2]);
  if (daemon.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(daemon.hostname)
    || daemon.username || daemon.password || daemon.pathname !== '/' || daemon.search || daemon.hash) throw Error();
  const curl = process.env.CURL || 'curl';
  const security = process.env.SECURITY || '/usr/bin/security';
  const run = (command, args, input) => execFileSync(command, args, {
    input, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const flags = ['--disable', '--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '5'];
  // PROXY_PORT follows a scratch proxy (#809); the live pool is 8317.
  const proxyPort = process.env.PROXY_PORT ?? '8317';
  if (!/^\d{1,5}$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535) throw Error();
  const state = JSON.parse(run(curl, [...flags, `${daemon.origin}/api/state`]));
  if (!Array.isArray(state.accounts)) throw Error();
  const services = new Set();
  for (const account of state.accounts) {
    const record = account.metadata?.clientKeyHelper;
    if (account.provider !== 'claude' || !account.cliproxyRouted || !account.helperRouted || record?.mode !== 'per-profile') continue;
    if (typeof record.service !== 'string' || !/^cli-proxy-api-client\.[a-z0-9-]{1,128}$/.test(record.service)) throw Error();
    services.add(record.service);
  }
  let managementKey;
  let admitted;
  const hash = (key) => createHash('sha256').update(key).digest('hex');
  const management = (method, body) => {
    let config = `header = ${JSON.stringify(`Authorization: Bearer ${managementKey}`)}\n`;
    if (body) config += `header = "Content-Type: application/json"\ndata = ${JSON.stringify(JSON.stringify(body))}\n`;
    return run(curl, [...flags, '--config', '-', '-X', method, `http://127.0.0.1:${proxyPort}/v0/management/api-keys`], config);
  };
  const restore = (key) => {
    // Skip-only runs need no management key or proxy call.
    if (!admitted) {
      managementKey = fs.readFileSync(process.env.MANAGEMENT_KEY_FILE || path.join(os.homedir(), '.config/cliproxyapi/.mgmt-key'), 'utf8').trim();
      if (!managementKey || /[\r\n]/.test(managementKey)) throw Error();
      const current = JSON.parse(management('GET'))['api-keys'];
      if (!Array.isArray(current) || current.some(key => typeof key !== 'string')) throw Error();
      if (!current.length) {
        // An empty list admits every request; adding a key would turn key
        // checking on and lock out keyless local clients. Leave that to a person.
        console.error('Local proxy has no api-keys (key checking is off); profile keys were not added. Add them by hand if you want key checking on.');
        process.exit(0);
      }
      admitted = new Set(current.map(hash));
    }
    if (admitted.has(hash(key))) return;
    // A missing old value is CLIProxyAPI's append operation, preserving all
    // existing keys. Use a unique sentinel and check that it is absent.
    let sentinel;
    do { sentinel = `pool-target-append-${randomUUID()}`; } while (admitted.has(hash(sentinel)));
    management('PATCH', { old: sentinel, new: key });
    admitted.add(hash(key));
  };
  // Finish Claude admission before checking any optional Codex accounts.
  for (const service of services) {
    const key = run(security, ['find-generic-password', '-s', service, '-w']).trim();
    if (!key || /[\r\n]/.test(key)) throw Error();
    restore(key);
  }
  // Off macOS this machine's Claude profiles send its one pool-client-key
  // (decision 0046, #808); read with the owner-only checks.
  if (process.platform !== 'darwin') {
    const secretsDir = process.env.MODELDECK_SECRETS_DIR || path.join(os.homedir(), '.config', 'modeldeck');
    const file = path.join(secretsDir, 'pool-client-key');
    const key = readSecretFile(file);
    if (key) restore(key);
    // Said out loud, not skipped quietly (Codex review of #814): without it
    // this machine's Claude profiles send no key the local proxy accepts.
    else console.error(`No ${file}: this machine's Claude profiles have no key for the local proxy. Install one with pool-client-keys.mjs, or add their key to api-keys by hand.`);
  }
  for (const account of state.accounts.filter((account) => account.provider === 'codex')) {
    const id = typeof account.id === 'string' && /^[a-z0-9-]{1,128}$/.test(account.id) ? account.id : 'unknown';
    const skip = (reason) => console.error(`Skipped Codex account ${id}: ${reason}`);
    let config;
    try { config = codexPoolConfigPath(account.profileRef, { homeDir: os.homedir(), profilesDir: state.codexProfilesDir }); }
    catch { skip('invalid Codex profile path'); continue; }
    let read;
    try {
      read = spawnSync('/usr/bin/python3', ['-I', '-c', CODEX_POOL_KEY_SCRIPT, config, 'read'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 8192,
        env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
        // Only the private fd 3 pipe can carry the bearer. No stdout/stderr.
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
    } catch { skip('Codex config command failed'); continue; }
    if (read.error || read.status !== 0) {
      skip(!read.error && Object.hasOwn(CODEX_POOL_KEY_ERRORS, read.status) ? CODEX_POOL_KEY_ERRORS[read.status] : 'Codex config command failed');
      continue;
    }
    const key = read.output?.[3] ?? '';
    if (!/^[A-Za-z0-9_-]+$/.test(key)) { skip('invalid Codex config or bearer'); continue; }
    if (key.length < 32) { skip('Codex bearer too short'); continue; }
    restore(key);
  }
  const t3 = (mode, id) => spawnSync('/usr/bin/python3', ['-I', '-c', T3_POOL_KEY_SCRIPT, mode, ...(id === undefined ? [] : [id])], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000,
    env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
    // Only list's validated metadata uses stdout. Keys use fd 3 exclusively.
    stdio: ['ignore', mode === 'list' ? 'pipe' : 'ignore', 'ignore', mode === 'read' ? 'pipe' : 'ignore'],
  });
  const t3Reason = (result) => !result.error && Object.hasOwn(T3_POOL_KEY_ERRORS, result.status)
    ? T3_POOL_KEY_ERRORS[result.status] : 'T3 instance command failed';
  let instances = [];
  try {
    const listed = t3('list');
    if (listed.error || listed.status !== 0) console.error(`Skipped T3 instance discovery: ${t3Reason(listed)}`);
    else {
      try { instances = parseT3PoolInstances(listed.stdout); }
      catch { console.error('Skipped T3 instance discovery: invalid T3 discovery'); }
    }
  } catch { console.error('Skipped T3 instance discovery: T3 instance command failed'); }
  for (const instance of instances) {
    const skip = (reason) => console.error(`Skipped T3 instance ${instance.id}: ${reason}`);
    if (instance.skipped !== undefined) { skip(T3_POOL_KEY_ERRORS[instance.skipped]); continue; }
    let read;
    try { read = t3('read', instance.id); }
    catch { skip('T3 instance command failed'); continue; }
    if (read.error || read.status !== 0) { skip(t3Reason(read)); continue; }
    const key = read.output?.[3] ?? '';
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) { skip('invalid T3 settings or key'); continue; }
    restore(key);
  }
} catch {
  console.error('Local profile key restore failed; check the daemon, local management key, profile Keychain items or the pool-client-key file, Codex configs and T3 instances, then re-run host --yes.');
  process.exitCode = 1;
}
