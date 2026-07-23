import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #131 (Tim directive 2026-07-22): the deck checkmark means "shown in
// menu bar" — exactly ONE checkmark across the whole deck, on the account
// whose window currently feeds the menu bar percentage. These tests cover the
// pure resolver (all three modes + the #123 fallback), the status-model
// property the view reads, the spend-only edge (documented lane decision:
// the checkmark stays on the resolved pinned account), and the
// never-two-checkmarks invariant. Placeholder labels only — never real
// account data.

@Suite("Menu bar source resolver (issue #131)")
struct MenuBarSourceResolverTests {
    private func state(
        accounts: [DeckAccount],
        usage: [UsageSnapshot] = []
    ) -> DeckState {
        DeckState(accounts: accounts, usage: usage)
    }

    private var twoProviderState: DeckState {
        state(
            accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true),
                DeckAccount(id: "c2", provider: "claude", label: "Client"),
                DeckAccount(id: "x1", provider: "codex", label: "Personal", isDefault: true),
            ],
            usage: [
                UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 80),
                UsageSnapshot(accountId: "c2", scope: "week", remainingPercent: 10),
                UsageSnapshot(accountId: "x1", scope: "week", remainingPercent: 60),
            ]
        )
    }

    private func worst(_ id: String, _ percent: Double) -> WorstRemaining {
        WorstRemaining(percent: percent, accountId: id, scope: "week")
    }

    // MARK: - Lowest-across (default)

    @Test func lowestAcrossMarksTheAccountOwningTheShownPercent() {
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: nil,
            state: twoProviderState,
            worstRemaining: worst("c2", 10)
        )
        #expect(source == "c2")
    }

    @Test func lowestAcrossMovesAsTheLowestChanges() {
        // The worst flips to another account between refreshes — the
        // checkmark moves with it.
        let before = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "",
            state: twoProviderState,
            worstRemaining: worst("c2", 10)
        )
        let after = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "",
            state: twoProviderState,
            worstRemaining: worst("x1", 4)
        )
        #expect(before == "c2")
        #expect(after == "x1")
    }

    @Test func noMeasurableUsageAnywhereMeansNoSource() {
        // The menu bar shows the plain glyph fed by no account — no card
        // gets the checkmark.
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: nil,
            state: state(accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true),
            ]),
            worstRemaining: nil
        )
        #expect(source == nil)
    }

    // MARK: - Pinned mode

    @Test func pinnedModeMarksThePinnedAccountRegardlessOfTheWorst() {
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "x1",
            state: twoProviderState,
            worstRemaining: worst("c2", 10)
        )
        #expect(source == "x1")
    }

    @Test func unresolvablePinFallsBackToTheLowestAccount() {
        // #123 fallback: a pin naming a removed account falls back to
        // lowest-across — the checkmark must follow the fallback so it never
        // points at an account that isn't actually shown.
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "gone",
            state: twoProviderState,
            worstRemaining: worst("c2", 10)
        )
        #expect(source == "c2")
    }

    // MARK: - Follow-active mode

    @Test func followActiveMarksTheProvidersActiveAccount() {
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "active:claude",
            state: twoProviderState,
            worstRemaining: worst("c2", 10)
        )
        #expect(source == "c1")
    }

    @Test func followActiveTracksAnActivationSwitch() {
        var switched = twoProviderState
        switched.accounts[0].isDefault = false
        switched.accounts[1].isDefault = true
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "active:claude",
            state: switched,
            worstRemaining: worst("x1", 4)
        )
        #expect(source == "c2")
    }

    @Test func followActiveWithNoActiveAccountFallsBack() {
        var noDefault = twoProviderState
        noDefault.accounts[0].isDefault = false
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "active:claude",
            state: noDefault,
            worstRemaining: worst("c2", 10)
        )
        #expect(source == "c2")
    }

    // MARK: - Tooltip copy (mode-honest, including fallback)

    @Test func tooltipNamesTheLowestAcrossModeWhenUnpinned() {
        for setting: String? in [nil, ""] {
            let tooltip = MenuBarSourceResolver.checkmarkTooltip(
                pinnedSetting: setting,
                resolvedPinnedAccountID: nil,
                accountID: "c2"
            )
            #expect(tooltip.contains("lowest % left"))
            #expect(!tooltip.contains("pinned"))
        }
    }

    @Test func tooltipNamesThePinWhenTheAccountIsPinned() {
        let tooltip = MenuBarSourceResolver.checkmarkTooltip(
            pinnedSetting: "x1",
            resolvedPinnedAccountID: "x1",
            accountID: "x1"
        )
        #expect(tooltip.contains("pinned"))
    }

    @Test func tooltipNamesFollowActiveWhenTheSentinelResolvedHere() {
        let tooltip = MenuBarSourceResolver.checkmarkTooltip(
            pinnedSetting: "active:claude",
            resolvedPinnedAccountID: "c1",
            accountID: "c1"
        )
        #expect(tooltip.contains("following the active account"))
    }

    @Test func tooltipIsHonestAboutTheFallbackWhenThePinDidNotResolve() {
        // The stored pin names something unavailable; this row won the
        // lowest-across fallback — the copy must not claim a working pin.
        for setting in ["gone", "active:claude"] {
            let tooltip = MenuBarSourceResolver.checkmarkTooltip(
                pinnedSetting: setting,
                resolvedPinnedAccountID: nil,
                accountID: "c2"
            )
            #expect(tooltip.contains("isn't available"))
            #expect(tooltip.contains("lowest % left"))
        }
    }
}

