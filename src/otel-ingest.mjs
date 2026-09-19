import crypto from 'node:crypto';
import { setImmediate as yieldToServeLoop } from 'node:timers/promises';

// Bound both normalization work and synchronous SQLite inserts per serve turn.
export const OTEL_INGEST_BATCH_SIZE = 250;

const METRIC_NAMES = new Set(['claude_code.token.usage', 'claude_code.cost.usage']);
const SENSITIVE_KEY = /(email|password|authorization|apikey|accesstoken|refreshtoken|secret)/;
const MAX_QUARANTINE_RAW_JSON_BYTES = 64 * 1024;

const COMMON_ATTRIBUTE_KEYS = new Set([
  'model', 'effort', 'speed', 'query_source', 'query.source',
  'agent.name', 'agent_name', 'skill.name', 'skill_name',
  'session.id', 'session_id', 'user.account_uuid', 'account_uuid',
  'organization.id', 'organization_id', 'type', 'token.type', 'token_type',
]);
const EVENT_ATTRIBUTE_KEYS = new Set([
  ...COMMON_ATTRIBUTE_KEYS,
  'event.name', 'event_name',
  'request.id', 'request_id', 'requestId',
  'input_tokens', 'input.tokens', 'inputTokens',
  'output_tokens', 'output.tokens', 'outputTokens',
  'cache_read_tokens', 'cache.read_tokens', 'cacheReadTokens',
  'cache_creation_tokens', 'cache.creation_tokens', 'cacheCreationTokens',
  'cost_usd', 'cost.usd', 'costUsd',
]);

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function invalidPayload(message) {
  const error = new Error(`malformed OTLP JSON payload: ${message}`);
  error.statusCode = 400;
  return error;
}

function sensitiveKey(key) {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function anyValue(value) {
  if (!isObject(value)) return undefined;
  if (Object.hasOwn(value, 'stringValue')) return String(value.stringValue);
  if (Object.hasOwn(value, 'boolValue')) return Boolean(value.boolValue);
  if (Object.hasOwn(value, 'intValue')) {
    const parsed = Number(value.intValue);
    return Number.isSafeInteger(parsed) ? parsed : String(value.intValue);
  }
  if (Object.hasOwn(value, 'doubleValue')) {
    const parsed = Number(value.doubleValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (Array.isArray(value.arrayValue?.values)) {
    return value.arrayValue.values.map(anyValue).filter((item) => item !== undefined);
  }
  if (Array.isArray(value.kvlistValue?.values)) return attributes(value.kvlistValue.values);
  // bytesValue is deliberately not retained. It is not needed for Claude
  // usage attribution and may contain arbitrary opaque data.
  return undefined;
}

function attributes(input) {
  if (!Array.isArray(input)) return {};
  const result = {};
  for (const item of input) {
    if (!isObject(item) || typeof item.key !== 'string' || sensitiveKey(item.key)) continue;
    const decoded = anyValue(item.value);
    if (decoded !== undefined) result[item.key] = decoded;
  }
  return result;
}

function scalar(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : null;
}

function pick(input, names) {
  for (const name of names) {
    if (Object.hasOwn(input, name)) return input[name];
  }
  return undefined;
}

function numberValue(value, { integer = false } = {}) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) return null;
  return parsed;
}

function timestamp(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    try {
      const millis = BigInt(value) / 1_000_000n;
      const asNumber = Number(millis);
      if (Number.isFinite(asNumber)) return new Date(asNumber).toISOString();
    } catch { return null; }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    try { return new Date(Math.trunc(value / 1_000_000)).toISOString(); }
    catch { return null; }
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function scrub(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(isObject(item) && typeof item.key === 'string' && sensitiveKey(item.key)))
      .map(scrub);
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveKey(key))
    .map(([key, item]) => [key, scrub(item)]));
}

function details(input, handled) {
  return scrub(Object.fromEntries(Object.entries(input).filter(([key]) => !handled.has(key))));
}

