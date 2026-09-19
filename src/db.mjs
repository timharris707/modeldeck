import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value?.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function canonicalDirectory(value, label) {
  const resolved = path.resolve(expandHome(value));
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${resolved}`);
  return { path: fs.realpathSync(resolved), stat };
}

function now() {
  return new Date().toISOString();
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return { ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFileStamp(left, right) {
  return left == null
    ? right == null
    : right != null && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function walChecksum(bytes, byteOrder, seed = [0, 0]) {
  if (bytes.length % 8 !== 0) throw new Error('ModelDeck database WAL checksum input is invalid');
  const readWord = byteOrder === 'little'
    ? (offset) => bytes.readUInt32LE(offset)
    : (offset) => bytes.readUInt32BE(offset);
  let [first, second] = seed;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    first = (first + readWord(offset) + second) >>> 0;
    second = (second + readWord(offset + 4) + first) >>> 0;
  }
  return [first, second];
}

// Build a committed SQLite image without opening the on-disk database. A
// filesystem-backed read-only SQLite connection still creates sidecars for a
// closed WAL database and writes reader marks into a live -shm file. The
// linter is report-only, so it reads main/WAL bytes and applies committed WAL
// frames to an in-memory image instead.
function applyCommittedWal(database, wal) {
  if (!wal || wal.length < 32) return database;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error('ModelDeck database WAL header is invalid');
  const byteOrder = magic === 0x377f0682 ? 'little' : 'big';
  let checksum = walChecksum(wal.subarray(0, 24), byteOrder);
  if (wal.readUInt32BE(24) !== checksum[0] || wal.readUInt32BE(28) !== checksum[1]) {
    throw new Error('ModelDeck database WAL header checksum is invalid');
  }
  const encodedPageSize = wal.readUInt32BE(8);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error('ModelDeck database WAL page size is invalid');
  }
  if (database.length < 100 || database.length % pageSize !== 0) {
    throw new Error('ModelDeck database size does not match its WAL page size');
  }
  const encodedDatabasePageSize = database.readUInt16BE(16);
  const databasePageSize = encodedDatabasePageSize === 1 ? 65_536 : encodedDatabasePageSize;
  if (databasePageSize !== pageSize) throw new Error('ModelDeck database and WAL page sizes disagree');
  const frameSize = pageSize + 24;
  const frameCount = Math.floor((wal.length - 32) / frameSize);
  const maximumDatabasePages = (database.length / pageSize) + frameCount;
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  let lastCommit = -1;
  let committedPages = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const offset = 32 + index * frameSize;
    const pageNumber = wal.readUInt32BE(offset);
    if (!pageNumber || wal.readUInt32BE(offset + 8) !== salt1 || wal.readUInt32BE(offset + 12) !== salt2) break;
    const databaseSize = wal.readUInt32BE(offset + 4);
    if (pageNumber > maximumDatabasePages || databaseSize > maximumDatabasePages) {
      throw new Error('ModelDeck database WAL commit database size is invalid');
    }
    checksum = walChecksum(wal.subarray(offset, offset + 8), byteOrder, checksum);
    checksum = walChecksum(wal.subarray(offset + 24, offset + 24 + pageSize), byteOrder, checksum);
    if (wal.readUInt32BE(offset + 16) !== checksum[0] || wal.readUInt32BE(offset + 20) !== checksum[1]) {
      throw new Error('ModelDeck database WAL frame checksum is invalid');
    }
    if (databaseSize > 0) {
      lastCommit = index;
      committedPages = databaseSize;
    }
  }
  if (lastCommit < 0) return database;
  const image = Buffer.alloc(committedPages * pageSize);
  database.copy(image, 0, 0, Math.min(database.length, image.length));
  for (let index = 0; index <= lastCommit; index += 1) {
    const offset = 32 + index * frameSize;
    const pageNumber = wal.readUInt32BE(offset);
    if (pageNumber > committedPages) continue;
    wal.copy(image, (pageNumber - 1) * pageSize, offset + 24, offset + 24 + pageSize);
  }
  return image;
}

function readOnlyDatabaseImage(dbPath) {
  const walPath = `${dbPath}-wal`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const databaseBefore = fileStamp(dbPath);
    const walBefore = fileStamp(walPath);
    if (!databaseBefore) throw new Error(`ModelDeck database does not exist: ${dbPath}`);
    try {
      const database = fs.readFileSync(dbPath);
      const wal = walBefore ? fs.readFileSync(walPath) : null;
      const databaseAfter = fileStamp(dbPath);
      const walAfter = fileStamp(walPath);
      if (sameFileStamp(databaseBefore, databaseAfter) && sameFileStamp(walBefore, walAfter)) {
        const image = Buffer.from(applyCommittedWal(database, wal));
        // Bytes 18/19 select WAL (2) versus rollback (1) read/write format.
        // The deserialized image has no filesystem WAL, so mark this private
        // in-memory copy as rollback format before SQLite opens it.
        if (image.length >= 20) {
          image[18] = 1;
          image[19] = 1;
        }
        return image;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || attempt === 2) throw error;
    }
  }
  throw new Error('ModelDeck database changed repeatedly while the read-only snapshot was collected');
}

// Issue #181: feature consumers need only the newest row per (account, scope),
// but keep a wide history window as a conservative operational/debugging
// margin. The newest row is protected independently of age for idle accounts.
export const USAGE_SNAPSHOT_RETENTION_DAYS = 90;
export const USAGE_SNAPSHOT_PRUNE_BATCH_SIZE = 500;
// Keep usage indexes hot across reads of multi-gigabyte databases (64 MiB).
const SQLITE_PAGE_CACHE_KIB = 65_536;
export const OTEL_QUARANTINE_RETENTION_DAYS = 7;
export const OTEL_QUARANTINE_MAX_ROWS = 50_000;
export const OTEL_QUARANTINE_PRUNE_BATCH_SIZE = 500;
export const REQUEST_USAGE_RETENTION_DAYS = 400;
export const REQUEST_USAGE_PRUNE_BATCH_SIZE = 500;
// Raw history retains the newest rows; truncated=true means older matching
// observations were omitted from the response.
export const USAGE_HISTORY_RAW_LIMIT = 10_000;
export const CORPUS_PROVIDERS = Object.freeze(['claude', 'codex', 'grok']);
export const MAX_AUTO_REFRESH_INTERVAL_SECONDS = 3_600;
// Default account swatch per provider (the user can override it per account).
export const ACCOUNT_COLORS = Object.freeze({
  claude: '#d97757',
  codex: '#48a868',
  grok: '#6f7ae8',
});

export const DEFAULT_SETTINGS = Object.freeze({
  claudeManaged: null,
  codexManaged: null,
  autoRefreshEnabled: true,
  // Issue #176: expired Claude OAuth credentials may be renewed through the
  // provider CLI after the normal scheduled refresh identifies them. This is
  // independently switchable from usage refreshes so the background
  // invocation can be stopped without making the deck stale.
  autoRenewEnabled: true,
  // Issue #342: the unauthenticated OTLP exporter endpoints are reachable
  // only over the daemon's loopback listener and remain absent until the
  // operator explicitly enables collection.
  otelReceiverEnabled: false,
  autoRefreshIntervalSeconds: 300,
  // Issue #90 change-event provenance: flips to true — permanently — the
  // first time a settings write CHANGES autoRefreshIntervalSeconds (or the
  // app asserts an explicit picker selection). Key presence alone can't
  // carry this fact because the app PUTs full merged documents; a change
  // event can't false-positive. While false, the active-session refresh cap
  // may slow the default cadence; once true, the user's interval always wins.
  autoRefreshIntervalCustomized: false,
  // Issue #187 (Tim directive 2026-07-29): OFF by default — an active
  // session is exactly when usage burns fastest and users most want the
  // deck live (first outside tester hit this within days). The pause and
  // the #90 active-session cap are opt-in via the Settings toggle; a
  // stored value from an older install is preserved as-is.
  pauseWhileActive: false,
  // Issue #204: sharing Claude's user-scope MCP configuration and memory is
  // deliberately opt-in. The engine never infers consent from shared files
  // left behind by an earlier enable/disable cycle.
  sharedUserScopeEnabled: false,
  // Issue #338/#388: usage-queue reads drain the proxy queue. This stays an
  // operator-owned cutover switch: release day retires both old consumers,
  // then enables the guarded daemon consumer in the same motion.
  usageQueueConsumerEnabled: false,
  layout: 'two-column',
  defaultSort: 'next-reset',
  notificationThresholdPercent: 25,
  menuBarStyle: 'icon-only',
  // Menu bar percent source: '' = lowest remaining across all enabled
  // accounts (the original behavior); an account id pins the menu bar
  // percentage to that single account, shown continuously. The id is not
  // validated against the accounts table — accounts can be removed after
  // being pinned, and the app falls back to lowest-across when the id no
  // longer resolves.
  menuBarAccountId: '',
  // Issue #238 quiet mode: WHEN the menu bar shows its indicator. '' =
  // always (the pre-#238 behavior); 'below:<1-99>' = percentage modes show
  // the number only under that percent; 'yellow' / 'red' = health modes
  // show the dot only from that verdict up. Free string like
  // menuBarAccountId — the app owns the grammar and treats anything it
  // doesn't recognize as '' (always), so old and new builds round-trip
  // each other's values safely. Display-only: notifications are unaffected.
  menuBarShowWhen: '',
  // Issue #488: per-provider pool-total display format shared by the deck
  // header and the menu bar's total modes — comma-joined
  // '<provider>:<sum|share>' entries (e.g. 'claude:share'); '' = nothing
  // chosen. Free string like menuBarShowWhen — the app owns the grammar and
  // ignores entries it doesn't recognize, so old and new builds round-trip
  // each other's values safely. Display-only.
  poolTotalFormat: '',
  // Issue #242 deck chip labels: '' = dot only (the default — the dot is
  // shape-coded green circle / yellow triangle / red octagon / hollow
  // no-data ring, so color is never the only signal); 'show' = dot +
  // verdict word (the Settings → General → Accessibility toggle). Free
  // string like menuBarShowWhen — the app owns the grammar and treats
  // anything it doesn't recognize as '' (dot only), so old and new builds
  // round-trip each other's values safely. Display-only: the chip's
  // tooltip, detail popover, and VoiceOver strings are unaffected.
  deckHealthLabels: '',
  // Issue #388 (charter d10): 0.4.6 defaults the dashboard ON. The setting is
  // retained as a kill switch, and a stored value always wins — changing this
  // default never rewrites an existing database's settings document.
  usageAnalyticsEnabled: true,
  // Issue #605: additional Claude homes for transcript ingest to scan
  // READ-ONLY, each attributed to an existing profile label. Entries are
  // { path, profileSlug }. Enumeration skips a root that is itself a symlink
  // or that overlaps the managed profiles directory, and never traverses
  // symlinks inside one — the same rule as the managed root.
  extraClaudeScanRoots: Object.freeze([]),
});

function validateSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`unknown setting: ${key}`);
  if (['claudeManaged', 'codexManaged'].includes(key) && value !== null && typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean or null`);
  }
  if (['autoRefreshEnabled', 'autoRenewEnabled', 'otelReceiverEnabled', 'autoRefreshIntervalCustomized', 'pauseWhileActive', 'sharedUserScopeEnabled', 'usageAnalyticsEnabled', 'usageQueueConsumerEnabled'].includes(key) && typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean`);
  }
  if (key === 'autoRefreshIntervalSeconds'
    && (!Number.isInteger(value) || value < 60 || value > MAX_AUTO_REFRESH_INTERVAL_SECONDS)) {
    throw new Error('autoRefreshIntervalSeconds must be an integer from 60 to 3600');
  }
  if (key === 'layout' && !['two-column', 'single-column'].includes(value)) {
    throw new Error('layout must be two-column or single-column');
  }
  if (key === 'defaultSort' && !['next-reset', 'lowest-remaining'].includes(value)) {
    throw new Error('defaultSort must be next-reset or lowest-remaining');
  }
  if (key === 'notificationThresholdPercent' && (!Number.isInteger(value) || value < 1 || value > 99)) {
    throw new Error('notificationThresholdPercent must be an integer from 1 to 99');
  }
  if (key === 'menuBarStyle' && !['icon-only', 'icon-and-percent'].includes(value)) {
    throw new Error('menuBarStyle must be icon-only or icon-and-percent');
  }
  if (key === 'menuBarAccountId' && (typeof value !== 'string' || value.length > 128)) {
    throw new Error('menuBarAccountId must be a string of at most 128 characters');
  }
  if (key === 'menuBarShowWhen' && (typeof value !== 'string' || value.length > 64)) {
    throw new Error('menuBarShowWhen must be a string of at most 64 characters');
  }
  if (key === 'deckHealthLabels' && (typeof value !== 'string' || value.length > 64)) {
    throw new Error('deckHealthLabels must be a string of at most 64 characters');
  }
  if (key === 'poolTotalFormat' && (typeof value !== 'string' || value.length > 64)) {
    throw new Error('poolTotalFormat must be a string of at most 64 characters');
  }
  if (key === 'extraClaudeScanRoots') {
    if (!Array.isArray(value) || value.length > 8) {
      throw new Error('extraClaudeScanRoots must be an array of at most 8 entries');
    }
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some((entryKey) => !['path', 'profileSlug'].includes(entryKey))) {
        throw new Error('each extraClaudeScanRoots entry must be a { path, profileSlug } object');
      }
      if (typeof entry.path !== 'string' || entry.path.includes('\0')
        || !path.isAbsolute(entry.path) || entry.path.length > 1024) {
        throw new Error('extraClaudeScanRoots path must be an absolute path of at most 1024 characters');
      }
      if (typeof entry.profileSlug !== 'string' || !entry.profileSlug.trim() || entry.profileSlug.length > 128) {
        throw new Error('extraClaudeScanRoots profileSlug must be a non-empty string of at most 128 characters');
      }
    }
  }
}

function accountRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    identity: row.identity || '',
    purpose: row.purpose || '',
    profileRef: row.profile_ref,
    color: row.color,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    purpose: row.purpose || '',
    claudeAccountId: row.claude_account_id,
    codexAccountId: row.codex_account_id,
    detected: Boolean(row.detected),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function usageRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    scope: row.scope,
    usedPercent: row.used_percent,
    remainingPercent: row.used_percent == null ? null : Math.max(0, 100 - row.used_percent),
    resetsAt: row.resets_at,
    observedAt: row.observed_at,
    source: row.source,
    stale: Boolean(row.stale),
    detail: JSON.parse(row.detail_json || '{}'),
  };
}

// Issue #377.
function sessionModelStateRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    sessionId: row.session_id,
    model: row.model,
    modelDisplay: row.model_display,
    cwd: row.cwd,
    observedAt: row.observed_at,
    droppedFrom: row.dropped_from,
    droppedFromDisplay: row.dropped_from_display,
    droppedAt: row.dropped_at,
  };
}

const USAGE_HISTORY_BUCKETS = new Set(['raw', 'hour', 'day']);
const USAGE_HISTORY_INDEX_PADDING_MS = 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function usageHistoryString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`usage history ${label} is required`);
  const normalized = value.trim();
  if (/\p{Cc}/u.test(normalized)) throw new Error(`usage history ${label} is invalid`);
  return normalized;
}

function usageHistoryTimestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`usage history ${label} is required`);
  const normalized = value.trim();
  const parts = normalized.match(ISO_TIMESTAMP_PATTERN);
  const year = Number(parts?.[1]);
  const month = Number(parts?.[2]);
  const day = Number(parts?.[3]);
  const hour = Number(parts?.[4]);
  const minute = Number(parts?.[5]);
  const second = Number(parts?.[6]);
  const offsetHour = Number(parts?.[8] || 0);
  const offsetMinute = Number(parts?.[9] || 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const timestamp = Date.parse(normalized);
  if (!parts || month < 1 || month > 12 || day < 1 || day > daysInMonth
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
      || !Number.isFinite(timestamp)) {
    throw new Error(`usage history ${label} must be an ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function usageHistoryBucketStart(observedAt, bucket) {
  const size = bucket === 'hour' ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
  return new Date(Math.floor(Date.parse(observedAt) / size) * size).toISOString();
}

function bucketUsageHistory(rows, bucket) {
  const buckets = new Map();
  for (const row of rows) {
    const bucketStart = usageHistoryBucketStart(row.observed_at, bucket);
    let entry = buckets.get(bucketStart);
    if (!entry) {
      entry = {
        bucketStart,
        lastUsedPercent: row.used_percent,
        lastObservedTime: Date.parse(row.observed_at),
        lastId: row.id,
        minUsedPercent: null,
        maxUsedPercent: null,
        resetsAtValues: new Set(),
      };
      buckets.set(bucketStart, entry);
    } else {
      const observedTime = Date.parse(row.observed_at);
      if (observedTime > entry.lastObservedTime
          || (observedTime === entry.lastObservedTime && row.id > entry.lastId)) {
        entry.lastUsedPercent = row.used_percent;
        entry.lastObservedTime = observedTime;
        entry.lastId = row.id;
      }
    }
    if (row.used_percent != null) {
      entry.minUsedPercent = entry.minUsedPercent == null
        ? row.used_percent
        : Math.min(entry.minUsedPercent, row.used_percent);
      entry.maxUsedPercent = entry.maxUsedPercent == null
        ? row.used_percent
        : Math.max(entry.maxUsedPercent, row.used_percent);
    }
    if (row.resets_at != null) entry.resetsAtValues.add(row.resets_at);
  }
  return [...buckets.values()]
    .sort((left, right) => right.bucketStart.localeCompare(left.bucketStart))
    .map((entry) => ({
      bucketStart: entry.bucketStart,
      lastUsedPercent: entry.lastUsedPercent,
      minUsedPercent: entry.minUsedPercent,
      maxUsedPercent: entry.maxUsedPercent,
      resetsAtValues: [...entry.resetsAtValues].sort(),
    }));
}

const REQUEST_USAGE_NUMBER_FIELDS = [
  'latencyMs',
  'ttftMs',
  'inputUncached',
  'inputCacheRead',
  'inputCacheWrite',
  'outputTotal',
  'outputReasoning',
  'total',
  'limitUsedPercent',
];

const REQUEST_USAGE_LIMIT_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);
const REQUEST_USAGE_PROVIDER_ID_RE = /^[A-Za-z0-9_.-]+$/;

const CODEX_TURN_TOKEN_FIELDS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
];

const GROK_TURN_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'costUsdTicks',
];

function validateRequestUsageRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('request usage record must be an object');
  for (const key of ['requestId', 'machine', 'observedAt', 'source', 'provider', 'model']) {
    if (typeof record[key] !== 'string' || !record[key].trim()) throw new Error(`request usage ${key} is required`);
  }
  if (!['claude', 'codex'].includes(record.provider)) throw new Error('request usage provider must be claude or codex');
  const observedMs = Date.parse(record.observedAt);
  if (!Number.isFinite(observedMs) || new Date(observedMs).toISOString() !== record.observedAt) {
    throw new Error('request usage observedAt must be a canonical ISO timestamp');
  }
  if (typeof record.failed !== 'boolean') throw new Error('request usage failed must be a boolean');
  if (record.statusCode != null && (!Number.isInteger(record.statusCode) || record.statusCode < 0)) {
    throw new Error('request usage statusCode must be a non-negative integer or null');
  }
  if (record.profileLabel != null && (
    typeof record.profileLabel !== 'string'
    || !record.profileLabel.trim()
    || record.profileLabel.length > 128
    || /\p{Cc}/u.test(record.profileLabel)
  )) {
    throw new Error('request usage profileLabel must be a non-empty string of at most 128 characters, free of control characters, or null');
  }
  if (record.providerRequestId != null && (
    typeof record.providerRequestId !== 'string'
    || record.providerRequestId.length > 128
    || !REQUEST_USAGE_PROVIDER_ID_RE.test(record.providerRequestId)
  )) {
    throw new Error('request usage providerRequestId must be an allowlisted string or null');
  }
  if (record.limitStatus != null && !REQUEST_USAGE_LIMIT_STATUSES.has(record.limitStatus)) {
    throw new Error('request usage limitStatus must be allowed, allowed_warning, rejected, or null');
  }
  if (record.limitResetsAt != null) {
    const resetMs = typeof record.limitResetsAt === 'string' ? Date.parse(record.limitResetsAt) : NaN;
    if (!Number.isFinite(resetMs)
      || new Date(resetMs).toISOString() !== record.limitResetsAt
      || Math.abs(resetMs - observedMs) > REQUEST_USAGE_RETENTION_DAYS * 86_400_000) {
      throw new Error('request usage limitResetsAt must be a canonical ISO timestamp within 400 days or null');
    }
  }
  for (const key of REQUEST_USAGE_NUMBER_FIELDS) {
    if (record[key] != null && (!Number.isFinite(record[key]) || record[key] < 0)) {
      throw new Error(`request usage ${key} must be a non-negative number or null`);
    }
  }
  if (record.limitUsedPercent != null && record.limitUsedPercent > 100) {
    throw new Error('request usage limitUsedPercent must be at most 100 or null');
  }
  for (const key of ['inputUncached', 'inputCacheRead', 'inputCacheWrite', 'outputTotal', 'outputReasoning', 'total']) {
    if (record[key] != null && !Number.isInteger(record[key])) {
      throw new Error(`request usage ${key} must be an integer`);
    }
  }
}

function validateCodexSessionRecord(session, turns) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('Codex session must be an object');
  for (const key of ['sessionId', 'profileSlug', 'machine', 'firstTimestamp', 'lastTimestamp']) {
    if (typeof session[key] !== 'string' || !session[key].trim()) throw new Error(`Codex session ${key} is required`);
  }
  for (const key of ['firstTimestamp', 'lastTimestamp']) {
    const parsed = Date.parse(session[key]);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== session[key]) {
      throw new Error(`Codex session ${key} must be a canonical ISO timestamp`);
    }
  }
  if (session.firstTimestamp > session.lastTimestamp) throw new Error('Codex session firstTimestamp must not follow lastTimestamp');
  if (typeof session.archived !== 'boolean') throw new Error('Codex session archived must be a boolean');
  if (!turns || typeof turns[Symbol.iterator] !== 'function') throw new Error('Codex turns must be iterable');
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new Error('Codex turn must be an object');
    if (!Number.isInteger(turn.turnIndex) || turn.turnIndex < 0) throw new Error('Codex turn turnIndex must be a non-negative integer');
    if (turn.turnId != null && (typeof turn.turnId !== 'string' || !turn.turnId.trim())) throw new Error('Codex turn turnId must be text or null');
    if (turn.timestamp != null) {
      const parsed = typeof turn.timestamp === 'string' ? Date.parse(turn.timestamp) : NaN;
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== turn.timestamp) {
        throw new Error('Codex turn timestamp must be a canonical ISO timestamp or null');
      }
    }
    for (const key of ['durationMs', 'timeToFirstTokenMs']) {
      if (turn[key] != null && (!Number.isFinite(turn[key]) || turn[key] < 0)) {
        throw new Error(`Codex turn ${key} must be a non-negative number or null`);
      }
    }
    for (const key of CODEX_TURN_TOKEN_FIELDS) {
      if (!Number.isSafeInteger(turn[key]) || turn[key] < 0) throw new Error(`Codex turn ${key} must be a non-negative safe integer`);
    }
  }
}

function validateGrokSessionRecord(session, turns) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('Grok session must be an object');
  for (const key of ['sessionId', 'profileSlug', 'cwdKey', 'machine', 'sourceFile']) {
    if (typeof session[key] !== 'string' || !session[key].trim()) throw new Error(`Grok session ${key} is required`);
  }
  for (const key of ['firstTimestamp', 'lastTimestamp']) {
    if (session[key] == null) continue;
    const parsed = typeof session[key] === 'string' ? Date.parse(session[key]) : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== session[key]) {
      throw new Error(`Grok session ${key} must be a canonical ISO timestamp or null`);
    }
  }
  if (session.firstTimestamp != null && session.lastTimestamp != null
      && session.firstTimestamp > session.lastTimestamp) {
    throw new Error('Grok session firstTimestamp must not follow lastTimestamp');
  }
  if (!Number.isInteger(session.parserVersion) || session.parserVersion < 1) {
    throw new Error('Grok session parserVersion must be a positive integer');
  }
  if (!turns || typeof turns[Symbol.iterator] !== 'function') throw new Error('Grok turns must be iterable');
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new Error('Grok turn must be an object');
    if (!Number.isInteger(turn.turnIndex) || turn.turnIndex < 0) throw new Error('Grok turn turnIndex must be a non-negative integer');
    if (turn.turnId != null && (typeof turn.turnId !== 'string' || !turn.turnId.trim())) throw new Error('Grok turn turnId must be text or null');
    if (turn.timestamp != null) {
      const parsed = typeof turn.timestamp === 'string' ? Date.parse(turn.timestamp) : NaN;
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== turn.timestamp) {
        throw new Error('Grok turn timestamp must be a canonical ISO timestamp or null');
      }
    }
    for (const key of GROK_TURN_TOKEN_FIELDS) {
      if (!Number.isSafeInteger(turn[key]) || turn[key] < 0) throw new Error(`Grok turn ${key} must be a non-negative safe integer`);
    }
    for (const key of ['modelCalls', 'numTurns']) {
      if (turn[key] != null && (!Number.isSafeInteger(turn[key]) || turn[key] < 0)) {
        throw new Error(`Grok turn ${key} must be a non-negative safe integer or null`);
      }
    }
    if (turn.apiDurationMs != null && (!Number.isFinite(turn.apiDurationMs) || turn.apiDurationMs < 0)) {
      throw new Error('Grok turn apiDurationMs must be a non-negative number or null');
    }
    if (typeof turn.provenanceJson !== 'string' || typeof turn.sourceJson !== 'string') {
      throw new Error('Grok turn provenanceJson and sourceJson are required');
    }
    if (!Array.isArray(turn.modelUsage)) throw new Error('Grok turn modelUsage must be an array');
    for (const model of turn.modelUsage) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Grok model usage must be an object');
      if (typeof model.model !== 'string' || !model.model.trim()) throw new Error('Grok model usage model is required');
      for (const key of GROK_TURN_TOKEN_FIELDS) {
        if (!Number.isSafeInteger(model[key]) || model[key] < 0) {
          throw new Error(`Grok model usage ${key} must be a non-negative safe integer`);
        }
      }
      if (typeof model.sourceJson !== 'string') throw new Error('Grok model usage sourceJson is required');
    }
  }
}

