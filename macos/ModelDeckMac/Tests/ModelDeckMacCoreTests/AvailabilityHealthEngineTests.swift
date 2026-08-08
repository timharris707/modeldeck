import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #235 — the Availability Health engine: tier weights, pool building
// with named exclusions, the measured-pace / 7-day-simulation port of the
// validated subscore prototype, and Tim's refinement (the continuous
// sustainable pace multiple M, band derivation, 0–100 display mapping, and
// the plain-language readout). Placeholder labels only — never real
// account data. Deterministic throughout: the engine takes `now` as input.

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(hoursFromNow hours: Double) -> String {
    ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(hours * 3600))
}

private func claudeAccount(
    id: String,
    label: String,
    rateLimitTier: String? = nil,
    subscriptionType: String? = nil,
    authState: String? = "ok",
    enabled: Bool = true
) -> DeckAccount {
    let plan: ProviderPlanInfo? = (rateLimitTier == nil && subscriptionType == nil)
        ? nil
        : ProviderPlanInfo(subscriptionType: subscriptionType, rateLimitTier: rateLimitTier)
    return DeckAccount(
        id: id, provider: "claude", label: label,
        enabled: enabled,
        metadata: plan.map { DeckAccountMetadata(claudePlan: $0) },
        authState: authState
    )
}

private func codexAccount(
    id: String,
    label: String,
    planType: String? = nil,
    authState: String? = "ok"
) -> DeckAccount {
    DeckAccount(
        id: id, provider: "codex", label: label,
        metadata: planType.map {
            DeckAccountMetadata(codexPlan: ProviderPlanInfo(subscriptionType: $0))
        },
        authState: authState
    )
}

private func snapshot(
    accountId: String,
    scope: String,
    remaining: Double?,
    resetsInHours: Double? = 84,
    observedMinutesAgo: Double = 1,
    stale: Bool = false
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: resetsInHours.map { iso(hoursFromNow: $0) },
        observedAt: iso(hoursFromNow: -observedMinutesAgo / 60),
        stale: stale
    )
}

@Suite("Availability Health tier weights (issue #235)")
struct AvailabilityTierWeightTests {
    @Test func claudeMax20xWeighs20() {
        let weight = AvailabilityHealthEngine.claudeTierWeight(
            ProviderPlanInfo(subscriptionType: "max", rateLimitTier: "default_claude_max_20x")
        )
        #expect(weight == AvailabilityTierWeight(value: 20, isKnown: true))
    }

    @Test func claudeMax5xWeighs5() {
        let weight = AvailabilityHealthEngine.claudeTierWeight(
            ProviderPlanInfo(rateLimitTier: "max_5x")
        )
        #expect(weight == AvailabilityTierWeight(value: 5, isKnown: true))
    }

    @Test func claudeProWeighs1() {
        let weight = AvailabilityHealthEngine.claudeTierWeight(
            ProviderPlanInfo(subscriptionType: "pro")
        )
        #expect(weight == AvailabilityTierWeight(value: 1, isKnown: true))
    }

    @Test func claudeMaxWithoutMultiplierWeighsBaseTier5() {
        let weight = AvailabilityHealthEngine.claudeTierWeight(
            ProviderPlanInfo(subscriptionType: "max")
        )
        #expect(weight == AvailabilityTierWeight(value: 5, isKnown: true))
    }

