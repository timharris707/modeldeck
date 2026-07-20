# ModelDeck Mac App Roadmap

Canonical build plan for the native menu bar app. Strategy lives here;
the **active work queue is GitHub issues** — one issue per phase below,
worked branch → PR → merge, LoanMeld-style. Design authority:
[`design/mac-app-spec.md`](mac-app-spec.md).

Versioning: `v0.1-web` tags the retired web-dashboard MVP. The Mac app ships
as `v0.2.0` when Phase 6 completes. VERSION file + CHANGELOG.md start at
Phase 1.

## Phases

- [x] **Phase 0 — Repo housekeeping** (no issue; done at kickoff)
  Tag `v0.1-web`, commit spec + roadmap + scrubbed mockups, retarget issue #1
  to the laptop.
- [x] **Phase 1 — Persistence & service on the laptop** (issue #1, retargeted)
  Application Support SQLite (0700/0600, WAL), `launchd` agent, Keychain
  mutation token, real project roots, acceptance checks from docs/HANDOFF.md
  rewritten for the laptop. Onboard all seven accounts locally. Blocks all
  feature work, per the repo's standing rule.
- [x] **Phase 2 — Backend API extensions**
  `POST /api/accounts/:id/activate` (per-provider active switch, new-sessions-
  only semantics), CLI tool probe endpoint (installed/latest/auth state,
  cached), settings storage, worst-remaining evaluation endpoint for icon and
  notification state. Tests for each.
- [x] **Phase 3 — Swift app shell**
  `macos/ModelDeckMac/` SwiftPM package following PanelyMac. `MenuBarExtra`
  with template deck glyph, icon states (plain / gold % / red %), daemon
  client, launch-at-login. App builds, signs, shows live worst-% from the
  daemon.
- [x] **Phase 4 — Popover deck**
  Two-column layout per spec: column headers with brand marks, collapsing
  account rows, expand-on-click windows, per-column ACTIVE badge, sort
  control (next reset / lowest), footer (Updated + Refresh). Single-column
  alternate layout behind the same view model.
- [x] **Phase 5 — Activate switching**
  Button in expanded rows wired to the activate endpoint; optimistic UI with
  verification; never disturbs running sessions.
- [x] **Phase 6 — Settings window**
  Accounts pane (roster, health chips, Edit, remove-with-confirm) and General
  pane (auto-refresh + interval + pause-while-active, layout, default sort,
  notification threshold, CLI tools with Update, launch at login).
  Notifications via UserNotifications. **Ship `v0.2.0`.**
- [x] **Phase 7 — Add-account flow**
  Three-step guided flow driving `claude auth login` / `codex login` under isolated
  profile homes; identity read-back confirmation; first usage pull.
- [ ] **Phase 8 — Retire the web UI**
  Remove `public/`, retire Mac mini staging per acceptance checks, update
  README/DESIGN.md, final CHANGELOG entry.

## Progress log

- 2026-07-19 — Design phase complete (spec rev C locked). Roadmap adopted.
- 2026-07-19 — Phase 0 confirmed done (v0.1-web tag, spec/roadmap committed, issue #1 retargeted).
- 2026-07-19 — "Make Active" renamed to "Activate" across spec/roadmap/mockups (4b380b4).
- 2026-07-19 — Phase 1 merged (PR #10): persistent App Support SQLite, VACUUM INTO migration tooling, ai.hermes.modeldeck LaunchAgent scripts, Keychain mutation token, VERSION 0.1.1 + CHANGELOG, laptop runbook. Issue #1 stays open until the hands-on deployment (migration, agent install, 7-account onboarding) passes acceptance.
- 2026-07-19 — Phase 3 merged (PR #11): SwiftPM MenuBarExtra shell under macos/ModelDeckMac/ — icon states, daemon client, worst-remaining evaluation, launch-at-login; 27 tests. CodeRabbit reviews on both PRs triaged (1 fix, 1 deferred-to-Phase-4, docstring metric waived).
- 2026-07-19 — Phase 4 merged (PR #12): two-column deck popover per spec — brand-mark headers, collapsing rows, expand-on-click windows, per-column ACTIVE badge, Reset/Lowest sort, live "Updated" footer, single-column alternate behind the same view model; 53 tests. CodeRabbit: no findings.
- 2026-07-19 — Phase 2 merged (PR #13, codex/gpt-5.6-sol lane): activate endpoint (cswap / atomic codex symlink, new-sessions-only), cached CLI tools probe (refresh gated by mutation token), settings storage, worst-capacity endpoint; 33 tests. CodeRabbit: 2 minor findings, both fixed pre-merge.
- 2026-07-19 — Phase 5 merged (PR #14): Activate button in expanded non-active rows, per-call session token (memory-only), optimistic flip with verify-then-revert, stale-refresh generation guard; 62 tests. CodeRabbit: 3 minor findings, all fixed pre-merge.
- 2026-07-19 — Phase 6 merged (PR #15): Settings window (Accounts + General panes), daemon-synced settings with live apply, transition-only usage notifications, CLI tools status; 93 Swift + 33 Node tests. CodeRabbit: 4 findings (2 major), all fixed pre-merge. **v0.2.0 tagged.**
- 2026-07-19 — Issue #17 merged (PR #19, codex/gpt-5.6-sol lane): native Claude profile management replaces cswap — per-account config homes under App Support, atomic symlink activation with clobber guard, credential-free usage probe (claude-code User-Agent per upstream 429 policy), opt-in migration with recursive owner-only perms + rollback; 44 tests. CodeRabbit: 3 findings (2 major), all fixed pre-merge; 1 nit already covered.
- 2026-07-19 — Phase 7 merged (PR #20, Fable lane stacked on #17): 3-step add-account flow — app-provisioned owner-only native profile homes both providers, Terminal-launched provider login (copy fallback), status-only verify with identity readback, first usage pull, reference-only delete; 53 Node + 101 Swift tests. CodeRabbit: 5 findings (4 major incl. 2 security), all fixed pre-merge; provider-profile dedup deferred to tracked follow-up.
- 2026-07-19 — Issue #23 merged (PR #24, codex lane): macOS Keychain credential support for native Claude profiles — per-config-dir service names (sha256-suffixed, NFC-normalized), probe keychain fallback with file fast-path, verify root cause fixed (stripped env omitted USER); 58 tests. CodeRabbit: 1 minor, fixed pre-merge. First laptop onboarding completed live: 4 Claude + 3 Codex accounts signed in natively, all refreshing.
- 2026-07-19 — Issue #21 merged (PR #22, spun-off session + orchestrator rebase): shared provider-profile helper module deduplicating the security-relevant provisioning logic across codex/claude adapters; rebased over #24's keychain work (USER/env behavior intact), 60 tests. Live daemon re-verified post-merge.
- 2026-07-19 — Issue #25 merged (PR #27, Fable lane): deck popover polish — Activate caption removed (tooltip retained), mini Activate button, visible empty tracks (primary@16%), high-contrast Codex chip, deck glyph left-justified 12/8/16. CodeRabbit silent through escalation; merged on independent verification per deadline policy.
- 2026-07-20 — Issue #28 merged (PR #29, Fable lane, 6 scope additions from Tim's live use): full card redesign — spend demoted from all worst-remaining picks (both layers), model-scoped weeklies parsed + headline-eligible ("Weekly · Fable"), plan tier line ("Max (20x)") captured on existing passes, Claude-panel typography, one shared left edge + wider single-column, ACTIVE pill → checkmark, Activate moved popover→Settings (spec amended). CodeRabbit: 3 findings (2 major), all fixed pre-merge; 69 Node + 118 Swift tests. Live-verified: daemon serving Fable weekly + Codex model weeklies.
- 2026-07-20 — Issue #26 merged (PR #34, codex lane): Codex plan tier surfaced from the id_token's chatgpt_plan_type claim (display-only, unverified by design, defensive decode) as metadata.codexPlan {planType, displayName}, stale-edit protected, removal path on absent claim; 74 Node tests. CodeRabbit: 1 trivial (test gap), fixed pre-merge. UI rendering rides #30's lane (PR #35).
- 2026-07-20 — Issue #30 merged (PR #35, Fable lane, 10 items incl. 1 live amendment): second-round deck redesign — canonical smaller type scale shared by both layouts, popover widened (640/420pt, no truncation at 7-account roster), darker card scrim + hairline edge, plan tier inline beside the name (provider-generic; Codex "Pro" lights up from #26's payload), meter rows label-left/reset-right with TZ abbreviation, Provider sort (popover-local), icon sort segments, "ModelDeck" wordmark top-left (spec amended). CodeRabbit: 2 findings (1 robustness), both fixed pre-merge; 131 Swift + 69 Node tests.
- 2026-07-20 — Issue #31 merged (PR #37, codex lane): per-account auth health — keychain-aware Claude presence probe (legacy-file fallback, USER env preserved), per-account authState in state/list payloads, /api/tools follows the active account, POST /api/tools/:tool/update (realpath install-method detection npm/brew, 409 otherwise, single-flight, mutation-token guarded). Root cause of the all-accounts "Sign in again" bug: pre-Keychain .credentials.json stat. CodeRabbit: 1 finding (cache race), fixed pre-merge; 82 Node tests.
- 2026-07-20 — PR #36 merged (marketing lane): public-launch README rewrite (honest badges, architecture, privacy/local-first, screenshot placeholders), issue templates, PolyForm Noncommercial 1.0.0 LICENSE per Tim's decision (commercial rights reserved for possible App Store future). CodeRabbit: 4 findings + 1 nitpick, all fixed pre-merge.
- 2026-07-20 — PR #40 merged (pre-launch scrub): real account labels/personal paths replaced repo-wide with Studio/Client/Personal/Side Project placeholders — incl. a user-visible TextField prompt leak in AddAccountSheet and lowercase email slugs in the mockups. CodeRabbit: 6 findings, all fixed pre-merge; 82 Node + 131 Swift tests. Repo renamed modeldeck → modeldeck-private; public mirror gets the freed name.
- 2026-07-20 — Issue #39 merged (PR #41, codex lane): daemon-side auto-refresh scheduler — the stored autoRefreshEnabled/interval settings finally drive refreshAll() (generation-guarded rearm, missed ticks dropped, no catch-up bursts, single-flight coalesce with manual refresh). Root cause of Tim's live '100% left while actively burning' bug. CodeRabbit: 1 finding + 1 nitpick, fixed pre-merge; 87 Node tests. Live-verified: scheduled poll landed at 07:55 with true percentages.
- 2026-07-20 — Issue #32 merged (PR #38, Fable lane): Settings polish — provider marks in rosters, per-account health chips from #37's authState (honest Unknown fallback), working per-account 'Sign in again' via Terminal-launched provider login, CLI Update pill on the update endpoint (single-flight aware, honest 409s), General chip labeled 'Active: <account>'. CodeRabbit: 2 findings (1 cancel-race) + nitpick, fixed pre-merge; 155 Swift tests.
- 2026-07-20 — Public launch: timharris707/modeldeck live (fresh single-commit history, neutral author, PolyForm Noncommercial 1.0.0, description + 8 topics). Working repo renamed modeldeck-private. Final scrubs at source: seed-demo slugs, mockup tim@ caption, install-launch-agent port 3868→3867.
- 2026-07-20 — Issues #33+#42+#43 merged (PR #44, Fable lane, 4 live amendments from Tim): brand mark (site's three bars #4C8DFF/#E0A94A/#EA5C50) left of the popover wordmark, footer version (release-tag authority), honest footer freshness from observedAt with staleness tint, CLI 'Check for Updates' button removed (pane-open auto-probe, 30s debounce), separate ModelDeck update surface with gear-menu 'Check for App Updates…' as primary (dialog w/ View Release; installer deferred to #16), collapsed-only headline percent, Reset sort keyed to the DISPLAYED binding window's reset (fixes hidden-key ordering). CodeRabbit: 1 nitpick, fixed pre-merge; 196 Swift tests.
- 2026-07-20 — Issue #45 merged (PR #46, Fable debug lane): menu bar percent + Settings fronting. Root causes: MenuBarExtra label held a value snapshot of iconState (frozen at launch-time .plain — data path proven innocent), and SettingsLink never activated the accessory app so the window opened behind. Fixes: label observes the model; daemon /api/capacity/worst is now the primary evaluator (client calc = offline fallback); activate+front with creation retry, same for dialogs. CodeRabbit: 2 findings (deprecated activate API, locale-aware title fallback), fixed pre-merge; 205 Swift tests.
- 2026-07-20 (overnight) — Issue #47 merged (PR #49, codex lane): pauseWhileActive implemented as THROTTLE not stop — ps-presence check (injectable), 30-min staleness cap so always-open sessions never freeze the deck, manual refresh unaffected, scheduler.pausedForActiveSessions surfaced, fail-open on lister errors. CodeRabbit: 1 finding (stale pause flag), fixed pre-merge; 93 Node tests.
- 2026-07-20 (overnight) — PR #48 merged (doc lane): design/ios-companion-note.md — iOS companion via CloudKit private-DB, read-only mirror (no remote Activate), Mac app is the bridge (daemon never learns CloudKit), honest privacy framing, creation-based subscriptions so payloads stay encrypted, best-effort pushes, TestFlight 90-day expiry noted. CodeRabbit: 6 findings, all fixed pre-merge. Issue #18 stays open as revisit marker.
- 2026-07-20 (overnight) — Issue #45 fully closed (PR #50, Fable debug lane round 2): TRUE root cause of the missing menu-bar percent — MenuBarExtra flattens its label to the FIRST Image only; the two-image label (glyph + percent) was unrenderable by design. Fix: single composited NSImage (glyph in dynamic labelColor + colored percent), renderer moved to Core with pixel tests. Live-verified 38x16 'ModelDeck 3%'. CodeRabbit: 1 finding + nitpick, fixed pre-merge; 211 Swift tests.
- 2026-07-20 (overnight) — **Phase 9 merged (PR #52, issue #16): signed + notarized DMG pipeline.** scripts/release-dmg.sh (release build → ModelDeckMac.app bundle, bundle id app.modeldeck.mac kept for TCC identity, VERSION→CFBundleShortVersionString + commit-count build number → codesign hardened runtime → hdiutil DMG → two notarization passes (app + DMG, both stapled) → spctl/codesign verify) + docs/RELEASE.md. REAL artifact produced: dist/ModelDeck-0.2.0.dmg, both Apple submissions Accepted, Gatekeeper-accepted, staple validated. Known gap: no .icns (no vector asset in repo); daemon still installs via install-launch-agent.sh (bundling = future). CodeRabbit: 2 findings, fixed pre-merge.
- 2026-07-20 (overnight) — Issue #53 merged (PR #54, Fable lane): collapsed headline never says 'no reset data' while a tied sibling window has a real reset (worst-window tie-break prefers reset-bearing windows, soonest first; #43 sort improves automatically); brand mark unified to the deck glyph's staggered 12/8/16 via shared DeckGlyphGeometry (one shape, two colorways; site favicon/logo updated to match by the orchestrator). CodeRabbit rate-limited through trigger+escalation → merged per deadline policy on independent verification (diff review + all-unknown edge pinned with a regression test); 219 Swift tests.
- 2026-07-20 (overnight) — Issue #55 backend merged (PR #56, codex lane): activation TRUTH — Tim caught the active-checkmark lie (codex 'active' account at 98% while sessions burned another to 21%). Root cause: real pre-ModelDeck ~/.codex dir blocks the activation symlink (clobber guard correct); DB checkmark showed intent, not reality. /api/state now serves activation.{claude,codex}.state = effective|blocked|mismatched|unlinked (live: BOTH providers 'blocked'); activate refusal carries code 'active-link-blocked' + migration guidance. UI half still open on #55. One-time move-aside ceremonies (both providers) remain Tim-gated. CodeRabbit: 1 nitpick (shared error helper), fixed pre-merge; 102 Node tests.
- 2026-07-20 (overnight) — PR #51 merged (Tim-spawned session): order-independent assertion fixes the flaky per-profile refresh test.
- 2026-07-20 (overnight) — Issue #55 fully closed (PR #57, Fable lane): honest activation UI — full checkmark only when the daemon verifies activation is physically effective; hollow warning-gold marker + calm tooltip for blocked/mismatched/unlinked; blocked Activate surfaces the daemon's migration guidance verbatim inline in Settings; per-provider notice (usage accurate, switching pending migration); tolerant decode (absent field ⇒ no false warnings); VoiceOver carries the pending state. CodeRabbit: 1 finding (a11y label), fixed pre-merge; 245 Swift tests.
