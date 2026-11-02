// Phone Deck — read-only phone and tablet usage page.
//
// GET-only daemon reads: by default the M1 locally and the M5 over SSH;
// SOURCES=local reads only this host's daemon, with no SSH or pool directory scan.
// /api/deck projects display fields; /api/status reports cached source health
// and, on the pool host, each member's weight and sign-in state under a
// one-way identity tag for remote Macs' decks (#827).
// Identity fields are omitted and sensitive display-text patterns are redacted
// (see README). No provider calls, refreshes, sign-ins or credential writes.
//
//   node tools/phone-deck/server.mjs            (binds 127.0.0.1:3871)
//   PORT=3871 HOSTS=127.0.0.1 node .../server.mjs
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isIP } from 'node:net';
import { validateConfig } from './config.mjs';
import { poolCredentialDetail, poolMemberTag } from '../../src/pool-member-tag.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3871);
const HOSTS = (process.env.HOSTS || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
const HERE = new URL('./', import.meta.url);
const MARKS = new URL('../../macos/ModelDeckMac/Sources/ModelDeckMacCore/Resources/', import.meta.url);
const POOL_AUTH_DIR = join(homedir(), '.config/cliproxyapi/auth');
const M5_HOST = process.env.M5_HOST || 'm5'; // overridable only to test the asleep path

const STATE_TTL = 60_000;          // upstream state cache
const FORECAST_TTL = 5 * 60_000;
const HISTORY_TTL = 10 * 60_000;
const M5_RETRY = 2 * 60_000;       // after a failed M5 read, wait this long before trying again
const STALE_AFTER = 10 * 60_000;   // Mac app: 2x its 5-minute fallback refresh interval
export const DOWN_AFTER = 5 * 60_000;     // one slow answer isn't "asleep": banner only after this long without a good read

// ---------- the Mac app's window rules (macos/.../DeckPopoverModel.swift) ----------

const isSpend = (scope) => scope.toLowerCase().includes('spend');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// DeckBuilder.knownTitle: the deck's name for a daemon scope, or null when the
// deck has no title for that kind (codenames like "nimbus quill").
export function knownTitle(scope) {
  const lower = scope.toLowerCase();
  if (['5h', '5hr', '5-hour', 'five_hour', 'session'].includes(lower)) return '5-hour limit';
  if (['week', 'weekly', '7d'].includes(lower)) return 'Weekly · all models';
  if (lower === 'spend') return 'Spend';
  if (['month', 'monthly', '30d'].includes(lower)) return 'Monthly · all models';
  if (lower === 'usage period') return 'Usage period';
  for (const sep of [':', '_', '-', ' ']) {
    if (lower.startsWith(`week${sep}`)) {
      const model = scope.slice(4 + sep.length);
      if (model) return `Weekly · ${cap(model)}`;
    }
  }
  for (const sep of [' ', '_', '-']) {
    if (lower.endsWith(`${sep}weekly`)) {
      const model = scope.slice(0, scope.length - 6 - sep.length);
      if (model && !isSpend(model)) return `Weekly · ${cap(model)}`;
    }
  }
  return null;
}
export const windowTitle = (scope) => knownTitle(scope) ?? scope;

// DeckBuilder.windowRank: 5-hour, then the whole-pool weekly, then model
// windows; spend is always last.
export function windowRank(scope) {
  if (isSpend(scope)) return 3;
  const t = windowTitle(scope);
  if (t === '5-hour limit') return 0;
  if (t === 'Weekly · all models' || t === 'Monthly · all models' || t === 'Usage period') return 1;
  return 2;
}

export function windowDurationMs(scope, detailMins) {
  if (detailMins > 0) return detailMins * 60_000;
  const t = windowTitle(scope);
  if (t === '5-hour limit') return 5 * 3_600_000;
  if (t.startsWith('Weekly · ')) return 7 * 86_400_000;
  const m = scope.toLowerCase().match(/(\d+)[ -]minute$/);
  return m ? Number(m[1]) * 60_000 : null;
}

// WindowPresentation.anchor: a fresh, untouched window reports a placeholder
// reset ("Starts on first use"); a just-rolled window gets a rollover note.
export function anchorOf(remaining, resetsAt, observedAt, duration, now) {
  if (!duration || remaining == null) return { kind: 'anchored' };
  const used = 100 - remaining;
  if (resetsAt == null) return used <= 0.05 ? { kind: 'unanchored' } : { kind: 'anchored' };
  if (used <= 0.05) {
    if (observedAt == null) return { kind: 'unanchored' };
    if (Math.abs(resetsAt - observedAt - duration) <= 5 * 60_000) return { kind: 'unanchored' };
  }
  if (used <= 1) {
    const rolledAt = resetsAt - duration;
    const age = now - rolledAt;
    if (age > 0 && age <= Math.min(duration / 4, 3 * 3_600_000)) return { kind: 'rolled', rolledAt };
  }
  return { kind: 'anchored' };
}

// IdleRollforward.notice: the stored window has provably ended since it was read.
export function idleNotice(scope, anchor, resetsAt, observedAt, now) {
  if (isSpend(scope) || anchor.kind !== 'anchored' || resetsAt == null || observedAt == null) return null;
  if (!(observedAt < resetsAt && resetsAt <= now)) return null;
  const t = windowTitle(scope);
  if (t === '5-hour limit') return '5-hour window reset since last use';
  if (t.startsWith('Weekly · ')) return 'Weekly window reset since last use';
  return 'Window reset since last use';
}

export function spendText(spend) {
  if (!spend || !(spend.limitMinor > 0) || spend.usedMinor == null || !spend.currency) return null;
  const div = 10 ** (spend.exponent ?? 2);
  try {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: spend.currency });
    return `${f.format(spend.usedMinor / div)} of ${f.format(spend.limitMinor / div)}`;
  } catch { return null; }
}

