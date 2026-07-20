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
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-30), now: now) == "Data from just now")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-300), now: now) == "Data from 5 min ago")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-7_200), now: now) == "Data from 2 hr ago")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-90_000), now: now) == "Data from 1 day ago")
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(-3 * 86_400), now: now) == "Data from 3 days ago")
        // Clock skew: a future observation reads as now, never negative.
        #expect(DeckFreshness.text(observedAt: now.addingTimeInterval(60), now: now) == "Data from just now")
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
        #expect(status?.text == "Data from 2 hr ago")
        #expect(status?.isStale == true) // default threshold 2×300 s
    }

    @Test func freshObservationIsNotStale() {
        let model = model()
        model.startAutoRefresh(interval: 300)
        defer { model.stopAutoRefresh() }
        model.apply(deckState: state(observedSecondsAgo: 90))
        let status = model.footerStatus(now: now)
        #expect(status == MenuBarStatusModel.FooterStatus(text: "Data from 1 min ago", isStale: false))
    }

    @Test func perRowStaleFlagForcesStalenessEvenWhenRecent() {
        let model = model()
        model.apply(deckState: state(observedSecondsAgo: 30, stale: true))
        let status = model.footerStatus(now: now)
        #expect(status?.text == "Data from just now")
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
