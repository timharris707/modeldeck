import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #42 — footer freshness derives from the provider observation
// (observedAt), not the app's last GET; staleness at ~2x the auto-refresh
// interval; the daemon's per-row stale flag is honored.

@Suite("Deck freshness (issue #42)")
struct DeckFreshnessTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func snapshot(observedAt: String?, stale: Bool = false, scope: String = "5h") -> UsageSnapshot {
        UsageSnapshot(accountId: "acct-1", scope: scope, remainingPercent: 50, observedAt: observedAt, stale: stale)
    }

    private func iso(secondsAgo: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
    }

    @Test func newestObservedAtPicksTheMax() {
        let state = DeckState(usage: [
            snapshot(observedAt: iso(secondsAgo: 7_200), scope: "5h"),
            snapshot(observedAt: iso(secondsAgo: 120), scope: "week"),
            snapshot(observedAt: nil, scope: "spend"),
        ])
        #expect(DeckFreshness.newestObservedAt(in: state) == now.addingTimeInterval(-120))
    }

    @Test func newestObservedAtNilWhenNoSnapshotCarriesOne() {
        let state = DeckState(usage: [snapshot(observedAt: nil), snapshot(observedAt: "not-a-date")])
        #expect(DeckFreshness.newestObservedAt(in: state) == nil)
    }

    @Test func textBuckets() {
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-30), now: now) == "Oldest data just now")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-300), now: now) == "Oldest data 5 min ago")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-7_200), now: now) == "Oldest data 2 hr ago")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-90_000), now: now) == "Oldest data 1 day ago")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-3 * 86_400), now: now) == "Oldest data 3 days ago")
        // Clock skew: a future observation reads as now, never negative.
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(60), now: now) == "Oldest data just now")
    }

    // MARK: Issue #89 — per-account footer basis

    private func accountSnapshot(_ accountId: String, secondsAgo: TimeInterval, scope: String = "5h") -> UsageSnapshot {
        UsageSnapshot(
            accountId: accountId, scope: scope, remainingPercent: 50,
            observedAt: iso(secondsAgo: secondsAgo)
        )
    }

    @Test func oldestAccountObservationKeysOnTheStalestAccountsNewestRow() {
        // Account A refreshed 2 min ago; account B has been failing for 16 h
        // (its newest row is old). The footer basis must be B's newest, not
        // A's — one failing account can't hide behind a fresh sibling.
        let state = DeckState(
            accounts: [
                DeckAccount(id: "a", provider: "claude", label: "Studio"),
                DeckAccount(id: "b", provider: "claude", label: "Client"),
            ],
            usage: [
                accountSnapshot("a", secondsAgo: 120),
                accountSnapshot("b", secondsAgo: 57_600, scope: "5h"),
                accountSnapshot("b", secondsAgo: 60_000, scope: "week"),
            ]
        )
        // B's NEWEST row (16 h) wins, not its oldest (16.7 h).
        #expect(DeckFreshness.oldestAccountObservation(in: state) == now.addingTimeInterval(-57_600))
    }

    @Test func oldestAccountObservationIgnoresDisabledAccounts() {
        let state = DeckState(
            accounts: [
                DeckAccount(id: "a", provider: "claude", label: "Studio"),
                DeckAccount(id: "b", provider: "claude", label: "Retired", enabled: false),
            ],
            usage: [
                accountSnapshot("a", secondsAgo: 120),
                accountSnapshot("b", secondsAgo: 400_000),
            ]
        )
        #expect(DeckFreshness.oldestAccountObservation(in: state) == now.addingTimeInterval(-120))
    }

    @Test func oldestAccountObservationNilWithoutParseableDates() {
        let state = DeckState(usage: [snapshot(observedAt: nil), snapshot(observedAt: "not-a-date")])
        #expect(DeckFreshness.oldestAccountObservation(in: state) == nil)
    }

    @Test func stalenessThresholdIsTwiceTheInterval() {
        // 300 s cadence → stale strictly beyond 600 s.
        #expect(!DeckFreshness.isStale(
            observedAt: now.addingTimeInterval(-599), now: now, autoRefreshInterval: 300))
        #expect(!DeckFreshness.isStale(
            observedAt: now.addingTimeInterval(-600), now: now, autoRefreshInterval: 300))
        #expect(DeckFreshness.isStale(
            observedAt: now.addingTimeInterval(-601), now: now, autoRefreshInterval: 300))
    }

    @Test func disabledAutoRefreshFallsBackToDefaultCadence() {
        // Interval 0 (auto-refresh off) → the spec-default 300 s still
        // defines staleness: 2 × 300 = 600.
        #expect(!DeckFreshness.isStale(
            observedAt: now.addingTimeInterval(-500), now: now, autoRefreshInterval: 0))
        #expect(DeckFreshness.isStale(
            observedAt: now.addingTimeInterval(-700), now: now, autoRefreshInterval: 0))
    }

    @Test func anyRowStaleHonorsTheDaemonFlag() {
        #expect(!DeckFreshness.anyRowStale(in: DeckState(usage: [snapshot(observedAt: nil)])))
        #expect(DeckFreshness.anyRowStale(in: DeckState(usage: [
            snapshot(observedAt: nil),
            snapshot(observedAt: nil, stale: true, scope: "week"),
        ])))
    }
}

