import os from 'node:os';
import path from 'node:path';

export const HOST = process.env.MODELDECK_HOST || '127.0.0.1';
export const PORT = Number(process.env.MODELDECK_PORT || 3867);
export const PROJECTS_ROOT = path.resolve(
  process.env.MODELDECK_PROJECTS_ROOT || path.join(os.homedir(), 'projects'),
);
export const DATA_DIR = path.resolve(
  process.env.MODELDECK_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'ModelDeck'),
);
export const DB_PATH = process.env.MODELDECK_DB_PATH || path.join(DATA_DIR, 'modeldeck.sqlite');
// The bundled launchd job cannot expand a per-user home path in its static
// plist. The SEA bootstrap redirects fd 2 here before server imports, with
// one bounded rotation managed by src/daemon-error-log.mjs.
export const DAEMON_ERROR_LOG_PATH = path.join(DATA_DIR, 'modeldeck.err.log');
// Issue #347: the lane runner's append-only run manifest
// (.claude/lane-logs/manifest.jsonl in the orchestrated repo). Read-only, and
// only ever to TAG sessions with a plausible issue number — a missing file
// simply means no lane tags. The default points at this repo's checkout under
// the projects root; the override exists for other checkouts and for tests.
export const LANE_MANIFEST_PATH = path.resolve(
  process.env.MODELDECK_LANE_MANIFEST_PATH
    || path.join(PROJECTS_ROOT, 'modeldeck', '.claude', 'lane-logs', 'manifest.jsonl'),
);
export const CLAUDE_PATH = process.env.MODELDECK_CLAUDE_PATH || 'claude';
export const CLAUDE_PROFILES_DIR = path.resolve(
  process.env.MODELDECK_CLAUDE_PROFILES_DIR || path.join(DATA_DIR, 'claude-profiles'),
);
export const CLAUDE_ACTIVE_LINK = path.resolve(
  process.env.MODELDECK_CLAUDE_ACTIVE_LINK || path.join(os.homedir(), '.claude'),
);
export const ZSHENV_PATH = path.resolve(
  process.env.MODELDECK_ZSHENV_PATH || path.join(os.homedir(), '.zshenv'),
);
export const LAUNCHCTL_PATH = process.env.MODELDECK_LAUNCHCTL_PATH || '/bin/launchctl';
// Issue #66: shell snippet the install-shell-env.sh block sources so new
// terminal sessions launch pinned to the active profile real path. The
// generated ~/.zshenv block honors the same MODELDECK_CLAUDE_SHELL_ENV_FILE
// override with the same default, so the daemon's write path and the path
// shells source can never diverge; keep both sides in sync.
export const CLAUDE_SHELL_ENV_FILE = path.resolve(
  process.env.MODELDECK_CLAUDE_SHELL_ENV_FILE || path.join(DATA_DIR, 'claude-env.sh'),
);
// Issue #174: per-profile statusline capture files (opt-in tee). Written by
// the statusline script running inside the user's Claude Code session, read
// by the daemon's ingest — always inside ModelDeck's own data dir, never a
// provider directory.
export const CLAUDE_STATUSLINE_DIR = path.resolve(
  process.env.MODELDECK_CLAUDE_STATUSLINE_DIR || path.join(DATA_DIR, 'statusline'),
);
export const CODEX_PATH = process.env.MODELDECK_CODEX_PATH || 'codex';
// Owner-only per-account CODEX_HOME directories created by the add-account
// flow (docs/ACCOUNT_ONBOARDING.md "Codex onboarding").
export const CODEX_PROFILES_DIR = path.resolve(
  process.env.MODELDECK_CODEX_PROFILES_DIR || path.join(DATA_DIR, 'codex-profiles'),
);
export const LEGACY_CODEX_PROFILES_DIR = path.resolve(
  process.env.MODELDECK_LEGACY_CODEX_PROFILES_DIR || path.join(os.homedir(), '.codex-profiles'),
);
export const CODEX_ACTIVE_LINK = path.resolve(
  process.env.MODELDECK_CODEX_ACTIVE_LINK || path.join(os.homedir(), '.codex'),
);
// Grok owns this external session store. ModelDeck only streams
// */*/updates.jsonl read-only; the override keeps tests on fixtures.
export const GROK_SESSIONS_DIR = path.resolve(
  process.env.MODELDECK_GROK_SESSIONS_DIR || path.join(os.homedir(), '.grok', 'sessions'),
);
// CLIProxyAPI owns OAuth and auth-file writes. ModelDeck only spawns its
// provider login command, then reads identity/routing metadata from the auth
// directory. Keep binary discovery configurable like Claude/Codex paths.
export const CLIPROXY_BIN = process.env.MODELDECK_CLIPROXY_BIN || 'cliproxyapi';
export const CLIPROXY_BASE_URL = process.env.MODELDECK_CLIPROXY_BASE_URL || 'http://127.0.0.1:8317';
// CLIProxyAPI management credential FILE. The daemon reads and trims it on
// every enabled usage-queue tick; only this path is configured here, never the
// key value. The override exists for nonstandard installs and isolated tests.
export const CLIPROXY_MANAGEMENT_KEY_PATH = path.resolve(
  process.env.MODELDECK_CLIPROXY_MANAGEMENT_KEY_PATH
    || path.join(os.homedir(), '.config', 'cliproxyapi', '.mgmt-key'),
);
// CLIProxyAPI state directory. Issue #421: the Mac app's managed proxy runs
// against this EXACT path — the same one an external instance uses — so
// adopting an existing install needs no credential migration (#398). The
// daemon only reports what it can observe here; the app owns the process.
export const CLIPROXY_CONFIG_DIR = path.resolve(
  process.env.MODELDECK_CLIPROXY_CONFIG_DIR || path.join(os.homedir(), '.config', 'cliproxyapi'),
);
// CLIProxyAPI auth-file directory (an external tool's state, read-only):
// each account file carries the routing `weight` an external rebalance job
// maintains from live quota. The daemon only ever READS the non-secret
// weight/identity fields to enrich /api/state; a missing directory means the
// proxy simply isn't installed and nothing renders.
// The default derives from CLIPROXY_CONFIG_DIR (PR #430 review): overriding
// only the config dir must move the auth dir with it, or the daemon reports
// on one install while reading auth metadata from another.
export const CLIPROXY_AUTH_DIR = path.resolve(
  process.env.MODELDECK_CLIPROXY_AUTH_DIR || path.join(CLIPROXY_CONFIG_DIR, 'auth'),
);
// Rebuildable request-usage archive owned by CLIProxyAPI's puller. The
// backfill CLI reads it without modifying or deleting source files. Keep the
// override separate from CLIPROXY_AUTH_DIR: archive ingest never needs access
// to provider auth material.
export const CLIPROXY_USAGE_ARCHIVE_DIR = path.resolve(
  process.env.MODELDECK_CLIPROXY_USAGE_ARCHIVE_DIR
    || process.env.MODELDECK_USAGE_ARCHIVE_DIR
    || path.join(os.homedir(), '.config', 'cliproxyapi', 'static', 'modeldeck-test-pulls'),
);