function usageAggregateRow(row) {
  return {
    requests: Number(row?.requests || 0),
    failed: Number(row?.failed || 0),
    latencyMs: Number(row?.latency_ms || 0),
    ttftMs: Number(row?.ttft_ms || 0),
    inputUncached: Number(row?.input_uncached || 0),
    inputCacheRead: Number(row?.input_cache_read || 0),
    inputCacheWrite: Number(row?.input_cache_write || 0),
    outputTotal: Number(row?.output_total || 0),
    outputReasoning: Number(row?.output_reasoning || 0),
    total: Number(row?.total || 0),
  };
}

// Allowlisted usage-summary groupings. `day` is the original UTC calendar day;
// local_day / hour / hour_of_day (issue #344) bucket in the daemon host's local
// time, which is what the burn timeline states on the view. `model_effort`
// (issue #345) is the one two-dimension grouping — model × reasoning effort.
const USAGE_SUMMARY_GROUPINGS = [
  'account', 'model', 'model_effort', 'reasoning_effort', 'day', 'local_day', 'hour', 'hour_of_day',
];

// Issue #344: the burn-timeline view filters the same aggregate by account,
// model, and provider. Filters are equality-only and validated in the reader's
// existing style so the route stays a pass-through of raw query strings.
function usageSummaryFilter(value, label, subject = 'usage summary') {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${subject} ${label} must be a non-empty string`);
  return value;
}

function canonicalSummaryBound(value, label, subject = 'usage summary') {
  if (value == null) return null;
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${subject} ${label} must be a canonical ISO timestamp`);
  }
  return value;
}

// Issue #347: session explorer bounds. The leaderboard is a ranked list, not a
// pagination surface — a limit exists so one read can never walk the whole
// corpus, and the response says when it clipped.
export const USAGE_SESSIONS_DEFAULT_LIMIT = 25;
export const USAGE_SESSIONS_MAX_LIMIT = 200;
// Per-session context-size samples returned by the detail read. A long session
// has thousands of requests; the trend only needs enough points to read.
export const USAGE_SESSION_TREND_LIMIT = 500;
export const SESSION_ANATOMY_BUCKETS = [
  30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
];
export const SESSION_ANATOMY_MAX_BUCKETS = 72;
export const SESSION_ANATOMY_CURVE_LIMIT = 4000;
export const SESSION_ANATOMY_ROW_LIMIT = 100000;
export const SESSION_ANATOMY_EVENT_LIMIT = 2000;
export const SESSION_ANATOMY_SUBAGENT_LIMIT = 500;

function localBucketKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function usageSessionsLimit(value) {
  if (value == null || value === '') return USAGE_SESSIONS_DEFAULT_LIMIT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > USAGE_SESSIONS_MAX_LIMIT) {
    throw new Error(`usage sessions limit must be an integer between 1 and ${USAGE_SESSIONS_MAX_LIMIT}`);
  }
  return parsed;
}

// Claude transcripts store disjoint token splits. Codex input_tokens already
// includes cached_input_tokens, while cache_write_input_tokens is a separate
// additive input flow. The ingester preserves those rollout counters as-is.
const TRANSCRIPT_TOTAL = '(r.input_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens + r.output_tokens)';
const TRANSCRIPT_INPUT = '(r.input_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens)';
const CODEX_INPUT_UNCACHED = '(t.input_tokens - t.cached_input_tokens)';
const CODEX_INPUT = '(t.input_tokens + t.cache_write_input_tokens)';

function sessionAverage(total, count) {
  if (!count) return 0;
  return Math.round(total / count);
}

// Issue #346 (decision 10b): project burn. A project is derived from the
// session's cwd — the only project identity the ingested transcript/rollout
// corpus carries. Issue #365 folds ModelDeck's exact linked-worktree layout
// back into the parent checkout while retaining the worktree name as detail.
// Tracked projects nested below another tracked project fold to their
// outermost tracked ancestor; unrelated cwd paths remain verbatim.
// Traffic whose session has no cwd (or whose session row is missing) is NOT
// dropped: it lands in this explicitly keyed bucket. Real cwds are absolute
// paths, so this non-path key cannot collide with one.
export const PROJECT_BURN_UNATTRIBUTED = 'unattributed';
export const PROJECT_BURN_DEFAULT_LIMIT = 25;
export const PROJECT_BURN_MAX_LIMIT = 200;

function projectBurnLimit(value) {
  if (value == null || value === '') return PROJECT_BURN_DEFAULT_LIMIT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > PROJECT_BURN_MAX_LIMIT) {
    throw new Error(`project burn limit must be an integer between 1 and ${PROJECT_BURN_MAX_LIMIT}`);
  }
  return parsed;
}

// The measures a project row carries. inputUncached / inputCacheRead /
// inputCacheWrite / outputTotal are exactly the four token classes the Claude
// window-burn estimate model is fitted on (issue #348), so the view can apply
// an account's fitted weights without re-deriving anything client-side.
const PROJECT_BURN_MEASURES = Object.freeze([
  'requests', 'sessions', 'totalTokens', 'reasoningTokens',
  'inputUncached', 'inputCacheRead', 'inputCacheWrite', 'outputTotal',
]);

function emptyProjectBurnAggregate() {
  return Object.fromEntries(PROJECT_BURN_MEASURES.map((measure) => [measure, 0]));
}

function projectBurnAggregate(row) {
  return {
    requests: Number(row?.requests || 0),
    sessions: Number(row?.sessions || 0),
    totalTokens: Number(row?.total_tokens || 0),
    reasoningTokens: Number(row?.reasoning_tokens || 0),
    inputUncached: Number(row?.input_uncached || 0),
    inputCacheRead: Number(row?.input_cache_read || 0),
    inputCacheWrite: Number(row?.input_cache_write || 0),
    outputTotal: Number(row?.output_total || 0),
  };
}

function addProjectBurnAggregate(target, source) {
  for (const measure of PROJECT_BURN_MEASURES) target[measure] += source[measure];
  return target;
}

// The estimate model's feature vector, in its own object so a caller cannot
// accidentally feed it a derived figure (inputTokens) the fit never saw.
function projectBurnTokenFlows(aggregate) {
  return {
    inputUncached: aggregate.inputUncached,
    inputCacheRead: aggregate.inputCacheRead,
    inputCacheWrite: aggregate.inputCacheWrite,
    outputTotal: aggregate.outputTotal,
  };
}

// The public shape of one aggregate: the stored measures plus the derived
// input total, so a row reads like a session-explorer row.
function projectBurnPayload(aggregate) {
  return {
    ...aggregate,
    inputTokens: aggregate.inputUncached + aggregate.inputCacheRead + aggregate.inputCacheWrite,
    tokenFlows: projectBurnTokenFlows(aggregate),
  };
}

// Allowlisted local-time buckets for per-project burn over time. Keys are the
// offset-free wall-clock strings the burn timeline already uses, so the
// browser reads them straight back as local instants.
const PROJECT_BURN_BUCKETS = Object.freeze({
  local_day: (column) => `strftime('%Y-%m-%d', ${column}, 'localtime')`,
  hour: (column) => `strftime('%Y-%m-%dT%H:00', ${column}, 'localtime')`,
});

// Both field checkout conventions fold: <repo>/.claude/worktrees/<name> AND
// <repo>/.worktrees/<name>, including session cwds nested BELOW the worktree
// root (…/<name>/plugin) and worktrees cut from worktrees (peeled to the
// outermost repo). An ordinary path containing `.claude`, or the bare marker
// directory with no name segment, remains its own project. Paths are
// otherwise kept verbatim (never trimmed into a different path).
const WORKTREE_MARKER_RE = /^(.+)\/(?:\.claude\/worktrees|\.worktrees)\/[^/]+(?:\/.*)?$/;

function projectKeyOf(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return PROJECT_BURN_UNATTRIBUTED;
  }
  let key = cwd;
  for (let match = key.match(WORKTREE_MARKER_RE); match; match = key.match(WORKTREE_MARKER_RE)) {
    key = match[1];
  }
  return key;
}

