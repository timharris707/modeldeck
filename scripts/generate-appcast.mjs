#!/usr/bin/env node
// generate-appcast.mjs — Issue #121: Sparkle 2 appcast for the ModelDeck
// release DMG. Called by scripts/release-dmg.sh after the DMG is signed,
// notarized, and stapled; also directly testable (node --test drives it with
// a stub sign_update and the clearly-fake test key in test/fixtures/sparkle).
//
// Issue #705: each feed carries signed release history. It is uploaded
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
//     [--release-notes-file docs/release-notes/0.3.2.md]  (issue #685: embedded as <description>)
//     --sign-update /path/to/sign_update \
//     [--key-file /path/to/TEST-key]   (tests only — real key stays in Keychain)
//     [--pub-date "Wed, 22 Jul 2026 12:00:00 +0000"]  (injectable for tests)
//     [--min-system 14.0] \
//     [--channel beta] [--merge-existing previous-appcast.xml] \
//     [--rollback-floor <version|unchanged>] [--stable-only] \
//     --out dist/appcast.xml
import { execFileSync } from "node:child_process";
import { statSync, writeFileSync, existsSync, realpathSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
    ["--release-notes-file", "releaseNotesFile"],
    ["--sign-update", "signUpdate"],
    ["--key-file", "keyFile"],
    ["--pub-date", "pubDate"],
    ["--min-system", "minSystem"],
    ["--out", "out"],
    ["--channel", "channel"],
    ["--merge-existing", "mergeExisting"],
    ["--rollback-floor", "rollbackFloor"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--stable-only") { args.stableOnly = true; continue; }
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
  if (args.channel !== undefined && !/^[0-9A-Za-z._-]+$/.test(args.channel)) throw new Error('invalid --channel name');
  if (args.version !== undefined && !isStrictVersion(args.version)) throw new Error(`invalid --version (strict SemVer required): ${args.version}`);
  if (args.rollbackFloor !== undefined && args.rollbackFloor !== "unchanged" && !isStrictVersion(args.rollbackFloor)) {
    throw new Error(`invalid --rollback-floor (strict SemVer or "unchanged"): ${args.rollbackFloor}`);
  }
  if (args.stableOnly && args.channel) throw new Error('--stable-only cannot carry a --channel');
  if (args.rollbackFloor && args.rollbackFloor !== 'unchanged' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args.rollbackFloor)) {
    throw new Error('invalid --rollback-floor version');
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

/// CDATA carries the release notes verbatim (markdown is full of `&`, `<`
/// and `>`); the one sequence CDATA cannot contain is its own terminator,
/// which is split across two sections.
function cdata(text) {
  return `<![CDATA[${String(text).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

// Issue #705: skip CDATA/comments while locating items, then carry the raw
// slices. Re-serializing old XML could change signed enclosure metadata.
// Issue #705 (CodeRabbit, PR #710): ONE strict SemVer 2.0.0 shape for release
// versions and rollback floors, used by every JavaScript entrypoint. No
// leading zeros, no empty identifiers, dot-separated prerelease only.
// Stricter than SemVer in one place on purpose: a prerelease identifier may
// not START with a hyphen (SemVer allows "--beta"; a tag like that is only
// ever a typo here).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z][0-9A-Za-z-]*))*))?$/;
export function isStrictVersion(value) {
  return typeof value === "string" && SEMVER.test(value);
}
export function isPrereleaseVersion(value) {
  return isStrictVersion(value) && value.includes("-");
}

export function appcastItems(xml) {
  const items = [];
  let start = null;
  for (const match of xml.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>/g)) {
    if (/^<item(?:\s|>)/.test(match[0])) start = match.index;
    if (match[0] !== '</item>' || start === null) continue;
    const raw = xml.slice(start, match.index + match[0].length);
    const metadata = raw.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, '');
    const field = name => metadata.match(new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`))?.[1]?.trim() ?? null;
    items.push({ raw, version: field('sparkle:shortVersionString'),
      channel: field('sparkle:channel') ?? (/<sparkle:channel\b/.test(metadata) ? '' : null),
      rollbackFloor: field('modeldeck:rollbackFloor') });
    start = null;
  }
  return items;
}

// Issue #705: numeric prerelease identifiers must keep beta.10 after beta.9.
export function compareVersions(a, b) {
  const parts = value => value.split('+')[0].split(/-(.*)/s).slice(0, 2);
  const [aCore, aPre] = parts(a);
  const [bCore, bPre] = parts(b);
  const compare = (left, right, prerelease = false) => {
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
      return BigInt(left) > BigInt(right) ? 1 : BigInt(left) < BigInt(right) ? -1 : 0;
    }
    if (prerelease && /^\d+$/.test(left) !== /^\d+$/.test(right)) return /^\d+$/.test(left) ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const ac = aCore.split('.'), bc = bCore.split('.');
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const order = compare(ac[i] ?? '0', bc[i] ?? '0');
    if (order) return order;
  }
  if (aPre === undefined || bPre === undefined) return aPre === bPre ? 0 : aPre === undefined ? 1 : -1;
  const ap = aPre.split('.'), bp = bPre.split('.');
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    const order = compare(ap[i], bp[i], true);
    if (order) return order;
  }
  return Math.sign(ap.length - bp.length);
}

