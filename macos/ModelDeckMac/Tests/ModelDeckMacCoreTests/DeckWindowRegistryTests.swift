import Foundation
import Testing
@testable import ModelDeckMacCore

/// Issue #230 (reopened): the v0.3.17 fix identified the deck popover by a
/// private class name observed on macOS 13–15 and silently no-opped on
/// macOS 26. The mechanism is now direct capture — the deck hierarchy
/// registers its own window here — and these tests pin the registry seam:
/// weak semantics, close routing, and the choke point's registry-first /
/// fallback-only-when-empty ordering.
@MainActor
@Suite("Issue #230 reopen — deck window registry")
struct DeckWindowRegistryTests {
    final class FakeWindow: DeckPopoverWindow {
        private(set) var closeCount = 0
        func close() { closeCount += 1 }
    }

    @Test("registered window is closed and reported")
    func closesRegisteredWindow() {
        let registry = DeckWindowRegistry()
        let window = FakeWindow()
        registry.register(window)
        #expect(registry.closeRegisteredWindow())
        #expect(window.closeCount == 1)
    }

    @Test("empty registry reports nothing to close")
    func emptyRegistryReportsFalse() {
        let registry = DeckWindowRegistry()
        #expect(registry.registeredWindow == nil)
        #expect(!registry.closeRegisteredWindow())
    }

    @Test("holds the window weakly — a deallocated window reads as empty")
    func weakReference() {
        let registry = DeckWindowRegistry()
        var window: FakeWindow? = FakeWindow()
        registry.register(window!)
        #expect(registry.registeredWindow != nil)
        window = nil
        // The registry must never extend the popover window's lifetime.
        #expect(registry.registeredWindow == nil)
        #expect(!registry.closeRegisteredWindow())
    }

    @Test("re-registration overwrites — only the latest window closes")
    func lastRegistrationWins() {
        let registry = DeckWindowRegistry()
        let first = FakeWindow()
        let second = FakeWindow()
        registry.register(first)
        registry.register(second)
        #expect(registry.closeRegisteredWindow())
        #expect(first.closeCount == 0)
        #expect(second.closeCount == 1)
    }

    @Test("choke point: a registered window closes and SKIPS the fallback")
    func chokePointPrefersRegistry() {
        let registry = DeckWindowRegistry()
        let window = FakeWindow()
        registry.register(window)
        var fallbackRuns = 0
        registry.closeDeckPopover { fallbackRuns += 1 }
        #expect(window.closeCount == 1)
        // A registered-and-closed deck must never fall through to a scan
        // that could misfire on a churned private class name.
        #expect(fallbackRuns == 0)
    }

    @Test("choke point: empty registry runs the class-name fallback scan")
    func chokePointFallsBackWhenEmpty() {
        let registry = DeckWindowRegistry()
        var fallbackRuns = 0
        registry.closeDeckPopover { fallbackRuns += 1 }
        #expect(fallbackRuns == 1)
    }

    @Test("choke point: a deallocated window also falls back to the scan")
    func chokePointFallsBackAfterDeallocation() {
        let registry = DeckWindowRegistry()
        var window: FakeWindow? = FakeWindow()
        registry.register(window!)
        window = nil
        var fallbackRuns = 0
        registry.closeDeckPopover { fallbackRuns += 1 }
        #expect(fallbackRuns == 1)
    }
}
