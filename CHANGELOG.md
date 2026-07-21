# Changelog

All notable changes to ModelDeck are documented here. Versioning follows the
roadmap in `design/mac-app-roadmap.md`: `v0.1-web` tags the retired web MVP,
and `v0.2.0` ships when the Mac menu bar app reaches parity (Phase 6).

## Unreleased

## 0.2.1 — Real Claude identity switching + launch polish

### Added
- **Real per-account Claude identity switching (issue #62, PRs #63/#64)**:
  activation now scopes Claude Code's Keychain credential storage per profile
  (`CLAUDE_SECURESTORAGE_CONFIG_DIR` via `launchctl setenv` + a shell-env
  block installed by `scripts/install-shell-env.sh`). Each profile holds its
  own login after a one-time `/login` ceremony (`docs/CLAUDE_IDENTITY.md`).
  ModelDeck never reads, copies, or stores credentials.
- Honest activation verification: `effective` / `identity-mismatch` /
  `identity-unverified` states with label-only guidance; identity captured
  credential-free from each profile's `.claude.json` with trust-gated,
  backfill-only seeding and provenance; token-gated
  `POST /api/accounts/:id/reset-identity`.
- Menu bar icon right-click context menu: Check for App Updates… and Quit
  (issue #59).
- Settings → General: "Check for updates automatically" — daily check against
  the same public releases feed as the manual button, banner notification
  only, never installs (issue #60).
- Activation UX: tooltips explain the amber pending marker per state, and a
  **Complete Activation** button appears on the DB-active row when the link
  is pending (issue #61).

### Changed
- Cold launch renders an intentional muted "–%" placeholder instead of a
  blank menu bar percent, and settings application no longer flashes the
  filter buttons (issue #58).

- **Phase 7 — add-account flow (issue #8)**: 3-step "Add Account…" in the
  Settings window's Accounts pane. Step 1 creates the isolated owner-only
  profile home (native Claude profile home / `CODEX_HOME`); step 2 runs the
  provider's own login command in Terminal (browser OAuth stays entirely with
  the provider — ModelDeck never sees or stores credentials); step 3 reads
  back the authenticated identity ("Signed in as …"), pulls the first usage
  snapshot, and lands the account in the deck. New daemon endpoints:
  `POST /api/accounts` without `profileRef` now provisions Codex homes too,
  `GET /api/accounts/:id/login` (provider login command spec), and
  token-gated `POST /api/accounts/:id/verify` (identity read-back via the
  provider's status command — never a login or logout).
- ModelDeck-owned, owner-only Claude profile homes under Application Support.
- Explicit per-home migration from legacy claude-swap profiles, with atomic
  copying, rollback, and symlink refusal.

- Claude activation now atomically swaps the managed `~/.claude` symlink for
  new sessions and refuses to replace real data.
- Claude usage refresh now reads Anthropic's native OAuth usage endpoint per
  profile using only that profile's stored credential; it never logs in,
  refreshes credentials, or falls back to ambient auth variables.
- Claude launches now use the native CLI with a profile-scoped
  `CLAUDE_CONFIG_DIR`; the runtime dependency on `cswap` is removed.

### Fixed
- Claude CLI version gating: below the known-good floor (2.1.215) activation
  reports identity-unverified instead of pretending.

## 0.2.0 — Mac menu bar app (Phases 2–6)

The native macOS menu bar app reaches parity with the web dashboard
(design/mac-app-spec.md). Summary of the Mac app work:

### Added
- **Phase 2 — backend API extensions** (`src/`): `GET/PUT /api/settings`
  (validated keys: auto-refresh, interval, pause-while-active, layout,
  default sort, notification threshold, menu bar style), `GET /api/tools`
  (cached CLI probe — installed vs. latest version, auth state; `?refresh=1`
  forced re-probe is mutation-token-gated), `GET /api/capacity/worst`
  (worst-remaining evaluation for icon/notification state), and
  `POST /api/accounts/:id/activate`.
- **Phase 3 — Swift app shell** (`macos/ModelDeckMac/`): SwiftPM package
  (PanelyMac conventions, no `.xcodeproj`), `MenuBarExtra` with the template
  deck glyph, typed loopback `DaemonClient`, worst-remaining icon states
  (plain / gold % / red %), optional background auto-refresh.
- **Phase 4 — two-column deck popover**: Claude column left, Codex right,
  brand-mark headers, collapsing account rows (worst-window bar, % left,
  next reset), expanded per-window detail, next-reset / lowest-remaining
  sort, single-column alternate layout, "Updated N min ago" footer with
  manual Refresh.
- **Phase 5 — Activate switching**: one-click Activate in a row's expanded
  state (new sessions only, running sessions never touched), optimistic
  ACTIVE badge flip with post-switch verification against a fresh
  `/api/state`, inline error + revert on failure.
- **Phase 6 — Settings window**: native two-pane Settings scene.
  *Accounts*: roster with provider health chips ("Healthy" / "Sign in
  again" from the CLI tool probe), Edit (label / purpose / color via the
  daemon's account upsert), Remove behind a confirmation dialog (deletes
  only ModelDeck's reference, never provider credentials). *General*:
  auto-refresh toggle + interval + pause-while-active, popover layout,
  default sort, notification threshold, CLI tools status (installed vs.
  latest vs. auth state with a token-gated Check for Updates), launch at
  login. Settings live in the daemon (`GET/PUT /api/settings`) and apply
  live to the running popover/menu bar models.
- **Notifications**: macOS banner when the worst remaining % crosses the
  configured threshold (and again at critical). Fires only on worsening
  transitions — never repeated on every refresh — re-arms after recovery,
  and requests notification authorization lazily on first use.

### Changed
- `VERSION`/`package.json` to 0.2.0. The web dashboard retirement and the
  add-account flow remain scheduled for later phases (issues #8, #9).

## 0.1.1 — Phase 1: Persistence & service on the laptop (unreleased)

### Added
- `scripts/migrate-db.mjs`: migrates a staging SQLite database into the
  persistent Application Support location using SQLite backup semantics
  (`VACUUM INTO`), verifies `PRAGMA integrity_check` and row counts, strips
  staging project mappings (`/tmp/modeldeck-identity-stage/...`), and refuses
  to overwrite an existing target without `--force`.
- `deploy/ai.hermes.modeldeck.plist.template` plus
  `scripts/install-launch-agent.sh` / `scripts/uninstall-launch-agent.sh`:
  idempotent LaunchAgent install (label `ai.hermes.modeldeck`, RunAtLoad,
  KeepAlive on crash, logs under `~/Library/Logs/ModelDeck/`).
- `scripts/set-mutation-token.sh` and `src/token.mjs`: durable mutation token
  managed in the macOS Keychain (service `modeldeck`, account
  `mutation-token`), with `MODELDECK_MUTATION_TOKEN` as the documented
  env fallback for tests/CI and an ephemeral random token as the last resort.
- `VERSION` and this changelog (roadmap Phase 1 requirement).
- Tests for token resolution and the migration pipeline.

### Changed
- `/api/health` now reports the real package version and the mutation-token
  source (`env` / `keychain` / `ephemeral`) — never the token itself.
- `docs/HANDOFF.md` rewritten as the laptop deployment runbook (issue #1 was
  retargeted from the Mac mini to the laptop on 2026-07-19).

## 0.1.0 — Web dashboard MVP (`v0.1-web`)

- Local project-aware account and usage control plane: Node daemon,
  SQLite store, Claude (`cswap`) and Codex (per-profile `CODEX_HOME`)
  adapters, localhost web dashboard, CLI.
