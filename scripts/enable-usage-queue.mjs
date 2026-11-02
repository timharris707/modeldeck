#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMutationToken } from '../src/token.mjs';

export async function enableUsageQueue({
  base = process.env.MODELDECK_BASE_URL || 'http://127.0.0.1:3867',
  token = process.env.MODELDECK_MUTATION_TOKEN,
  fetcher = globalThis.fetch,
  stdout = process.stdout,
  wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
} = {}) {
  token = token?.trim();
  if (!token) throw new Error('no mutation token: set one with scripts/set-mutation-token.sh');
  let previousEnabled;
  try {
    const previousResponse = await fetcher(new URL('/api/settings', base), { redirect: 'error' });
    if (!previousResponse.ok) throw new Error(`settings read failed (HTTP ${previousResponse.status})`);
    const previousSettings = await previousResponse.json();
    if (typeof previousSettings?.usageQueueConsumerEnabled !== 'boolean') {
      throw new Error('settings read did not return usageQueueConsumerEnabled');
    }
    previousEnabled = previousSettings.usageQueueConsumerEnabled;
  } catch (error) {
    throw new Error(`could not snapshot usage-queue kill switch: ${error.message}`);
  }
  try {
    const response = await fetcher(new URL('/api/settings', base), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-ModelDeck-Token': token,
        Cookie: `modeldeck_session=${encodeURIComponent(token)}`,
      },
      body: JSON.stringify({ usageQueueConsumerEnabled: true }),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`daemon settings update failed (HTTP ${response.status})`);
    const settings = await response.json();
    if (settings.usageQueueConsumerEnabled !== true) {
      throw new Error('daemon did not confirm usageQueueConsumerEnabled=true');
    }
    let queue;
    for (let attempt = 0; attempt < 175; attempt += 1) {
      const stateResponse = await fetcher(new URL('/api/state', base), { redirect: 'error' });
      if (!stateResponse.ok) throw new Error(`state read failed (HTTP ${stateResponse.status})`);
      queue = (await stateResponse.json()).usageQueue;
      if (queue?.guard?.status === 'blocked' || queue?.guard?.status === 'unknown') {
        throw new Error(queue.guard.message || 'usage queue startup guard did not clear');
      }
      if (queue?.lastPull && Number(queue.lastPull.warnings) > 0) {
        throw new Error(`first usage-queue pull reported warnings=${Number(queue.lastPull.warnings)}`);
      }
      if (queue?.running === true
        && queue?.guard?.status === 'clear'
        && typeof queue?.lastPull?.at === 'string'
        && Number(queue.lastPull.warnings) === 0) break;
      await wait(200);
    }
    if (queue?.running !== true
      || queue?.guard?.status !== 'clear'
      || typeof queue?.lastPull?.at !== 'string'
      || Number(queue.lastPull.warnings) !== 0) {
      throw new Error('daemon did not complete a clean first guarded usage-queue pull');
    }
  } catch (error) {
    if (!previousEnabled) {
      try {
        const rollback = await fetcher(new URL('/api/settings', base), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-ModelDeck-Token': token,
            Cookie: `modeldeck_session=${encodeURIComponent(token)}`,
          },
          body: JSON.stringify({ usageQueueConsumerEnabled: false }),
          redirect: 'error',
        });
        if (!rollback.ok) {
          error.message += `; kill-switch rollback failed (HTTP ${rollback.status})`;
        } else {
          const rollbackSettings = await rollback.json();
          if (rollbackSettings.usageQueueConsumerEnabled !== false) {
            error.message += '; kill-switch rollback was not confirmed';
          }
        }
      } catch { error.message += '; kill-switch rollback failed'; }
    }
    throw error;
  }
  stdout.write('Usage queue enabled; guard clear and first daemon pull clean\n');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // The stored token (Keychain on macOS, the owner-only file on Linux) when
  // the environment does not carry one (#811); never a throwaway token.
  const { token, source } = resolveMutationToken();
  // null, not undefined: the parameter default would re-read the raw variable.
  enableUsageQueue({ token: source === 'ephemeral' ? null : token }).catch((error) => {
    process.stderr.write(`enable-usage-queue.mjs: ${error.message}\n`);
    process.exitCode = 1;
  });
}
