import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertFetchedSource,
  cliProxyManifest,
  parseCLIProxyPin,
  readCLIProxyPin,
  resolveBundledCLIProxyPath,
  verifyCLIProxyArtifact,
} from '../scripts/cliproxyapi-pin.mjs';

const buildScript = new URL('../scripts/build-cliproxyapi.sh', import.meta.url);
const pinPath = new URL('../scripts/cliproxyapi-pin.json', import.meta.url);
const pinHelper = new URL('../scripts/cliproxyapi-pin.mjs', import.meta.url);
const releaseScript = new URL('../scripts/release-dmg.sh', import.meta.url);

function rawPin() {
  return JSON.parse(fs.readFileSync(pinPath, 'utf8'));
}

test('CLIProxyAPI pin records the resolved release, commit, and official Go archive', () => {
  const pin = readCLIProxyPin(fileURLToPath(pinPath));
  assert.deepEqual(pin, {
    repository: 'https://github.com/router-for-me/CLIProxyAPI',
    tag: 'v7.3.20',
    commit: 'ef9e71201e0ca72b03a540d9b6e0862f8c053347',
    goVersion: '1.26.4',
    goDarwinArm64Sha256: 'b62ad2b6d7d2464f12a5bcad7ff47f19d08325773b5efd21610e445a05a9bf53',
    bundlePath: 'Contents/Resources/cliproxyapi/cliproxyapi',
    version: '7.3.20',
  });
});

test('pin parsing refuses floating refs and missing or abbreviated commits', () => {
  assert.throws(
    () => parseCLIProxyPin({ ...rawPin(), tag: 'main' }),
    /floating refs are forbidden/,
  );

  const missingCommit = rawPin();
  delete missingCommit.commit;
  assert.throws(() => parseCLIProxyPin(missingCommit), /missing required string 'commit'/);
  assert.throws(
    () => parseCLIProxyPin({ ...rawPin(), commit: 'f43aad7' }),
    /full lowercase 40-character SHA/,
  );
});

test('source verification refuses tag/SHA mismatch, wrong HEAD, and dirty fetches', () => {
  const pin = parseCLIProxyPin(rawPin());
  const otherCommit = 'a'.repeat(40);

  assert.throws(
    () => assertFetchedSource(pin, {
      tagCommit: otherCommit,
      headCommit: pin.commit,
      dirty: false,
    }),
    /tag\/SHA mismatch/,
  );
  assert.throws(
    () => assertFetchedSource(pin, {
      tagCommit: pin.commit,
      headCommit: otherCommit,
      dirty: false,
    }),
    /checked-out HEAD/,
  );
  assert.throws(
    () => assertFetchedSource(pin, {
      tagCommit: pin.commit,
      headCommit: pin.commit,
      dirty: true,
    }),
    /source is dirty/,
  );
});

test('pin validator CLI makes tag/SHA mismatch a non-zero refusal', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(pinHelper),
    'verify-source',
    'a'.repeat(40),
    rawPin().commit,
    'clean',
    fileURLToPath(pinPath),
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag\/SHA mismatch/);
});

test('bundle staging path resolves from the pin without escaping the app', () => {
  const pin = parseCLIProxyPin(rawPin());
  const app = path.join(os.tmpdir(), 'ModelDeck.app');
  assert.equal(
    resolveBundledCLIProxyPath(app, pin),
    path.join(app, 'Contents', 'Resources', 'cliproxyapi', 'cliproxyapi'),
  );

  assert.throws(
    () => parseCLIProxyPin({ ...rawPin(), bundlePath: 'Contents/Resources/../MacOS/cliproxyapi' }),
    /normalized file below Contents\/Resources/,
  );
});

