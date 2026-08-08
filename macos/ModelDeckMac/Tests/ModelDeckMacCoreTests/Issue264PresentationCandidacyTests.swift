import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #264 — presentation vs. renewal candidacy split. Statusline captures
// (#174) record fresh server-truth for an account whose stored sign-in is
// still flagged expired. The flag must SURVIVE (it drives auto-renew), but:
// - the deck card gets a distinct "live" tone instead of "Idle — renews on
//   next use" over numbers a running session updated seconds ago,
// - Availability Health includes the account on DATA AGE, not authState, and
// - (bonus) a flagged account's FROZEN percentages can no longer own the
//   menu-bar headline while health counts the same account as zero capacity.
// Placeholder labels and emails only — never real account data.

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let interval: TimeInterval = 300

private func iso(secondsAgo: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
}

private func iso(hoursFromNow hours: Double) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(hours * 3600))
}

private func idleAccount(
    id: String = "a1",
    label: String = "Studio",
    authState: String? = "signin-required",
    signinReason: String? = "expired",
    renew: AccountRenewCapability? = nil
) -> DeckAccount {
    DeckAccount(
        id: id, provider: "claude", label: label,
        enabled: true,
        authState: authState,
        lastRefreshError: AccountRefreshError(
            message: "stored OAuth credentials have expired; sign in explicitly before refreshing"
        ),
        signinReason: signinReason,
        renew: renew
    )
}

// MARK: - The live tone (deck card presentation)

@Suite("Issue #264 — live tone on fresh server-truth")
struct Issue264LiveToneTests {
    @Test func idleWithFreshObservationUpgradesToLiveIdle() throws {
        let recovery = try #require(DeckFreshness.signInRecovery(
            for: idleAccount(),
            newestObservedAt: now.addingTimeInterval(-60),
            now: now,
            autoRefreshInterval: interval
        ))
        #expect(recovery.tone == .liveIdle)
        #expect(recovery.text == "Live — renews automatically")
        // The tooltip keeps the whole story: live data, background renewal,
        // the Claude structural context, and the honest last-refresh error.
        #expect(recovery.tooltip.contains("live"))
        #expect(recovery.tooltip.contains("renewing it automatically"))
        #expect(recovery.tooltip.contains("Last refresh failed:"))
    }

    @Test func idleWithStaleObservationKeepsTheIdleTone() throws {
        let recovery = try #require(DeckFreshness.signInRecovery(
            for: idleAccount(),
            newestObservedAt: now.addingTimeInterval(-3 * interval),
            now: now,
            autoRefreshInterval: interval
        ))
        #expect(recovery.tone == .idle)
        #expect(recovery.text == "Idle — renews on next use")
    }

    @Test func idleWithNoObservationKeepsTheIdleTone() throws {
        let recovery = try #require(DeckFreshness.signInRecovery(
            for: idleAccount(),
            newestObservedAt: nil,
            now: now,
            autoRefreshInterval: interval
        ))
        #expect(recovery.tone == .idle)
    }

    @Test func signedOutNeverUpgradesEvenWithFreshData() throws {
        // A genuinely missing sign-in stays the alarm — fresh rows on the
        // card do not soften a real sign-out.
        let recovery = try #require(DeckFreshness.signInRecovery(
            for: idleAccount(signinReason: "missing"),
            newestObservedAt: now.addingTimeInterval(-60),
            now: now,
            autoRefreshInterval: interval
        ))
        #expect(recovery.tone == .signedOut)
        #expect(recovery.text == "Sign in needed")
    }

    @Test func clockFreeDerivationNeverProducesLiveIdle() throws {
        // Age-blind surfaces (footer breakdown, Settings roster) keep the
        // existing idle story — only the clocked variant can say "live".
        let recovery = try #require(DeckFreshness.signInRecovery(for: idleAccount()))
        #expect(recovery.tone == .idle)
    }

    @Test func rowVariantUsesTheRowsNewestObservation() throws {
        let account = idleAccount()
        let state = DeckState(
            accounts: [account],
            usage: [UsageSnapshot(
                accountId: account.id, scope: "weekly", remainingPercent: 45,
                resetsAt: iso(hoursFromNow: 84), observedAt: iso(secondsAgo: 30),
                source: "claude-statusline"
            )]
        )
        let row = try #require(DeckBuilder.rows(state: state, now: now).first)
        let recovery = try #require(row.signInRecovery(now: now, autoRefreshInterval: interval))
        #expect(recovery.tone == .liveIdle)
        // Nil-ness matches the clock-free variant, so the warning slot and
        // the notice-suppression logic never disagree with the card.
        #expect(row.signInRecovery != nil)
    }

    // Renewal candidacy is untouched by the presentation split: the renew
    // affordance still keys on healthChip == .idleSignIn (signinReason
    // "expired"), which the live tone never alters.
    @Test func renewalCandidacySurvivesTheLiveState() {
        let account = idleAccount(renew: AccountRenewCapability(available: true))
        let recovery = DeckFreshness.signInRecovery(
            for: account,
            newestObservedAt: now.addingTimeInterval(-60),
            now: now,
            autoRefreshInterval: interval
        )
        #expect(recovery?.tone == .liveIdle)
        #expect(account.healthChip == .idleSignIn)
        #expect(AccountRenew.action(for: account) == .renewNow)
    }
}

// MARK: - Availability Health inclusion by data age

