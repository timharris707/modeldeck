#!/usr/bin/env node
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CLIPROXY_MANAGEMENT_KEY_PATH } from '../src/paths.mjs';
import { KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, MUTATION_TOKEN_FILE } from '../src/token.mjs';
import { readSecretFile } from '../src/secret-file.mjs';
import { runPoolClientKeys } from '../src/pool-client-keys.mjs';

// Never collect stderr: security -i echoes the secret-bearing command there.
// Only discovery, wire HTTP status and the host token lookup capture stdout. Child errors are
// replaced here too, so no argv, input, output or cause can reach the terminal.
function command(spawn, env, binary, argv, { stdin = '', captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, argv, { stdio: ['pipe', captureStdout ? 'pipe' : 'ignore', 'ignore'], env });
    } catch {
      reject(new Error('external command failed'));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    const timeout = setTimeout(() => { failed = true; child.kill(); }, 30_000);
    child.stdout?.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { failed = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('external command failed')); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || failed) reject(Object.assign(new Error('external command failed'), {
        ...(Number.isInteger(code) && !failed ? { exitCode: code } : {}),
      }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => { failed = true; });
    child.stdin.end(stdin);
  });
}

export function createPoolClientKeyEffects({
  spawn = spawnChild, env = process.env, platform = process.platform, mutationTokenFile = MUTATION_TOKEN_FILE,
} = {}) {
  const childEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of ['SSH_AUTH_SOCK', 'HOME', 'USER', 'LOGNAME']) {
    if (typeof env[name] === 'string') childEnv[name] = env[name];
  }
  const run = (...args) => command(spawn, childEnv, ...args);
  return {
    managementKeyFile: CLIPROXY_MANAGEMENT_KEY_PATH,
    readFile: fs.readFile, randomBytes,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
    ssh: (argv, options) => run('/usr/bin/ssh', argv, options),
    readMutationToken: async () => {
      const fromEnv = env.MODELDECK_MUTATION_TOKEN?.trim();
      if (fromEnv) return fromEnv;
      if (env.MODELDECK_SKIP_KEYCHAIN === '1') throw new Error('mutation token unavailable');
      // A Linux pool host keeps its token in the owner-only file (decision 0046).
      if (platform !== 'darwin') {
        const fromFile = readSecretFile(mutationTokenFile);
        if (!fromFile) throw new Error('mutation token unavailable');
        return fromFile;
      }
      return run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { captureStdout: true });
    },
    output: (line) => process.stdout.write(`${line}\n`),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await runPoolClientKeys(process.argv.slice(2), createPoolClientKeyEffects());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
