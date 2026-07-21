import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #90 — honest refresh cadence. The daemon's active-session cap only
// steers the never-customized default interval, and whenever the EFFECTIVE
// cadence is slower than the configured one, /api/state says so
// (scheduler.effectiveRefreshReason). The app decodes that surface
// tolerantly, shows a calm footer indicator, and bases ALL staleness math on
// the effective interval so the cap never falsely marks cards stale.

@Suite("Refresh cadence honesty (issue #90)")
@MainActor
struct RefreshCadenceHonestyTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func decode(_ json: String) throws -> DeckState {
        try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
    }

    private func scheduler(
        effective: Int?,
        configured: Int? = 300,
        reason: String? = "active-session-cap"
    ) -> DeckScheduler {
        DeckScheduler(
            pausedForActiveSessions: true,
            configuredRefreshIntervalSeconds: configured,
            effectiveRefreshIntervalSeconds: effective,
            effectiveRefreshReason: reason
        )
    }

    private func iso(secondsAgo: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
    }

    private func snapshot(secondsAgo: TimeInterval) -> UsageSnapshot {
        UsageSnapshot(accountId: "acct-1", scope: "5h", remainingPercent: 50, observedAt: iso(secondsAgo: secondsAgo))
    }

    private func model(state: DeckState, configuredInterval: TimeInterval) -> MenuBarStatusModel {
        let model = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { [now] in now }
        )
        // Records the configured interval; the armed timer (if any) is
        // cancelled immediately so the test stays synchronous.
        model.startAutoRefresh(interval: configuredInterval)
        model.stopAutoRefresh()
        model.apply(deckState: state)
        return model
    }

    // MARK: - Decode (tolerant, old daemons included)

    @Test func decodesTheFullSchedulerSurface() throws {
        let state = try decode(#"""
        {"accounts": [], "usage": [],
         "scheduler": {"pausedForActiveSessions": true,
                       "configuredRefreshIntervalSeconds": 300,
                       "effectiveRefreshIntervalSeconds": 1800,
                       "effectiveRefreshReason": "active-session-cap"}}
        """#)
        #expect(state.scheduler?.pausedForActiveSessions == true)
        #expect(state.scheduler?.configuredRefreshIntervalSeconds == 300)
        #expect(state.scheduler?.effectiveRefreshIntervalSeconds == 1800)
        #expect(state.scheduler?.effectiveRefreshReason == "active-session-cap")
    }

    @Test func decodesTheOldDaemonSchedulerWithoutCadenceFields() throws {
        // Pre-#90 daemons sent only pausedForActiveSessions.
        let state = try decode(#"{"accounts": [], "usage": [], "scheduler": {"pausedForActiveSessions": false}}"#)
        #expect(state.scheduler?.pausedForActiveSessions == false)
        #expect(state.scheduler?.effectiveRefreshIntervalSeconds == nil)
        #expect(state.scheduler?.effectiveRefreshReason == nil)
    }

    @Test func decodesNullEffectiveIntervalWhileAutoRefreshDisabled() throws {
        let state = try decode(#"""
        {"accounts": [], "usage": [],
         "scheduler": {"pausedForActiveSessions": false,
                       "configuredRefreshIntervalSeconds": 300,
                       "effectiveRefreshIntervalSeconds": null,
                       "effectiveRefreshReason": null}}
        """#)
        #expect(state.scheduler?.effectiveRefreshIntervalSeconds == nil)
        #expect(state.scheduler?.effectiveRefreshReason == nil)
    }

    @Test func missingOrMalformedSchedulerReadsAsAbsent() throws {
        #expect(try decode(#"{"accounts": [], "usage": []}"#).scheduler == nil)
        #expect(try decode(#"{"accounts": [], "usage": [], "scheduler": "nope"}"#).scheduler == nil)
    }

    // MARK: - Indicator visibility

    @Test func noticeShownWhileTheCapSlowsTheDefaultInterval() {
        let model = model(
            state: DeckState(scheduler: scheduler(effective: 1_800)),
            configuredInterval: 300
        )
        let notice = model.refreshCadenceNotice
        #expect(notice != nil)
        #expect(notice?.text == "Auto-refresh slowed")
        #expect(notice?.tooltip.contains("every 30 min") == true)
        #expect(notice?.tooltip.contains("every 5 min") == true)
        // The migration-honesty promise: confirming the current interval
        // (the Settings "Keep" affordance) lifts the cap permanently
        // (change-event provenance, issue #90).
        #expect(notice?.tooltip.contains("Keep") == true)
        #expect(notice?.tooltip.contains("your current 5 min") == true)
        #expect(notice?.tooltip.contains("permanently") == true)
    }

    @Test func noNoticeWhenEffectiveMatchesConfigured() {
        let model = model(
            state: DeckState(scheduler: scheduler(effective: 300, reason: nil)),
            configuredInterval: 300
        )
        #expect(model.refreshCadenceNotice == nil)
    }

    @Test func noNoticeForAnUnknownSlowdownReason() {
        let model = model(
            state: DeckState(scheduler: scheduler(effective: 1_800, reason: "solar-flare")),
            configuredInterval: 300
        )
        #expect(model.refreshCadenceNotice == nil)
    }

    @Test func noNoticeOnOldDaemonsWithoutTheSchedulerSurface() {
        let model = model(state: DeckState(), configuredInterval: 300)
        #expect(model.refreshCadenceNotice == nil)
    }

    @Test func noNoticeWhileAutoRefreshDisabled() {
        let model = model(
            state: DeckState(scheduler: scheduler(effective: nil, reason: nil)),
            configuredInterval: 0
        )
        #expect(model.refreshCadenceNotice == nil)
    }

    // MARK: - DeckFreshness consistency (#89 stale math uses the EFFECTIVE interval)

    @Test func footerStaleMathUsesTheEffectiveIntervalWhileCapped() {
        // Data 20 min old: stale against 2x300s, fresh against 2x1800s.
        let usage = [snapshot(secondsAgo: 1_200)]
        let capped = model(
            state: DeckState(usage: usage, scheduler: scheduler(effective: 1_800)),
            configuredInterval: 300
        )
        #expect(capped.stalenessInterval == 1_800)
        #expect(capped.footerStatus(now: now)?.isStale == false)

        let uncapped = model(state: DeckState(usage: usage), configuredInterval: 300)
        #expect(uncapped.stalenessInterval == 300)
        #expect(uncapped.footerStatus(now: now)?.isStale == true)
    }

    @Test func footerStillFlagsDataOlderThanTheEffectiveCadence() {
        // 70 min old: stale even against 2x the capped 30-min cadence.
        let model = model(
            state: DeckState(usage: [snapshot(secondsAgo: 4_200)], scheduler: scheduler(effective: 1_800)),
            configuredInterval: 300
        )
        #expect(model.footerStatus(now: now)?.isStale == true)
    }

    @Test func cardStalenessUsesTheEffectiveIntervalWhileCapped() {
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Main")
        let row = DeckAccountRow(
            account: account,
            provider: nil,
            windows: [],
            isActive: false,
            activationState: .unknown,
            newestObservedAt: now.addingTimeInterval(-1_200)
        )
        let capped = model(
            state: DeckState(accounts: [account], scheduler: scheduler(effective: 1_800)),
            configuredInterval: 300
        )
        #expect(capped.cardStaleness(for: row, now: now) == nil)

        let uncapped = model(state: DeckState(accounts: [account]), configuredInterval: 300)
        #expect(uncapped.cardStaleness(for: row, now: now) != nil)
    }
}