    @Test func claudeUnknownTierFallsBackTo1AndIsFlagged() {
        #expect(AvailabilityHealthEngine.claudeTierWeight(nil)
            == AvailabilityTierWeight(value: 1, isKnown: false))
        #expect(AvailabilityHealthEngine.claudeTierWeight(
            ProviderPlanInfo(subscriptionType: "mystery")
        ) == AvailabilityTierWeight(value: 1, isKnown: false))
    }

    @Test func codexWeights() {
        #expect(AvailabilityHealthEngine.codexTierWeight(ProviderPlanInfo(subscriptionType: "pro"))
            == AvailabilityTierWeight(value: 10, isKnown: true))
        #expect(AvailabilityHealthEngine.codexTierWeight(ProviderPlanInfo(subscriptionType: "plus"))
            == AvailabilityTierWeight(value: 1, isKnown: true))
        #expect(AvailabilityHealthEngine.codexTierWeight(ProviderPlanInfo(subscriptionType: "business"))
            == AvailabilityTierWeight(value: 1, isKnown: true))
        #expect(AvailabilityHealthEngine.codexTierWeight(nil)
            == AvailabilityTierWeight(value: 1, isKnown: false))
        #expect(AvailabilityHealthEngine.codexTierWeight(ProviderPlanInfo(subscriptionType: "free"))
            == AvailabilityTierWeight(value: 1, isKnown: false))
    }

    @Test func tierMultiplierValueParsesTierStrings() {
        #expect(PlanTierFormatter.multiplierValue(in: "default_claude_max_20x") == 20)
        #expect(PlanTierFormatter.multiplierValue(in: "max_5x") == 5)
        #expect(PlanTierFormatter.multiplierValue(in: "pro") == nil)
        #expect(PlanTierFormatter.multiplierValue(in: nil) == nil)
    }
}

@Suite("Availability Health pool building (issue #235)")
struct AvailabilityPoolTests {
    @Test func claudePrefersFableWeeklyOverGenericWeekly() {
        let state = DeckState(
            accounts: [claudeAccount(id: "c1", label: "Studio", rateLimitTier: "max_20x")],
            usage: [
                snapshot(accountId: "c1", scope: "weekly", remaining: 90),
                snapshot(accountId: "c1", scope: "Fable weekly", remaining: 40),
            ]
        )
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(for: .claude, state: state, now: fixedNow)
        #expect(excluded.isEmpty)
        #expect(pool.count == 1)
        // 40% of a 20x tier: 800 of 2000 points.
        #expect(pool[0].remainingPoints == 800)
        #expect(pool[0].capacityPoints == 2000)
    }

    @Test func claudeFallsBackToGenericWeeklyAndAcceptsSynonyms() {
        let state = DeckState(
            accounts: [claudeAccount(id: "c1", label: "Studio", subscriptionType: "pro")],
            usage: [snapshot(accountId: "c1", scope: "week", remaining: 60)]
        )
        let (pool, _, _) = AvailabilityHealthEngine.pool(for: .claude, state: state, now: fixedNow)
        #expect(pool.count == 1)
        #expect(pool[0].remainingPoints == 60)
    }

    @Test func codexIgnoresModelScopedWeeklies() {
        // The generic "weekly" is the codex driver scope; a model-scoped
        // "GPT-5-Codex weekly" must never be mistaken for it.
        let state = DeckState(
            accounts: [codexAccount(id: "x1", label: "Ship", planType: "pro")],
            usage: [snapshot(accountId: "x1", scope: "GPT-5-Codex weekly", remaining: 90)]
        )
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(for: .codex, state: state, now: fixedNow)
        #expect(pool.isEmpty)
        #expect(excluded == [AvailabilityExclusion(label: "Ship", reason: "no weekly usage data")])
    }

