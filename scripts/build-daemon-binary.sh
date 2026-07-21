#!/usr/bin/env bash
# build-daemon-binary.sh — bundle and package modeldeckd as a Node SEA.
#
# Usage: scripts/build-daemon-binary.sh [--check-only] [--allow-dirty] [--fetch-node]
#
# Produces dist/daemon/modeldeckd and dist/daemon/manifest.json. On macOS the
# copied Node binary is stripped before injection and ad-hoc signed afterward;
# release-dmg.sh replaces that signature with the release identity.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/dist/daemon"
OUTPUT_BINARY="$OUTPUT_DIR/modeldeckd"
OUTPUT_MANIFEST="$OUTPUT_DIR/manifest.json"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"
POSTJECT="$REPO_ROOT/node_modules/.bin/postject"

fail() { echo "build-daemon-binary.sh: ERROR: $*" >&2; exit 1; }
warn_override() {
  echo >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo "!! RELEASE SAFETY OVERRIDE: $*" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo >&2
}
tracked_dirt() {
  git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- \
    . ':(exclude)dist' ':(exclude)dist/**'
}

CHECK_ONLY=0
ALLOW_DIRTY=0
FETCH_NODE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --fetch-node) FETCH_NODE=1 ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "build-daemon-binary.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || fail "$REPO_ROOT is not a git checkout"

DIRTY_TRACKED="$(tracked_dirt)"
if [[ -n "$DIRTY_TRACKED" ]]; then
  if [[ "$ALLOW_DIRTY" == 1 ]]; then
    warn_override "--allow-dirty builds these tracked changes:"
    printf '%s\n' "$DIRTY_TRACKED" >&2
  else
    echo "build-daemon-binary.sh: ERROR: tracked working-tree changes would be built:" >&2
    printf '%s\n' "$DIRTY_TRACKED" >&2
    echo "build-daemon-binary.sh: commit/stash them, or use --allow-dirty explicitly" >&2
    exit 1
  fi
elif [[ "$ALLOW_DIRTY" == 1 ]]; then
  warn_override "--allow-dirty was supplied (the tracked tree is currently clean)"
fi

RUNNING_NODE_BINARY="$(command -v node)" || fail "could not locate the running node binary"
RUNNING_NODE_VERSION="$("$RUNNING_NODE_BINARY" --version)" || fail "node is required"
NODE_VERSION="$RUNNING_NODE_VERSION"
NODE_MAJOR="${RUNNING_NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 24 ]] \
  || fail "Node >=24 is required (found $RUNNING_NODE_VERSION)"
NODE_BINARY="$RUNNING_NODE_BINARY"

has_sea_fuse() {
  local binary="$1"
  local count
  count="$(grep -a -c NODE_SEA_FUSE "$binary" 2>/dev/null || true)"
  [[ "$count" =~ ^[0-9]+$ && "$count" -ge 1 ]]
}

validate_node_candidate() {
  local binary="$1"
  local source="$2"
  [[ -f "$binary" && -x "$binary" ]] || fail "$source is not an executable file: $binary"
  has_sea_fuse "$binary" || fail "$source has no NODE_SEA_FUSE sentinel: $binary"

  local candidate_version candidate_major
  candidate_version="$("$binary" --version 2>/dev/null)" \
    || fail "could not run $source: $binary"
  candidate_major="${candidate_version#v}"
  candidate_major="${candidate_major%%.*}"
  [[ "$candidate_major" == "$NODE_MAJOR" ]] \
    || fail "$source is $candidate_version, but the running Node is $RUNNING_NODE_VERSION; major versions must match"
  if [[ "$candidate_version" != "$RUNNING_NODE_VERSION" ]]; then
    echo "build-daemon-binary.sh: WARNING: $source is $candidate_version while the running Node is $RUNNING_NODE_VERSION; continuing because the major versions match" >&2
  fi
  NODE_BINARY="$binary"
  NODE_VERSION="$candidate_version"
}