@Suite("Issue #264 — health includes flagged accounts on data age")
struct Issue264HealthInclusionTests {
    private func state(observedSecondsAgo: TimeInterval) -> DeckState {
        DeckState(
            accounts: [idleAccount(label: "Studio")],
            usage: [UsageSnapshot(
                accountId: "a1", scope: "weekly", remainingPercent: 60,
                resetsAt: iso(hoursFromNow: 84),
                observedAt: iso(secondsAgo: observedSecondsAgo),
                source: "claude-statusline"
            )]
        )
    }

    @Test func flaggedAccountWithFreshServerTruthJoinsThePool() {
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(
            for: .claude, state: state(observedSecondsAgo: 120), now: now
        )
        #expect(pool.map(\.label) == ["Studio"])
        #expect(excluded.isEmpty)
    }

    @Test func flaggedAccountWithStaleDataIsExcludedWithTheAuthReason() {
        // The auth flag is WHY the data froze — the health detail keeps
        // telling the sign-in story, not a vague staleness line.
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(
            for: .claude, state: state(observedSecondsAgo: 45 * 60), now: now
        )
        #expect(pool.isEmpty)
        #expect(excluded == [AvailabilityExclusion(label: "Studio", reason: "sign in needed")])
    }

    @Test func flaggedAccountWithNoDataIsExcludedWithTheAuthReason() {
        let state = DeckState(accounts: [idleAccount(label: "Studio")], usage: [])
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(for: .claude, state: state, now: now)
        #expect(pool.isEmpty)
        #expect(excluded == [AvailabilityExclusion(label: "Studio", reason: "sign in needed")])
    }

    @Test func duplicateTokenStaysExcludedEvenWithFreshData() {
        // Two profiles holding the same login would double-count one
        // subscription's capacity — freshness cannot fix identity.
        let state = DeckState(
            accounts: [idleAccount(label: "Twin", authState: "duplicate-token", signinReason: nil)],
            usage: [UsageSnapshot(
                accountId: "a1", scope: "weekly", remainingPercent: 60,
                resetsAt: iso(hoursFromNow: 84), observedAt: iso(secondsAgo: 60)
            )]
        )
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(for: .claude, state: state, now: now)
        #expect(pool.isEmpty)
        #expect(excluded == [AvailabilityExclusion(label: "Twin", reason: "duplicate login")])
    }
}

// MARK: - Menu-bar headline (bonus fix)

@Suite("Issue #264 — frozen percentages never own the headline")
struct Issue264HeadlineTests {
    private func accounts(flaggedAuth: String?) -> [DeckAccount] {
        [
            DeckAccount(id: "flagged", provider: "claude", label: "Frozen",
                        enabled: true, authState: flaggedAuth,
                        signinReason: flaggedAuth == "signin-required" ? "expired" : nil),
            DeckAccount(id: "healthy", provider: "claude", label: "Healthy",
                        enabled: true, authState: "ok"),
        ]
    }

    private func usage(flaggedObservedSecondsAgo: TimeInterval) -> [UsageSnapshot] {
        [
            UsageSnapshot(accountId: "flagged", scope: "5-hour", remainingPercent: 3,
                          observedAt: iso(secondsAgo: flaggedObservedSecondsAgo)),
            UsageSnapshot(accountId: "healthy", scope: "5-hour", remainingPercent: 40,
                          observedAt: iso(secondsAgo: 60)),
        ]
    }

    @Test func frozenFlaggedRowLosesTheHeadline() throws {
        let state = DeckState(
            accounts: accounts(flaggedAuth: "signin-required"),
            usage: usage(flaggedObservedSecondsAgo: 2 * 3600)
        )
        let worst = try #require(WorstRemainingCalculator.worstRemaining(in: state, now: now))
        #expect(worst.accountId == "healthy")
        #expect(worst.percent == 40)
    }

    @Test func freshFlaggedRowStillWinsTheHeadline() throws {
        // A live session's statusline captures keep the rows fresh — that
        // account is honestly usable and its 3% is the real headline.
        let state = DeckState(
            accounts: accounts(flaggedAuth: "signin-required"),
            usage: usage(flaggedObservedSecondsAgo: 60)
        )
        let worst = try #require(WorstRemainingCalculator.worstRemaining(in: state, now: now))
        #expect(worst.accountId == "flagged")
        #expect(worst.percent == 3)
    }

    @Test func keychainDeniedFreezesTheSameWay() throws {
        let state = DeckState(
            accounts: accounts(flaggedAuth: "keychain-denied"),
            usage: usage(flaggedObservedSecondsAgo: 2 * 3600)
        )
        let worst = try #require(WorstRemainingCalculator.worstRemaining(in: state, now: now))
        #expect(worst.accountId == "healthy")
    }

    @Test func unflaggedOldDataStillCounts() throws {
        // The IdleRollforward isolation contract survives: an account with
        // no auth flag keeps its stored percents in the headline no matter
        // the age — only accounts that CANNOT refresh lose frozen rows.
        let state = DeckState(
            accounts: accounts(flaggedAuth: "ok"),
            usage: usage(flaggedObservedSecondsAgo: 2 * 86_400)
        )
        let worst = try #require(WorstRemainingCalculator.worstRemaining(in: state, now: now))
        #expect(worst.accountId == "flagged")
        #expect(worst.percent == 3)
    }

    @Test func pinnedVariantIsDeliberatelyUntouched() throws {
        // A pin is an explicit user choice; its tooltip names the window.
        let state = DeckState(
            accounts: accounts(flaggedAuth: "signin-required"),
            usage: usage(flaggedObservedSecondsAgo: 2 * 3600)
        )
        let pinned = try #require(
            WorstRemainingCalculator.worstRemaining(in: state, accountId: "flagged")
        )
        #expect(pinned.percent == 3)
    }
}
