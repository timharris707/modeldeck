# Changelog

All notable changes to ModelDeck are documented here. Versioning follows the
roadmap in `design/mac-app-roadmap.md`: `v0.1-web` tags the retired web MVP,
and `v0.2.0` ships when the Mac menu bar app reaches parity (Phase 6).

## 0.3.1 — 2026-07-22

### Fixed
- **Deck cards now say "Sign in needed" instead of a bare stale age when an
  account's stored sign-in is missing or expired (issue #114)**: the daemon
  had been reporting `signin-required` per account all along, but the deck
  card only rendered the #89 "Data from N hr ago" line, with the real cause
  buried in a tooltip — on a multi-account deck this read as a silent
  refresh failure. The card now shows an actionable warning in the same
  visual family as the #98 Keychain notice, whose tooltip explains that
  Claude keeps only the ACTIVE account's sign-in fresh (CLI ≥ 2.1.216, issue
  #99) and points at Settings → Accounts to recover.
- **Probe failures from the bundled daemon no longer masquerade as a daemon
  crash (issue #114)**: the SEA binary dispatched the Claude usage probe
  through the daemon entry point, so any probe error was recorded as
  "ModelDeck failed to start: …" in per-account refresh errors. Both launch
  modes now share one probe CLI wrapper and report
  "Claude usage probe failed: …" identically.

## 0.3.0 — 2026-07-21

### Fixed
- **Your refresh interval now always wins over active CLI sessions (issue
  #90, Tim's design call)**: pause-while-active used to clamp scheduled
  refresh to every 30 minutes whenever any `claude`/`codex` process ran —
  silently overriding the configured interval exactly when usage was
  burning. The cap now applies ONLY until you have ever explicitly chosen a
  refresh interval (a new persisted `autoRefreshIntervalCustomized` flag,
  set permanently the first time a settings write *changes* the interval or
  the Settings pane asserts a selection — a "Keep N min" affordance in the
  Refresh section confirms your current value explicitly, since a picker
  cannot re-fire on the already-selected row). While the cap applies, the
  scheduler runs `max(configured, 30 min)` — it slows fast cadences but
  never polls faster than you configured — and the deck footer shows an
  honest "Auto-refresh slowed" indicator whose tooltip explains it,
  `/api/state` reports the effective cadence
  (`scheduler.effectiveRefreshIntervalSeconds` + `effectiveRefreshReason`,
  derived from the same function the scheduler runs), and stale markers key
  on the effective interval so slowed refresh is never mislabeled as stale
  data. **Migration note:** existing installs start with the flag unset, so
  the cap still applies once — pick any interval in Settings, or click
  "Keep" next to your current one, and it is lifted permanently; the new
  indicator makes this discoverable.
- **CRITICAL — per-profile sign-in on Claude Code ≥ 2.1.216 (issue #99)**:
  current Claude Code keys Keychain credential storage off the resolved
  `~/.claude`, ignoring `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR`,
  so the old env-scoped login guidance silently overwrote the ACTIVE
  profile's credentials. The daemon now version-detects the installed CLI and
  drives sign-ins through activation on affected versions (activate target →
  plain `claude /login` → verify → restore prior active); both app sign-in
  flows (add-account step 2/3 and the roster's "Sign in again") follow the
  daemon's spec. Post-login verification now has teeth: the verify endpoint
  compares the read-back identity against the intended account and refuses
  the sign-in on mismatch (`identityMismatch` in the response, surfaced
  loudly in the app) instead of recording the wrong login. `GET /api/tools`
  additionally reports `credentialScoping` ("config-dir" / "resolved-home")
  for the installed Claude CLI.

### Added
- Per-account staleness surfacing (issue #89): deck cards whose newest
  snapshot is older than ~2x the effective refresh interval now carry a
  visible warning-tinted "Data from N hr ago" line with a tooltip naming the
  account's last refresh error; the daemon propagates per-account refresh
  failures into `/api/state` (`lastRefreshError: {message, at}`); an
  expired-stored-OAuth failure flips that account's health chip to "Sign in
  again" even though the credential presence probe still sees the (expired)
  credentials; the popover footer now reads "Oldest data N min ago", keyed
  on the account whose data is oldest, so one silently failing account can
  no longer hide behind fresh siblings.
- DMG installer art (issue #69): the release DMG now opens as a proper
  drag-to-Applications installer — deck-glyph brand mark, arrow, dashed
  drop-zone ring on a committed background (`design/dmg/`), window sized and
  icons pinned via a vendored Finder `.DS_Store`
  (`scripts/generate-dmg-background.swift`,
  `scripts/generate-dmg-ds-store.sh`). Volume name is now the fixed
  "ModelDeck" (version stays in the DMG filename).

### Changed
- Retired the legacy `public/` web dashboard and its static-file routes. The
  daemon is now API-only, and the native macOS menu-bar app is the sole
  graphical interface; old dashboard paths return JSON 404 responses.
- Retired the Mac mini staging deployment from the supported architecture;
  the local laptop daemon now serves the native app.
- README rewritten for the public mirror (issue #86): release-first install
  (latest release DMG from Releases, daemon via launch agent), hero local-first/
  no-telemetry callout, feature list matching the current app,
  build-from-source demoted to Development, modeldeck.ai linked.

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
- `VERSION`/`package.json` to 0.2.0. At release time, the web dashboard
  retirement and add-account flow remained scheduled for later phases
  (issues #8, #9).

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
