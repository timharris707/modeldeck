import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #238 — menu bar quiet mode: the `menuBarShowWhen` setting (its own
// key, #229/#235 compat discipline), the `MenuBarShowWhen` grammar, and the
// display-only gating on the status model — health modes hide a GREEN dot
// ("all-clear = silence"), percentage modes hide the number until it drops
// below an independent threshold. Notifications keep watching every account
// in every case. Placeholder labels only — never real account data.

private let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(hoursFromNow hours: Double) -> String {
    ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(hours * 3600))
}

/// Healthy Claude pool (full Fable weekly, no measured pace → GREEN) with a
/// sibling at a critical 4% — the #235 fixture that proves display modes are
/// display-only.
private var greenFixtureState: DeckState {
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

/// 30% left with the weekly reset only 12 hours out: measured pace
/// ~10.8 pts/day, sustainable multiple ~1.36 → YELLOW.
private var yellowFixtureState: DeckState {
    DeckState(
        accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio", authState: "ok")],
        usage: [UsageSnapshot(
            accountId: "c1", scope: "Fable weekly", remainingPercent: 30,
            resetsAt: iso(hoursFromNow: 12), observedAt: iso(hoursFromNow: -0.01)
        )]
    )
}

/// 6% left with heavy elapsed use and the reset far out: the measured pace
/// droughts the pool → RED (the #235 red fixture).
private var redFixtureState: DeckState {
    DeckState(
        accounts: [DeckAccount(id: "c1", provider: "claude", label: "Studio", authState: "ok")],
        usage: [UsageSnapshot(
            accountId: "c1", scope: "Fable weekly", remainingPercent: 6,
            resetsAt: iso(hoursFromNow: 160), observedAt: iso(hoursFromNow: -0.01)
        )]
    )
}

@Suite("menuBarShowWhen grammar (issue #238)")
struct MenuBarShowWhenGrammarTests {
    @Test func storedValuesRoundTrip() {
        let cases: [MenuBarShowWhen] = [
            .always, .belowPercent(1), .belowPercent(25), .belowPercent(99),
            .yellowOrWorse, .redOnly,
        ]
        for mode in cases {
            #expect(MenuBarShowWhen.parse(mode.stored) == mode)
        }
        #expect(MenuBarShowWhen.always.stored == "")
        #expect(MenuBarShowWhen.belowPercent(25).stored == "below:25")
        #expect(MenuBarShowWhen.yellowOrWorse.stored == "yellow")
        #expect(MenuBarShowWhen.redOnly.stored == "red")
    }

    @Test func unknownValuesParseAsAlways() {
        // The graceful-degradation contract: anything this build doesn't
        // recognize — including future values and malformed thresholds —
        // means "always shown", never a crash, never data hidden by
        // surprise.
        for stored in [
            "nonsense", "yellowish", "RED", "below:", "below:0", "below:100",
            "below:-5", "below:abc", "orange", "attention",
        ] {
            #expect(MenuBarShowWhen.parse(stored) == .always, "\(stored)")
        }
    }

    @Test func healthGateShowsYellowAndRedHidesGreen() {
        #expect(!MenuBarShowWhen.yellowOrWorse.showsHealth(verdict: .green))
        #expect(MenuBarShowWhen.yellowOrWorse.showsHealth(verdict: .yellow))
        #expect(MenuBarShowWhen.yellowOrWorse.showsHealth(verdict: .red))
        #expect(!MenuBarShowWhen.redOnly.showsHealth(verdict: .green))
        #expect(!MenuBarShowWhen.redOnly.showsHealth(verdict: .yellow))
        #expect(MenuBarShowWhen.redOnly.showsHealth(verdict: .red))
        // Always and the percentage value never hide the dot.
        for verdict in AvailabilityVerdict.allCases {
            #expect(MenuBarShowWhen.always.showsHealth(verdict: verdict))
            #expect(MenuBarShowWhen.belowPercent(25).showsHealth(verdict: verdict))
        }
    }

    @Test func nilVerdictAlwaysShows() {
        // Quiet mode must never dress "unknown" up as all-clear: the muted
        // no-data ring stays visible in every quiet setting.
        #expect(MenuBarShowWhen.yellowOrWorse.showsHealth(verdict: nil))
        #expect(MenuBarShowWhen.redOnly.showsHealth(verdict: nil))
        #expect(MenuBarShowWhen.always.showsHealth(verdict: nil))
    }

    @Test func percentGateIsStrictlyBelowTheThreshold() {
        let gate = MenuBarShowWhen.belowPercent(30)
        #expect(gate.showsPercent(29.9))
        #expect(gate.showsPercent(0))
        #expect(!gate.showsPercent(30))
        #expect(!gate.showsPercent(30.1))
        #expect(!gate.showsPercent(100))
        // Always and the health values never hide the number.
        #expect(MenuBarShowWhen.always.showsPercent(100))
        #expect(MenuBarShowWhen.yellowOrWorse.showsPercent(100))
        #expect(MenuBarShowWhen.redOnly.showsPercent(100))
    }

    @Test func percentThresholdAccessor() {
        #expect(MenuBarShowWhen.belowPercent(15).percentThreshold == 15)
        #expect(MenuBarShowWhen.always.percentThreshold == nil)
        #expect(MenuBarShowWhen.yellowOrWorse.percentThreshold == nil)
        #expect(MenuBarShowWhen.redOnly.percentThreshold == nil)
    }
}

@Suite("menuBarShowWhen storage compatibility (issue #238)")
struct MenuBarShowWhenStorageTests {
    @Test func settingsDecodeToleratesTheMissingKey() throws {
        // Pre-#238 daemons omit the key entirely → always shown (default:
        // existing users see zero behavior change).
        let old = try JSONDecoder().decode(DaemonSettings.self, from: Data("{}".utf8))
        #expect(old.menuBarShowWhen == "")
        #expect(old.menuBarShowWhenMode == .always)
    }

    @Test func settingsDocumentRoundTripsEveryGrammarValue() throws {
        for stored in ["", "below:25", "yellow", "red"] {
            let decoded = try JSONDecoder().decode(
                DaemonSettings.self,
                from: Data(#"{"menuBarShowWhen": "\#(stored)"}"#.utf8)
            )
            #expect(decoded.menuBarShowWhen == stored)
            #expect(decoded.menuBarShowWhenMode == MenuBarShowWhen.parse(stored))
        }
    }

    @Test func unknownStoredValueSurvivesButReadsAsAlways() throws {
        // A newer build's future value round-trips verbatim (never
        // clobbered) while THIS build treats it as always shown.
        let decoded = try JSONDecoder().decode(
            DaemonSettings.self,
            from: Data(#"{"menuBarShowWhen": "moon-phase:full"}"#.utf8)
        )
        #expect(decoded.menuBarShowWhen == "moon-phase:full")
        #expect(decoded.menuBarShowWhenMode == .always)
    }

    @Test func patchEncodesTheKeyForThePut() throws {
        let data = try JSONEncoder().encode(DaemonSettingsPatch(menuBarShowWhen: "yellow"))
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains(#""menuBarShowWhen":"yellow""#))
        // Absent field stays absent — the daemon's merge semantics.
        let empty = try JSONEncoder().encode(DaemonSettingsPatch(menuBarAccountId: "acct-1"))
        let emptyJSON = try #require(String(data: empty, encoding: .utf8))
        #expect(!emptyJSON.contains("menuBarShowWhen"))
    }

    @Test func patchMergingAndEmptinessCoverTheKey() {
        let first = DaemonSettingsPatch(menuBarShowWhen: "yellow")
        let second = DaemonSettingsPatch(menuBarShowWhen: "below:20")
        #expect(first.merging(second).menuBarShowWhen == "below:20")
        #expect(second.merging(first).menuBarShowWhen == "yellow")
        #expect(!first.isEmpty)
        #expect(DaemonSettingsPatch().isEmpty)
    }
}

@Suite("menuBarShowWhen sync model (issue #238)")
@MainActor
struct MenuBarShowWhenSyncTests {
    @Test func setterSyncsAndEchoesAreNoOps() async {
        var confirmed = DaemonSettings.defaults
        confirmed.menuBarShowWhen = "yellow"
        let sync = StubSettingsSync(results: [
            .success(DaemonSettings.defaults),
            .success(confirmed),
        ])
        let model = SettingsSyncModel(sync: sync)
        await model.load()

        // Echo of the stored default ("" = always): no PUT.
        await model.setMenuBarShowWhen("")
        #expect(sync.pushedPatches.isEmpty)

        await model.setMenuBarShowWhen("yellow")
        #expect(sync.pushedPatches.count == 1)
        #expect(sync.pushedPatches.first?.menuBarShowWhen == "yellow")
        #expect(model.settings.menuBarShowWhen == "yellow")

        // Confirmed echo: no second PUT.
        await model.setMenuBarShowWhen("yellow")
        #expect(sync.pushedPatches.count == 1)
    }

    @Test func oldDaemonRejectingTheKeyIsASuccessfulNoOp() async {
        // A pre-#238 daemon answers "unknown setting: menuBarShowWhen" —
        // the key was the whole patch, so the stripped patch is empty: no
        // retry PUT, no lastError, always-shown behavior simply stays.
        let sync = StubSettingsSync(results: [
            .failure(DaemonClientError.daemonError(
                message: "unknown setting: menuBarShowWhen", status: 400
            )),
        ])
        let model = SettingsSyncModel(sync: sync)

        await model.setMenuBarShowWhen("below:25")

        #expect(sync.pushedPatches.count == 1)
        #expect(model.lastError == nil)
        #expect(model.settings.menuBarShowWhen == "")
    }
}

@Suite("Quiet mode gating — health (issue #238)")
@MainActor
struct MenuBarQuietHealthTests {
    private func model() -> MenuBarStatusModel {
        MenuBarStatusModel(evaluator: StubEvaluator(results: []), clock: { fixedNow })
    }

    @Test func yellowOrWorseHidesAGreenDeck() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.showWhen = MenuBarShowWhen.yellowOrWorse.stored
        m.apply(deckState: greenFixtureState)
        // All-clear = silence: the plain glyph, not a green dot.
        #expect(m.iconState == .plain)
        // Display-only: the global worst is still tracked for notifications.
        #expect(m.worstRemaining == WorstRemaining(
            percent: 4, accountId: "c2", scope: "5h",
            resetsAt: iso(hoursFromNow: 2), stale: false
        ))
    }

    @Test func yellowOrWorseShowsAYellowDeck() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.showWhen = MenuBarShowWhen.yellowOrWorse.stored
        m.apply(deckState: yellowFixtureState)
        #expect(m.iconState == .health(provider: .claude, verdict: .yellow))
    }

    @Test func yellowOrWorseShowsARedDeck() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.showWhen = MenuBarShowWhen.yellowOrWorse.stored
        m.apply(deckState: redFixtureState)
        #expect(m.iconState == .health(provider: .claude, verdict: .red))
    }

    @Test func redOnlyHidesYellowShowsRed() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.showWhen = MenuBarShowWhen.redOnly.stored
        m.apply(deckState: yellowFixtureState)
        #expect(m.iconState == .plain)
        m.apply(deckState: redFixtureState)
        #expect(m.iconState == .health(provider: .claude, verdict: .red))
    }

    @Test func quietHealthKeepsTheNoDataRing() {
        // No data yet / empty provider pool: the muted ring stays — quiet
        // mode never claims all-clear for a health it can't compute.
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .codex)
        m.showWhen = MenuBarShowWhen.yellowOrWorse.stored
        #expect(m.iconState == .health(provider: .codex, verdict: nil))
        m.apply(deckState: greenFixtureState) // no codex accounts at all
        #expect(m.iconState == .health(provider: .codex, verdict: nil))
    }

    @Test func recoveryReturnsToSilenceAndBack() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.showWhen = MenuBarShowWhen.yellowOrWorse.stored
        m.apply(deckState: redFixtureState)
        #expect(m.iconState == .health(provider: .claude, verdict: .red))
        m.apply(deckState: greenFixtureState)
        #expect(m.iconState == .plain)
    }

    @Test func percentageValueDoesNotGateHealthMode() {
        // A stale "below:…" left from percentage mode gates nothing here —
        // health mode shows always, exactly like the default.
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.showWhen = MenuBarShowWhen.belowPercent(25).stored
        m.apply(deckState: greenFixtureState)
        #expect(m.iconState == .health(provider: .claude, verdict: .green))
    }

    @Test func notificationPathStillSeesTheGlobalWorstWhileQuiet() {
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.healthSentinel(for: .claude)
        m.showWhen = MenuBarShowWhen.yellowOrWorse.stored
        var seenWorst: WorstRemaining??
        m.onStateUpdate = { worst, _ in seenWorst = worst }
        m.apply(deckState: greenFixtureState)
        #expect(seenWorst == WorstRemaining(
            percent: 4, accountId: "c2", scope: "5h",
            resetsAt: iso(hoursFromNow: 2), stale: false
        ))
    }
}

