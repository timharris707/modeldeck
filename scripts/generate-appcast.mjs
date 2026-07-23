#!/usr/bin/env node
// generate-appcast.mjs — Issue #121: Sparkle 2 appcast for the ModelDeck
// release DMG. Called by scripts/release-dmg.sh after the DMG is signed,
// notarized, and stapled; also directly testable (node --test drives it with
// a stub sign_update and the clearly-fake test key in test/fixtures/sparkle).
//
// The appcast is a single-item RSS feed: newest release only. It is uploaded
// as an asset named "appcast.xml" on the SAME GitHub release as the DMG, and
// the app's SUFeedURL points at the STABLE redirect
//   https://github.com/timharris707/modeldeck/releases/latest/download/appcast.xml
// so the feed URL never changes while each release carries its own feed.
//
// EdDSA signing: delegates to Sparkle's own `sign_update` tool (from the
// resolved SwiftPM artifact). By default sign_update reads the private key
// from the login Keychain, where Tim's ONE-TIME `generate_keys` run put it —
// the key never exists in the repo or this script's environment. A key FILE
// (-f) is supported strictly for tests with the fake fixture key.
//
// Usage:
//   node scripts/generate-appcast.mjs \
//     --version 0.3.2 --build 456 \
//     --dmg dist/ModelDeck-0.3.2.dmg \
//     --url  https://github.com/timharris707/modeldeck/releases/download/v0.3.2/ModelDeck-0.3.2.dmg \
//     --release-notes-url https://github.com/timharris707/modeldeck/releases/tag/v0.3.2 \
//     --sign-update /path/to/sign_update \
//     [--key-file /path/to/TEST-key]   (tests only — real key stays in Keychain)
//     [--pub-date "Wed, 22 Jul 2026 12:00:00 +0000"]  (injectable for tests)
//     [--min-system 14.0] \
//     --out dist/appcast.xml
import { execFileSync } from "node:child_process";
import { statSync, writeFileSync, existsSync } from "node:fs";
import process from "node:process";

const KEY_HELP = `
generate-appcast: the Sparkle EdDSA signature step failed.

If the private key is missing, run Sparkle's one-time key generation ON THE
RELEASE MAC (stores the private key in the login Keychain; never in the repo):

    <sparkle-artifacts>/bin/generate_keys

Then print the PUBLIC key for Info.plist stamping with:

    <sparkle-artifacts>/bin/generate_keys -p

where <sparkle-artifacts> is the resolved SwiftPM artifact directory, e.g.
macos/ModelDeckMac/.build/artifacts/sparkle/Sparkle/bin. Re-run the release
after that. NEVER copy the private key into the repo, env vars, or scripts.
`;

function fail(message) {
  process.stderr.write(`generate-appcast: ERROR: ${message}\n`);
  process.exit(1);
}

export function parseArgs(argv) {
  const args = {};
  const flags = new Map([
    ["--version", "version"],
    ["--build", "build"],
    ["--dmg", "dmg"],
    ["--url", "url"],
    ["--release-notes-url", "releaseNotesUrl"],
    ["--sign-update", "signUpdate"],
    ["--key-file", "keyFile"],
    ["--pub-date", "pubDate"],
    ["--min-system", "minSystem"],
    ["--out", "out"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags.get(argv[i]);
    if (!key) throw new Error(`unknown argument: ${argv[i]}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} requires a value`);
    args[key] = argv[i + 1];
    i += 1;
  }
  for (const required of ["version", "build", "dmg", "url", "out"]) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(args.version)) {
    throw new Error(`--version '${args.version}' is not a dotted version`);
  }
  if (!/^\d+$/.test(args.build)) throw new Error(`--build '${args.build}' is not an integer`);
  return args;
}

/// Runs sign_update and parses `sparkle:edSignature="…" length="…"` from its
/// stdout. Loud, instructive failure when the tool or the key is missing.
export function edSignature({ signUpdate, keyFile, dmg }) {
  if (!signUpdate) {
    throw new Error(`no sign_update tool provided (--sign-update). ${KEY_HELP}`);
  }
  if (!existsSync(signUpdate)) {
    throw new Error(`sign_update not found at ${signUpdate} — resolve SwiftPM packages first (swift package resolve in macos/ModelDeckMac). ${KEY_HELP}`);
  }
  const toolArgs = keyFile ? ["-f", keyFile, dmg] : [dmg];
  let output;
  try {
    output = execFileSync(signUpdate, toolArgs, { encoding: "utf8" });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : "";
    throw new Error(`sign_update failed (${error.status ?? error.code}): ${stderr.trim()} ${KEY_HELP}`);
  }
  const sigMatch = output.match(/sparkle:edSignature="([^"]+)"/);
  const lenMatch = output.match(/length="(\d+)"/);
  if (!sigMatch || !lenMatch) {
    throw new Error(`could not parse sign_update output: ${output.trim()} ${KEY_HELP}`);
  }
  return { signature: sigMatch[1], length: Number(lenMatch[1]) };
}

function xmlEscape(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/// Pure appcast rendering — the shape under test.
export function renderAppcast({
  version,
  build,
  url,
  length,
  signature,
  pubDate,
  releaseNotesUrl,
  minSystem = "14.0",
}) {
  const notes = releaseNotesUrl
    ? `\n            <sparkle:releaseNotesLink>${xmlEscape(releaseNotesUrl)}</sparkle:releaseNotesLink>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
    <channel>
        <title>ModelDeck</title>
        <item>
            <title>ModelDeck ${xmlEscape(version)}</title>
            <pubDate>${xmlEscape(pubDate)}</pubDate>${notes}
            <sparkle:version>${xmlEscape(build)}</sparkle:version>
            <sparkle:shortVersionString>${xmlEscape(version)}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>${xmlEscape(minSystem)}</sparkle:minimumSystemVersion>
            <enclosure
                url="${xmlEscape(url)}"
                length="${length}"
                type="application/octet-stream"
                sparkle:edSignature="${xmlEscape(signature)}"
            />
        </item>
    </channel>
</rss>
`;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  if (!existsSync(args.dmg)) fail(`DMG not found: ${args.dmg}`);
  const dmgSize = statSync(args.dmg).size;
  let signed;
  try {
    signed = edSignature(args);
  } catch (error) {
    fail(error.message);
  }
  if (signed.length !== dmgSize) {
    fail(`sign_update reported length ${signed.length} but the DMG is ${dmgSize} bytes — refusing to publish a mismatched appcast`);
  }
  const xml = renderAppcast({
    version: args.version,
    build: args.build,
    url: args.url,
    length: signed.length,
    signature: signed.signature,
    pubDate: args.pubDate ?? new Date().toUTCString().replace("GMT", "+0000"),
    releaseNotesUrl: args.releaseNotesUrl,
    minSystem: args.minSystem ?? "14.0",
  });
  writeFileSync(args.out, xml);
  process.stdout.write(`generate-appcast: wrote ${args.out} (v${args.version}, build ${args.build}, ${signed.length} bytes)\n`);
}

// Import-safe for tests; executes only when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
