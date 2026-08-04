import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #244 — the rolling burn-rate window ("today's rate"). The traps
// these tests pin are all optimistic-direction: a cold window must never
// fabricate a rate, a reset crossing must never read as negative burn
// (which would dilute the pool rate toward zero and flatter the verdict),
// and stale/duplicate observations must never stretch the span or the
// rate. Placeholder labels only — never real account data.

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(minutesAgo minutes: Double) -> String {
    ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(-minutes * 60))
}

/// One max_20x Claude account (tier weight 20 → 2000-point weeks) whose
/// generic-weekly snapshot reads `remaining`% observed `minutesAgo`.
private func state(
    accounts: [(id: String, provider: String, tier: String?, remaining: Double, observedMinutesAgo: Double)]
) -> DeckState {
    DeckState(
        accounts: accounts.map { spec in
            DeckAccount(
                id: spec.id, provider: spec.provider, label: "Acct-\(spec.id)",
                metadata: spec.tier.map {
                    DeckAccountMetadata(claudePlan: ProviderPlanInfo(rateLimitTier: $0))
                },
                authState: "ok"
            )
        },
        usage: accounts.map { spec in
            UsageSnapshot(
                accountId: spec.id, scope: "weekly",
                remainingPercent: spec.remaining,
                resetsAt: iso(minutesAgo: -84 * 60),
                observedAt: iso(minutesAgo: spec.observedMinutesAgo)
            )
        }
    )
}

private func max20x(
    remaining: Double, observedMinutesAgo: Double, id: String = "c1"
) -> DeckState {
    state(accounts: [(id, "claude", "max_20x", remaining, observedMinutesAgo)])
}

@Suite("BurnRateWindow (issue #244)")
struct BurnRateWindowTests {
    // MARK: Cold start / span threshold