fetch_official_node() {
  [[ "$(uname -s)" == Darwin ]] \
    || fail "--fetch-node currently supports macOS only (found $(uname -s))"
  local machine node_arch dist_name archive_name base_url cache_dir tarball sums_file expected actual cached_binary
  machine="$(uname -m)"
  case "$machine" in
    arm64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *) fail "--fetch-node does not support macOS architecture: $machine" ;;
  esac
  dist_name="node-${RUNNING_NODE_VERSION}-darwin-${node_arch}"
  archive_name="${dist_name}.tar.gz"
  base_url="https://nodejs.org/dist/${RUNNING_NODE_VERSION}"
  cache_dir="$REPO_ROOT/.cache/node-sea"
  tarball="$cache_dir/$archive_name"
  sums_file="$cache_dir/SHASUMS256-${RUNNING_NODE_VERSION}.txt"
  cached_binary="$cache_dir/${dist_name}-node"
  mkdir -p "$cache_dir"

  command -v curl >/dev/null 2>&1 || fail "curl is required by --fetch-node"
  echo "==> fetching official Node checksum list for $RUNNING_NODE_VERSION"
  curl --fail --location --proto '=https' --tlsv1.2 \
    "$base_url/SHASUMS256.txt" -o "$sums_file.download"
  mv "$sums_file.download" "$sums_file"
  if [[ ! -f "$tarball" ]]; then
    echo "==> fetching official Node binary $archive_name"
    curl --fail --location --proto '=https' --tlsv1.2 \
      "$base_url/$archive_name" -o "$tarball.download"
    mv "$tarball.download" "$tarball"
  fi

  expected="$(awk -v name="$archive_name" '$2 == name || $2 == "*" name { print $1; exit }' "$sums_file")"
  [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] \
    || fail "$archive_name is not listed with a valid SHA-256 in the published SHASUMS256.txt"
  actual="$("$RUNNING_NODE_BINARY" -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const h=crypto.createHash("sha256"); h.update(fs.readFileSync(process.argv[1])); process.stdout.write(h.digest("hex"));' "$tarball")"
  [[ "$actual" == "$expected" ]] \
    || fail "SHA-256 mismatch for $tarball (published $expected, got $actual)"

  echo "==> extracting bin/node from verified $archive_name"
  rm -f "$cache_dir/node"
  tar -xzf "$tarball" -C "$cache_dir" --strip-components=2 "$dist_name/bin/node"
  mv "$cache_dir/node" "$cached_binary"
  chmod 755 "$cached_binary"
  validate_node_candidate "$cached_binary" "downloaded official Node"
  [[ "$NODE_VERSION" == "$RUNNING_NODE_VERSION" ]] \
    || fail "downloaded official Node version does not exactly match $RUNNING_NODE_VERSION"
}

if ! has_sea_fuse "$NODE_BINARY"; then
  if [[ -n "${MD_NODE_BINARY:-}" ]]; then
    validate_node_candidate "$MD_NODE_BINARY" "MD_NODE_BINARY"
  elif [[ "$FETCH_NODE" == 1 ]]; then
    fetch_official_node
  else
    fail "the running Node binary has no NODE_SEA_FUSE sentinel: $RUNNING_NODE_BINARY. Set MD_NODE_BINARY to an official nodejs.org Node $NODE_MAJOR binary, or rerun with --fetch-node to download and SHA-256-verify the official $RUNNING_NODE_VERSION macOS binary"
  fi
fi
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify HEAD 2>/dev/null || true)"
PACKAGE_VERSION="$("$RUNNING_NODE_BINARY" -p 'require(process.argv[1]).version' "$REPO_ROOT/package.json")"

echo "==> modeldeckd SEA build"
echo "    node:       $NODE_VERSION ($NODE_BINARY)"
echo "    version:    $PACKAGE_VERSION"
echo "    git commit: ${GIT_COMMIT:-unavailable}"
echo "    binary:     $OUTPUT_BINARY"
echo "    manifest:   $OUTPUT_MANIFEST"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo "==> check-only: would bundle src/server.mjs, inject a Node SEA, ad-hoc sign on macOS, write the manifest, and smoke-check GET /api/health"
  exit 0
fi

[[ -x "$ESBUILD" ]] || fail "esbuild is missing; run npm install"
[[ -x "$POSTJECT" ]] || fail "postject is missing; run npm install"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/modeldeck-daemon-build.XXXXXX")"
DAEMON_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" >/dev/null 2>&1 || true
    wait "$DAEMON_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

BUNDLE="$BUILD_DIR/modeldeckd.cjs"
SEA_CONFIG="$BUILD_DIR/sea-config.json"
SEA_BLOB="$BUILD_DIR/sea-prep.blob"
STAGED_BINARY="$BUILD_DIR/modeldeckd"
VERSION_DEFINE="$("$RUNNING_NODE_BINARY" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$PACKAGE_VERSION")"

echo "==> bundling daemon and embedded usage probe"
"$ESBUILD" "$REPO_ROOT/src/server.mjs" \
  --bundle --platform=node --target=node24 --format=cjs \
  --define:__MODELDECK_VERSION__="$VERSION_DEFINE" \
  --define:import.meta.url='"file:///__modeldeck_sea_bundle__.mjs"' \
  --outfile="$BUNDLE"

