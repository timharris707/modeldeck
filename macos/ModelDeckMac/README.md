# ModelDeckMac

Native SwiftUI menu bar app for ModelDeck (Phases 3–6 of
[`design/mac-app-roadmap.md`](../../design/mac-app-roadmap.md); design
authority [`design/mac-app-spec.md`](../../design/mac-app-spec.md)).
SwiftPM package following PanelyMac conventions — no `.xcodeproj`.

## Layout

- `Sources/ModelDeckMacCore` — testable core: daemon HTTP client
  (`DaemonClient`, localhost-only, token-gated mutations), typed API models
  (state, settings, CLI tool probe), worst-remaining evaluation + menu bar
  icon state (`UsageEvaluation.swift`), the `MenuBarStatusModel` /
  `DeckPopoverModel` / `SettingsSyncModel` / `AccountsSettingsModel` /
  `ToolsStatusModel` view models, threshold-crossing notification logic
  (`UsageNotifications.swift`), `LaunchAtLogin` (SMAppService).
- `Sources/ModelDeckMac` — app shell: `MenuBarExtra` with the template deck
  glyph, gold/red percent rendering, the two-column deck popover with
  Activate switching, the Settings window (Accounts + General panes), and
  the UserNotifications banner poster.
- `Tests/ModelDeckMacCoreTests` — Swift Testing suites for thresholds,
  worst-% computation, client decoding, settings sync, notification
  transitions, and the view models.

## Build, test, run

```sh
swift build            # from macos/ModelDeckMac
swift test
Scripts/build_app.sh   # assembles + signs dist/ModelDeck.app (ad-hoc by default)
```

The app talks to the local Node daemon at `http://127.0.0.1:3867`
(`MODELDECK_PORT` env var or the `modeldeck.daemon.port` user default
override the port). Reads (`/api/health`, `/api/state`, `/api/settings`,
cached `/api/tools`) hit the daemon's cache and never trigger provider
polling. Mutations (Activate, settings PUT, account edit/remove, forced
tool re-probe) fetch the `/api/session` token per call and echo it back as
both the `x-modeldeck-token` header and the `modeldeck_session` cookie.

Settings live in the daemon (`GET/PUT /api/settings`); the app loads them
at launch and applies changes live (popover layout/sort, refresh cadence,
notification threshold). Usage banners post only when the worst remaining
% crosses the configured threshold (or critical) — once per crossing,
re-armed on recovery — and notification authorization is requested lazily.

Launch-at-login uses `SMAppService.mainApp`, and usage notifications use
`UNUserNotificationCenter`; both only work from an assembled `.app` bundle
(`Scripts/build_app.sh`), not from a bare `swift run` binary.