export function severity(remaining) {
  if (remaining == null) return 'unknown';
  if (remaining <= 10) return 'critical';
  if (remaining <= 25) return 'warning';
  return 'healthy';
}

// DeckBuilder.isMeaninglessWindow + isUnusedCodexModelWindow.
export function hidden(w, provider) {
  if (w.spend) {
    if (w.resetsAt != null || w.spendText) return false;
  } else if (knownTitle(w.scope) != null) {
    if (provider === 'codex' && w.rank === 2) return w.remaining == null || w.remaining >= 100;
    return false;
  }
  return w.remaining == null || w.remaining >= 100;
}

// PlanTierFormatter.label: "Max (20x)", "Pro".
export function planLabel(meta) {
  for (const plan of [meta?.claudePlan, meta?.codexPlan, meta?.plan]) {
    if (!plan) continue;
    if (typeof plan === 'string') return cap(plan);
    if (plan.displayName) return plan.displayName;
    const sub = (plan.subscriptionType || plan.planType || '').trim();
    const tokens = String(plan.rateLimitTier || '').toLowerCase().split(/[^a-z0-9]+/);
    let base = sub ? cap(sub) : null;
    if (!base) {
      // 'ultra' is Max 20x renamed (Anthropic, 2026-10-30, issue #799).
      const word = ['ultra', 'max', 'pro', 'plus', 'team', 'enterprise', 'free'].find((p) => tokens.includes(p));
      base = word ? cap(word) : null;
    }
    if (!base) continue;
    const mult = tokens.find((t) => /^\d+x$/.test(t));
    return mult ? `${base} (${mult})` : base;
  }
  return null;
}

