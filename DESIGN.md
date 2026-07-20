---
product: ModelDeck
surface: local-web-dashboard
visual_direction: compact-instrument-panel
status: normative
---

# ModelDeck Design Direction

> **Superseded for the primary surface (2026-07-19):** ModelDeck's primary
> surface is now the native macOS menu bar app specified in
> [`design/mac-app-spec.md`](design/mac-app-spec.md). This document remains
> normative for the web dashboard until its retirement (roadmap Phase 8), and
> its warning semantics and privacy rules carry forward unchanged.

## Core hierarchy

1. **Quick Deck is the default glance surface.** It shows exactly two compact provider widgets: Claude and Codex.
2. **Provider first, accounts on click.** Each provider widget shows account count, warning count, lowest remaining capacity, and account-color dots.
3. **Identity is mandatory in expansion.** Clicking Claude reveals all four Claude accounts; clicking Codex reveals all three Codex accounts. Every expanded account shows its human label and email/login.
4. **One decisive provider meter.** Claude prefers the lowest Fable remaining capacity when present; Codex shows the lowest remaining active window across its accounts.
5. **The full dashboard remains the control surface.** Project mapping, defaults, launch controls, usage history, and account administration stay below the compact deck.

## Density requirements

- Default glance surface: two provider widgets, each no wider than roughly 340px.
- Provider widget information budget: provider, account count, warning count, lowest account/scope, remaining percentage, identity dots.
- Account identities belong in the click expansion, not the initial provider widget.
- Do not place long project paths or action button clusters in the compact widget.
- Keep the hero subordinate to the provider meters; it must not consume the initial viewport.

## Warning semantics

| Remaining | State | Color |
|---:|---|---|
| `>25%` | Healthy | Green |
| `11–25%` | Warning | Amber |
| `≤10%` | Critical | Red |
| Unknown | Unavailable | Neutral gray |

Warnings describe capacity. They do not trigger account rotation or imply permission to bypass provider limits.

## Reference patterns

- [CodexBar](https://codexbar.app): menu/status surface first; provider details, resets, account identity, and charts behind interaction. Particularly relevant: explicit `Account: user@example.com` treatment and small/medium/large widgets.
- [AI Gauge](https://github.com/jpajak/ai-gauge): closest compact reference. Collapsed provider pills expose one number; click expands to a dense panel with multiple windows and reset timing.
- [onWatch](https://github.com/onllm-dev/onwatch): useful full-dashboard reference for historical data and alerting, but too broad for ModelDeck's primary glance surface.
- SessionWatcher: useful for alert and countdown behavior; avoid making the primary surface a full analytical dashboard.

## Interaction rules

- Compact cards are real buttons with keyboard focus and click-through details.
- Mutating actions never live on the compact card.
- Setting a default affects new launches only.
- Removing a profile requires confirmation and never deletes provider credentials.
- Refresh remains manual until an explicit monitoring schedule is approved.

## Privacy

Account identity is intentionally visible in this private local dashboard. Do not put real identities in source fixtures, screenshots intended for public use, logs, commit messages, or documentation examples. Inject private demo identities through environment variables.
