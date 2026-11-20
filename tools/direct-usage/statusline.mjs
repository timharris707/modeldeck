// Terminal status line capture for the direct reader (#838).
//
// Claude Code runs a folder's status line command after each reply and hands
// it a JSON payload on stdin; once the account has replied, the payload
// carries `rate_limits` (weekly and 5-hour: percent used, reset time). This
// program saves those numbers for reader.mjs and prints nothing, so the
// terminal shows no status line.
//
// Safety contract, as reader.mjs: it never opens a credential file or the
// Keychain and makes no network call. From the folder's .claude.json it keeps
// only the account uuid, so a reading stays with the account that made it.
// Node built-ins only; any failure exits quietly so the terminal never shows
// an error.
//
//   node direct-statusline.mjs capture <folder>      (the status line command)
//   node direct-statusline.mjs install <folder>...   (this machine's folders)
//   node direct-statusline.mjs uninstall <folder>...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAPTURE_VERSION = 1;
const FOLDER = /^[A-Za-z0-9._-]{1,64}$/;
const WINDOWS = ['seven_day', 'five_hour'];
const SAME_FOR_MS = 60_000;

export function capturePaths(home = os.homedir(), env = process.env) {
  return {
    accountsDir: env.MD_CLAUDE_ACCOUNTS_DIR || path.join(home, '.claude-accounts'),
    terminalDir: path.join(home, '.cache', 'modeldeck', 'direct-usage', 'terminal'),
    installed: path.join(home, '.local', 'share', 'modeldeck', 'direct-statusline.mjs'),
  };
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/// The windows worth saving from one status line payload, or null.
export function windowsOf(payload) {
  const limits = payload?.rate_limits;
  if (!limits || typeof limits !== 'object') return null;
  const out = {};
  for (const key of WINDOWS) {
    const used = finite(limits[key]?.used_percentage);
    if (used == null || used < 0 || used > 100) continue;
    out[key] = { used_percentage: used, resets_at: finite(limits[key]?.resets_at) };
  }
  return Object.keys(out).length ? out : null;
}

function accountUuid(accountsDir, folder) {
  try {
    const uuid = JSON.parse(fs.readFileSync(path.join(accountsDir, folder, '.claude.json'), 'utf8'))?.oauthAccount?.accountUuid;
    return typeof uuid === 'string' ? uuid : null;
  } catch { return null; }
}

/// Save one payload's windows for `folder`. Returns true when it wrote.
export function capture(folder, payload, { paths = capturePaths(), now = Date.now() } = {}) {
  if (!FOLDER.test(folder)) return false;
  const windows = windowsOf(payload);
  if (!windows) return false;
  const uuid = accountUuid(paths.accountsDir, folder);
  if (!uuid) return false;
  const file = path.join(paths.terminalDir, `${folder}.json`);
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A status line runs often; the same numbers need saving once a minute.
    if (prev?.accountUuid === uuid && JSON.stringify(prev.windows) === JSON.stringify(windows)
      && now - Date.parse(prev.observedAt) < SAME_FOR_MS) return false;
  } catch { /* first capture */ }
  fs.mkdirSync(paths.terminalDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: CAPTURE_VERSION, folder, accountUuid: uuid, observedAt: new Date(now).toISOString(), windows }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

function writeWhole(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/// The node to name in settings.json: a `node` on PATH that is this same
/// program, so a version-numbered path (Homebrew's Cellar) that a Node
/// upgrade removes is never written down. Falls back to this program.
export function stableNode(execPath = process.execPath, pathList = process.env.PATH || '') {
  let real;
  try { real = fs.realpathSync(execPath); } catch { return execPath; }
  for (const dir of pathList.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    // The program's own folder may come first on PATH; only a link to it is stable (#840 review).
    try { if (fs.lstatSync(candidate).isSymbolicLink() && fs.realpathSync(candidate) === real) return candidate; } catch { /* not here */ }
  }
  return execPath;
}

// Single quotes: the shell expands nothing inside them (#840 review).
const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const commandFor = (paths, folder) => `${shellQuote(stableNode())} ${shellQuote(paths.installed)} capture ${folder}`;

/// Add (or remove) this program as each folder's status line. A folder with a
/// status line of its own is left alone. settings.json keeps its other keys,
/// its mode, and a one-time backup beside it; an account folder without one
/// gets a new file holding only the status line (#838 review).
export function setStatusLine(folders, { install = true, paths = capturePaths(), source = null } = {}) {
  const results = [];
  if (install && source != null) {
    fs.mkdirSync(path.dirname(paths.installed), { recursive: true, mode: 0o700 });
    // Status lines may be running it: replace it whole, never truncate it (#838 review).
    writeWhole(paths.installed, source, 0o644);
  }
  for (const folder of folders) {
    if (!FOLDER.test(folder)) { results.push([folder, 'refused: bad folder name']); continue; }
    const file = path.join(paths.accountsDir, folder, 'settings.json');
    let text = null;
    let settings;
    try { text = fs.readFileSync(file, 'utf8'); settings = JSON.parse(text); } catch (error) {
      if (error.code !== 'ENOENT') { results.push([folder, 'skipped: settings.json unreadable']); continue; }
      if (!install) { results.push([folder, 'nothing to remove']); continue; }
      if (!accountUuid(paths.accountsDir, folder)) { results.push([folder, 'skipped: not an account folder']); continue; }
      settings = {};
    }
    // Ours under either spelling: quoted for the shell, or as first installed (#840 review).
    const command = settings.statusLine?.command;
    const ours = typeof command === 'string' && [shellQuote(paths.installed), paths.installed].some((p) => command.includes(p));
    if (install && settings.statusLine && !ours) { results.push([folder, 'skipped: has its own status line']); continue; }
    if (!install && !ours) { results.push([folder, 'nothing to remove']); continue; }
    const backup = `${file}.bak-modeldeck-statusline`;
    const mode = text == null ? 0o600 : fs.statSync(file).mode & 0o777;
    if (install && text != null && !fs.existsSync(backup)) fs.writeFileSync(backup, text, { mode });
    if (install) settings.statusLine = { type: 'command', command: commandFor(paths, folder) };
    else delete settings.statusLine;
    writeWhole(file, `${JSON.stringify(settings, null, 2)}\n`, mode);
    results.push([folder, install ? 'installed' : 'removed']);
  }
  return results;
}

async function main(argv) {
  const [mode, ...folders] = argv;
  if (mode === 'capture') {
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 1_000_000) return; }
    try { capture(folders[0], JSON.parse(text)); } catch { /* never disturb the terminal */ }
    return;
  }
  if (mode === 'install' || mode === 'uninstall') {
    const source = mode === 'install' ? fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') : null;
    for (const [folder, result] of setStatusLine(folders, { install: mode === 'install', source })) {
      process.stdout.write(`${folder}: ${result}\n`);
    }
    return;
  }
  process.stderr.write('usage: direct-statusline.mjs capture <folder> | install <folder>... | uninstall <folder>...\n');
  process.exitCode = 2;
}

const isMain = (() => {
  // Real paths on both sides: Node resolves links in import.meta.url, and
  // macOS's temp and home paths can reach the file through one.
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) await main(process.argv.slice(2)).catch(() => { process.exitCode = 1; });
