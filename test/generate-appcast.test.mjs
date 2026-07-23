// Issue #121 — appcast generation for Sparkle 2 in-app updates.
// Tests the Node-testable half of the release pipeline's new step: XML
// shape, sign_update integration seam, and the loud fail-with-instructions
// gating when the EdDSA key/tool is absent. Sparkle itself is not under
// test; sign_update is stubbed, and the only "key" involved is the clearly
// fake fixture in test/fixtures/sparkle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, renderAppcast, edSignature } from '../scripts/generate-appcast.mjs';

const script = fileURLToPath(new URL('../scripts/generate-appcast.mjs', import.meta.url));
const releaseDmgScript = fileURLToPath(new URL('../scripts/release-dmg.sh', import.meta.url));
const fakeKeyFile = fileURLToPath(
  new URL('../test/fixtures/sparkle/TEST_ed25519_private_key.txt', import.meta.url));

const FAKE_SIGNATURE = 'FAKEsigFAKEsigFAKEsigFAKEsigFAKEsigFAKEsigFAKEsigFAKEsigFAKEsigFAKEsigFAKEsigFAKEsig00==';

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldeck-appcast-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/// A stand-in DMG with known bytes/size.
function writeDmg(dir, bytes = 4096) {
  const dmg = path.join(dir, 'ModelDeck-0.9.9.dmg');
  fs.writeFileSync(dmg, Buffer.alloc(bytes, 7));
  return dmg;
}

/// Stub sign_update: succeeds ONLY when called with the fake fixture key
/// file (mirroring the real tool's "no key → hard failure" behavior) and
/// reports the actual file length like the real tool does.
function writeSignUpdateStub(dir, { requireKeyFile = true, lengthOverride = null, fail = false } = {}) {
  const stub = path.join(dir, 'sign_update');
  const lines = [
    '#!/bin/sh',
    fail
      ? 'echo "ERROR! Unable to access the private key in the Keychain" >&2; exit 1'
      : [
          requireKeyFile
            ? 'case "$1" in -f) KEY="$2"; ARCHIVE="$3";; *) echo "ERROR! No signing key found in the Keychain" >&2; exit 1;; esac'
            : 'ARCHIVE="$1"',
          '[ -f "$KEY" ] || { echo "ERROR! key file missing" >&2; exit 1; }',
          lengthOverride === null
            ? 'LEN=$(wc -c < "$ARCHIVE" | tr -d "[:space:]")'
            : `LEN=${lengthOverride}`,
          `printf 'sparkle:edSignature="${FAKE_SIGNATURE}" length="%s"\\n' "$LEN"`,
        ].join('\n'),
  ];
  fs.writeFileSync(stub, `${lines.join('\n')}\n`, { mode: 0o755 });
  return stub;
}

