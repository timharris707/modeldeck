#!/usr/bin/env bash
# sync-mirror.sh — publish a scrubbed snapshot of committed HEAD.
#
# Usage:
#   MD_SCRUB_PATTERNS=/path/to/patterns scripts/sync-mirror.sh [--check-only] [--push] MIRROR_DIR MESSAGE
#
# MD_SCRUB_PATTERNS must name a readable file containing one extended regular
# expression per line. Blank lines and lines beginning with # are ignored.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

fail() { echo "sync-mirror.sh: ERROR: $*" >&2; exit 1; }

CHECK_ONLY=0
PUSH=0
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --push) PUSH=1 ;;
    -h|--help)
      awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
      exit 0
      ;;
    --) shift; POSITIONAL+=("$@"); break ;;
    -*) fail "unknown argument: $1" ;;
    *) POSITIONAL+=("$1") ;;
  esac
  shift
done

[[ ${#POSITIONAL[@]} -eq 2 ]] \
  || fail "usage: MD_SCRUB_PATTERNS=<file> $0 [--check-only] [--push] MIRROR_DIR MESSAGE"
[[ "$CHECK_ONLY" == 0 || "$PUSH" == 0 ]] || fail "--push cannot be combined with --check-only"

MIRROR_DIR="${POSITIONAL[0]}"
MESSAGE="${POSITIONAL[1]}"
PATTERN_FILE="${MD_SCRUB_PATTERNS:-}"
[[ -n "$PATTERN_FILE" ]] || fail "MD_SCRUB_PATTERNS must name a scrub-pattern file"
[[ -r "$PATTERN_FILE" ]] || fail "scrub-pattern file is not readable: $PATTERN_FILE"
PATTERN_FILE="$(cd "$(dirname "$PATTERN_FILE")" && pwd -P)/$(basename "$PATTERN_FILE")"

git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || fail "$REPO_ROOT is not a git checkout"
DIRTY="$(git -C "$REPO_ROOT" status --porcelain)"
[[ -z "$DIRTY" ]] || {
  echo "sync-mirror.sh: ERROR: source tree is dirty; commit or stash these paths:" >&2
  printf '%s\n' "$DIRTY" >&2
  exit 1
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/modeldeck-mirror-sync.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SNAPSHOT="$WORK_DIR/snapshot"
ACTIVE_PATTERNS="$WORK_DIR/patterns"
mkdir -p "$SNAPSHOT"

echo "==> archiving committed HEAD"
git -C "$REPO_ROOT" archive HEAD | tar -x -C "$SNAPSHOT"

# This list is intentionally duplicated in docs/RELEASE.md for operator
# visibility. Keep both locations synchronized.
STRIPPED_PATHS=(
  ".claude"
  "docs/HANDOFF.md"
  "docs/ACCOUNT_ONBOARDING.md"
  "docs/lane-routing-policy.md"
  "docs/live-proxy-ops.md"
  "docs/linux-install.md"
  "docs/incidents"
  "scripts/lane-codex.sh"
  "scripts/lane-watch.mjs"
  "scripts/live-proxy-swap.sh"
  "test/lane-codex-args.test.mjs"
  "design/mac-app-roadmap.md"
  "ops"
  ".github/workflows/test-linux.yml"
)
for stripped_path in "${STRIPPED_PATHS[@]}"; do
  rm -rf -- "$SNAPSHOT/$stripped_path"
done

# TRIPWIRE stripped-test-subjects: a test that directly resolves a stripped
# repo path cannot survive in the mirror without its subject.
for stripped_path in "${STRIPPED_PATHS[@]}"; do
  while IFS= read -r -d '' test_file; do
    if grep -F -- "../$stripped_path" "$test_file" \
      | grep -E '^[[:space:]]*(const|let|var)[[:space:]]+[^=]+=[[:space:]]*new[[:space:]]+URL[[:space:]]*\(' \
      >/dev/null; then
      fail "surviving test ${test_file#"$SNAPSHOT/"} references stripped path $stripped_path"
    fi
  done < <(find "$SNAPSHOT/test" -type f -name '*.test.mjs' -print0 2>/dev/null)
done

# A repository-local pattern file may contain private terms. Remove that exact
# file from the snapshot before staging; external pattern files need no action.
case "$PATTERN_FILE" in
  "$REPO_ROOT"/*)
    PATTERN_RELATIVE="${PATTERN_FILE#"$REPO_ROOT"/}"
    rm -rf "$SNAPSHOT/$PATTERN_RELATIVE"
    ;;
esac

awk 'NF && $0 !~ /^[[:space:]]*#/' "$PATTERN_FILE" > "$ACTIVE_PATTERNS"

run_scrub_gate() {
  local repository="$1" status
  if MATCHES="$(git -C "$repository" grep --cached -a -l -E -f "$ACTIVE_PATTERNS" -- . 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" -le 1 ]] \
    || fail "scrub grep failed; validate the regular expressions in MD_SCRUB_PATTERNS"
  if [[ -n "$MATCHES" ]]; then
    echo "sync-mirror.sh: ERROR: scrub patterns matched these staged files:" >&2
    printf '%s\n' "$MATCHES" >&2
    exit 1
  fi
}

# Stage the candidate snapshot in an isolated repository so the scrub gate
# examines precisely the tree that would be committed, never untracked files.
git -C "$SNAPSHOT" init -q
git -C "$SNAPSHOT" add -A
run_scrub_gate "$SNAPSHOT"
echo "==> scrub gate passed"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo "==> check-only complete; mirror clone was not touched"
  exit 0
fi

MIRROR_DIR="$(git -C "$MIRROR_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "mirror directory is not a non-bare git working tree: $MIRROR_DIR"
[ "$MIRROR_DIR" != "$REPO_ROOT" ] \
  || fail "mirror directory must not be the source checkout itself"
MIRROR_DIRTY="$(git -C "$MIRROR_DIR" status --porcelain)"
[[ -z "$MIRROR_DIRTY" ]] || fail "mirror clone is dirty; commit or discard its changes first"

echo "==> syncing snapshot into mirror clone"
rsync -a --delete --exclude=.git/ "$SNAPSHOT/" "$MIRROR_DIR/"
git -C "$MIRROR_DIR" add -A

# Re-run the gate against the real mirror index immediately before commit.
run_scrub_gate "$MIRROR_DIR"

if git -C "$MIRROR_DIR" diff --cached --quiet; then
  echo "==> mirror already matches committed HEAD; no commit created"
else
  GIT_AUTHOR_NAME="ModelDeck Mirror Sync" \
    GIT_AUTHOR_EMAIL="mirror-sync@example.invalid" \
    GIT_COMMITTER_NAME="ModelDeck Mirror Sync" \
    GIT_COMMITTER_EMAIL="mirror-sync@example.invalid" \
    git -C "$MIRROR_DIR" \
    -c user.name="ModelDeck Mirror Sync" \
    -c user.email="mirror-sync@example.invalid" \
    -c commit.gpgsign=false \
    commit -m "Sync: $MESSAGE"
fi

if [[ "$PUSH" == 1 ]]; then
  echo "==> pushing mirror commit"
  git -C "$MIRROR_DIR" push
else
  echo "==> mirror commit kept local (pass --push to publish)"
fi
