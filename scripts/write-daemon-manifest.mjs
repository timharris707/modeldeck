#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function daemonManifest({ binaryPath, nodeVersion, gitCommit }) {
  return {
    artifact: path.basename(binaryPath),
    nodeVersion,
    MDGitCommit: gitCommit || null,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'),
  };
}

// Both sides must be realpath'd: Node resolves the entry module's URL through
// symlinks while argv[1] stays as typed, so under a symlinked checkout (e.g.
// mktemp's /var/folders -> /private/var) a plain comparison silently skips the
// CLI branch and the manifest is never written.
function realpathOrSelf(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

const invokedAsCli = process.argv[1]
  && realpathOrSelf(process.argv[1]) === realpathOrSelf(fileURLToPath(import.meta.url));

if (invokedAsCli) {
  const [, , binaryPath, outputPath, nodeVersion, gitCommit = ''] = process.argv;
  if (!binaryPath || !outputPath || !nodeVersion) {
    process.stderr.write('usage: write-daemon-manifest.mjs <binary> <output> <node-version> [git-commit]\n');
    process.exit(2);
  }
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(daemonManifest({ binaryPath, nodeVersion, gitCommit }), null, 2)}\n`,
  );
}