function runScript(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('appcast XML carries version, build, url, length, signature, pubDate', (t) => {
  const dir = tmpdir(t);
  const dmg = writeDmg(dir, 8192);
  const stub = writeSignUpdateStub(dir);
  const out = path.join(dir, 'appcast.xml');
  const result = runScript([
    '--version', '0.9.9', '--build', '512',
    '--dmg', dmg,
    '--url', 'https://github.com/timharris707/modeldeck/releases/download/v0.9.9/ModelDeck-0.9.9.dmg',
    '--release-notes-url', 'https://github.com/timharris707/modeldeck/releases/tag/v0.9.9',
    '--sign-update', stub, '--key-file', fakeKeyFile,
    '--pub-date', 'Wed, 22 Jul 2026 12:00:00 +0000',
    '--out', out,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const xml = fs.readFileSync(out, 'utf8');
  assert.match(xml, /<rss version="2.0" xmlns:sparkle="http:\/\/www\.andymatuschak\.org\/xml-namespaces\/sparkle">/);
  assert.match(xml, /<title>ModelDeck 0\.9\.9<\/title>/);
  assert.match(xml, /<sparkle:version>512<\/sparkle:version>/);
  assert.match(xml, /<sparkle:shortVersionString>0\.9\.9<\/sparkle:shortVersionString>/);
  assert.match(xml, /<sparkle:minimumSystemVersion>14\.0<\/sparkle:minimumSystemVersion>/);
  assert.match(xml, /<pubDate>Wed, 22 Jul 2026 12:00:00 \+0000<\/pubDate>/);
  assert.match(xml, /url="https:\/\/github\.com\/timharris707\/modeldeck\/releases\/download\/v0\.9\.9\/ModelDeck-0\.9\.9\.dmg"/);
  assert.match(xml, /length="8192"/);
  assert.match(xml, new RegExp(`sparkle:edSignature="${FAKE_SIGNATURE}"`));
  assert.match(xml, /<sparkle:releaseNotesLink>https:\/\/github\.com\/timharris707\/modeldeck\/releases\/tag\/v0\.9\.9<\/sparkle:releaseNotesLink>/);
});

test('missing signing key fails loudly with generate_keys instructions', (t) => {
  const dir = tmpdir(t);
  const dmg = writeDmg(dir);
  // Stub behaves like the real tool with an empty Keychain: no -f → error.
  const stub = writeSignUpdateStub(dir);
  const result = runScript([
    '--version', '0.9.9', '--build', '512', '--dmg', dmg,
    '--url', 'https://example.invalid/ModelDeck.dmg',
    '--sign-update', stub,
    '--out', path.join(dir, 'appcast.xml'),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generate_keys/);
  assert.match(result.stderr, /Keychain/);
});

test('sign_update hard failure propagates with instructions, writes nothing', (t) => {
  const dir = tmpdir(t);
  const dmg = writeDmg(dir);
  const stub = writeSignUpdateStub(dir, { fail: true });
  const out = path.join(dir, 'appcast.xml');
  const result = runScript([
    '--version', '0.9.9', '--build', '512', '--dmg', dmg,
    '--url', 'https://example.invalid/ModelDeck.dmg',
    '--sign-update', stub, '--key-file', fakeKeyFile,
    '--out', out,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generate_keys/);
  assert.equal(fs.existsSync(out), false);
});

test('missing sign_update tool fails with resolve instructions', (t) => {
  const dir = tmpdir(t);
  const dmg = writeDmg(dir);
  const result = runScript([
    '--version', '0.9.9', '--build', '512', '--dmg', dmg,
    '--url', 'https://example.invalid/ModelDeck.dmg',
    '--sign-update', path.join(dir, 'nope/sign_update'),
    '--out', path.join(dir, 'appcast.xml'),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /swift package resolve|generate_keys/);
});

test('length mismatch between sign_update and the DMG refuses to publish', (t) => {
  const dir = tmpdir(t);
  const dmg = writeDmg(dir, 4096);
  const stub = writeSignUpdateStub(dir, { lengthOverride: 999 });
  const result = runScript([
    '--version', '0.9.9', '--build', '512', '--dmg', dmg,
    '--url', 'https://example.invalid/ModelDeck.dmg',
    '--sign-update', stub, '--key-file', fakeKeyFile,
    '--out', path.join(dir, 'appcast.xml'),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mismatched appcast/);
});

test('parseArgs validates version and build shapes', () => {
  assert.throws(() => parseArgs(['--version', 'abc', '--build', '1', '--dmg', 'x', '--url', 'y', '--out', 'z']),
    /not a dotted version/);
  assert.throws(() => parseArgs(['--version', '1.2.3', '--build', 'x1', '--dmg', 'x', '--url', 'y', '--out', 'z']),
    /not an integer/);
  assert.throws(() => parseArgs(['--version', '1.2.3']), /--build is required/);
  assert.throws(() => parseArgs(['--bogus', '1']), /unknown argument/);
});

test('renderAppcast escapes XML special characters', () => {
  const xml = renderAppcast({
    version: '1.0.0', build: '1',
    url: 'https://example.invalid/a?b=1&c=2',
    length: 10, signature: 'sig"with<chars>',
    pubDate: 'Wed, 22 Jul 2026 12:00:00 +0000',
  });
  assert.match(xml, /b=1&amp;c=2/);
  assert.match(xml, /sig&quot;with&lt;chars&gt;/);
  assert.doesNotMatch(xml, /releaseNotesLink/); // optional and absent here
});

test('edSignature seam parses the real tool output shape', (t) => {
  const dir = tmpdir(t);
  const dmg = writeDmg(dir, 2048);
  const stub = writeSignUpdateStub(dir);
  const signed = edSignature({ signUpdate: stub, keyFile: fakeKeyFile, dmg });
  assert.equal(signed.signature, FAKE_SIGNATURE);
  assert.equal(signed.length, 2048);
});

// release-dmg.sh integration: the --appcast-only mode exists precisely so
// the new release step is verifiable without signing identities, notary
// profiles, or a Swift build — an injected stub sign_update and the fake
// fixture key drive the same code path the real release runs.
test('release-dmg.sh --appcast-only generates the appcast next to the DMG', (t) => {
  const dir = tmpdir(t);
  const dmg = path.join(dir, 'ModelDeck-9.9.9.dmg');
  fs.writeFileSync(dmg, Buffer.alloc(1024, 3));
  const stub = writeSignUpdateStub(dir);
  const result = spawnSync('bash', [releaseDmgScript, '--appcast-only', dmg], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MD_SPARKLE_SIGN_UPDATE: stub,
      MD_SPARKLE_KEY_FILE: fakeKeyFile,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const out = path.join(dir, 'appcast.xml');
  assert.ok(fs.existsSync(out), 'appcast.xml written beside the DMG');
  const xml = fs.readFileSync(out, 'utf8');
  assert.match(xml, /<sparkle:shortVersionString>9\.9\.9<\/sparkle:shortVersionString>/);
  assert.match(xml, /length="1024"/);
  assert.match(xml, /releases\/download\/v9\.9\.9\/ModelDeck-9\.9\.9\.dmg/);
});

test('release-dmg.sh --appcast-only fails loudly without a signing key path', (t) => {
  const dir = tmpdir(t);
  const dmg = path.join(dir, 'ModelDeck-9.9.9.dmg');
  fs.writeFileSync(dmg, Buffer.alloc(64, 1));
  const stub = writeSignUpdateStub(dir); // requires -f; none injected → real-tool-like failure
  const result = spawnSync('bash', [releaseDmgScript, '--appcast-only', dmg], {
    encoding: 'utf8',
    env: { ...process.env, MD_SPARKLE_SIGN_UPDATE: stub, MD_SPARKLE_KEY_FILE: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generate_keys/);
});
