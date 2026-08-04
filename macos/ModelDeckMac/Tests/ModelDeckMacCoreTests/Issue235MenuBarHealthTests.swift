import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #235 — the menu bar half of Availability Health: the
// "health:<provider>" sentinel riding the free-string `menuBarAccountId`
// setting (coexisting with #229's "none"), the status-model display mode,
// the shape-coded dot composition, and the #229-style downgrade contract
// (an old build reads the sentinel as an unresolvable pin and falls back
// to lowest-across). Placeholder labels only — never real account data.

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(hoursFromNow hours: Double) -> String {
    ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(hours * 3600))
}

/// A deck whose Claude pool is healthy (full Fable weekly, no measured
/// pace → GREEN) while a second account sits at a critical 4% on its
/// 5-hour window — the fixture that proves health mode is display-only.
private var healthFixtureState: DeckState {
    DeckState(
        accounts: [
            DeckAccount(
                id: "c1", provider: "claude", label: "Studio", isDefault: true,
                metadata: DeckAccountMetadata(
                    claudePlan: ProviderPlanInfo(rateLimitTier: "default_claude_max_20x")
                ),
                authState: "ok"
            ),
            DeckAccount(id: "c2", provider: "claude", label: "Client", authState: "ok"),
        ],
        usage: [
            UsageSnapshot(
                accountId: "c1", scope: "Fable weekly", remainingPercent: 100,
                resetsAt: iso(hoursFromNow: 84), observedAt: iso(hoursFromNow: -0.01)
            ),
            UsageSnapshot(
                accountId: "c2", scope: "5h", remainingPercent: 4,
                resetsAt: iso(hoursFromNow: 2), observedAt: iso(hoursFromNow: -0.01)
            ),
        ]
    )
}

@Suite("Menu bar health sentinel grammar (issue #235)")
struct MenuBarHealthSentinelTests {
    @Test func sentinelFormatAndParsing() {
        #expect(MenuBarPinResolver.healthSentinel(for: .claude) == "health:claude")
        #expect(MenuBarPinResolver.healthSentinel(for: .codex) == "health:codex")
        #expect(MenuBarPinResolver.healthProvider("health:claude") == .claude)
        #expect(MenuBarPinResolver.healthProvider("health:codex") == .codex)
        #expect(MenuBarPinResolver.isHealth("health:claude"))
        #expect(!MenuBarPinResolver.isHealth("none"))
        #expect(!MenuBarPinResolver.isHealth("active:claude"))
        #expect(!MenuBarPinResolver.isHealth(""))
        // A provider this build doesn't know is NOT health mode — it takes
        // the unknown-sentinel fallback path instead.
        #expect(MenuBarPinResolver.healthProvider("health:gemini") == nil)
        #expect(!MenuBarPinResolver.isHealth("health:gemini"))
    }

    @Test func healthSentinelNeverResolvesToAnAccount() {
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: []
        )
        #expect(MenuBarPinResolver.resolve("health:claude", in: state) == nil)
    }

    @Test func healthSentinelNeverResolvesEvenWhenAnAccountIdCollides() {
        // Same explicit guard as #229's "none": any "health:"-prefixed
        // value is a display sentinel, never an account pin.
        let state = DeckState(
            accounts: [DeckAccount(id: "health:claude", provider: "claude", label: "Oddly Named")],
            usage: []
        )
        #expect(MenuBarPinResolver.resolve("health:claude", in: state) == nil)
        #expect(MenuBarPinResolver.resolve("health:gemini", in: DeckState(
            accounts: [DeckAccount(id: "health:gemini", provider: "claude", label: "Odder")],
            usage: []
        )) == nil)
    }

    @Test func healthModeMeansNoAccountFeedsTheMenuBar() {
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "health:claude",
            state: healthFixtureState,
            worstRemaining: WorstRemaining(percent: 4, accountId: "c2", scope: "5h")
        )
        #expect(source == nil)
    }

    @Test func unknownHealthProviderFallsBackLikeAnyUnknownSentinel() {
        // "health:gemini" is not a mode this build recognizes: the icon
        // falls back to the lowest-across percentage, so the checkmark
        // honestly marks the account that percentage comes from.
        let source = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "health:gemini",
            state: healthFixtureState,
            worstRemaining: WorstRemaining(percent: 4, accountId: "c2", scope: "5h")
        )
        #expect(source == "c2")
    }

    @Test func downgradeReadsHealthAsAnUnresolvablePin() {
        // The #229 downgrade contract, verified for the new sentinel: a
        // pre-#235 build has no health handling — the stored string
        // matches no account id, resolve() returns nil, and the pre-#229
        // fallback path (issue #123) shows lowest-across. Degraded but
        // never a crash. This locks the exact behaviors that fallback
        // relies on.
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio")],
            usage: [UsageSnapshot(accountId: "c1", scope: "week", remainingPercent: 9)]
        )
        #expect(MenuBarPinResolver.resolve("health:claude", in: state) == nil)
        let legacyFallback = MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: "acct-gone",
            state: state,
            worstRemaining: WorstRemaining(percent: 9, accountId: "c1", scope: "week")
        )
        #expect(legacyFallback == "c1")
    }
}