function pathContains(ancestor, descendant) {
  const relative = path.relative(ancestor, descendant);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function trackedProjectRollups(projects) {
  const paths = projects.map((project) => project.path).sort((a, b) => a.length - b.length);
  return new Map(paths.map((projectPath) => [
    projectPath,
    paths.find((candidate) => candidate === projectPath || pathContains(candidate, projectPath)),
  ]));
}

function projectIdentityOf(cwd, rollups = null) {
  const sourceKey = projectKeyOf(cwd);
  if (sourceKey === PROJECT_BURN_UNATTRIBUTED) {
    return { key: sourceKey, project: null, worktree: null };
  }
  const key = rollups?.get(sourceKey) || sourceKey;
  if (sourceKey === cwd) return { key, project: key, worktree: null };
  const worktree = cwd
    .slice(sourceKey.length + 1)
    .replace(/^(?:\.claude\/worktrees|\.worktrees)\//, '');
  return { key, project: key, worktree };
}

// The project predicate, in both readers' SQL, over whichever session table
// carries the cwd. The unattributed key selects the rows a cwd cannot name —
// including sessions missing entirely, which the LEFT JOIN leaves NULL. A
// parent checkout selects itself plus everything under either worktree
// marker (nested cwds included — they fold to the same parent); an explicit
// worktree path narrows to that checkout, nested cwds included. A tracked
// parent also selects its tracked descendants so its rolled-up drill is whole.
function projectPredicate(column, project, containedProjects = []) {
  if (project === PROJECT_BURN_UNATTRIBUTED) {
    return { sql: `(${column} IS NULL OR TRIM(${column}) = '')`, params: [] };
  }
  const scopes = [project, ...containedProjects];
  const predicates = scopes.map((scope) => projectPathPredicate(column, scope));
  return {
    sql: `(${predicates.map((predicate) => predicate.sql).join(' OR ')})`,
    params: predicates.flatMap((predicate) => predicate.params),
  };
}

function projectPathPredicate(column, project) {
  // Prefix boundaries are computed by SQLite's own length(): JS .length
  // counts UTF-16 code units while SQLite counts Unicode characters, and the
  // two disagree the moment a path carries a non-BMP character.
  if (projectIdentityOf(project).worktree != null) {
    const inside = `${project}/`;
    return {
      sql: `(${column} = ? OR substr(${column}, 1, length(?)) = ?)`,
      params: [project, inside, inside],
    };
  }
  const claudePrefix = `${project}/.claude/worktrees/`;
  const barePrefix = `${project}/.worktrees/`;
  return {
    sql: `(${column} = ? OR substr(${column}, 1, length(?)) = ? OR substr(${column}, 1, length(?)) = ?)`,
    params: [
      project,
      claudePrefix,
      claudePrefix,
      barePrefix,
      barePrefix,
    ],
  };
}

function earlier(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  return left < right ? left : right;
}

function later(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  return left > right ? left : right;
}

export class Store {
  constructor(dbPath, { readOnly = false } = {}) {
    if (readOnly) {
      this.db = new DatabaseSync(':memory:');
      this.db.deserialize(readOnlyDatabaseImage(dbPath));
      this.db.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -${SQLITE_PAGE_CACHE_KIB};`);
      return;
    }
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -${SQLITE_PAGE_CACHE_KIB};`);
    this.migrate();
    if (dbPath !== ':memory:') {
      fs.chmodSync(path.dirname(dbPath), 0o700);
      fs.chmodSync(dbPath, 0o600);
    }
  }

  /// Decision 0035: the accounts table's provider CHECK predates Grok, and
  /// SQLite cannot alter a CHECK in place — the table has to be rebuilt.
  /// Idempotent (it reads the recorded DDL first) and a no-op on any database
  /// created after this shipped.
  ///
  /// The foreign_keys pragma must be toggled OUTSIDE a transaction, so the
  /// rebuild owns its own. Five tables carry six foreign-key clauses onto
  /// accounts(id) — `projects` carries two (claude_account_id and
  /// codex_account_id), alongside `request_usage`, `usage_snapshots`,
  /// `session_model_state`, and `launch_events`. Dropping the
  /// old table with enforcement OFF is what stops the ON DELETE CASCADE
  /// children (usage_snapshots, session_model_state) from being wiped and
  /// the ON DELETE SET NULL parents from being blanked; renaming the
  /// replacement into its name then leaves all six clauses resolving to the
  /// new table. This is SQLite's documented rebuild sequence, including the
  /// step-10 `foreign_key_check` before COMMIT.
  migrateAccountProviders() {
    const recorded = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
    ).get()?.sql || '';
    if (!recorded || recorded.includes("'grok'")) return;
    // Databases old enough to predate the identity/purpose columns are still
    // out there, and those columns are added AFTER this runs. Copy only what
    // the old table actually has and let the new table's defaults cover the
    // rest, so the rebuild never depends on migration ordering.
    const present = new Set(
      this.db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name),
    );
    const columns = [
      'id', 'provider', 'label', 'profile_ref', 'created_at', 'updated_at',
      'identity', 'purpose', 'color', 'enabled', 'is_default', 'metadata_json',
    ].filter((column) => present.has(column)).join(', ');
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE accounts_migrating (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok')),
            label TEXT NOT NULL,
            identity TEXT NOT NULL DEFAULT '',
            purpose TEXT NOT NULL DEFAULT '',
            profile_ref TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#6f7bf7',
            enabled INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(provider, profile_ref)
          );
          INSERT INTO accounts_migrating(${columns}) SELECT ${columns} FROM accounts;
          DROP TABLE accounts;
          ALTER TABLE accounts_migrating RENAME TO accounts;
          CREATE UNIQUE INDEX IF NOT EXISTS one_default_per_provider
            ON accounts(provider) WHERE is_default = 1;
        `);
        // SQLite's documented step 10. Enforcement is off for the rebuild, so
        // nothing else would notice a row this migration orphaned — a bad
        // copy would land silently and only surface later as a child row
        // pointing at an account that no longer exists. Checking here means a
        // rebuild that broke a reference rolls back instead of committing.
        const orphans = this.db.prepare('PRAGMA foreign_key_check').all();
        if (orphans.length) {
          const tables = [...new Set(orphans.map((row) => row.table))].sort().join(', ');
          throw new Error(`accounts rebuild orphaned ${orphans.length} row(s) in: ${tables}`);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        -- Decision 0035 widened this to three. Existing databases are
        -- rebuilt onto the same shape by migrateAccountProviders() below.
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok')),
        label TEXT NOT NULL,
        identity TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        profile_ref TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6f7bf7',
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, profile_ref)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_default_per_provider
        ON accounts(provider) WHERE is_default = 1;

      CREATE TABLE IF NOT EXISTS request_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        machine TEXT NOT NULL DEFAULT 'studio',
        observed_at TEXT NOT NULL,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        profile_label TEXT,
        -- Ingest-safe proxy source: plaintext identity for OAuth, SHA-256 for
        -- key-authenticated upstreams. Store it only when account_id is NULL.
        source_raw TEXT,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
        provider_request_id TEXT,
        model TEXT NOT NULL,
        alias TEXT,
        reasoning_effort TEXT,
        endpoint TEXT,
        user_agent_class TEXT NOT NULL DEFAULT 'unknown',
        failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1)),
        status_code INTEGER,
        latency_ms REAL,
        ttft_ms REAL,
        input_uncached INTEGER NOT NULL DEFAULT 0,
        input_cache_read INTEGER NOT NULL DEFAULT 0,
        input_cache_write INTEGER NOT NULL DEFAULT 0,
        output_total INTEGER NOT NULL DEFAULT 0,
        output_reasoning INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        limit_used_percent REAL,
        limit_status TEXT,
        limit_resets_at TEXT,
        CHECK(account_id IS NULL OR source_raw IS NULL)
      );
      CREATE INDEX IF NOT EXISTS request_usage_observed
        ON request_usage(observed_at);
      CREATE INDEX IF NOT EXISTS request_usage_account_observed
        ON request_usage(account_id, observed_at);
      CREATE INDEX IF NOT EXISTS request_usage_account_outcome_observed
        ON request_usage(account_id, failed, observed_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS request_usage_source_outcome_observed
        ON request_usage(provider, source_raw COLLATE NOCASE, failed, observed_at DESC, id DESC)
        WHERE account_id IS NULL;
      CREATE INDEX IF NOT EXISTS request_usage_model
        ON request_usage(model);
      CREATE INDEX IF NOT EXISTS request_usage_reasoning_effort
        ON request_usage(reasoning_effort);

      -- Issue #377: the model each live Claude Code session is currently on,
      -- observed from the #174 statusline tee, plus the standing unresolved
      -- DROP for that session. One row per (account, session): the last
      -- observation and the open drop live together so a daemon restart
      -- cannot forget a drop or re-raise one that already recovered.
      CREATE TABLE IF NOT EXISTS session_model_state (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        model_display TEXT,
        cwd TEXT,
        observed_at TEXT NOT NULL,
        -- Non-null exactly while a drop stands unresolved. dropped_from
        -- keeps the ORIGINAL model, so a second downgrade never rewrites the
        -- story from "you were on Fable" to "you were on Sonnet".
        dropped_from TEXT,
        dropped_from_display TEXT,
        dropped_at TEXT,
        PRIMARY KEY(account_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS session_model_state_dropped
        ON session_model_state(dropped_at) WHERE dropped_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS codex_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        profile_slug TEXT NOT NULL,
        machine TEXT NOT NULL DEFAULT 'studio',
        cwd TEXT,
        originator TEXT,
        source TEXT,
        cli_version TEXT,
        git_branch TEXT,
        git_repo TEXT,
        git_commit TEXT,
        first_timestamp TEXT NOT NULL,
        last_timestamp TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
      );
      CREATE INDEX IF NOT EXISTS codex_sessions_profile_last
        ON codex_sessions(profile_slug, last_timestamp);
      CREATE INDEX IF NOT EXISTS codex_sessions_git_repo
        ON codex_sessions(git_repo);

      CREATE TABLE IF NOT EXISTS codex_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES codex_sessions(session_id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        turn_id TEXT,
        model TEXT,
        reasoning_effort TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms REAL,
        time_to_first_token_ms REAL,
        timestamp TEXT,
        UNIQUE(session_id, turn_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS codex_turns_session_turn_id
        ON codex_turns(session_id, turn_id) WHERE turn_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS codex_turns_timestamp
        ON codex_turns(timestamp);
      CREATE INDEX IF NOT EXISTS codex_turns_model_effort
        ON codex_turns(model, reasoning_effort);

      CREATE TABLE IF NOT EXISTS grok_sessions (
        session_id TEXT PRIMARY KEY,
        profile_slug TEXT NOT NULL,
        cwd_key TEXT NOT NULL,
        machine TEXT NOT NULL DEFAULT 'studio',
        cwd TEXT,
        first_timestamp TEXT,
        last_timestamp TEXT,
        source_file TEXT NOT NULL,
        parser_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS grok_sessions_profile_last
        ON grok_sessions(profile_slug, last_timestamp);
      CREATE INDEX IF NOT EXISTS grok_sessions_cwd
        ON grok_sessions(cwd);

      CREATE TABLE IF NOT EXISTS grok_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES grok_sessions(session_id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        turn_id TEXT,
        timestamp TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cached_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        model_calls INTEGER,
        api_duration_ms REAL,
        cost_usd_ticks INTEGER NOT NULL DEFAULT 0,
        num_turns INTEGER,
        parser_version INTEGER NOT NULL,
        source_file TEXT NOT NULL,
        source_line INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        UNIQUE(session_id, turn_index)
      );
      CREATE INDEX IF NOT EXISTS grok_turns_timestamp
        ON grok_turns(timestamp);
      CREATE INDEX IF NOT EXISTS grok_turns_session_turn_id
        ON grok_turns(session_id, turn_id) WHERE turn_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS grok_model_usage (
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        turn_id TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cached_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd_ticks INTEGER NOT NULL DEFAULT 0,
        parser_version INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_index, model),
        FOREIGN KEY(session_id, turn_index)
          REFERENCES grok_turns(session_id, turn_index) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS grok_model_usage_model
        ON grok_model_usage(model);

      CREATE TABLE IF NOT EXISTS ingest_file_state (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        ino INTEGER NOT NULL,
        parser TEXT,
        parser_version INTEGER,
        session_id TEXT,
        record_count INTEGER,
        reconcile_pending INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_pending IN (0,1)),
        last_ingested_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_sessions (
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        machine TEXT NOT NULL DEFAULT 'studio',
        cwd TEXT,
        git_branch TEXT,
        entrypoint TEXT,
        client_version TEXT,
        first_at TEXT,
        last_at TEXT,
        title TEXT,
        -- Internal precedence marker: a custom title must not be replaced by
        -- a later last-prompt record during a replay.
        title_source TEXT CHECK(title_source IN ('custom-title','last-prompt')),
        PRIMARY KEY(session_id, profile_slug)
      );
      CREATE INDEX IF NOT EXISTS transcript_sessions_profile_last
        ON transcript_sessions(profile_slug, last_at);
      CREATE INDEX IF NOT EXISTS transcript_sessions_cwd
        ON transcript_sessions(cwd);

      CREATE TABLE IF NOT EXISTS transcript_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- Older transcripts use request:<requestId>. Current requestId-less
        -- transcripts use message:<sessionId>:<message.id>, falling back to
        -- record:<sessionId>:<uuid> only when message.id is absent.
        dedupe_key TEXT NOT NULL,
        request_id TEXT,
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        message_id TEXT,
        record_uuid TEXT,
        model TEXT NOT NULL,
        effort TEXT,
        observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_ephemeral_5m_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_ephemeral_1h_input_tokens INTEGER NOT NULL DEFAULT 0,
        is_sidechain INTEGER NOT NULL DEFAULT 0 CHECK(is_sidechain IN (0,1)),
        agent_id TEXT,
        FOREIGN KEY(session_id, profile_slug)
          REFERENCES transcript_sessions(session_id, profile_slug) ON DELETE CASCADE,
        UNIQUE(dedupe_key, profile_slug)
      );
      -- Within one profile, this deliberately makes INSERT OR IGNORE drop
      -- provider-side requestId collisions even when the dedupe_key differs.
      CREATE UNIQUE INDEX IF NOT EXISTS transcript_requests_request_id
        ON transcript_requests(request_id, profile_slug) WHERE request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS transcript_requests_session_observed
        ON transcript_requests(session_id, profile_slug, observed_at);
      CREATE INDEX IF NOT EXISTS transcript_requests_model_effort
        ON transcript_requests(model, effort);
      CREATE INDEX IF NOT EXISTS transcript_requests_agent
        ON transcript_requests(agent_id) WHERE agent_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS transcript_subagents (
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        agent_type TEXT,
        resolved_model TEXT,
        total_tokens INTEGER,
        tool_stats_json TEXT,
        duration_ms INTEGER,
        observed_at TEXT,
        PRIMARY KEY(agent_id, profile_slug),
        FOREIGN KEY(session_id, profile_slug)
          REFERENCES transcript_sessions(session_id, profile_slug) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS transcript_subagents_session
        ON transcript_subagents(session_id, profile_slug);

      CREATE TABLE IF NOT EXISTS transcript_skill_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        skill TEXT,
        command_name TEXT,
        observed_at TEXT NOT NULL,
        CHECK((skill IS NOT NULL AND command_name IS NULL)
          OR (skill IS NULL AND command_name IS NOT NULL)),
        FOREIGN KEY(session_id, profile_slug)
          REFERENCES transcript_sessions(session_id, profile_slug) ON DELETE CASCADE,
        UNIQUE(event_key, profile_slug)
      );
      CREATE INDEX IF NOT EXISTS transcript_skill_events_session_observed
        ON transcript_skill_events(session_id, profile_slug, observed_at);
      CREATE INDEX IF NOT EXISTS transcript_skill_events_skill
        ON transcript_skill_events(skill) WHERE skill IS NOT NULL;
      CREATE INDEX IF NOT EXISTS transcript_skill_events_command
        ON transcript_skill_events(command_name) WHERE command_name IS NOT NULL;
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        pathology_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        corpus_fingerprint TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        first_detected_at TEXT NOT NULL,
        last_changed_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(pathology_kind, scope_key)
      );
      CREATE INDEX IF NOT EXISTS findings_active_changed
        ON findings(active, last_changed_at DESC);
      CREATE TABLE IF NOT EXISTS otel_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingest_key TEXT NOT NULL UNIQUE,
        machine TEXT NOT NULL DEFAULT 'studio',
        metric_name TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        value REAL NOT NULL,
        model TEXT,
        effort TEXT,
        speed TEXT,
        query_source TEXT,
        agent_name TEXT,
        skill_name TEXT,
        session_id TEXT,
        account_uuid TEXT,
        organization_id TEXT,
        token_type TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS otel_metrics_observed ON otel_metrics(observed_at);
      CREATE INDEX IF NOT EXISTS otel_metrics_account_observed ON otel_metrics(account_uuid, observed_at);
      CREATE INDEX IF NOT EXISTS otel_metrics_session ON otel_metrics(session_id);
      CREATE INDEX IF NOT EXISTS otel_metrics_model_effort ON otel_metrics(model, effort);

      CREATE TABLE IF NOT EXISTS otel_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingest_key TEXT NOT NULL UNIQUE,
        machine TEXT NOT NULL DEFAULT 'studio',
        event_name TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        speed TEXT,
        query_source TEXT,
        agent_name TEXT,
        skill_name TEXT,
        session_id TEXT,
        account_uuid TEXT,
        organization_id TEXT,
        token_type TEXT,
        request_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        cost_usd REAL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS otel_events_observed ON otel_events(observed_at);
      CREATE INDEX IF NOT EXISTS otel_events_account_observed ON otel_events(account_uuid, observed_at);
      CREATE INDEX IF NOT EXISTS otel_events_session ON otel_events(session_id);
      CREATE INDEX IF NOT EXISTS otel_events_request ON otel_events(request_id);
      CREATE INDEX IF NOT EXISTS otel_events_model_effort ON otel_events(model, effort);

      CREATE TABLE IF NOT EXISTS otel_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingest_key TEXT NOT NULL UNIQUE,
        received_at TEXT NOT NULL,
        endpoint TEXT NOT NULL CHECK(endpoint IN ('metrics','logs')),
        reason TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1))
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL DEFAULT '',
        claude_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        codex_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        detected INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        used_percent REAL,
        resets_at TEXT,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS usage_account_observed
        ON usage_snapshots(account_id, observed_at DESC);
      -- PR #177 review: statusline ingest raises the insert rate, and the
      -- latest-per-(account, scope) readers must stay index-served rather
      -- than scanning the whole history on every /api/state poll.
      CREATE INDEX IF NOT EXISTS usage_account_scope_observed
        ON usage_snapshots(account_id, scope, observed_at DESC, id DESC);
      -- Issue #181: retention discovers globally expired rows by observation
      -- time. The account-leading indexes cannot range-search that predicate.
      CREATE INDEX IF NOT EXISTS usage_observed
        ON usage_snapshots(observed_at, id);

      -- Issue #383: learned weights live at provider-pool grain. Claude's
      -- profiles are proxy routing identities within one subscription pool,
      -- so an account-grain fit is not provider truth.
      CREATE TABLE IF NOT EXISTS usage_estimate_fits (
        pool_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
        scope TEXT NOT NULL CHECK(scope IN ('weekly','5-hour')),
        input_uncached_weight REAL,
        input_cache_read_weight REAL,
        input_cache_write_weight REAL,
        output_total_weight REAL,
        fit_quality REAL,
        identifiability TEXT NOT NULL
          CHECK(identifiability IN ('well-conditioned','ill-conditioned','not-assessed')),
        condition_ratio REAL,
        intervals_used INTEGER NOT NULL CHECK(intervals_used >= 0),
        method TEXT NOT NULL,
        reason TEXT,
        fitted_at TEXT NOT NULL,
        PRIMARY KEY(pool_id, scope),
        CHECK(input_uncached_weight IS NULL OR input_uncached_weight >= 0),
        CHECK(input_cache_read_weight IS NULL OR input_cache_read_weight >= 0),
        CHECK(input_cache_write_weight IS NULL OR input_cache_write_weight >= 0),
        CHECK(output_total_weight IS NULL OR output_total_weight >= 0),
        CHECK(fit_quality IS NULL OR (fit_quality >= 0 AND fit_quality <= 1)),
        CHECK(condition_ratio IS NULL OR (condition_ratio >= 0 AND condition_ratio <= 1)),
        CHECK(
          (reason IS NULL
            AND input_uncached_weight IS NOT NULL
            AND input_cache_read_weight IS NOT NULL
            AND input_cache_write_weight IS NOT NULL
            AND output_total_weight IS NOT NULL
            AND fit_quality IS NOT NULL
            AND identifiability = 'well-conditioned'
            AND condition_ratio IS NOT NULL
            AND condition_ratio >= 0.00000001)
          OR
          (reason IS NOT NULL
            AND input_uncached_weight IS NULL
            AND input_cache_read_weight IS NULL
            AND input_cache_write_weight IS NULL
            AND output_total_weight IS NULL
            AND fit_quality IS NULL
            AND (
              (identifiability = 'ill-conditioned'
                AND condition_ratio IS NOT NULL
                AND condition_ratio < 0.00000001)
              OR
              (identifiability = 'not-assessed' AND condition_ratio IS NULL)
            ))
        )
      );

      CREATE TABLE IF NOT EXISTS launch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        command_preview TEXT NOT NULL,
        launched_at TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        value_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_lint_facts (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        value_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      -- Issue #520 / decision 0036 D1: the app-owned client key -> profile
      -- mapping, keyed by SHA-256 of a ModelDeck-generated 256-bit random
      -- key. These hashes are NOT credentials and no raw key ever lands here;
      -- the discard-hardening invariant (a request's api_key never reaches
      -- SQLite) is unchanged. Ingest attribution reads this table (build
      -- item 6); this schema and its write path are build item 3.
      CREATE TABLE IF NOT EXISTS client_key_map (
        key_sha256 TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        profile_label TEXT,
        created_at TEXT NOT NULL
      );

      -- The last report generation applied. The app persists a monotonic
      -- generation and re-reports full state on every handshake; recording
      -- what we applied is what lets a replayed or out-of-order report be
      -- rejected instead of resurrecting a rotated key or a removed profile.
      CREATE TABLE IF NOT EXISTS client_key_map_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings(id, value_json, updated_at) VALUES (1, '{}', ?)
    `).run(now());
    this.migrateAccountProviders();
    // Take the write lock BEFORE probing the schema: two Stores opening
    // concurrently (daemon + CLI refit) could otherwise both see the legacy
    // table, and the second would re-migrate the already-migrated table,
    // downgrading a fresh fit to 'not-assessed'.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const requestUsageColumns = new Set(
        this.db.prepare('PRAGMA table_info(request_usage)').all().map((column) => column.name),
      );
      for (const [column, type] of [
        ['profile_label', 'TEXT'],
        ['provider_request_id', 'TEXT'],
        ['limit_used_percent', 'REAL'],
        ['limit_status', 'TEXT'],
        ['limit_resets_at', 'TEXT'],
      ]) {
        if (!requestUsageColumns.has(column)) {
          this.db.exec(`ALTER TABLE request_usage ADD COLUMN ${column} ${type}`);
        }
      }
      const ingestFileStateColumns = new Set(
        this.db.prepare('PRAGMA table_info(ingest_file_state)').all().map((column) => column.name),
      );
      if (!ingestFileStateColumns.has('parser')) {
        this.db.exec('ALTER TABLE ingest_file_state ADD COLUMN parser TEXT');
      }
      if (!ingestFileStateColumns.has('parser_version')) {
        this.db.exec('ALTER TABLE ingest_file_state ADD COLUMN parser_version INTEGER');
      }
      if (!ingestFileStateColumns.has('reconcile_pending')) {
        this.db.exec(`
          ALTER TABLE ingest_file_state ADD COLUMN reconcile_pending INTEGER NOT NULL DEFAULT 0
            CHECK(reconcile_pending IN (0,1))
        `);
      }
      if (!ingestFileStateColumns.has('session_id')) {
        this.db.exec('ALTER TABLE ingest_file_state ADD COLUMN session_id TEXT');
      }
      if (!ingestFileStateColumns.has('record_count')) {
        this.db.exec('ALTER TABLE ingest_file_state ADD COLUMN record_count INTEGER');
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS ingest_file_state_session_parser_path
          ON ingest_file_state(session_id, parser, path)
      `);
      const estimateFitColumns = new Set(
        this.db.prepare('PRAGMA table_info(usage_estimate_fits)').all().map((column) => column.name),
      );
      if (!estimateFitColumns.has('pool_id')) {
        // Account-grain weights are invalid for a pooled provider and cannot
        // be promoted. Drop them during the idempotent shape migration; the
        // recurring ingest immediately writes fresh pool-grain fits.
        this.db.exec(`
        ALTER TABLE usage_estimate_fits RENAME TO usage_estimate_fits_legacy;
        CREATE TABLE usage_estimate_fits (
          pool_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
          scope TEXT NOT NULL CHECK(scope IN ('weekly','5-hour')),
          input_uncached_weight REAL,
          input_cache_read_weight REAL,
          input_cache_write_weight REAL,
          output_total_weight REAL,
          fit_quality REAL,
          identifiability TEXT NOT NULL
            CHECK(identifiability IN ('well-conditioned','ill-conditioned','not-assessed')),
          condition_ratio REAL,
          intervals_used INTEGER NOT NULL CHECK(intervals_used >= 0),
          method TEXT NOT NULL,
          reason TEXT,
          fitted_at TEXT NOT NULL,
          PRIMARY KEY(pool_id, scope),
          CHECK(input_uncached_weight IS NULL OR input_uncached_weight >= 0),
          CHECK(input_cache_read_weight IS NULL OR input_cache_read_weight >= 0),
          CHECK(input_cache_write_weight IS NULL OR input_cache_write_weight >= 0),
          CHECK(output_total_weight IS NULL OR output_total_weight >= 0),
          CHECK(fit_quality IS NULL OR (fit_quality >= 0 AND fit_quality <= 1)),
          CHECK(condition_ratio IS NULL OR (condition_ratio >= 0 AND condition_ratio <= 1)),
          CHECK(
            (reason IS NULL
              AND input_uncached_weight IS NOT NULL
              AND input_cache_read_weight IS NOT NULL
              AND input_cache_write_weight IS NOT NULL
              AND output_total_weight IS NOT NULL
              AND fit_quality IS NOT NULL
              AND identifiability = 'well-conditioned'
              AND condition_ratio IS NOT NULL
              AND condition_ratio >= 0.00000001)
            OR
            (reason IS NOT NULL
              AND input_uncached_weight IS NULL
              AND input_cache_read_weight IS NULL
              AND input_cache_write_weight IS NULL
              AND output_total_weight IS NULL
              AND fit_quality IS NULL
              AND (
                (identifiability = 'ill-conditioned'
                  AND condition_ratio IS NOT NULL
                  AND condition_ratio < 0.00000001)
                OR
                (identifiability = 'not-assessed' AND condition_ratio IS NULL)
              ))
          )
        );
        DROP TABLE usage_estimate_fits_legacy;
        `);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const accountColumns = new Set(this.db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name));
    if (!accountColumns.has('identity')) this.db.exec("ALTER TABLE accounts ADD COLUMN identity TEXT NOT NULL DEFAULT ''");
  }

  close() {
    this.db.close();
  }

  listAccounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY provider, is_default DESC, label').all().map(accountRow);
  }

  getAccount(id) {
    return accountRow(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  findAccount(provider, profileRef) {
    return accountRow(this.db.prepare('SELECT * FROM accounts WHERE provider = ? AND profile_ref = ?').get(provider, profileRef));
  }

  saveAccount(input) {
    // Decision 0035: Grok is the third provider. The enum widens here (and
    // only here) for the quota probe — request_usage stays claude|codex until
    // the wire/pool stage, because nothing routes Grok through the proxy yet.
    if (!CORPUS_PROVIDERS.includes(input.provider)) throw new Error('provider must be claude, codex, or grok');
    if (!input.label?.trim()) throw new Error('account label is required');
    if (!input.profileRef?.trim()) throw new Error('profile reference is required');
    let profileRef = input.profileRef.trim();
    if (input.provider === 'codex') {
      const managed = this.getSettings().codexManaged === true;
      // The service restricts unmanaged registrations to the real default home.
      // A fresh login may not have created it yet; never mkdir or chmod it here.
      if (managed || fs.existsSync(profileRef)) {
        const canonical = canonicalDirectory(profileRef, 'CODEX_HOME');
        if (process.getuid && canonical.stat.uid !== process.getuid()) throw new Error('CODEX_HOME must be owned by the current user');
        if (managed && (canonical.stat.mode & 0o077) !== 0) throw new Error(`CODEX_HOME must use owner-only permissions (chmod 700 ${canonical.path})`);
        profileRef = canonical.path;
      } else {
        if (!path.isAbsolute(profileRef)) throw new Error('CODEX_HOME must be an absolute path');
        profileRef = path.resolve(profileRef);
      }
      for (const account of this.listAccounts().filter((item) => item.provider === 'codex' && item.id !== input.id)) {
        if (profileRef === account.profileRef || profileRef.startsWith(`${account.profileRef}${path.sep}`) || account.profileRef.startsWith(`${profileRef}${path.sep}`)) {
          if (profileRef !== account.profileRef) throw new Error('CODEX_HOME profiles cannot be nested inside one another');
        }
      }
    }
    const existing = input.id ? this.getAccount(input.id) : this.findAccount(input.provider, profileRef);
    const id = existing?.id || crypto.randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO accounts(id, provider, label, identity, purpose, profile_ref, color, enabled, is_default, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label, identity=excluded.identity, purpose=excluded.purpose, profile_ref=excluded.profile_ref,
        color=excluded.color, enabled=excluded.enabled, metadata_json=excluded.metadata_json,
        updated_at=excluded.updated_at
    `).run(
      id,
      input.provider,
      input.label.trim(),
      input.identity == null ? existing?.identity || '' : input.identity.trim(),
      input.purpose == null ? existing?.purpose || '' : input.purpose.trim(),
      profileRef,
      input.color || ACCOUNT_COLORS[input.provider],
      input.enabled === false ? 0 : 1,
      existing?.isDefault ? 1 : 0,
      JSON.stringify(input.metadata || existing?.metadata || {}),
      existing?.createdAt || timestamp,
      timestamp,
    );
    if (input.isDefault) this.setDefault(input.provider, id);
    return this.getAccount(id);
  }

  /// Publish a verified directory migration atomically, without changing any
  /// other account fields. A stale account reference aborts the whole batch.
  repointCodexProfiles(moves) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(`
        UPDATE accounts SET profile_ref = ?
        WHERE id = ? AND provider = 'codex' AND profile_ref = ?
      `);
      for (const { id, from, to } of moves) {
        if (update.run(to, id, from).changes !== 1) throw new Error('Codex profile reference changed during migration');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setDefault(provider, id) {
    const account = this.getAccount(id);
    if (!account || account.provider !== provider) throw new Error('account does not match provider');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE accounts SET is_default = 0, updated_at = ? WHERE provider = ?').run(now(), provider);
      this.db.prepare('UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ?').run(now(), id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getAccount(id);
  }

  deleteAccount(id) {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  listProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(projectRow);
  }

  projectPredicate(column, project) {
    const trackedPaths = this.listProjects().map((tracked) => tracked.path);
    const contained = trackedPaths.includes(project)
      ? trackedPaths.filter((candidate) => pathContains(project, candidate))
      : [];
    return projectPredicate(column, project, contained);
  }

  getProject(id) {
    return projectRow(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  }

  findProjectByPath(projectPath) {
    const canonical = canonicalDirectory(projectPath, 'project').path;
    return projectRow(this.db.prepare('SELECT * FROM projects WHERE path = ?').get(canonical));
  }

  saveProject(input) {
    const projectPath = canonicalDirectory(input.path, 'project').path;
    const existing = input.id ? this.getProject(input.id) : this.findProjectByPath(projectPath);
    const id = existing?.id || crypto.randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO projects(id, name, path, purpose, claude_account_id, codex_account_id, detected, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        name=excluded.name, purpose=CASE WHEN projects.purpose='' THEN excluded.purpose ELSE projects.purpose END,
        detected=excluded.detected, updated_at=excluded.updated_at
    `).run(
      id,
      input.name?.trim() || path.basename(projectPath),
      projectPath,
      input.purpose?.trim() || existing?.purpose || '',
      input.claudeAccountId ?? existing?.claudeAccountId ?? null,
      input.codexAccountId ?? existing?.codexAccountId ?? null,
      input.detected === false ? 0 : 1,
      existing?.createdAt || timestamp,
      timestamp,
    );
    return this.findProjectByPath(projectPath);
  }

  mapProject(id, input) {
    const project = this.getProject(id);
    if (!project) throw new Error('project not found');
    for (const [provider, accountId] of [['claude', input.claudeAccountId], ['codex', input.codexAccountId]]) {
      if (!accountId) continue;
      const account = this.getAccount(accountId);
      if (!account || account.provider !== provider) throw new Error(`${provider} mapping must reference a ${provider} account`);
    }
    this.db.prepare(`
      UPDATE projects SET purpose=?, claude_account_id=?, codex_account_id=?, updated_at=? WHERE id=?
    `).run(
      input.purpose?.trim() ?? project.purpose,
      input.claudeAccountId || null,
      input.codexAccountId || null,
      now(),
      id,
    );
    return this.getProject(id);
  }

  resolveProject(projectPath) {
    const absolute = path.resolve(expandHome(projectPath));
    const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    return this.listProjects()
      .filter((project) => {
        const relative = path.relative(project.path, resolved);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      })
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  recordUsage(accountId, snapshot) {
    this.db.prepare(`
      INSERT INTO usage_snapshots(account_id, scope, used_percent, resets_at, observed_at, source, stale, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      snapshot.scope,
      snapshot.usedPercent ?? null,
      snapshot.resetsAt || null,
      snapshot.observedAt || now(),
      snapshot.source,
      snapshot.stale ? 1 : 0,
      JSON.stringify(snapshot.detail || {}),
    );
  }

  /// Delete at most one bounded batch of expired history while always keeping
  /// the newest observation for every (account, scope). Candidate discovery is
  /// a range walk over usage_observed; the newer-row guard is served by the
  /// existing latest-row covering index. DELETE resolves only selected ids.
  pruneUsageSnapshotsBatch({ cutoff, batchSize = USAGE_SNAPSHOT_PRUNE_BATCH_SIZE }) {
    const cutoffMs = typeof cutoff === 'string' ? Date.parse(cutoff) : NaN;
    if (!Number.isFinite(cutoffMs) || new Date(cutoffMs).toISOString() !== cutoff) {
      throw new Error('usage snapshot prune cutoff must be a canonical ISO timestamp');
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > USAGE_SNAPSHOT_PRUNE_BATCH_SIZE) {
      throw new Error(`usage snapshot prune batchSize must be an integer from 1 to ${USAGE_SNAPSHOT_PRUNE_BATCH_SIZE}`);
    }
    return this.db.prepare(`
      DELETE FROM usage_snapshots
      WHERE id IN (
        SELECT old.id
        FROM usage_snapshots AS old INDEXED BY usage_observed
        WHERE old.observed_at < ?
          AND EXISTS (
            SELECT 1
            FROM usage_snapshots AS newer INDEXED BY usage_account_scope_observed
            WHERE newer.account_id = old.account_id
              AND newer.scope = old.scope
              AND (newer.observed_at, newer.id) > (old.observed_at, old.id)
          )
        ORDER BY old.observed_at, old.id
        LIMIT ?
      )
    `).run(cutoff, batchSize).changes;
  }

  /// Delete at most one bounded batch of request evidence strictly older than
  /// the retention cutoff. Boundary and future clock-skew rows remain intact.
  pruneRequestUsageBatch({ cutoff, batchSize = REQUEST_USAGE_PRUNE_BATCH_SIZE }) {
    const cutoffMs = typeof cutoff === 'string' ? Date.parse(cutoff) : NaN;
    if (!Number.isFinite(cutoffMs) || new Date(cutoffMs).toISOString() !== cutoff) {
      throw new Error('request usage prune cutoff must be a canonical ISO timestamp');
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > REQUEST_USAGE_PRUNE_BATCH_SIZE) {
      throw new Error(`request usage prune batchSize must be an integer from 1 to ${REQUEST_USAGE_PRUNE_BATCH_SIZE}`);
    }
    return this.db.prepare(`
      DELETE FROM request_usage
      WHERE id IN (
        SELECT id
        FROM request_usage INDEXED BY request_usage_observed
        WHERE observed_at < ?
        ORDER BY observed_at, id
        LIMIT ?
      )
    `).run(cutoff, batchSize).changes;
  }

  walAutoCheckpointPages() {
    return this.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint;
  }

  setWalAutoCheckpointPages(pages) {
    if (!Number.isInteger(pages) || pages < 0) throw new Error('WAL autocheckpoint pages must be a nonnegative integer');
    this.db.exec(`PRAGMA wal_autocheckpoint = ${pages}`);
  }

  checkpointWal() {
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  /// Walk receipts newest-id first, keeping at most the newest 50k unexpired
  /// rows. Carry the cursor/count between batches so both reads and deletes
  /// are bounded, without building an index over the existing raw-JSON backlog.
  pruneOtelQuarantineBatch({ cutoff, beforeId = null, retained = 0, batchSize = OTEL_QUARANTINE_PRUNE_BATCH_SIZE }) {
    const cutoffMs = typeof cutoff === 'string' ? Date.parse(cutoff) : NaN;
    if (!Number.isFinite(cutoffMs) || new Date(cutoffMs).toISOString() !== cutoff) {
      throw new Error('OTLP quarantine prune cutoff must be a canonical ISO timestamp');
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > OTEL_QUARANTINE_PRUNE_BATCH_SIZE) {
      throw new Error(`OTLP quarantine prune batchSize must be an integer from 1 to ${OTEL_QUARANTINE_PRUNE_BATCH_SIZE}`);
    }
    const rows = this.db.prepare(`
      SELECT id, received_at FROM otel_quarantine
      ${beforeId == null ? '' : 'WHERE id < ?'}
      ORDER BY id DESC LIMIT ?
    `).all(...(beforeId == null ? [batchSize] : [beforeId, batchSize]));
    const expiredIds = [];
    for (const row of rows) {
      if (row.received_at < cutoff || retained >= OTEL_QUARANTINE_MAX_ROWS) expiredIds.push(row.id);
      else retained += 1;
    }
    const deleted = expiredIds.length === 0 ? 0 : this.db.prepare(`
      DELETE FROM otel_quarantine WHERE id IN (${expiredIds.map(() => '?').join(',')})
    `).run(...expiredIds).changes;
    return { deleted, scanned: rows.length, beforeId: rows.at(-1)?.id ?? beforeId, retained };
  }

  /// Issue #174: the newest stored row for one (account, scope) — the
  /// statusline ingest's record-if-newer guard reads this before inserting.
  /// Same ordering contract as latestUsage: newest observed_at wins, insert
  /// order (id) breaks ties.
  latestUsageRow(accountId, scope) {
    return usageRow(this.db.prepare(`
      SELECT * FROM usage_snapshots
      WHERE account_id = ? AND scope = ?
      ORDER BY observed_at DESC, id DESC LIMIT 1
    `).get(accountId, scope));
  }

  // Issue #174: "latest" means newest OBSERVATION, not newest insert. With a
  // single snapshot source those coincide (probe rows are stamped at insert
  // time), but statusline captures carry their own observedAt — a refresh
  // pass that lands after a fresher capture was ingested must not shadow it
  // just by inserting later. Ties (identical observed_at) keep the previous
  // max-id behavior.
  latestUsage() {
    // Seek past each scope's entire history for the known accounts. Keep the
    // account equality separate: SQLite's tuple > seek still visits every row
    // equal to the previous pair before advancing (as does SELECT DISTINCT).
    const firstScope = this.db.prepare(`
      SELECT scope FROM usage_snapshots WHERE account_id = ?
      ORDER BY scope LIMIT 1
    `);
    const nextScope = this.db.prepare(`
      SELECT scope FROM usage_snapshots WHERE account_id = ? AND scope > ?
      ORDER BY scope LIMIT 1
    `);
    const rows = [];
    for (const account of this.db.prepare('SELECT id FROM accounts ORDER BY id').all()) {
      let pair = firstScope.get(account.id);
      while (pair) {
        rows.push(this.latestUsageRow(account.id, pair.scope));
        pair = nextScope.get(account.id, pair.scope);
      }
    }
    return rows;
  }

  usageHistory({ accountId, scope, since, until, bucket = 'raw' } = {}) {
    const normalizedAccountId = usageHistoryString(accountId, 'accountId');
    const normalizedScope = usageHistoryString(scope, 'scope');
    const normalizedSince = usageHistoryTimestamp(since, 'since');
    const normalizedUntil = usageHistoryTimestamp(until, 'until');
    if (normalizedSince > normalizedUntil) throw new Error('usage history since must not be after until');
    if (!USAGE_HISTORY_BUCKETS.has(bucket)) throw new Error('usage history bucket must be raw, hour, or day');

    // observed_at predates this reader and may use another valid ISO offset or
    // omit milliseconds. Pad the index range, then compare/order exact instants.
    const indexedSince = new Date(Date.parse(normalizedSince) - USAGE_HISTORY_INDEX_PADDING_MS).toISOString();
    const indexedUntil = new Date(Date.parse(normalizedUntil) + USAGE_HISTORY_INDEX_PADDING_MS).toISOString();
    const selection = bucket === 'raw' ? '*' : 'id, used_percent, resets_at, observed_at';
    const orderAndLimit = bucket === 'raw' ? 'ORDER BY julianday(observed_at) DESC, id DESC LIMIT ?' : '';
    const statement = this.db.prepare(`
      SELECT ${selection} FROM usage_snapshots INDEXED BY usage_account_scope_observed
      WHERE account_id = ? AND scope = ?
        AND observed_at >= ? AND observed_at <= ?
        AND julianday(observed_at) >= julianday(?)
        AND julianday(observed_at) <= julianday(?)
      ${orderAndLimit}
    `);
    const parameters = [
      normalizedAccountId,
      normalizedScope,
      indexedSince,
      indexedUntil,
      normalizedSince,
      normalizedUntil,
    ];
    const rows = bucket === 'raw'
      ? statement.all(...parameters, USAGE_HISTORY_RAW_LIMIT + 1)
      : statement.iterate(...parameters);

    const result = {
      accountId: normalizedAccountId,
      scope: normalizedScope,
      since: normalizedSince,
      until: normalizedUntil,
      bucket,
      rows: bucket === 'raw'
        ? rows.slice(0, USAGE_HISTORY_RAW_LIMIT).map(usageRow)
        : bucketUsageHistory(rows, bucket),
      truncated: bucket === 'raw' && rows.length > USAGE_HISTORY_RAW_LIMIT,
    };
    return result;
  }

  /// Insert normalized proxy request records as one transaction. The archive
  /// source resolves only Claude accounts in this slice: Codex account
  /// identities are intentionally blank until the explicit mapping follow-up.
  /// INSERT OR IGNORE makes request_id the durable replay/idempotency key.
  ingestRequestUsage(records) {
    if (!records || typeof records[Symbol.iterator] !== 'function') throw new Error('request usage records must be iterable');
    const resolveAccount = this.db.prepare(`
      SELECT id FROM accounts
      WHERE provider = 'claude' AND identity <> '' AND identity = ? COLLATE NOCASE
      ORDER BY id LIMIT 2
    `);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO request_usage(
        request_id, machine, observed_at, account_id, profile_label, source_raw,
        provider, provider_request_id, model, alias, reasoning_effort, endpoint, user_agent_class,
        failed, status_code, latency_ms, ttft_ms,
        input_uncached, input_cache_read, input_cache_write,
        output_total, output_reasoning, total,
        limit_used_percent, limit_status, limit_resets_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const summary = { inserted: 0, duplicates: 0, resolved: 0, unresolved: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        validateRequestUsageRecord(record);
        const matches = record.provider === 'claude' ? resolveAccount.all(record.source) : [];
        const accountId = matches.length === 1 ? matches[0].id : null;
        const result = insert.run(
          record.requestId,
          record.machine,
          record.observedAt,
          accountId,
          record.profileLabel ?? null,
          accountId == null ? record.source : null,
          record.provider,
          record.providerRequestId ?? null,
          record.model,
          record.alias || null,
          record.reasoningEffort || null,
          record.endpoint || null,
          record.userAgentClass || 'unknown',
          record.failed ? 1 : 0,
          record.statusCode ?? null,
          record.latencyMs ?? null,
          record.ttftMs ?? null,
          record.inputUncached ?? 0,
          record.inputCacheRead ?? 0,
          record.inputCacheWrite ?? 0,
          record.outputTotal ?? 0,
          record.outputReasoning ?? 0,
          record.total ?? 0,
          record.limitUsedPercent ?? null,
          record.limitStatus ?? null,
          record.limitResetsAt ?? null,
        );
        if (result.changes === 0) {
          summary.duplicates += 1;
        } else {
          summary.inserted += 1;
          if (accountId == null) summary.unresolved += 1;
          else summary.resolved += 1;
        }
      }
      this.resolveRequestUsageAccounts();
      this.db.exec('COMMIT');
      return summary;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// Read the chronologically trailing failure streak for one routed member.
  /// Queue batches can arrive late or be replayed, so this is derived from the
  /// durable request archive instead of trusting ingest order or process memory.
  /// parseUsageRecord canonicalizes observed_at to UTC ISO, so indexed text
  /// ordering is chronological here.
  // -------------------------------------------------------------------------
  // Issue #377 — per-session model state (see the session_model_state DDL).

  /// The last recorded state for one session, or null.
  sessionModelState(accountId, sessionId) {
    const row = this.db.prepare(`
      SELECT * FROM session_model_state WHERE account_id = ? AND session_id = ?
    `).get(accountId, sessionId);
    return row ? sessionModelStateRow(row) : null;
  }

  /// Upsert one session's state. `droppedFrom`/`droppedAt` are written on
  /// every call, so passing null CLEARS a standing drop — recovery and
  /// detection use the same single write.
  saveSessionModelState({
    accountId,
    sessionId,
    model,
    modelDisplay = null,
    cwd = null,
    observedAt,
    droppedFrom = null,
    droppedFromDisplay = null,
    droppedAt = null,
  }) {
    this.db.prepare(`
      INSERT INTO session_model_state(
        account_id, session_id, model, model_display, cwd, observed_at,
        dropped_from, dropped_from_display, dropped_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, session_id) DO UPDATE SET
        model = excluded.model,
        model_display = excluded.model_display,
        cwd = excluded.cwd,
        observed_at = excluded.observed_at,
        dropped_from = excluded.dropped_from,
        dropped_from_display = excluded.dropped_from_display,
        dropped_at = excluded.dropped_at
    `).run(
      accountId, sessionId, model, modelDisplay, cwd, observedAt,
      droppedFrom, droppedFromDisplay, droppedAt,
    );
    return this.sessionModelState(accountId, sessionId);
  }

  /// Every session carrying an unresolved drop, newest drop first. `since`
  /// bounds the result to sessions still observed at or after that instant —
  /// a closed session can never report the recovery that clears its own drop
  /// (CodeRabbit, PR #472).
  listSessionModelDrops({ since = null } = {}) {
    const bound = typeof since === 'string' && since.trim() ? since : null;
    return this.db.prepare(`
      SELECT * FROM session_model_state
      WHERE dropped_at IS NOT NULL
        AND (? IS NULL OR observed_at >= ?)
      ORDER BY dropped_at DESC, session_id ASC
    `).all(bound, bound).map(sessionModelStateRow);
  }

  /// Remove rows for sessions last observed before `before`. The reader bound
  /// above hides them; this is what keeps the table from growing forever.
  /// Returns the number of rows removed.
  pruneSessionModelState(before) {
    if (typeof before !== 'string' || !before.trim()) {
      throw new Error('session model state prune cutoff is required');
    }
    return this.db.prepare(`
      DELETE FROM session_model_state WHERE observed_at < ?
    `).run(before).changes;
  }

  requestFailureStreak({ accountId = null, provider = null, source = null } = {}) {
    let selector;
    let selectorParameters;
    if (typeof accountId === 'string' && accountId.trim()) {
      selector = 'account_id = ?';
      selectorParameters = [accountId.trim()];
    } else {
      if (!['claude', 'codex'].includes(provider)) {
        throw new Error('request failure streak provider must be claude or codex');
      }
      if (typeof source !== 'string' || !source.trim()) {
        throw new Error('request failure streak source is required');
      }
      selector = 'account_id IS NULL AND provider = ? AND source_raw = ? COLLATE NOCASE';
      selectorParameters = [provider, source.trim()];
    }

    const latestSuccess = this.db.prepare(`
      SELECT observed_at, id
      FROM request_usage
      WHERE ${selector} AND failed = 0
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `).get(...selectorParameters);
    const afterSuccess = latestSuccess
      ? `AND (
          observed_at > ?
          OR (observed_at = ? AND id > ?)
        )`
      : '';
    const afterSuccessParameters = latestSuccess
      ? [latestSuccess.observed_at, latestSuccess.observed_at, latestSuccess.id]
      : [];
    const row = this.db.prepare(`
      WITH failures AS (
        SELECT id, observed_at, status_code
        FROM request_usage
        WHERE ${selector} AND failed = 1 ${afterSuccess}
      )
      SELECT
        COUNT(*) AS consecutive_failures,
        MIN(observed_at) AS first_failure_at,
        MAX(observed_at) AS last_failure_at,
        (
          SELECT status_code
          FROM failures
          ORDER BY observed_at DESC, id DESC
          LIMIT 1
        ) AS latest_status_code
      FROM failures
    `).get(...selectorParameters, ...afterSuccessParameters);
    return {
      consecutiveFailures: Number(row.consecutive_failures || 0),
      firstFailureAt: row.first_failure_at || null,
      lastFailureAt: row.last_failure_at || null,
      statusCode: row.latest_status_code == null ? null : Number(row.latest_status_code),
    };
  }

  getIngestFileState(filePath) {
    const row = this.db.prepare(`
      SELECT size, mtime_ms, ino, parser, parser_version, session_id, record_count,
        reconcile_pending
      FROM ingest_file_state WHERE path = ?
    `).get(filePath);
    return row ? {
      size: row.size,
      mtimeMs: row.mtime_ms,
      ino: row.ino,
      parser: row.parser || null,
      parserVersion: row.parser_version == null ? null : Number(row.parser_version),
      sessionId: row.session_id || null,
      recordCount: row.record_count == null ? null : Number(row.record_count),
      reconcilePending: Boolean(row.reconcile_pending),
    } : null;
  }

  getIngestFilePathsForSession(sessionId, parser) {
    return this.db.prepare(`
      SELECT path FROM ingest_file_state
      WHERE session_id = ? AND parser = ?
      ORDER BY path
    `).all(sessionId, parser).map((row) => row.path);
  }

  recordIngestFileState(filePath, { size, mtimeMs, ino }, {
    parser = null,
    parserVersion = null,
    sessionId = null,
    recordCount = null,
  } = {}) {
    this.db.prepare(`
      INSERT INTO ingest_file_state(
        path, size, mtime_ms, ino, parser, parser_version, session_id, record_count,
        reconcile_pending, last_ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        ino = excluded.ino,
        parser = excluded.parser,
        parser_version = excluded.parser_version,
        session_id = excluded.session_id,
        record_count = excluded.record_count,
        reconcile_pending = 0,
        last_ingested_at = excluded.last_ingested_at
    `).run(filePath, size, mtimeMs, ino, parser, parserVersion, sessionId, recordCount, now());
  }

  recordIngestFileStates(entries, {
    parser = null,
    parserVersion = null,
    sessionId = null,
  } = {}) {
    if (!entries.length) return;
    const record = this.db.prepare(`
      INSERT INTO ingest_file_state(
        path, size, mtime_ms, ino, parser, parser_version, session_id, record_count,
        reconcile_pending, last_ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        ino = excluded.ino,
        parser = excluded.parser,
        parser_version = excluded.parser_version,
        session_id = excluded.session_id,
        record_count = excluded.record_count,
        reconcile_pending = 0,
        last_ingested_at = excluded.last_ingested_at
    `);
    const ingestedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const {
        filePath,
        stat: { size, mtimeMs, ino },
        recordCount = null,
        sessionId: entrySessionId = sessionId,
      } of entries) {
        record.run(
          filePath,
          size,
          mtimeMs,
          ino,
          parser,
          parserVersion,
          entrySessionId,
          recordCount,
          ingestedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markIngestFileReconcilePending(filePath) {
    this.db.prepare(`
      UPDATE ingest_file_state
      SET reconcile_pending = 1
      WHERE path = ?
    `).run(filePath);
  }

  markIngestFilesReconcilePending(filePaths) {
    if (!filePaths.length) return;
    const markPending = this.db.prepare(`
      UPDATE ingest_file_state
      SET reconcile_pending = 1
      WHERE path = ?
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const filePath of filePaths) markPending.run(filePath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// Upsert one streamed Codex rollout summary. Active rollout files grow in
  /// place, so replay safety cannot be INSERT-only: the session bounds and
  /// existing turn aggregates must advance on later scans. The stable
  /// (session_id, turn_index) key keeps the operation idempotent, while the
  /// partial turn_id index preserves the provider identifier when present.
  ingestCodexSession(session, turns, { reconcile = false } = {}) {
    turns = [...turns];
    validateCodexSessionRecord(session, turns);
    const insertSession = this.db.prepare(`
      INSERT INTO codex_sessions(
        session_id, profile_slug, machine, cwd, originator, source, cli_version,
        git_branch, git_repo, git_commit, first_timestamp, last_timestamp, archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        profile_slug=excluded.profile_slug,
        machine=excluded.machine,
        cwd=COALESCE(excluded.cwd, codex_sessions.cwd),
        originator=COALESCE(excluded.originator, codex_sessions.originator),
        source=COALESCE(excluded.source, codex_sessions.source),
        cli_version=COALESCE(excluded.cli_version, codex_sessions.cli_version),
        git_branch=COALESCE(excluded.git_branch, codex_sessions.git_branch),
        git_repo=COALESCE(excluded.git_repo, codex_sessions.git_repo),
        git_commit=COALESCE(excluded.git_commit, codex_sessions.git_commit),
        first_timestamp=MIN(codex_sessions.first_timestamp, excluded.first_timestamp),
        last_timestamp=MAX(codex_sessions.last_timestamp, excluded.last_timestamp),
        archived=MAX(codex_sessions.archived, excluded.archived)
      WHERE codex_sessions.profile_slug IS NOT excluded.profile_slug
        OR codex_sessions.machine IS NOT excluded.machine
        OR codex_sessions.cwd IS NOT COALESCE(excluded.cwd, codex_sessions.cwd)
        OR codex_sessions.originator IS NOT COALESCE(excluded.originator, codex_sessions.originator)
        OR codex_sessions.source IS NOT COALESCE(excluded.source, codex_sessions.source)
        OR codex_sessions.cli_version IS NOT COALESCE(excluded.cli_version, codex_sessions.cli_version)
        OR codex_sessions.git_branch IS NOT COALESCE(excluded.git_branch, codex_sessions.git_branch)
        OR codex_sessions.git_repo IS NOT COALESCE(excluded.git_repo, codex_sessions.git_repo)
        OR codex_sessions.git_commit IS NOT COALESCE(excluded.git_commit, codex_sessions.git_commit)
        OR codex_sessions.first_timestamp IS NOT MIN(codex_sessions.first_timestamp, excluded.first_timestamp)
        OR codex_sessions.last_timestamp IS NOT MAX(codex_sessions.last_timestamp, excluded.last_timestamp)
        OR codex_sessions.archived IS NOT MAX(codex_sessions.archived, excluded.archived)
    `);
    const insertTurn = this.db.prepare(`
      INSERT INTO codex_turns(
        session_id, turn_index, turn_id, model, reasoning_effort,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens,
        duration_ms, time_to_first_token_ms, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn_index) DO UPDATE SET
        turn_id=COALESCE(excluded.turn_id, codex_turns.turn_id),
        model=COALESCE(excluded.model, codex_turns.model),
        reasoning_effort=COALESCE(excluded.reasoning_effort, codex_turns.reasoning_effort),
        input_tokens=excluded.input_tokens,
        cached_input_tokens=excluded.cached_input_tokens,
        cache_write_input_tokens=excluded.cache_write_input_tokens,
        output_tokens=excluded.output_tokens,
        reasoning_output_tokens=excluded.reasoning_output_tokens,
        total_tokens=excluded.total_tokens,
        duration_ms=COALESCE(excluded.duration_ms, codex_turns.duration_ms),
        time_to_first_token_ms=COALESCE(excluded.time_to_first_token_ms, codex_turns.time_to_first_token_ms),
        timestamp=COALESCE(excluded.timestamp, codex_turns.timestamp)
      WHERE codex_turns.turn_id IS NOT COALESCE(excluded.turn_id, codex_turns.turn_id)
        OR codex_turns.model IS NOT COALESCE(excluded.model, codex_turns.model)
        OR codex_turns.reasoning_effort IS NOT COALESCE(excluded.reasoning_effort, codex_turns.reasoning_effort)
        OR codex_turns.input_tokens IS NOT excluded.input_tokens
        OR codex_turns.cached_input_tokens IS NOT excluded.cached_input_tokens
        OR codex_turns.cache_write_input_tokens IS NOT excluded.cache_write_input_tokens
        OR codex_turns.output_tokens IS NOT excluded.output_tokens
        OR codex_turns.reasoning_output_tokens IS NOT excluded.reasoning_output_tokens
        OR codex_turns.total_tokens IS NOT excluded.total_tokens
        OR codex_turns.duration_ms IS NOT COALESCE(excluded.duration_ms, codex_turns.duration_ms)
        OR codex_turns.time_to_first_token_ms IS NOT COALESCE(excluded.time_to_first_token_ms, codex_turns.time_to_first_token_ms)
        OR codex_turns.timestamp IS NOT COALESCE(excluded.timestamp, codex_turns.timestamp)
    `);
    const existingSession = this.db.prepare('SELECT 1 FROM codex_sessions WHERE session_id = ?');
    const existingTurn = this.db.prepare('SELECT 1 FROM codex_turns WHERE session_id = ? AND turn_index = ?');
    const summary = { sessionsInserted: 0, sessionsUpdated: 0, turnsInserted: 0, turnsUpdated: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sessionExists = Boolean(existingSession.get(session.sessionId));
      const sessionResult = insertSession.run(
        session.sessionId,
        session.profileSlug,
        session.machine,
        session.cwd ?? null,
        session.originator ?? null,
        session.source ?? null,
        session.cliVersion ?? null,
        session.gitBranch ?? null,
        session.gitRepo ?? null,
        session.gitCommit ?? null,
        session.firstTimestamp,
        session.lastTimestamp,
        session.archived ? 1 : 0,
      );
      if (!sessionExists) summary.sessionsInserted += 1;
      else if (sessionResult.changes > 0) summary.sessionsUpdated += 1;
      if (reconcile) {
        this.db.prepare('DELETE FROM codex_turns WHERE session_id = ?').run(session.sessionId);
      }
      for (const turn of turns) {
        const turnExists = Boolean(existingTurn.get(session.sessionId, turn.turnIndex));
        const turnResult = insertTurn.run(
          session.sessionId,
          turn.turnIndex,
          turn.turnId ?? null,
          turn.model ?? null,
          turn.reasoningEffort ?? null,
          turn.inputTokens,
          turn.cachedInputTokens,
          turn.cacheWriteInputTokens,
          turn.outputTokens,
          turn.reasoningOutputTokens,
          turn.totalTokens,
          turn.durationMs ?? null,
          turn.timeToFirstTokenMs ?? null,
          turn.timestamp ?? null,
        );
        if (!turnExists) summary.turnsInserted += 1;
        else if (turnResult.changes > 0) summary.turnsUpdated += 1;
      }
      this.db.exec('COMMIT');
      return summary;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  removeCodexSession(sessionId) {
    this.db.prepare('DELETE FROM codex_sessions WHERE session_id = ?').run(sessionId);
  }

  /// Upsert one read-only Grok updates stream. The source file may grow in
  /// place, so stable session/turn indexes provide the same replay behavior as
  /// Codex rollouts while source JSON and a parser version preserve schema
  /// drift for later reprocessing.
  ingestGrokSession(session, turns, { transaction = true } = {}) {
    turns = [...turns];
    validateGrokSessionRecord(session, turns);
    const insertSession = this.db.prepare(`
      INSERT INTO grok_sessions(
        session_id, profile_slug, cwd_key, machine, cwd,
        first_timestamp, last_timestamp, source_file, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        profile_slug=excluded.profile_slug,
        cwd_key=excluded.cwd_key,
        machine=excluded.machine,
        cwd=COALESCE(excluded.cwd, grok_sessions.cwd),
        first_timestamp=CASE
          WHEN excluded.first_timestamp IS NULL THEN grok_sessions.first_timestamp
          WHEN grok_sessions.first_timestamp IS NULL THEN excluded.first_timestamp
          ELSE MIN(grok_sessions.first_timestamp, excluded.first_timestamp)
        END,
        last_timestamp=CASE
          WHEN excluded.last_timestamp IS NULL THEN grok_sessions.last_timestamp
          WHEN grok_sessions.last_timestamp IS NULL THEN excluded.last_timestamp
          ELSE MAX(grok_sessions.last_timestamp, excluded.last_timestamp)
        END,
        source_file=excluded.source_file,
        parser_version=excluded.parser_version
      WHERE grok_sessions.profile_slug IS NOT excluded.profile_slug
        OR grok_sessions.cwd_key IS NOT excluded.cwd_key
        OR grok_sessions.machine IS NOT excluded.machine
        OR grok_sessions.cwd IS NOT COALESCE(excluded.cwd, grok_sessions.cwd)
        OR grok_sessions.first_timestamp IS NOT CASE
          WHEN excluded.first_timestamp IS NULL THEN grok_sessions.first_timestamp
          WHEN grok_sessions.first_timestamp IS NULL THEN excluded.first_timestamp
          ELSE MIN(grok_sessions.first_timestamp, excluded.first_timestamp)
        END
        OR grok_sessions.last_timestamp IS NOT CASE
          WHEN excluded.last_timestamp IS NULL THEN grok_sessions.last_timestamp
          WHEN grok_sessions.last_timestamp IS NULL THEN excluded.last_timestamp
          ELSE MAX(grok_sessions.last_timestamp, excluded.last_timestamp)
        END
        OR grok_sessions.source_file IS NOT excluded.source_file
        OR grok_sessions.parser_version IS NOT excluded.parser_version
    `);
    const insertTurn = this.db.prepare(`
      INSERT INTO grok_turns(
        session_id, turn_index, turn_id, timestamp,
        input_tokens, output_tokens, total_tokens, cached_read_tokens,
        cache_creation_tokens, reasoning_tokens, model_calls,
        api_duration_ms, cost_usd_ticks, num_turns, parser_version,
        source_file, source_line, provenance_json, source_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn_index) DO UPDATE SET
        turn_id=excluded.turn_id,
        timestamp=excluded.timestamp,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        total_tokens=excluded.total_tokens,
        cached_read_tokens=excluded.cached_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        model_calls=excluded.model_calls,
        api_duration_ms=excluded.api_duration_ms,
        cost_usd_ticks=excluded.cost_usd_ticks,
        num_turns=excluded.num_turns,
        parser_version=excluded.parser_version,
        source_file=excluded.source_file,
        source_line=excluded.source_line,
        provenance_json=excluded.provenance_json,
        source_json=excluded.source_json
      WHERE grok_turns.parser_version IS NOT excluded.parser_version
        OR grok_turns.provenance_json IS NOT excluded.provenance_json
        OR grok_turns.source_json IS NOT excluded.source_json
    `);
    const insertModel = this.db.prepare(`
      INSERT INTO grok_model_usage(
        session_id, turn_index, turn_id, model,
        input_tokens, output_tokens, total_tokens, cached_read_tokens,
        cache_creation_tokens, reasoning_tokens, cost_usd_ticks,
        parser_version, source_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn_index, model) DO UPDATE SET
        turn_id=excluded.turn_id,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        total_tokens=excluded.total_tokens,
        cached_read_tokens=excluded.cached_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        cost_usd_ticks=excluded.cost_usd_ticks,
        parser_version=excluded.parser_version,
        source_json=excluded.source_json
      WHERE grok_model_usage.parser_version IS NOT excluded.parser_version
        OR grok_model_usage.source_json IS NOT excluded.source_json
    `);
    const existingSession = this.db.prepare('SELECT 1 FROM grok_sessions WHERE session_id = ?');
    const existingTurn = this.db.prepare('SELECT 1 FROM grok_turns WHERE session_id = ? AND turn_index = ?');
    const existingModel = this.db.prepare(`
      SELECT 1 FROM grok_model_usage WHERE session_id = ? AND turn_index = ? AND model = ?
    `);
    const summary = {
      sessionsInserted: 0,
      sessionsUpdated: 0,
      turnsInserted: 0,
      turnsUpdated: 0,
      modelUsageInserted: 0,
      modelUsageUpdated: 0,
    };
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const sessionExists = Boolean(existingSession.get(session.sessionId));
      const sessionResult = insertSession.run(
        session.sessionId,
        session.profileSlug,
        session.cwdKey,
        session.machine,
        session.cwd ?? null,
        session.firstTimestamp ?? null,
        session.lastTimestamp ?? null,
        session.sourceFile,
        session.parserVersion,
      );
      if (!sessionExists) summary.sessionsInserted += 1;
      else if (sessionResult.changes > 0) summary.sessionsUpdated += 1;
      for (const turn of turns) {
        const turnExists = Boolean(existingTurn.get(session.sessionId, turn.turnIndex));
        const result = insertTurn.run(
          session.sessionId,
          turn.turnIndex,
          turn.turnId ?? null,
          turn.timestamp ?? null,
          turn.inputTokens,
          turn.outputTokens,
          turn.totalTokens,
          turn.cachedReadTokens,
          turn.cacheCreationTokens,
          turn.reasoningTokens,
          turn.modelCalls ?? null,
          turn.apiDurationMs ?? null,
          turn.costUsdTicks,
          turn.numTurns ?? null,
          session.parserVersion,
          session.sourceFile,
          turn.sourceLine,
          turn.provenanceJson,
          turn.sourceJson,
        );
        if (!turnExists) summary.turnsInserted += 1;
        else if (result.changes > 0) summary.turnsUpdated += 1;
        for (const model of turn.modelUsage) {
          const modelExists = Boolean(existingModel.get(session.sessionId, turn.turnIndex, model.model));
          const modelResult = insertModel.run(
            session.sessionId,
            turn.turnIndex,
            turn.turnId ?? null,
            model.model,
            model.inputTokens,
            model.outputTokens,
            model.totalTokens,
            model.cachedReadTokens,
            model.cacheCreationTokens,
            model.reasoningTokens,
            model.costUsdTicks,
            session.parserVersion,
            model.sourceJson,
          );
          if (!modelExists) summary.modelUsageInserted += 1;
          else if (modelResult.changes > 0) summary.modelUsageUpdated += 1;
        }
      }
      if (transaction) this.db.exec('COMMIT');
      return summary;
    } catch (error) {
      if (transaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// Grok shrink replay uses a temporary payload table so file parsing never
  /// holds the Store connection's write transaction open. The final delete +
  /// insert is one synchronous publish scoped by session id.
  beginGrokReconcile(affectedSessions = []) {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS grok_reconcile_sessions (
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        PRIMARY KEY(session_id, profile_slug)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS grok_replay_payloads (
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        session_json TEXT NOT NULL,
        turns_json TEXT NOT NULL,
        PRIMARY KEY(session_id, profile_slug)
      ) WITHOUT ROWID;
    `);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO grok_reconcile_sessions(session_id, profile_slug) VALUES (?, ?)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM grok_reconcile_sessions;
        DELETE FROM grok_replay_payloads;
      `);
      for (const session of affectedSessions) insert.run(session.sessionId, session.profileSlug);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stageGrokReplay(session, turns) {
    turns = [...turns];
    validateGrokSessionRecord(session, turns);
    this.db.prepare(`
      INSERT INTO grok_replay_payloads(
        session_id, profile_slug, session_json, turns_json
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, profile_slug) DO UPDATE SET
        session_json = excluded.session_json,
        turns_json = excluded.turns_json
    `).run(
      session.sessionId,
      session.profileSlug,
      JSON.stringify(session),
      JSON.stringify(turns),
    );
  }

  finishGrokReconcile() {
    const payloads = this.db.prepare(`
      SELECT session_json, turns_json FROM grok_replay_payloads
      ORDER BY session_id, profile_slug
    `).all().map((row) => ({
      session: JSON.parse(row.session_json),
      turns: JSON.parse(row.turns_json),
    }));
    const deleteAffected = this.db.prepare(`
      DELETE FROM grok_sessions
      WHERE EXISTS (
        SELECT 1 FROM grok_reconcile_sessions replay
        WHERE replay.session_id = grok_sessions.session_id
      )
    `);
    const summary = {
      sessionsInserted: 0,
      sessionsUpdated: 0,
      turnsInserted: 0,
      turnsUpdated: 0,
      modelUsageInserted: 0,
      modelUsageUpdated: 0,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      deleteAffected.run();
      for (const payload of payloads) {
        const stored = this.ingestGrokSession(payload.session, payload.turns, { transaction: false });
        for (const [key, value] of Object.entries(stored)) summary[key] += value;
      }
      this.db.exec('COMMIT');
      return summary;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.cancelGrokReconcile();
    }
  }

  cancelGrokReconcile() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM grok_reconcile_sessions;
        DELETE FROM grok_replay_payloads;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// Insert one bounded streaming batch from Claude transcript JSONL files.
  /// Parent Agent rollup totals belong only in transcript_subagents; callers
  /// put the subagent file's actual API calls in transcript_requests so token
  /// accounting never adds both descriptions of the same work.
  ingestTranscriptBatch({ sessions = [], requests = [], subagents = [], skills = [] } = {}) {
    const insertSession = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_sessions(
        session_id, profile_slug, machine, cwd, git_branch, entrypoint,
        client_version, first_at, last_at, title, title_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateSession = this.db.prepare(`
      UPDATE transcript_sessions SET
        cwd = COALESCE(?, cwd),
        git_branch = COALESCE(?, git_branch),
        entrypoint = COALESCE(?, entrypoint),
        client_version = COALESCE(?, client_version),
        first_at = CASE
          WHEN ? IS NULL THEN first_at
          WHEN first_at IS NULL OR ? < first_at THEN ?
          ELSE first_at
        END,
        last_at = CASE
          WHEN ? IS NULL THEN last_at
          WHEN last_at IS NULL OR ? > last_at THEN ?
          ELSE last_at
        END,
        title = CASE
          WHEN ? IS NULL THEN title
          WHEN title_source = 'custom-title' AND ? <> 'custom-title' THEN title
          ELSE ?
        END,
        title_source = CASE
          WHEN ? IS NULL THEN title_source
          WHEN title_source = 'custom-title' AND ? <> 'custom-title' THEN title_source
          ELSE ?
        END
      WHERE session_id = ? AND profile_slug = ?
        AND (
          cwd IS NOT COALESCE(?, cwd)
          OR git_branch IS NOT COALESCE(?, git_branch)
          OR entrypoint IS NOT COALESCE(?, entrypoint)
          OR client_version IS NOT COALESCE(?, client_version)
          OR first_at IS NOT CASE
            WHEN ? IS NULL THEN first_at
            WHEN first_at IS NULL OR ? < first_at THEN ?
            ELSE first_at
          END
          OR last_at IS NOT CASE
            WHEN ? IS NULL THEN last_at
            WHEN last_at IS NULL OR ? > last_at THEN ?
            ELSE last_at
          END
          OR title IS NOT CASE
            WHEN ? IS NULL THEN title
            WHEN title_source = 'custom-title' AND ? <> 'custom-title' THEN title
            ELSE ?
          END
          OR title_source IS NOT CASE
            WHEN ? IS NULL THEN title_source
            WHEN title_source = 'custom-title' AND ? <> 'custom-title' THEN title_source
            ELSE ?
          END
        )
    `);
    const insertRequest = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_requests(
        dedupe_key, request_id, session_id, profile_slug, message_id, record_uuid,
        model, effort, observed_at, input_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
        cache_creation_ephemeral_5m_input_tokens,
        cache_creation_ephemeral_1h_input_tokens, is_sidechain, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSubagent = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_subagents(
        agent_id, session_id, profile_slug, agent_type, resolved_model, total_tokens,
        tool_stats_json, duration_ms, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateSubagent = this.db.prepare(`
      UPDATE transcript_subagents SET
        agent_type = COALESCE(?, agent_type),
        resolved_model = COALESCE(?, resolved_model),
        total_tokens = COALESCE(?, total_tokens),
        tool_stats_json = COALESCE(?, tool_stats_json),
        duration_ms = COALESCE(?, duration_ms),
        observed_at = COALESCE(?, observed_at)
      WHERE agent_id = ? AND profile_slug = ?
        AND (
          agent_type IS NOT COALESCE(?, agent_type)
          OR resolved_model IS NOT COALESCE(?, resolved_model)
          OR total_tokens IS NOT COALESCE(?, total_tokens)
          OR tool_stats_json IS NOT COALESCE(?, tool_stats_json)
          OR duration_ms IS NOT COALESCE(?, duration_ms)
          OR observed_at IS NOT COALESCE(?, observed_at)
        )
    `);
    const insertSkill = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_skill_events(
        event_key, session_id, profile_slug, skill, command_name, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const summary = { sessions: 0, requests: 0, subagents: 0, skills: 0 };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const session of sessions) {
        const inserted = insertSession.run(
          session.sessionId,
          session.profileSlug,
          session.machine,
          session.cwd ?? null,
          session.gitBranch ?? null,
          session.entrypoint ?? null,
          session.clientVersion ?? null,
          session.firstAt ?? null,
          session.lastAt ?? null,
          session.title ?? null,
          session.titleSource ?? null,
        );
        if (inserted.changes > 0) summary.sessions += 1;
        else {
          const updateValues = [
            session.cwd ?? null,
            session.gitBranch ?? null,
            session.entrypoint ?? null,
            session.clientVersion ?? null,
            session.firstAt ?? null,
            session.firstAt ?? null,
            session.firstAt ?? null,
            session.lastAt ?? null,
            session.lastAt ?? null,
            session.lastAt ?? null,
            session.title ?? null,
            session.titleSource ?? null,
            session.title ?? null,
            session.titleSource ?? null,
            session.titleSource ?? null,
            session.titleSource ?? null,
          ];
          updateSession.run(
            ...updateValues,
            session.sessionId,
            session.profileSlug,
            ...updateValues,
          );
        }
      }
      for (const request of requests) {
        const result = insertRequest.run(
          request.dedupeKey,
          request.requestId ?? null,
          request.sessionId,
          request.profileSlug,
          request.messageId ?? null,
          request.recordUuid ?? null,
          request.model,
          request.effort ?? null,
          request.observedAt,
          request.inputTokens,
          request.cacheCreationInputTokens,
          request.cacheReadInputTokens,
          request.outputTokens,
          request.cacheCreationEphemeral5mInputTokens,
          request.cacheCreationEphemeral1hInputTokens,
          request.isSidechain ? 1 : 0,
          request.agentId ?? null,
        );
        if (result.changes > 0) summary.requests += 1;
      }
      for (const subagent of subagents) {
        const inserted = insertSubagent.run(
          subagent.agentId,
          subagent.sessionId,
          subagent.profileSlug,
          subagent.agentType ?? null,
          subagent.resolvedModel ?? null,
          subagent.totalTokens ?? null,
          subagent.toolStatsJson ?? null,
          subagent.durationMs ?? null,
          subagent.observedAt ?? null,
        );
        if (inserted.changes > 0) summary.subagents += 1;
        else {
          const updateValues = [
            subagent.agentType ?? null,
            subagent.resolvedModel ?? null,
            subagent.totalTokens ?? null,
            subagent.toolStatsJson ?? null,
            subagent.durationMs ?? null,
            subagent.observedAt ?? null,
          ];
          updateSubagent.run(
            ...updateValues,
            subagent.agentId,
            subagent.profileSlug,
            ...updateValues,
          );
        }
      }
      for (const skill of skills) {
        const result = insertSkill.run(
          skill.eventKey,
          skill.sessionId,
          skill.profileSlug,
          skill.skill ?? null,
          skill.commandName ?? null,
          skill.observedAt,
        );
        if (result.changes > 0) summary.skills += 1;
      }
      this.db.exec('COMMIT');
      return summary;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// A Claude session can span one main transcript and several subagent files.
  /// Shrink callers stage the whole group in temporary tables using short
  /// transactions. One synchronous publish then replaces the affected session,
  /// so awaited file reads never own unrelated writes on the shared connection.
  /// This staging design assumes one Store and its single SQLite connection own the reconcile.
  beginTranscriptReconcile(affectedSessions = []) {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS transcript_reconcile_sessions (
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        PRIMARY KEY(session_id, profile_slug)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS transcript_replay_sessions (
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        machine TEXT NOT NULL,
        cwd TEXT,
        git_branch TEXT,
        entrypoint TEXT,
        client_version TEXT,
        first_at TEXT,
        last_at TEXT,
        title TEXT,
        title_source TEXT,
        PRIMARY KEY(session_id, profile_slug)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS transcript_replay_requests (
        dedupe_key TEXT NOT NULL,
        request_id TEXT,
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        message_id TEXT,
        record_uuid TEXT,
        model TEXT NOT NULL,
        effort TEXT,
        observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_ephemeral_5m_input_tokens INTEGER NOT NULL,
        cache_creation_ephemeral_1h_input_tokens INTEGER NOT NULL,
        is_sidechain INTEGER NOT NULL,
        agent_id TEXT,
        PRIMARY KEY(dedupe_key, profile_slug)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS temp.transcript_replay_requests_request_id
        ON transcript_replay_requests(request_id, profile_slug) WHERE request_id IS NOT NULL;
      CREATE TEMP TABLE IF NOT EXISTS transcript_replay_subagents (
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        agent_type TEXT,
        resolved_model TEXT,
        total_tokens INTEGER,
        tool_stats_json TEXT,
        duration_ms INTEGER,
        observed_at TEXT,
        PRIMARY KEY(agent_id, profile_slug)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS transcript_replay_skills (
        event_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        skill TEXT,
        command_name TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(event_key, profile_slug)
      ) WITHOUT ROWID;
    `);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_reconcile_sessions(session_id, profile_slug) VALUES (?, ?)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM transcript_reconcile_sessions;
        DELETE FROM transcript_replay_sessions;
        DELETE FROM transcript_replay_requests;
        DELETE FROM transcript_replay_subagents;
        DELETE FROM transcript_replay_skills;
      `);
      for (const session of affectedSessions) insert.run(session.sessionId, session.profileSlug);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stageTranscriptReplayBatch({ sessions = [], requests = [], subagents = [], skills = [] } = {}) {
    const upsertSession = this.db.prepare(`
      INSERT INTO transcript_replay_sessions(
        session_id, profile_slug, machine, cwd, git_branch, entrypoint,
        client_version, first_at, last_at, title, title_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, profile_slug) DO UPDATE SET
        cwd = COALESCE(excluded.cwd, transcript_replay_sessions.cwd),
        git_branch = COALESCE(excluded.git_branch, transcript_replay_sessions.git_branch),
        entrypoint = COALESCE(excluded.entrypoint, transcript_replay_sessions.entrypoint),
        client_version = COALESCE(excluded.client_version, transcript_replay_sessions.client_version),
        first_at = CASE
          WHEN excluded.first_at IS NULL THEN transcript_replay_sessions.first_at
          WHEN transcript_replay_sessions.first_at IS NULL
            OR excluded.first_at < transcript_replay_sessions.first_at THEN excluded.first_at
          ELSE transcript_replay_sessions.first_at
        END,
        last_at = CASE
          WHEN excluded.last_at IS NULL THEN transcript_replay_sessions.last_at
          WHEN transcript_replay_sessions.last_at IS NULL
            OR excluded.last_at > transcript_replay_sessions.last_at THEN excluded.last_at
          ELSE transcript_replay_sessions.last_at
        END,
        title = CASE
          WHEN excluded.title IS NULL THEN transcript_replay_sessions.title
          WHEN transcript_replay_sessions.title_source = 'custom-title'
            AND excluded.title_source <> 'custom-title' THEN transcript_replay_sessions.title
          ELSE excluded.title
        END,
        title_source = CASE
          WHEN excluded.title_source IS NULL THEN transcript_replay_sessions.title_source
          WHEN transcript_replay_sessions.title_source = 'custom-title'
            AND excluded.title_source <> 'custom-title' THEN transcript_replay_sessions.title_source
          ELSE excluded.title_source
        END
    `);
    const insertRequest = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_replay_requests(
        dedupe_key, request_id, session_id, profile_slug, message_id, record_uuid,
        model, effort, observed_at, input_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
        cache_creation_ephemeral_5m_input_tokens,
        cache_creation_ephemeral_1h_input_tokens, is_sidechain, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertSubagent = this.db.prepare(`
      INSERT INTO transcript_replay_subagents(
        agent_id, session_id, profile_slug, agent_type, resolved_model, total_tokens,
        tool_stats_json, duration_ms, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, profile_slug) DO UPDATE SET
        agent_type = COALESCE(excluded.agent_type, transcript_replay_subagents.agent_type),
        resolved_model = COALESCE(excluded.resolved_model, transcript_replay_subagents.resolved_model),
        total_tokens = COALESCE(excluded.total_tokens, transcript_replay_subagents.total_tokens),
        tool_stats_json = COALESCE(excluded.tool_stats_json, transcript_replay_subagents.tool_stats_json),
        duration_ms = COALESCE(excluded.duration_ms, transcript_replay_subagents.duration_ms),
        observed_at = COALESCE(excluded.observed_at, transcript_replay_subagents.observed_at)
    `);
    const insertSkill = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_replay_skills(
        event_key, session_id, profile_slug, skill, command_name, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const session of sessions) {
        upsertSession.run(
          session.sessionId,
          session.profileSlug,
          session.machine,
          session.cwd ?? null,
          session.gitBranch ?? null,
          session.entrypoint ?? null,
          session.clientVersion ?? null,
          session.firstAt ?? null,
          session.lastAt ?? null,
          session.title ?? null,
          session.titleSource ?? null,
        );
      }
      for (const request of requests) {
        insertRequest.run(
          request.dedupeKey,
          request.requestId ?? null,
          request.sessionId,
          request.profileSlug,
          request.messageId ?? null,
          request.recordUuid ?? null,
          request.model,
          request.effort ?? null,
          request.observedAt,
          request.inputTokens,
          request.cacheCreationInputTokens,
          request.cacheReadInputTokens,
          request.outputTokens,
          request.cacheCreationEphemeral5mInputTokens,
          request.cacheCreationEphemeral1hInputTokens,
          request.isSidechain ? 1 : 0,
          request.agentId ?? null,
        );
      }
      for (const subagent of subagents) {
        upsertSubagent.run(
          subagent.agentId,
          subagent.sessionId,
          subagent.profileSlug,
          subagent.agentType ?? null,
          subagent.resolvedModel ?? null,
          subagent.totalTokens ?? null,
          subagent.toolStatsJson ?? null,
          subagent.durationMs ?? null,
          subagent.observedAt ?? null,
        );
      }
      for (const skill of skills) {
        insertSkill.run(
          skill.eventKey,
          skill.sessionId,
          skill.profileSlug,
          skill.skill ?? null,
          skill.commandName ?? null,
          skill.observedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishTranscriptReconcile() {
    const deleteAffected = this.db.prepare(`
      DELETE FROM transcript_sessions
      WHERE EXISTS (
        SELECT 1 FROM transcript_reconcile_sessions replay
        WHERE replay.session_id = transcript_sessions.session_id
          AND replay.profile_slug = transcript_sessions.profile_slug
      )
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      deleteAffected.run();
      this.db.exec(`
        INSERT INTO transcript_sessions(
          session_id, profile_slug, machine, cwd, git_branch, entrypoint,
          client_version, first_at, last_at, title, title_source
        )
        SELECT
          session_id, profile_slug, machine, cwd, git_branch, entrypoint,
          client_version, first_at, last_at, title, title_source
        FROM transcript_replay_sessions WHERE true
        ON CONFLICT(session_id, profile_slug) DO UPDATE SET
          cwd = COALESCE(excluded.cwd, transcript_sessions.cwd),
          git_branch = COALESCE(excluded.git_branch, transcript_sessions.git_branch),
          entrypoint = COALESCE(excluded.entrypoint, transcript_sessions.entrypoint),
          client_version = COALESCE(excluded.client_version, transcript_sessions.client_version),
          first_at = CASE
            WHEN excluded.first_at IS NULL THEN transcript_sessions.first_at
            WHEN transcript_sessions.first_at IS NULL
              OR excluded.first_at < transcript_sessions.first_at THEN excluded.first_at
            ELSE transcript_sessions.first_at
          END,
          last_at = CASE
            WHEN excluded.last_at IS NULL THEN transcript_sessions.last_at
            WHEN transcript_sessions.last_at IS NULL
              OR excluded.last_at > transcript_sessions.last_at THEN excluded.last_at
            ELSE transcript_sessions.last_at
          END,
          title = CASE
            WHEN excluded.title IS NULL THEN transcript_sessions.title
            WHEN transcript_sessions.title_source = 'custom-title'
              AND excluded.title_source <> 'custom-title' THEN transcript_sessions.title
            ELSE excluded.title
          END,
          title_source = CASE
            WHEN excluded.title_source IS NULL THEN transcript_sessions.title_source
            WHEN transcript_sessions.title_source = 'custom-title'
              AND excluded.title_source <> 'custom-title' THEN transcript_sessions.title_source
            ELSE excluded.title_source
          END;

        INSERT OR IGNORE INTO transcript_requests(
          dedupe_key, request_id, session_id, profile_slug, message_id, record_uuid,
          model, effort, observed_at, input_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
          cache_creation_ephemeral_5m_input_tokens,
          cache_creation_ephemeral_1h_input_tokens, is_sidechain, agent_id
        )
        SELECT
          dedupe_key, request_id, session_id, profile_slug, message_id, record_uuid,
          model, effort, observed_at, input_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
          cache_creation_ephemeral_5m_input_tokens,
          cache_creation_ephemeral_1h_input_tokens, is_sidechain, agent_id
        FROM transcript_replay_requests;

        INSERT INTO transcript_subagents(
          agent_id, session_id, profile_slug, agent_type, resolved_model, total_tokens,
          tool_stats_json, duration_ms, observed_at
        )
        SELECT
          agent_id, session_id, profile_slug, agent_type, resolved_model, total_tokens,
          tool_stats_json, duration_ms, observed_at
        FROM transcript_replay_subagents WHERE true
        ON CONFLICT(agent_id, profile_slug) DO UPDATE SET
          agent_type = COALESCE(excluded.agent_type, transcript_subagents.agent_type),
          resolved_model = COALESCE(excluded.resolved_model, transcript_subagents.resolved_model),
          total_tokens = COALESCE(excluded.total_tokens, transcript_subagents.total_tokens),
          tool_stats_json = COALESCE(excluded.tool_stats_json, transcript_subagents.tool_stats_json),
          duration_ms = COALESCE(excluded.duration_ms, transcript_subagents.duration_ms),
          observed_at = COALESCE(excluded.observed_at, transcript_subagents.observed_at);

        INSERT OR IGNORE INTO transcript_skill_events(
          event_key, session_id, profile_slug, skill, command_name, observed_at
        )
        SELECT event_key, session_id, profile_slug, skill, command_name, observed_at
        FROM transcript_replay_skills;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.cancelTranscriptReconcile();
    }
  }

  cancelTranscriptReconcile() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM transcript_reconcile_sessions;
        DELETE FROM transcript_replay_sessions;
        DELETE FROM transcript_replay_requests;
        DELETE FROM transcript_replay_subagents;
        DELETE FROM transcript_replay_skills;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// Replace one detector's active finding set. A finding keeps one stable row
  /// and advances its revision only when the detector's underlying corpus
  /// fingerprint changes (or a resolved finding becomes active again). That
  /// (id, revision) pair is the generic suppression key for future consumers.
  syncFindings(pathologyKind, findings, { detectedAt = now() } = {}) {
    if (typeof pathologyKind !== 'string' || !pathologyKind.trim()) {
      throw new Error('finding pathology kind must be a non-empty string');
    }
    if (!Array.isArray(findings)) throw new Error('findings must be an array');
    if (typeof detectedAt !== 'string' || !Number.isFinite(Date.parse(detectedAt))) {
      throw new Error('finding detectedAt must be an ISO timestamp');
    }

    const existingById = this.db.prepare('SELECT * FROM findings WHERE id = ?');
    const insert = this.db.prepare(`
      INSERT INTO findings(
        id, pathology_kind, scope_key, corpus_fingerprint, evidence_json,
        revision, active, first_detected_at, last_changed_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, NULL)
    `);
    const reactivate = this.db.prepare(`
      UPDATE findings SET
        corpus_fingerprint = ?, evidence_json = ?, revision = revision + 1,
        active = 1, last_changed_at = ?, resolved_at = NULL
      WHERE id = ?
    `);
    const refreshEvidence = this.db.prepare(`
      UPDATE findings SET evidence_json = ? WHERE id = ?
    `);
    const activeForKind = this.db.prepare(`
      SELECT id FROM findings WHERE pathology_kind = ? AND active = 1
    `);
    const resolve = this.db.prepare(`
      UPDATE findings SET
        active = 0, revision = revision + 1, last_changed_at = ?, resolved_at = ?
      WHERE id = ? AND active = 1
    `);
    const summary = { inserted: 0, updated: 0, resolved: 0, unchanged: 0 };
    const seen = new Set();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const finding of findings) {
        if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
          throw new Error('finding must be a JSON object');
        }
        for (const field of ['id', 'scopeKey', 'corpusFingerprint']) {
          if (typeof finding[field] !== 'string' || !finding[field].trim()) {
            throw new Error(`finding ${field} must be a non-empty string`);
          }
        }
        if (finding.evidence == null || typeof finding.evidence !== 'object' || Array.isArray(finding.evidence)) {
          throw new Error('finding evidence must be a JSON object');
        }
        if (seen.has(finding.id)) throw new Error(`duplicate finding id: ${finding.id}`);
        seen.add(finding.id);
        const evidenceJson = JSON.stringify(finding.evidence);
        const existing = existingById.get(finding.id);
        if (!existing) {
          insert.run(
            finding.id,
            pathologyKind,
            finding.scopeKey,
            finding.corpusFingerprint,
            evidenceJson,
            detectedAt,
            detectedAt,
          );
          summary.inserted += 1;
          continue;
        }
        if (existing.pathology_kind !== pathologyKind || existing.scope_key !== finding.scopeKey) {
          throw new Error(`finding id collision: ${finding.id}`);
        }
        if (existing.active && existing.corpus_fingerprint === finding.corpusFingerprint) {
          if (existing.evidence_json !== evidenceJson) refreshEvidence.run(evidenceJson, finding.id);
          summary.unchanged += 1;
          continue;
        }
        reactivate.run(finding.corpusFingerprint, evidenceJson, detectedAt, finding.id);
        summary.updated += 1;
      }

      for (const row of activeForKind.all(pathologyKind)) {
        if (seen.has(row.id)) continue;
        if (resolve.run(detectedAt, detectedAt, row.id).changes > 0) summary.resolved += 1;
      }
      this.db.exec('COMMIT');
      return summary;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listFindings({ includeResolved = false } = {}) {
    const rows = this.db.prepare(`
      SELECT * FROM findings
      ${includeResolved ? '' : 'WHERE active = 1'}
      ORDER BY active DESC, last_changed_at DESC, pathology_kind, id
    `).all();
    return rows.map((row) => ({
      id: row.id,
      pathologyKind: row.pathology_kind,
      revision: row.revision,
      suppressionKey: `${row.id}:${row.revision}`,
      active: Boolean(row.active),
      evidence: JSON.parse(row.evidence_json),
      firstDetectedAt: row.first_detected_at,
      lastChangedAt: row.last_changed_at,
      resolvedAt: row.resolved_at,
    }));
  }

  /// Attach previously unresolved Claude rows when their raw proxy source now
  /// identifies exactly one account. LIMIT 2 preserves the ingest ambiguity
  /// guard: zero or multiple case-insensitive identity matches remain NULL.
  resolveRequestUsageAccounts() {
    const unresolvedSources = this.db.prepare(`
      SELECT DISTINCT source_raw FROM request_usage
      WHERE account_id IS NULL AND provider = 'claude' AND source_raw IS NOT NULL
    `).all();
    const resolveAccount = this.db.prepare(`
      SELECT id FROM accounts
      WHERE provider = 'claude' AND identity <> '' AND identity = ? COLLATE NOCASE
      ORDER BY id LIMIT 2
    `);
    const resolveRows = this.db.prepare(`
      UPDATE request_usage
      SET account_id = ?, source_raw = NULL
      WHERE account_id IS NULL AND provider = 'claude' AND source_raw = ? COLLATE NOCASE
    `);
    let resolved = 0;
    for (const row of unresolvedSources) {
      const matches = resolveAccount.all(row.source_raw);
      if (matches.length === 1) resolved += resolveRows.run(matches[0].id, row.source_raw).changes;
    }
    return resolved;
  }

  ingestOtelMetrics(records) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO otel_metrics(
        ingest_key, machine, metric_name, observed_at, value, model, effort,
        speed, query_source, agent_name, skill_name, session_id, account_uuid,
        organization_id, token_type, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.#ingestOtel(records, (record) => insert.run(
      record.ingestKey, 'studio', record.metricName, record.observedAt, record.value,
      record.model, record.effort, record.speed, record.querySource, record.agentName,
      record.skillName, record.sessionId, record.accountUuid, record.organizationId,
      record.tokenType, JSON.stringify(record.details || {}),
    ));
  }

  ingestOtelEvents(records) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO otel_events(
        ingest_key, machine, event_name, observed_at, model, effort, speed,
        query_source, agent_name, skill_name, session_id, account_uuid,
        organization_id, token_type, request_id, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.#ingestOtel(records, (record) => insert.run(
      record.ingestKey, 'studio', record.eventName, record.observedAt, record.model,
      record.effort, record.speed, record.querySource, record.agentName, record.skillName,
      record.sessionId, record.accountUuid, record.organizationId, record.tokenType,
      record.requestId, record.inputTokens, record.outputTokens, record.cacheReadTokens,
      record.cacheCreationTokens, record.costUsd, JSON.stringify(record.details || {}),
    ));
  }

  ingestOtelQuarantine(records) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO otel_quarantine(
        ingest_key, received_at, endpoint, reason, raw_json, truncated
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const receivedAt = now();
    return this.#ingestOtel(records, (record) => insert.run(
      record.ingestKey, receivedAt, record.endpoint, record.reason, record.rawJson,
      record.truncated ? 1 : 0,
    ));
  }

  #ingestOtel(records, runInsert) {
    if (!Array.isArray(records)) throw new Error('OTLP records must be an array');
    const summary = { inserted: 0, duplicates: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        const result = runInsert(record);
        if (result.changes === 0) summary.duplicates += 1;
        else summary.inserted += 1;
      }
      this.db.exec('COMMIT');
      return summary;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// Aggregate the request warehouse over a half-open [since, until) range.
  /// One allowlisted grouping is selected per read; no groupBy returns totals
  /// only. Stored timestamps are canonical UTC, so indexed text bounds and
  /// UTC-day grouping agree.
  ///
  /// Issue #344 adds three local-time groupings for the burn timeline — hour,
  /// local_day, and the 24-bucket hour_of_day fold — plus account/model/
  /// provider filters. The filters narrow totals and groups alike, so a
  /// filtered chart always reconciles with the filtered totals it is drawn
  /// beside. The pre-existing UTC `day` grouping is untouched.
  usageSummary({
    since = null, until = null, groupBy = null,
    accountId = null, model = null, provider = null,
  } = {}) {
    since = canonicalSummaryBound(since, 'since');
    until = canonicalSummaryBound(until, 'until');
    if (since && until && since >= until) throw new Error('usage summary since must be earlier than until');
    if (groupBy != null && !USAGE_SUMMARY_GROUPINGS.includes(groupBy)) {
      throw new Error(`usage summary groupBy must be ${USAGE_SUMMARY_GROUPINGS.slice(0, -1).join(', ')}, or ${USAGE_SUMMARY_GROUPINGS.at(-1)}`);
    }
    accountId = usageSummaryFilter(accountId, 'accountId');
    model = usageSummaryFilter(model, 'model');
    provider = usageSummaryFilter(provider, 'provider');
    if (provider != null && !['claude', 'codex'].includes(provider)) {
      throw new Error('usage summary provider must be claude or codex');
    }

    const clauses = [];
    const params = [];
    if (since) { clauses.push('ru.observed_at >= ?'); params.push(since); }
    if (until) { clauses.push('ru.observed_at < ?'); params.push(until); }
    if (accountId) { clauses.push('ru.account_id = ?'); params.push(accountId); }
    if (model) { clauses.push('ru.model = ?'); params.push(model); }
    if (provider) { clauses.push('ru.provider = ?'); params.push(provider); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const aggregates = `
      COUNT(*) AS requests,
      COALESCE(SUM(ru.failed), 0) AS failed,
      COALESCE(SUM(ru.latency_ms), 0) AS latency_ms,
      COALESCE(SUM(ru.ttft_ms), 0) AS ttft_ms,
      COALESCE(SUM(ru.input_uncached), 0) AS input_uncached,
      COALESCE(SUM(ru.input_cache_read), 0) AS input_cache_read,
      COALESCE(SUM(ru.input_cache_write), 0) AS input_cache_write,
      COALESCE(SUM(ru.output_total), 0) AS output_total,
      COALESCE(SUM(ru.output_reasoning), 0) AS output_reasoning,
      COALESCE(SUM(ru.total), 0) AS total
    `;
    // Totals and groups are one logical response. Hold a read snapshot across
    // both SELECTs so a separate ingester connection cannot commit between
    // them and produce totals that disagree with the grouped subtotals.
    this.db.exec('BEGIN');
    try {
      const totals = usageAggregateRow(this.db.prepare(`
        SELECT ${aggregates} FROM request_usage ru ${where}
      `).get(...params));

      let groups = [];
      if (groupBy === 'account') {
        groups = this.db.prepare(`
          SELECT ru.account_id, ru.source_raw, ru.provider, a.label AS account_label, ${aggregates}
          FROM request_usage ru
          LEFT JOIN accounts a ON a.id = ru.account_id
          ${where}
          GROUP BY ru.account_id, ru.source_raw, ru.provider, a.label
          ORDER BY COALESCE(a.label, ru.source_raw, ''), ru.provider, ru.account_id
        `).all(...params).map((row) => {
          const unresolvedSource = row.account_id == null && row.source_raw != null
            ? `unresolved-${crypto.createHash('sha256').update(row.source_raw).digest('hex').slice(0, 8)}`
            : null;
          return {
            accountId: row.account_id,
            accountLabel: row.account_label,
            source: unresolvedSource,
            provider: row.provider,
            ...usageAggregateRow(row),
          };
        });
      } else if (groupBy === 'model_effort') {
        // Issue #345: the one two-dimension grouping — model × reasoning
        // effort. reasoning_effort stays NULL where the wire carried none;
        // the caller classes NULL as its own 'none' tier and never folds it
        // into 'low'. Grouping on the raw columns keeps the cell subtotals
        // summing exactly to totals for the same filters.
        groups = this.db.prepare(`
          SELECT ru.model AS model, ru.reasoning_effort AS reasoning_effort, ${aggregates}
          FROM request_usage ru
          ${where}
          GROUP BY ru.model, ru.reasoning_effort
          ORDER BY ru.model, ru.reasoning_effort IS NULL DESC, ru.reasoning_effort
        `).all(...params).map((row) => ({
          model: row.model,
          reasoningEffort: row.reasoning_effort,
          ...usageAggregateRow(row),
        }));
      } else if (groupBy != null) {
        // Local-time buckets are wall-clock strings with no offset, so the
        // browser parses them straight back into local Date instants and the
        // view never re-derives a timezone. `day` stays UTC for compatibility.
        const dimensions = {
          model: { expression: 'ru.model', output: 'model' },
          reasoning_effort: { expression: 'ru.reasoning_effort', output: 'reasoningEffort' },
          day: { expression: 'substr(ru.observed_at, 1, 10)', output: 'day' },
          local_day: { expression: "strftime('%Y-%m-%d', ru.observed_at, 'localtime')", output: 'localDay' },
          hour: { expression: "strftime('%Y-%m-%dT%H:00', ru.observed_at, 'localtime')", output: 'hour' },
          hour_of_day: {
            expression: "strftime('%H', ru.observed_at, 'localtime')",
            output: 'hourOfDay',
            cast: (value) => Number(value),
          },
        };
        const dimension = dimensions[groupBy];
        groups = this.db.prepare(`
          SELECT ${dimension.expression} AS group_value, ${aggregates}
          FROM request_usage ru
          ${where}
          GROUP BY ${dimension.expression}
          ORDER BY group_value
        `).all(...params).map((row) => ({
          [dimension.output]: dimension.cast ? dimension.cast(row.group_value) : row.group_value,
          ...usageAggregateRow(row),
        }));
      }
      this.db.exec('COMMIT');
      return { totals, groupBy, groups };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /// Issue #347 session explorer. Accounts are keyed by a filesystem profile
  /// REF (an absolute CODEX_HOME / Claude profile directory); transcript and
  /// rollout rows are keyed by that directory's SLUG. Derive the mapping here,
  /// once, and keep the ingest ambiguity guard: a slug claimed by two accounts
  /// resolves to neither, exactly like resolveRequestUsageAccounts().
  accountsByProfileSlug() {
    const bySlug = new Map();
    const ambiguous = new Set();
    for (const row of this.db.prepare('SELECT id, provider, label, profile_ref FROM accounts').all()) {
      const slug = path.basename(String(row.profile_ref || ''));
      if (!slug) continue;
      const key = `${row.provider}:${slug}`;
      if (bySlug.has(key)) { ambiguous.add(key); continue; }
      bySlug.set(key, { accountId: row.id, accountLabel: row.label, slug });
    }
    for (const key of ambiguous) bySlug.delete(key);
    return bySlug;
  }

  /// Rank sessions across every corpus provider by tokens burned in [since, until).
  ///
  /// Membership is "this session had a request/turn inside the range", and the
  /// aggregates then cover the in-range requests only — the same half-open
  /// convention usageSummary() uses, so a leaderboard row reconciles with a
  /// direct warehouse query over the same bounds.
  ///
  /// SUBAGENT TOKENS ARE COUNTED ONCE. A Claude subagent's own requests are
  /// rows in transcript_requests carrying agent_id, so they are already inside
  /// the session total; subagentTokens re-reports that SUBSET and the
  /// transcript_subagents rollup's total_tokens is never added to anything.
  /// (Adding the rollup is the documented ~2× inflation trap.)
  usageSessions({
    since = null, until = null, provider = null, accountId = null, limit = null, project = null,
    includeCorpusOnly = true,
  } = {}) {
    since = canonicalSummaryBound(since, 'since', 'usage sessions');
    until = canonicalSummaryBound(until, 'until', 'usage sessions');
    if (since && until && since >= until) throw new Error('usage sessions since must be earlier than until');
    provider = usageSummaryFilter(provider, 'provider', 'usage sessions');
    if (provider != null && !CORPUS_PROVIDERS.includes(provider)) {
      throw new Error('usage sessions provider must be claude, codex, or grok');
    }
    accountId = usageSummaryFilter(accountId, 'accountId', 'usage sessions');
    // Issue #346: the project-burn drill-down is the same leaderboard narrowed
    // to one project (or to the 'unattributed' bucket), not a second reader.
    project = usageSummaryFilter(project, 'project', 'usage sessions');
    const rowLimit = usageSessionsLimit(limit);

    const accounts = this.accountsByProfileSlug();
    // An account filter narrows to that account's profile slug. An account
    // whose profile ref is not a transcript/rollout profile (or is claimed by
    // two accounts) selects nothing rather than silently widening.
    // The slug alone is not enough: an unrelated profile directory for the
    // OTHER provider may share the same basename, and filtering both tables by
    // the bare slug would mix that profile's sessions into this account's
    // leaderboard. Scope the filter to the account's own provider's table.
    let scopedSlug = null;
    let scopedProvider = null;
    if (accountId) {
      for (const [key, entry] of accounts.entries()) {
        if (entry.accountId === accountId) {
          scopedSlug = entry.slug;
          scopedProvider = key.slice(0, key.indexOf(':'));
          break;
        }
      }
      if (!scopedSlug) {
        return { since, until, provider, accountId, project, limit: rowLimit, truncated: false, sessions: [] };
      }
    }

    const claudeRows = (provider && provider !== 'claude') || (scopedProvider && scopedProvider !== 'claude') ? [] : this.transcriptSessionRows({
      since, until, profileSlug: scopedSlug, project, limit: rowLimit + 1,
    });
    const codexRows = (provider && provider !== 'codex') || (scopedProvider && scopedProvider !== 'codex') ? [] : this.codexSessionRows({
      since, until, profileSlug: scopedSlug, project, limit: rowLimit + 1,
    });
    const grokRows = !includeCorpusOnly || (provider && provider !== 'grok') || scopedProvider
      ? []
      : this.grokSessionRows({
        since, until, profileSlug: scopedSlug, project, limit: rowLimit + 1,
      });
    const merged = [...claudeRows, ...codexRows, ...grokRows].sort(
      (a, b) => b.totalTokens - a.totalTokens || String(b.lastAt).localeCompare(String(a.lastAt)),
    );
    const sessions = merged.slice(0, rowLimit);
    for (const session of sessions) {
      const account = accounts.get(`${session.provider}:${session.profileSlug}`) || null;
      session.accountId = account ? account.accountId : null;
      session.accountLabel = account ? account.accountLabel : null;
    }
    return {
      since,
      until,
      provider,
      accountId,
      project,
      limit: rowLimit,
      truncated: merged.length > sessions.length,
      sessions,
    };
  }

  /// Claude transcript half of the leaderboard. The per-session model, skill
  /// and subagent reads run per returned row (bounded by the limit) so the
  /// leaderboard never fans out over the whole corpus.
  transcriptSessionRows({
    since = null, until = null, profileSlug = null, limit = 1, sessionId = null, project = null,
  } = {}) {
    const clauses = [];
    const params = [];
    if (since) { clauses.push('r.observed_at >= ?'); params.push(since); }
    if (until) { clauses.push('r.observed_at < ?'); params.push(until); }
    if (profileSlug) { clauses.push('s.profile_slug = ?'); params.push(profileSlug); }
    if (sessionId) { clauses.push('s.session_id = ?'); params.push(sessionId); }
    // Issue #346 drill-down: the project burn view asks this same reader for
    // one project's sessions rather than growing a parallel session shape.
    if (project) {
      const predicate = this.projectPredicate('s.cwd', project);
      clauses.push(predicate.sql);
      params.push(...predicate.params);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT s.session_id AS session_id, s.profile_slug AS profile_slug, s.title AS title,
             s.title_source AS title_source, s.cwd AS cwd, s.git_branch AS git_branch,
             MIN(r.observed_at) AS first_at, MAX(r.observed_at) AS last_at,
             COUNT(*) AS requests,
             COALESCE(SUM(${TRANSCRIPT_TOTAL}), 0) AS total_tokens,
             COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
             COALESCE(SUM(${TRANSCRIPT_INPUT}), 0) AS input_tokens,
             COUNT(DISTINCT r.agent_id) AS subagent_count,
             COALESCE(SUM(CASE WHEN r.agent_id IS NOT NULL THEN ${TRANSCRIPT_TOTAL} ELSE 0 END), 0) AS subagent_tokens
      FROM transcript_sessions s
      JOIN transcript_requests r
        ON r.session_id = s.session_id AND r.profile_slug = s.profile_slug
      ${where}
      GROUP BY s.session_id, s.profile_slug
      ORDER BY total_tokens DESC, last_at DESC
      LIMIT ?
    `).all(...params, limit);

    const models = this.db.prepare(`
      SELECT r.model AS model, r.effort AS effort, COUNT(*) AS requests
      FROM transcript_requests r
      WHERE r.session_id = ? AND r.profile_slug = ?
        ${since ? 'AND r.observed_at >= ?' : ''} ${until ? 'AND r.observed_at < ?' : ''}
      GROUP BY r.model, r.effort
      ORDER BY requests DESC, r.model
    `);
    const skills = this.db.prepare(`
      SELECT skill, command_name, COUNT(*) AS events
      FROM transcript_skill_events
      WHERE session_id = ? AND profile_slug = ?
        ${since ? 'AND observed_at >= ?' : ''} ${until ? 'AND observed_at < ?' : ''}
      GROUP BY skill, command_name
      ORDER BY events DESC, skill IS NULL, skill, command_name
    `);
    const bounds = [since, until].filter((value) => value != null);

    return rows.map((row) => {
      const modelRows = models.all(row.session_id, row.profile_slug, ...bounds);
      const skillRows = skills.all(row.session_id, row.profile_slug, ...bounds);
      const identity = projectIdentityOf(row.cwd);
      return {
        provider: 'claude',
        sessionId: row.session_id,
        profileSlug: row.profile_slug,
        title: row.title,
        titleSource: row.title_source,
        cwd: row.cwd,
        project: identity.project,
        worktree: identity.worktree,
        gitBranch: row.git_branch,
        firstAt: row.first_at,
        lastAt: row.last_at,
        requests: Number(row.requests || 0),
        totalTokens: Number(row.total_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        inputTokens: Number(row.input_tokens || 0),
        // Context-size signal: the average input (prompt + cache) a request in
        // this session carried. A big number means a big working context.
        avgInputTokens: sessionAverage(Number(row.input_tokens || 0), Number(row.requests || 0)),
        subagents: Number(row.subagent_count || 0),
        // A SUBSET of totalTokens, never an addition to it.
        subagentTokens: Number(row.subagent_tokens || 0),
        models: modelRows.map((model) => model.model).filter(Boolean),
        efforts: [...new Set(modelRows.map((model) => model.effort).filter(Boolean))],
        skills: skillRows.filter((skill) => skill.skill).map((skill) => skill.skill),
        commands: skillRows.filter((skill) => skill.command_name).map((skill) => skill.command_name),
        archived: null,
      };
    });
  }

  /// Codex rollout half of the leaderboard. Turn totals come from the rollout's
  /// own token_count events, which the ingester already de-duplicates.
  codexSessionRows({
    since = null, until = null, profileSlug = null, limit = 1, sessionId = null, project = null,
  } = {}) {
    // A turn with no timestamp still belongs to its session; fall back to the
    // session's last timestamp so it can never drop out of every range.
    const turnAt = 'COALESCE(t.timestamp, c.last_timestamp)';
    const clauses = [];
    const params = [];
    if (since) { clauses.push(`${turnAt} >= ?`); params.push(since); }
    if (until) { clauses.push(`${turnAt} < ?`); params.push(until); }
    if (profileSlug) { clauses.push('c.profile_slug = ?'); params.push(profileSlug); }
    if (sessionId) { clauses.push('c.session_id = ?'); params.push(sessionId); }
    if (project) {
      const predicate = this.projectPredicate('c.cwd', project);
      clauses.push(predicate.sql);
      params.push(...predicate.params);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT c.session_id AS session_id, c.profile_slug AS profile_slug, c.cwd AS cwd,
             c.git_branch AS git_branch, c.archived AS archived,
             MIN(${turnAt}) AS first_at, MAX(${turnAt}) AS last_at,
             COUNT(*) AS turns,
             COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
             COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
             COALESCE(SUM(${CODEX_INPUT}), 0) AS input_tokens
      FROM codex_sessions c
      JOIN codex_turns t ON t.session_id = c.session_id
      ${where}
      GROUP BY c.session_id
      ORDER BY total_tokens DESC, last_at DESC
      LIMIT ?
    `).all(...params, limit);

    const models = this.db.prepare(`
      SELECT t.model AS model, t.reasoning_effort AS effort, COUNT(*) AS turns
      FROM codex_turns t
      JOIN codex_sessions c ON c.session_id = t.session_id
      WHERE t.session_id = ?
        ${since ? `AND ${turnAt} >= ?` : ''} ${until ? `AND ${turnAt} < ?` : ''}
      GROUP BY t.model, t.reasoning_effort
      ORDER BY turns DESC, t.model
    `);
    const bounds = [since, until].filter((value) => value != null);

    return rows.map((row) => {
      const modelRows = models.all(row.session_id, ...bounds);
      const identity = projectIdentityOf(row.cwd);
      return {
        provider: 'codex',
        sessionId: row.session_id,
        profileSlug: row.profile_slug,
        // Codex rollouts carry no session title; the working directory and git
        // branch are the only human handles, so the view labels them as such.
        title: null,
        titleSource: null,
        cwd: row.cwd,
        project: identity.project,
        worktree: identity.worktree,
        gitBranch: row.git_branch,
        firstAt: row.first_at,
        lastAt: row.last_at,
        requests: Number(row.turns || 0),
        totalTokens: Number(row.total_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        inputTokens: Number(row.input_tokens || 0),
        avgInputTokens: sessionAverage(Number(row.input_tokens || 0), Number(row.turns || 0)),
        // Codex rollouts have no subagent rollups; 0 is a fact here, not a gap.
        subagents: 0,
        subagentTokens: 0,
        models: modelRows.map((model) => model.model).filter(Boolean),
        efforts: [...new Set(modelRows.map((model) => model.effort).filter(Boolean))],
        skills: [],
        commands: [],
        archived: row.archived === 1,
      };
    });
  }

  /// Grok's turn_completed usage is already per-turn rather than cumulative.
  /// Its inputTokens includes the cached/cache-creation subsets, so the
  /// leaderboard uses that reported input directly.
  grokSessionRows({
    since = null, until = null, profileSlug = null, limit = 1, sessionId = null, project = null,
  } = {}) {
    const turnAt = 'COALESCE(t.timestamp, g.last_timestamp)';
    const clauses = [];
    const params = [];
    if (since) { clauses.push(`${turnAt} >= ?`); params.push(since); }
    if (until) { clauses.push(`${turnAt} < ?`); params.push(until); }
    if (profileSlug) { clauses.push('g.profile_slug = ?'); params.push(profileSlug); }
    if (sessionId) { clauses.push('g.session_id = ?'); params.push(sessionId); }
    if (project) {
      const predicate = this.projectPredicate('g.cwd', project);
      clauses.push(predicate.sql);
      params.push(...predicate.params);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT g.session_id AS session_id, g.profile_slug AS profile_slug, g.cwd AS cwd,
             MIN(${turnAt}) AS first_at, MAX(${turnAt}) AS last_at,
             COUNT(*) AS turns,
             COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
             COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
             COALESCE(SUM(t.input_tokens), 0) AS input_tokens
      FROM grok_sessions g
      JOIN grok_turns t ON t.session_id = g.session_id
      ${where}
      GROUP BY g.session_id
      ORDER BY total_tokens DESC, last_at DESC
      LIMIT ?
    `).all(...params, limit);
    const models = this.db.prepare(`
      SELECT m.model AS model, COUNT(*) AS turns
      FROM grok_model_usage m
      JOIN grok_turns t
        ON t.session_id = m.session_id AND t.turn_index = m.turn_index
      JOIN grok_sessions g ON g.session_id = t.session_id
      WHERE m.session_id = ?
        ${since ? `AND ${turnAt} >= ?` : ''} ${until ? `AND ${turnAt} < ?` : ''}
      GROUP BY m.model
      ORDER BY turns DESC, m.model
    `);
    const bounds = [since, until].filter((value) => value != null);
    return rows.map((row) => {
      const modelRows = models.all(row.session_id, ...bounds);
      const identity = projectIdentityOf(row.cwd);
      return {
        provider: 'grok',
        sessionId: row.session_id,
        profileSlug: row.profile_slug,
        title: null,
        titleSource: null,
        cwd: row.cwd,
        project: identity.project,
        worktree: identity.worktree,
        gitBranch: null,
        firstAt: row.first_at,
        lastAt: row.last_at,
        requests: Number(row.turns || 0),
        totalTokens: Number(row.total_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        inputTokens: Number(row.input_tokens || 0),
        avgInputTokens: sessionAverage(Number(row.input_tokens || 0), Number(row.turns || 0)),
        subagents: 0,
        subagentTokens: 0,
        models: modelRows.map((model) => model.model).filter(Boolean),
        efforts: [],
        skills: [],
        commands: [],
        archived: null,
      };
    });
  }

  /// One session in full: its leaderboard row (over the session's whole life,
  /// not a range), the subagent rollup rows with their OWN request aggregates,
  /// the skill/slash-command events, and the context-size trend.
  usageSessionDetail({ sessionId = null, profile = null, provider = null } = {}) {
    sessionId = usageSummaryFilter(sessionId, 'sessionId', 'usage sessions');
    profile = usageSummaryFilter(profile, 'profile', 'usage sessions');
    if (!sessionId) throw new Error('usage sessions sessionId is required');
    if (!profile) throw new Error('usage sessions profile is required');
    provider = usageSummaryFilter(provider, 'provider', 'usage sessions');
    if (provider != null && !CORPUS_PROVIDERS.includes(provider)) {
      throw new Error('usage sessions provider must be claude, codex, or grok');
    }

    const accounts = this.accountsByProfileSlug();
    const claude = provider && provider !== 'claude'
      ? []
      : this.transcriptSessionRows({ sessionId, profileSlug: profile, limit: 1 });
    const codex = (provider && provider !== 'codex') || claude.length
      ? []
      : this.codexSessionRows({ sessionId, profileSlug: profile, limit: 1 });
    const grok = (provider && provider !== 'grok') || claude.length || codex.length
      ? []
      : this.grokSessionRows({ sessionId, profileSlug: profile, limit: 1 });
    const session = claude[0] || codex[0] || grok[0] || null;
    if (!session) return { session: null, subagents: [], skills: [], contextTrend: [], truncated: false };
    const account = accounts.get(`${session.provider}:${session.profileSlug}`) || null;
    session.accountId = account ? account.accountId : null;
    session.accountLabel = account ? account.accountLabel : null;

    const subagents = session.provider !== 'claude' ? [] : this.db.prepare(`
      SELECT sa.agent_id AS agent_id, sa.agent_type AS agent_type, sa.resolved_model AS resolved_model,
             sa.total_tokens AS rollup_total_tokens, sa.tool_stats_json AS tool_stats_json,
             sa.duration_ms AS duration_ms, sa.observed_at AS observed_at,
             COALESCE(SUM(${TRANSCRIPT_TOTAL}), 0) AS total_tokens,
             COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
             COUNT(r.id) AS requests
      FROM transcript_subagents sa
      LEFT JOIN transcript_requests r
        ON r.session_id = sa.session_id AND r.agent_id = sa.agent_id AND r.profile_slug = sa.profile_slug
      WHERE sa.session_id = ? AND sa.profile_slug = ?
      GROUP BY sa.agent_id, sa.profile_slug
      ORDER BY total_tokens DESC, sa.observed_at
    `).all(session.sessionId, session.profileSlug).map((row) => ({
      agentId: row.agent_id,
      agentType: row.agent_type,
      resolvedModel: row.resolved_model,
      // The transcript's own rollup, reported beside the measured sum rather
      // than added to it: the session total already contains these requests.
      rollupTotalTokens: row.rollup_total_tokens == null ? null : Number(row.rollup_total_tokens),
      totalTokens: Number(row.total_tokens || 0),
      outputTokens: Number(row.output_tokens || 0),
      requests: Number(row.requests || 0),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      observedAt: row.observed_at,
      toolStats: row.tool_stats_json == null ? null : row.tool_stats_json,
    }));

    const skills = session.provider !== 'claude' ? [] : this.db.prepare(`
      SELECT skill, command_name, COUNT(*) AS events,
             MIN(observed_at) AS first_at, MAX(observed_at) AS last_at
      FROM transcript_skill_events
      WHERE session_id = ? AND profile_slug = ?
      GROUP BY skill, command_name
      ORDER BY events DESC, skill IS NULL, skill, command_name
    `).all(session.sessionId, session.profileSlug).map((row) => ({
      skill: row.skill,
      commandName: row.command_name,
      events: Number(row.events || 0),
      firstAt: row.first_at,
      lastAt: row.last_at,
    }));

    let trendRows;
    if (session.provider === 'claude') {
      trendRows = this.db.prepare(`
        SELECT r.observed_at AS observed_at, r.model AS model, r.agent_id AS agent_id,
               ${TRANSCRIPT_INPUT} AS input_tokens, r.output_tokens AS output_tokens,
               ${TRANSCRIPT_TOTAL} AS total_tokens
        FROM transcript_requests r
        WHERE r.session_id = ? AND r.profile_slug = ?
        ORDER BY r.observed_at
        LIMIT ?
      `).all(session.sessionId, session.profileSlug, USAGE_SESSION_TREND_LIMIT + 1);
    } else if (session.provider === 'codex') {
      trendRows = this.db.prepare(`
        SELECT t.timestamp AS observed_at, t.model AS model, NULL AS agent_id,
               ${CODEX_INPUT} AS input_tokens, t.output_tokens AS output_tokens,
               t.total_tokens AS total_tokens
        FROM codex_turns t
        WHERE t.session_id = ?
        ORDER BY t.turn_index
        LIMIT ?
      `).all(session.sessionId, USAGE_SESSION_TREND_LIMIT + 1);
    } else {
      trendRows = this.db.prepare(`
        SELECT t.timestamp AS observed_at,
               (SELECT m.model FROM grok_model_usage m
                WHERE m.session_id = t.session_id AND m.turn_index = t.turn_index
                ORDER BY m.input_tokens + m.output_tokens DESC, m.model LIMIT 1) AS model,
               NULL AS agent_id, t.input_tokens AS input_tokens,
               t.output_tokens AS output_tokens, t.total_tokens AS total_tokens
        FROM grok_turns t
        WHERE t.session_id = ?
        ORDER BY t.turn_index
        LIMIT ?
      `).all(session.sessionId, USAGE_SESSION_TREND_LIMIT + 1);
    }

    const truncated = trendRows.length > USAGE_SESSION_TREND_LIMIT;
    const contextTrend = trendRows.slice(0, USAGE_SESSION_TREND_LIMIT).map((row, index) => ({
      index,
      observedAt: row.observed_at,
      model: row.model,
      agentId: row.agent_id,
      inputTokens: Number(row.input_tokens || 0),
      outputTokens: Number(row.output_tokens || 0),
      totalTokens: Number(row.total_tokens || 0),
    }));
    return { session, subagents, skills, contextTrend, truncated };
  }

  subagentTypesForSessions(pairs = []) {
    if (!pairs.length) return new Map();
    const placeholders = pairs.map(() => '(?, ?)').join(', ');
    const params = pairs.flatMap(({ sessionId, profileSlug }) => [sessionId, profileSlug]);
    const rows = this.db.prepare(`
      WITH requested(session_id, profile_slug) AS (VALUES ${placeholders})
      SELECT sa.session_id, sa.profile_slug, sa.agent_type
      FROM transcript_subagents sa
      JOIN requested r
        ON r.session_id = sa.session_id AND r.profile_slug = sa.profile_slug
      WHERE sa.agent_type IS NOT NULL
      GROUP BY sa.session_id, sa.profile_slug, sa.agent_type
    `).all(...params);
    const result = new Map(pairs.map(({ sessionId, profileSlug }) => [`${sessionId}\u001f${profileSlug}`, []]));
    for (const row of rows) result.get(`${row.session_id}\u001f${row.profile_slug}`).push(row.agent_type);
    return result;
  }

  /// Supported anatomy read: four cuts of the same ordered session rows, so
  /// totals, timeline, composition, context curve, and cache inputs reconcile.
  /// Codex exposes only the cuts its rollout schema records and says so in
  /// supports; turns are never mislabeled as provider requests.
  sessionAnatomy({
    sessionId = null, profile = null, provider = null,
    maxBuckets = SESSION_ANATOMY_MAX_BUCKETS, curveLimit = SESSION_ANATOMY_CURVE_LIMIT,
  } = {}) {
    sessionId = usageSummaryFilter(sessionId, 'sessionId', 'session anatomy');
    profile = usageSummaryFilter(profile, 'profile', 'session anatomy');
    if (!sessionId) throw new Error('session anatomy sessionId is required');
    if (!profile) throw new Error('session anatomy profile is required');
    provider = usageSummaryFilter(provider, 'provider', 'session anatomy');
    if (provider != null && !CORPUS_PROVIDERS.includes(provider)) {
      throw new Error('session anatomy provider must be claude, codex, or grok');
    }
    const claude = provider && provider !== 'claude'
      ? []
      : this.transcriptSessionRows({ sessionId, profileSlug: profile, limit: 1 });
    const codex = (provider && provider !== 'codex') || claude.length
      ? []
      : this.codexSessionRows({ sessionId, profileSlug: profile, limit: 1 });
    const grok = (provider && provider !== 'grok') || claude.length || codex.length
      ? []
      : this.grokSessionRows({ sessionId, profileSlug: profile, limit: 1 });
    const session = claude[0] || codex[0] || grok[0] || null;
    if (!session) return {
      session: null, supports: null, totals: null, timeline: null,
      composition: [], compositionTruncated: false, compositionTotal: 0,
      curve: [], curveStride: 1, events: { skills: [], launches: [] }, truncated: false,
    };
    const isClaude = session.provider === 'claude';
    let read;
    if (isClaude) {
      read = this.db.prepare(`
        SELECT observed_at AS at, model, effort, agent_id, input_tokens AS fresh,
               cache_creation_input_tokens AS write, cache_read_input_tokens AS read, output_tokens AS out
        FROM transcript_requests WHERE session_id = ? AND profile_slug = ?
        ORDER BY observed_at, id LIMIT ?
      `).all(session.sessionId, session.profileSlug, SESSION_ANATOMY_ROW_LIMIT + 1);
    } else if (session.provider === 'codex') {
      read = this.db.prepare(`
        SELECT COALESCE(t.timestamp, c.last_timestamp) AS at, t.model, t.reasoning_effort AS effort,
               NULL AS agent_id, ${CODEX_INPUT_UNCACHED} AS fresh, t.cache_write_input_tokens AS write,
               t.cached_input_tokens AS read, t.output_tokens AS out, t.total_tokens AS reported
        FROM codex_turns t JOIN codex_sessions c ON c.session_id = t.session_id
        WHERE t.session_id = ? ORDER BY t.turn_index LIMIT ?
      `).all(session.sessionId, SESSION_ANATOMY_ROW_LIMIT + 1);
    } else {
      read = this.db.prepare(`
        SELECT COALESCE(t.timestamp, g.last_timestamp) AS at,
               (SELECT m.model FROM grok_model_usage m
                WHERE m.session_id = t.session_id AND m.turn_index = t.turn_index
                ORDER BY m.input_tokens + m.output_tokens DESC, m.model LIMIT 1) AS model,
               NULL AS effort, NULL AS agent_id,
               MAX(0, t.input_tokens - t.cached_read_tokens - t.cache_creation_tokens) AS fresh,
               t.cache_creation_tokens AS write, t.cached_read_tokens AS read,
               t.output_tokens AS out, t.total_tokens AS reported
        FROM grok_turns t JOIN grok_sessions g ON g.session_id = t.session_id
        WHERE t.session_id = ? ORDER BY t.turn_index LIMIT ?
      `).all(session.sessionId, SESSION_ANATOMY_ROW_LIMIT + 1);
    }
    const truncated = read.length > SESSION_ANATOMY_ROW_LIMIT;
    const rows = read.slice(0, SESSION_ANATOMY_ROW_LIMIT);
    const rollupRead = isClaude ? this.db.prepare(`
      SELECT agent_id, agent_type, resolved_model, total_tokens, duration_ms, observed_at, tool_stats_json,
             COUNT(*) OVER () AS total_count
      FROM transcript_subagents WHERE session_id = ? AND profile_slug = ?
      ORDER BY observed_at, agent_id
      LIMIT ?
    `).all(session.sessionId, session.profileSlug, SESSION_ANATOMY_SUBAGENT_LIMIT) : [];
    const rollupTotal = Number(rollupRead[0]?.total_count || 0);
    const compositionTruncated = rollupTotal > rollupRead.length;
    const rollups = rollupRead;
    const skillRows = isClaude ? this.db.prepare(`
      SELECT skill, command_name, observed_at FROM transcript_skill_events
      WHERE session_id = ? AND profile_slug = ? ORDER BY observed_at LIMIT ?
    `).all(session.sessionId, session.profileSlug, SESSION_ANATOMY_EVENT_LIMIT) : [];

    const totals = {
      requests: 0, tokens: 0, inputUncached: 0, inputCacheWrite: 0, inputCacheRead: 0, output: 0,
      reportedTokens: 0, mainRequests: 0, mainTokens: 0, laneRequests: 0, laneTokens: 0,
      contextSum: 0, contextMax: 0,
    };
    const parts = new Map();
    const ensurePart = (agentId) => {
      const key = agentId || '__main';
      if (!parts.has(key)) parts.set(key, {
        key, kind: agentId ? 'lane' : 'main', agentId: agentId || null, agentType: null,
        resolvedModel: null, rollupTotalTokens: null, durationMs: null, toolStats: null,
        requests: 0, tokens: 0, inputUncached: 0, inputCacheWrite: 0, inputCacheRead: 0,
        output: 0, firstAt: null, lastAt: null, modelCounts: new Map(),
      });
      return parts.get(key);
    };
    ensurePart(null);
    const firstMs = rows.length ? Date.parse(rows[0].at) : Date.parse(session.firstAt);
    const lastMs = rows.reduce((latest, row) => Math.max(latest, Date.parse(row.at) || 0), firstMs || 0);
    const durationMs = Math.max(0, lastMs - firstMs);
    let bucketMs = SESSION_ANATOMY_BUCKETS.find((size) => durationMs / size <= maxBuckets) || SESSION_ANATOMY_BUCKETS.at(-1);
    const bucketSizeClamped = durationMs / bucketMs > maxBuckets;
    if (bucketSizeClamped) bucketMs = Math.ceil(durationMs / maxBuckets);
    const firstDate = new Date(firstMs || Date.now());
    const anchor = bucketSizeClamped
      ? firstMs
      : new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate()).getTime();
    const buckets = new Map();
    const ensureBucket = (index) => {
      if (!buckets.has(index)) buckets.set(index, {
        index, startMs: anchor + index * bucketMs, requests: 0, tokens: 0, mainTokens: 0, laneTokens: 0,
        inputUncached: 0, inputCacheWrite: 0, inputCacheRead: 0, output: 0,
        contextSum: 0, contextMax: 0, skills: 0, launches: 0,
      });
      return buckets.get(index);
    };
    const bucketIndex = (at) => {
      const index = Math.floor(((Date.parse(at) || firstMs || 0) - anchor) / bucketMs);
      return bucketSizeClamped ? Math.min(index, maxBuckets - 1) : index;
    };
    const curveStride = Math.max(1, Math.ceil(rows.length / curveLimit));
    const curve = [];
    rows.forEach((row, index) => {
      const fresh = Number(row.fresh || 0);
      const write = Number(row.write || 0);
      const readTokens = Number(row.read || 0);
      const output = Number(row.out || 0);
      const tokens = fresh + write + readTokens + output;
      const context = fresh + write + readTokens;
      const agentId = isClaude ? row.agent_id : null;
      totals.requests += 1; totals.tokens += tokens; totals.inputUncached += fresh;
      totals.reportedTokens += isClaude ? tokens : Number(row.reported || 0);
      totals.inputCacheWrite += write; totals.inputCacheRead += readTokens; totals.output += output;
      totals.contextSum += context; totals.contextMax = Math.max(totals.contextMax, context);
      if (agentId) { totals.laneRequests += 1; totals.laneTokens += tokens; }
      else { totals.mainRequests += 1; totals.mainTokens += tokens; }
      const part = ensurePart(agentId);
      part.requests += 1; part.tokens += tokens; part.inputUncached += fresh; part.inputCacheWrite += write;
      part.inputCacheRead += readTokens; part.output += output; part.firstAt ||= row.at; part.lastAt = row.at;
      if (row.model) part.modelCounts.set(row.model, (part.modelCounts.get(row.model) || 0) + 1);
      const bucket = ensureBucket(bucketIndex(row.at));
      bucket.requests += 1; bucket.tokens += tokens; bucket.inputUncached += fresh; bucket.inputCacheWrite += write;
      bucket.inputCacheRead += readTokens; bucket.output += output; bucket.contextSum += context;
      bucket.contextMax = Math.max(bucket.contextMax, context);
      if (agentId) bucket.laneTokens += tokens; else bucket.mainTokens += tokens;
      if (index % curveStride === 0) curve.push({ i: index, at: row.at, context, output, lane: agentId ? 1 : 0, model: row.model || null });
    });
    let lanesWithoutRequests = 0;
    for (const row of rollups) {
      const part = ensurePart(row.agent_id);
      part.agentType = row.agent_type; part.resolvedModel = row.resolved_model;
      part.rollupTotalTokens = row.total_tokens == null ? null : Number(row.total_tokens);
      part.durationMs = row.duration_ms == null ? null : Number(row.duration_ms);
      part.toolStats = row.tool_stats_json; part.firstAt ||= row.observed_at; part.lastAt ||= row.observed_at;
      if (!part.requests) lanesWithoutRequests += 1;
    }
    const composition = [...parts.values()].map((part) => {
      const models = [...part.modelCounts].sort((left, right) => right[1] - left[1]).map(([model]) => model);
      const { modelCounts, ...payload } = part;
      return { ...payload, models, model: models[0] || part.resolvedModel || null };
    }).sort((left, right) => (left.kind === 'main' ? -1 : right.kind === 'main' ? 1 : right.tokens - left.tokens));
    const skills = skillRows.map((row) => ({ at: row.observed_at, name: row.skill || row.command_name, kind: row.skill ? 'skill' : 'command' }));
    // Events outside the request span remain in the event list but cannot widen its request timeline.
    const inRequestSpan = (at) => {
      const timestamp = Date.parse(at);
      return Number.isFinite(timestamp) && timestamp >= firstMs && timestamp <= lastMs;
    };
    for (const event of skills) if (inRequestSpan(event.at)) ensureBucket(bucketIndex(event.at)).skills += 1;
    const launches = composition.filter((part) => part.kind === 'lane' && part.firstAt).map((part) => ({
      at: part.firstAt, agentId: part.agentId, agentType: part.agentType, tokens: part.tokens, requests: part.requests,
    })).sort((left, right) => left.at.localeCompare(right.at));
    for (const launch of launches) if (inRequestSpan(launch.at)) ensureBucket(bucketIndex(launch.at)).launches += 1;
    const indexes = [...buckets.keys()].sort((left, right) => left - right);
    const timeline = [];
    if (indexes.length) for (let index = indexes[0]; index <= indexes.at(-1); index += 1) {
      const bucket = ensureBucket(index);
      timeline.push({ ...bucket, key: localBucketKey(new Date(bucket.startMs)) });
    }
    return {
      session,
      supports: {
        timeline: true, curve: true, cache: true, cacheRate: isClaude, unit: isClaude ? 'request' : 'turn',
        composition: isClaude, skillEvents: isClaude, laneLaunches: isClaude,
        agentTypes: isClaude && composition.some((part) => part.kind === 'lane' && part.agentType),
        note: isClaude ? null : `${session.provider === 'codex' ? 'Codex rollouts' : 'Grok updates'} record turns only — no subagent or skill records exist to dissect. `
          + 'tokens is the displayed token-class sum; reportedTokens preserves the provider total without reinterpreting it.',
      },
      totals: { ...totals, lanes: composition.filter((part) => part.kind === 'lane').length, lanesWithoutRequests, durationMs, firstAt: firstMs ? new Date(firstMs).toISOString() : session.firstAt, lastAt: lastMs ? new Date(lastMs).toISOString() : session.lastAt },
      timeline: { bucketMs, buckets: timeline }, composition,
      compositionTruncated, compositionTotal: rollupTotal + 1, curve, curveStride,
      events: { skills, launches }, truncated,
    };
  }

  /// Claude half of the project-burn fold: transcript requests grouped by the
  /// project (session cwd), branch, and profile they were recorded under.
  ///
  /// COMPOSITE KEY: the session join and the distinct-session count both carry
  /// (session_id, profile_slug) together. The same session id under two
  /// profiles is two different sessions; mixing them is this repo's recurring
  /// defect class. The LEFT JOIN is deliberate — a request whose session row is
  /// missing must surface in the unattributed bucket, never vanish.
  transcriptProjectRows({ since = null, until = null, project = null } = {}) {
    const clauses = [];
    const params = [];
    if (since) { clauses.push('r.observed_at >= ?'); params.push(since); }
    if (until) { clauses.push('r.observed_at < ?'); params.push(until); }
    if (project) {
      const predicate = this.projectPredicate('s.cwd', project);
      clauses.push(predicate.sql);
      params.push(...predicate.params);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // char(31) is the ASCII unit separator: it cannot occur in a session id or
    // a profile slug, so the concatenated key is a faithful tuple.
    return this.db.prepare(`
      SELECT s.cwd AS cwd, s.git_branch AS git_branch, r.profile_slug AS profile_slug,
             COUNT(*) AS requests,
             COUNT(DISTINCT r.session_id || char(31) || r.profile_slug) AS sessions,
             COALESCE(SUM(r.input_tokens), 0) AS input_uncached,
             COALESCE(SUM(r.cache_read_input_tokens), 0) AS input_cache_read,
             COALESCE(SUM(r.cache_creation_input_tokens), 0) AS input_cache_write,
             COALESCE(SUM(r.output_tokens), 0) AS output_total,
             0 AS reasoning_tokens,
             COALESCE(SUM(${TRANSCRIPT_TOTAL}), 0) AS total_tokens,
             MIN(r.observed_at) AS first_at, MAX(r.observed_at) AS last_at
      FROM transcript_requests r
      LEFT JOIN transcript_sessions s
        ON s.session_id = r.session_id AND s.profile_slug = r.profile_slug
      ${where}
      GROUP BY s.cwd, s.git_branch, r.profile_slug
    `).all(...params).map((row) => ({
      provider: 'claude',
      cwd: row.cwd,
      gitBranch: row.git_branch,
      profileSlug: row.profile_slug,
      firstAt: row.first_at,
      lastAt: row.last_at,
      // Claude transcripts record no reasoning-token split, so reasoningTokens
      // is 0 here as a stated absence rather than an inferred number.
      aggregate: projectBurnAggregate(row),
    }));
  }

  /// Codex half of the fold. Turn totals are the rollout's own token_count
  /// figures (never re-derived), and an undated turn falls back to its
  /// session's last timestamp — the same convention the session explorer uses,
  /// so a turn can never drop out of every range.
  codexProjectRows({ since = null, until = null, project = null } = {}) {
    const turnAt = 'COALESCE(t.timestamp, c.last_timestamp)';
    const clauses = [];
    const params = [];
    if (since) { clauses.push(`${turnAt} >= ?`); params.push(since); }
    if (until) { clauses.push(`${turnAt} < ?`); params.push(until); }
    if (project) {
      const predicate = this.projectPredicate('c.cwd', project);
      clauses.push(predicate.sql);
      params.push(...predicate.params);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT c.cwd AS cwd, c.git_branch AS git_branch, c.profile_slug AS profile_slug,
             COUNT(*) AS requests,
             COUNT(DISTINCT t.session_id) AS sessions,
             COALESCE(SUM(${CODEX_INPUT_UNCACHED}), 0) AS input_uncached,
             COALESCE(SUM(t.cached_input_tokens), 0) AS input_cache_read,
             COALESCE(SUM(t.cache_write_input_tokens), 0) AS input_cache_write,
             COALESCE(SUM(t.output_tokens), 0) AS output_total,
             COALESCE(SUM(t.reasoning_output_tokens), 0) AS reasoning_tokens,
             COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
             MIN(${turnAt}) AS first_at, MAX(${turnAt}) AS last_at
      FROM codex_turns t
      LEFT JOIN codex_sessions c ON c.session_id = t.session_id
      ${where}
      GROUP BY c.cwd, c.git_branch, c.profile_slug
    `).all(...params).map((row) => ({
      provider: 'codex',
      cwd: row.cwd,
      gitBranch: row.git_branch,
      profileSlug: row.profile_slug,
      firstAt: row.first_at,
      lastAt: row.last_at,
      aggregate: projectBurnAggregate(row),
    }));
  }

  /// Issue #371: model × reasoning effort, FILTERABLE BY PROJECT.
  ///
  /// usageSummary's `model_effort` grouping reads the proxy warehouse, which
  /// records no project and whose request_id ↔ transcript bridge measured a 0%
  /// join (FINDINGS-336.md) — so a project filter cannot be honoured there at
  /// all. This reader measures the SESSION corpus instead (transcript_requests
  /// for Claude, codex_turns for Codex), which is the same universe the project
  /// treemap and the drill partition. That is what lets a cell be apportioned
  /// out of the figure the level above printed rather than becoming a second,
  /// disagreeing absolute.
  ///
  /// An unrecorded effort stays NULL — the wire carried none, and inventing a
  /// bucket for it would put tokens in a column no request was made under.
  modelEffortBurn({ since = null, until = null, provider = null, project = null } = {}) {
    since = canonicalSummaryBound(since, 'since', 'model effort burn');
    until = canonicalSummaryBound(until, 'until', 'model effort burn');
    if (since && until && since >= until) {
      throw new Error('model effort burn since must be earlier than until');
    }
    provider = usageSummaryFilter(provider, 'provider', 'model effort burn');
    if (provider != null && !['claude', 'codex'].includes(provider)) {
      throw new Error('model effort burn provider must be claude or codex');
    }
    project = usageSummaryFilter(project, 'project', 'model effort burn');

    const claude = () => {
      const clauses = [];
      const params = [];
      if (since) { clauses.push('r.observed_at >= ?'); params.push(since); }
      if (until) { clauses.push('r.observed_at < ?'); params.push(until); }
      if (project) {
        const predicate = this.projectPredicate('s.cwd', project);
        clauses.push(predicate.sql);
        params.push(...predicate.params);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return this.db.prepare(`
        SELECT r.model AS model, r.effort AS effort,
               COUNT(*) AS requests,
               COALESCE(SUM(${TRANSCRIPT_TOTAL}), 0) AS total_tokens,
               COALESCE(SUM(${TRANSCRIPT_INPUT}), 0) AS input_tokens,
               COALESCE(SUM(r.output_tokens), 0) AS output_tokens
        FROM transcript_requests r
        LEFT JOIN transcript_sessions s
          ON s.session_id = r.session_id AND s.profile_slug = r.profile_slug
        ${where}
        GROUP BY r.model, r.effort
      `).all(...params).map((row) => ({ provider: 'claude', ...row }));
    };

    const codex = () => {
      const turnAt = 'COALESCE(t.timestamp, c.last_timestamp)';
      const clauses = [];
      const params = [];
      if (since) { clauses.push(`${turnAt} >= ?`); params.push(since); }
      if (until) { clauses.push(`${turnAt} < ?`); params.push(until); }
      if (project) {
        const predicate = this.projectPredicate('c.cwd', project);
        clauses.push(predicate.sql);
        params.push(...predicate.params);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return this.db.prepare(`
        SELECT t.model AS model, t.reasoning_effort AS effort,
               COUNT(*) AS requests,
               COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
               COALESCE(SUM(${CODEX_INPUT}), 0) AS input_tokens,
               COALESCE(SUM(t.output_tokens), 0) AS output_tokens
        FROM codex_turns t
        LEFT JOIN codex_sessions c ON c.session_id = t.session_id
        ${where}
        GROUP BY t.model, t.reasoning_effort
      `).all(...params).map((row) => ({ provider: 'codex', ...row }));
    };

    // Both halves under one read snapshot, like projectBurn: an ingester
    // committing between them would produce cells that do not sum to the totals
    // reported beside them.
    this.db.exec('BEGIN');
    let rows;
    try {
      rows = [
        ...(provider === 'codex' ? [] : claude()),
        ...(provider === 'claude' ? [] : codex()),
      ];
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const totals = { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 };
    const cells = rows.map((row) => {
      const cell = {
        provider: row.provider,
        model: row.model,
        effort: row.effort,
        requests: Number(row.requests || 0),
        totalTokens: Number(row.total_tokens || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
      };
      totals.requests += cell.requests;
      totals.totalTokens += cell.totalTokens;
      totals.inputTokens += cell.inputTokens;
      totals.outputTokens += cell.outputTokens;
      return cell;
    });
    cells.sort((a, b) => b.totalTokens - a.totalTokens
      || String(a.model).localeCompare(String(b.model))
      || String(a.effort).localeCompare(String(b.effort)));
    return { since, until, provider, project, cells, totals };
  }

  /// Per-project burn OVER TIME, in local-time buckets — the same offset-free
  /// wall-clock keys the burn timeline uses, so the browser parses them back
  /// into local instants without re-deriving a timezone. One row is one
  /// project × one bucket; the unattributed bucket is a project key like any
  /// other, so an idle-looking project can never be an accounting hole.
  projectBurnSeries({ since = null, until = null, provider = null, project = null, bucket = null } = {}) {
    const expression = PROJECT_BURN_BUCKETS[bucket];
    if (!expression) {
      throw new Error(`project burn bucket must be ${Object.keys(PROJECT_BURN_BUCKETS).join(' or ')}`);
    }
    const rows = [];
    // Both provider halves read under one snapshot, like projectBurn: an
    // ingest committing between them would make series points disagree with
    // the leaderboard totals they are reconciled against.
    this.db.exec('BEGIN');
    try {
    if (provider !== 'codex') {
      const clauses = [];
      const params = [];
      if (since) { clauses.push('r.observed_at >= ?'); params.push(since); }
      if (until) { clauses.push('r.observed_at < ?'); params.push(until); }
      if (project) {
        const predicate = this.projectPredicate('s.cwd', project);
        clauses.push(predicate.sql);
        params.push(...predicate.params);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      rows.push(...this.db.prepare(`
        SELECT s.cwd AS cwd, ${expression('r.observed_at')} AS bucket,
               COUNT(*) AS requests,
               COALESCE(SUM(${TRANSCRIPT_TOTAL}), 0) AS total_tokens,
               COALESCE(SUM(r.output_tokens), 0) AS output_total
        FROM transcript_requests r
        LEFT JOIN transcript_sessions s
          ON s.session_id = r.session_id AND s.profile_slug = r.profile_slug
        ${where}
        GROUP BY s.cwd, bucket
      `).all(...params));
    }
    if (provider !== 'claude') {
      const turnAt = 'COALESCE(t.timestamp, c.last_timestamp)';
      const clauses = [];
      const params = [];
      if (since) { clauses.push(`${turnAt} >= ?`); params.push(since); }
      if (until) { clauses.push(`${turnAt} < ?`); params.push(until); }
      if (project) {
        const predicate = this.projectPredicate('c.cwd', project);
        clauses.push(predicate.sql);
        params.push(...predicate.params);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      rows.push(...this.db.prepare(`
        SELECT c.cwd AS cwd, ${expression(turnAt)} AS bucket,
               COUNT(*) AS requests,
               COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
               COALESCE(SUM(t.output_tokens), 0) AS output_total
        FROM codex_turns t
        LEFT JOIN codex_sessions c ON c.session_id = t.session_id
        ${where}
        GROUP BY c.cwd, bucket
      `).all(...params));
    }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const rollups = trackedProjectRollups(this.listProjects());
    const folded = new Map();
    for (const row of rows) {
      const identity = projectIdentityOf(row.cwd, rollups);
      const key = identity.key;
      const cell = `${key}\n${row.bucket}`;
      if (!folded.has(cell)) {
        folded.set(cell, {
          key,
          project: identity.project,
          unattributed: key === PROJECT_BURN_UNATTRIBUTED,
          bucket: row.bucket,
          requests: 0,
          totalTokens: 0,
          outputTotal: 0,
        });
      }
      const entry = folded.get(cell);
      entry.requests += Number(row.requests || 0);
      entry.totalTokens += Number(row.total_tokens || 0);
      entry.outputTotal += Number(row.output_total || 0);
    }
    return [...folded.values()].sort(
      (a, b) => String(a.bucket).localeCompare(String(b.bucket)) || a.key.localeCompare(b.key),
    );
  }

  /// Issue #346 (decision 10b): burn by PROJECT over the half-open range
  /// [since, until), across both providers, with a per-project account
  /// breakdown the window-burn estimate model can be applied to.
  ///
  /// UNIVERSE. Project identity is derived from the session's cwd; an exact
  /// ModelDeck worktree root folds to its parent checkout while worktree and
  /// git branch remain secondary detail. The proxy warehouse behind
  /// usageSummary() records no project,
  /// and the request_id ↔ transcript requestId bridge measured a 0% join on
  /// the available history (FINDINGS-336.md), so per-request attribution of
  /// warehouse rows is not available. This reader therefore measures the
  /// SESSION token universe — transcript_requests for Claude, codex_turns for
  /// Codex — and reports the warehouse's own totals for the identical bounds
  /// beside it in `reconciliation`, instead of implying the two universes are
  /// one number.
  ///
  /// NOTHING IS DROPPED. Rows whose session carries no cwd (or, defensively,
  /// no session row at all) land in the explicit 'unattributed' bucket, and
  /// projects past `limit` are summed into `remainder` with their count. The
  /// reader's own totals always equal attributed + unattributed, and equal
  /// the sum of the returned projects plus the remainder.
  projectBurn({
    since = null, until = null, provider = null, project = null, limit = null, bucket = null,
  } = {}) {
    since = canonicalSummaryBound(since, 'since', 'project burn');
    until = canonicalSummaryBound(until, 'until', 'project burn');
    if (since && until && since >= until) throw new Error('project burn since must be earlier than until');
    provider = usageSummaryFilter(provider, 'provider', 'project burn');
    if (provider != null && !['claude', 'codex'].includes(provider)) {
      throw new Error('project burn provider must be claude or codex');
    }
    project = usageSummaryFilter(project, 'project', 'project burn');
    bucket = usageSummaryFilter(bucket, 'bucket', 'project burn');
    if (bucket != null && !Object.hasOwn(PROJECT_BURN_BUCKETS, bucket)) {
      throw new Error(`project burn bucket must be ${Object.keys(PROJECT_BURN_BUCKETS).join(' or ')}`);
    }
    const rowLimit = projectBurnLimit(limit);

    // Read the proxy warehouse FIRST: usageSummary owns its own read snapshot,
    // and nesting transactions is neither needed nor allowed here.
    const warehouse = this.usageSummary({ since, until, provider });
    const accounts = this.accountsByProfileSlug();
    const rollups = trackedProjectRollups(this.listProjects());

    // Both halves under one read snapshot, so an ingester committing between
    // them cannot produce project rows that disagree with the totals.
    this.db.exec('BEGIN');
    let rows;
    try {
      rows = [
        ...(provider === 'codex' ? [] : this.transcriptProjectRows({ since, until, project })),
        ...(provider === 'claude' ? [] : this.codexProjectRows({ since, until, project })),
      ];
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const folded = new Map();
    const totals = emptyProjectBurnAggregate();
    for (const row of rows) {
      const identity = projectIdentityOf(row.cwd, rollups);
      const key = identity.key;
      if (!folded.has(key)) {
        folded.set(key, {
          key,
          project: identity.project,
          unattributed: key === PROJECT_BURN_UNATTRIBUTED,
          providers: new Set(),
          branches: new Map(),
          accounts: new Map(),
          aggregate: emptyProjectBurnAggregate(),
          firstAt: null,
          lastAt: null,
        });
      }
      const entry = folded.get(key);
      entry.providers.add(row.provider);
      entry.firstAt = earlier(entry.firstAt, row.firstAt);
      entry.lastAt = later(entry.lastAt, row.lastAt);
      addProjectBurnAggregate(entry.aggregate, row.aggregate);
      addProjectBurnAggregate(totals, row.aggregate);

      const branchKey = JSON.stringify([row.provider, row.gitBranch, identity.worktree]);
      if (!entry.branches.has(branchKey)) {
        entry.branches.set(branchKey, {
          provider: row.provider,
          gitBranch: row.gitBranch,
          worktree: identity.worktree,
          aggregate: emptyProjectBurnAggregate(),
        });
      }
      addProjectBurnAggregate(entry.branches.get(branchKey).aggregate, row.aggregate);

      // Account attribution runs through the profile slug, exactly like the
      // session explorer: a slug claimed by two accounts resolves to neither.
      const account = accounts.get(`${row.provider}:${row.profileSlug}`) || null;
      const accountKey = `${row.provider}:${row.profileSlug}`;
      if (!entry.accounts.has(accountKey)) {
        entry.accounts.set(accountKey, {
          provider: row.provider,
          profileSlug: row.profileSlug,
          accountId: account ? account.accountId : null,
          accountLabel: account ? account.accountLabel : null,
          aggregate: emptyProjectBurnAggregate(),
        });
      }
      addProjectBurnAggregate(entry.accounts.get(accountKey).aggregate, row.aggregate);
    }

    const byBurn = (a, b) => b.aggregate.totalTokens - a.aggregate.totalTokens
      || b.aggregate.requests - a.aggregate.requests;
    const ordered = [...folded.values()].sort((a, b) => byBurn(a, b) || a.key.localeCompare(b.key));
    const visible = ordered.slice(0, rowLimit);
    const remainderProjects = ordered.slice(rowLimit);
    const remainderAggregate = remainderProjects.reduce(
      (target, entry) => addProjectBurnAggregate(target, entry.aggregate),
      emptyProjectBurnAggregate(),
    );

    const attributed = emptyProjectBurnAggregate();
    const unattributed = emptyProjectBurnAggregate();
    for (const entry of ordered) {
      addProjectBurnAggregate(entry.unattributed ? unattributed : attributed, entry.aggregate);
    }

    const projects = visible.map((entry) => ({
      key: entry.key,
      project: entry.project,
      unattributed: entry.unattributed,
      providers: [...entry.providers].sort(),
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      branches: [...entry.branches.values()]
        .sort((a, b) => byBurn(a, b)
          || String(a.gitBranch).localeCompare(String(b.gitBranch))
          || String(a.worktree).localeCompare(String(b.worktree)))
        .map((branch) => ({
          provider: branch.provider,
          gitBranch: branch.gitBranch,
          worktree: branch.worktree,
          ...projectBurnPayload(branch.aggregate),
        })),
      accounts: [...entry.accounts.values()]
        .sort((a, b) => byBurn(a, b) || a.profileSlug.localeCompare(b.profileSlug))
        .map((account) => ({
          provider: account.provider,
          profileSlug: account.profileSlug,
          accountId: account.accountId,
          accountLabel: account.accountLabel,
          ...projectBurnPayload(account.aggregate),
        })),
      ...projectBurnPayload(entry.aggregate),
    }));

    // This drill-down is the wire-provider subset of the session leaderboard.
    // Project burn is reconciled against a warehouse that does not carry
    // corpus-only providers yet, so Grok stays in context/session APIs without
    // receiving a share of Claude/Codex subscription burn here.
    const sessions = project == null
      ? null
      : this.usageSessions({
        since, until, provider, project, limit: rowLimit, includeCorpusOnly: false,
      });
    const series = bucket == null
      ? null
      : this.projectBurnSeries({ since, until, provider, project, bucket });

    return {
      range: { since, until, endExclusive: true },
      provider,
      project,
      bucket,
      series,
      limit: rowLimit,
      projects,
      truncated: remainderProjects.length > 0,
      remainder: remainderProjects.length
        ? { projects: remainderProjects.length, ...projectBurnPayload(remainderAggregate) }
        : null,
      totals: projectBurnPayload(totals),
      sessions,
      reconciliation: {
        attributed: projectBurnPayload(attributed),
        unattributed: projectBurnPayload(unattributed),
        sessionTotals: projectBurnPayload(totals),
        // The proxy-observed universe for the SAME bounds and provider filter,
        // straight from usageSummary. It is reported, not reconciled away:
        // these two universes overlap in reality but cannot be joined per
        // request (FINDINGS-336.md), so the difference is stated, not hidden.
        warehouse: { ...warehouse.totals },
        requestLevelJoinAvailable: false,
        note: 'Project burn is measured from session records (Claude transcripts, Codex rollouts). '
          + 'The proxy request warehouse carries no project, and the per-request join to transcripts '
          + 'measured 0% on the available history, so warehouse totals are reported beside these '
          + 'figures rather than attributed to a project.',
      },
    };
  }

  getSettings() {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE id = 1').get();
    const stored = JSON.parse(row?.value_json || '{}');
    const settings = { ...DEFAULT_SETTINGS };
    for (const [key, value] of Object.entries(stored)) {
      try { validateSetting(key, value); settings[key] = value; }
      catch { /* Ignore invalid persisted values and retain the typed default. */ }
    }
    return settings;
  }

  validateSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be a JSON object');
    for (const [key, value] of Object.entries(input)) validateSetting(key, value);
  }

  saveSettings(input) {
    this.validateSettings(input);
    const current = this.getSettings();
    const settings = { ...current, ...input };
    // Issue #90 change-event provenance. The flag is one-way: it turns true
    // when this write CHANGES the interval or when the app asserts an
    // explicit user selection (autoRefreshIntervalCustomized: true in the
    // patch), and it NEVER turns back false — an echoed full document
    // (every key present, values unchanged) therefore cannot set it, and a
    // stray `false` cannot clear it.
    settings.autoRefreshIntervalCustomized = current.autoRefreshIntervalCustomized
      || input.autoRefreshIntervalCustomized === true
      || (input.autoRefreshIntervalSeconds != null
        && input.autoRefreshIntervalSeconds !== current.autoRefreshIntervalSeconds);
    this.db.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(settings), now());
    return settings;
  }

  getConfigLintFacts() {
    let row;
    try { row = this.db.prepare('SELECT value_json, updated_at FROM config_lint_facts WHERE id = 1').get(); }
    catch (error) {
      if (/no such table: config_lint_facts/i.test(error?.message || '')) {
        return { installedCliVersions: {}, claudeWeeklyFingerprints: {}, updatedAt: null };
      }
      throw error;
    }
    let stored = {};
    try { stored = JSON.parse(row?.value_json || '{}'); }
    catch { /* A malformed fact row is unavailable, never guessed. */ }
    const installed = stored?.installedCliVersions;
    const fingerprints = stored?.claudeWeeklyFingerprints;
    return {
      installedCliVersions: Object.fromEntries(
        Object.entries(installed && typeof installed === 'object' && !Array.isArray(installed) ? installed : {})
          .filter(([provider, version]) => ['claude', 'codex'].includes(provider)
            && typeof version === 'string' && version.trim()),
      ),
      claudeWeeklyFingerprints: Object.fromEntries(
        Object.entries(fingerprints && typeof fingerprints === 'object' && !Array.isArray(fingerprints) ? fingerprints : {})
          .filter(([accountId, value]) => accountId && Number.isSafeInteger(value)),
      ),
      updatedAt: row?.updated_at || null,
    };
  }

  saveConfigLintFacts(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('config lint facts must be an object');
    const current = this.getConfigLintFacts();
    const next = {
      installedCliVersions: input.installedCliVersions ?? current.installedCliVersions,
      claudeWeeklyFingerprints: input.claudeWeeklyFingerprints ?? current.claudeWeeklyFingerprints,
    };
    const validated = {
      installedCliVersions: Object.fromEntries(
        Object.entries(next.installedCliVersions || {}).filter(([provider, version]) => (
          ['claude', 'codex'].includes(provider) && typeof version === 'string' && version.trim()
        )),
      ),
      claudeWeeklyFingerprints: Object.fromEntries(
        Object.entries(next.claudeWeeklyFingerprints || {}).filter(([accountId, value]) => (
          accountId && Number.isSafeInteger(value)
        )),
      ),
    };
    const updatedAt = now();
    this.db.prepare(`
      INSERT INTO config_lint_facts(id, value_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(validated), updatedAt);
    return { ...validated, updatedAt };
  }

  // --- Client key map (issue #520, design §2.1/§2.2, decision 0036 D1) ---

  // The last report generation applied, 0 before any report.
  clientKeyMapGeneration() {
    const row = this.db.prepare('SELECT generation FROM client_key_map_state WHERE id = 1').get();
    return row ? Number(row.generation) : 0;
  }

  clientKeyMapEntries() {
    return this.db.prepare('SELECT * FROM client_key_map ORDER BY key_sha256').all().map((row) => ({
      keySha256: row.key_sha256,
      profileId: row.profile_id,
      profileLabel: row.profile_label,
      createdAt: row.created_at,
    }));
  }

  // Resolve a hashed client key to its profile, or null. Unknown keys
  // resolve to null so attribution stays honest (design §2.2) — an unknown
  // key value, raw or hashed, is never stored or logged by the caller.
  clientKeyProfile(keySha256) {
    const row = this.db.prepare('SELECT * FROM client_key_map WHERE key_sha256 = ?').get(String(keySha256 || ''));
    if (!row) return null;
    return { profileId: row.profile_id, profileLabel: row.profile_label };
  }

  // Apply one app report as an ATOMIC FULL REPLACEMENT (design §2.1).
  //
  // Entries absent from the report are deleted, so a rotation or a profile
  // removal takes effect at this report and a removed key thereafter
  // resolves to honest NULL. The generation is checked INSIDE the same
  // transaction that writes, so two racing reports cannot interleave into a
  // mixed state: a report at or below the applied generation is rejected
  // (replay, out-of-order delivery) and changes nothing.
  //
  // Entries are pre-validated by the caller (ModelDeckService.reportClientKeys);
  // this method owns atomicity and the generation gate only.
  replaceClientKeyMap({ generation, entries, maximumGenerationJump = Infinity }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const applied = this.clientKeyMapGeneration();
      // A report may move the ratchet forward, not teleport it (CodeRabbit,
      // PR #529). Checked here rather than in the caller because `applied` is
      // only authoritative inside this transaction. A refusal is not fatal:
      // the app's resync adopts the real generation and retries from there.
      if (generation > applied + maximumGenerationJump) {
        this.db.exec('ROLLBACK');
        return {
          applied: false,
          reason: 'generation-jump-refused',
          generation: applied,
          entries: this.clientKeyMapEntries().length,
        };
      }
      if (!(generation > applied)) {
        this.db.exec('ROLLBACK');
        // Nothing was written; the caller reports the mapping as it stands.
        return {
          applied: false,
          reason: 'stale-generation',
          generation: applied,
          entries: this.clientKeyMapEntries().length,
        };
      }
      this.db.prepare('DELETE FROM client_key_map').run();
      const insert = this.db.prepare(`
        INSERT INTO client_key_map(key_sha256, profile_id, profile_label, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const at = now();
      for (const entry of entries) insert.run(entry.keySha256, entry.profileId, entry.profileLabel, at);
      this.db.prepare(`
        INSERT INTO client_key_map_state(id, generation, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at
      `).run(generation, at);
      this.db.exec('COMMIT');
      return { applied: true, generation, entries: entries.length };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordLaunch({ accountId, projectId, provider, commandPreview, dryRun = false }) {
    this.db.prepare(`
      INSERT INTO launch_events(account_id, project_id, provider, command_preview, launched_at, dry_run)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(accountId || null, projectId || null, provider, commandPreview, now(), dryRun ? 1 : 0);
  }

  recentLaunches(limit = 20) {
    return this.db.prepare(`
      SELECT l.*, a.label AS account_label, p.name AS project_name
      FROM launch_events l
      LEFT JOIN accounts a ON a.id=l.account_id
      LEFT JOIN projects p ON p.id=l.project_id
      ORDER BY l.id DESC LIMIT ?
    `).all(limit).map((row) => ({
      id: row.id,
      provider: row.provider,
      accountId: row.account_id,
      accountLabel: row.account_label,
      projectId: row.project_id,
      projectName: row.project_name,
      commandPreview: row.command_preview,
      launchedAt: row.launched_at,
      dryRun: Boolean(row.dry_run),
    }));
  }

  state() {
    return {
      accounts: this.listAccounts(),
      projects: this.listProjects(),
      usage: this.latestUsage(),
      launches: this.recentLaunches(),
    };
  }
}
