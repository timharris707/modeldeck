import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #249 (Tim's 2026-08-04 field report): the menu bar read "36%" while
// no visible card showed 36 — the cards were toggled to the model-window
// headline ("Weekly · Fable 81%") for the same account, so the number looked
// like a tracking bug or an account mix-up. The data was correct (36% was
// the account's 5-hour window); the number was just untraceable. These tests
// lock the traceability surfaces: `menuBarPercentSource` (the exact window
// feeding the displayed percent), the popover source line, and the #131
// checkmark tooltip's window suffix. Placeholder labels only — never real
// account data.

@Suite("Menu bar percent source (issue #249)")
@MainActor
struct MenuBarPercentSourceTests {
    /// Tim's field scenario: the followed account's 5-hour window is at 36%
    /// while its model-scoped weekly — what the cards were headlining — is
    /// at 81%.
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

    @Test func followActivePercentTracesToAccountAndWindow() {
        // The exact field setup: following the active Claude account, whose
        // lowest window (the 5-hour limit) drives the continuously-shown 36%.
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.followActiveSentinel(for: .claude)
        m.apply(deckState: fieldState)
        #expect(m.iconState == .pinned(percentRemaining: 36))
        #expect(m.menuBarPercentSource == WorstRemaining(percent: 36, accountId: "c1", scope: "5h"))
        let line = m.menuBarNumberSourceLine
        #expect(line?.text == "Menu bar 36% — Studio · 5-hour limit")
        #expect(line?.tooltip.contains("follows the active account") == true)
        #expect(line?.tooltip.contains("limit window") == false)
        #expect(line?.tooltip.contains("Studio's 5-hour limit") == true)
    }

    @Test func plainPinNamesTheUnpinAffordance() {
        let m = model()
        m.pinnedAccountId = "c1"
        m.apply(deckState: fieldState)
        let line = m.menuBarNumberSourceLine
        #expect(line?.text == "Menu bar 36% — Studio · 5-hour limit")
        #expect(line?.tooltip.contains("pinned to this account") == true)
        #expect(line?.tooltip.contains("Right-click its card to unpin") == true)
    }

    @Test func lowestAcrossWarningTracesToTheWinningWindow() {
        var state = fieldState
        state.usage.append(UsageSnapshot(accountId: "c2", scope: "5h", remainingPercent: 18))
        let m = model()
        m.apply(deckState: state)
        #expect(m.iconState == .warning(percentRemaining: 18))
        #expect(m.menuBarPercentSource == WorstRemaining(percent: 18, accountId: "c2", scope: "5h"))
        let line = m.menuBarNumberSourceLine
        #expect(line?.text == "Menu bar 18% — Client · 5-hour limit")
        #expect(line?.tooltip.contains("lowest % left across every account") == true)
    }

    @Test func unresolvablePinFallsBackWithHonestCopy() {
        var state = fieldState
        state.usage.append(UsageSnapshot(accountId: "c2", scope: "5h", remainingPercent: 18))
        let m = model()
        m.pinnedAccountId = "acct-gone"
        m.apply(deckState: state)
        #expect(m.iconState == .warning(percentRemaining: 18))
        #expect(m.menuBarNumberSourceLine?.tooltip.contains("pinned selection isn't available") == true)
    }

    @Test func hiddenNumberHasNoSourceToExplain() {
        let m = model()
        // Lowest-across with every window healthy: plain glyph, no percent.
        m.apply(deckState: fieldState)
        #expect(m.iconState == .plain)
        #expect(m.menuBarPercentSource == nil)
        #expect(m.menuBarNumberSourceLine == nil)
    }

    @Test func quietModeHidingTheNumberHidesTheLineToo() {
        // Pinned at 36% but "Show when below 30%": the glyph is plain, so
        // there is no number to trace.
        let m = model()
        m.pinnedAccountId = "c1"
        m.showWhen = MenuBarShowWhen.belowPercent(30).stored
        m.apply(deckState: fieldState)
        #expect(m.iconState == .plain)
        #expect(m.menuBarNumberSourceLine == nil)
    }

    @Test func displayOnlyModesHaveNoSource() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.noneSentinel
        m.apply(deckState: fieldState)
        #expect(m.menuBarPercentSource == nil)
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        #expect(m.menuBarPercentSource == nil)
    }

    @Test func loadingPlaceholderHasNoSource() {
        let m = model()
        #expect(m.iconState == .loading)
        #expect(m.menuBarPercentSource == nil)
        #expect(m.menuBarNumberSourceLine == nil)
    }
}

