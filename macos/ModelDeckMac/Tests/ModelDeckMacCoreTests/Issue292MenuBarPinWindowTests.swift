import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #292 (Tim's field report, 2026-08-07): the menu bar was pinned to
// one Claude account to watch its Fable weekly availability, but the pin
// always displayed the account's LOWEST window — the 5-hour burst limit —
// with no way to choose. An account pin can now carry a window choice
// ("<id>|win:<key>"), defaulting to the unchanged lowest-window behavior.
// These tests lock the grammar, the chosen-window calculator, the status
// model's honest fallback, and the traceability copy. Placeholder labels
// only — never real account data.

@Suite("Pin window grammar (issue #292)")
struct PinWindowGrammarTests {
    @Test func roundTripsEveryWindowChoice() {
        for choice in MenuBarPinResolver.PinWindow.allCases {
            let stored = MenuBarPinResolver.pinnedValue(accountId: "c1", window: choice)
            #expect(MenuBarPinResolver.pinBase(stored) == "c1")
            #expect(MenuBarPinResolver.pinWindow(stored) == choice)
        }
    }

    @Test func lowestWindowDefaultStoresThePlainPreExistingGrammar() {
        // The default must be byte-identical to the pre-#292 value so it
        // never writes a format an older build would treat as unresolvable.
        #expect(MenuBarPinResolver.pinnedValue(accountId: "c1", window: nil) == "c1")
        #expect(MenuBarPinResolver.pinBase("c1") == "c1")
        #expect(MenuBarPinResolver.pinWindow("c1") == nil)
    }

    @Test func unknownWindowKeyDegradesToLowestNotToABrokenPin() {
        // A future build's "|win:<new>" key: the account still resolves,
        // the choice reads as lowest — degraded, never broken.
        #expect(MenuBarPinResolver.pinBase("c1|win:someday") == "c1")
        #expect(MenuBarPinResolver.pinWindow("c1|win:someday") == nil)
    }

    @Test func sentinelsCarryNoWindowChoice() {
        for stored in ["", "none", "active:claude", "health:claude"] {
            #expect(MenuBarPinResolver.pinWindow(stored) == nil)
            #expect(MenuBarPinResolver.pinBase(stored) == stored)
        }
    }

    @Test func resolveStripsTheWindowSuffix() {
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: []
        )
        #expect(MenuBarPinResolver.resolve("c1|win:model", in: state) == "c1")
        #expect(MenuBarPinResolver.resolve("gone|win:model", in: state) == nil)
    }
}

@Suite("Chosen-window calculator (issue #292)")
struct PinWindowCalculatorTests {
    /// One account where the 5-hour burst (36%) is lower than the Fable
    /// weekly (81%) — so "lowest" and "model weekly" genuinely differ.
    private var state: DeckState {
        DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: [
                UsageSnapshot(accountId: "c1", scope: "5h", remainingPercent: 36),
                UsageSnapshot(accountId: "c1", scope: "week:fable", remainingPercent: 81),
                UsageSnapshot(accountId: "c1", scope: "spend", remainingPercent: 10),
            ]
        )
    }

    @Test func picksOnlyTheChosenWindowClass() {
        let fable = WorstRemainingCalculator.worstRemaining(
            in: state, accountId: "c1", pinWindow: .modelWeekly
        )
        #expect(fable == WorstRemaining(percent: 81, accountId: "c1", scope: "week:fable"))
        let burst = WorstRemainingCalculator.worstRemaining(
            in: state, accountId: "c1", pinWindow: .fiveHour
        )
        #expect(burst?.scope == "5h")
    }

    @Test func absentClassReturnsNilForTheCallerToFallBack() {
        // No general weekly reported: nil, never another class's number.
        #expect(WorstRemainingCalculator.worstRemaining(
            in: state, accountId: "c1", pinWindow: .generalWeekly
        ) == nil)
    }

    @Test func spendNeverMatchesAnyWindowChoice() {
        for choice in MenuBarPinResolver.PinWindow.allCases {
            #expect(choice.matches(scope: "spend") == false)
        }
        #expect(MenuBarPinResolver.PinWindow.fiveHour.matches(scope: "5h"))
        #expect(MenuBarPinResolver.PinWindow.generalWeekly.matches(scope: "week"))
        #expect(MenuBarPinResolver.PinWindow.modelWeekly.matches(scope: "week:fable"))
        #expect(MenuBarPinResolver.PinWindow.modelWeekly.matches(scope: "Fable weekly"))
    }
}