@Suite("Health sentinel storage compatibility (issue #235)")
struct MenuBarHealthStorageTests {
    @Test func settingsDocumentRoundTripsTheHealthSentinel() throws {
        let decoded = try JSONDecoder().decode(
            DaemonSettings.self,
            from: Data(#"{"menuBarAccountId": "health:claude"}"#.utf8)
        )
        #expect(decoded.menuBarAccountId == "health:claude")
        // The typed pin accessor surfaces it like any non-empty value; the
        // resolver is what refuses to treat it as an account.
        #expect(decoded.menuBarPinnedAccountId == "health:claude")
    }

    @Test func patchEncodesTheHealthSentinelForThePut() throws {
        let data = try JSONEncoder().encode(
            DaemonSettingsPatch(menuBarAccountId: MenuBarPinResolver.healthSentinel(for: .codex))
        )
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains(#""menuBarAccountId":"health:codex""#))
    }
}

@Suite("Menu bar health mode on the status model (issue #235)")
@MainActor
struct MenuBarHealthStatusModelTests {
    private func model() -> MenuBarStatusModel {
        MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { fixedNow }
        )
    }

    @Test func healthModeShowsTheVerdictNotThePercent() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.apply(deckState: healthFixtureState)
        // Full Fable-weekly pool, no measured pace → GREEN, even though a
        // sibling account sits at a critical 4%.
        #expect(m.iconState == .health(provider: .claude, verdict: .green))
        #expect(m.iconState.percentLabel == nil)
        // Display-only: the global worst is still tracked for notifications.
        #expect(m.worstRemaining == WorstRemaining(
            percent: 4, accountId: "c2", scope: "5h",
            resetsAt: iso(hoursFromNow: 2), stale: false
        ))
        // No single account feeds the menu bar, so no card gets the checkmark.
        #expect(m.menuBarSourceAccountId == nil)
    }

    @Test func healthModeGoesRedWhenTheMeasuredPaceRunsDry() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        // 6% left on the driver window with heavy elapsed use: the
        // measured pace droughts the pool within the horizon.
        let state = DeckState(
            accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio", authState: "ok")],
            usage: [UsageSnapshot(
                accountId: "c1", scope: "Fable weekly", remainingPercent: 6,
                resetsAt: iso(hoursFromNow: 160), observedAt: iso(hoursFromNow: -0.01)
            )]
        )
        m.apply(deckState: state)
        #expect(m.iconState == .health(provider: .claude, verdict: .red))
    }

    @Test func healthModeSuppressesTheColdStartPlaceholderHonestly() {
        // Before any state lands the mode renders the muted no-data dot —
        // never the "–%" percent placeholder, never a guessed color.
        let m = model()
        #expect(m.iconState == .loading)
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .codex)
        #expect(m.iconState == .health(provider: .codex, verdict: nil))
    }

    @Test func emptyProviderPoolShowsTheNoDataDot() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .codex)
        // The fixture has no codex accounts at all.
        m.apply(deckState: healthFixtureState)
        #expect(m.iconState == .health(provider: .codex, verdict: nil))
    }

    @Test func notificationPathStillSeesTheGlobalWorst() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        var seenWorst: WorstRemaining??
        m.onStateUpdate = { worst, _ in seenWorst = worst }
        m.apply(deckState: healthFixtureState)
        #expect(seenWorst == WorstRemaining(
            percent: 4, accountId: "c2", scope: "5h",
            resetsAt: iso(hoursFromNow: 2), stale: false
        ))
    }

    @Test func leavingHealthModeRestoresSeverityDisplay() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.apply(deckState: healthFixtureState)
        #expect(m.iconState == .health(provider: .claude, verdict: .green))
        m.pinnedAccountId = nil
        #expect(m.iconState == .critical(percentRemaining: 4))
        #expect(m.menuBarSourceAccountId == "c2")
    }

    @Test func unknownHealthProviderKeepsThePercentFallback() {
        // recomputeIconState mirrors sourceAccountID: an unrecognized
        // "health:<future>" value is an unresolvable pin, not health mode.
        let m = model()
        m.pinnedAccountId = "health:gemini"
        m.apply(deckState: healthFixtureState)
        #expect(m.iconState == .critical(percentRemaining: 4))
    }
}

