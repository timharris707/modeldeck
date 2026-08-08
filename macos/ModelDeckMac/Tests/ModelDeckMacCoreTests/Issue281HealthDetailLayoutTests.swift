import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #281 — the health detail popover's fact wall becomes grouped
// label/value rows. This is LAYOUT ONLY: every fact the flat list carried
// still renders, with the same numbers and units, and no fact was added.
// The existing string-pinning tests moved to the structured lookups
// (AvailabilityHealthEngineTests, Issue244/257/260); this suite pins the
// STRUCTURE and Tim's width rules.
//
// Placeholder labels only — never real account data.

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(hoursFromNow hours: Double) -> String {
    ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(hours * 3600))
}

private func claudeState(
    _ rows: [(id: String, label: String, tier: String, remaining: Double, resetHours: Double)]
) -> DeckState {
    DeckState(
        accounts: rows.map {
            DeckAccount(
                id: $0.id, provider: "claude", label: $0.label,
                enabled: true, isDefault: false,
                metadata: DeckAccountMetadata(
                    claudePlan: ProviderPlanInfo(rateLimitTier: $0.tier)
                ),
                authState: "ok"
            )
        },
        usage: rows.map {
            UsageSnapshot(
                accountId: $0.id, scope: "Fable weekly", remainingPercent: $0.remaining,
                resetsAt: iso(hoursFromNow: $0.resetHours),
                observedAt: iso(hoursFromNow: -0.01)
            )
        }
    )
}

/// A deck with something to say in every group: a partly-spent pool, a
/// measured pace, a live burn, and a big reset coming.
private var busyPresentation: AvailabilityHealthPresentation {
    let state = claudeState([
        // The long label sits on the account that holds the biggest reset,
        // so the relief row — the widest row the layout can produce — is
        // exercised at its worst case.
        (id: "c1", label: "Client Overflow Account", tier: "max_20x", remaining: 30, resetHours: 20),
        (id: "c2", label: "Studio", tier: "max_5x", remaining: 8, resetHours: 140),
        // Below the 5% usable floor: points counted in the pool that cannot
        // host a session, which is what makes the Usable row render (#257).
        (id: "c3", label: "Spent", tier: "max_5x", remaining: 2, resetHours: 90),
    ])
    return AvailabilityHealthPresentation.make(
        report: AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow, burstPointsPerDay: 2_600
        ),
        now: fixedNow
    )
}

@Suite("Health detail groups its facts (issue #281)")
struct HealthDetailStructureTests {
    @Test func theThreeGroupsAppearInReadingOrder() {
        // NOW (what is true), PACE (how fast it moves), WEEK AHEAD (what the
        // 7-day sim says) — the order Tim's target layout specifies.
        let titles = busyPresentation.sections.map(\.title)
        #expect(titles == ["Now", "Pace", "Week ahead"])
        #expect(titles == [
            AvailabilityHealthPresentation.SectionTitle.now,
            AvailabilityHealthPresentation.SectionTitle.pace,
            AvailabilityHealthPresentation.SectionTitle.weekAhead,
        ])
    }

    @Test func aGroupWithNothingToSayIsDroppedNotLeftEmpty() {
        // A headed group with no rows under it is exactly the noise this
        // redesign removes.
        for section in busyPresentation.sections {
            #expect(!section.rows.isEmpty)
        }
        // A pool with nothing to score carries no groups at all.
        let empty = AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: .claude, state: DeckState(accounts: [], usage: []), now: fixedNow
            ),
            now: fixedNow
        )
        #expect(empty.sections.isEmpty)
        #expect(empty.guidance == nil)
        #expect(empty.chipWord == AvailabilityHealthPresentation.noDataWord)
    }

    @Test func everyFactIsOnItsOwnRow() {
        // Tim's width addendum rejected the compressed one-line-per-group
        // form: a row carries ONE fact, so the pool and what's usable of it
        // never share a line, and the weekly pace never rides inside the
        // burn row the way the first sketch had it.
        let p = busyPresentation
        #expect(p.section("Now")?.row("Pool") != nil)
        #expect(p.section("Now")?.row("Usable") != nil)
        #expect(p.section("Pace")?.row("Weekly pace") != nil)
        #expect(p.section("Pace")?.row("Today's burn") != nil)
        // Each row's value carries one number-bearing clause, never two
        // separated by a sentence break.
        for section in p.sections {
            for row in section.rows {
                #expect(!row.value.contains(";"), "\(row.label) merges two facts")
            }
        }
    }

    @Test func labelsStayInsideTheLabelColumn() {
        // The label column is a fixed 68 pt at 11 pt system font. Pinning a
        // character budget is the testable half of "design to the REAL
        // narrow width" — a label that grows past this silently eats the
        // value column's numbers.
        for section in busyPresentation.sections {
            for row in section.rows {
                #expect(row.label.count <= 12, "label '\(row.label)' overruns the label column")
            }
        }
    }

    @Test func onlyTheAccountNameIsEverTruncatable() {
        // The relief row is the longest (name + points + time). Its NAME
        // travels in its own field so the view can ellipsize that and only
        // that — the numbers are never allowed to lose a digit.
        let relief = busyPresentation.section("Week ahead")?.row("Next relief")
        #expect(relief?.name == "Client Overflow Account")
        #expect(relief?.value.hasPrefix("+") == true)
        #expect(relief?.value.contains("pts ·") == true)
        // Every other row is numbers only — nothing to truncate.
        for section in busyPresentation.sections {
            for row in section.rows where row.label != "Next relief" {
                #expect(row.name == nil, "\(row.label) must not carry a truncatable name")
            }
        }
    }

    @Test func theReliefTimeDropsTheDecksResetsLead() {
        // Seven characters of "Resets " are what let the account name and
        // the numbers share one line at 300 pt. The phrasing still comes
        // from the one reset-time formatter the cards use.
        #expect(AvailabilityHealthPresentation.reliefWhen(
            for: fixedNow.addingTimeInterval(3 * 3600 + 20 * 60), now: fixedNow
        ) == "in 3 hr 20 min")
        #expect(AvailabilityHealthPresentation.reliefWhen(
            for: fixedNow.addingTimeInterval(30 * 60), now: fixedNow
        ) == "in 30 min")
        #expect(AvailabilityHealthPresentation.reliefWhen(for: fixedNow, now: fixedNow) == "now")
        #expect(AvailabilityHealthPresentation.reliefWhen(for: nil, now: fixedNow)
            == "no reset data")
    }

    @Test func valuesCarryTheirUnits() {
        // Consistent unit style across the wall: pts, pts/day, hr.
        let p = busyPresentation
        #expect(p.row("Pool")?.value.hasSuffix(" pts") == true)
        #expect(p.row("Weekly pace")?.value.hasSuffix(" pts/day") == true)
        #expect(p.row("Today's burn")?.value.contains(" pts/day") == true)
    }
}

