#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { appcastItems, isPrereleaseVersion, isStrictVersion } from './generate-appcast.mjs';
import {
  DEFAULT_CLIPROXY_BINARY,
  verifyCLIProxyCompatibilityEvidence,
} from './cliproxyapi-compat.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Issue #705: these guards also run in appcast-only mode, before signing.
export function validateReleaseChannel({ version, beta = false, notes = '', stableAppcast }) {
  // CodeRabbit (PR #710): one strict SemVer validator for versions and floors.
  if (!isStrictVersion(version)) throw new Error(`invalid release VERSION (strict SemVer required): ${version}`);
  const prerelease = isPrereleaseVersion(version);
  if (prerelease && !beta) throw new Error('prerelease VERSION requires --beta');
  if (beta && !prerelease) throw new Error('--beta requires a prerelease VERSION');
  const floorLine = notes.match(/^Rollback floor: (\S+)[ \t]*\r?$/m)?.[1];
  const floor = floorLine === 'unchanged' || isStrictVersion(floorLine) ? floorLine : undefined;
  if (/schema/i.test(notes) && !floor) throw new Error('schema release notes require a Rollback floor: <version|unchanged> line');
  if (/^Rollback floor:/m.test(notes) && !floor) throw new Error('invalid Rollback floor line');
  if (stableAppcast !== undefined && appcastItems(stableAppcast).some(item => item.channel !== null || item.version?.includes('-'))) {
    throw new Error('stable appcast must not contain a channel item or prerelease');
  }
  return floor ?? 'unchanged';
}

async function main() {
  const args = process.argv.slice(2);
  let beta = false, channelOnly = false, version, notesPath, stablePath;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--beta': beta = true; break;
      case '--channel-only': channelOnly = true; break;
      case '--version': case '--notes': case '--stable-appcast': {
        // CodeRabbit (PR #710): a trailing option with no value must not
        // silently fall back to the repo default.
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`${args[i]} requires a value`);
        if (args[i] === '--version') version = value;
        else if (args[i] === '--notes') notesPath = value;
        else stablePath = value;
        i += 1;
        break;
      }
      default: throw new Error(`unknown argument: ${args[i]}`);
    }
  }
  version ??= readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
  notesPath ??= path.join(repoRoot, 'docs/release-notes', `${version}.md`);
  if (!channelOnly) stablePath ??= path.join(repoRoot, 'dist/appcast.xml');
  const floor = validateReleaseChannel({ version, beta,
    notes: existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '',
    stableAppcast: stablePath && existsSync(stablePath) ? readFileSync(stablePath, 'utf8') : undefined,
  });
  if (channelOnly) { process.stdout.write(`${floor}\n`); return; }

  // TRIPWIRE version-sources-agree (0.4.6 go-live field find): the app bundle
  // stamps VERSION while the daemon inlines package.json's version — bumping
  // only one shipped a 0.4.6 app whose daemon reported 0.4.5 and failed the
  // runbook's health check. A release cannot proceed with the two out of step.
  const fileVersion = (await import('node:fs')).readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
  const packageVersion = JSON.parse(
    (await import('node:fs')).readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ).version;
  if (fileVersion !== packageVersion) {
    process.stderr.write(`release-checks: VERSION file (${fileVersion}) and package.json (${packageVersion}) disagree — bump both\n`);
    process.exit(1);
  }
  process.stdout.write(`==> version sources agree: ${fileVersion}\n`);

  // TRIPWIRE mirror-deliverables-present (issue #425): the repo-root NOTICES
  // and the app-bundle Credits.rtf are the two MIT-notice channels (source
  // mirror and shipped binary). A release with either missing or empty would
  // ship bundled MIT components without their required attribution.
  {
    const fs = await import('node:fs');
    // Marker strings, not just non-emptiness: a placeholder or truncated file
    // must not pass. NOTICES carries every vendored component's full text;
    // Credits.rtf carries the two primary MIT notices and points at NOTICES
    // (also staged into the app bundle by release-dmg.sh) for the rest.
    const requiredMarkers = {
      NOTICES: [
        'CLIProxyAPI', 'Luis Pater', 'Router-For.ME', 'MIT License',
        'Sparkle', 'Andy Matuschak', 'Colin Percival', 'Yuta Mori',
        'Orson Peters', 'Mark Hamlin',
      ],
      'macos/ModelDeckMac/Resources/Credits.rtf': [
        'CLIProxyAPI', 'Luis Pater', 'Router-For.ME', 'MIT License',
        'Sparkle', 'Andy Matuschak', 'NOTICES',
      ],
    };
    for (const [rel, markers] of Object.entries(requiredMarkers)) {
      const file = path.join(repoRoot, rel);
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        process.stderr.write(`release-checks: third-party notice file missing or empty: ${rel}\n`);
        process.exit(1);
      }
      const text = fs.readFileSync(file, 'utf8');
      const missing = markers.filter((marker) => !text.includes(marker));
      if (missing.length > 0) {
        process.stderr.write(`release-checks: ${rel} lacks required notice marker(s): ${missing.join(', ')}\n`);
        process.exit(1);
      }
    }
    process.stdout.write('==> third-party notice files complete (NOTICES, Credits.rtf)\n');
  }

  const checks = [
    ['prototype chart round-trip click-test', 'test/dashboard-overview-clicktest.test.mjs'],
    ['#374 fit-floor boundary test', 'test/usage-estimate.test.mjs'],
  ];

  for (const [name, file] of checks) {
    process.stdout.write(`==> ${name}\n`);
    const result = spawnSync(process.execPath, ['--test', file], { cwd: repoRoot, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }

  process.stdout.write('==> CLIProxyAPI pin-bump compatibility evidence\n');
  try {
    const evidence = verifyCLIProxyCompatibilityEvidence({ binaryPath: DEFAULT_CLIPROXY_BINARY });
    process.stdout.write(`    ${evidence.pin.tag} ${evidence.binarySha256}\n`);
  } catch (error) {
    process.stderr.write(
      `release-checks: ${error.message} — build the pinned binary, then run npm run test:cliproxyapi-pin\n`,
    );
    process.exit(1);
  }

  process.stdout.write('==> release checks passed\n');

}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  await main();
}