@Suite("Menu bar source on the status model (issue #131)")
@MainActor
struct MenuBarStatusModelSourceTests {
    private var fixtureState: DeckState {
        DeckState(
            accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true),
                DeckAccount(id: "c2", provider: "claude", label: "Client"),
                DeckAccount(id: "x1", provider: "codex", label: "Personal", isDefault: true),
            ],
            usage: [
                UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 80),
                UsageSnapshot(accountId: "c2", scope: "week", remainingPercent: 10),
                UsageSnapshot(accountId: "x1", scope: "week", remainingPercent: 60),
            ]
        )
    }

    private func model() -> MenuBarStatusModel {
        MenuBarStatusModel(evaluator: StubEvaluator(results: []))
    }

    @Test func sourceIsNilBeforeTheFirstLoad() {
        // The `.loading` placeholder comes from no account — pinned or not.
        let m = model()
        #expect(m.menuBarSourceAccountId == nil)
        m.pinnedAccountId = "c1"
        #expect(m.menuBarSourceAccountId == nil)
    }

    @Test func lowestAcrossSourceMatchesTheShownPercent() {
        let m = model()
        m.apply(deckState: fixtureState)
        #expect(m.iconState == .critical(percentRemaining: 10))
        #expect(m.menuBarSourceAccountId == "c2")
    }

    @Test func pinningMovesTheSourceWithTheShownPercent() {
        let m = model()
        m.apply(deckState: fixtureState)
        m.pinnedAccountId = "x1"
        #expect(m.iconState == .pinned(percentRemaining: 60))
        #expect(m.menuBarSourceAccountId == "x1")

        m.pinnedAccountId = nil
        #expect(m.iconState == .critical(percentRemaining: 10))
        #expect(m.menuBarSourceAccountId == "c2")
    }

    @Test func unresolvablePinSourceFollowsTheFallbackedIcon() {
        let m = model()
        m.pinnedAccountId = "acct-gone"
        m.apply(deckState: fixtureState)
        // #123: the icon falls back to the global worst — the checkmark
        // follows the RESOLVED source, i.e. the fallback account.
        #expect(m.iconState == .critical(percentRemaining: 10))
        #expect(m.menuBarSourceAccountId == "c2")
    }

    @Test func followActiveSourceTracksActivationSwitches() {
        let m = model()
        m.pinnedAccountId = "active:claude"
        var state = fixtureState
        m.apply(deckState: state)
        #expect(m.menuBarSourceAccountId == "c1")

        state.accounts[0].isDefault = false
        state.accounts[1].isDefault = true
        m.apply(deckState: state)
        #expect(m.menuBarSourceAccountId == "c2")
    }

    @Test func spendOnlyPinnedAccountShowsPlainButKeepsTheSource() {
        // Documented lane decision on issue #131's spend-only edge: the pin
        // resolves but the account has only spend data, so the menu bar
        // shows the plain glyph with no percentage (issue #28's spend rule).
        // The checkmark STAYS on the resolved account — the pin is still in
        // force and that account owns the (empty) menu bar slot; hiding it
        // would make a working pin look broken, and moving it to the global
        // worst would mark an account the menu bar is not showing.
        let m = model()
        var state = fixtureState
        state.usage = [
            UsageSnapshot(accountId: "c2", scope: "week", remainingPercent: 10),
            UsageSnapshot(accountId: "x1", scope: "spend", remainingPercent: 40),
        ]
        m.pinnedAccountId = "x1"
        m.apply(deckState: state)
        #expect(m.iconState == .plain)
        #expect(m.menuBarSourceAccountId == "x1")
    }

    // MARK: - Never two checkmarks

    @Test func neverTwoCheckmarksAcrossEveryMode() {
        // The old semantics marked one CLI-active account PER PROVIDER — two
        // checkmarks on a two-provider deck. The new marking derives from
        // one source id, so across every mode (default, pinned, unresolved
        // pin, follow-active, no data) at most one deck row can match.
        let m = model()
        var spendOnly = fixtureState
        spendOnly.usage = [UsageSnapshot(accountId: "x1", scope: "spend", remainingPercent: 40)]
        let modes: [(String?, DeckState)] = [
            (nil, fixtureState),
            ("", fixtureState),
            ("x1", fixtureState),
            ("acct-gone", fixtureState),
            ("active:claude", fixtureState),
            ("active:codex", fixtureState),
            ("x1", spendOnly),
        ]
        for (setting, state) in modes {
            m.pinnedAccountId = setting
            m.apply(deckState: state)
            let rows = DeckBuilder.rows(state: state)
            let marked = rows.filter { $0.id == m.menuBarSourceAccountId }
            #expect(marked.count <= 1, "mode \(String(describing: setting)) marked \(marked.count) rows")
        }
    }

    @Test func cliActiveAccountsGetNoCheckmarkUnlessTheyFeedTheMenuBar() {
        // Both providers have a DB-default (CLI-active) account — c1 and x1.
        // Under the pre-#131 semantics both carried checkmarks. Now neither
        // does: the single checkmark sits on c2, the account whose window
        // the menu bar shows.
        let m = model()
        m.apply(deckState: fixtureState)
        let rows = DeckBuilder.rows(state: fixtureState)
        let source = m.menuBarSourceAccountId
        #expect(source == "c2")
        #expect(rows.first { $0.id == "c1" }?.isActive == true)
        #expect(rows.first { $0.id == "x1" }?.isActive == true)
        let markedActive = rows.filter { $0.isActive && $0.id == source }
        #expect(markedActive.isEmpty, "CLI-active state must not earn the deck checkmark")
    }

    @Test func modeTransitionsAlwaysLandOnExactlyOneOrZeroSources() {
        // Walk the modes in sequence on one model — the source id must be
        // single-valued after every transition, and match the mode's rule.
        let m = model()
        m.apply(deckState: fixtureState)
        #expect(m.menuBarSourceAccountId == "c2") // lowest-across

        m.pinnedAccountId = "x1"
        #expect(m.menuBarSourceAccountId == "x1") // pinned

        m.pinnedAccountId = "active:codex"
        #expect(m.menuBarSourceAccountId == "x1") // follow-active resolves

        m.pinnedAccountId = "active:claude"
        #expect(m.menuBarSourceAccountId == "c1") // follows the other provider

        m.pinnedAccountId = nil
        #expect(m.menuBarSourceAccountId == "c2") // back to lowest-across

        var empty = fixtureState
        empty.usage = []
        m.apply(deckState: empty)
        #expect(m.menuBarSourceAccountId == nil) // nothing shown, nothing marked
    }
}
