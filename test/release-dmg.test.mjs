import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const releaseScript = new URL('../scripts/release-dmg.sh', import.meta.url);

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runGuard(root, ...args) {
  return spawnSync('bash', ['scripts/release-dmg.sh', '--check-only', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function releaseRepository(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-release-guard-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'work');
  const origin = path.join(temporary, 'origin.git');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'));
  fs.copyFileSync(releaseScript, path.join(root, 'scripts', 'release-dmg.sh'));
  fs.writeFileSync(path.join(root, 'VERSION'), '0.0.0\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'clean\n');
  fs.writeFileSync(path.join(root, 'dist', 'tracked.txt'), 'allowed\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture baseline');
  git(temporary, 'init', '--bare', origin);
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-u', 'origin', 'main');
  return root;
}

test('release guard accepts a clean origin/main checkout and ignores dist changes', (t) => {
  const root = releaseRepository(t);
  let result = runGuard(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /repository guard OK/);
  assert.match(result.stdout, /packaged commit: [0-9a-f]{40}/);

  fs.appendFileSync(path.join(root, 'dist', 'tracked.txt'), 'rebuilt\n');
  result = runGuard(root);
  assert.equal(result.status, 0, result.stderr);
});

test('release guard refuses tracked changes and --allow-dirty warns loudly', (t) => {
  const root = releaseRepository(t);
  fs.appendFileSync(path.join(root, 'tracked.txt'), 'dirty\n');

  let result = runGuard(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracked working-tree changes would be packaged/);
  assert.match(result.stderr, /tracked\.txt/);

  result = runGuard(root, '--allow-dirty');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /!{20}/);
  assert.match(result.stderr, /RELEASE SAFETY OVERRIDE: --allow-dirty/);
});

test('release guard refuses a non-origin commit and --ref warns loudly', (t) => {
  const root = releaseRepository(t);
  fs.appendFileSync(path.join(root, 'tracked.txt'), 'committed locally\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'local fixture commit');

  let result = runGuard(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HEAD \([0-9a-f]{40}\) is not origin\/main/);

  result = runGuard(root, '--ref', 'HEAD');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /!{20}/);
  assert.match(result.stderr, /RELEASE SAFETY OVERRIDE: --ref overrides origin\/main/);
});

test('dmg installer art assets exist and the script stages them (#69)', () => {
  // The committed drag-to-Applications art the release script depends on.
  const backgroundPath = new URL('../design/dmg/modeldeck-installer-bg.png', import.meta.url);
  const dsStorePath = new URL('../design/dmg/DS_Store', import.meta.url);
  const background = fs.readFileSync(backgroundPath);
  const dsStore = fs.readFileSync(dsStorePath);
  // PNG magic + non-trivial size (a truncated/corrupt commit would be tiny).
  assert.deepEqual([...background.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(background.length > 10_000, 'background png suspiciously small');
  // .DS_Store buddy-allocator magic "Bud1" at offset 4.
  assert.equal(dsStore.subarray(4, 8).toString('latin1'), 'Bud1');

  const script = fs.readFileSync(releaseScript, 'utf8');
  // Staged into the DMG under the names the committed .DS_Store references.
  assert.match(script, /\.background\/modeldeck-installer-bg\.png/);
  assert.match(script, /cp "\$DMG_DS_STORE" "\$STAGING\/\.DS_Store"/);
  // Volume name must stay the FIXED "ModelDeck": the .DS_Store background
  // alias records the volume name, so a versioned volname orphans the art.
  assert.match(script, /hdiutil create -volname "ModelDeck" /);
  assert.doesNotMatch(script, /-volname "ModelDeck \$VERSION"/);
});

test('app icon asset exists and the script bundles it, Info.plist references it (#82)', () => {
  // Committed, reproducible via `swift scripts/generate-app-icon.swift`.
  const icnsPath = new URL('../design/icon/ModelDeck.icns', import.meta.url);
  const icns = fs.readFileSync(icnsPath);
  // .icns magic "icns" + non-trivial size (must carry the full 16..1024 set).
  assert.equal(icns.subarray(0, 4).toString('latin1'), 'icns');
  assert.ok(icns.length > 50_000, 'icns suspiciously small for a full size set');

  const script = fs.readFileSync(releaseScript, 'utf8');
  // Bundle assembly copies the icon under the CFBundleIconFile name, and
  // fails fast when the asset is missing.
  assert.match(script, /design\/icon\/ModelDeck\.icns/);
  assert.match(script, /cp "\$APP_ICON" "\$APP\/Contents\/Resources\/ModelDeck\.icns"/);
  assert.match(script, /app icon missing/);
  // DMG volume icon staged as .VolumeIcon.icns (best-effort attribute).
  assert.match(script, /cp "\$APP_ICON" "\$STAGING\/\.VolumeIcon\.icns"/);

  // Info.plist names the icon (without the .icns extension, per convention).
  const plist = fs.readFileSync(
    new URL('../macos/ModelDeckMac/Support/Info.plist', import.meta.url),
    'utf8'
  );
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>ModelDeck<\/string>/);
});

test('release guard --help prints the full header through the Idempotent note', (t) => {
  const root = releaseRepository(t);
  const result = spawnSync('bash', ['scripts/release-dmg.sh', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Idempotent: every run rebuilds/);
  assert.doesNotMatch(result.stdout, /set -euo pipefail/);
});

test('release signing uses a placeholder unless MD_SIGN_IDENTITY is set', () => {
  const script = fs.readFileSync(releaseScript, 'utf8');
  assert.match(script, /Developer ID Application: EXAMPLE DEVELOPER \(TEAMID1234\)/);
  assert.match(script, /IDENTITY="\$\{MD_SIGN_IDENTITY:-\$DEFAULT_IDENTITY\}"/);
  assert.match(script, /signing identity is still the placeholder; set MD_SIGN_IDENTITY/);
});

test('missing Sparkle artifacts dir fails loudly, not with a silent exit', (t) => {
  // v0.3.2 regression: in a pristine worktree .build/artifacts does not
  // exist, find exits nonzero, and under `set -euo pipefail` that status
  // escaped the command substitution and killed the script BEFORE the
  // intended fail() message. --appcast-only exercises locate_sign_update
  // on exactly that path without needing credentials or a build.
  const root = releaseRepository(t);
  const dmg = path.join(root, 'dist', 'ModelDeck-0.0.0.dmg');
  fs.writeFileSync(dmg, 'not a real dmg');
  const result = spawnSync('bash', ['scripts/release-dmg.sh', '--appcast-only', dmg], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MD_SPARKLE_SIGN_UPDATE: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Sparkle sign_update tool not found/);
  assert.match(result.stderr, /Sparkle EdDSA key setup/);
});

test('Sparkle preflight find pipelines cannot die silently under pipefail', () => {
  const script = fs.readFileSync(releaseScript, 'utf8');
  // Every artifacts-dir find must neutralize its exit status so an absent
  // directory reaches the loud fail() instead of tripping set -e.
  const finds = script
    .split('\n')
    .filter((line) => /^[^#]*\bfind "\$PACKAGE_DIR\/\.build\/artifacts"/.test(line));
  assert.ok(finds.length >= 2, 'expected the sign_update and generate_keys lookups');
  for (const line of finds) {
    assert.match(line, /\|\| true/, `find lookup can silently kill the script: ${line.trim()}`);
  }
  // A pristine worktree has no artifacts until SwiftPM resolves; the script
  // must resolve before the Sparkle preflight rather than fail on it.
  assert.match(script, /swift package resolve --package-path "\$PACKAGE_DIR"/);
});

test('resource bundle ships with an Info.plist and a loud preflight (#151)', () => {
  // v0.3.3 field crash (public report modeldeck#1): the packaged
  // ModelDeckMac_ModelDeckMacCore.bundle was loose PNGs with no Info.plist,
  // Bundle(url:) rejected it, and Bundle.module trapped on first popover
  // open. Three layers guard the regression:
  // 1. Package.swift declares defaultLocalization so SwiftPM generates the
  //    bundle's Info.plist in the first place.
  const packageSwift = fs.readFileSync(
    new URL('../macos/ModelDeckMac/Package.swift', import.meta.url),
    'utf8'
  );
  assert.match(packageSwift, /defaultLocalization:\s*"en"/);

  const script = fs.readFileSync(releaseScript, 'utf8');
  // 2. Belt-and-braces: the script synthesizes a minimal plist if a future
  //    toolchain stops emitting one (CFBundlePackageType=BNDL et al.).
  assert.match(script, /synthesizing a minimal one \(issue #151\)/);
  assert.match(script, /Add :CFBundlePackageType string BNDL/);
  assert.match(script, /Add :CFBundleIdentifier string /);
  assert.match(script, /Add :CFBundleName string /);
  // 3. Loud preflight before signing: plist must EXIST (PlistBuddy Print
  //    creates a missing file and exits 0, so a bare Print is not enough),
  //    must print, and all six provider PNGs must be present.
  assert.match(script, /resource bundle preflight/);
  assert.match(script, /"\$PACKAGED_BUNDLE\/Info\.plist" "\$PACKAGED_BUNDLE\/Contents\/Info\.plist"/);
  assert.match(script, /resource bundle has NO Info\.plist/);
  assert.match(script, /PlistBuddy -c Print "\$BUNDLE_PLIST"/);
  assert.match(script, /resource bundle Info\.plist does not print via PlistBuddy/);
  for (const provider of ['claude', 'codex']) {
    for (const px of [32, 64, 128]) {
      assert.match(script, new RegExp(`provider-${provider}-${px}\\.png`));
    }
  }
  assert.match(script, /missing provider icon/);
  // The preflight must run BEFORE any codesign call so a bad bundle can
  // never reach signing/notarization.
  const preflightAt = script.indexOf('resource bundle preflight');
  const firstSignAt = script.indexOf('codesign --force');
  assert.ok(preflightAt > 0 && firstSignAt > 0 && preflightAt < firstSignAt,
    'resource bundle preflight must precede the first codesign');
});

test('release assembly requires, stages, and signs the self-contained daemon (#91)', () => {
  const script = fs.readFileSync(releaseScript, 'utf8');
  assert.match(script, /DAEMON_BINARY="\$DIST_DIR\/daemon\/modeldeckd"/);
  assert.match(script, /daemon binary missing or not executable/);
  assert.match(script, /run scripts\/build-daemon-binary\.sh first/);
  assert.match(script, /mkdir -p "\$APP\/Contents\/MacOS" "\$APP\/Contents\/Resources\/daemon"/);
  assert.match(script, /cp "\$DAEMON_BINARY" "\$APP\/Contents\/Resources\/daemon\/modeldeckd"/);
  assert.match(script, /codesign --force --options runtime --timestamp \\\n\s+--entitlements "\$REPO_ROOT\/scripts\/daemon-entitlements\.plist" --sign "\$IDENTITY" \\\n\s+"\$APP\/Contents\/Resources\/daemon\/modeldeckd"/);
  assert.match(script, /release assembly will require: \$DAEMON_BINARY/);
  assert.match(script, /stage \$DAEMON_BINARY in Contents\/Resources\/daemon/);
});