@Suite("Health detail leads with one sentence of guidance (issue #281)")
struct HealthDetailGuidanceTests {
    @Test func guidanceIsTheCurrentBandOnly() {
        #expect(AvailabilityHealthPresentation.guidance(for: .green)
            == "Safe to launch heavy multi-agent work.")
        #expect(AvailabilityHealthPresentation.guidance(for: .yellow)
            == "Normal work is fine — hold the heavy runs until the next reset.")
        #expect(AvailabilityHealthPresentation.guidance(for: .red)
            == "Slow down and focus on one project.")
        #expect(AvailabilityHealthPresentation.guidance(for: nil) == nil)
        // A yellow deck hears about yellow — and about neither of the other
        // two bands, which is the whole point of the change.
        let p = busyPresentation
        #expect(p.guidance == AvailabilityHealthPresentation.guidance(for: p.verdict))
        #expect(p.guidance?.contains("Green:") == false)
        #expect(p.guidance?.contains("Red:") == false)
    }

    @Test func theThreeBandLegendIsRelocatedNeverDeleted() {
        // It now lives on the verdict bar's hover. Same bytes, and each
        // band's guidance sentence is that band's own clause, so the hover
        // and the body can never disagree.
        let legend = AvailabilityHealthPresentation.meaningParagraph
        for verdict in [AvailabilityVerdict.green, .yellow, .red] {
            guard let guidance = AvailabilityHealthPresentation.guidance(for: verdict) else {
                Issue.record("every band has guidance"); continue
            }
            let clause = guidance.prefix(1).lowercased() + guidance.dropFirst()
            #expect(legend.contains(clause), "legend lost the \(verdict.rawValue) clause")
        }
        #expect(legend.contains("The bar shows how close you are to the neighboring band."))
    }

    @Test func theReadoutAndFootnoteSurvivedTheRedesign() {
        // Non-goal check: no facts were dropped along with the legend.
        let p = busyPresentation
        #expect(!p.readout.isEmpty)
        #expect(p.chipTooltip.hasSuffix("Click for details."))
        #expect(AvailabilityHealthPresentation.pointsFootnote.contains("Pro plan-week is 100"))
    }
}

@Suite("Health detail speaks in groups (issue #281)")
struct HealthDetailAccessibilityTests {
    @Test func aGroupIsSpokenAsOneCoherentSentence() {
        guard let now = busyPresentation.section("Now") else {
            Issue.record("the NOW group always renders"); return
        }
        let spoken = now.accessibilityLabel
        #expect(spoken.hasPrefix("Now: Pool "))
        for row in now.rows {
            #expect(spoken.contains(row.label))
            #expect(spoken.contains(row.spokenValue))
        }
    }

    @Test func theTruncatableNameIsStillSpokenInFull() {
        // The view may ellipsize the account name to fit; VoiceOver must
        // still hear all of it.
        guard let week = busyPresentation.section("Week ahead"),
              let relief = week.row("Next relief") else {
            Issue.record("the relief row renders in this fixture"); return
        }
        #expect(relief.spokenValue.hasPrefix("Client Overflow Account +"))
        #expect(week.accessibilityLabel.contains("Client Overflow Account"))
    }
}
