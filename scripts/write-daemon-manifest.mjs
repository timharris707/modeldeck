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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
