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
export const CLAUDE_PATH = process.env.MODELDECK_CLAUDE_PATH || 'claude';
export const CLAUDE_PROFILES_DIR = path.resolve(
  process.env.MODELDECK_CLAUDE_PROFILES_DIR || path.join(DATA_DIR, 'claude-profiles'),
);
export const CLAUDE_ACTIVE_LINK = path.resolve(
  process.env.MODELDECK_CLAUDE_ACTIVE_LINK || path.join(os.homedir(), '.claude'),
);
// Issue #66: shell snippet the install-shell-env.sh block sources so new
// terminal sessions launch pinned to the active profile real path. The
// generated ~/.zshenv block honors the same MODELDECK_CLAUDE_SHELL_ENV_FILE
// override with the same default, so the daemon's write path and the path
// shells source can never diverge; keep both sides in sync.
export const CLAUDE_SHELL_ENV_FILE = path.resolve(
  process.env.MODELDECK_CLAUDE_SHELL_ENV_FILE || path.join(DATA_DIR, 'claude-env.sh'),
);
export const CODEX_PATH = process.env.MODELDECK_CODEX_PATH || 'codex';
// Owner-only per-account CODEX_HOME directories created by the add-account
// flow (docs/ACCOUNT_ONBOARDING.md "Codex onboarding").
export const CODEX_PROFILES_DIR = path.resolve(
  process.env.MODELDECK_CODEX_PROFILES_DIR || path.join(os.homedir(), '.codex-profiles'),
);
export const CODEX_ACTIVE_LINK = path.resolve(
  process.env.MODELDECK_CODEX_ACTIVE_LINK || path.join(os.homedir(), '.codex'),
);