@Suite("Quiet mode gating — percentage (issue #238)")
@MainActor
struct MenuBarQuietPercentTests {
    private func model() -> MenuBarStatusModel {
        MenuBarStatusModel(evaluator: StubEvaluator(results: []), clock: { fixedNow })
    }

    /// One pinned account at the given percent plus a sibling at 4% —
    /// proving the gate reads the PINNED percent while notifications keep
    /// the global worst.
    private func state(pinnedPercent: Double) -> DeckState {
        DeckState(
            accounts: [
                DeckAccount(id: "c1", provider: "claude", label: "Studio", authState: "ok"),
                DeckAccount(id: "c2", provider: "claude", label: "Client", authState: "ok"),
            ],
            usage: [
                UsageSnapshot(
                    accountId: "c1", scope: "week", remainingPercent: pinnedPercent,
                    resetsAt: iso(hoursFromNow: 84), observedAt: iso(hoursFromNow: -0.01)
                ),
                UsageSnapshot(
                    accountId: "c2", scope: "5h", remainingPercent: 4,
                    resetsAt: iso(hoursFromNow: 2), observedAt: iso(hoursFromNow: -0.01)
                ),
            ]
        )
    }

    @Test func pinnedAccountHidesAboveTheThreshold() {
        let m = model()
        m.pinnedAccountId = "c1"
        m.showWhen = MenuBarShowWhen.belowPercent(30).stored
        m.apply(deckState: state(pinnedPercent: 50))
        #expect(m.iconState == .plain)
        // The pin is still in force: the account keeps the (empty) menu
        // bar slot, so the deck checkmark doesn't drift (#131 precedent).
        #expect(m.menuBarSourceAccountId == "c1")
        // Display-only: notifications still see the sibling's critical 4%.
        #expect(m.worstRemaining?.percent == 4)
    }

