import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #244 — the burst-aware pace scenario. The engine's measured pace
// is a 7-day trailing average; Tim's live ultracode run burned ~7× that
// while the verdict sat far-right GREEN. These tests pin the field
// scenario from that evening (tier-weighted numbers from the issue), the
// degrade rules in the pessimistic direction only, and the popover copy
// carrying the two numbers Tim needed live. Placeholder labels only.

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(hoursFromNow hours: Double) -> String {
    ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(hours * 3600))
}

private func claudeState(
    _ specs: [(id: String, tier: String, remaining: Double, resetsInHours: Double)],
    observedMinutesAgo: Double = 1
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
        usage: specs.map { spec in
            UsageSnapshot(
                accountId: spec.id, scope: "Fable weekly",
                remainingPercent: spec.remaining,
                resetsAt: iso(hoursFromNow: spec.resetsInHours),
                observedAt: iso(hoursFromNow: -observedMinutesAgo / 60)
            )
        }
    )
}

/// The field calibration deck (issue #244, Tim live, 2026-08-04 evening):
/// five Max 20x accounts, pool 1240 of 10 000 tier-weighted points,
/// trailing average ~408 pts/day, and the +1920-point reset 7 hours out.
/// remaining%: 80 pts = 4%, 290 pts = 14.5% per 2000-point account.
private var fieldState: DeckState {
    claudeState([
        ("c1", "max_20x", 4.0, 7),    // 80 pts, the 7 h rescue (+1920)
        ("c2", "max_20x", 14.5, 31),
        ("c3", "max_20x", 14.5, 55),
        ("c4", "max_20x", 14.5, 103),
        ("c5", "max_20x", 14.5, 127),
    ])
}

/// The burst rate ModelDeck measured during the run.
private let fieldBurst = 2800.0

@Suite("Issue #244 field calibration regression")
struct Issue244FieldCalibrationTests {
    @Test func fixtureMatchesTheFieldNumbers() {
        let report = AvailabilityHealthEngine.report(for: .claude, state: fieldState, now: fixedNow)
        #expect(report.poolPoints == 1240)
        #expect(report.capacityPoints == 10000)
        // Trailing average ≈ 408 pts/day (8760 used over ~21.5 elapsed
        // account-days).
        #expect(abs(report.pacePointsPerDay - 407) < 12)
    }

    @Test func withoutTheBurnWindowTonightWasGreen() {
        // Pre-#244 behavior, pinned: the trailing average scores this deck
        // GREEN — the exact optimistic verdict Tim outran live. This is
        // the honest cold-start behavior too (window inactive → nil).
        let report = AvailabilityHealthEngine.report(for: .claude, state: fieldState, now: fixedNow)
        #expect(report.verdict == .green)
        #expect(report.burstPointsPerDay == nil)
        #expect(report.burstFirstDroughtHours == nil)
        #expect(report.burstDegraded == false)
    }

    @Test func withTheBurstRateTonightIsYellow() {
        // THE regression this issue exists for: same deck, burst 2800
        // pts/day. The pool clears the 7-hour rescue (+1920) but droughts
        // ~a day later if the burn sustains — the verdict must degrade to
        // YELLOW where today's engine said GREEN.
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: fieldBurst
        )
        #expect(report.verdict == .yellow)
        #expect(report.burstDegraded)
        // The burst sim must clear the 7 h reset (drought AFTER hour 7)…
        #expect((report.burstFirstDroughtHours ?? 0) > 7)
        // …and drought before the h31 reset (≈ Wednesday at this pace).
        #expect((report.burstFirstDroughtHours ?? 999) < 31)
        // Steady-state semantics untouched: M and the measured pace are
        // the trailing-average story, not redefined by the burst.
        #expect((report.sustainableMultiple ?? 0) >= 2)
        #expect(report.firstDroughtHours == nil)
    }

    @Test func degradedScoreSitsInTheYellowSegment() {
        // Verdict/score/bar coherence: a yellow chip must never point the
        // needle into the green segment (66+).
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: fieldBurst
        )
        #expect((report.displayScore ?? 0) >= 33)
        #expect((report.displayScore ?? 100) < 66)
        // But the untouched steady-state multiple would have scored green
        // — proving the clamp did the work, not a changed M.
        #expect(AvailabilityHealthEngine.displayScore(
            forMultiple: report.sustainableMultiple ?? 0
        ) >= 66)
    }

    @Test func tonightsTwoNumbersAreOnTheReport() {
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: fieldBurst
        )
        // Straight-line bottoms-out at 2800/day from 1240 pts (floor 100):
        // (1240 − 100) / (2800/24) ≈ 9.8 h.
        #expect(abs((report.burstBottomsOutHours ?? 0) - 9.77) < 0.3)
        // The soonest reset — the 7 h rescue — not the biggest one.
        #expect(abs((report.soonestResetHours ?? 0) - 7) < 0.05)
    }
}