    @Test func exclusionsAreNamedNeverSilent() {
        let state = DeckState(
            accounts: [
                claudeAccount(id: "c1", label: "SignedOut", authState: "signin-required"),
                claudeAccount(id: "c2", label: "Stale"),
                claudeAccount(id: "c3", label: "FlaggedStale"),
                claudeAccount(id: "c4", label: "NoReset"),
                claudeAccount(id: "c5", label: "NoScope"),
                claudeAccount(id: "c6", label: "Disabled", enabled: false),
                claudeAccount(id: "c7", label: "Healthy", subscriptionType: "pro"),
            ],
            usage: [
                // Issue #264: a flagged account's FRESH data would now be
                // included (see Issue264PresentationCandidacyTests) — this
                // fixture's flagged account sits on stale data, so the
                // exclusion reports the auth story, not generic staleness.
                snapshot(accountId: "c1", scope: "weekly", remaining: 50, observedMinutesAgo: 45),
                snapshot(accountId: "c2", scope: "weekly", remaining: 50, observedMinutesAgo: 45),
                snapshot(accountId: "c3", scope: "weekly", remaining: 50, stale: true),
                snapshot(accountId: "c4", scope: "weekly", remaining: 50, resetsInHours: nil),
                snapshot(accountId: "c6", scope: "weekly", remaining: 50),
                snapshot(accountId: "c7", scope: "weekly", remaining: 50),
            ]
        )
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(for: .claude, state: state, now: fixedNow)
        #expect(pool.map(\.label) == ["Healthy"])
        #expect(excluded == [
            AvailabilityExclusion(label: "SignedOut", reason: "sign in needed"),
            AvailabilityExclusion(label: "Stale", reason: "usage data is stale"),
            AvailabilityExclusion(label: "FlaggedStale", reason: "usage data is stale"),
            AvailabilityExclusion(label: "NoReset", reason: "missing remaining % or reset time"),
            AvailabilityExclusion(label: "NoScope", reason: "no weekly usage data"),
        ])
    }

    @Test func absentAuthStateIsToleratedForOlderDaemons() {
        // A pre-per-account-health daemon omits authState entirely; the
        // freshness gate still protects the sim, so the account counts.
        let state = DeckState(
            accounts: [claudeAccount(id: "c1", label: "Old", authState: nil)],
            usage: [snapshot(accountId: "c1", scope: "weekly", remaining: 70)]
        )
        let (pool, excluded, _) = AvailabilityHealthEngine.pool(for: .claude, state: state, now: fixedNow)
        #expect(pool.count == 1)
        #expect(excluded.isEmpty)
    }

    @Test func unknownTiersAreFlaggedAndCountedAtWeight1() {
        let state = DeckState(
            accounts: [claudeAccount(id: "c1", label: "Mystery")],
            usage: [snapshot(accountId: "c1", scope: "weekly", remaining: 80)]
        )
        let (pool, _, unknown) = AvailabilityHealthEngine.pool(for: .claude, state: state, now: fixedNow)
        #expect(pool == [AvailabilityPoolAccount(
            label: "Mystery", remainingPoints: 80, capacityPoints: 100,
            hoursToReset: pool[0].hoursToReset, tierKnown: false
        )])
        #expect(abs(pool[0].hoursToReset - 84) < 0.001)
        #expect(unknown == ["Mystery"])
    }
}

@Suite("Availability Health simulation (issue #235)")
struct AvailabilitySimulationTests {
    private func pool(
        remaining: Double, capacity: Double = 100, resetIn hours: Double
    ) -> AvailabilityPoolAccount {
        AvailabilityPoolAccount(
            label: "Studio", remainingPoints: remaining,
            capacityPoints: capacity, hoursToReset: hours
        )
    }

    @Test func measuredPaceIsTierWeightedUsedOverElapsedDays() {
        // 20x account half used, 3.5 days in (1000 pts used over 3.5 d) +
        // Pro half used, 3.5 days in (50 pts over 3.5 d): 1050 / 7 = 150.
        let accounts = [
            pool(remaining: 1000, capacity: 2000, resetIn: 84),
            pool(remaining: 50, capacity: 100, resetIn: 84),
        ]
        #expect(abs(AvailabilityHealthEngine.measuredPace(accounts) - 150) < 0.001)
    }

    @Test func measuredPaceIsZeroWithNoElapsedTime() {
        #expect(AvailabilityHealthEngine.measuredPace([pool(remaining: 100, resetIn: 168)]) == 0)
    }