    @Test func coldStartIsInactive() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 1), now: fixedNow)
        // One sample: no interval, no opinion — the engine must behave
        // exactly as pre-#244.
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }

    @Test func underThirtyMinutesOfSpanStaysInactive() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 20), now: fixedNow)
        window.record(state: max20x(remaining: 80, observedMinutesAgo: 0), now: fixedNow)
        // A violent 20-minute burn is still only 20 minutes of evidence.
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }

    @Test func activatesAtExactlyThirtyMinutesOfSpan() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 30), now: fixedNow)
        window.record(state: max20x(remaining: 89, observedMinutesAgo: 0), now: fixedNow)
        // 1% of a 20x week = 20 points over half an hour → 960 pts/day.
        let rate = window.burstRate(for: .claude, now: fixedNow)
        #expect(rate != nil)
        #expect(abs((rate ?? 0) - 960) < 0.5)
    }

    @Test func staleSampleCannotPropTheSpanOpen() {
        // Adversarial review finding 1 (the reviewer's exact scenario):
        // account A's snapshot is stuck 30 minutes old — one sample, no
        // interval — while account B has a single 5-minute pair. The old
        // all-samples span read 30 minutes and ACTIVATED, fabricating a
        // pool rate from 5 minutes of B extrapolated ×288. The usable
        // span is B's 5 minutes: INACTIVE.
        var window = BurnRateWindow()
        window.record(state: state(accounts: [
            ("a", "claude", "max_20x", 50, 30),
            ("b", "claude", "max_20x", 90, 5),
        ]), now: fixedNow)
        // Next refresh: A's snapshot is still stuck at the same
        // observedAt (deduped); only B advances.
        window.record(state: state(accounts: [
            ("a", "claude", "max_20x", 50, 30),
            ("b", "claude", "max_20x", 89, 0),
        ]), now: fixedNow)
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }

    @Test func resetDroppedIntervalsDoNotCountTowardTheSpan() {
        // Same trap, reset flavor: an account whose only interval was
        // reset-dropped contributes no evidence — its endpoints must not
        // stretch the activation span for a sibling's short pair.
        var window = BurnRateWindow()
        window.record(state: state(accounts: [
            ("a", "claude", "max_20x", 10, 40),
            ("b", "claude", "max_20x", 90, 5),
        ]), now: fixedNow)
        window.record(state: state(accounts: [
            ("a", "claude", "max_20x", 95, 0), // reset crossed: dropped
            ("b", "claude", "max_20x", 89, 0),
        ]), now: fixedNow)
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }

    // MARK: Reset handling

    @Test func resetCrossingIntervalIsDroppedNotNegated() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 10, observedMinutesAgo: 60), now: fixedNow)
        // Weekly reset crossed: remaining JUMPS 10% → 95%.
        window.record(state: max20x(remaining: 95, observedMinutesAgo: 30), now: fixedNow)
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 0), now: fixedNow)
        // Only the post-reset interval counts: 5% (100 pts) over 30 min →
        // 4800 pts/day. Averaging across the reset would have read
        // (200 − 1900 + 100 pts)/hour — negative burn, GREEN forever.
        let rate = window.burstRate(for: .claude, now: fixedNow)
        #expect(abs((rate ?? 0) - 4800) < 0.5)
    }

    @Test func onlyResetIntervalsMeansNoOpinion() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 10, observedMinutesAgo: 40), now: fixedNow)
        window.record(state: max20x(remaining: 95, observedMinutesAgo: 0), now: fixedNow)
        // The single interval crossed a reset: dropped, so there is no
        // usable interval at all — nil, never zero-dressed-as-measured
        // and NEVER a negative rate.
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }

    @Test func hiddenResetInsideANetPositiveGapIsDropped() {
        // Adversarial review finding 3: the account's scheduled resetsAt
        // lands INSIDE a sampling gap and remaining still shows a net
        // drop (90% → 88% across the snap): the naive 2-point delta
        // hides a full pool's worth of burn. The interval must be
        // dropped — and, being the only one, leave the window inactive.
        var window = BurnRateWindow()
        var deck = max20x(remaining: 90, observedMinutesAgo: 40)
        deck.usage[0].resetsAt = iso(minutesAgo: 20) // reset mid-gap
        window.record(state: deck, now: fixedNow)
        window.record(state: max20x(remaining: 88, observedMinutesAgo: 0), now: fixedNow)
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }

    @Test func futureResetsAtDoesNotDropIntervals() {
        // The normal case: resetsAt sits hours ahead of both samples —
        // the interval counts exactly as before finding 3.
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 30), now: fixedNow)
        window.record(state: max20x(remaining: 89, observedMinutesAgo: 0), now: fixedNow)
        #expect(abs((window.burstRate(for: .claude, now: fixedNow) ?? 0) - 960) < 0.5)
    }

    @Test func clockSkewedDaemonStillFeedsTheWindow() {
        // Adversarial review finding 5: a daemon stamping observations
        // 5 minutes ahead of this process's clock must not permanently
        // disable the feature. Beyond the 60 s jitter tolerance the
        // timestamp clamps to now — and 31 minutes later the window is
        // active with the true rate.
        var window = BurnRateWindow()
        var deck = max20x(remaining: 90, observedMinutesAgo: -5) // +5 min skew
        window.record(state: deck, now: fixedNow.addingTimeInterval(-31 * 60))
        deck = max20x(remaining: 89, observedMinutesAgo: -5 - 31) // +5 min skew, 31 min later
        window.record(state: deck, now: fixedNow)
        // 20 points over the 31 clamped minutes ≈ 929 pts/day.
        let rate = window.burstRate(for: .claude, now: fixedNow)
        #expect(rate != nil)
        #expect(abs((rate ?? 0) - 20.0 / (31 * 60) * 86_400) < 1)
    }

    @Test func smallFutureJitterIsKeptUnclamped() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 31), now: fixedNow)
        // 30 s ahead of now: ordinary jitter, kept and usable.
        window.record(state: max20x(remaining: 89, observedMinutesAgo: -0.5), now: fixedNow)
        #expect(window.sampleCount(for: .claude) == 2)
        #expect(window.burstRate(for: .claude, now: fixedNow) != nil)
    }

    @Test func rateIsNeverNegative() {
        var window = BurnRateWindow()
        // One account only ever "gains" (reset), the other burns.
        var deck = state(accounts: [
            ("c1", "claude", "max_20x", 10, 31),
            ("c2", "claude", "max_20x", 50, 31),
        ])
        window.record(state: deck, now: fixedNow)
        deck = state(accounts: [
            ("c1", "claude", "max_20x", 95, 0),
            ("c2", "claude", "max_20x", 49, 0),
        ])
        window.record(state: deck, now: fixedNow)
        // c1's reset interval is dropped; c2's 20 points over 31 min stand.
        let rate = window.burstRate(for: .claude, now: fixedNow)
        #expect(rate != nil)
        #expect((rate ?? -1) >= 0)
        #expect(abs((rate ?? 0) - 20.0 / (31 * 60) * 86_400) < 0.5)
    }

    // MARK: Age pruning

    @Test func samplesOlderThanTheWindowArePruned() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 200), now: fixedNow)
        window.record(state: max20x(remaining: 85, observedMinutesAgo: 190), now: fixedNow)
        window.record(state: max20x(remaining: 80, observedMinutesAgo: 20), now: fixedNow)
        window.record(state: max20x(remaining: 79, observedMinutesAgo: 0), now: fixedNow)
        // The 200/190-minute samples fell out of the 3-hour window: only
        // 20 minutes of span remain, so the window is INACTIVE — expired
        // history must not prop the span open.
        #expect(window.sampleCount(for: .claude) == 2)
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }

    @Test func pruneIsRelativeToNowNotToRecordTime() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 35), now: fixedNow)
        window.record(state: max20x(remaining: 89, observedMinutesAgo: 0), now: fixedNow)
        #expect(window.burstRate(for: .claude, now: fixedNow) != nil)
        // Four hours later, without new records, the same samples are out
        // of window — the pure read must not resurrect them.
        #expect(window.burstRate(for: .claude, now: fixedNow.addingTimeInterval(4 * 3600)) == nil)
    }

    // MARK: Deduplication

    @Test func repeatedObservationsRecordOnce() {
        var window = BurnRateWindow()
        let deck = max20x(remaining: 90, observedMinutesAgo: 5)
        window.record(state: deck, now: fixedNow)
        window.record(state: deck, now: fixedNow)
        window.record(state: deck, now: fixedNow)
        // A refresh that returns the same provider observation (same
        // observedAt) adds nothing: no fake zero-burn intervals.
        #expect(window.sampleCount(for: .claude) == 1)
    }

    // MARK: Aggregation

    @Test func poolRateSumsAcrossAccounts() {
        var window = BurnRateWindow()
        var deck = state(accounts: [
            ("c1", "claude", "max_20x", 90, 30),
            ("c2", "claude", "max_20x", 60, 30),
        ])
        window.record(state: deck, now: fixedNow)
        deck = state(accounts: [
            ("c1", "claude", "max_20x", 89, 0),
            ("c2", "claude", "max_20x", 59, 0),
        ])
        window.record(state: deck, now: fixedNow)
        // Two accounts each burning 960 pts/day → pool 1920.
        #expect(abs((window.burstRate(for: .claude, now: fixedNow) ?? 0) - 1920) < 1)
    }

    @Test func samplesAreTierWeighted() {
        var window = BurnRateWindow()
        // Same 1%-per-half-hour burn on a Pro (weight 1): 1 point per 30
        // minutes → 48 pts/day, not the 20x account's 960.
        window.record(
            state: state(accounts: [("p1", "claude", "pro", 90, 30)]), now: fixedNow
        )
        window.record(
            state: state(accounts: [("p1", "claude", "pro", 89, 0)]), now: fixedNow
        )
        #expect(abs((window.burstRate(for: .claude, now: fixedNow) ?? 0) - 48) < 0.5)
    }

    @Test func providersAreIndependent() {
        var window = BurnRateWindow()
        window.record(state: max20x(remaining: 90, observedMinutesAgo: 30), now: fixedNow)
        window.record(state: max20x(remaining: 89, observedMinutesAgo: 0), now: fixedNow)
        #expect(window.burstRate(for: .claude, now: fixedNow) != nil)
        // A Claude burn is no opinion about the Codex pool.
        #expect(window.burstRate(for: .codex, now: fixedNow) == nil)
    }

    @Test func disabledAccountsAreNotSampled() {
        var window = BurnRateWindow()
        var deck = max20x(remaining: 90, observedMinutesAgo: 30)
        deck.accounts[0].enabled = false
        window.record(state: deck, now: fixedNow)
        var later = max20x(remaining: 80, observedMinutesAgo: 0)
        later.accounts[0].enabled = false
        window.record(state: later, now: fixedNow)
        #expect(window.sampleCount(for: .claude) == 0)
        #expect(window.burstRate(for: .claude, now: fixedNow) == nil)
    }
}