@Suite("Footer status (issue #42)")
@MainActor
struct FooterStatusTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func model() -> MenuBarStatusModel {
        let fixed = now
        return MenuBarStatusModel(evaluator: StubEvaluator(results: []), clock: { fixed })
    }

    private func state(observedSecondsAgo: TimeInterval?, stale: Bool = false) -> DeckState {
        let observedAt = observedSecondsAgo.map {
            ISO8601DateFormatter().string(from: now.addingTimeInterval(-$0))
        }
        return DeckState(
            accounts: [DeckAccount(id: "acct-1", provider: "claude", label: "Studio")],
            usage: [UsageSnapshot(
                accountId: "acct-1", scope: "5h", remainingPercent: 40,
                observedAt: observedAt, stale: stale
            )]
        )
    }

    @Test func nilBeforeAnyLoad() {
        #expect(model().footerStatus(now: now) == nil)
    }

    @Test func derivesFromObservedAtNotTheAppGet() {
        let model = model()
        // The GET happened "just now" (apply stamps lastUpdatedAt = clock),
        // but the provider observation is two hours old — the footer must
        // say so instead of claiming freshness (issue #42's exact bug).
        model.apply(deckState: state(observedSecondsAgo: 7_200))
        let status = model.footerStatus(now: now)
        #expect(status?.text == "Oldest data 2 hr ago")
        #expect(status?.isStale == true) // default threshold 2×300 s
    }

    @Test func freshObservationIsNotStale() {
        let model = model()
        model.startAutoRefresh(interval: 300)
        defer { model.stopAutoRefresh() }
        model.apply(deckState: state(observedSecondsAgo: 90))
        let status = model.footerStatus(now: now)
        #expect(status == MenuBarStatusModel.FooterStatus(text: "Oldest data 1 min ago", isStale: false))
    }

    @Test func perRowStaleFlagForcesStalenessEvenWhenRecent() {
        let model = model()
        model.apply(deckState: state(observedSecondsAgo: 30, stale: true))
        let status = model.footerStatus(now: now)
        #expect(status?.text == "Oldest data just now")
        #expect(status?.isStale == true)
    }

    @Test func missingObservedAtFallsBackToUpdatedText() {
        let model = model()
        model.apply(deckState: state(observedSecondsAgo: nil))
        let status = model.footerStatus(now: now.addingTimeInterval(120))
        #expect(status?.text == "Updated 2 min ago")
        #expect(status?.isStale == false)
    }

    @Test func startAutoRefreshRecordsTheInterval() {
        let model = model()
        model.startAutoRefresh(interval: 900)
        defer { model.stopAutoRefresh() }
        #expect(model.autoRefreshInterval == 900)
        // 25 min old is within 2×900 s — not stale on the wider cadence.
        model.apply(deckState: state(observedSecondsAgo: 1_500))
        #expect(model.footerStatus(now: now)?.isStale == false)
    }

    @Test func oneFailingAccountCannotHideBehindAFreshSibling() {
        // Issue #89 / Tim's 2026-07-21 repro: one account's fetch failed for
        // 16 h while the others refreshed fine — the old footer said "Data
        // from just now". The per-account basis must say 16 h and go stale.
        let iso = { (secondsAgo: TimeInterval) in
            ISO8601DateFormatter().string(from: self.now.addingTimeInterval(-secondsAgo))
        }
        let model = model()
        model.apply(deckState: DeckState(
            accounts: [
                DeckAccount(id: "fresh", provider: "claude", label: "Studio"),
                DeckAccount(id: "dead", provider: "claude", label: "Client"),
            ],
            usage: [
                UsageSnapshot(accountId: "fresh", scope: "5h", remainingPercent: 60, observedAt: iso(20)),
                UsageSnapshot(accountId: "dead", scope: "5h", remainingPercent: 100, observedAt: iso(57_600)),
            ]
        ))
        let status = model.footerStatus(now: now)
        #expect(status?.text == "Oldest data 16 hr ago")
        #expect(status?.isStale == true)
    }
}

