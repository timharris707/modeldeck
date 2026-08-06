import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #257 (Tim, 2026-08-05): the Claude chip read GREEN 96 while four of
// six accounts sat at 1–3% Fable. The 7-day runway was defensible — every
// account resets inside the horizon — but nothing in the verdict reacted to
// how little was reachable AT THAT MOMENT, which is the question Availability
// Health exists to answer. Present scarcity now caps the runway verdict.
//
// Issue #258: and the chip evaluates whichever window the deck is showing,
// so flipping the #254 header toggle switches the basis between Fable weekly
// and the general weekly.
//
// Placeholder identities only — never real account data.

private let fixedNow = Date(timeIntervalSince1970: 1_785_000_000)

private func iso(hoursFromNow hours: Double) -> String {
    ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(hours * 3600))
}

/// Claude accounts with BOTH weekly windows, so the #258 basis switch has
/// something to switch to.
private func claudeState(
    _ specs: [(id: String, tier: String, fable: Double, general: Double, resetsInHours: Double)]
) -> DeckState {
    DeckState(
        accounts: specs.map { spec in
            DeckAccount(
                id: spec.id, provider: "claude", label: "Acct-\(spec.id)",
                metadata: DeckAccountMetadata(
                    claudePlan: ProviderPlanInfo(rateLimitTier: spec.tier)
                ),
                authState: "ok"
            )
        },
        usage: specs.flatMap { spec in
            [
                UsageSnapshot(
                    accountId: spec.id, scope: "Fable weekly",
                    remainingPercent: spec.fable,
                    resetsAt: iso(hoursFromNow: spec.resetsInHours),
                    observedAt: iso(hoursFromNow: -1.0 / 60)
                ),
                UsageSnapshot(
                    accountId: spec.id, scope: "weekly",
                    remainingPercent: spec.general,
                    resetsAt: iso(hoursFromNow: spec.resetsInHours),
                    observedAt: iso(hoursFromNow: -1.0 / 60)
                ),
            ]
        }
    )
}

/// Tim's 2026-08-05 deck: two accounts with real Fable left, four spent,
/// while the general weekly still has room everywhere.
private var scarceFableState: DeckState {
    claudeState([
        ("c1", "max_20x", 39, 74, 152),
        ("c2", "max_20x", 33, 66, 150),
        ("c3", "max_20x", 3, 43, 1.3),
        ("c4", "max_20x", 2, 46, 75),
        ("c5", "max_20x", 2, 50, 86),
        ("c6", "max_20x", 1, 47, 56),
    ])
}

@Suite("Present scarcity caps the runway verdict (issue #257)")
struct HealthScarcityTests {
    @Test func theFieldDeckReadsYellowNotGreen() {
        let r = AvailabilityHealthEngine.report(
            for: .claude, state: scarceFableState, now: fixedNow
        )
        // Pre-#257 this was GREEN 96: the sim never droughts because every
        // account resets inside the horizon.
        #expect(r.verdict == .yellow)
        #expect(r.scarcityCapped)
        #expect(r.usableAccountCount == 2)
        #expect(r.pool.count == 6)
        // 39% + 33% of two Max 20x weeks = 1440 pts.
        #expect(r.usablePoints == 1440)
        // The stranded 160 pts still count in the raw pool, and the gap is
        // exactly what the new "usable now" line exists to expose.
        #expect(r.poolPoints == 1600)
    }

    @Test func theCapNeverImprovesAVerdict() {
        // A runway-RED deck stays RED even though the scarcity rule alone
        // would only ask for YELLOW: the cap lowers, never lifts.
        let state = claudeState([
            ("c1", "max_20x", 8, 8, 160),
            ("c2", "max_20x", 1, 1, 160),
        ])
        let r = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        #expect(r.verdict == .red)
    }

    @Test func aHealthyDeckIsUntouched() {
        let state = claudeState([
            ("c1", "max_20x", 80, 85, 100),
            ("c2", "max_20x", 70, 75, 120),
        ])
        let r = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        #expect(r.verdict == .green)
        #expect(r.scarcityCapped == false)
        #expect(r.usableAccountCount == 2)
    }

    @Test func aLowPoolWithMostAccountsAliveIsNotCapped() {
        // The #244 field deck Tim confirmed as GREEN: pool 11.6% of
        // capacity, but four of five accounts are working. A low pool ALONE
        // must never cap — otherwise that calibration silently regresses.
        let state = claudeState([
            ("c1", "max_20x", 4, 4, 7),
            ("c2", "max_20x", 14.5, 14.5, 31),
            ("c3", "max_20x", 14.5, 14.5, 55),
            ("c4", "max_20x", 14.5, 14.5, 103),
            ("c5", "max_20x", 14.5, 14.5, 127),
        ])
        let r = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        #expect(r.usableAccountCount == 4)
        #expect(r.scarcityCapped == false)
        #expect(r.verdict == .green)
    }