/// Pure appcast rendering — the shape under test.
// Issue #705 (CodeRabbit, PR #710): a required prior feed that is empty or
// carries no versioned item would silently produce a one-item feed and drop
// the rollback history. Refuse it here so the release stops before writing.
export function readPriorFeed(file) {
  const xml = readFileSync(file, "utf8");
  if (!appcastItems(xml).some(item => item.version)) {
    throw new Error(`prior feed has no versioned items: ${file}`);
  }
  return xml;
}

export function renderAppcast({
  version,
  build,
  url,
  length,
  signature,
  pubDate,
  releaseNotesUrl,
  description,
  minSystem = "14.0",
  channel,
  existingXML = "",
  rollbackFloor = "unchanged",
  stableOnly = false,
}) {
  const older = appcastItems(existingXML).filter(item => item.version && item.version !== version);
  const stables = older.filter(item => item.channel === null && !item.version.includes("-"))
    .sort((a, b) => compareVersions(b.version, a.version));
  const newestStable = channel ? stables[0]?.version : version;
  const carriedStables = stables.filter(item => channel || compareVersions(item.version, version) < 0)
    .slice(0, channel ? 4 : 3);
  const betas = stableOnly ? [] : older.filter(item => item.channel === "beta"
    && (!newestStable || compareVersions(item.version, newestStable) > 0));
  const carried = [...carriedStables, ...betas].sort((a, b) => compareVersions(b.version, a.version));
  const floor = rollbackFloor === "unchanged"
    ? (carriedStables[0]?.rollbackFloor || version) : rollbackFloor;
  const notes = releaseNotesUrl
    ? `\n            <sparkle:releaseNotesLink>${xmlEscape(releaseNotesUrl)}</sparkle:releaseNotesLink>`
    : "";
  // Issue #685: the release notes body rides the appcast as <description>,
  // so the app reads version, notes, and link from the ONE feed Sparkle
  // installs from. Absent when no notes file was given (pre-#685 shape).
  const body = description !== undefined && description !== null
    ? `\n            <description>${cdata(description)}</description>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:modeldeck="https://modeldeck.ai/appcast">
    <channel>
        <title>ModelDeck</title>
        <item>
            <title>ModelDeck ${xmlEscape(version)}</title>
            <pubDate>${xmlEscape(pubDate)}</pubDate>${notes}${body}
            <sparkle:version>${xmlEscape(build)}</sparkle:version>
            <sparkle:shortVersionString>${xmlEscape(version)}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>${xmlEscape(minSystem)}</sparkle:minimumSystemVersion>${channel ? `\n            <sparkle:channel>${xmlEscape(channel)}</sparkle:channel>` : ""}
            <modeldeck:rollbackFloor>${xmlEscape(floor)}</modeldeck:rollbackFloor>
            <enclosure
                url="${xmlEscape(url)}"
                length="${length}"
                type="application/octet-stream"
                sparkle:edSignature="${xmlEscape(signature)}"
            />
        </item>${carried.map(item => `\n        ${item.raw}`).join("")}
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
  if (args.releaseNotesFile && !existsSync(args.releaseNotesFile)) {
    fail(`release notes file not found: ${args.releaseNotesFile}`);
  }
  const description = args.releaseNotesFile
    ? readFileSync(args.releaseNotesFile, "utf8")
    : undefined;
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
    channel: args.channel,
    existingXML: args.mergeExisting ? readPriorFeed(args.mergeExisting) : "",
    rollbackFloor: args.rollbackFloor,
    stableOnly: args.stableOnly,
    version: args.version,
    build: args.build,
    url: args.url,
    length: signed.length,
    signature: signed.signature,
    pubDate: args.pubDate ?? new Date().toUTCString().replace("GMT", "+0000"),
    releaseNotesUrl: args.releaseNotesUrl,
    description,
    minSystem: args.minSystem ?? "14.0",
  });
  writeFileSync(args.out, xml);
  process.stdout.write(`generate-appcast: wrote ${args.out} (v${args.version}, build ${args.build}, ${signed.length} bytes)\n`);
}

// Import-safe for tests; executes only when run directly.
//
// The v0.3.9/v0.3.10 release flake (roadmap "appcast reported written but
// absent"): the release runs from a mktemp worktree under /var/folders — a
// symlink to /private/var/folders — and Node canonicalizes the MAIN entry
// module's URL (realpath, preserve-symlinks off) while process.argv[1]
// keeps the symlinked spelling. The naive `file://${argv[1]}` comparison
// then fails, main() silently never runs, and node exits 0 — the caller
// prints "appcast written" for a file that does not exist. Canonicalize
// argv[1] the same way (and URL-encode via pathToFileURL) before comparing;
// release-dmg.sh additionally asserts the output file exists post-write.
const entryHref = (() => {
  if (!process.argv[1]) return null;
  try { return pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return null; }
})();
if (entryHref === import.meta.url) {
  main();
}