    @Test func freshlyResetAccountDoesNotDiluteTheMeasuredPace() {
        // Review regression (PR #236, finding 1): account A reset about an
        // hour ago — its stored resetsAt has passed, so hoursToReset is
        // clamped to 0 — with a nearly full pool; account B is mid-cycle
        // and heavily used. The clamped account is FRESHLY reset (elapsed
        // ≈ 0, matching resetLands' next-snap-a-cycle-out reading), so the
        // pace must reflect B's true burn. The old end-of-cycle reading
        // charged A seven elapsed days and diluted the pace ~3x — a GREEN
        // verdict on a deck that is really YELLOW/RED.
        let accounts = [
            pool(remaining: 98, resetIn: 0),
            pool(remaining: 30, resetIn: 84),
        ]
        let pace = AvailabilityHealthEngine.measuredPace(accounts)
        // Used: 2 + 70 pts; elapsed: 0 + 3.5 days.
        #expect(abs(pace - 72.0 / 3.5) < 0.001)
    }

    @Test func floorScalesWithTheLargestAdmittedCapacity() {
        // Review (PR #236, finding 3): 5% of the largest admitted
        // account's capacity — the exact generalization of the prototype's
        // fixed 5 points, where every account's capacity was 100.
        #expect(AvailabilityHealthEngine.floorPoints(for: [
            pool(remaining: 0, capacity: 2000, resetIn: 10),
            pool(remaining: 0, capacity: 100, resetIn: 10),
        ]) == 100)
        #expect(AvailabilityHealthEngine.floorPoints(for: [
            pool(remaining: 0, capacity: 100, resetIn: 10)
        ]) == 5)
    }

    @Test func resetSnapsThePoolBackToFullCapacity() {
        // No drain: pool sits at 50 until the reset lands at hour 10, then
        // jumps to full capacity and stays there.
        let result = AvailabilityHealthEngine.simulate(
            [pool(remaining: 50, resetIn: 10)], pacePerDay: 0
        )
        #expect(result.minPoolPoints == 50)
        #expect(result.firstDroughtHour == nil)
        #expect(result.droughtHours == 0)
    }

    @Test func subHourResetSnapsInTheFirstSimulatedHour() {
        #expect(AvailabilityHealthEngine.resetLands(at: 0.5, inHour: 1))
        #expect(AvailabilityHealthEngine.resetLands(at: 1.0, inHour: 1))
        #expect(!AvailabilityHealthEngine.resetLands(at: 1.2, inHour: 1))
        #expect(AvailabilityHealthEngine.resetLands(at: 1.2, inHour: 2))
        // The already-passed reset re-lands one full cycle later.
        #expect(AvailabilityHealthEngine.resetLands(at: 0, inHour: 168))
    }

    @Test func droughtIsDetectedAtTheFloorWithTiming() {
        // 10 pts left, reset a week out, 24 pts/day: pool hits the 5-pt
        // floor at hour 5 and stays dry until the reset snaps it back.
        let result = AvailabilityHealthEngine.simulate(
            [pool(remaining: 10, resetIn: 167.5)], pacePerDay: 24
        )
        #expect(result.firstDroughtHour == 5)
        #expect(result.droughtHours > 100)
        #expect(result.minPoolPoints <= 5) // floor: 5% of the 100-pt capacity
    }

    @Test func extraSpendNowModelsTheHeadroomProbe() {
        let clean = AvailabilityHealthEngine.simulate(
            [pool(remaining: 100, resetIn: 84)], pacePerDay: 0
        )
        let spent = AvailabilityHealthEngine.simulate(
            [pool(remaining: 100, resetIn: 84)], pacePerDay: 0, extraSpendNow: 60
        )
        #expect(clean.minPoolPoints == 100)
        #expect(spent.minPoolPoints == 40)
    }
}

@Suite("Sustainable pace multiple and bands (issue #235 refinement)")
struct AvailabilityMultipleTests {
    private func pool(
        remaining: Double, capacity: Double = 100, resetIn hours: Double
    ) -> AvailabilityPoolAccount {
        AvailabilityPoolAccount(
            label: "Studio", remainingPoints: remaining,
            capacityPoints: capacity, hoursToReset: hours
        )
    }