test('generated artifact manifest binds the signed bytes back to the current pin', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-cliproxy-manifest-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const binaryPath = path.join(temporary, 'cliproxyapi');
  const manifestPath = path.join(temporary, 'manifest.json');
  const pin = parseCLIProxyPin(rawPin());
  fs.writeFileSync(binaryPath, 'signed fixture bytes');

  const write = spawnSync(process.execPath, [
    fileURLToPath(pinHelper),
    'write-manifest',
    binaryPath,
    manifestPath,
    fileURLToPath(pinPath),
  ], { encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  assert.deepEqual(
    verifyCLIProxyArtifact({ binaryPath, manifestPath, pin }),
    cliProxyManifest({ binaryPath, pin }),
  );

  fs.appendFileSync(binaryPath, 'tampered');
  assert.throws(
    () => verifyCLIProxyArtifact({ binaryPath, manifestPath, pin }),
    /artifact manifest sha256 mismatch/,
  );
});

test('build script validates arguments and check-only stays offline', () => {
  const script = fileURLToPath(buildScript);
  let result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--fetch-go/);
  assert.match(result.stdout, /--handshake-only/);
  assert.match(result.stdout, /--handshake-port/);

  result = spawnSync('bash', [script, '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);

  result = spawnSync('bash', [script, '--handshake-port'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires a port/);

  result = spawnSync('bash', [script, '--check-only', '--handshake-port', 'not-a-port'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be an integer/);

  result = spawnSync('bash', [script, '--handshake-only', '/fixture/binary', '--fetch-go'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined/);

  result = spawnSync('bash', [script, '--check-only', '--handshake-port', '8317'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not use CLIProxyAPI's live default port 8317/);

  result = spawnSync('bash', [script, '--check-only', '--fetch-go', '--handshake-port', '18317'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pin and arguments are valid/);
  assert.match(result.stdout, /would fetch the exact source commit \+ tag/);
});

// PR #427 review (CodeRabbit security finding, fixed by the orchestrator):
// a version-matching local toolchain is not attestation, so a signing build
// only ever accepts the checksum-verified official archive. TRIPWIRE
// cliproxyapi-pinned-toolchain-only.
test('signing builds refuse unpinned Go toolchains without the explicit escape hatch', () => {
  const script = fileURLToPath(buildScript);

  let result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--allow-unpinned-go/);

  result = spawnSync('bash', [script, '--fetch-go', '--allow-unpinned-go'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contradictory/);

  // MD_GO_BINARY without the escape hatch fails BEFORE any fetch or build.
  result = spawnSync('bash', [script, '--handshake-port', '18317'], {
    encoding: 'utf8',
    env: { ...process.env, MD_GO_BINARY: '/bin/false' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MD_GO_BINARY bypasses the checksum-verified official toolchain/);

  const text = fs.readFileSync(buildScript, 'utf8');
  // The unpinned path exists ONLY inside the explicit escape hatch, and the
  // default path always goes through fetch_official_go's checksum gate.
  assert.match(text, /ALLOW_UNPINNED_GO" == 1 \]\]; then\n  echo "==> WARNING: --allow-unpinned-go bypasses/);
  assert.match(text, /\[\[ -z "\$GO_BINARY" \]\][^\n]*\n\s*\|\| fail "MD_GO_BINARY bypasses/);
});

test('build uses only pinned source and a checksum-pinned official Go toolchain', () => {
  const script = fs.readFileSync(buildScript, 'utf8');
  assert.match(script, /git -C "\$SOURCE_DIR" fetch --quiet --no-tags --depth=1 origin "\$PIN_COMMIT"/);
  assert.match(script, /refs\/tags\/\$PIN_TAG:refs\/tags\/\$PIN_TAG/);
  assert.match(script, /verify-source "\$TAG_COMMIT" "\$HEAD_COMMIT"/);
  assert.match(script, /status --porcelain --untracked-files=all/);
  assert.doesNotMatch(script, /CLIProxyAPI_[^\n]*darwin|releases\/download/);

  assert.match(script, /https:\/\/go\.dev\/dl\/\$archive_name/);
  assert.match(script, /"\$actual" == "\$GO_ARCHIVE_SHA256"/);
  assert.match(script, /GOTOOLCHAIN=local/);
  assert.doesNotMatch(script, /brew|homebrew/i);

  assert.match(script, /CGO_ENABLED=1/);
  assert.match(script, /GOOS=darwin/);
  assert.match(script, /GOARCH=arm64/);
  assert.match(script, /-mod=readonly -trimpath -buildvcs=false/);
  assert.match(script, /-buildid=/);
  assert.match(script, /\.\/cmd\/server\//);
});

test('signed build starts from no entitlements and performs the live handshake', () => {
  const script = fs.readFileSync(buildScript, 'utf8');
  assert.match(
    script,
    /codesign --force --options runtime --timestamp --sign "\$IDENTITY" "\$STAGED_BINARY"/,
  );
  assert.match(script, /signed CLIProxyAPI unexpectedly carries entitlements/);
  assert.match(script, /\/healthz/);
  assert.match(script, /\/v0\/management\/config/);
  assert.match(script, /Authorization: Bearer modeldeck-build-management-placeholder/);
  assert.match(script, /exec \/usr\/bin\/env -i/);
  assert.match(script, /HOME="\$handshake_dir\/home"/);
  assert.match(script, /-config "\$config" -local-model/);
  assert.match(script, /X-CPA-COMMIT/);
  assert.match(script, /X-CPA-VERSION/);
});

test('DMG assembly consumes the one pinned bundle path and signs it before the app', () => {
  const build = fs.readFileSync(buildScript, 'utf8');
  const helper = fs.readFileSync(pinHelper, 'utf8');
  const release = fs.readFileSync(releaseScript, 'utf8');
  const literalPath = rawPin().bundlePath;

  assert.doesNotMatch(build, new RegExp(literalPath));
  assert.doesNotMatch(helper, new RegExp(literalPath));
  assert.doesNotMatch(release, new RegExp(literalPath));
  assert.match(release, /bundle-path "\$APP" "\$CLIPROXY_PIN"/);
  assert.match(release, /verify-artifact "\$CLIPROXY_BINARY" "\$CLIPROXY_MANIFEST"/);
  assert.match(release, /cp "\$CLIPROXY_BINARY" "\$CLIPROXY_APP_BINARY"/);
  assert.ok(release.includes(
    'codesign --force --options runtime --timestamp --sign "$IDENTITY" \\\n  "$CLIPROXY_APP_BINARY"',
  ));
  assert.match(release, /embedded CLIProxyAPI unexpectedly carries entitlements/);

  const nestedSign = release.indexOf('codesign embedded CLIProxyAPI');
  const appSign = release.indexOf('codesign app (hardened runtime, timestamp)');
  assert.ok(nestedSign > 0 && appSign > nestedSign, 'CLIProxyAPI must be signed before the outer app');
  assert.equal((release.match(/out="\$\(xcrun notarytool submit/g) ?? []).length, 1,
    'integration must reuse the existing notarize function, not add a parallel submission');
});
