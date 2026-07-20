import fs from 'node:fs';
import path from 'node:path';

const IGNORED = new Set(['node_modules', '.git', '.next', '.claude', '.turbo', 'dist', 'build', 'coverage']);
const MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.git'];

function displayName(projectPath) {
  const packagePath = path.join(projectPath, 'package.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
  } catch {}
  return path.basename(projectPath);
}

function looksLikeProject(entryPath) {
  return MARKERS.some((marker) => fs.existsSync(path.join(entryPath, marker)));
}

export function scanProjectRoot(root) {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) throw new Error(`project root does not exist: ${absoluteRoot}`);
  if (!fs.statSync(absoluteRoot).isDirectory()) throw new Error(`project root must be a directory: ${absoluteRoot}`);
  const resolvedRoot = fs.realpathSync(absoluteRoot);
  const seen = new Set();
  const projects = [];
  for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
    const entryPath = fs.realpathSync(path.join(resolvedRoot, entry.name));
    const key = entryPath.toLocaleLowerCase('en-US');
    if (seen.has(key) || !looksLikeProject(entryPath)) continue;
    seen.add(key);
    projects.push({ name: displayName(entryPath), path: entryPath, detected: true });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
