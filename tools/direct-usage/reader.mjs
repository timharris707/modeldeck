// Direct usage reader (#834): what Claude Code itself reported about an
// account's plan limits, read on the machine where the account is signed in.
//
// Sources, both documented by Anthropic and both handed over by Claude Code:
//   - T3 conversations (Agent SDK): the `rate_limit_event` message, which T3
//     saves in ~/.t3/userdata/logs/provider/*.log. Each line names the T3
//     entry; T3's settings.json gives that entry's account folder.
//   - terminal `claude`: the status line payload's `rate_limits`, which
//     statusline.mjs saves per folder under ~/.cache/modeldeck/direct-usage/
//     terminal/ (#838).
//
// Safety contract: this file never opens a credential file or the Keychain
// and never makes a network call. From each account folder's .claude.json it
// keeps only the account uuid and plan name. It is self-contained (Node
// built-ins only) so the Studio's page can pipe it over SSH:
//   ssh host 'MD_DIRECT_READER_MAIN=1 node --input-type=module' < reader.mjs
// It prints one JSON object. A small cache under ~/.cache/modeldeck lets each
// run read only new log bytes; MD_DIRECT_NO_CACHE=1 reads everything and
// writes nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const READER_VERSION = 1;
const DAY = 86_400_000;
export const KEEP_MS = 8 * DAY;          // a weekly window plus a day
export const MAX_READINGS = 4000;
const CHUNK = 8 * 1024 * 1024;
const LINE_HEAD = /^\[([^\]]{10,40})\] [A-Z]{1,12}: /;
const INSTANCE = /provider-instance:([A-Za-z0-9._-]{1,80})/;
const WINDOWS = [['seven_day', 'weekly'], ['five_hour', '5-hour']];

export function defaultPaths(home = os.homedir(), env = process.env) {
  const t3 = env.MD_T3_USERDATA || path.join(home, '.t3', 'userdata');
  return {
    accountsDir: env.MD_CLAUDE_ACCOUNTS_DIR || path.join(home, '.claude-accounts'),
    t3Settings: path.join(t3, 'settings.json'),
    t3Logs: path.join(t3, 'logs', 'provider'),
    cacheFile: path.join(home, '.cache', 'modeldeck', 'direct-usage', 'state.json'),
    terminalDir: path.join(home, '.cache', 'modeldeck', 'direct-usage', 'terminal'),
  };
}

// The account folders: every directory under ~/.claude-accounts whose
// .claude.json names an account. Only identity-free display fields leave.
export function readFolders(accountsDir) {
  let names;
  // No accounts folder means no direct sign-ins; any other failure must reach
  // the page as a failed read, so it keeps its last cards and warns (#834 review).
  try { names = fs.readdirSync(accountsDir, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const folders = [];
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const f = folderAccount(path.join(accountsDir, d.name), d.name);
    if (f) folders.push(f);
  }
  return folders.sort((a, b) => a.folder.localeCompare(b.folder));
}

// One account folder's identity-free display fields, or null.
function folderAccount(dir, folder) {
  let oauth;
  try { oauth = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).oauthAccount; } catch { return null; }
  if (!oauth || typeof oauth.accountUuid !== 'string') return null;
  return {
    folder,
    accountUuid: oauth.accountUuid,
    plan: typeof oauth.planDisplayName === 'string' ? oauth.planDisplayName : null,
    rateLimitTier: typeof oauth.organizationRateLimitTier === 'string' ? oauth.organizationRateLimitTier : null,
  };
}

// #853: account folders outside the accounts directory that a terminal capture
// names by absolute path (agent homes). Their account is read at read time,
// like every other folder's, so a reading stays with the account that made it.
export function captureFolders(terminalDir, known) {
  let names;
  try { names = fs.readdirSync(terminalDir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(terminalDir, name), 'utf8')); } catch { continue; }
    if (typeof c?.dir !== 'string' || !path.isAbsolute(c.dir) || `${c.folder}.json` !== name
      || path.basename(c.dir).replace(/^\.+/, '') !== c.folder || known.has(c.folder)) continue;
    const f = folderAccount(c.dir, c.folder);
    if (f) { out.push(f); known.add(c.folder); }
  }
  return out;
}