    @Test func imminentReliefSoftensTheCapFromRedToYellow() {
        // The cap itself, in isolation: same emptiness, different relief.
        // (End to end this branch is narrow — a pool this empty with no
        // reset for days usually droughts, so the RUNWAY already says RED
        // and the cap has nothing left to lower. Testing the rule directly
        // keeps its intent pinned regardless.)
        let empty = { (hoursToFirstReset: Double) in
            [
                AvailabilityPoolAccount(label: "a", remainingPoints: 40, capacityPoints: 2000, hoursToReset: hoursToFirstReset),
                AvailabilityPoolAccount(label: "b", remainingPoints: 20, capacityPoints: 2000, hoursToReset: 90),
                AvailabilityPoolAccount(label: "c", remainingPoints: 20, capacityPoints: 2000, hoursToReset: 120),
            ]
        }
        #expect(AvailabilityHealthEngine.scarcityCap(empty(1)) == .yellow)
        #expect(AvailabilityHealthEngine.scarcityCap(empty(80)) == .red)
        // Relief never buys an all-clear: the cap is YELLOW at best.
        #expect(AvailabilityHealthEngine.scarcityCap(empty(0.1)) != .green)
    }

    @Test func imminentReliefKeepsAGreenRunwayAtYellowNotRed() {
        // Everything nearly spent, but resets land within hours, so the
        // runway itself stays healthy. The cap is what speaks — and it says
        // caution, not alarm.
        let state = claudeState([
            ("c1", "max_20x", 2, 40, 1),
            ("c2", "max_20x", 2, 40, 2),
            ("c3", "max_20x", 2, 40, 3),
            ("c4", "max_20x", 2, 40, 4),
        ])
        let r = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        #expect(r.usableAccountCount == 0)
        #expect(r.scarcityCapped)
        #expect(r.verdict == .yellow)
    }

    @Test func nearEmptyAccountsAreNotCountedAsUsable() {
        let accounts = [
            AvailabilityPoolAccount(label: "full", remainingPoints: 1000, capacityPoints: 2000, hoursToReset: 100),
            AvailabilityPoolAccount(label: "fumes", remainingPoints: 40, capacityPoints: 2000, hoursToReset: 100),
            AvailabilityPoolAccount(label: "exactly-at-floor", remainingPoints: 100, capacityPoints: 2000, hoursToReset: 100),
        ]
        // 5% of own capacity is usable; below it is not.
        #expect(AvailabilityHealthEngine.usableAccountCount(accounts) == 2)
        #expect(AvailabilityHealthEngine.usablePoints(accounts) == 1100)
    }

    @Test func theCappedReadoutExplainsPresentScarcityNotPace() {
        let r = AvailabilityHealthEngine.report(
            for: .claude, state: scarceFableState, now: fixedNow
        )
        let p = AvailabilityHealthPresentation.make(report: r, now: fixedNow)
        // The runway sentence ("you could sustain N× your pace") reads as an
        // all-clear beside four near-empty cards — that was the complaint.
        #expect(p.readout.contains("usable right now"))
        #expect(p.readout.contains("2 of 6 accounts"))
        #expect(p.readout.contains("sustain") == false)
        // And the fact list states the reachable number beside the raw pool.
        #expect(p.factLines.contains { $0.contains("Usable now:") && $0.contains("2 of 6") })
    }
}

@Suite("Health basis follows the deck window toggle (issue #258)")
struct HealthBasisTests {
    @Test func fableBasisIsTheDefault() {
        let r = AvailabilityHealthEngine.report(
            for: .claude, state: scarceFableState, now: fixedNow
        )
        // 39 + 33 + 3 + 2 + 2 + 1 = 80% of six Max 20x weeks.
        #expect(r.poolPoints == 1600)
        #expect(r.verdict == .yellow)
    }

    @Test func generalWeeklyBasisEvaluatesTheOtherPool() {
        let r = AvailabilityHealthEngine.report(
            for: .claude, state: scarceFableState, now: fixedNow, generalWeekly: true
        )
        // 74 + 66 + 43 + 46 + 50 + 47 = 326% → 6520 pts, all six usable.
        #expect(r.poolPoints == 6520)
        #expect(r.usableAccountCount == 6)
        #expect(r.scarcityCapped == false)
        #expect(r.verdict == .green)
    }

    @Test func codexIgnoresTheFlagEntirely() {
        // Codex's driver scope is already the general weekly, and the #254
        // toggle never touches Codex cards.
        #expect(
            AvailabilityHealthEngine.driverScopes(for: .codex, generalWeekly: true).primary
                == AvailabilityHealthEngine.driverScopes(for: .codex, generalWeekly: false).primary
        )
        #expect(AvailabilityHealthEngine.driverScopes(for: .codex, generalWeekly: true).primary == "weekly")
    }

    @Test func claudeDriverScopesSwitchWithTheFlag() {
        let fable = AvailabilityHealthEngine.driverScopes(for: .claude, generalWeekly: false)
        #expect(fable.primary == "fable weekly")
        #expect(fable.fallback == "weekly")
        let general = AvailabilityHealthEngine.driverScopes(for: .claude, generalWeekly: true)
        #expect(general.primary == "weekly")
        // No Fable fallback in general mode: the toggle asked for the
        // all-models window specifically, so silently falling back to the
        // model window would answer the wrong question.
        #expect(general.fallback == nil)
    }
}
