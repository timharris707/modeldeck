import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #229: "None — icon only" in the Show percentage for picker. The
// stored value is the "none" sentinel riding the existing free-string
// `menuBarAccountId` setting; the menu bar shows the bare glyph at every
// severity while notifications keep watching every account. Placeholder
// labels only — never real account data.

@Suite("Menu bar percentage None sentinel (issue #229)")
struct MenuBarNoneSentinelTests {
    private var fixtureState: DeckState {
        DeckState(
            accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true),
                DeckAccount(id: "c2", provider: "claude", label: "Client"),
            ],
            usage: [
                UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 80),
                UsageSnapshot(accountId: "c2", scope: "week", remainingPercent: 4),
            ]
        )
    }

    @Test func noneSentinelIsRecognized() {
        #expect(MenuBarPinResolver.isNone(MenuBarPinResolver.noneSentinel))
        #expect(!MenuBarPinResolver.isNone(""))
        #expect(!MenuBarPinResolver.isNone("acct-1"))
        #expect(!MenuBarPinResolver.isNone("active:claude"))
    }

    @Test func noneNeverResolvesToAnAccount() {
        #expect(MenuBarPinResolver.resolve("none", in: fixtureState) == nil)
    }

    @Test func noneNeverResolvesEvenWhenAnAccountIdCollides() {
        // "none" is a display-mode sentinel, not a pin — a literal id
        // collision must not turn icon-only mode into a pinned account.
        let state = DeckState(
            accounts: [DeckAccount(id: "none", provider: "claude", label: "Oddly Named")],
            usage: []
        )
        #expect(MenuBarPinResolver.resolve("none", in: state) == nil)
    }

    @Test func noneMeansNoAccountFeedsTheMenuBar() {
        // No percentage shown -> no source -> no deck checkmark (#131).
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "none",
            state: fixtureState,
            worstRemaining: WorstRemaining(percent: 4, accountId: "c2", scope: "week")
        )
        #expect(source == nil)
    }
}

@Suite("Menu bar icon-only mode on the status model (issue #229)")
@MainActor
struct MenuBarNoneStatusModelTests {
    private var fixtureState: DeckState {
        DeckState(
            accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", isDefault: true),
                DeckAccount(id: "c2", provider: "claude", label: "Client"),
            ],
            usage: [
                UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 80),
                UsageSnapshot(accountId: "c2", scope: "week", remainingPercent: 4),
            ]
        )
    }

    private func model() -> MenuBarStatusModel {
        MenuBarStatusModel(evaluator: StubEvaluator(results: []))
    }

    @Test func criticalUsageStaysIconOnly() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.noneSentinel
        m.apply(deckState: fixtureState)
        // c2 is at 4% — critical for every other mode; icon-only stays plain.
        #expect(m.iconState == .plain)
        #expect(m.iconState.percentLabel == nil)
        // Display-only: the global worst is still tracked for notifications.
        #expect(m.worstRemaining == WorstRemaining(percent: 4, accountId: "c2", scope: "week"))
        // No account feeds the menu bar, so no card gets the checkmark.
        #expect(m.menuBarSourceAccountId == nil)
    }

    @Test func iconOnlySuppressesTheColdStartPlaceholder() {
        // Before the first load the default mode shows the "–%" loading
        // placeholder; icon-only means icon only from the very start.
        let m = model()
        #expect(m.iconState == .loading)
        m.pinnedAccountId = MenuBarPinResolver.noneSentinel
        #expect(m.iconState == .plain)
    }

    @Test func iconOnlyComposesTheBareGlyphMenuBarImage() {
        // End-to-end title composition: none-mode iconState renders the
        // untouched template deck glyph — no percent composite at all.
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.noneSentinel
        m.apply(deckState: fixtureState)
        let image = MenuBarIconRenderer.labelImage(for: m.iconState)
        #expect(image === MenuBarIconRenderer.deckGlyph)
        #expect(image.isTemplate)
    }

    @Test func notificationPathStillSeesTheGlobalWorst() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.noneSentinel
        var seenWorst: WorstRemaining??
        m.onStateUpdate = { worst, _ in seenWorst = worst }
        m.apply(deckState: fixtureState)
        #expect(seenWorst == WorstRemaining(percent: 4, accountId: "c2", scope: "week"))
    }

    @Test func leavingIconOnlyRestoresSeverityDisplay() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.noneSentinel
        m.apply(deckState: fixtureState)
        #expect(m.iconState == .plain)
        // Back to "Lowest across all accounts" (the daemon maps "" to nil
        // via menuBarPinnedAccountId).
        m.pinnedAccountId = nil
        #expect(m.iconState == .critical(percentRemaining: 4))
        #expect(m.menuBarSourceAccountId == "c2")
    }
}

@Suite("None sentinel storage compatibility (issue #229)")
struct MenuBarNoneStorageTests {
    @Test func settingsDocumentRoundTripsTheNoneSentinel() throws {
        let decoded = try JSONDecoder().decode(
            DaemonSettings.self,
            from: Data(#"{"menuBarAccountId": "none"}"#.utf8)
        )
        #expect(decoded.menuBarAccountId == "none")
        // The typed pin accessor surfaces it like any non-empty value; the
        // resolver is what refuses to treat it as an account.
        #expect(decoded.menuBarPinnedAccountId == "none")
    }

    @Test func patchEncodesTheNoneSentinelForThePut() throws {
        let data = try JSONEncoder().encode(
            DaemonSettingsPatch(menuBarAccountId: MenuBarPinResolver.noneSentinel)
        )
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains(#""menuBarAccountId":"none""#))
    }

    @Test func downgradeReadsNoneAsAnUnresolvablePinAbsentAnIdCollision() {
        // A build older than #229 has no none handling: with no account id
        // equal to the literal "none" (ids are store-generated UUIDs, so a
        // collision is implausible — though a colliding id WOULD be pinned
        // by an old build, which lacks the sentinel guard), the sentinel
        // reads as a pin that doesn't resolve and the pre-#229 fallback
        // path (issue #123) shows the lowest-across percentage — degraded
        // but never a crash. This test locks the exact behaviors that
        // fallback relies on: resolve() -> nil and the fallback to worst.
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: [UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 9)]
        )
        #expect(MenuBarPinResolver.resolve("none", in: state) == nil)
        // What the pre-#229 sourceAccountID did with an unresolvable pin:
        let legacyFallback = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "acct-gone",
            state: state,
            worstRemaining: WorstRemaining(percent: 9, accountId: "c1", scope: "week")
        )
        #expect(legacyFallback == "c1")
    }

    @Test func unknownFutureSentinelStillFallsBackGracefully() {
        // Forward compatibility the other way: a future sentinel this build
        // doesn't know keeps today's unresolvable-pin fallback.
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: []
        )
        #expect(MenuBarPinResolver.resolve("future:whatever", in: state) == nil)
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "future:whatever",
            state: state,
            worstRemaining: WorstRemaining(percent: 42, accountId: "c1", scope: "week")
        )
        #expect(source == "c1")
    }
}
