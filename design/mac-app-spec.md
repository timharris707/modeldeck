---
product: ModelDeck
surface: native-macos-menu-bar-app
status: normative
supersedes: web dashboard (DESIGN.md) as the primary surface
decided: 2026-07-19
---

# ModelDeck Mac App — Design Specification

Native SwiftUI menu bar app (`MenuBarExtra`), structured after PanelyMac
(SwiftPM package, no `.xcodeproj`). The existing Node daemon is the backend,
running on the user's laptop under `launchd`; the app is a pure client of its
localhost API. The web dashboard retires once the app reaches parity.

Interactive mockups (private, real-size): claude.ai artifact
"ModelDeck — Mac App Design, Round 1" (rev C). A scrubbed static copy lives at
[`design/mockups/modeldeck-mac-app-mockups.html`](mockups/modeldeck-mac-app-mockups.html).

## Locked decisions

| Topic | Decision |
|---|---|
| Number convention | **"% left"** everywhere, both providers. |
| Popover layout | **Two-column deck** — Claude column left, Codex column right, each headed by its brand mark. Single-column available via Settings; flat window list rejected. *Amended 2026-07-19 (Tim's call): card rows adopt Claude Code's usage-panel anatomy (scope label left in primary color, right-aligned reset + semibold percent, thin full-width bar below, generous vertical rhythm; "% left" semantics unchanged); the provider mark sits inline in the title row — never a leading gutter — so every card element shares one left edge; single-column widened so reset + percent never truncate; a muted plan-tier line ("Max (20x)") renders near the Claude account label. Amended 2026-07-19 (issue #30, Tim's second screenshot round): one canonical smaller type scale shared identically by both layouts (name 12 semibold; captions/tier 10.5 muted; meter labels 11 medium; "% left" 11 semibold); popover widened (two-column 640pt, single 420pt) so nothing truncates at the 7-account roster; cards get clearly darker backgrounds (black scrim + hairline edge) so each account reads as a distinct card; the plan tier renders inline beside the account name ("Studio · Max (20x)", muted, provider-generic — absent tier renders nothing); every meter row puts the limit label LEFT and reset info RIGHT, with absolute reset times carrying the time-zone abbreviation ("Resets Wed 5:59 PM PDT").* |
| Row behavior | Accounts collapse to one line (name, active checkmark, worst-window bar, % left, next reset). Click expands full windows (5-hour / weekly / model-scoped, spend tertiary/last). *Amended 2026-07-19 (Tim's call): the worst-window headline excludes the `spend` scope (fallback only when nothing else exists), and the ACTIVE pill is replaced by a small checkmark glyph beside the account title so the headline slot always carries the usage summary.* |
| Switch action | **"Activate"** — lives in **Settings → Accounts** as a small trailing control on each non-active row (the active row shows the checkmark instead). One click switches that provider's CLI for **new sessions only**; running sessions are never touched; the semantics note lives in the control's tooltip. *Amended 2026-07-19 (Tim's call): supersedes the earlier expanded-row placement — the deck popover carries zero activation controls; only the surface moved, activation semantics (optimistic flip → verify → revert, token-gated endpoint) are unchanged.* |
| Active semantics | Each provider has its own active account. Active Claude account = what Claude Code (terminal or desktop app) uses next launch; active Codex account = what plain `codex` uses. One active checkmark per provider column (*2026-07-19: checkmark glyph replaced the two ACTIVE badges*). |
| Menu bar icon | White template "deck" glyph (three stacked bars). Gold % appears beside it only when the **lowest remaining % across all accounts and windows** drops below the Settings threshold; red at critical; hidden when recovered. |
| Bar colors | Blue when healthy, yellow-gold below threshold, red at critical (thresholds per DESIGN.md: warn ≤25%, critical ≤10%, configurable). |
| Provider marks | Official logos — Claude starburst in Anthropic clay `#D97757`, OpenAI knot in white. Sourced from hiverunner `ProviderLogo`. *Amended 2026-07-21 (Tim directive, issue #103): provider marks are now the official desktop-app icons — Claude.app's icon for Claude, ChatGPT.app's icon for Codex (Tim's explicit choice) — extracted from the installed apps' `.icns` into bundled 32/64/128 px PNGs and rendered as-is in the same layout slots (the squircle artwork carries its own shape and margins; no chip backing, no extra masking).* |
| Sorting | Within each column: next reset (default) / lowest remaining. Default sort is a setting. *Amended 2026-07-19 (issue #30): a third "Provider" option groups accounts by provider (Claude, then Codex, unknown last; next-reset within a group) even in single-column mode. Provider is popover-local — the daemon settings schema stays next-reset/lowest-remaining; the sort control is rendered smaller as compact icon segments (clock = next reset, percent = lowest remaining, grid = by provider; tooltips + accessibility labels carry the names). Item 10: the popover header carries a quiet "ModelDeck" wordmark top-left (system semibold, slight tracking, no color/glyph); settings gear stays top-right; version/update chrome deferred to issue #33.* |
| Notifications | macOS banner when any account crosses a configurable remaining-% threshold. |
| Refresh | Manual + optional background auto-refresh (interval setting, default 5 min) with optional "pause while a session is active". Footer shows "Updated N min ago" + manual Refresh. *Amended 2026-07-21 (Tim's call, issue #90): the user's explicitly-chosen interval always wins — the pause-while-active 30-minute cap applies ONLY until the user has ever chosen an interval, tracked by change-event provenance (persisted `autoRefreshIntervalCustomized` flag: set permanently when a settings write CHANGES the interval or the Settings pane asserts a selection; value-vs-default comparison was rejected because a deliberate choice of 300s must also win, and since SwiftUI's picker cannot re-fire on the already-selected row, the Refresh section shows a small "Keep N min" affordance while the flag is unset so the current value can be confirmed explicitly). While the cap applies the daemon runs `max(configured, 30 min)` — it slows fast cadences, never accelerates slow ones — and scheduler + reported state derive from one shared function. Whenever the effective cadence is slower than the configured setting, the daemon reports it (`scheduler.effectiveRefreshIntervalSeconds` + `effectiveRefreshReason`) and the deck footer shows a calm "Auto-refresh slowed" indicator whose tooltip explains the cap and that choosing any interval lifts it. The toggle stays; only its throttling reach changed. Stale math (issue #89) keys on the EFFECTIVE interval so the cap never falsely marks cards stale.* |
| CLI versions | Settings shows installed vs. latest for Claude Code and Codex CLI with one-click Update. Architecture: Panely `CliToolProbe` pattern (one cached probe returns version + availability + auth state, background refresh, never blocks launch) plus hiverunner's latest-version comparison. The same probe feeds account health chips. |
| Settings window | Native two-pane window. **Accounts**: roster with health chips ("Healthy" / "Sign in again"), Edit (rename, purpose, color, remove-behind-confirm), Add Account. **General**: auto-refresh, interval, pause-while-active, menu bar style, popover layout, default sort, notification threshold, CLI tools, launch at login. |
| Add account | 3 steps: (1) provider + label + purpose, app creates isolated profile home; (2) provider's own login flow (`claude auth login` / `codex login`) in the browser under that home — ModelDeck never sees credentials; (3) read back authenticated identity, confirm, pull first usage. |
| Remove account | Deletes only ModelDeck's reference; never provider credentials. Confirmation required. |

## Account roster (labels)

Example shape: Claude — Studio (default/active), Client, Personal, Side
Project; Codex — Studio (default/active), Client, Personal. Real account
data stays local and is excluded from shareable artifacts: ModelDeck's own
metadata (labels, identities, emails) lives in the local database, while
auth state stays in provider-managed profile homes and the macOS Keychain —
none of it ever appears in fixtures, docs, or screenshots intended for
sharing (DESIGN.md privacy rule).

## Architecture

- **Backend**: existing Node daemon (`src/`), migrated to the laptop with
  Application Support SQLite + `launchd` (adapts issue #1 from the Mac mini to
  the laptop). Localhost-only, token + session-cookie mutations, unchanged
  safety contract.
- **App**: SwiftPM package at `macos/ModelDeckMac/` following PanelyMac
  conventions. `MenuBarExtra` + popover + Settings window. Talks HTTP to
  `127.0.0.1:<port>`.
- **New backend endpoints needed**: active-account switch per provider,
  CLI version probe (installed/latest/auth state), settings storage,
  usage-threshold evaluation for icon/notification state.
- The Mac mini staging deployment retires after laptop migration passes the
  acceptance checks in docs/HANDOFF.md (retargeted to the laptop).
