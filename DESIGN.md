---
product: ModelDeck
surface: api-only-daemon
status: normative
---

# ModelDeck Daemon Design

ModelDeck's user interface is the native macOS menu-bar app specified in
[`design/mac-app-spec.md`](design/mac-app-spec.md). The Node daemon is an
API-only localhost service: it serves `/api/*` JSON endpoints and does not
serve a root page, dashboard, or static assets.

The app remains a pure client of that API. The daemon owns persistence,
provider coordination, usage refresh, and account activation; presentation
and interaction belong to the native app.

## Warning semantics

| Remaining | State | Color |
|---:|---|---|
| `>25%` | Healthy | Green |
| `11–25%` | Warning | Amber |
| `≤10%` | Critical | Red |
| Unknown | Unavailable | Neutral gray |

Warnings describe capacity. They do not trigger account rotation or imply permission to bypass provider limits.

## Safety rules

- The daemon binds to loopback and rejects unexpected Host headers on every
  request; Origin is additionally validated at the mutation boundary (all
  non-GET requests and refresh probes). Plain GET reads do not check Origin.
- Mutations require the managed token and session cookie.
- Setting a default affects new launches only.
- Removing a profile requires confirmation and never deletes provider credentials.
- Refresh cadence remains controlled by the stored scheduler settings.
- Account activation never disturbs running sessions.

## Privacy

Account identity is visible only in the private native app. Do not put real
identities in source fixtures, screenshots intended for public use, logs,
commit messages, or documentation examples. ModelDeck never stores provider
credentials.
