import fs from 'node:fs';
import { parseUsagePull } from './usage-ingest.mjs';

export const USAGE_QUEUE_BATCH_SIZE = 500;
export const USAGE_QUEUE_CONSUMER_INTERVAL_MS = 5 * 60_000;
export const USAGE_QUEUE_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_CLIPROXY_BASE_URL = 'http://127.0.0.1:8317';

function summary() {
  return {
    records: 0,
    inserted: 0,
    duplicates: 0,
    resolved: 0,
    unresolved: 0,
    riderRejections: 0,
    warnings: {
      keyFile: 0,
      requestFailures: 0,
      httpFailures: 0,
      malformedBodies: 0,
      malformedRecords: 0,
      ingestFailures: 0,
    },
  };
}

export function usageQueueWarningCount(result) {
  return Object.values(result?.warnings || {}).reduce((total, count) => total + count, 0);
}

function emit(callback, message) {
  try { callback(message); } catch { /* Logging must never break the consumer. */ }
}

function loopbackUsageQueueUrl(baseUrl) {
  const url = new URL(baseUrl || DEFAULT_CLIPROXY_BASE_URL);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)
    || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('usage queue URL must be loopback HTTP');
  }
  url.pathname = '/v0/management/usage-queue';
  url.search = '';
  url.searchParams.set('count', String(USAGE_QUEUE_BATCH_SIZE));
  url.hash = '';
  return url;
}

/// Pull one destructive-read batch from CLIProxyAPI and ingest its explicit
/// allowlist representation. The management key is read for every pull so a
/// runtime rotation takes effect without restarting the daemon. It remains a
/// tick-local value: only the key-file path is retained on this object.
export class UsageQueueConsumer {
  constructor({
    store,
    managementKeyPath = null,
    baseUrl = DEFAULT_CLIPROXY_BASE_URL,
    machine = 'studio',
    fetcher = globalThis.fetch,
    readFile = fs.promises.readFile,
    warn = (message) => console.warn(`[modeldeck] ${message}`),
    log = (message) => console.log(`[modeldeck] ${message}`),
    requestTimeoutMs = USAGE_QUEUE_REQUEST_TIMEOUT_MS,
    canPull = () => true,
  } = {}) {
    if (!store?.ingestRequestUsage) throw new Error('usage queue consumer requires a Store');
    this.store = store;
    this.managementKeyPath = managementKeyPath;
    this.baseUrl = baseUrl;
    this.machine = machine;
    this.fetcher = fetcher;
    this.readFile = readFile;
    this.warn = warn;
    this.log = log;
    this.requestTimeoutMs = requestTimeoutMs;
    this.canPull = canPull;
  }

  async pull() {
    const result = summary();
    if (!this.canPull()) return { ...result, skipped: true };
    let url;
    try {
      url = loopbackUsageQueueUrl(this.baseUrl);
    } catch {
      result.warnings.requestFailures += 1;
      emit(this.warn, 'usage queue pull skipped: unsafe endpoint (warnings=1)');
      return result;
    }

    // Deliberately resolve the credential inside the tick. Never retain it on
    // the service, place it in settings/SQLite, or include read errors in logs.
    let managementKey;
    try {
      if (!this.managementKeyPath) throw new Error('management key path unavailable');
      managementKey = String(await this.readFile(this.managementKeyPath, 'utf8')).trim();
      if (!managementKey) throw new Error('management key is empty');
    } catch {
      result.warnings.keyFile += 1;
      emit(this.warn, 'usage queue pull skipped: management key unavailable (warnings=1)');
      return result;
    }

    let response;
    try {
      // The pool role may change while the key read is pending. Check
      // again immediately before the request that destructively drains it.
      if (!this.canPull()) return { ...result, skipped: true };
      const timeout = Number(this.requestTimeoutMs);
      response = await this.fetcher(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${managementKey}` },
        redirect: 'error',
        ...(Number.isFinite(timeout) && timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
      });
    } catch {
      result.warnings.requestFailures += 1;
      emit(this.warn, 'usage queue pull failed: proxy unavailable (warnings=1)');
      return result;
    } finally {
      managementKey = null;
    }

    if (!response?.ok) {
      result.warnings.httpFailures += 1;
      const status = Number.isInteger(response?.status) ? response.status : 'unknown';
      emit(this.warn, `usage queue pull failed: HTTP ${status} (warnings=1)`);
      try { await response?.body?.cancel(); } catch { /* Never read/log an error body. */ }
      return result;
    }

    let pull;
    try {
      pull = parseUsagePull(await response.text(), {
        machine: this.machine,
        resolveClientKeyProfile: (keySha256) => this.store.clientKeyProfile?.(keySha256) ?? null,
      });
      if (pull.kind === 'instances') throw new Error('unexpected instances envelope');
    } catch {
      result.warnings.malformedBodies += 1;
      emit(this.warn, 'usage queue pull failed: malformed response (warnings=1)');
      return result;
    }

    if (pull.kind === 'empty') return result;
    result.records = pull.records.length;
    result.warnings.malformedRecords = pull.malformedRecords.length;
    result.riderRejections = pull.riderRejections;
    if (pull.malformedRecords.length > 0) {
      emit(
        this.warn,
        `usage queue pull skipped malformed records: count=${pull.malformedRecords.length} (warnings=${pull.malformedRecords.length})`,
      );
    }
    if (pull.riderRejections > 0) {
      emit(
        this.warn,
        `usage queue rejected rider fields: count=${pull.riderRejections}`,
      );
    }

    try {
      Object.assign(result, this.store.ingestRequestUsage(pull.records));
    } catch {
      result.warnings.ingestFailures += 1;
      emit(this.warn, `usage queue ingest failed: records=${result.records} (warnings=1)`);
      return result;
    }

    // Counts are the whole log contract. Request/account/model data and the
    // response body never cross this boundary.
    emit(
      this.log,
      `usage queue ingested: records=${result.records} inserted=${result.inserted} duplicates=${result.duplicates} resolved=${result.resolved} unresolved=${result.unresolved} warnings=${usageQueueWarningCount(result)}`,
    );
    return result;
  }
}
