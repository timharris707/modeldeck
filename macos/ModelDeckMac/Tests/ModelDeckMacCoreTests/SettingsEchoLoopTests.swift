import Foundation
import Testing
@testable import ModelDeckMacCore

// Regression tests for the idle re-render loop (the "PR #68" report; the
// mechanism itself long predates it and reproduced identically at the
// parent commit).
//
// The loop: `settingsSync.onApply` used to assign `deckModel.layout` and
// `deckModel.sortOrder` directly. `layout`'s didSet fired
// `onSelectionChange(layout, sortOrder)` BEFORE the apply had updated
// `sortOrder`, so whenever the popover-local stored sort diverged from the
// daemon's `defaultSort` at launch, the stale local sort was pushed back to
// the daemon. The daemon confirmed it, the confirmed document re-applied and
// flipped `sortOrder` again, and the two values ping-ponged forever
// (~50-100 PUTs/sec) — a @Published storm that re-evaluated the App body
// continuously (22-48% idle CPU, flashing sort segments, shuffling deck
// rows, broken expanded cards).
//
// The fix: a daemon-confirmed document is applied through
// `DeckPopoverModel.adopt(confirmedLayout:confirmedSortOrder:)`, which never
// fires `onSelectionChange` — only USER selections sync back. Additionally,
// didSet only fires the callback when the value actually changed.
@Suite("Settings echo loop regression (#68 investigation)")
@MainActor
struct SettingsEchoLoopTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "echo-loop-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    // MARK: - DeckPopoverModel.adopt

    @Test func adoptingConfirmedSettingsNeverFiresSelectionChange() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        var fired: [(DeckLayout, DeckSortOrder)] = []
        model.onSelectionChange = { fired.append(($0, $1)) }

        // Both values genuinely change — the didSets run — yet nothing may
        // echo: the daemon already holds these values.
        model.adopt(confirmedLayout: .singleColumn, confirmedSortOrder: .lowestRemaining)

        #expect(model.layout == .singleColumn)
        #expect(model.sortOrder == .lowestRemaining)
        #expect(fired.isEmpty, "a daemon-confirmed document must never echo back")
    }

    @Test func adoptedValuesPersistLikeUserSelections() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.adopt(confirmedLayout: .singleColumn, confirmedSortOrder: .lowestRemaining)

        let second = DeckPopoverModel(defaults: defaults)
        #expect(second.layout == .singleColumn)
        #expect(second.sortOrder == .lowestRemaining)
    }

    @Test func adoptingNilSortLeavesProviderGroupingAlone() {
        // Issue #30: provider grouping is popover-local; the app passes nil
        // for the sort while it's active so a confirmed document can't snap
        // the user out of it.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.sortOrder = .provider
        var fired = 0
        model.onSelectionChange = { _, _ in fired += 1 }

        model.adopt(confirmedLayout: .twoColumn, confirmedSortOrder: nil)

        #expect(model.sortOrder == .provider)
        #expect(fired == 0)
    }

    // MARK: - User selections still sync

    @Test func userSelectionStillFiresSelectionChange() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        var fired: [(DeckLayout, DeckSortOrder)] = []
        model.onSelectionChange = { fired.append(($0, $1)) }

        model.sortOrder = .lowestRemaining

        #expect(fired.count == 1)
        #expect(fired.first?.1 == .lowestRemaining)

        model.layout = .singleColumn
        #expect(fired.count == 2)
        #expect(fired.last?.0 == .singleColumn)
    }

    @Test func reassigningTheSameValueDoesNotFire() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        var fired = 0
        model.onSelectionChange = { _, _ in fired += 1 }

        model.layout = model.layout
        model.sortOrder = model.sortOrder

        #expect(fired == 0, "no-change assignments must not spam the sync path")
    }

    @Test func userSelectionAfterAdoptStillSyncs() {
        // The suppression is scoped to the adopt call — it must not latch.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.adopt(confirmedLayout: .singleColumn, confirmedSortOrder: .lowestRemaining)
        var fired = 0
        model.onSelectionChange = { _, _ in fired += 1 }

        model.sortOrder = .nextReset

        #expect(fired == 1)
    }

    // MARK: - End-to-end: the exact launch sequence that looped

    /// Wires SettingsSyncModel and DeckPopoverModel exactly like
    /// ModelDeckMacApp does, seeds the divergence that used to start the
    /// loop (local sort ≠ daemon defaultSort), performs the launch-time
    /// load, and asserts the daemon sees ZERO pushes while the model adopts
    /// the daemon's value.
    @Test func launchTimeApplyWithDivergentSortNeverPushes() async {
        var document = DaemonSettings.defaults
        document.defaultSort = DeckSortOrder.lowestRemaining.rawValue
        let sync = StubSettingsSync(results: [.success(document)])
        let settingsSync = SettingsSyncModel(sync: sync)
        let deckModel = DeckPopoverModel(defaults: freshDefaults())
        #expect(deckModel.sortOrder == .nextReset, "seed: local sort diverges from the daemon document")

        // Mirror of ModelDeckMacApp.init's wiring.
        settingsSync.onApply = { [weak deckModel] settings in
            deckModel?.adopt(
                confirmedLayout: settings.deckLayout,
                confirmedSortOrder: deckModel?.sortOrder == .provider
                    ? nil
                    : settings.deckSortOrder
            )
        }
        deckModel.onSelectionChange = { [weak settingsSync] layout, sort in
            Task { @MainActor [weak settingsSync] in
                await settingsSync?.setLayout(layout)
                await settingsSync?.setDefaultSort(sort)
            }
        }

        await settingsSync.load()
        // Drain anything the wiring might have scheduled on the main actor.
        for _ in 0..<20 { await Task.yield() }

        #expect(deckModel.sortOrder == .lowestRemaining, "the daemon document is adopted")
        #expect(sync.pushedPatches.isEmpty,
                "a daemon-confirmed apply must never push back — this is the ping-pong seed")
    }
}