@Suite("Menu bar health dot composition (issue #235)")
@MainActor
struct MenuBarHealthRendererTests {
    @Test func healthImagesAreFullColorComposites() {
        for verdict in AvailabilityVerdict.allCases {
            let image = MenuBarIconRenderer.labelImage(
                for: .health(provider: .claude, verdict: verdict)
            )
            // Never the bare template glyph: the dot rides beside it, and
            // the composite must stay non-template so the menu bar can't
            // flatten the color.
            #expect(image !== MenuBarIconRenderer.deckGlyph)
            #expect(!image.isTemplate)
            #expect(image.size.width > MenuBarIconRenderer.deckGlyph.size.width)
        }
    }

    @Test func accessibilityDescriptionSpeaksProviderAndVerdict() {
        let green = MenuBarIconRenderer.labelImage(
            for: .health(provider: .claude, verdict: .green)
        )
        #expect(green.accessibilityDescription == "ModelDeck Claude availability green")
        let unknown = MenuBarIconRenderer.labelImage(
            for: .health(provider: .codex, verdict: nil)
        )
        #expect(unknown.accessibilityDescription == "ModelDeck Codex availability unknown")
    }
}

@Suite("Health chip warning-slot reconcile (issue #235)")
@MainActor
struct HealthChipReconcileTests {
    private func model() -> DeckPopoverModel {
        let defaults = UserDefaults(suiteName: "health-chip-tests-\(UUID().uuidString)")!
        return DeckPopoverModel(defaults: defaults)
    }

    @Test func healthChipIDsAreLiveWhileTheChipsRender() {
        let live = DeckPopoverModel.liveWarningIDs(
            rows: [], staleness: { _ in nil }, cadenceNoticeVisible: false,
            healthChipProviders: [.claude, .codex]
        )
        #expect(live.contains(DeckWarningID(topic: .availabilityHealth, elementID: "claude")))
        #expect(live.contains(DeckWarningID(topic: .availabilityHealth, elementID: "codex")))
    }

    @Test func openDetailPopoverSurvivesARefreshWhileChipsRender() {
        let m = model()
        let chipID = DeckWarningID(topic: .availabilityHealth, elementID: "claude")
        m.toggleWarning(chipID)
        m.reconcileWarnings(
            rows: [], staleness: { _ in nil }, cadenceNoticeVisible: false,
            healthChipProviders: [.claude, .codex]
        )
        #expect(m.presentedWarning == chipID)
    }

    @Test func openDetailPopoverIsReleasedWhenTheChipsLeave() {
        // Layout switched to single column (no column headers, no chips):
        // the presented slot must not stay latched to a vanished anchor.
        let m = model()
        m.toggleWarning(DeckWarningID(topic: .availabilityHealth, elementID: "claude"))
        m.reconcileWarnings(
            rows: [], staleness: { _ in nil }, cadenceNoticeVisible: false,
            healthChipProviders: []
        )
        #expect(m.presentedWarning == nil)
    }
}
