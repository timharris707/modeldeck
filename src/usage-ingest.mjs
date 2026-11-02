import fs from 'node:fs';
import path from 'node:path';
import { hash } from './detectors/shared.mjs';

const LIMIT_STATUS_VALUES = new Set(['allowed', 'allowed_warning', 'rejected']);
const LIMIT_STATUS_RANK = new Map([['allowed', 0], ['allowed_warning', 1], ['rejected', 2]]);
const PROVIDER_REQUEST_ID_RE = /^[A-Za-z0-9_.-]+$/;
const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;
const RESET_WINDOW_MS = 400 * 24 * 60 * 60 * 1_000;
const ANTHROPIC_DOCUMENTED_LIMITS = [
  'requests',
  'tokens',
  'input-tokens',
  'output-tokens',
];

function object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeNumber(value, label, { integer = false, defaultValue = null } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`${label} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return number;
}

function boolean(value, label, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new Error(`${label} must be a boolean`);
}

function observedTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error('usage record timestamp must be an ISO timestamp');
  return new Date(timestamp).toISOString();
}

function riderHeaderReader(headers, onReject = () => {}) {
  const entries = Object.entries(object(headers));
  return {
    entries,
    reject: onReject,
    value(name) {
      const matches = entries
        .filter(([headerName]) => headerName.toLowerCase() === name.toLowerCase());
      if (matches.length === 0) return null;
      const values = matches.length === 1 ? matches[0][1] : null;
      if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim()) {
        onReject();
        return null;
      }
      return values[0].trim();
    },
  };
}

function parsedHeader(headers, name, parse) {
  const value = headers.value(name);
  if (value == null) return null;
  const parsed = parse(value);
  if (parsed == null) headers.reject();
  return parsed;
}

function providerRequestId(headers, rawKeys) {
  const value = parsedHeader(headers, 'request-id', (candidate) => (
    candidate.length <= 128 && PROVIDER_REQUEST_ID_RE.test(candidate) ? candidate : null
  ));
  if (value != null && rawKeys.some((rawKey) => rawKey && value.includes(rawKey))) {
    headers.reject();
    return null;
  }
  return value;
}

function boundedNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'string' || !DECIMAL_NUMBER_RE.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function headerNumber(headers, name, bounds = {}) {
  return parsedHeader(headers, name, (value) => boundedNumber(value, bounds));
}

function usedPercent(headers, name) {
  return headerNumber(headers, name, { min: 0, max: 100 });
}

function utilizationPercent(headers, name) {
  const utilization = headerNumber(headers, name, { min: 0, max: 1 });
  return utilization == null ? null : utilization * 100;
}

function boundedResetAt(timestamp, observedAt) {
  const observedTimestampMs = Date.parse(observedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(observedTimestampMs)) return null;
  if (Math.abs(timestamp - observedTimestampMs) > RESET_WINDOW_MS) return null;
  try { return new Date(timestamp).toISOString(); }
  catch { return null; }
}

function epochResetAt(headers, name, observedAt) {
  const seconds = headerNumber(headers, name, { min: 0 });
  if (seconds == null) return null;
  const resetAt = boundedResetAt(seconds * 1_000, observedAt);
  if (resetAt == null) headers.reject();
  return resetAt;
}

function rfc3339Timestamp(value) {
  const parts = value.match(RFC3339_RE);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = Number(parts[7] || 0);
  const offsetMinute = Number(parts[8] || 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const timestamp = Date.parse(value);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(timestamp)
    ? timestamp
    : null;
}

function isoResetAt(headers, name, observedAt) {
  const value = headers.value(name);
  if (value == null) return null;
  const timestamp = rfc3339Timestamp(value);
  const resetAt = timestamp == null ? null : boundedResetAt(timestamp, observedAt);
  if (resetAt == null) headers.reject();
  return resetAt;
}

function headerStatus(headers, name) {
  return parsedHeader(headers, name, (value) => {
    const normalized = value.toLowerCase();
    return LIMIT_STATUS_VALUES.has(normalized) ? normalized : null;
  });
}

function mostConstrained(candidates) {
  const constrained = candidates.filter((candidate) => (LIMIT_STATUS_RANK.get(candidate.limitStatus) || 0) > 0);
  if (constrained.length > 0) {
    return constrained.reduce((selected, candidate) => {
      const rankDifference = LIMIT_STATUS_RANK.get(candidate.limitStatus) - LIMIT_STATUS_RANK.get(selected.limitStatus);
      if (rankDifference !== 0) return rankDifference > 0 ? candidate : selected;
      return (candidate.limitUsedPercent ?? -1) > (selected.limitUsedPercent ?? -1) ? candidate : selected;
    });
  }
  const withUsage = candidates.filter((candidate) => candidate.limitUsedPercent != null);
  if (withUsage.length > 0) {
    return withUsage.reduce((selected, candidate) => (
      candidate.limitUsedPercent > selected.limitUsedPercent ? candidate : selected
    ));
  }
  return candidates.find((candidate) => candidate.limitStatus != null || candidate.limitResetsAt != null)
    || { limitUsedPercent: null, limitStatus: null, limitResetsAt: null };
}

function documentedAnthropicLimit(headers, observedAt, resource) {
  const prefix = `anthropic-ratelimit-${resource}`;
  const limit = headerNumber(headers, `${prefix}-limit`, { min: 0 });
  const remaining = headerNumber(headers, `${prefix}-remaining`, { min: 0 });
  const calculated = limit != null && limit > 0 && remaining != null
    ? ((limit - remaining) / limit) * 100
    : null;
  const parsedPercent = calculated != null && calculated >= 0 && calculated <= 100 ? calculated : null;
  if (limit != null && remaining != null && parsedPercent == null) headers.reject();
  return {
    limitUsedPercent: parsedPercent,
    limitStatus: null,
    limitResetsAt: isoResetAt(headers, `${prefix}-reset`, observedAt),
  };
}

function retryAfterResetAt(headers, observedAt) {
  const seconds = headerNumber(headers, 'retry-after', {
    min: 0,
    max: RESET_WINDOW_MS / 1_000,
  });
  return seconds == null ? null : boundedResetAt(Date.parse(observedAt) + seconds * 1_000, observedAt);
}

function parseAnthropicLimitHeaders(headers, observedAt) {
  const selected = mostConstrained([
    {
      limitUsedPercent: usedPercent(headers, 'anthropic-ratelimit-unified-fallback-percentage'),
      limitStatus: headerStatus(headers, 'anthropic-ratelimit-unified-status'),
      limitResetsAt: epochResetAt(headers, 'anthropic-ratelimit-unified-reset', observedAt),
    },
    ...['5h', '7d'].map((window) => ({
      limitUsedPercent: utilizationPercent(headers, `anthropic-ratelimit-unified-${window}-utilization`),
      limitStatus: headerStatus(headers, `anthropic-ratelimit-unified-${window}-status`),
      limitResetsAt: epochResetAt(headers, `anthropic-ratelimit-unified-${window}-reset`, observedAt),
    })),
    ...ANTHROPIC_DOCUMENTED_LIMITS.map((resource) => (
      documentedAnthropicLimit(headers, observedAt, resource)
    )),
  ]);
  if (selected.limitResetsAt == null) {
    selected.limitResetsAt = retryAfterResetAt(headers, observedAt);
  }
  return selected;
}

function codexLimitIds(headers) {
  const ids = new Set();
  for (const [name] of headers.entries) {
    const match = name.toLowerCase().match(/^x-(codex(?:-[a-z0-9]+)*)-(?:primary|secondary)-(?:used-percent|reset-at)$/);
    if (match?.[1].length <= 64) ids.add(match[1]);
  }
  return ids;
}

function parseCodexLimitHeaders(headers, observedAt) {
  const selected = mostConstrained([...codexLimitIds(headers)].flatMap((id) => (
    ['primary', 'secondary'].map((window) => ({
      limitUsedPercent: usedPercent(headers, `x-${id}-${window}-used-percent`),
      limitStatus: null,
      limitResetsAt: epochResetAt(headers, `x-${id}-${window}-reset-at`, observedAt),
    }))
  )));
  return selected;
}

function parsedSource(record) {
  const source = requiredText(
    firstDefined(record.source, record.source_email_hash, record.sourceEmailHash),
    'usage record source',
  );
  const authType = optionalText(firstDefined(record.auth_type, record.authType))?.toLowerCase();
  return authType === 'apikey'
    ? { value: hash(source), rawKey: source }
    : { value: source, rawKey: null };
}

function resolvedClientKeyProfile(apiKey, resolveClientKeyProfile) {
  const profile = typeof apiKey === 'string' && apiKey.length > 0
    ? resolveClientKeyProfile(hash(apiKey)) : null;
  const label = profile?.profileLabel;
  // Legacy map rows predate the report boundary's label gate. An invalid
  // stored label must degrade to honest NULL, never abort a dequeued batch.
  const profileLabel = typeof label === 'string'
    && label.trim()
    && label.length <= 128
    && !/\p{Cc}/u.test(label)
    ? label
    : null;
  const machine = typeof profile?.machine === 'string' && /^[a-z0-9-]{1,64}$/.test(profile.machine)
    ? profile.machine : null;
  return { profileLabel, machine };
}

export function classifyUserAgent(value) {
  const userAgent = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!userAgent) return 'unknown';
  if (userAgent.includes('codex')) return 'codex';
  if (userAgent.includes('claude')) return 'claude-code';
  if (userAgent.includes('curl')) return 'curl';
  if (userAgent.includes('python')) return 'python';
  if (userAgent.includes('node')) return 'node';
  return 'other';
}

const USER_AGENT_CLASSES = new Set(['claude-code', 'codex', 'curl', 'python', 'node', 'other', 'unknown']);

function userAgentClass(record) {
  const supplied = optionalText(firstDefined(record.user_agent_class, record.userAgentClass))?.toLowerCase();
  if (supplied) return USER_AGENT_CLASSES.has(supplied) ? supplied : 'other';
  return classifyUserAgent(record.user_agent);
}

/// Convert one proxy archive record into the warehouse's explicit allowlist.
/// Unknown fields are intentionally discarded; in particular raw api_key,
/// access_token_sha256, response_headers, user-agent/IP data, and failure
/// bodies can never reach this returned object or SQLite. Only named scalar
/// rider values are extracted from response_headers, and key-auth source is
/// hashed before it crosses this boundary.
export function parseUsageRecord(input, {
  machine = 'studio',
  onRiderRejection = () => {},
  resolveClientKeyProfile = () => null,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('usage record must be an object');
  const record = input;
  const rawClientKey = typeof record.api_key === 'string' ? record.api_key : null;
  const profile = resolvedClientKeyProfile(rawClientKey, resolveClientKeyProfile);
  const breakdown = object(record.token_breakdown);
  const breakdownInput = object(breakdown.input);
  const breakdownOutput = object(breakdown.output);
  const legacyTokens = object(record.tokens);
  const failure = object(record.fail);

  const statusCode = nonNegativeNumber(
    firstDefined(record.status_code, record.statusCode, failure.status_code, failure.statusCode),
    'usage record status_code',
    { integer: true },
  );
  const inputUncached = nonNegativeNumber(
    firstDefined(record.input_uncached, record.inputUncached, breakdownInput.uncached_tokens, legacyTokens.input_tokens),
    'usage record input_uncached',
    { integer: true, defaultValue: 0 },
  );
  const inputCacheRead = nonNegativeNumber(
    firstDefined(record.input_cache_read, record.inputCacheRead, breakdownInput.cache_read_tokens, legacyTokens.cache_read_tokens, legacyTokens.cached_tokens),
    'usage record input_cache_read',
    { integer: true, defaultValue: 0 },
  );
  const inputCacheWrite = nonNegativeNumber(
    firstDefined(record.input_cache_write, record.inputCacheWrite, breakdownInput.cache_write_tokens, legacyTokens.cache_creation_tokens),
    'usage record input_cache_write',
    { integer: true, defaultValue: 0 },
  );
  const outputTotal = nonNegativeNumber(
    firstDefined(record.output_total, record.outputTotal, breakdownOutput.total_tokens, legacyTokens.output_tokens),
    'usage record output_total',
    { integer: true, defaultValue: 0 },
  );
  const outputReasoning = nonNegativeNumber(
    firstDefined(record.output_reasoning, record.outputReasoning, breakdownOutput.reasoning_tokens, legacyTokens.reasoning_tokens),
    'usage record output_reasoning',
    { integer: true, defaultValue: 0 },
  );
  const total = nonNegativeNumber(
    firstDefined(record.total, breakdown.total_tokens, legacyTokens.total_tokens),
    'usage record total',
    { integer: true, defaultValue: inputUncached + inputCacheRead + inputCacheWrite + outputTotal },
  );
  const failed = boolean(record.failed, 'usage record failed', statusCode != null && statusCode >= 400);
  const provider = requiredText(record.provider, 'usage record provider').toLowerCase();
  if (!['claude', 'codex'].includes(provider)) throw new Error('usage record provider must be claude or codex');
  const observedAt = observedTimestamp(firstDefined(record.timestamp, record.observed_at, record.observedAt));
  const source = parsedSource(record);
  const responseHeaders = riderHeaderReader(record.response_headers, onRiderRejection);
  const limits = provider === 'claude'
    ? parseAnthropicLimitHeaders(responseHeaders, observedAt)
    : parseCodexLimitHeaders(responseHeaders, observedAt);

  return {
    requestId: requiredText(firstDefined(record.request_id, record.requestId), 'usage record request_id'),
    machine: requiredText(profile.machine ?? machine, 'usage record machine'),
    observedAt,
    profileLabel: profile.profileLabel,
    source: source.value,
    provider,
    providerRequestId: providerRequestId(responseHeaders, [
      source.rawKey,
      rawClientKey,
    ]),
    model: requiredText(record.model, 'usage record model'),
    alias: optionalText(record.alias),
    reasoningEffort: optionalText(firstDefined(record.reasoning_effort, record.reasoningEffort)),
    endpoint: optionalText(record.endpoint),
    userAgentClass: userAgentClass(record),
    failed,
    statusCode,
    latencyMs: nonNegativeNumber(firstDefined(record.latency_ms, record.latencyMs), 'usage record latency_ms'),
    ttftMs: nonNegativeNumber(firstDefined(record.ttft_ms, record.ttftMs), 'usage record ttft_ms'),
    inputUncached,
    inputCacheRead,
    inputCacheWrite,
    outputTotal,
    outputReasoning,
    total,
    ...limits,
  };
}

export function parseUsagePull(input, options = {}) {
  let document = input;
  if (Buffer.isBuffer(document)) document = document.toString('utf8');
  if (typeof document === 'string') {
    try { document = JSON.parse(document); }
    catch { throw new Error('usage pull is not valid JSON'); }
  }
  // The live CLIProxyAPI management endpoint answers with a BARE ARRAY of
  // records; the {usage: [...]} envelope exists only in archive files. Both
  // are one queue batch (0.4.6 go-live field find — the daemon's first real
  // pull counted malformedBodies on every tick and consumed nothing).
  if (Array.isArray(document)) document = { usage: document };
  if (!document || typeof document !== 'object') {
    throw new Error('usage pull must be a JSON object or array');
  }
  if (!Object.hasOwn(document, 'usage') && Object.hasOwn(document, 'instances')) {
    return { kind: 'instances', records: [] };
  }
  if (!Object.hasOwn(document, 'usage')) throw new Error('usage pull is missing usage');
  if (document.usage == null) return { kind: 'empty', records: [] };
  if (!Array.isArray(document.usage)) throw new Error('usage pull usage must be an array or null');
  if (document.usage.length === 0) return { kind: 'empty', records: [] };
  const records = [];
  const malformedRecords = [];
  let riderRejections = 0;
  const recordOptions = {
    ...options,
    onRiderRejection: () => { riderRejections += 1; },
  };
  document.usage.forEach((record, index) => {
    try { records.push(parseUsageRecord(record, recordOptions)); }
    catch (error) { malformedRecords.push({ index, message: error.message }); }
  });
  return { kind: 'usage', records, malformedRecords, riderRejections };
}

/// Read pull-*.json files without writing, renaming, or deleting the archive.
/// Valid records are collected before the Store transaction begins; malformed
/// files and records are counted and skipped without blocking the rest.
export function ingestUsageArchive({ store, directory, machine = 'studio', warn = () => {} } = {}) {
  if (!store?.ingestRequestUsage) throw new Error('usage archive ingest requires a Store');
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('usage archive directory is required');
  const resolvedDirectory = path.resolve(directory);
  if (!fs.existsSync(resolvedDirectory)) throw new Error(`usage archive directory does not exist: ${resolvedDirectory}`);
  if (!fs.statSync(resolvedDirectory).isDirectory()) throw new Error(`usage archive path must be a directory: ${resolvedDirectory}`);

  const files = fs.readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^pull-.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const records = [];
  const summary = {
    files: files.length,
    usageFiles: 0,
    records: 0,
    inserted: 0,
    duplicates: 0,
    resolved: 0,
    unresolved: 0,
    riderRejections: 0,
    warnings: {
      emptyUsageFiles: 0,
      instancesFiles: 0,
      malformedFiles: 0,
      malformedRecords: 0,
    },
  };

  for (const name of files) {
    let pull;
    try {
      pull = parseUsagePull(fs.readFileSync(path.join(resolvedDirectory, name), 'utf8'), {
        machine,
        resolveClientKeyProfile: (keySha256) => store.clientKeyProfile?.(keySha256) ?? null,
      });
    } catch (error) {
      summary.warnings.malformedFiles += 1;
      warn(`usage-ingest: skipped ${name}: malformed file: ${error.message}`);
      continue;
    }
    if (pull.kind === 'empty') {
      summary.warnings.emptyUsageFiles += 1;
      warn(`usage-ingest: skipped ${name}: usage is empty`);
      continue;
    }
    if (pull.kind === 'instances') {
      summary.warnings.instancesFiles += 1;
      warn(`usage-ingest: skipped ${name}: instances payload is not request usage`);
      continue;
    }
    summary.usageFiles += 1;
    summary.riderRejections += pull.riderRejections;
    if (pull.riderRejections > 0) {
      warn(`usage-ingest: ${name}: rejected rider fields: count=${pull.riderRejections}`);
    }
    for (const malformed of pull.malformedRecords) {
      summary.warnings.malformedRecords += 1;
      warn(`usage-ingest: skipped ${name} record ${malformed.index}: ${malformed.message}`);
    }
    summary.records += pull.records.length;
    records.push(...pull.records);
  }

  Object.assign(summary, store.ingestRequestUsage(records));
  return summary;
}
