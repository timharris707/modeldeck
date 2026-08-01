import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_PROFILE_EXPLAINER_START = '<!-- modeldeck:profile-explainer:v1 -->';
export const CLAUDE_PROFILE_EXPLAINER_END = '<!-- /modeldeck:profile-explainer:v1 -->';

// Issue #203: pinned, inert guidance installed in every managed Claude home.
// Keep this deliberately short and calm: it exists to prevent Claude from
// turning ModelDeck's per-account home into the subject of unrelated work.
export const CLAUDE_PROFILE_EXPLAINER_BLOCK = [
  CLAUDE_PROFILE_EXPLAINER_START,
  'This is a ModelDeck-managed Claude profile; ModelDeck is a multi-account manager.',
  'Treat this profile exactly like a normal Claude home.',
  'Do not narrate, explain, or investigate ModelDeck during unrelated work.',
  'Mention ModelDeck only if the user asks about it or the task is about ModelDeck itself.',
  'User-scope configuration on this machine, including MCP servers and memory, is per-profile.',
  "A tool registered under another account's profile may therefore be absent here.",
  CLAUDE_PROFILE_EXPLAINER_END,
  '',
].join('\n');

const START_BYTES = Buffer.from(CLAUDE_PROFILE_EXPLAINER_START);
const END_BYTES = Buffer.from(CLAUDE_PROFILE_EXPLAINER_END);

function markerRange(content) {
  const start = content.indexOf(START_BYTES);
  const firstEnd = content.indexOf(END_BYTES);
  if (start === -1) {
    if (firstEnd !== -1) throw new Error('Claude profile explainer has an end marker without a start marker');
    return null;
  }

  const end = content.indexOf(
    END_BYTES,
    start + START_BYTES.length,
  );
  if (end === -1) throw new Error('Claude profile explainer start marker has no end marker');

  const nestedStart = content.indexOf(
    START_BYTES,
    start + START_BYTES.length,
  );
  const anotherStart = content.indexOf(START_BYTES, end + END_BYTES.length);
  const anotherEnd = content.indexOf(END_BYTES, end + END_BYTES.length);
  if ((nestedStart !== -1 && nestedStart < end) || anotherStart !== -1 || anotherEnd !== -1) {
    throw new Error('Claude profile explainer markers are ambiguous');
  }

  // The line ending immediately after the end marker is emitted as part of
  // the managed block. Treating it as managed lets install + removal restore
  // every pre-existing byte, including a file with no final newline.
  let after = end + END_BYTES.length;
  if (content[after] === 0x0d && content[after + 1] === 0x0a) after += 2;
  else if (content[after] === 0x0a) after += 1;
  return { start, after };
}

async function readFile(file, fileSystem) {
  try {
    return { existed: true, content: await fileSystem.readFile(file) };
  } catch (error) {
    if (error.code === 'ENOENT') return { existed: false, content: Buffer.alloc(0) };
    throw error;
  }
}

async function atomicWrite(file, content, {
  fileSystem,
  randomUUID,
  pid,
  existed,
}) {
  let mode = 0o600;
  if (existed) mode = (await fileSystem.stat(file)).mode & 0o777;
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.modeldeck-${pid}-${randomUUID()}`,
  );
  try {
    await fileSystem.writeFile(temporary, content, { mode });
    await fileSystem.rename(temporary, file);
  } catch (error) {
    await fileSystem.unlink(temporary).catch(() => {});
    throw error;
  }
}

function dependencies(options) {
  return {
    fileSystem: options.fileSystem || fs.promises,
    randomUUID: options.randomUUID || crypto.randomUUID,
    pid: options.pid ?? process.pid,
  };
}

/// Create or reconcile the marker-delimited explainer in <profile>/CLAUDE.md.
/// Existing bytes before and after the block are copied verbatim. With no
/// block, the explainer is prepended so its own final newline supplies the
/// separator and removal can recover the exact original document.
export async function reconcileClaudeProfileExplainer({
  profileRef,
  block = CLAUDE_PROFILE_EXPLAINER_BLOCK,
  ...options
} = {}) {
  if (!profileRef) throw new Error('Claude profile home is required');
  const file = path.join(profileRef, 'CLAUDE.md');
  const deps = dependencies(options);
  const current = await readFile(file, deps.fileSystem);
  const range = markerRange(current.content);
  const blockBytes = Buffer.isBuffer(block) ? block : Buffer.from(block);
  const next = range
    ? Buffer.concat([current.content.subarray(0, range.start), blockBytes, current.content.subarray(range.after)])
    : Buffer.concat([blockBytes, current.content]);
  if (next.equals(current.content)) return { changed: false, file };
  await atomicWrite(file, next, { ...deps, existed: current.existed });
  return { changed: true, file };
}

/// Remove only the managed block. No production opt-out is exposed (the
/// guidance is inert); this inverse exists to keep the file operation fully
/// reversible and testable.
export async function removeClaudeProfileExplainer({ profileRef, ...options } = {}) {
  if (!profileRef) throw new Error('Claude profile home is required');
  const file = path.join(profileRef, 'CLAUDE.md');
  const deps = dependencies(options);
  const current = await readFile(file, deps.fileSystem);
  const range = markerRange(current.content);
  if (!range) return { changed: false, file };
  const next = Buffer.concat([current.content.subarray(0, range.start), current.content.subarray(range.after)]);
  await atomicWrite(file, next, { ...deps, existed: current.existed });
  return { changed: true, file };
}
