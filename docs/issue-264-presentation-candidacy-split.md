# Issue #264 — presentation vs. renewal candidacy split

Design note written BEFORE code, as #264 mandates. The naive fix (clearing the
remembered refresh error when a statusline capture lands) is rejected: that
error is the single input `signinReason` derives from, and
`performClaudeRenewal` refuses unless `signinReason === 'expired'`
(src/service.mjs). Clearing it the moment an account looks healthy would stop
auto-renew exactly when Tim wants it running.

## Invariant (candidacy — untouched)

Renewal candidacy remains driven solely by the remembered refresh error:

- `ingestClaudeStatuslineCaptures` keeps calling ONLY `store.recordUsage` —
  it never touches `accountRefreshErrors`.
- `signinReason`, `accountAuthState`, and `performClaudeRenewal` are not
  modified. `renew.available` stays `enabled && signinReason === 'expired'
  && !authOverride && readable`.
- Tests assert the account stays renewal-candidate (signinReason "expired",
  `renew.available == true`) while fresh statusline captures are flowing.

## The split

The daemon already publishes everything the app needs: `authState`,
`signinReason` (additive, #149), and usage rows with `observedAt` +
`source: 'claude-statusline'`. "Flagged but currently producing fresh
server-truth" is therefore a pure app-side derivation — **data age**, using
the deck's existing staleness rule (2× effective auto-refresh interval,
5-minute fallback; `DeckFreshness.isStale`). No new /api/state field is
needed; the daemon's only change is additive options/fields on the
worst-capacity evaluation (bonus fix, below).

### 1. Deck card: a third tone, not the sign-in CTA

`DeckFreshness.SignInRecovery.Tone` gains `.liveIdle`. A clocked overload
`signInRecovery(for:newestObservedAt:now:autoRefreshInterval:)` upgrades the
`.idle` tone to `.liveIdle` when the account's newest observation is inside
the staleness threshold. Copy: **"Live — renews automatically"**; tooltip
explains that a running session is reporting current usage while ModelDeck
keeps renewing the stored sign-in in the background. Per Tim's #149
directive this stays the SAME single notice slot, same footprint, same
click-through explanation and one-click sign-in path — a tone/wording split,
never a second notice. The clock-free `signInRecovery(for:)` keeps returning
`.idle` (footer breakdown and old call paths never see `.liveIdle`; a
fresh-data account never appears in the stale footer list anyway).

The Settings roster chip keeps `healthChip == .idleSignIn` ("Idle") — it has
no clock and the renewal affordance (`AccountRenewModel.action`) is keyed on
it; changing it would touch candidacy surfaces for a presentation win the
deck card already delivers. Judgment call, flagged for the orchestrator.

### 2. Availability Health: include on data age, not authState

`AvailabilityHealth.pool()` no longer hard-excludes on `authState != "ok"`.
`duplicate-token` stays excluded on authState (fresh data would double-count
one login's capacity — the exclusion is about identity, not data trust).
Every other flagged state falls through to the existing data gates: driver
snapshot present, not daemon-stale, within `staleAfter` (30 min). A flagged
account with fresh server-truth is real capacity and joins the pool; when
its data is missing or stale, the exclusion reports the ORIGINAL auth reason
("sign in needed", "needs Keychain access") so the grouped health detail
(#281) keeps telling the sign-in story instead of a vague "usage data is
stale".

### 3. Bonus fix: the frozen headline

Same account was both "zero capacity" (health) and "the menu-bar number"
(worst-remaining). Both halves of the number's pipeline get the same rule —
a row belonging to an account that CANNOT refresh (sign-in required or
Keychain-denied) counts toward the headline only while it is fresh:

- Daemon (primary source, `/api/capacity/worst`):
  `evaluateWorstCapacity` accepts accounts carrying an additive
  `authFlagged: true` and an additive `flaggedMaxAgeMinutes` option
  (default 30, matching the app's health `defaultStaleAfter`). Flagged
  accounts' rows older than that (or with unparseable `observedAt`) are
  excluded with reason `usage frozen while the account cannot refresh` —
  the `excluded` array already exists, so this is additive payload only.
  `service.worstCapacity()` sets `authFlagged` from the remembered refresh
  errors (`SIGN_IN_REQUIRED_ERROR_PATTERN` / `KEYCHAIN_DENIED_ERROR_PATTERN`
  — the same patterns `accountAuthState` keys on, sync and cheap).
- App fallback (`WorstRemainingCalculator.worstRemaining(in:)`): the same
  filter, keyed on `authState` ∈ {signin-required, keychain-denied} and
  `AvailabilityHealth.defaultStaleAfter`, with `now` injectable for tests.
  The PINNED variants are deliberately untouched: a pin is an explicit user
  choice and its tooltip already names the window; only the lowest-across
  default loses the frozen row. Judgment call, flagged.

Consistency: with the split in place a flagged account is either fresh
(counts for health AND may own the headline) or frozen (counts for neither).
The "both empty and headline" contradiction is gone in both directions.

## Safety contract

No credential storage, no touching running sessions, placeholder emails only
in tests/fixtures. Locked decisions in design/mac-app-spec.md untouched.