    @Test func pinnedAccountShowsBelowTheThreshold() {
        let m = model()
        m.pinnedAccountId = "c1"
        m.showWhen = MenuBarShowWhen.belowPercent(30).stored
        m.apply(deckState: state(pinnedPercent: 20))
        // Below the default 25% warning line too, so it renders gold.
        #expect(m.iconState == .warning(percentRemaining: 20))
    }

    @Test func pinnedAccountShowsNeutralBetweenWarningAndThreshold() {
        // Threshold above the warning line: 28% is visible (below 30) but
        // healthy (above 25) → the neutral pinned style, not gold.
        let m = model()
        m.pinnedAccountId = "c1"
        m.showWhen = MenuBarShowWhen.belowPercent(30).stored
        m.apply(deckState: state(pinnedPercent: 28))
        #expect(m.iconState == .pinned(percentRemaining: 28))
    }

    @Test func lowestAcrossHidesAboveAndShowsBelowTheThreshold() {
        let m = model()
        m.showWhen = MenuBarShowWhen.belowPercent(3).stored
        // Global worst is c2's 4% — at/above the 3% threshold: hidden,
        // even though the default behavior would show gold at 4%.
        m.apply(deckState: state(pinnedPercent: 80))
        #expect(m.iconState == .plain)
        m.showWhen = MenuBarShowWhen.belowPercent(10).stored
        #expect(m.iconState == .critical(percentRemaining: 4))
    }