// DeckFreshness.signInRecovery, per machine.
export function signInOf(a) {
  const auth = a.authState;
  if (!auth || auth === 'ok') return { state: 'ok', text: null };
  if (auth === 'signin-required') {
    const failures = a.provider === 'claude' ? (a.renew?.consecutiveFailures ?? 0) : 0;
    const expired = String(a.signinReason || '').toLowerCase() === 'expired';
    if (expired && failures >= 2) return { state: 'needed', text: 'Renewal failed — sign in needed' };
    if (expired) return { state: 'idle', text: 'Idle — renews on next use' };
    return { state: 'needed', text: 'Sign in needed' };
  }
  if (auth === 'duplicate-token') return { state: 'needed', text: 'Same sign-in as another account' };
  return { state: 'needed', text: 'Sign-in problem' };
}

const normProvider = (p) => {
  const s = String(p || '').toLowerCase();
  if (s === 'anthropic') return 'claude';
  if (s === 'openai') return 'codex';
  if (s === 'xai') return 'grok';
  return s;
};
const normLabel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// ---------- merge the configured sources ----------

const machineList = (machines) => machines.M5 && machines.M1 ? [machines.M5, machines.M1] : Object.values(machines);

export function mergeAccounts(machines) {
  const list = [];
  for (const m of machineList(machines)) { // M5 first in two-Mac mode: its display labels win
    if (!m.state) continue;
    for (const a of m.state.accounts) {
      if (!a.enabled) continue;
      const provider = normProvider(a.provider);
      const uuid = a.metadata?.claudeAccountUuid || null;
      const norm = normLabel(a.label);
      const target = list.find((x) => x.provider === provider && !x.from.has(m.name)
        && (uuid && x.uuids.size ? x.uuids.has(uuid) : x.norms.has(norm)));
      const acct = target || { provider, label: a.label, color: a.color, uuids: new Set(), norms: new Set(), from: new Map() };
      if (!target) list.push(acct);
      acct.from.set(m.name, a);
      if (uuid) acct.uuids.add(uuid);
      acct.norms.add(norm);
    }
  }
  return list;
}

export function headlineOf(windows, provider) {
  const measurable = windows.filter((w) => w.remaining != null);
  const rateLimits = measurable.filter((w) => !w.spend);
  const eligible = rateLimits.length ? rateLimits : measurable;
  let headline = provider === 'claude'
    ? windows.findIndex((w) => w.title === 'Weekly · all models' && w.remaining != null && !w.spend)
    : -1;
  if (headline >= 0) {
    // the weekly leads
  } else if (eligible.length) {
    const worst = Math.min(...eligible.map((w) => w.remaining));
    const tied = eligible.filter((w) => w.remaining === worst);
    const withReset = tied.filter((w) => w.resetsAt != null).sort((a, b) => a.resetsAt - b.resetsAt)[0];
    headline = windows.indexOf(withReset || tied[0]);
  } else {
    headline = windows.findIndex((w) => w.spendText);
  }

  return headline;
}

export function weightOf(account) {
  if (!account) return undefined;
  return account.proxyPool === 'member' ? account.proxyWeight ?? null : null;
}

