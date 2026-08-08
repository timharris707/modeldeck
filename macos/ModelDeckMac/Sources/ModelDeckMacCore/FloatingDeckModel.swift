import Foundation

/// Issue #295 (Tim, 2026-08-07): the deck can detach from the menu bar into
/// a floating desktop window — same view, same models, a different home.
///
/// This model owns only the MODE (attached vs detached) and its
/// persistence; the app target owns the actual `NSWindow` (creation, frame
/// autosave, close detection) and wires it through the two hooks. Decisions
/// locked with Tim:
/// - The menu bar click keeps today's popover; a detach control on it pops
///   the deck out. Default behavior unchanged.
/// - The floating window sits at NORMAL level (never always-on-top), is
///   draggable, not resizable, and remembers its position.
/// - Closing the window (its close button, or the popover's Reattach)
///   returns the menu bar to popover behavior.
/// - While detached the popover renders a small placeholder instead of a
///   second live deck — one deck, two homes, never both at once.
///
/// The mode persists across relaunches so a Sparkle self-update (#241)
/// can't silently snap a kept-open deck back into the menu bar.
@MainActor
public final class FloatingDeckModel: ObservableObject {
    static let defaultsKey = "modeldeck.deck.detached"

    /// Whether the deck currently lives in the floating window.
    @Published public private(set) var isDetached: Bool

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.isDetached = defaults.bool(forKey: Self.defaultsKey)
    }

    /// Fired on `detach()` and by the placeholder's Bring to Front — the
    /// app opens the floating window, or fronts the existing one.
    public var onDetach: (() -> Void)?
    /// Fired on `reattach()` — the app closes the floating window if open.
    public var onReattach: (() -> Void)?

    /// The popover's detach control: flip the mode, then let the app open
    /// the window.
    public func detach() {
        setDetached(true)
        onDetach?()
    }

    /// The placeholder's explicit reattach: flip the mode, then let the app
    /// close the window.
    public func reattach() {
        setDetached(false)
        onReattach?()
    }

    /// The window-close path (red close button, or the reattach close
    /// arriving at the delegate): state only — the window is already going
    /// away, so no `onReattach` echo. Idempotent, so the reattach flow's
    /// delegate callback is a harmless no-op.
    public func windowDidClose() {
        setDetached(false)
    }

    private func setDetached(_ value: Bool) {
        guard isDetached != value else { return }
        isDetached = value
        defaults.set(value, forKey: Self.defaultsKey)
    }

    // MARK: - Copy (pinned by tests; the views render these verbatim)

    /// The floating window's title.
    public static let windowTitle = "ModelDeck"
    /// What the popover shows instead of a second live deck.
    public static let placeholderTitle = "The deck is floating on your desktop."
    public static let bringToFrontTitle = "Bring to Front"
    public static let reattachTitle = "Reattach to Menu Bar"
    /// Issue #315: the detach control renders as a bare footer glyph (the
    /// #283 rule), whose tooltip leads with the button's NAME — this is it.
    public static let detachName = "Float the deck"
    /// The detach control's tooltip — states the whole contract, including
    /// the way back.
    public static let detachHelp = "Move the deck into a floating window that "
        + "stays open on your desktop. It sits among your other windows and "
        + "remembers its position; closing it brings the deck back here."
    public static let detachAccessibilityLabel = "Float the deck in its own window"
}
