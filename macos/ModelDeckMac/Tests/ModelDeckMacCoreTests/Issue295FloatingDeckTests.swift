import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #295 (Tim, 2026-08-07): the deck can detach from the menu bar into
// a floating desktop window. Core owns the MODE and its persistence; these
// tests lock the state machine (detach / reattach / window-closed), the
// hook firing, the relaunch persistence, and the copy the views render
// verbatim.

@Suite("Floating deck mode (issue #295)")
@MainActor
struct FloatingDeckModelTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "floating-deck-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test func startsAttachedAndDetachFiresTheOpenHook() {
        let model = FloatingDeckModel(defaults: freshDefaults())
        #expect(model.isDetached == false)
        var opened = 0
        model.onDetach = { opened += 1 }
        model.detach()
        #expect(model.isDetached == true)
        #expect(opened == 1)
    }

    @Test func reattachFiresTheCloseHookOnceAndTheDelegateEchoIsANoOp() {
        let model = FloatingDeckModel(defaults: freshDefaults())
        model.detach()
        var closed = 0
        model.onReattach = { closed += 1 }
        model.reattach()
        #expect(model.isDetached == false)
        #expect(closed == 1)
        // The controller's close runs through the window delegate, which
        // calls windowDidClose — already-attached, so nothing changes and
        // no hook fires again.
        model.windowDidClose()
        #expect(model.isDetached == false)
        #expect(closed == 1)
    }

    @Test func theRedCloseButtonReattachesWithoutAnEcho() {
        let model = FloatingDeckModel(defaults: freshDefaults())
        model.detach()
        var closed = 0
        model.onReattach = { closed += 1 }
        // The user closes the window directly: state flips, but the window
        // is already going away — the close hook must NOT fire (it would
        // close a window mid-close).
        model.windowDidClose()
        #expect(model.isDetached == false)
        #expect(closed == 0)
    }

    @Test func theModeSurvivesARelaunch() {
        let defaults = freshDefaults()
        FloatingDeckModel(defaults: defaults).detach()
        // A fresh model over the same defaults — the relaunch (including a
        // Sparkle self-update) comes back floating.
        #expect(FloatingDeckModel(defaults: defaults).isDetached == true)
        FloatingDeckModel(defaults: defaults).reattach()
        #expect(FloatingDeckModel(defaults: defaults).isDetached == false)
    }

    @Test func copyIsPinned() {
        // The views render these verbatim; the detach tooltip must state
        // the whole contract including the way back.
        #expect(FloatingDeckModel.windowTitle == "ModelDeck")
        #expect(FloatingDeckModel.placeholderTitle == "The deck is floating on your desktop.")
        #expect(FloatingDeckModel.bringToFrontTitle == "Bring to Front")
        #expect(FloatingDeckModel.reattachTitle == "Reattach to Menu Bar")
        #expect(FloatingDeckModel.detachHelp.contains("closing it brings the deck back"))
        #expect(FloatingDeckModel.detachAccessibilityLabel == "Float the deck in its own window")
    }
}