@Suite("Menu bar number source line copy (issue #249)")
struct MenuBarNumberSourceLineTests {
    @Test func missingAccountLabelFallsBackToTheWindowAlone() {
        // Daemon-evaluated worst for an account the state fetch doesn't
        // carry (mid-refresh mismatch): the line stays honest without a
        // name rather than inventing one.
        let line = MenuBarSourceResolver.numberSourceLine(
            source: WorstRemaining(percent: 36.4, accountId: "ghost", scope: "5h"),
            accountLabel: nil,
            pinnedSetting: nil,
            resolvedPinnedAccountID: nil
        )
        #expect(line.text == "Menu bar 36% — 5-hour limit")
        #expect(line.tooltip.contains("the 5-hour limit") == true)
    }

    @Test func anEmptyAccountLabelReadsAsUnavailable() {
        // CodeRabbit (PR #250): an empty label must degrade to the
        // label-less copy, never render "'s 5-hour limit".
        let line = MenuBarSourceResolver.numberSourceLine(
            source: WorstRemaining(percent: 36, accountId: "c1", scope: "5h"),
            accountLabel: "",
            pinnedSetting: nil,
            resolvedPinnedAccountID: nil
        )
        #expect(line.text == "Menu bar 36% — 5-hour limit")
        #expect(line.tooltip.contains("'s") == false)
    }

    @Test func aSpendSourceIsNamedABudgetNotALimitWindow() {
        // CodeRabbit (PR #250): the calculator falls back to spend when an
        // account has no measurable rate-limit window. Calling that a
        // "limit window" would be a lie in exactly the state this copy
        // exists to clarify.
        #expect(MenuBarSourceResolver.windowDescriptor(for: "spend") == "Spend budget")
        #expect(MenuBarSourceResolver.windowDescriptor(for: "5h") == "5-hour limit")
        let line = MenuBarSourceResolver.numberSourceLine(
            source: WorstRemaining(percent: 40, accountId: "c1", scope: "spend"),
            accountLabel: "Studio",
            pinnedSetting: "c1",
            resolvedPinnedAccountID: "c1"
        )
        #expect(line.text == "Menu bar 40% — Studio · Spend budget")
        #expect(line.tooltip.contains("limit window") == false)
        #expect(line.tooltip.contains("Studio's Spend budget") == true)
    }

    @Test func modelScopedWeeklyUsesTheCardWindowTitle() {
        // The same formatter the cards use, so the line's window name always
        // matches a row the user can find ("Weekly · Fable").
        let line = MenuBarSourceResolver.numberSourceLine(
            source: WorstRemaining(percent: 81, accountId: "c1", scope: "week:fable"),
            accountLabel: "Studio",
            pinnedSetting: "c1",
            resolvedPinnedAccountID: "c1"
        )
        #expect(line.text == "Menu bar 81% — Studio · Weekly · Fable")
    }
}

@Suite("Checkmark tooltip window suffix (issue #249)")
struct CheckmarkWindowSuffixTests {
    @Test func windowTitleAppendsTheFeedingWindow() {
        let tooltip = MenuBarSourceResolver.checkmarkTooltip(
            pinnedSetting: nil,
            resolvedPinnedAccountID: nil,
            accountID: "c1",
            windowTitle: "5-hour limit"
        )
        #expect(tooltip == "Shown in the menu bar — currently the lowest % left across accounts. "
            + "Its 5-hour limit is the number in the menu bar.")
    }

    @Test func absentWindowTitleKeepsThePreExistingCopy() {
        // No percent currently shown (plain glyph / quiet mode): the #131
        // copy is unchanged, byte for byte.
        let unpinned = MenuBarSourceResolver.checkmarkTooltip(
            pinnedSetting: nil, resolvedPinnedAccountID: nil, accountID: "c1"
        )
        #expect(unpinned == "Shown in the menu bar — currently the lowest % left across accounts")
        let pinned = MenuBarSourceResolver.checkmarkTooltip(
            pinnedSetting: "c1", resolvedPinnedAccountID: "c1", accountID: "c1"
        )
        #expect(pinned == "Shown in the menu bar — pinned (right-click to unpin)")
        let active = MenuBarSourceResolver.checkmarkTooltip(
            pinnedSetting: "active:claude", resolvedPinnedAccountID: "c1", accountID: "c1"
        )
        #expect(active == "Shown in the menu bar — following the active account")
        let fallback = MenuBarSourceResolver.checkmarkTooltip(
            pinnedSetting: "acct-gone", resolvedPinnedAccountID: nil, accountID: "c1"
        )
        #expect(fallback == "Shown in the menu bar — the pinned selection isn't available, "
            + "so the lowest % left across accounts is shown")
    }
}
