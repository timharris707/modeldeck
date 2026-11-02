# The deterministic multi-profile config linter

Charter position: control-plane grilling 2026-08-17, item 9(A): "config audit →
build as the deterministic multi-profile linter, sequenced after Receipts v1."
Receipts v1 has shipped (the diagnostician detectors run in the released
daemon), so this is next in the arc. Decision 0032 applies: zero LLM, the
product never spends subscription quota. Decision 0034's scope note applies:
config artifacts at rest are the linter's approved input; live harness state is
not.

Grounding: `src/paths.mjs` (the directory estate), `src/shared-scope.mjs` (how
profiles are actually read and what already gets skipped silently),
docs/ACCOUNT_ONBOARDING.md, docs/CLAUDE_IDENTITY.md, docs/incidents/, decisions
0016/0017, and the closed-issue record. That record covers #62, #66, #99, #108,
plus #161, #224, #263, #300, #484, #486, #514, and #515. Every rule below cites
the incident it would have caught. Rules with no incident behind them were left
out on purpose.

## 1. What it is

A deterministic checker that reads ModelDeck's multi-profile estate — the
Claude profile homes, the Codex homes, the activation symlinks, the shell
pinning, the per-profile settings files, and the proxy's non-secret routing
metadata — and reports misconfigurations as findings with a severity, plain
evidence, and a suggested fix. It changes nothing. Blume's context-engineering
audit proved the product shape (a versioned registry of typed checks); ours is
the deterministic, zero-LLM version of that shape, pointed at account/identity
plumbing rather than prompt quality.

Explicitly not in scope for v1: linting CLAUDE.md / skills / hook *content*
quality (that is Blume's LLM territory and stays dead per grilling 9B), and
anything requiring judgment rather than a decidable predicate.

## 2. What it reads (the whole input surface, closed)

- The Claude profiles directory (`CLAUDE_PROFILES_DIR`) and each profile home:
  directory perms/ownership, `settings.json`, `.claude.json` structure and
  non-secret top-level keys only (using the byte-offset reading discipline
  `src/shared-scope.mjs` already established: OAuth/account bytes are outside
  the boundary), `memory/` link state.
- The activation symlinks `~/.claude` and `~/.codex`, and the Codex homes under
  `<DATA_DIR>/codex-profiles/` including the identifier-only `tokens.account_id` field
  of each `auth.json` — the same read the daemon's #108 duplicate detection
  already performs; token values never read past the identifier.
- The shell pinning pair: the generated block in `~/.zshenv` and the env file
  `claude-env.sh` (`CLAUDE_SHELL_ENV_FILE`).
- CLIProxyAPI's config dir: config presence, `.mgmt-key` file perms (never its
  contents), and the non-secret `weight` / `excluded-models` / identity fields
  of auth files (the read the daemon already does for `/api/state`).
- launchd state for ModelDeck's own daemon and the proxy, via read-only
  `launchctl print` (exit status, spawn-failure codes).
- The daemon's own store, for facts the daemon already computed (account
  roster, detected CLI version, duplicate-token fingerprints). The linter
  consumes these rather than re-deriving them.

## 3. Rule inventory (v1)

Severities: **error** = identity or data is being silently mis-attributed, or a
managed function is dead; **warn** = drift that will bite on the next
activation/login/update; **info** = hygiene.