@Suite("Issue #244 degrade rules (optimistic-direction guards)")
struct Issue244DegradeRuleTests {
    @Test func burstAtOrBelowTwiceTheAverageIsANoOp() {
        // GREEN already proves the pool survives 2× the trailing average
        // (M ≥ 2), so a burst at or under that line cannot drought the
        // sim: the verdict, score, and burst fact fields must all be
        // untouched — nothing changes but the echoed rate.
        let base = AvailabilityHealthEngine.report(for: .claude, state: fieldState, now: fixedNow)
        for burst in [500.0, 2 * base.pacePointsPerDay] {
            let report = AvailabilityHealthEngine.report(
                for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: burst
            )
            #expect(report.verdict == .green)
            #expect(report.burstDegraded == false)
            #expect(report.burstFirstDroughtHours == nil)
            #expect(report.burstBottomsOutHours == nil)
            #expect(report.displayScore == base.displayScore)
            #expect(report.sustainableMultiple == base.sustainableMultiple)
            #expect(report.burstPointsPerDay == burst)
        }
    }

    @Test func survivableBurstNeverDegrades() {
        // 20x account at 90%, gentle trailing pace, burst 400/day: over 2×
        // the average but the pool rides it out — GREEN stands, and the
        // burn line still shows (awareness without alarm).
        let state = claudeState([("c1", "max_20x", 90, 84)])
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow, burstPointsPerDay: 400
        )
        #expect(report.verdict == .green)
        #expect(report.burstDegraded == false)
        #expect(report.burstFirstDroughtHours == nil)
        #expect(report.burstPointsPerDay == 400)
    }

    @Test func yellowStaysYellowNeverRed() {
        // Pro at 55%, reset 84 h out: pace ≈ 12.9/day, M ≈ 1.11 — YELLOW.
        // A burst that droughts in ~6 h keeps it YELLOW (degrade is "at
        // most to yellow", never a new red), but the burst facts surface.
        let state = claudeState([("c1", "pro", 55, 84)])
        let steady = AvailabilityHealthEngine.report(for: .claude, state: state, now: fixedNow)
        #expect(steady.verdict == .yellow)
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow, burstPointsPerDay: 200
        )
        #expect(report.verdict == .yellow)
        #expect(report.burstDegraded == false) // it was never green
        #expect(report.burstFirstDroughtHours != nil)
        #expect(report.displayScore == steady.displayScore)
    }

    @Test func redStaysRedButStillShowsTheBurstFacts() {
        // The measured pace itself droughts (RED): the burst scenario can
        // never make the verdict worse (no new red, no degrade flag) and
        // absolutely never better — but the bench-out vs next-reset
        // numbers still surface (orchestrator decision: the issue's
        // closing requirement shows them regardless of verdict).
        let state = claudeState([("c1", "pro", 6, 160)])
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow, burstPointsPerDay: 10_000
        )
        #expect(report.verdict == .red)
        #expect(report.burstDegraded == false)
        #expect(report.firstDroughtHours != nil)
        // Display-only fields populate; the verdict path is untouched.
        #expect(report.burstFirstDroughtHours != nil)
        #expect(report.burstBottomsOutHours != nil)
    }

    @Test func burstFactsShowOnYellowBetweenOneAndTwoTimesPace() {
        // A burst UNDER the 2× degrade gate but over the measured pace
        // still surfaces the numbers when it droughts (display gate is
        // burst > pace; verdict gate stays burst > 2×). Pro at 55%,
        // pace ≈ 12.9/day, burst 20/day: droughts before the h84 reset
        // ((55−5)/(20/24) = 60 h), yet 20 < 2 × 12.9.
        let state = claudeState([("c1", "pro", 55, 84)])
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow, burstPointsPerDay: 20
        )
        #expect(report.verdict == .yellow)
        #expect(report.burstDegraded == false)
        #expect(report.burstFirstDroughtHours == 60)
        #expect(report.burstBottomsOutHours != nil)
    }

    @Test func nilBurstIsExactlyThePre244Report() {
        let old = AvailabilityHealthEngine.report(for: .claude, state: fieldState, now: fixedNow)
        let explicit = AvailabilityHealthEngine.report(
            for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: nil
        )
        #expect(old == explicit)
    }

    @Test func emptyPoolIgnoresTheBurstRate() {
        let state = DeckState(accounts: [], usage: [])
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow, burstPointsPerDay: fieldBurst
        )
        #expect(report.verdict == nil)
        #expect(report.burstPointsPerDay == nil)
    }
}

