import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #302 — header info-space notices are dismissible, and dismissal
// persists. Tim: "anything that gets put into that space, I would like it
// to be dismissible. We don't need the extra noise again." Per-KIND
// dismissal (DeckHeaderNotice), stored in app-local UserDefaults like every
// other popover view preference (the #73 pattern).

@Suite("Header notice dismissal (issue #302)")
@MainActor
struct HeaderNoticeDismissalTests {
    private func freshSuite() -> String {
        "issue302-tests-\(UUID().uuidString)"
    }

    private func model(suite: String) -> DeckPopoverModel {
        DeckPopoverModel(defaults: UserDefaults(suiteName: suite)!)
    }

    @Test func nothingIsDismissedByDefault() {
        let model = model(suite: freshSuite())
        for notice in DeckPopoverModel.DeckHeaderNotice.allCases {
            #expect(!model.isHeaderNoticeDismissed(notice))
        }
    }

    @Test func dismissingHidesTheNotice() {
        let model = model(suite: freshSuite())
        model.dismissHeaderNotice(.menuBarSource)
        #expect(model.isHeaderNoticeDismissed(.menuBarSource))
    }

    @Test func dismissalPersistsAcrossModelInstances() {
        let suite = freshSuite()
        model(suite: suite).dismissHeaderNotice(.menuBarSource)
        // A fresh model over the same store — the app-relaunch shape.
        #expect(model(suite: suite).isHeaderNoticeDismissed(.menuBarSource))
    }

    @Test func dismissingTwiceIsIdempotent() {
        let suite = freshSuite()
        let model = model(suite: suite)
        model.dismissHeaderNotice(.menuBarSource)
        model.dismissHeaderNotice(.menuBarSource)
        let stored = UserDefaults(suiteName: suite)!
            .stringArray(forKey: DeckPopoverModel.dismissedHeaderNoticesDefaultsKey)
        #expect(stored == ["menuBarSource"])
    }

    @Test func unrecognizedStoredKindsAreDroppedNotResurrected() {
        // A downgrade or hand-edited plist: unknown raw values must neither
        // crash the load nor surface as some other notice's dismissal.
        let suite = freshSuite()
        UserDefaults(suiteName: suite)!.set(
            ["menuBarSource", "someFutureNotice"],
            forKey: DeckPopoverModel.dismissedHeaderNoticesDefaultsKey
        )
        let model = model(suite: suite)
        #expect(model.isHeaderNoticeDismissed(.menuBarSource))
        #expect(model.dismissedHeaderNotices.count == 1)
    }

    @Test func rawValuesAreThePersistenceContract() {
        // Renaming a case's raw value would silently resurrect every
        // dismissed notice on upgrade — pin the format.
        #expect(DeckPopoverModel.DeckHeaderNotice.menuBarSource.rawValue == "menuBarSource")
    }
}