    @Test func bandBoundariesAreExact() {
        // Pinned per Tim's refinement: exactly 1.0 is YELLOW (not RED),
        // exactly 2.0 is GREEN (not YELLOW).
        #expect(AvailabilityVerdict.band(forMultiple: 1.0) == .yellow)
        #expect(AvailabilityVerdict.band(forMultiple: 2.0) == .green)
        #expect(AvailabilityVerdict.band(forMultiple: 0.999) == .red)
        #expect(AvailabilityVerdict.band(forMultiple: 1.999) == .yellow)
        #expect(AvailabilityVerdict.band(forMultiple: 0) == .red)
        #expect(AvailabilityVerdict.band(forMultiple: 8) == .green)
    }

    @Test func displayScoreMapsTheThreeSegments() {
        // M 0→1 spans 0–33, 1→2 spans 33–66, 2→3+ spans 66–100 capped.
        #expect(AvailabilityHealthEngine.displayScore(forMultiple: 0) == 0)
        #expect(abs(AvailabilityHealthEngine.displayScore(forMultiple: 0.5) - 16.5) < 0.001)
        #expect(AvailabilityHealthEngine.displayScore(forMultiple: 1.0) == 33)
        #expect(abs(AvailabilityHealthEngine.displayScore(forMultiple: 1.5) - 49.5) < 0.001)
        #expect(AvailabilityHealthEngine.displayScore(forMultiple: 2.0) == 66)
        #expect(AvailabilityHealthEngine.displayScore(forMultiple: 3.0) == 100)
        #expect(AvailabilityHealthEngine.displayScore(forMultiple: 8.0) == 100)
    }

    @Test func droughtAtMeasuredPaceYieldsMultipleBelowOne() {
        // 20 pts, reset a week out, 30 pts/day: the measured pace itself
        // runs dry, so M is far below 1 — RED.
        let accounts = [pool(remaining: 20, resetIn: 167.5)]
        let multiple = AvailabilityHealthEngine.sustainableMultiple(accounts, pacePerDay: 30)
        #expect(multiple < 1)
        #expect(AvailabilityVerdict.band(forMultiple: multiple) == .red)
    }

    @Test func moderateRunwayLandsInYellowWithAKnownMultiple() {
        // 50 pts, reset only at the horizon, 5 pts/day: drought needs
        // 45 pts of drain in 7 days → M = 45/35 ≈ 1.29 — YELLOW.
        let accounts = [pool(remaining: 50, resetIn: 167.5)]
        let multiple = AvailabilityHealthEngine.sustainableMultiple(accounts, pacePerDay: 5)
        #expect(abs(multiple - 45.0 / 35.0) < 0.01)
        #expect(AvailabilityVerdict.band(forMultiple: multiple) == .yellow)
    }

    @Test func ampleRunwayCapsAtTheMaxMultiple() {
        // Full pool, weekly reset mid-horizon, 2 pts/day: even 8x survives.
        let accounts = [pool(remaining: 100, resetIn: 84)]
        let multiple = AvailabilityHealthEngine.sustainableMultiple(accounts, pacePerDay: 2)
        #expect(multiple == AvailabilityHealthEngine.maxMultiple)
        #expect(AvailabilityVerdict.band(forMultiple: multiple) == .green)
    }