@Suite("Issue #244 popover copy")
struct Issue244PresentationTests {
    private var degradedPresentation: AvailabilityHealthPresentation {
        AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: fieldBurst
            ),
            now: fixedNow
        )
    }

    @Test func currentBurnLineIsPinned() {
        // Tim's first live number: today's rate, and how far ahead of the
        // weekly pace it runs. 2800 / ~406.7 → 6.9×. Issue #281 moved it
        // into the PACE group as a label/value row — same numbers, and the
        // weekly pace it compares against now sits one row above it.
        let pace = degradedPresentation.section(
            AvailabilityHealthPresentation.SectionTitle.pace
        )
        // #281 also grouped thousands for readability. The separator is
        // LOCALE-AWARE, so build the expectation with the same formatter
        // configuration rather than hardcoding a US comma — CodeRabbit (PR
        // #285) caught that the first version of this pin would fail on a
        // non-US install.
        let grouping: (Int) -> String = { value in
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            formatter.usesGroupingSeparator = true
            formatter.maximumFractionDigits = 0
            return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
        }
        #expect(pace?.row("Today's burn")?.value == "~\(grouping(2800)) pts/day · 6.9× pace")
        #expect(pace?.row("Weekly pace")?.value.hasSuffix(" pts/day") == true)
    }

    @Test func bottomsOutVersusResetLineIsPinned() {
        // Tim's second live number: straight-line runway vs the rescue.
        #expect(degradedPresentation.row("Runway")?.value
            == "bottoms out ~10 hr · reset in 7 hr")
    }

    @Test func degradedReadoutOwnsTheYellowAndNamesTheBurst() {
        let presentation = degradedPresentation
        #expect(presentation.chipWord == "Yellow")
        #expect(presentation.verdict == .yellow)
        #expect(presentation.readout.hasPrefix("Your weekly average could sustain"))
        #expect(presentation.readout.contains("today's burn (6.9× that pace)"))
        #expect(presentation.readout.contains("would run the pool dry in"))
        #expect(presentation.readout.hasSuffix("Yellow while this burst lasts."))
        // The steady-state sentence would have said "— green": it must be
        // nowhere near a yellow chip.
        #expect(!presentation.readout.contains("green"))
        #expect(presentation.accessibilitySummary.contains("Yellow"))
    }

    @Test func burstReadoutGrammarIsPinned() {
        #expect(AvailabilityHealthPresentation.burstReadout(
            multiple: 4.2, burstPointsPerDay: 2800, pacePerDay: 400, droughtHours: 26
        ) == "Your weekly average could sustain about 4.2× — but today's burn "
            + "(7.0× that pace) would run the pool dry in 1.1 days. "
            + "Yellow while this burst lasts.")
        #expect(AvailabilityHealthPresentation.burstReadout(
            multiple: 8, burstPointsPerDay: 900, pacePerDay: 100, droughtHours: 5
        ) == "Your weekly average could sustain over 8× — but today's burn "
            + "(9.0× that pace) would run the pool dry in 5 hr. "
            + "Yellow while this burst lasts.")
        // Fresh cycle: no trailing average yet, burn window still live.
        #expect(AvailabilityHealthPresentation.burstReadout(
            multiple: 8, burstPointsPerDay: 900, pacePerDay: 0, droughtHours: 5
        ) == "No weekly usage measured yet, but today's burn would run "
            + "the pool dry in 5 hr. Yellow while this burst lasts.")
    }

    @Test func multiplierFormatting() {
        #expect(AvailabilityHealthPresentation.multiplierText(6.88) == "6.9")
        #expect(AvailabilityHealthPresentation.multiplierText(1.0) == "1.0")
        #expect(AvailabilityHealthPresentation.multiplierText(9.94) == "9.9")
        #expect(AvailabilityHealthPresentation.multiplierText(9.96) == "10")
        #expect(AvailabilityHealthPresentation.multiplierText(27.9) == "28")
    }

    @Test func quietDeckCarriesNoBurstLines() {
        // Window inactive (nil burst): the popover reads exactly as before
        // #244 — no "Current burn", no bottoms-out line.
        let presentation = AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(for: .claude, state: fieldState, now: fixedNow),
            now: fixedNow
        )
        // #260's cold-window line still owns the burn slot, and there is
        // no runway row to state a rate the window never measured.
        #expect(presentation.row("Today's burn")?.value == "still measuring")
        #expect(presentation.row("Runway") == nil)
    }

    @Test func yellowDeckReadoutCarriesTheBurstClause() {
        // Review finding 4 (partial): when a base-YELLOW deck has a burst
        // drought, the sentence must agree with the fact lines below it.
        let state = claudeState([("c1", "pro", 55, 84)])
        let presentation = AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: .claude, state: state, now: fixedNow, burstPointsPerDay: 200
            ),
            now: fixedNow
        )
        #expect(presentation.verdict == .yellow)
        #expect(presentation.readout.contains("your current pace — yellow"))
        #expect(presentation.readout.hasSuffix(
            "Today's burn runs ahead of that pace and would dry the pool in 6 hr."
        ))
        #expect(presentation.row("Runway") != nil)
    }

    @Test func redDeckShowsTheBurstFactLines() {
        // Orchestrator decision: bench-out vs next-reset shows regardless
        // of verdict — including RED, where it sits beside the existing
        // "Pool dry in…" fact.
        let state = claudeState([("c1", "pro", 6, 160)])
        let presentation = AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: .claude, state: state, now: fixedNow, burstPointsPerDay: 10_000
            ),
            now: fixedNow
        )
        #expect(presentation.verdict == .red)
        #expect(presentation.row("Pool dry")?.value.hasPrefix("in ") == true)
        #expect(presentation.row("Runway") != nil)
        // #281: both live in their own groups, never one merged line.
        #expect(presentation.section(
            AvailabilityHealthPresentation.SectionTitle.weekAhead
        )?.row("Pool dry") != nil)
    }

    @Test func zeroRateBurnLineIsSuppressed() {
        // Review finding 7: an idle-but-active window (rate rounds to 0)
        // must not render "Current burn: ~0 pts/day (0.0× your weekly
        // pace)".
        let presentation = AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: 0.3
            ),
            now: fixedNow
        )
        #expect(presentation.row("Today's burn") == nil)
        // At 1 pt/day the line is honest again.
        let onePoint = AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: 1
            ),
            now: fixedNow
        )
        #expect(onePoint.row("Today's burn")?.value.hasPrefix("~1 pts/day") == true)
    }

    @Test func activeButHarmlessBurnShowsTheRateOnly() {
        let presentation = AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: .claude, state: fieldState, now: fixedNow, burstPointsPerDay: 500
            ),
            now: fixedNow
        )
        #expect(presentation.row("Today's burn")?.value.hasPrefix("~500 pts/day") == true)
        #expect(presentation.row("Runway") == nil)
        // Steady-state readout untouched.
        #expect(presentation.readout.contains("your current pace"))
    }
}