// MARK: - Per-card staleness (issue #89)

@Suite("Card staleness (issue #89)")
struct CardStalenessTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func row(
        observedSecondsAgo: TimeInterval?,
        errorMessage: String? = nil
    ) -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(
                id: "acct-1", provider: "claude", label: "Studio",
                lastRefreshError: errorMessage.map { AccountRefreshError(message: $0, at: nil) }
            ),
            provider: .claude,
            windows: [],
            isActive: false,
            newestObservedAt: observedSecondsAgo.map { now.addingTimeInterval(-$0) }
        )
    }

    @Test func freshCardHasNoMarker() {
        // 300 s cadence → threshold 600 s; at/below it stays clean.
        #expect(row(observedSecondsAgo: 599).staleness(now: now, autoRefreshInterval: 300) == nil)
        #expect(row(observedSecondsAgo: 600).staleness(now: now, autoRefreshInterval: 300) == nil)
    }

    @Test func staleCardGetsMarkerWithAgeText() {
        let staleness = row(observedSecondsAgo: 57_600).staleness(now: now, autoRefreshInterval: 300)
        #expect(staleness?.text == "Data from 16 hr ago")
        #expect(staleness?.tooltip == "Data from 16 hr ago — No newer data has arrived from the provider.")
        #expect(staleness?.accessibilityLabel.contains("Stale data") == true)
    }

    @Test func markerTooltipCarriesTheLastRefreshError() {
        let message = "Claude usage refresh failed: stored OAuth credentials have expired; "
            + "sign in explicitly before refreshing"
        let staleness = row(observedSecondsAgo: 3_600, errorMessage: message)
            .staleness(now: now, autoRefreshInterval: 300)
        #expect(staleness?.tooltip == "Data from 1 hr ago — Last refresh failed: \(message)")
        #expect(staleness?.accessibilityLabel.contains(message) == true)
    }

    @Test func thresholdUsesTheEffectiveInterval() {
        // 900 s cadence → 25 min old is fresh; past 30 min is stale.
        #expect(row(observedSecondsAgo: 1_500).staleness(now: now, autoRefreshInterval: 900) == nil)
        #expect(row(observedSecondsAgo: 1_801).staleness(now: now, autoRefreshInterval: 900) != nil)
        // Interval 0 (auto-refresh off) falls back to the 300 s default.
        #expect(row(observedSecondsAgo: 700).staleness(now: now, autoRefreshInterval: 0) != nil)
    }

    @Test func cardWithoutObservationsHasNoMarker() {
        // No data at all: nothing to present as stale (the card already
        // renders no meters) — even when a refresh error exists.
        #expect(row(observedSecondsAgo: nil, errorMessage: "boom")
            .staleness(now: now, autoRefreshInterval: 300) == nil)
    }

    @Test func builderComputesNewestObservedAtFromAllSnapshots() {
        let iso = { (secondsAgo: TimeInterval) in
            ISO8601DateFormatter().string(from: self.now.addingTimeInterval(-secondsAgo))
        }
        let state = DeckState(
            accounts: [DeckAccount(id: "a", provider: "claude", label: "Studio")],
            usage: [
                UsageSnapshot(accountId: "a", scope: "5h", remainingPercent: 60, observedAt: iso(7_200)),
                UsageSnapshot(accountId: "a", scope: "week", remainingPercent: 80, observedAt: iso(120)),
                // A meaningless spend row is hidden from windows but still
                // counts toward the card's data age.
                UsageSnapshot(accountId: "a", scope: "spend", remainingPercent: 100, observedAt: iso(30)),
            ]
        )
        let rows = DeckBuilder.rows(state: state, now: now)
        #expect(rows.first?.newestObservedAt == now.addingTimeInterval(-30))
        #expect(rows.first?.windows.contains(where: \.isSpend) == false)
    }
}