    @Test func zeroPaceWithAHealthyPoolIsFullRunway() {
        let accounts = [pool(remaining: 60, resetIn: 84)]
        #expect(AvailabilityHealthEngine.sustainableMultiple(accounts, pacePerDay: 0)
            == AvailabilityHealthEngine.maxMultiple)
    }

    @Test func poolAlreadyAtTheFloorIsZeroEvenWithZeroPace() {
        let accounts = [pool(remaining: 4, resetIn: 167.5)]
        #expect(AvailabilityHealthEngine.sustainableMultiple(accounts, pacePerDay: 0) == 0)
    }

    @Test func burstHeadroomIsPositiveWithRunwayAndZeroInDrought() {
        let green = [pool(remaining: 100, resetIn: 84)]
        let headroom = AvailabilityHealthEngine.burstHeadroom(green, pacePerDay: 2)
        #expect(headroom > 50)
        #expect(headroom <= 100)
        let red = [pool(remaining: 20, resetIn: 167.5)]
        #expect(AvailabilityHealthEngine.burstHeadroom(red, pacePerDay: 30) < 0.001)
    }

    @Test func burstHeadroomIsForgivenByAResetInsideTheWindow() {
        // Review regression (PR #236, finding 2): a one-time spend today
        // must be restored by a reset inside the window. Single account,
        // full pool, reset in 12 h, 12 pts/day: the binding constraint is
        // the pre-reset hours only (100 − X − 5.5 pts of drain > 5-pt
        // floor → X ≈ 89.5); the snap then restores everything and the
        // post-reset week never gets near the floor. The old detached-pool
        // deduction never forgave the spend, so the whole week bound the
        // spend and headroom capped near 17.
        let accounts = [pool(remaining: 100, resetIn: 12)]
        let headroom = AvailabilityHealthEngine.burstHeadroom(accounts, pacePerDay: 12)
        #expect(abs(headroom - 89.5) < 1)
    }

    @Test func nextReliefSkipsAnImmaterialSoonerReset() {
        // A near-full 1x account resetting in 5 h restores only 90 pts —
        // not relief on a pool this size. The 20x restoring 1,000 pts is
        // the row's answer even though it lands much later.
        let accounts = [
            pool(remaining: 1000, capacity: 2000, resetIn: 100),
            AvailabilityPoolAccount(
                label: "Side", remainingPoints: 10, capacityPoints: 100, hoursToReset: 5
            ),
        ]
        let reset = AvailabilityHealthEngine.nextBigReset(accounts, now: fixedNow)
        #expect(reset?.accountLabel == "Studio")
        #expect(reset?.restoredPoints == 1000)
        #expect(reset?.date == fixedNow.addingTimeInterval(100 * 3600))
    }

    @Test func nextReliefIsTheSoonestMateriallyRelievingReset() {
        // Issue #310, Tim's field deck (placeholder labels): seven Max 20x
        // accounts. "Drained B" restores 20 pts MORE than "Drained A" but
        // lands a full day later; magnitude-first selection told Tim to
        // wait until Sunday while a comparably sized relief landed in
        // 18.5 h. Next relief must name the SOONEST material reset.
        func account(_ label: String, remainingPercent: Double, resetIn hours: Double)
            -> AvailabilityPoolAccount {
            AvailabilityPoolAccount(
                label: label,
                remainingPoints: remainingPercent * 20,
                capacityPoints: 2000,
                hoursToReset: hours
            )
        }
        let accounts = [
            account("Drained A", remainingPercent: 2, resetIn: 18.45),  // +1,960 pts
            account("Drained B", remainingPercent: 1, resetIn: 42.5),   // +1,980 pts, Sunday
            account("Drained C", remainingPercent: 5, resetIn: 86.5),
            account("Drained D", remainingPercent: 3, resetIn: 108.5),
            account("Drained E", remainingPercent: 4, resetIn: 125.5),
            account("Working", remainingPercent: 19, resetIn: 148.5),
            account("Fresh", remainingPercent: 96, resetIn: 156.5),
        ]
        let reset = AvailabilityHealthEngine.nextBigReset(accounts, now: fixedNow)
        #expect(reset?.accountLabel == "Drained A")
        #expect(reset?.restoredPoints == 1960)
        #expect(reset?.date == fixedNow.addingTimeInterval(18.45 * 3600))
    }
}