    @Test func healthValueDoesNotGatePercentageMode() {
        // A stale "yellow" left from health mode gates nothing here.
        let m = model()
        m.pinnedAccountId = "c1"
        m.showWhen = MenuBarShowWhen.yellowOrWorse.stored
        m.apply(deckState: state(pinnedPercent: 80))
        #expect(m.iconState == .pinned(percentRemaining: 80))
    }

    @Test func defaultAlwaysKeepsExistingBehavior() {
        // The stored default (""): pinned percent shows continuously,
        // exactly the pre-#238 behavior.
        let m = model()
        m.pinnedAccountId = "c1"
        m.apply(deckState: state(pinnedPercent: 80))
        #expect(m.iconState == .pinned(percentRemaining: 80))
        m.pinnedAccountId = nil
        #expect(m.iconState == .critical(percentRemaining: 4))
    }

    @Test func noneModeStaysPlainRegardless() {
        // The "when" row is hidden for None in the UI; the model likewise
        // never lets a leftover quiet value resurrect a number.
        let m = model()
        m.pinnedAccountId = MenuBarPinResolver.noneSentinel
        m.showWhen = MenuBarShowWhen.belowPercent(99).stored
        m.apply(deckState: state(pinnedPercent: 2))
        #expect(m.iconState == .plain)
    }
}