"$NODE_BINARY" -e 'const fs=require("node:fs"); const [main,output]=process.argv.slice(1); fs.writeFileSync(process.argv[3], JSON.stringify({main, output, disableExperimentalSEAWarning: true}));' \
  "$BUNDLE" "$SEA_BLOB" "$SEA_CONFIG"
"$NODE_BINARY" --experimental-sea-config "$SEA_CONFIG"

cp "$NODE_BINARY" "$STAGED_BINARY"
chmod 755 "$STAGED_BINARY"
POSTJECT_ARGS=(
  "$STAGED_BINARY" NODE_SEA_BLOB "$SEA_BLOB"
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
)
if [[ "$(uname -s)" == Darwin ]]; then
  echo "==> removing Node signature before SEA injection"
  codesign --remove-signature "$STAGED_BINARY"
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi

echo "==> injecting SEA blob"
"$POSTJECT" "${POSTJECT_ARGS[@]}"
if [[ "$(uname -s)" == Darwin ]]; then
  echo "==> applying ad-hoc signature (release-dmg.sh applies the real identity later)"
  codesign --force --options runtime \
  --entitlements "$REPO_ROOT/scripts/daemon-entitlements.plist" --sign - "$STAGED_BINARY"
fi

publish_artifacts() {
  mkdir -p "$OUTPUT_DIR"
  cp "$STAGED_BINARY" "$OUTPUT_BINARY"
  chmod 755 "$OUTPUT_BINARY"
  "$RUNNING_NODE_BINARY" "$REPO_ROOT/scripts/write-daemon-manifest.mjs" \
    "$OUTPUT_BINARY" "$OUTPUT_MANIFEST" "$NODE_VERSION" "$GIT_COMMIT"
}

echo "==> smoke-checking GET /api/health"
SMOKE_DIR="$BUILD_DIR/smoke"
SMOKE_LOG="$BUILD_DIR/smoke.log"
mkdir -p "$SMOKE_DIR"
MODELDECK_DB_PATH="$SMOKE_DIR/modeldeck.sqlite" \
MODELDECK_DATA_DIR="$SMOKE_DIR/data" \
MODELDECK_PROJECTS_ROOT="$SMOKE_DIR/projects" \
MODELDECK_MUTATION_TOKEN="build-smoke-placeholder" \
MODELDECK_PORT=0 \
  "$STAGED_BINARY" >"$SMOKE_LOG" 2>&1 &
DAEMON_PID=$!

SMOKE_URL=""
for _ in {1..100}; do
  if grep -q 'listen EPERM' "$SMOKE_LOG"; then
    echo "==> LOUD NOTE: smoke test skipped because this sandbox forbids socket bind (EPERM)" >&2
    SMOKE_PID="$DAEMON_PID"
    DAEMON_PID=""
    wait "$SMOKE_PID" >/dev/null 2>&1 || true
    publish_artifacts
    echo "==> built $OUTPUT_BINARY"
    exit 0
  fi
  SMOKE_URL="$(sed -nE 's/.*(http:\/\/127\.0\.0\.1:[0-9]+).*/\1/p' "$SMOKE_LOG" | head -1)"
  [[ -n "$SMOKE_URL" ]] && break
  kill -0 "$DAEMON_PID" >/dev/null 2>&1 || {
    sed 's/^/    /' "$SMOKE_LOG" >&2
    fail "daemon exited before its health endpoint became ready"
  }
  sleep 0.1
done
[[ -n "$SMOKE_URL" ]] || fail "timed out waiting for daemon startup"
HEALTH="$(curl --fail --silent --show-error "$SMOKE_URL/api/health")" || fail "GET /api/health failed"
"$RUNNING_NODE_BINARY" -e 'const body=JSON.parse(process.argv[1]); if (body.ok !== true || body.name !== "ModelDeck") process.exit(1)' "$HEALTH" \
  || fail "GET /api/health returned an unexpected payload: $HEALTH"
kill "$DAEMON_PID"
wait "$DAEMON_PID" >/dev/null 2>&1 || true
DAEMON_PID=""

publish_artifacts
echo "==> smoke check OK: $SMOKE_URL/api/health"
echo "==> built $OUTPUT_BINARY"
echo "    sha256: $("$RUNNING_NODE_BINARY" -p 'require(process.argv[1]).sha256' "$OUTPUT_MANIFEST")"