@Suite("Availability Health report and presentation (issue #235)")
struct AvailabilityReportTests {
    @Test func reportEvaluatesOneProviderEndToEnd() {
        let state = DeckState(
            accounts: [
                claudeAccount(id: "c1", label: "Studio", rateLimitTier: "default_claude_max_20x"),
                claudeAccount(id: "c2", label: "Stale", subscriptionType: "pro"),
                claudeAccount(id: "c3", label: "Mystery"),
                codexAccount(id: "x1", label: "Ship", planType: "pro"),
            ],
            usage: [
                snapshot(accountId: "c1", scope: "Fable weekly", remaining: 80),
                snapshot(accountId: "c2", scope: "weekly", remaining: 50, observedMinutesAgo: 60),
                snapshot(accountId: "c3", scope: "weekly", remaining: 100),
                snapshot(accountId: "x1", scope: "weekly", remaining: 90),
            ]
        )
        let report = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        // Codex never leaks into the Claude pool; the stale Pro is excluded.
        #expect(report.pool.map(\.label) == ["Studio", "Mystery"])
        #expect(report.poolPoints == 1600 + 100)
        #expect(report.capacityPoints == 2000 + 100)
        #expect(report.excluded == [AvailabilityExclusion(label: "Stale", reason: "usage data is stale")])
        #expect(report.unknownTierLabels == ["Mystery"])
        #expect(report.verdict != nil)
        #expect(report.sustainableMultiple != nil)
        #expect(report.displayScore != nil)
        #expect(report.burstHeadroomPoints != nil)
        #expect(report.nextBigReset?.accountLabel == "Studio")
    }

    @Test func emptyPoolReportsNoVerdictWithTheReasons() {
        let state = DeckState(
            accounts: [claudeAccount(id: "c1", label: "SignedOut", authState: "signin-required")],
            usage: []
        )
        let report = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        #expect(report.verdict == nil)
        #expect(report.sustainableMultiple == nil)
        #expect(report.excluded == [AvailabilityExclusion(label: "SignedOut", reason: "sign in needed")])
        let presentation = AvailabilityHealthPresentation.make(report: report, now: fixedNow)
        #expect(presentation.chipWord == "No data")
        #expect(presentation.score == nil)
        #expect(presentation.readout == "No usable Claude accounts to score.")
        #expect(presentation.excludedLine == "Not counted: SignedOut (sign in needed)")
    }