export function buildAccount(acct, idx, now, machines) {
  // Freshest reading per window across both machines.
  const best = new Map();
  for (const [mname, a] of acct.from) {
    for (const u of machines[mname].state.usage || []) {
      if (u.accountId !== a.id) continue;
      const obs = Date.parse(u.observedAt);
      const prev = best.get(u.scope);
      if (!prev || obs > prev.obs) best.set(u.scope, { u, obs, machine: mname, accountId: a.id });
    }
  }
  let newest = null;
  const windows = [];
  for (const { u, obs, machine, accountId } of best.values()) {
    if (newest == null || obs > newest) newest = obs;
    const remaining = u.remainingPercent ?? (u.usedPercent != null ? 100 - u.usedPercent : null);
    const resetsAt = u.resetsAt ? Date.parse(u.resetsAt) : null;
    const duration = isSpend(u.scope) ? null : windowDurationMs(u.scope, u.detail?.windowDurationMins);
    const anchor = isSpend(u.scope) ? { kind: 'anchored' } : anchorOf(remaining, resetsAt, obs, duration, now);
    const idle = idleNotice(u.scope, anchor, resetsAt, obs, now);
    const w = {
      scope: u.scope, rank: windowRank(u.scope), spend: isSpend(u.scope),
      remaining, resetsAt, spendText: isSpend(u.scope) ? spendText(u.detail?.spend) : null,
    };
    if (hidden(w, acct.provider)) continue;
    windows.push({
      ...w, title: windowTitle(u.scope), observedAt: obs, machine, accountId, duration,
      state: idle ? 'idle' : anchor.kind, rolledAt: anchor.rolledAt ?? null, idleText: idle,
      severity: idle ? 'unknown' : severity(remaining),
    });
  }
  windows.sort((l, r) => (l.rank - r.rank) || l.scope.localeCompare(r.scope, 'en', { sensitivity: 'base' }));

  // Claude cards lead with the all-models weekly, as Tim's Mac deck does (his
  // chosen lead window, #746); Codex cards, and Claude cards with no weekly,
  // lead with the lowest window, also as on the Mac.
  const headline = headlineOf(windows, acct.provider);

  // Sign-in, per machine and overall (trouble only when no machine is signed in).
  const perMachine = [...acct.from].map(([mname, a]) => ({ name: mname, ...signInOf(a) }));
  const anyOk = perMachine.some((p) => p.state === 'ok');
  const feeds = [...new Set(windows.map((w) => w.machine))];
  const lead = perMachine.find((p) => p.name === feeds[0]) || perMachine[0];
  let renewedAt = null;
  for (const a of acct.from.values()) {
    const last = a.renew?.lastAttempt || a.metadata?.claudeRenewal?.lastAttempt;
    if (last?.outcome === 'renewed' && last.at) renewedAt = Math.max(renewedAt ?? 0, Date.parse(last.at));
  }

  // Forecast: only when, at the measured pace, a shown window runs out before it resets.
  let forecast = null;
  for (const w of windows) {
    if (w.state !== 'anchored' || w.spend || w.resetsAt == null) continue;
    const report = machines[w.machine].forecast;
    const f = report?.accounts?.find((e) => e.accountId === w.accountId && e.scope === w.scope);
    if (!f || f.status !== 'forecast' || !f.dryAt) continue;
    const dry = Date.parse(f.dryAt);
    if (!(dry > now && dry < w.resetsAt - 10 * 60_000)) continue;
    if (!forecast || dry < forecast.dryAt) {
      forecast = { title: w.title, dryAt: dry, resetsAt: w.resetsAt, basis: report.basisWindow?.label || null, label: report.estimateLabel || 'Estimate' };
    }
  }

  const weekly = windows.find((w) => w.rank === 1 && w.state === 'anchored' && w.resetsAt > now && w.duration);
  return {
    out: {
      id: `a${idx + 1}`,
      provider: acct.provider,
      label: acct.label,
      color: /^#[0-9a-f]{6}$/i.test(acct.color || '') ? acct.color : null,
      plan: planLabel([...acct.from.values()][0]?.metadata) || planLabel([...acct.from.values()][1]?.metadata),
      // The pool host's weight (M5 in two-Mac mode): null when outside it.
      weight: weightOf(acct.from.get(machineList(machines).length === 1 ? machineList(machines)[0].name : 'M5')),
      reads: true,
      windows: windows.map((w) => ({
        title: w.title, rank: w.rank, spend: w.spend, remaining: round1(w.remaining),
        resetsAt: iso(w.resetsAt), observedAt: iso(w.observedAt), source: w.machine,
        state: w.state, rolledAt: iso(w.rolledAt), idleText: w.idleText, spendText: w.spendText,
        severity: w.severity,
      })),
      headline,
      newestObservedAt: iso(newest),
      stale: newest != null && now - newest > STALE_AFTER,
      feeds,
      machines: perMachine.map((p) => ({ name: p.name, signIn: p.state, text: p.text })),
      signIn: anyOk ? null : { text: lead?.text || 'Sign in needed', state: lead?.state || 'needed' },
      renewedAt: iso(renewedAt),
      forecast: forecast && { ...forecast, dryAt: iso(forecast.dryAt), resetsAt: iso(forecast.resetsAt) },
      history: null,
    },
    _weekly: weekly ? {
      machine: weekly.machine, accountId: weekly.accountId, scope: weekly.scope,
      resetsAt: new Date(weekly.resetsAt).toISOString(), durationMs: weekly.duration,
      title: weekly.title, observedAt: weekly.observedAt, remaining: weekly.remaining,
    } : null,
  };
}