Each shipped rule carries, Blume-registry style but deterministic: a stable id,
the predicate, the incident source, the CLI version(s) the underlying behavior
claim was verified against, and a suggested fix in plain words. The
version-provenance field exists because this repo has twice recorded CLI
behavior beliefs that hand-testing later falsified (#263's notes); a rule whose
behavior claim predates the installed CLI version reports itself as unverified
instead of asserting.

| id | check | severity | incident source |
| --- | --- | --- | --- |
| MD-L01 | `apiKeyHelper` present in a managed profile's `settings.json` (kills the identity read, so auto-renewal silently dies) | error | #263 |
| MD-L02 | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` set in a managed profile's `settings.json` env | error | #224 |
| MD-L03 | `ANTHROPIC_BASE_URL` in `settings.json` pointing somewhere other than the expected proxy origin, or present on a profile the proxy roster doesn't know | warn | #224 (the classification half) |
| MD-L04 | `~/.claude` missing, not a symlink, or resolving outside the managed profiles dir while managed accounts exist; same for `~/.codex` vs `<DATA_DIR>/codex-profiles` (or its override), including a stale legacy target after migration | error | #62, #66, #647, onboarding runbook |
| MD-L05 | Shell pinning absent or stale: no generated block in `~/.zshenv`, or `claude-env.sh` pinning a profile that is not the active one, or the pinned pair `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR` diverging (the CLAUDE_IDENTITY.md invariant: divergence stores transcripts under one profile while authenticating as another) | error | #66, docs/CLAUDE_IDENTITY.md |
| MD-L06 | No Codex pinning while multiple Codex homes exist (a plain `codex login` then lands wherever `~/.codex` points, destroying another profile's single-use refresh token) | warn | #161 |
| MD-L07 | Duplicate identity: two Codex homes whose `auth.json` carry the same `tokens.account_id`, or the daemon's duplicate-token fingerprint (shared weekly reset instant) flagging two Claude profiles | error | #108, #161, docs/CLAUDE_IDENTITY.md |
| MD-L08 | Profile home or profiles root group/other-accessible or wrong owner (the shared-scope engine silently refuses such profiles today; the linter says so out loud) | warn | src/shared-scope.mjs managedProfiles() |
| MD-L09 | `.claude.json` unparseable, not an object, or not a regular file (today this only appears as a skipped-profile note inside shared-scope outcomes) | error | src/shared-scope.mjs readMcpDocument() |
| MD-L10 | `memory/` in a managed profile is a symlink pointing anywhere other than the shared memory dir while sharing is enabled, or a shared-scope backup/manifest inconsistency | warn | src/shared-scope.mjs, incident file 2026-07-20 |
| MD-L11 | Multiple `claude` executables of different versions reachable (daemon-PATH version vs login-Terminal version mismatch armed the #300 trap: version-checked one binary, executed another) | info | #300 |
| MD-L12 | ModelDeck daemon launchd job in spawn-failed state, exit code 78 (the stale launch-constraint class: launchd enforcing a constraint captured from an old binary) | error | #486, #514 |
| MD-L13 | Proxy auth dir: a weight-bearing auth file no registered account claims (a decommissioned account silently keeping a stale weight) | warn | rebalance cron's NOTE path |
| MD-L14 | Proxy `.mgmt-key` file missing while the proxy is managed, or readable by group/other | warn | managed-proxy-adoption.md |
| MD-L15 | `MODELDECK_*` environment overrides active on the running daemon that point config/auth dirs at different installs (the split the CLIPROXY_AUTH_DIR comment in paths.mjs guards: reporting on one install while reading auth metadata from another) | warn | PR #430 review note in paths.mjs |
| MD-L17 | The daemon's usage-queue consumer is on, but the proxy's `config.yaml` keeps unread usage records (`redis-usage-queue-retention-seconds`, default 60; proxy v8's `observability.usage` spelling wins when both exist) for less than two of the daemon's 5-minute pulls, so usage can be dropped before it is read. Only that one number is read from the file. MD-L16 is reserved for #585 | warn | #785 |

MD-L11 is `info` in v1. PATH enumeration is deterministic and sorted, but the
linter cannot establish every reachable executable's version without spawning
`claude --version`, which section 4 forbids. Its provenance records that limit,
and missing version evidence produces a could-not-evaluate info finding rather
than a warning.

v2 candidates, listed so they are not re-invented: importer side-effect files
left in repos (incident file, still-open sweep item), stale session pointers
after a restore (incident file "still broken" list), backups accumulation
bounds, and cross-checking the Keychain per-profile service-name scheme — that
last one is currently impossible under the no-Keychain-reads rule and stays out
unless Tim ever relaxes it (I recommend it stays out).

## 4. What it must never do

1. **No writes.** Report-only permanently. No auto-fix, no "apply" button.
   Suggested fixes are instructions (and where a runbook exists, a pointer to
   it).
2. **No Keychain reads**, not even metadata. The #99 forensics used Keychain
   timestamps; the linter never does. Identity questions are answered from
   files and daemon-owned state or not at all.
3. **No provider calls and no provider-CLI spawns.** It does not run `claude`
   or `codex` for anything, version probes included — it consumes the daemon's
   already-detected versions. Zero network beyond the daemon's own loopback
   API. Decision 0032 quota rule holds trivially: zero LLM of any kind.
4. **No live harness state** (0034): no session DBs, no transcript inference,
   no files under an active writer. Config artifacts at rest only.
5. **No secret bytes in memory or output.** `.claude.json` is read with the
   top-level byte-offset discipline; `auth.json` reads stop at the identifier;
   findings carry paths and non-secret evidence only. Never the live
   usage-queue endpoints (destructive read) and never ports 8317/3867 from
   test code.
6. **No guessing.** A rule either decides its predicate from evidence it can
   cite or reports "could not evaluate" with the reason. The deck showing
   Healthy while four accounts were cross-wired (#99) is the failure mode this
   whole tool exists to end; the linter must not reproduce it by optimism.

## 5. Placement: engine, CLI, daemon

The rules engine is one pure module in the daemon codebase (predicates over a
snapshot object), so the same code serves both callers:

- **CLI**: `modeldeck lint`, one-shot, exits nonzero when any error-severity
  finding exists. It is the v1 delivery vehicle and has no UI dependency.
- **Daemon**: the same engine runs on demand via an API endpoint, immediately
  at daemon startup, and then daily. Half the incident classes only change on
  activation, login, or update, so continuous watching adds contention without
  useful detection latency.

Findings data model (spec'd now so the UI can come later): rule id, severity,
scope (machine / profile id / file path), plain-English message, evidence list
(paths plus the observed values that decided the predicate), suggested fix
text, rule provenance (incident source, verified-against CLI versions), and a
stable fingerprint so re-runs can diff (new / persisting / resolved).

## 6. Where results surface

Settled by this spec: the data model above, the CLI output (human table plus
`--json`), and a daemon endpoint serving the latest findings.

The UI direction is approved for a later mockup, not this delivery: a single
count chip in Settings ("2 configuration problems") clicking through to a
findings list; deck cards get at most an inline marker on a profile with an
error-severity finding, with no new rows. No UI ships with v1. The linter sends
no notifications.

## 7. Failure modes of the linter itself

- A rule whose behavior claim is version-stamped older than the installed CLI
  reports unverified instead of firing (section 3).
- Unreadable input (permission, parse) becomes a "could not evaluate" finding
  on that rule and scope, never a crash and never a silent skip.
- The linter runs read-only, so its worst case is a wrong finding. False
  errors are the expensive kind (they train Tim to ignore the tool); when a
  predicate cannot reach certainty it reports at most warn. This asymmetry is
  deliberate.
- `POST /api/config-lint/run` has no rate cap beyond the mutation gate and
  in-flight request coalescing; this residual risk is accepted for v1.

## Rulings recorded

Tim recorded these rulings on issue #578 on 2026-08-25:

- v1 is CLI-first and the command is `modeldeck lint`;
- the daemon runs the linter on demand and daily;
- the linter sends no notifications;
- report-only is permanent;
- the UI direction is approved for a later mockup, and nothing UI ships in
  this delivery.