    @Test func readoutPhrasingIsPinned() {
        // Tim's example verbatim, plus the qualifier grammar at each edge.
        #expect(AvailabilityHealthPresentation.readout(multiple: 1.8, pacePerDay: 10)
            == "You could sustain about 1.8× your current pace — yellow, close to green.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 1.5, pacePerDay: 10)
            == "You could sustain about 1.5× your current pace — yellow.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 1.1, pacePerDay: 10)
            == "You could sustain about 1.1× your current pace — yellow, close to red.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 0.9, pacePerDay: 10)
            == "You could sustain about 0.9× your current pace — red, close to yellow.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 0.3, pacePerDay: 10)
            == "You could sustain about 0.3× your current pace — red.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 2.1, pacePerDay: 10)
            == "You could sustain about 2.1× your current pace — green, close to yellow.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 2.6, pacePerDay: 10)
            == "You could sustain about 2.6× your current pace — green.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 8, pacePerDay: 10)
            == "You could sustain over 8× your current pace — green.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 8, pacePerDay: 0)
            == "No measured usage yet this cycle — full runway.")
        #expect(AvailabilityHealthPresentation.readout(multiple: 0, pacePerDay: 0)
            == "No measured usage yet this cycle, but the pool is nearly empty.")
    }

    @Test func presentationCarriesTheFactsAndFlags() {
        let state = DeckState(
            accounts: [
                claudeAccount(id: "c1", label: "Studio", rateLimitTier: "max_5x"),
                claudeAccount(id: "c2", label: "Mystery"),
            ],
            usage: [
                snapshot(accountId: "c1", scope: "Fable weekly", remaining: 40),
                snapshot(accountId: "c2", scope: "weekly", remaining: 100),
            ]
        )
        let report = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        let presentation = AvailabilityHealthPresentation.make(report: report, now: fixedNow)
        #expect(presentation.title == "Claude availability")
        #expect(presentation.verdict == report.verdict)
        #expect(presentation.chipWord == report.verdict?.displayWord)
        // Issue #281: the same facts, now grouped label/value rows. Every
        // number is byte-identical to the flat wall this replaced; only the
        // labels and the grouping are new.
        let now = presentation.section(AvailabilityHealthPresentation.SectionTitle.now)
        let pace = presentation.section(AvailabilityHealthPresentation.SectionTitle.pace)
        let week = presentation.section(AvailabilityHealthPresentation.SectionTitle.weekAhead)
        // Locale-safe pin (CodeRabbit, PR #294): the presentation's point
        // formatter is locale-aware (grouping AND digit glyphs), so the
        // expectation is built with the same configuration rather than
        // hardcoding ASCII digits.
        let pts: (Int) -> String = { value in
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            formatter.usesGroupingSeparator = true
            formatter.maximumFractionDigits = 0
            return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
        }
        #expect(now?.row("Pool")?.value == "\(pts(300)) of \(pts(600)) pts")
        #expect(pace?.row("Weekly pace")?.value.hasSuffix(" pts/day") == true)
        #expect(week?.row("Lowest point")?.value.hasSuffix(" pts") == true)
        #expect(week?.row("Burst room")?.value.hasPrefix("~") == true)
        #expect(week?.row("Burst room")?.value.hasSuffix(" pts today") == true)
        // Studio (5x, 60% used) restores 300 pts — the big reset. The
        // account NAME travels separately: it is the only part the popover
        // may ellipsize, and the numbers beside it never are.
        let relief = week?.row("Next relief")
        #expect(relief?.name == "Studio")
        #expect(relief?.value.hasPrefix("+\(pts(300)) pts · ") == true)
        #expect(relief?.spokenValue.hasPrefix("Studio +\(pts(300)) pts") == true)
        #expect(presentation.unknownTierLine == "Tier unknown, counted as 1×: Mystery")
        #expect(presentation.excludedLine == nil)
        #expect(presentation.chipTooltip.hasSuffix("Click for details."))
        #expect(presentation.accessibilitySummary.hasPrefix("Claude availability"))
    }

    @Test func redReportCarriesTheDroughtTime() {
        // Nearly-drained 5x pool, heavy elapsed use → measured pace runs it
        // dry within the horizon.
        let state = DeckState(
            accounts: [claudeAccount(id: "c1", label: "Studio", rateLimitTier: "max_5x")],
            usage: [snapshot(accountId: "c1", scope: "Fable weekly", remaining: 6, resetsInHours: 160)]
        )
        let report = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        #expect(report.verdict == .red)
        #expect(report.firstDroughtHours != nil)
        let presentation = AvailabilityHealthPresentation.make(report: report, now: fixedNow)
        #expect(presentation.row("Pool dry")?.value.hasPrefix("in ") == true)
        #expect(presentation.row("Pool dry")?.value.hasSuffix(" at the current pace") == true)
    }

    @Test func droughtHoursTextFormats() {
        #expect(AvailabilityHealthPresentation.hoursText(5) == "5 hr")
        #expect(AvailabilityHealthPresentation.hoursText(50) == "2.1 days")
    }

    @Test func meaningParagraphIsTheNonJargonDecisionCopy() {
        let paragraph = AvailabilityHealthPresentation.meaningParagraph
        #expect(paragraph.contains("Green: safe to launch heavy multi-agent work."))
        #expect(paragraph.contains("Yellow: normal work is fine — hold the heavy runs until the next reset."))
        #expect(paragraph.contains("Red: slow down and focus on one project."))
        #expect(paragraph.contains("The bar shows how close you are to the neighboring band."))
    }
}