export function historyFor(w, histories) {
  if (!w) return null;
  const hit = histories.get(`${w.machine}:${w.accountId}:${w.resetsAt}`);
  if (!hit) return null;
  const end = Date.parse(w.resetsAt);
  const start = end - w.durationMs;
  const points = hit.rows
    .map((r) => [Date.parse(r.bucketStart), r.lastUsedPercent])
    .filter(([t, used]) => t >= start - 3_600_000 && used != null)
    .sort((a, b) => a[0] - b[0])
    .map(([t, used]) => [Math.max(t, start), round1(100 - used)]);
  points.push([w.observedAt, round1(w.remaining)]);
  if (points.length < 3) return null;
  return { title: w.title, start: iso(start), end: iso(end), points: points.map(([t, r]) => [iso(t), r]) };
}

// Guard display text as well as omitted identity fields: daemon labels and plan
// names can themselves contain an identity or credential. Ordinary text is unchanged:
// token prefixes match case-sensitively, and a long unbroken run counts as a key only
// when it mixes digits with letters the way random keys do (#787 review).
const IDENTITY_TEXT = /[^\s@]+(?:@|%40)[^\s@]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|\/(?:Users|home|private|Volumes|var)\/|~\//i;
const TOKEN_TEXT = /(?<![A-Za-z0-9])(?:ghp_|gho_|github_pat_|AIza|ya29\.)\S{6,}|(?<![A-Za-z0-9])(?:[Ss][Kk]-|[Xx][Aa][Ii]-)\S{6,}|\bBearer [A-Za-z0-9._~+\/-]{8,}|\beyJ[A-Za-z0-9_-]{8,}/;
const keyLike = (run) => /\d/.test(run) && (/^[0-9a-f]+$/i.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run)));
function displaySafe(value) {
  if (typeof value === 'string') {
    const secret = IDENTITY_TEXT.test(value) || TOKEN_TEXT.test(value)
      || (value.match(/[A-Za-z0-9_+\/-]{32,}={0,2}/g) || []).some(keyLike);
    return secret ? '[redacted]' : value;
  }
  if (Array.isArray(value)) return value.map(displaySafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, displaySafe(v)]));
  return value;
}

// Issue #827: on the pool host (one local source), the pool's own record of
// each member, for remote Macs' decks. Members are named only by a one-way
// tag of their identity; accounts outside the pool are left out entirely.
export function hubPoolOf(machines) {
  const list = machineList(machines);
  if (list.length !== 1 || list[0].remote || !list[0].state) return undefined;
  const m = list[0];
  const members = [];
  for (const a of m.state.accounts) {
    if (!a.enabled || a.proxyPool !== 'member') continue;
    const provider = normProvider(a.provider);
    const match = poolMemberTag(provider, provider === 'claude' ? a.identity : a.codexAccountId);
    if (!match) continue;
    const credential = ['ok', 'error', 'resting', 'disabled'].includes(a.proxyCredential) ? a.proxyCredential : null;
    members.push({
      provider, match,
      weight: Number.isInteger(a.proxyWeight) && a.proxyWeight >= 0 ? a.proxyWeight : null,
      fableExcluded: a.proxyFableExcluded === true,
      credential,
      // Never the proxy's own text: only a retry time or "provider overloaded".
      credentialDetail: poolCredentialDetail(credential, a.proxyCredentialDetail),
    });
  }
  return { readAt: m.stateAt ? iso(m.stateAt) : null, members };
}

