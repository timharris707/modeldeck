import Foundation

/// Issue #230 (reopened): the abstract shape of "the deck popover's own
/// window" — the one operation the dismissal choke point needs. `NSWindow`
/// satisfies it verbatim (an empty conformance in the app target); tests
/// inject fakes. `close()` (never a bare `orderOut`) is the contract because
/// SwiftUI's presentation state must reset so the next status-item click
/// reopens the deck first try (the PR #231 lesson).
/// Main-actor isolated to match AppKit: `NSWindow.close()` is `@MainActor`,
/// and windows are only ever touched there.
@MainActor
public protocol DeckPopoverWindow: AnyObject {
    func close()
}

/// Issue #230 (reopened, Tim's 2026-08-04 field report on v0.3.17): the
/// shipped fix identified the deck window by suffix-matching the private
/// class name `MenuBarExtraWindow` — observed on macOS 13–15, evidently
/// different on macOS 26, so `closeDeckPopover()` silently no-opped and
/// Settings (and the update dialog) still came up occluded behind the
/// status-level deck panel.
///
/// This registry removes the guesswork: a tiny window-accessor view INSIDE
/// the deck's own hierarchy registers the popover's `NSWindow` the moment
/// SwiftUI hosts it (`viewDidMoveToWindow`), so dismissal closes THE window
/// we were handed — deterministic on every macOS version, zero private-API
/// assumptions. The reference is weak: the registry must never extend the
/// window's lifetime, and a deallocated window simply reads as "nothing
/// registered".
///
/// The pre-existing class-name matcher (`DeckPopoverWindowMatcher`) survives
/// strictly as the FALLBACK for the never-registered case (deck never
/// opened this session, or a future SwiftUI rehost that skips the accessor)
/// — see `closeDeckPopover(fallbackScan:)`.
@MainActor
public final class DeckWindowRegistry {
    public static let shared = DeckWindowRegistry()

    /// Weak on purpose (see type doc). At most one deck window exists per
    /// process — MenuBarExtra is a single scene — so a single slot, with
    /// re-registration simply overwriting, is the honest model.
    private weak var window: DeckPopoverWindow?

    public init() {}

    /// Called from the deck hierarchy's window accessor whenever the content
    /// lands in a(nother) window. Last registration wins.
    public func register(_ window: DeckPopoverWindow) {
        self.window = window
    }

    /// The currently registered (still-alive) deck window, if any.
    public var registeredWindow: DeckPopoverWindow? { window }

    /// Closes the registered deck window. Returns whether a live window was
    /// there to close — the choke point uses this to decide whether the
    /// class-name fallback still needs to run.
    @discardableResult
    public func closeRegisteredWindow() -> Bool {
        guard let window else { return false }
        window.close()
        return true
    }

    /// Issue #230 (reopened): THE deck-dismissal choke point, Core-side so
    /// the ordering is unit-tested. Registry first — the directly captured
    /// window, correct on every macOS — and the caller-supplied class-name
    /// scan ONLY when nothing was ever registered (belt and suspenders for
    /// the never-appeared case; a registered-and-closed deck must never fall
    /// through to a scan that could misfire on a churned private name).
    public func closeDeckPopover(fallbackScan: () -> Void) {
        if closeRegisteredWindow() { return }
        fallbackScan()
    }
}