@Suite("Issue #244 menu bar follows the degraded verdict")
@MainActor
struct Issue244MenuBarTests {
    @Test func healthDotDegradesWithTheBurstScenario() {
        let m = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { fixedNow }
        )
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.apply(deckState: fieldState)
        // Cold window: the dot shows the trailing-average GREEN.
        #expect(m.iconState == .health(provider: .claude, verdict: .green))
        // 31 minutes ago the burning account (c2) had 3% more of its 20x
        // week: 60 points in half an hour ≈ 2880 pts/day — the live run.
        let earlier = claudeState([
            ("c1", "max_20x", 4.0, 7),
            ("c2", "max_20x", 17.5, 31),
            ("c3", "max_20x", 14.5, 55),
            ("c4", "max_20x", 14.5, 103),
            ("c5", "max_20x", 14.5, 127),
        ], observedMinutesAgo: 31)
        m.recordBurnSample(state: earlier)
        // One sample: still inactive, still green (honest cold start).
        #expect(m.iconState == .health(provider: .claude, verdict: .green))
        m.recordBurnSample(state: fieldState)
        // Window active, burst droughts where the average doesn't: the
        // dot follows the degraded verdict with no extra wiring.
        #expect(m.iconState == .health(provider: .claude, verdict: .yellow))
    }
}