// Pure projection: callers supply machine snapshots, time, and optional cached data.
export function buildDeck(machines, now, { pool = {}, histories = new Map(), generatedAt = now } = {}) {
  const built = mergeAccounts(machines).map((a, i) => buildAccount(a, i, now, machines));
  const accounts = built.map((b) => ({ ...b.out, history: historyFor(b._weekly, histories) }));

  const poolName = machineList(machines).find((m) => !m.remote)?.name;
  const poolNote = `Signed in to the ${poolName} proxy pool. ModelDeck doesn’t read its usage yet.`;
  for (let i = 0; i < pool.grok; i++) {
    accounts.push({ id: `g${i + 1}`, provider: 'grok', label: pool.grok > 1 ? `Grok ${i + 1}` : 'Grok', reads: false, note: poolNote });
  }
  for (let i = 0; i < pool.antigravity; i++) {
    accounts.push({ id: `ag${i + 1}`, provider: 'antigravity', label: pool.antigravity > 1 ? `Antigravity ${i + 1}` : 'Antigravity', reads: false, note: poolNote });
  }

  const hubPool = hubPoolOf(machines);
  return displaySafe({
    generatedAt: iso(generatedAt),
    sources: machineList(machines).map((m) => ({
      name: m.name,
      ok: m.ok,
      reachable: m.ok || (m.stateAt > 0 && generatedAt - m.stateAt < DOWN_AFTER),
      readAt: m.stateAt ? iso(m.stateAt) : null,
      note: m.ok ? null : (m.remote ? 'Asleep or offline' : 'Not answering'),
    })),
    accounts,
    ...(hubPool ? { hubPool } : {}),
  });
}

