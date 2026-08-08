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

// Issue #181: feature consumers need only the newest row per (account, scope),
// but keep a wide history window as a conservative operational/debugging
// margin. The newest row is protected independently of age for idle accounts.
export const USAGE_SNAPSHOT_RETENTION_DAYS = 90;
export const USAGE_SNAPSHOT_PRUNE_BATCH_SIZE = 500;

export const DEFAULT_SETTINGS = Object.freeze({
  autoRefreshEnabled: true,
  // Issue #176: expired Claude OAuth credentials may be renewed through the
  // provider CLI after the normal scheduled refresh identifies them. This is
  // independently switchable from usage refreshes so the background
  // invocation can be stopped without making the deck stale.
  autoRenewEnabled: true,
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
  // Issue #242 deck chip labels: '' = dot only (the default — the dot is
  // shape-coded green circle / yellow triangle / red octagon / hollow
  // no-data ring, so color is never the only signal); 'show' = dot +
  // verdict word (the Settings → General → Accessibility toggle). Free
  // string like menuBarShowWhen — the app owns the grammar and treats
  // anything it doesn't recognize as '' (dot only), so old and new builds
  // round-trip each other's values safely. Display-only: the chip's
  // tooltip, detail popover, and VoiceOver strings are unaffected.
  deckHealthLabels: '',
});

function validateSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`unknown setting: ${key}`);
  if (['autoRefreshEnabled', 'autoRenewEnabled', 'autoRefreshIntervalCustomized', 'pauseWhileActive', 'sharedUserScopeEnabled'].includes(key) && typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean`);
  }
  if (key === 'autoRefreshIntervalSeconds' && (!Number.isInteger(value) || value < 60 || value > 3600)) {
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

export class Store {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    if (dbPath !== ':memory:') {
      fs.chmodSync(path.dirname(dbPath), 0o700);
      fs.chmodSync(dbPath, 0o600);
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
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
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings(id, value_json, updated_at) VALUES (1, '{}', ?)
    `).run(now());
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
    if (!['claude', 'codex'].includes(input.provider)) throw new Error('provider must be claude or codex');
    if (!input.label?.trim()) throw new Error('account label is required');
    if (!input.profileRef?.trim()) throw new Error('profile reference is required');
    let profileRef = input.profileRef.trim();
    if (input.provider === 'codex') {
      const canonical = canonicalDirectory(profileRef, 'CODEX_HOME');
      if (process.getuid && canonical.stat.uid !== process.getuid()) throw new Error('CODEX_HOME must be owned by the current user');
      if ((canonical.stat.mode & 0o077) !== 0) throw new Error(`CODEX_HOME must use owner-only permissions (chmod 700 ${canonical.path})`);
      profileRef = canonical.path;
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
      input.color || (input.provider === 'claude' ? '#d97757' : '#48a868'),
      input.enabled === false ? 0 : 1,
      existing?.isDefault ? 1 : 0,
      JSON.stringify(input.metadata || existing?.metadata || {}),
      existing?.createdAt || timestamp,
      timestamp,
    );
    if (input.isDefault) this.setDefault(input.provider, id);
    return this.getAccount(id);
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
    // Correlated-subquery form so the usage_account_scope_observed covering
    // index serves each (account, scope)'s newest row directly — the
    // window-function form full-scanned the table (PR #177 review). Same
    // contract: newest observed_at wins, id breaks ties.
    const rows = this.db.prepare(`
      SELECT u.* FROM usage_snapshots u
      WHERE u.id = (
        SELECT u2.id FROM usage_snapshots u2
        WHERE u2.account_id = u.account_id AND u2.scope = u.scope
        ORDER BY u2.observed_at DESC, u2.id DESC LIMIT 1
      )
      ORDER BY u.account_id, u.scope
    `).all();
    return rows.map(usageRow);
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

  saveSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be a JSON object');
    for (const [key, value] of Object.entries(input)) validateSetting(key, value);
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
