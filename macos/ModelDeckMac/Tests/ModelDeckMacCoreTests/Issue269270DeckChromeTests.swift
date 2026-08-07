import Foundation
import Testing
@testable import ModelDeckMacCore

// Tim, 2026-08-06, two pieces of deck-chrome feedback on v0.3.22:
//
// #269 — "there should be a dismiss option next to it so that it doesn't sit
//         there and remain when it's no longer applicable once we've seen it."
// #270 — "the window glass transparency … a little too transparent. I would
//         like to see that transparency cut down some, maybe half of what it's
//         currently at."
//
// The #270 tests pin the two properties that actually matter and that a
// screenshot could not settle (MenuBarExtra popovers cannot be captured from a
// script): that `.clear` is EXACTLY the pre-#270 look, and that an existing
// install lands on the reduced default without touching anything.

private func freshDefaults(_ name: String) -> UserDefaults {
    let suite = "modeldeck-chrome-\(name)-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
}

@Suite("Deck glass (issue #270)")
@MainActor
struct DeckGlassTests {
    @Test func clearIsExactlyThePreIssueLook() {
        // The escape hatch has to be a true no-op: anything above zero would
        // mean the old appearance is no longer reachable.
        #expect(DeckGlass.clear.fillOpacity == 0)
    }

    @Test func theDefaultIsHalf() {
        // "maybe half of what it's currently at" — the whole ask.
        #expect(DeckGlass.default == .frosted)
        #expect(DeckGlass.frosted.fillOpacity == 0.5)
    }

    @Test func stepsIncreaseMonotonicallyAndStayInRange() {
        let steps = DeckGlass.allCases.map(\.fillOpacity)
        #expect(steps == steps.sorted())
        #expect(steps.allSatisfy { $0 >= 0 && $0 <= 1 })
        #expect(Set(steps).count == steps.count, "a duplicated step is a menu entry that does nothing")
        #expect(DeckGlass.solid.fillOpacity == 1, "the top step must be genuinely opaque")
    }

    @Test func everyStepIsNamedAndDistinct() {
        let titles = DeckGlass.allCases.map(\.title)
        #expect(titles.allSatisfy { !$0.isEmpty })
        #expect(Set(titles).count == titles.count)
    }

    @Test func anExistingInstallGetsTheReducedDefaultWithoutTouchingAnything() {
        // The upgrade path: no stored key, so no user has to find the menu.
        let model = DeckPopoverModel(defaults: freshDefaults("absent"))
        #expect(model.glass == .frosted)
    }

    @Test func theChoicePersists() {
        let defaults = freshDefaults("persist")
        let model = DeckPopoverModel(defaults: defaults)
        model.glass = .clear
        #expect(DeckPopoverModel(defaults: defaults).glass == .clear,
                "a user who wants the old look must not have to re-pick it every launch")
    }

    @Test func anUnreadableStoredValueFallsBackToTheDefault() {
        // A downgrade, a hand-edited plist, or a renamed case must not leave
        // the deck rendering an undefined background.
        let defaults = freshDefaults("garbage")
        defaults.set("chartreuse", forKey: DeckPopoverModel.glassDefaultsKey)
        #expect(DeckPopoverModel(defaults: defaults).glass == .frosted)
    }
}

// The #269 dismiss tests live in DaemonSetupTests.swift, alongside the
// file-private fakes that drive a real drift re-register.