export const SAFE_PATH = /^\/api\/[A-Za-z0-9/?=&:.\-_%+]+$/;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Each reader owns its caches; injected I/O keeps offline tests fail-closed.
export function createDeckReader(env = process.env, { fetch = globalThis.fetch, execFile: run = execFile, readdir: list = readdir } = {}) {
  const { local, name, daemonPort } = validateConfig(env);
  const daemon = `http://127.0.0.1:${daemonPort}`;
  const machines = local ? {
    [name]: { name, remote: false, state: null, stateAt: 0, lastTry: 0, ok: false, error: null, forecast: null, forecastAt: 0 },
  } : {
    M5: { name: 'M5', remote: true, state: null, stateAt: 0, lastTry: 0, ok: false, error: null, forecast: null, forecastAt: 0 },
    M1: { name: 'M1', remote: false, state: null, stateAt: 0, lastTry: 0, ok: false, error: null, forecast: null, forecastAt: 0 },
  };
  const historyCache = new Map(); // `${machine}:${accountId}:${resetsAt}` -> { at, rows }
  let deck = null;
  let deckAt = 0;
  let inflight = null;

  // ---------- upstream reads (GET only) ----------

  async function localGet(path) {
    const res = await fetch(daemon + path, { method: 'GET', signal: AbortSignal.timeout(25_000) }); // slow for a while after a restart
    if (!res.ok) throw new Error(`${local ? name : 'M1'} ${path} -> HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new Error('Invalid daemon JSON'); }
  }

  // One ssh round trip for several GETs on the M5's daemon. Paths are checked to
  // be shell-safe before they go inside the remote single quotes.
  async function m5GetMany(paths) {
    for (const p of paths) if (!SAFE_PATH.test(p)) throw new Error('unsafe path');
    const cmd = paths.map((p) => `curl -s -m 15 'http://127.0.0.1:3867${p}'; printf '\\n\\036\\n'`).join('; ');
    return new Promise((resolve, reject) => {
      run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', M5_HOST, cmd],
        { timeout: 25_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(new Error(err.killed ? 'ssh timed out' : 'ssh failed'));
          const parts = stdout.split('\n\x1e\n');
          resolve(paths.map((_, i) => { try { return JSON.parse(parts[i]); } catch { return null; } }));
        });
    });
  }

  async function readMachine(m, now) {
    if (m.remote && !m.ok && m.lastTry && now - m.lastTry < M5_RETRY && now - m.stateAt > DOWN_AFTER) return; // asleep: don't stall every page load
    m.lastTry = now;
    const wantForecast = now - m.forecastAt > FORECAST_TTL;
    try {
      let state, forecast;
      if (m.remote) {
        // Separate round trips, so a slow forecast can't time out the state read.
        [[state], [forecast]] = await Promise.all([
          m5GetMany(['/api/state']),
          wantForecast ? m5GetMany(['/api/usage/exhaustion-forecast']).catch(() => [null]) : [null],
        ]);
      } else {
        [state, forecast] = await Promise.all([
          localGet('/api/state'),
          wantForecast ? localGet('/api/usage/exhaustion-forecast').catch(() => null) : null,
        ]);
      }
      if (!state || !Array.isArray(state.accounts)) throw new Error('no state');
      m.state = state; m.stateAt = Date.now(); m.ok = true; m.error = null;
      if (wantForecast && forecast && Array.isArray(forecast.accounts)) { m.forecast = forecast; m.forecastAt = Date.now(); }
    } catch {
      m.ok = false; m.error = 'Read failed';
      log(`${m.name} read failed`);
    }
  }

  async function readHistories(accounts, now) {
    // The all-models weekly of each account, from the machine whose reading we show.
    const wants = Object.fromEntries(machineList(machines).map((m) => [m.name, []]));
    for (const acct of accounts) {
      const w = acct._weekly;
      if (!w) continue;
      const key = `${w.machine}:${w.accountId}:${w.resetsAt}`;
      const hit = historyCache.get(key);
      if (hit && now - hit.at < HISTORY_TTL) continue;
      const since = new Date(Date.parse(w.resetsAt) - w.durationMs).toISOString().replace(/\.\d+Z$/, 'Z');
      const until = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
      const q = new URLSearchParams({ accountId: w.accountId, scope: w.scope, since, until, bucket: 'hour' });
      wants[w.machine].push({ key, path: `/api/usage/history?${q}` });
    }
    const store = (key, body) => {
      if (body && Array.isArray(body.rows)) historyCache.set(key, { at: Date.now(), rows: body.rows });
    };
    const jobs = [];
    for (const m of machineList(machines)) {
      const wanted = wants[m.name];
      if (!wanted.length) continue;
      if (!m.remote) {
        jobs.push(Promise.all(wanted.map(async (x) => store(x.key, await localGet(x.path).catch(() => null)))));
      } else if (m.ok) {
        jobs.push(m5GetMany(wanted.map((x) => x.path))
          .then((bodies) => bodies.forEach((b, i) => store(wanted[i].key, b)))
          .catch(() => log(`${m.name} history failed`)));
      }
    }
    await Promise.all(jobs);
    for (const [k, v] of historyCache) if (now - v.at > 6 * HISTORY_TTL) historyCache.delete(k);
  }

  // The pool's Grok and Antigravity sign-ins, counted from file NAMES only.
  // The files themselves are never opened.
  async function poolSignins() {
    try {
      const names = await list(POOL_AUTH_DIR);
      return {
        grok: names.filter((n) => /^xai-.*\.json$/.test(n)).length,
        antigravity: names.filter((n) => /^antigravity-.*\.json$/.test(n)).length,
      };
    } catch {
      return { grok: 0, antigravity: 0 };
    }
  }

  async function build() {
    const now = Date.now();
    await Promise.all(machineList(machines).map((m) => readMachine(m, now)));
    const built = mergeAccounts(machines).map((a, i) => buildAccount(a, i, now, machines));
    await readHistories(built, now);
    const pool = local ? {} : await poolSignins();
    return buildDeck(machines, now, { pool, histories: historyCache, generatedAt: Date.now() });
  }

  async function getDeck() {
    if (deck && Date.now() - deckAt < STATE_TTL) return deck;
    if (!inflight) {
      inflight = build()
        .then((d) => { deck = d; deckAt = Date.now(); return d; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return getDeck;
}
const getDeck = createDeckReader();

// ---------- HTTP ----------

const STATIC = {
  '/manifest.webmanifest': { file: new URL('manifest.webmanifest', HERE), type: 'application/manifest+json', maxAge: 3600 },
  '/icons/apple-touch-icon.png': { file: new URL('icons/apple-touch-icon.png', HERE), type: 'image/png', maxAge: 86400 },
  '/icons/icon-192.png': { file: new URL('icons/icon-192.png', HERE), type: 'image/png', maxAge: 86400 },
  '/icons/icon-512.png': { file: new URL('icons/icon-512.png', HERE), type: 'image/png', maxAge: 86400 },
  '/icons/favicon-32.png': { file: new URL('icons/favicon-32.png', HERE), type: 'image/png', maxAge: 86400 },
  '/marks/claude.png': { file: new URL('provider-claude-128.png', MARKS), type: 'image/png', maxAge: 86400 },
  '/marks/codex.png': { file: new URL('provider-codex-128.png', MARKS), type: 'image/png', maxAge: 86400 },
  '/marks/grok.png': { file: new URL('provider-grok-128.png', MARKS), type: 'image/png', maxAge: 86400 },
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'",
};

// Host checking limits DNS rebinding to explicitly trusted names.
const shortHostname = hostname().split('.')[0].toLowerCase();
const { allowedNames } = validateConfig(process.env);
export function hostAllowed(host = '', names = allowedNames) {
  const name = host.toLowerCase().replace(/:\d+$/, '');
  const ip = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  return name === 'localhost' || isIP(ip) !== 0 || name.endsWith('.ts.net')
    || (/^[a-z0-9-]+$/.test(name) && (name === shortHostname || names.includes(name)));
}

export async function handle(req, res, readDeck = getDeck) {
  const send = (status, type, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, ...SECURITY, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (!hostAllowed(req.headers.host)) return send(403, 'text/plain', 'Forbidden\n');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Read-only\n', { Allow: 'GET, HEAD' });
  const path = URL.parse(req.url, 'http://local')?.pathname;
  if (!path) return send(400, 'text/plain', 'Bad request\n');
  try {
    if (path === '/' || path === '/index.html') {
      return send(200, 'text/html; charset=utf-8', await readFile(new URL('index.html', HERE)), { 'Cache-Control': 'no-store' });
    }
    if (path === '/api/deck' || path === '/api/status') {
      const deck = await readDeck();
      const { hubPool, ...page } = deck;
      const body = path === '/api/status' ? {
        generatedAt: deck.generatedAt,
        sources: deck.sources.map(({ name, ok, reachable, readAt }) => ({ name, ok, reachable, readAt })),
        ...(hubPool ? { pool: hubPool } : {}),
      } : page;
      return send(200, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
    }
    const s = STATIC[path];
    if (s) return send(200, s.type, await readFile(s.file), { 'Cache-Control': `public, max-age=${s.maxAge}` });
    return send(404, 'text/plain', 'Not found\n');
  } catch {
    log('request failed');
    return send(500, 'text/plain', 'Server error\n');
  }
}

// True when node was started with this file, also through a symlinked path.
export const isMain = (argv1, url = import.meta.url) => !!argv1 && url === pathToFileURL(realpathSync(argv1)).href;

if (isMain(process.argv[1])) {
  for (const host of HOSTS) {
    http.createServer(handle).listen(PORT, host, () => log(`phone deck on http://${host}:${PORT}`));
  }
}