// T3 entry name -> account folder name, for entries whose folder sits
// directly under the accounts directory. Other entries (the retired pool,
// the default home) map to nothing and their lines are ignored.
export function readEntryFolders(t3Settings, accountsDir) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(t3Settings, 'utf8')); } catch { return new Map(); }
  const map = new Map();
  for (const [entry, inst] of Object.entries(settings?.providerInstances || {})) {
    const env = Array.isArray(inst?.environment) ? inst.environment : [];
    const dir = inst?.config?.homePath
      || env.find((e) => e?.name === 'CLAUDE_CONFIG_DIR')?.value
      || env.find((e) => e?.name === 'CLAUDE_SECURESTORAGE_CONFIG_DIR')?.value;
    if (typeof dir !== 'string') continue;
    const resolved = path.resolve(dir.replace(/^~(?=\/)/, os.homedir()));
    if (path.dirname(resolved) === path.resolve(accountsDir)) map.set(entry, path.basename(resolved));
  }
  return map;
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
// An out-of-range reset is no reset, never a thrown read (#838 review).
const isoSec = (s) => {
  const at = finite(s) != null && s > 0 ? new Date(s * 1000) : null;
  return at && Number.isFinite(at.getTime()) ? at.toISOString() : null;
};

// One saved log line -> readings, or null when it is not a rate-limit event.
// utilization is a fraction (0.86 = 86% used); resetsAt is epoch seconds.
export function readingsFromLine(line, entryFolders, uuidOf = new Map()) {
  if (!line.includes('"rate_limit_event"')) return null;
  const head = LINE_HEAD.exec(line);
  if (!head) return null;
  let rec;
  try { rec = JSON.parse(line.slice(head[0].length)); } catch { return null; }
  const payload = rec?.event?.payload;
  if (payload?.type !== 'rate_limit_event' || !payload.rate_limit_info) return null;
  const entry = INSTANCE.exec(String(rec.providerSessionId || ''))?.[1];
  const folder = entry && entryFolders.get(entry);
  const observedMs = Date.parse(head[1]);
  if (!folder || Number.isNaN(observedMs)) return [];
  const info = payload.rate_limit_info;
  const out = [];
  for (const [key, scope] of WINDOWS) {
    let w = info.unifiedWindows?.[key];
    if (!w && info.rateLimitType === key) w = { utilization: info.utilization, resetsAt: info.resetsAt, status: info.status };
    const used = finite(w?.utilization);
    if (used == null) continue;
    out.push({
      folder, accountUuid: uuidOf.get(folder) ?? null, entry, source: 't3', scope,
      usedPercent: Math.round(used * 1000) / 10,
      resetsAt: isoSec(w.resetsAt),
      status: typeof w.status === 'string' ? w.status : null,
      observedAt: new Date(observedMs).toISOString(),
    });
  }
  return out;
}

// An assistant message on a mapped entry: proof the conversation reached
// Claude, so a rate-limit event should exist somewhere in the same file.
export function activityFromLine(line, entryFolders) {
  if (!line.includes('"payload":{"type":"assistant"')) return null;
  const head = LINE_HEAD.exec(line);
  const entry = INSTANCE.exec(line)?.[1];
  if (!head || !entry || !entryFolders.has(entry)) return null;
  const at = Date.parse(head[1]);
  return Number.isNaN(at) ? null : { at, folder: entryFolders.get(entry) };
}

// #838: the terminal status line's last capture per folder -> readings. Each
// capture names the account it was made under; percent is already 0-100.
export function readTerminal(terminalDir) {
  let names;
  try { names = fs.readdirSync(terminalDir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(terminalDir, name), 'utf8')); } catch { continue; }
    if (c?.v !== 1 || typeof c.folder !== 'string' || `${c.folder}.json` !== name
      || typeof c.accountUuid !== 'string' || Number.isNaN(Date.parse(c.observedAt))) continue;
    for (const [key, scope] of WINDOWS) {
      const used = finite(c.windows?.[key]?.used_percentage);
      if (used == null || used < 0 || used > 100) continue;
      out.push({
        folder: c.folder, accountUuid: c.accountUuid, entry: null, source: 'terminal', scope,
        usedPercent: Math.round(used * 10) / 10,
        resetsAt: isoSec(c.windows[key].resets_at),
        status: null,
        observedAt: new Date(Date.parse(c.observedAt)).toISOString(),
      });
    }
  }
  return out;
}

function loadCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c?.v === READER_VERSION && c.files && Array.isArray(c.readings) && c.activity) return c;
  } catch { /* absent or unreadable: start over */ }
  return { v: READER_VERSION, files: {}, readings: [], activity: {} };
}

function saveCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Read a log file from `offset`, calling onLine for each complete line.
// Returns the offset just past the last complete line.
function readNewLines(file, offset, size, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        onLine(data.toString('utf8', start, nl));
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    return pos - carry.length;
  } finally {
    fs.closeSync(fd);
  }
}

export function collect({ paths = defaultPaths(), now = Date.now(), useCache = true } = {}) {
  const cache = useCache ? loadCache(paths.cacheFile) : loadCache('');
  const folders = readFolders(paths.accountsDir);
  folders.push(...captureFolders(paths.terminalDir, new Set(folders.map((f) => f.folder))));
  const uuidOf = new Map(folders.map((f) => [f.folder, f.accountUuid]));
  const entryFolders = readEntryFolders(paths.t3Settings, paths.accountsDir);
  let logNames = [];
  let t3Logs = true;
  try { logNames = fs.readdirSync(paths.t3Logs).filter((n) => n.endsWith('.log')); } catch { t3Logs = false; }

  const seen = new Set();
  for (const name of logNames) {
    const file = path.join(paths.t3Logs, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    seen.add(name);
    let prev = cache.files[name];
    if (prev && (prev.ino !== st.ino || st.size < prev.offset)) prev = null; // rotated or rewritten
    if (!prev && now - st.mtimeMs > KEEP_MS) { cache.files[name] = { ino: st.ino, offset: st.size }; continue; }
    const offset = prev?.offset ?? 0;
    if (st.size === offset) continue;
    try {
      const next = readNewLines(file, offset, st.size, (line) => {
        const rs = readingsFromLine(line, entryFolders, uuidOf);
        if (rs) {
          for (const r of rs) cache.readings.push(r);
          if (rs.length) (cache.activity[name] ||= { at: 0, folder: rs[0].folder, reading: 0 }).reading = Date.parse(rs[0].observedAt);
          return;
        }
        const act = activityFromLine(line, entryFolders);
        if (act) {
          const a = (cache.activity[name] ||= { at: 0, folder: act.folder, reading: 0 });
          a.at = Math.max(a.at, act.at);
          a.folder = act.folder;
        }
      });
      cache.files[name] = { ino: st.ino, offset: next };
    } catch { /* unreadable now; try again next run */ }
  }
  for (const name of Object.keys(cache.files)) if (!seen.has(name)) delete cache.files[name];
  for (const r of readTerminal(paths.terminalDir)) cache.readings.push(r);

  const cutoff = now - KEEP_MS;
  const keyOf = (r) => `${r.folder}|${r.scope}|${r.source}|${r.observedAt}|${r.usedPercent}`;
  const unique = new Map();
  for (const r of cache.readings) if (Date.parse(r.observedAt) >= cutoff) unique.set(keyOf(r), r);
  // The cap trims history, never a window's latest reading (#834 review).
  const sorted = [...unique.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const latest = new Map(sorted.map((r) => [`${r.folder}|${r.scope}`, r]));
  const kept = new Set(sorted.slice(-MAX_READINGS));
  for (const r of latest.values()) kept.add(r);
  cache.readings = sorted.filter((r) => kept.has(r));
  for (const [name, a] of Object.entries(cache.activity)) {
    if (Math.max(a.at, a.reading) < cutoff) delete cache.activity[name];
  }
  if (useCache) {
    try { saveCache(paths.cacheFile, cache); } catch { /* read-only home: still answer */ }
  }

  // Format tripwire: conversations that reached Claude in the last day
  // whose log has no rate-limit event at all. Every conversation sends one
  // with its first reply, so a run of these means T3 changed its log.
  const dayAgo = now - DAY;
  const active = Object.values(cache.activity).filter((a) => a.at >= dayAgo);
  const silent = active.filter((a) => !a.reading);
  return {
    v: READER_VERSION,
    readAt: new Date(now).toISOString(),
    folders,
    // A folder signed in to another account since a reading drops that
    // reading: it belongs to the old account (#834 review).
    readings: cache.readings.filter((r) => r.accountUuid && r.accountUuid === uuidOf.get(r.folder)),
    health: {
      t3Logs,
      t3Entries: entryFolders.size,
      conversationsLastDay: active.length,
      withoutReadingLastDay: silent.length,
      formatWarning: active.length >= 2 && silent.length === active.length,
    },
  };
}

function startedAsScript() {
  if (process.env.MD_DIRECT_READER_MAIN === '1') return true;
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
const isMain = startedAsScript();
if (isMain) {
  process.stdout.write(`${JSON.stringify(collect({ useCache: process.env.MD_DIRECT_NO_CACHE !== '1' }))}\n`);
}