function commonFields(input) {
  return {
    model: scalar(pick(input, ['model'])),
    effort: scalar(pick(input, ['effort'])),
    speed: scalar(pick(input, ['speed'])),
    querySource: scalar(pick(input, ['query_source', 'query.source'])),
    agentName: scalar(pick(input, ['agent.name', 'agent_name'])),
    skillName: scalar(pick(input, ['skill.name', 'skill_name'])),
    sessionId: scalar(pick(input, ['session.id', 'session_id'])),
    accountUuid: scalar(pick(input, ['user.account_uuid', 'account_uuid'])),
    organizationId: scalar(pick(input, ['organization.id', 'organization_id'])),
    tokenType: scalar(pick(input, ['type', 'token.type', 'token_type'])),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function withIngestKey(record) {
  return {
    ...record,
    ingestKey: crypto.createHash('sha256').update(stableJson(record)).digest('hex'),
  };
}

function boundedRawJson(value) {
  const rawJson = JSON.stringify(value) ?? 'null';
  if (Buffer.byteLength(rawJson) <= MAX_QUARANTINE_RAW_JSON_BYTES) {
    return { rawJson, truncated: false };
  }

  // Keep truncated quarantine data valid JSON while bounding the stored text.
  // The hash is calculated from the complete scrubbed subtree below, so retry
  // deduplication does not depend on the bounded preview.
  let low = 0;
  let high = rawJson.length;
  let bounded = JSON.stringify({ _modeldeckTruncated: true, rawJsonPrefix: '' });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ _modeldeckTruncated: true, rawJsonPrefix: rawJson.slice(0, middle) });
    if (Buffer.byteLength(candidate) <= MAX_QUARANTINE_RAW_JSON_BYTES) {
      bounded = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { rawJson: bounded, truncated: true };
}

function quarantineRecord(endpoint, reason, subtree) {
  // Quarantine rows are scrubbed before persistence, including OTLP key/value
  // attributes whose key is email-, authorization-, or secret-shaped.
  const scrubbed = scrub(subtree);
  const { rawJson, truncated } = boundedRawJson(scrubbed);
  return {
    ingestKey: crypto.createHash('sha256')
      .update(stableJson({ endpoint, reason, subtree: scrubbed }))
      .digest('hex'),
    endpoint,
    reason,
    rawJson,
    truncated,
  };
}

function metricPoints(metric) {
  for (const kind of ['sum', 'gauge']) {
    if (Array.isArray(metric?.[kind]?.dataPoints)) return metric[kind].dataPoints;
  }
  return null;
}

function metricDataPointCount(value) {
  if (!isObject(value)) return 0;
  if (Array.isArray(value.scopeMetrics)) {
    return value.scopeMetrics.reduce((count, scopeMetric) => count + metricDataPointCount(scopeMetric), 0);
  }
  if (Array.isArray(value.metrics)) {
    return value.metrics.reduce((count, metric) => count + metricDataPointCount(metric), 0);
  }
  return ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']
    .reduce((count, kind) => count + (Array.isArray(value[kind]?.dataPoints) ? value[kind].dataPoints.length : 0), 0);
}

export async function parseOtlpMetrics(payload, { yieldToServeLoop: yieldLoop = yieldToServeLoop } = {}) {
  if (!isObject(payload) || !Array.isArray(payload.resourceMetrics)) {
    throw invalidPayload('resourceMetrics must be an array');
  }
  const records = [];
  const quarantine = [];
  let unknown = 0;
  let rejectedDataPoints = 0;
  let processed = 0;
  for (const resourceMetric of payload.resourceMetrics) {
    if (++processed % OTEL_INGEST_BATCH_SIZE === 0) await yieldLoop();
    if (!isObject(resourceMetric) || !Array.isArray(resourceMetric.scopeMetrics)) {
      unknown += 1;
      rejectedDataPoints += metricDataPointCount(resourceMetric);
      quarantine.push(quarantineRecord('metrics', 'resource metric must contain scopeMetrics array', resourceMetric));
      continue;
    }
    const resourceAttributes = attributes(resourceMetric.resource?.attributes);
    for (const scopeMetric of resourceMetric.scopeMetrics) {
      if (++processed % OTEL_INGEST_BATCH_SIZE === 0) await yieldLoop();
      if (!isObject(scopeMetric) || !Array.isArray(scopeMetric.metrics)) {
        unknown += 1;
        rejectedDataPoints += metricDataPointCount(scopeMetric);
        quarantine.push(quarantineRecord('metrics', 'scope metric must contain metrics array', scopeMetric));
        continue;
      }
      const scopeAttributes = attributes(scopeMetric.scope?.attributes);
      for (const metric of scopeMetric.metrics) {
        if (++processed % OTEL_INGEST_BATCH_SIZE === 0) await yieldLoop();
        if (!isObject(metric) || !METRIC_NAMES.has(metric.name)) {
          unknown += 1;
          rejectedDataPoints += metricDataPointCount(metric);
          quarantine.push(quarantineRecord('metrics', 'metric name is not recognized', metric));
          continue;
        }
        const points = metricPoints(metric);
        if (!points) {
          unknown += 1;
          rejectedDataPoints += metricDataPointCount(metric);
          quarantine.push(quarantineRecord('metrics', 'metric must contain sum or gauge dataPoints', metric));
          continue;
        }
        for (const point of points) {
          if (++processed % OTEL_INGEST_BATCH_SIZE === 0) await yieldLoop();
          if (!isObject(point)) {
            unknown += 1;
            rejectedDataPoints += 1;
            quarantine.push(quarantineRecord('metrics', 'data point must be an object', point));
            continue;
          }
          const observedAt = timestamp(point.timeUnixNano);
          const value = numberValue(Object.hasOwn(point, 'asInt') ? point.asInt : point.asDouble);
          if (!observedAt || value == null) {
            unknown += 1;
            rejectedDataPoints += 1;
            quarantine.push(quarantineRecord('metrics', 'data point timestamp or value is invalid', point));
            continue;
          }
          const merged = { ...resourceAttributes, ...scopeAttributes, ...attributes(point.attributes) };
          records.push(withIngestKey({
            metricName: metric.name,
            observedAt,
            value,
            ...commonFields(merged),
            details: details(merged, COMMON_ATTRIBUTE_KEYS),
          }));
        }
      }
    }
  }
  return { records, quarantine, unknown, rejectedDataPoints };
}

function bodyFields(body) {
  const decoded = anyValue(body);
  if (isObject(decoded)) return decoded;
  if (typeof decoded !== 'string') return {};
  if (decoded === 'api_request' || decoded === 'claude_code.api_request') return { 'event.name': decoded };
  if (!decoded.trim().startsWith('{')) return {};
  try {
    const parsed = JSON.parse(decoded);
    return isObject(parsed) ? scrub(parsed) : {};
  } catch { return {}; }
}

function isApiRequest(value) {
  return value === 'api_request' || value === 'claude_code.api_request';
}

function logRecordCount(value) {
  if (!isObject(value)) return 0;
  if (Array.isArray(value.scopeLogs)) {
    return value.scopeLogs.reduce((count, scopeLog) => count + logRecordCount(scopeLog), 0);
  }
  return Array.isArray(value.logRecords) ? value.logRecords.length : 0;
}

export async function parseOtlpLogs(payload, { yieldToServeLoop: yieldLoop = yieldToServeLoop } = {}) {
  if (!isObject(payload) || !Array.isArray(payload.resourceLogs)) {
    throw invalidPayload('resourceLogs must be an array');
  }
  const records = [];
  const quarantine = [];
  let unknown = 0;
  let rejectedLogRecords = 0;
  let processed = 0;
  for (const resourceLog of payload.resourceLogs) {
    if (++processed % OTEL_INGEST_BATCH_SIZE === 0) await yieldLoop();
    if (!isObject(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) {
      unknown += 1;
      rejectedLogRecords += logRecordCount(resourceLog);
      quarantine.push(quarantineRecord('logs', 'resource log must contain scopeLogs array', resourceLog));
      continue;
    }
    const resourceAttributes = attributes(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs) {
      if (++processed % OTEL_INGEST_BATCH_SIZE === 0) await yieldLoop();
      if (!isObject(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
        unknown += 1;
        rejectedLogRecords += logRecordCount(scopeLog);
        quarantine.push(quarantineRecord('logs', 'scope log must contain logRecords array', scopeLog));
        continue;
      }
      const scopeAttributes = attributes(scopeLog.scope?.attributes);
      for (const logRecord of scopeLog.logRecords) {
        if (++processed % OTEL_INGEST_BATCH_SIZE === 0) await yieldLoop();
        if (!isObject(logRecord)) {
          unknown += 1;
          rejectedLogRecords += 1;
          quarantine.push(quarantineRecord('logs', 'log record must be an object', logRecord));
          continue;
        }
        const recordAttributes = attributes(logRecord.attributes);
        const body = bodyFields(logRecord.body);
        const eventName = pick(recordAttributes, ['event.name', 'event_name'])
          ?? pick(body, ['event.name', 'event_name', 'name']);
        const observedAt = timestamp(logRecord.timeUnixNano ?? logRecord.observedTimeUnixNano);
        if (!isApiRequest(eventName) || !observedAt) {
          unknown += 1;
          rejectedLogRecords += 1;
          quarantine.push(quarantineRecord('logs', 'log record event name or timestamp is invalid', logRecord));
          continue;
        }
        const merged = { ...resourceAttributes, ...scopeAttributes, ...body, ...recordAttributes };
        records.push(withIngestKey({
          eventName: 'api_request',
          observedAt,
          ...commonFields(merged),
          requestId: scalar(pick(merged, ['request_id', 'request.id', 'requestId'])),
          inputTokens: numberValue(pick(merged, ['input_tokens', 'input.tokens', 'inputTokens']), { integer: true }),
          outputTokens: numberValue(pick(merged, ['output_tokens', 'output.tokens', 'outputTokens']), { integer: true }),
          cacheReadTokens: numberValue(pick(merged, ['cache_read_tokens', 'cache.read_tokens', 'cacheReadTokens']), { integer: true }),
          cacheCreationTokens: numberValue(pick(merged, ['cache_creation_tokens', 'cache.creation_tokens', 'cacheCreationTokens']), { integer: true }),
          costUsd: numberValue(pick(merged, ['cost_usd', 'cost.usd', 'costUsd'])),
          details: details(merged, EVENT_ATTRIBUTE_KEYS),
        }));
      }
    }
  }
  return { records, quarantine, unknown, rejectedLogRecords };
}