@Suite("Pinned window in the menu bar (issue #292)")
@MainActor
struct PinWindowStatusModelTests {
    /// The field scenario: the 5-hour burst window is lower than the Fable
    /// weekly, so a plain pin shows the burst number.
    private var fieldState: DeckState {
        DeckState(
            accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true),
                DeckAccount(id: "c2", provider: "claude", label: "Client"),
            ],
            usage: [
                UsageSnapshot(accountId: "c1", scope: "5h", remainingPercent: 36),
                UsageSnapshot(accountId: "c1", scope: "week:fable", remainingPercent: 81),
                UsageSnapshot(accountId: "c2", scope: "week", remainingPercent: 55),
            ]
        )
    }

    private func model() -> MenuBarStatusModel {
        MenuBarStatusModel(evaluator: StubEvaluator(results: []))
    }

    @Test func modelWeeklyPinShowsTheFableNumberNotTheBurst() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.pinnedValue(accountId: "c1", window: .modelWeekly)
        m.apply(deckState: fieldState)
        #expect(m.iconState == .pinned(percentRemaining: 81))
        #expect(m.menuBarPercentSource == WorstRemaining(percent: 81, accountId: "c1", scope: "week:fable"))
        let line = m.menuBarNumberSourceLine
        #expect(line?.text == "Menu bar 81% — Studio · Weekly · Fable")
        #expect(line?.tooltip.contains("pinned to Studio's Weekly · Fable") == true)
        #expect(line?.tooltip.contains("Right-click its card to unpin") == true)
    }

    @Test func plainPinBehaviorIsByteForByteUnchanged() {
        let m = model()
        m.pinnedAccountId = "c1"
        m.apply(deckState: fieldState)
        #expect(m.iconState == .pinned(percentRemaining: 36))
        #expect(m.menuBarNumberSourceLine?.tooltip.contains("shows its lowest usage window") == true)
    }

    @Test func absentChosenWindowFallsBackToLowestWithHonestCopy() {
        // c2 reports only a general weekly: a model-weekly pin falls back
        // to the lowest window and the tooltip says so.
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.pinnedValue(accountId: "c2", window: .modelWeekly)
        m.apply(deckState: fieldState)
        #expect(m.iconState == .pinned(percentRemaining: 55))
        #expect(m.menuBarPercentSource?.scope == "week")
        let tooltip = m.menuBarNumberSourceLine?.tooltip
        #expect(tooltip?.contains("model weekly window isn't reported") == true)
        #expect(tooltip?.contains("lowest usage window") == true)
    }

    @Test func severityAndQuietModeReadTheChosenWindowsPercent() {
        // "Show when below 50%": the chosen Fable weekly sits at 81, so
        // the number hides — even though the burst window is at 36.
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.pinnedValue(accountId: "c1", window: .modelWeekly)
        m.showWhen = MenuBarShowWhen.belowPercent(50).stored
        m.apply(deckState: fieldState)
        #expect(m.iconState == .plain)
        m.showWhen = MenuBarShowWhen.belowPercent(90).stored
        #expect(m.iconState == .pinned(percentRemaining: 81))
    }

    @Test func checkmarkFollowsTheSuffixedPin() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.pinnedValue(accountId: "c1", window: .modelWeekly)
        m.apply(deckState: fieldState)
        #expect(m.resolvedPinnedAccountId == "c1")
        #expect(m.menuBarSourceAccountId == "c1")
    }

    @Test func deckModelPinStateReadsThroughTheSuffix() {
        let suite = "pin-window-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let deck = DeckPopoverModel(defaults: defaults)
        var written: [String] = []
        deck.onPinMenuBarAccount = { written.append($0) }
        deck.menuBarPinnedSetting = MenuBarPinResolver.pinnedValue(accountId: "c1", window: .modelWeekly)
        #expect(deck.isMenuBarPinned("c1"))
        #expect(deck.menuBarPinWindow(for: "c1") == .modelWeekly)
        #expect(deck.menuBarPinWindow(for: "c2") == nil)
        // Unpin still works from the suffixed value; re-pinning with a
        // choice writes the composed grammar.
        deck.toggleMenuBarPin(accountID: "c1")
        deck.pinMenuBar(accountID: "c1", window: .fiveHour)
        deck.pinMenuBar(accountID: "c1", window: nil)
        #expect(written == ["", "c1|win:5h", "c1"])
    }
}