@Suite("Collapsed-only headline percent (issue #33 amendment)")
struct HeadlineWindowTests {
    private func row() -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Studio"),
            provider: .claude,
            windows: [DeckWindow(
                scope: "5h", title: "5-hour limit", remainingPercent: 37,
                resetsAt: nil, resetText: "no reset data",
                severity: .healthy, stale: false
            )],
            isActive: false
        )
    }

    @Test func collapsedShowsTheWorstWindowHeadline() {
        #expect(row().headlineWindow(isExpanded: false)?.remainingPercent == 37)
    }

    @Test func expandedHidesTheHeadlinePercent() {
        #expect(row().headlineWindow(isExpanded: true) == nil)
    }
}

// MARK: - lastRefreshError decode (issue #89)

@Suite("Account refresh error decode (issue #89)")
struct AccountRefreshErrorDecodeTests {
    private func decodeAccount(_ json: String) throws -> DeckAccount {
        let wrapped = #"{"accounts": [\#(json)], "usage": []}"#
        return try JSONDecoder().decode(DeckState.self, from: Data(wrapped.utf8)).accounts[0]
    }

    @Test func decodesMessageAndTimestamp() throws {
        let account = try decodeAccount(#"""
        {"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false,
         "authState": "signin-required",
         "lastRefreshError": {"message": "stored OAuth credentials have expired; sign in explicitly before refreshing",
                              "at": "2026-07-21T09:00:00.000Z"}}
        """#)
        #expect(account.lastRefreshError?.message?.contains("sign in explicitly") == true)
        #expect(account.lastRefreshError?.at == "2026-07-21T09:00:00.000Z")
        #expect(account.healthChip == .signInAgain)
    }

    @Test func absentFieldReadsAsNil() throws {
        let account = try decodeAccount(
            #"{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false}"#
        )
        #expect(account.lastRefreshError == nil)
    }

    @Test func bareStringReadsAsMessage() throws {
        let account = try decodeAccount(
            #"{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false, "lastRefreshError": "fixture provider failure"}"#
        )
        #expect(account.lastRefreshError?.message == "fixture provider failure")
    }

    @Test func unexpectedShapeNeverFailsTheAccountDecode() throws {
        let account = try decodeAccount(
            #"{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false, "lastRefreshError": 42}"#
        )
        #expect(account.lastRefreshError == AccountRefreshError())
    }
}

// MARK: - Keychain access recovery (issue #98)

@Suite("Keychain access recovery (issue #98)")
struct KeychainAccessRecoveryTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func row(authState: String?, observedSecondsAgo: TimeInterval? = nil) -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(
                id: "acct-1", provider: "claude", label: "Studio",
                authState: authState,
                lastRefreshError: AccountRefreshError(
                    message: "Claude usage refresh failed: Claude usage probe failed: macOS Keychain blocked ModelDeck's background service from reading this account's stored sign-in (a dismissed permission prompt does this); click Refresh and choose Always Allow when macOS asks again",
                    at: "2026-07-21T09:00:00.000Z"
                )
            ),
            provider: .claude,
            windows: [],
            isActive: false,
            newestObservedAt: observedSecondsAgo.map { now.addingTimeInterval(-$0) }
        )
    }

    @Test func deniedAccountGetsTheRecoveryNotice() {
        let recovery = row(authState: "keychain-denied").keychainRecovery
        #expect(recovery?.text == "ModelDeck needs Keychain access")
        #expect(recovery?.tooltip.contains("Refresh") == true)
        #expect(recovery?.tooltip.contains("Always Allow") == true)
        #expect(recovery?.tooltip.contains("one prompt per account") == true)
        #expect(recovery?.accessibilityLabel.contains("ModelDeck needs Keychain access") == true)
        #expect(recovery?.accessibilityLabel.contains("Always Allow") == true)
    }

    @Test func stateMatchIsCaseInsensitive() {
        #expect(row(authState: "Keychain-Denied").keychainRecovery != nil)
    }

    @Test func otherStatesNeverShowRecovery() {
        for state: String? in [nil, "ok", "signin-required", "unknown", "duplicate-token"] {
            #expect(row(authState: state).keychainRecovery == nil)
        }
    }

    @Test func recoveryOutranksTheBareStaleLine() {
        // 16 hr old data on a 300 s cadence would normally earn the #89
        // stale marker — the actionable recovery notice replaces it (one
        // notice per card; the denial is WHY the data is aging).
        let denied = row(authState: "keychain-denied", observedSecondsAgo: 57_600)
        #expect(denied.keychainRecovery != nil)
        #expect(denied.staleness(now: now, autoRefreshInterval: 300) == nil)

        // Without the denial the same age still gets the stale marker.
        let justStale = row(authState: "ok", observedSecondsAgo: 57_600)
        #expect(justStale.keychainRecovery == nil)
        #expect(justStale.staleness(now: now, autoRefreshInterval: 300) != nil)
    }

    @Test func deniedDecodesFromStateAndKeepsAnHonestChip() throws {
        let wrapped = #"""
        {"accounts": [{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false,
         "authState": "keychain-denied",
         "lastRefreshError": {"message": "Claude usage refresh failed: Claude usage probe failed: macOS Keychain blocked ModelDeck's background service from reading this account's stored sign-in (a dismissed permission prompt does this); click Refresh and choose Always Allow when macOS asks again",
                              "at": "2026-07-21T09:00:00.000Z"}}], "usage": []}
        """#
        let account = try JSONDecoder().decode(DeckState.self, from: Data(wrapped.utf8)).accounts[0]
        #expect(account.keychainAccessDenied)
        // NEVER "Sign in again" — the account IS signed in; macOS refused
        // the daemon's read. The chip stays Unknown and its tooltip carries
        // the honest refresh error.
        #expect(account.healthChip == .unknown)
        #expect(account.lastRefreshError?.message?.contains("Always Allow") == true)
    }

    @Test func olderDaemonsNeverTriggerFalseRecovery() {
        // A pre-#98 daemon omits authState or sends known states only.
        let account = DeckAccount(id: "a", provider: "claude", label: "Work")
        #expect(!account.keychainAccessDenied)
        #expect(DeckFreshness.keychainRecovery(for: account) == nil)
    }
}

// MARK: - Sign-in recovery (issue #114)

@Suite("Sign-in recovery (issue #114)")
struct SignInRecoveryTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    /// The exact per-account error the live daemon recorded during the #114
    /// forensics (expired stored sign-in on a non-active Claude account).
    private static let expiredMessage = "Claude usage refresh failed: Claude usage probe failed: stored OAuth credentials have expired; sign in explicitly before refreshing"

    private func row(
        authState: String?,
        provider: String = "claude",
        errorMessage: String? = expiredMessage,
        observedSecondsAgo: TimeInterval? = nil,
        signinReason: String? = nil,
        isDefault: Bool = false
    ) -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(
                id: "acct-1", provider: provider, label: "Studio",
                isDefault: isDefault,
                authState: authState,
                lastRefreshError: errorMessage.map {
                    AccountRefreshError(message: $0, at: "2026-07-22T04:10:00.000Z")
                },
                signinReason: signinReason
            ),
            provider: provider == "claude" ? .claude : .codex,
            windows: [],
            isActive: isDefault,
            newestObservedAt: observedSecondsAgo.map { now.addingTimeInterval(-$0) }
        )
    }

    @Test func signinRequiredGetsTheRecoveryNotice() {
        let recovery = row(authState: "signin-required").signInRecovery
        #expect(recovery?.text == "Sign in needed")
        #expect(recovery?.tooltip.contains("Settings → Accounts") == true)
        #expect(recovery?.accessibilityLabel.contains("Sign in needed") == true)
    }

    @Test func claudeRowExplainsTheActiveOnlyRenewal() {
        // Issue #114 root cause: Claude Code ≥ 2.1.216 renews only the
        // ACTIVE account's stored sign-in, so non-active accounts expire
        // within hours. The card must say WHY, not just "sign in".
        let recovery = row(authState: "signin-required").signInRecovery
        #expect(recovery?.tooltip.contains("only the active account's sign-in") == true)
    }

    @Test func codexRowOmitsTheClaudeDetail() {
        let recovery = row(authState: "signin-required", provider: "codex").signInRecovery
        #expect(recovery != nil)
        #expect(recovery?.tooltip.contains("active account's sign-in") == false)
    }

    @Test func daemonErrorMessageRidesAlongInTheTooltip() {
        let recovery = row(authState: "signin-required").signInRecovery
        #expect(recovery?.tooltip.contains("Last refresh failed:") == true)
        #expect(recovery?.tooltip.contains("stored OAuth credentials have expired") == true)
    }

    @Test func missingErrorMessageAddsNoDanglingSuffix() {
        let recovery = row(authState: "signin-required", errorMessage: nil).signInRecovery
        #expect(recovery != nil)
        #expect(recovery?.tooltip.contains("Last refresh failed:") == false)
    }

    @Test func otherStatesNeverShowRecovery() {
        for state: String? in [nil, "ok", "keychain-denied", "unknown", "duplicate-token"] {
            #expect(row(authState: state).signInRecovery == nil)
        }
    }

    @Test func noticesAreMutuallyExclusive() {
        // authState is single-valued: a keychain-denied row keeps #98's
        // notice and never also renders "Sign in needed", and vice versa.
        let denied = row(authState: "keychain-denied")
        #expect(denied.keychainRecovery != nil)
        #expect(denied.signInRecovery == nil)
        let signin = row(authState: "signin-required")
        #expect(signin.signInRecovery != nil)
        #expect(signin.keychainRecovery == nil)
    }

    @Test func recoveryOutranksTheBareStaleLine() {
        // The #114 live shape: ~14 hr old data on the capped 30 min cadence
        // earned only a bare "Data from 14 hr ago" line while the daemon had
        // been saying signin-required all along. The actionable notice now
        // replaces the age line (one notice per card).
        let signin = row(authState: "signin-required", observedSecondsAgo: 50_400)
        #expect(signin.signInRecovery != nil)
        #expect(signin.staleness(now: now, autoRefreshInterval: 1_800) == nil)

        // Without the auth failure the same age still gets the stale marker.
        let justStale = row(authState: "ok", observedSecondsAgo: 50_400)
        #expect(justStale.signInRecovery == nil)
        #expect(justStale.staleness(now: now, autoRefreshInterval: 1_800) != nil)
    }

    @Test func olderDaemonsNeverTriggerFalseRecovery() {
        // A daemon that omits authState maps to the Unknown chip — no
        // notice, exactly like #98's leniency rule.
        let account = DeckAccount(id: "a", provider: "claude", label: "Work")
        #expect(DeckFreshness.signInRecovery(for: account) == nil)
    }

    // MARK: Idle-decay split (issue #149)

    @Test func expiredReasonRendersTheCalmIdleNotice() {
        let recovery = row(authState: "signin-required", signinReason: "expired").signInRecovery
        #expect(recovery?.tone == .idle)
        // Pinned EXACTLY (orchestrator verify on PR #150, Tim's constraint
        // 1): this string matches the Settings chip and fits the two-column
        // card on one line — the view adds lineLimit(1) as the structural
        // guard, and this pin catches wording drift toward a longer copy.
        // The full renewal sentence lives in the tooltip/explanation only.
        #expect(recovery?.text == "Idle — renews on next use")
        #expect(recovery?.text == ToolProbe.HealthChip.idleSignIn.text)
        // The calm lead: paused data, automatic renewal on next use.
        #expect(recovery?.tooltip.contains("renews the sign-in automatically") == true)
        // The full #114 structural story stays in the explanation…
        #expect(recovery?.tooltip.contains("only the active account's sign-in") == true)
        // …and so does the #118 one-click path pointer.
        #expect(recovery?.tooltip.contains("Settings → Accounts") == true)
        #expect(recovery?.accessibilityLabel.contains("Idle — renews on next use") == true)
    }

    @Test func expiredReasonKeepsTheDaemonErrorLine() {
        let recovery = row(authState: "signin-required", signinReason: "expired").signInRecovery
        #expect(recovery?.tooltip.contains("Last refresh failed:") == true)
        #expect(recovery?.tooltip.contains("stored OAuth credentials have expired") == true)
    }

    @Test func expiredReasonIsCaseInsensitive() {
        #expect(row(authState: "signin-required", signinReason: "Expired").signInRecovery?.tone == .idle)
    }

    @Test func missingReasonKeepsTodaysAlarmVerbatim() {
        let missing = row(authState: "signin-required", signinReason: "missing").signInRecovery
        #expect(missing?.tone == .signedOut)
        #expect(missing?.text == "Sign in needed")
        // Byte-for-byte the pre-#149 rendering: identical to a payload that
        // carries no reason at all.
        #expect(missing == row(authState: "signin-required", signinReason: nil).signInRecovery)
    }

    @Test func absentReasonFromAnOldDaemonKeepsTodaysAlarmVerbatim() {
        let recovery = row(authState: "signin-required", signinReason: nil).signInRecovery
        #expect(recovery?.tone == .signedOut)
        #expect(recovery?.text == "Sign in needed")
        #expect(recovery?.tooltip.contains("missing or has expired") == true)
    }

    @Test func unrecognizedReasonStaysTheConservativeAlarm() {
        let recovery = row(authState: "signin-required", signinReason: "future-reason").signInRecovery
        #expect(recovery?.tone == .signedOut)
        #expect(recovery?.text == "Sign in needed")
    }

    @Test func activeAccountWithExpiredTokenIsAlsoIdle() {
        // The distinction is reason-based, never activation-based: Tim idle
        // >8h everywhere means the ACTIVE account's token expires too, and
        // it renews on next use exactly the same way.
        let recovery = row(
            authState: "signin-required", signinReason: "expired", isDefault: true
        ).signInRecovery
        #expect(recovery?.tone == .idle)
    }

    @Test func codexIdleOmitsTheClaudeDetail() {
        let recovery = row(
            authState: "signin-required", provider: "codex", signinReason: "expired"
        ).signInRecovery
        #expect(recovery?.tone == .idle)
        #expect(recovery?.tooltip.contains("active account's sign-in") == false)
    }

    @Test func idleNoticeKeepsTheSameSingleNoticeFootprint() {
        // Tim directive (issue #149 comment): the calm tone occupies the
        // SAME slot as the alarm — one notice per card, so the bare stale
        // line stays suppressed exactly as it is for the signed-out tone.
        let idle = row(
            authState: "signin-required",
            observedSecondsAgo: 50_400,
            signinReason: "expired"
        )
        #expect(idle.signInRecovery != nil)
        #expect(idle.staleness(now: now, autoRefreshInterval: 1_800) == nil)
        #expect(idle.keychainRecovery == nil)
    }
}

// MARK: - signinReason decode (issue #149)

@Suite("signinReason decode (issue #149)")
struct SigninReasonDecodeTests {
    private func decodeAccount(_ json: String) throws -> DeckAccount {
        let wrapped = #"{"accounts": [\#(json)], "usage": []}"#
        return try JSONDecoder().decode(DeckState.self, from: Data(wrapped.utf8)).accounts[0]
    }

    @Test func decodesTheReasonAndSplitsTheChip() throws {
        let account = try decodeAccount(#"""
        {"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false,
         "authState": "signin-required", "signinReason": "expired"}
        """#)
        #expect(account.signinReason == "expired")
        #expect(account.healthChip == .idleSignIn)
    }

    @Test func missingReasonMapsToTheAlarmChip() throws {
        let account = try decodeAccount(#"""
        {"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false,
         "authState": "signin-required", "signinReason": "missing"}
        """#)
        #expect(account.signinReason == "missing")
        #expect(account.healthChip == .signInAgain)
    }

    @Test func oldDaemonPayloadDecodesToExactlyTodaysState() throws {
        // The compat story (#65 honest-Unknown precedent): no reason field
        // means the pre-#149 rendering, bit for bit.
        let account = try decodeAccount(#"""
        {"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false,
         "authState": "signin-required"}
        """#)
        #expect(account.signinReason == nil)
        #expect(account.healthChip == .signInAgain)
        #expect(DeckFreshness.signInRecovery(for: account)?.text == "Sign in needed")
        #expect(DeckFreshness.signInRecovery(for: account)?.tone == .signedOut)
    }

    @Test func reasonNeverAffectsOtherAuthStates() throws {
        // A daemon bug pairing a reason with a healthy state must not
        // invent an idle chip — the reason only refines signin-required.
        let account = try decodeAccount(#"""
        {"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false,
         "authState": "ok", "signinReason": "expired"}
        """#)
        #expect(account.healthChip == .healthy)
        #expect(DeckFreshness.signInRecovery(for: account) == nil)
    }
}
