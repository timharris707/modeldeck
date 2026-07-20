---
product: ModelDeck
surface: ios-companion-app
status: exploration — revisit later (issue #18)
depends-on: signed distribution pipeline (issue #16)
captured: 2026-07-20
---

# ModelDeck iOS Companion — Design Note

**This is a revisit-later exploration document, not an implementation plan.**
It captures the architecture thinking from issue #18 while it is fresh so a
future phase can pick it up without re-deriving it. Nothing here is
scheduled; the go/no-go decision comes after the DMG pipeline (#16) ships.
Design authority for everything Mac-side remains
[`mac-app-spec.md`](mac-app-spec.md).

## Goal

Glance at the deck from a phone: every account, its "% left" per window,
next resets, and the worst-account state — plus a push when something
crosses the threshold. That is the entire product. Explicitly **not** goals:

- No account switching from iOS.
- No provider sign-in or add-account flow on iOS.
- No settings mutation from iOS.

The phone is a read-only window onto state the laptop owns. An iPhone
cannot read CLI profile dirs, spawn `codex app-server` probes, or swap
activation symlinks — so the iOS app is a **remote client, not a port**.
The consolation is large: `ModelDeckMacCore` (deck view models,
worst-remaining math, sort/layout, freshness formatting, notification
planning) is platform-clean Swift and most of it reuses directly.

## Sync architecture

```text
Node daemon ──localhost──▶ Mac app ──CloudKit private DB──▶ iOS app
(source of truth)          (sync bridge)                    (read-only subscriber)
```

- **The Node daemon stays exactly as it is.** Localhost-only, no cloud
  code, unchanged safety contract. It never learns CloudKit exists.
- **The Mac app is the sync bridge.** CloudKit is native in Swift; after
  each refresh cycle the app mirrors the current deck state into the
  user's **CloudKit private database** and updates a heartbeat record.
- **The iOS app is a read-only subscriber.** Same Apple ID, same private
  DB. It renders the deck with the shared core and receives push-driven
  updates via CloudKit subscriptions. It writes nothing (a future remote
  command surface is a separate decision — see Open questions).
- **Pairing = iCloud sign-in on both devices**, plus build-time plumbing:
  both app targets must declare the same CloudKit container identifier,
  environment, and iCloud/CloudKit entitlements — same Apple ID alone is
  not sufficient; mismatched containers silently isolate the two apps.
  Still: no accounts we operate, no relay server, no QR codes, no login UI.

### The local-first promise, honestly

The README says "Cloud services: **None**." An iOS companion bends that,
and the note should be honest about exactly how far:

- **CloudKit IS Apple's cloud.** Deck state (labels, tiers, percentages,
  reset times) leaves the laptop and rests on Apple servers. Anyone who
  says otherwise is marketing.
- What it preserves: **no third-party server, no ModelDeck backend, no
  ModelDeck accounts, no telemetry.** The private database is scoped to
  the user's own iCloud account; ModelDeck operates no server and holds
  no key, so *we* never see the data — only the user's own signed-in
  devices (and, absent ADP, Apple's infrastructure) can read it.
- **Provider credentials never leave the Mac.** The guarantee is scoped
  to provider credentials and tokens (Claude/Codex auth): the bridge
  mirrors derived usage state only — never tokens, never Keychain
  material, never profile-home contents. It does not, and cannot, cover
  the user's own iCloud auth, which Apple manages. Provider identities
  (emails) are already excluded from the daemon's shareable surfaces and
  stay out of the mirror; the phone shows labels ("Studio", "Client"),
  not identities. What *is* mirrored — labels, usage percentages, reset
  times — is still sensitive metadata (it sketches work rhythm and
  account structure) and gets treated as such, not waved off as harmless.
- Encryption: CloudKit private-DB records are encrypted in transit and at
  rest; with Advanced Data Protection enabled they are end-to-end
  encrypted. We should use encrypted field types wherever a field is not
  needed in a query predicate (see the data-model note below — CloudKit
  cannot index or query encrypted fields), so ADP users get E2E for the
  sensitive values, and say plainly that non-ADP users are trusting
  Apple's standard iCloud protections.
- Sync must ship **off by default**. The README privacy table gets a new
  honest row when this ships ("iCloud sync: optional, your private
  database, derived usage state only"), not a silent walk-back.

## Data model sketch

Mirror **current state, not history**. The SQLite `usage_snapshots` table
keeps history on the laptop; CloudKit holds only the latest frame, so
retention/pruning is structural rather than a chore.

| Record type | One per | Fields (sketch) |
|---|---|---|
| `DeckAccount` | account (recordName = account id) | `label` ("Studio", "Side Project"), `provider` (`claude`/`codex`), `planTier` ("Max (20x)", "Pro", absent OK), `color`, `isActive` (per-provider active marker, display-only), `worstRemainingPercent` (queryable, for subscriptions), `worstScope`, `schemaVersion` |
| `DeckWindow` | account × window scope (recordName = accountId·scope) | `scope` (`session`/`weekly`/`weekly-model:<slug>`/`spend`), `remainingPercent`, `resetsAt`, `observedAt`, `stale` |
| `BridgeHeartbeat` | singleton | `lastSyncAt`, `daemonObservedAt`, `bridgeVersion`, `schemaVersion` |
| `ThresholdEvent` | crossing (ephemeral) | `accountId`, `label`, `scope`, `remainingPercent`, `direction`, `occurredAt` |

Notes:

- Stable record names make every sync an upsert; deleted accounts delete
  their records. `DeckWindow` rows carry `observedAt` per window because
  scopes refresh at different times.
- **Encrypted vs. queryable is a hard tradeoff.** CloudKit cannot index,
  sort, or use encrypted fields in query predicates, so any field a
  `CKQuerySubscription` or fetch predicate depends on must stay
  unencrypted. The design leans on a **creation-based** `ThresholdEvent`
  subscription (fires on record creation, no field predicate), which lets
  the numeric payloads stay in encrypted fields; `worstRemainingPercent`
  on `DeckAccount` is marked queryable above only as an option — if we
  never build a field-predicate subscription on it, encrypt it too.
  Whatever the final split, it must be explicit per field, because the
  choice is permanent once the schema deploys.
- `worstRemainingPercent` follows the spec's headline rule: `spend` is
  excluded from worst-window picks (fallback only), model-scoped weeklies
  are eligible.
- `ThresholdEvent` records exist to trigger pushes (below) and are pruned
  by the bridge after a short horizon (e.g. 7 days) — they are signals,
  not a log.
- `schemaVersion` on every record from day one. The iOS app renders what
  it understands and shows an "update the app" nudge for newer majors,
  never a crash or a silently wrong deck.

## Failure and staleness handling

The Mac must be awake, online, and running the app for the mirror to be
fresh. When it is not, **the phone must be honest rather than reassuring**
— this is the #42 `observedAt` philosophy carried over verbatim:

- Freshness is computed from `observedAt` / `BridgeHeartbeat.lastSyncAt`,
  never from "when did the phone last hear from CloudKit". A push that
  arrives late does not make old data young.
- The iOS deck reuses the footer pattern: "Updated N min ago", with the
  staleness tint at the same thresholds as the Mac app. Beyond a longer
  horizon (laptop asleep overnight), an explicit banner: "Deck last
  synced 9h ago — is your Mac awake?".
- Percentages and reset countdowns keep rendering while stale (a reset
  time in the past can even be labeled "likely reset since") — but the
  stale state is visually unmissable, never a footnote.
- No heroics: the phone cannot wake the laptop, and we do not build a
  relay to pretend otherwise. Stale-but-honest is the contract.

## Notifications

Threshold pushes are **generated on the Mac side, delivered by CloudKit**:
the daemon/bridge already owns transition-only crossing detection (the
worst-capacity evaluator + the one-banner-per-crossing rule), so the
bridge writes a `ThresholdEvent` record at each crossing and a
creation-based `CKQuerySubscription` on that record type delivers the
push — no server of ours, no polling.

CloudKit pushes are **best-effort change hints, not guaranteed
delivery**: payloads can be coalesced or pruned by APNs, so the iOS app
treats a push purely as "something changed — go fetch", pulling the
current deck state and the recent events from the private DB rather than
trusting the notification contents. Likewise, `ThresholdEvent` records
are ephemeral signals, not a source of truth — the app must never depend
on one surviving long enough to be read.

Rejected alternative: iOS-local re-evaluation (phone recomputes crossings
from synced snapshots). That creates a second evaluator that can disagree
with the Mac's, double-fires when both devices notify, and drifts when
thresholds change. One evaluator, one crossing, one event record —
**the one-banner-per-crossing rule carries over** because the event *is*
the crossing. The iOS app dedupes against the Mac only in the trivial
sense that macOS banners and iOS pushes are separate surfaces; whether to
offer "notify on phone only when Mac has been idle" is Settings polish
for later.

## What it does NOT do, and why

| Not doing | Why |
|---|---|
| Activate from iOS | The safety contract lives on the laptop: activation is a localhost, token-gated, verify-then-revert mutation against CLI state only the daemon may touch. A remote command path adds a writable cloud surface, replay/staleness windows, and a failure mode where the phone believes a switch happened that the sleeping Mac never executed. Issue #18 sketched a nonce-guarded `ActivationCommand` queue; it is *deferrable*, not impossible — but the read-only slice ships without it, and the burden of proof is on adding it. |
| Sign-in / add account | Add-account is a guided local flow driving the provider's own browser login under an isolated profile home. None of that exists off the laptop, and credentials never leave it. |
| Settings mutation | Settings are daemon state behind the mutation token. A phone toggle that a sleeping Mac applies hours later is worse than no toggle. |

One-way mirror, zero writable cloud surface (beyond the bridge's own
records), and no provider credentials or tokens on the phone — what it
holds is usage metadata, which is worth protecting but cannot be used to
act on any account.

## Open questions

1. **Remote Activate** — revisit only after the read-only slice has been
   lived with. If revived, the issue-#18 command-queue sketch (nonce +
   freshness window + result read-back) is the starting point.
2. **Bridge liveness** — is "the Mac app must be running" acceptable, or
   does the bridge belong in a small `launchd`-adjacent helper so sync
   survives the app being quit? (The app already launches at login;
   probably fine for v1.)
3. **ADP posture** — do we merely inherit E2E when the user has Advanced
   Data Protection, or actively recommend it in onboarding copy?
4. **Widgets / complications** — a lock-screen widget ("worst: Client
   12%") may be most of the product's daily value; needs the same
   staleness honesty in a much smaller canvas.
5. **Multi-Mac** — two laptops writing the same private DB. Likely
   per-bridge record namespacing later; explicitly out of scope now.
6. **Apple lock-in** — CloudKit forecloses Android/web. If that ever
   matters, the alternative is issue #18's original sketch: a small
   self-hosted E2E relay (laptop keypair, key via iCloud Keychain,
   server stores opaque blobs). For a Mac+iPhone companion, CloudKit
   wins on zero-ops.

## Phase gating (rough)

1. **Gate: #16 ships.** The DMG pipeline is a prerequisite, not the iOS
   setup itself: it establishes the paid developer account and signing
   practice, but the iOS companion still needs its own App ID,
   provisioning profiles, and iCloud/CloudKit capability configuration
   before TestFlight. Nothing iOS-shaped starts before #16.
2. **Go/no-go decision** on a prototype (this note is the input).
3. **Slice 1 — mirror + read-only deck** via TestFlight: bridge in the
   Mac app (off by default), `DeckAccount`/`DeckWindow`/heartbeat,
   iOS deck with honest staleness. No notifications yet.
4. **Slice 2 — threshold pushes** (`ThresholdEvent` + subscription).
5. **Slice 3 — App Store?** Distribution question, not architecture.
   TestFlight builds expire after 90 days, so it is a beta channel, not
   indefinite distribution — long-term use means either periodically
   refreshed TestFlight builds or an App Store release. Tim holds
   commercial rights under PolyForm-NC, so a paid App Store listing
   remains open; the license question is his alone to exercise.
