import AppKit
import SwiftUI
import ModelDeckMacCore

/// Issue #295: the floating deck's window — the SAME `DeckPopoverView` the
/// menu-bar popover hosts, in a plain AppKit window the user can park
/// anywhere. AppKit rather than a SwiftUI `Window` scene for three locked
/// requirements a scene makes awkward: position memory for free
/// (`setFrameAutosaveName`), reliable close detection (the delegate — the
/// red close button is the primary reattach path), and open-on-launch
/// restore when the mode persisted.
///
/// The window is deliberately NOT registered in `DeckWindowRegistry`: that
/// registry is the popover-dismissal choke point (#230), and Settings
/// fronting closes whatever is registered there — which must never reach a
/// deck the user chose to keep open (`DeckPopoverView` skips its capture
/// view in floating mode).
@MainActor
final class FloatingDeckWindowController: NSObject, NSWindowDelegate {
    private let model: FloatingDeckModel
    private let content: () -> AnyView
    private var window: NSWindow?

    static let frameAutosaveName = "ModelDeckFloatingDeck"

    init(model: FloatingDeckModel, content: @escaping () -> AnyView) {
        self.model = model
        self.content = content
    }

    /// Opens the window at its remembered position, or fronts the existing
    /// one. Activation is explicit: with the accessory activation policy a
    /// bare orderFront can land behind the frontmost app (the #45 Settings
    /// lesson). `activate: false` is the launch-restore path — the window
    /// reappears where it was without stealing focus from whatever the
    /// user is doing at login.
    func show(activate: Bool = true) {
        if let window {
            present(window, activate: activate)
            return
        }
        let window = Self.makeWindow(rootView: content())
        window.setFrameAutosaveName(Self.frameAutosaveName)
        window.delegate = self
        self.window = window
        present(window, activate: activate)
    }

    /// The floating deck's window, without the position memory and the
    /// delegate (so tests can host a deck in it without touching either).
    static func makeWindow(rootView: some View) -> NSWindow {
        let hosting = NSHostingController(rootView: rootView)
        let window = NSWindow(contentViewController: hosting)
        // Tim, 2026-09-27: on screen this automatic sizing raised the
        // window's minimum and maximum to an expanded deck's height but never
        // resized the window. `DeckHeightLimit` sizes it instead; turned
        // off after creation so the window opens at the deck's size.
        hosting.sizingOptions = []
        // Tim's decisions: draggable, closable, NOT resizable — the deck
        // sizes itself exactly like the popover, from the same
        // `DeckLayoutMetrics` derivation: single-column 420, and in column
        // mode 300 pt per rendered column plus chrome (two → 640, three →
        // 940 once decision 0035's Grok column is present). Miniaturizable
        // stays: minimizing a parked window is normal macOS behavior, and
        // forbidding it buys nothing.
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.title = FloatingDeckModel.windowTitle
        // Tim's decision: a NORMAL window among the others — never
        // always-on-top.
        window.level = .normal
        window.isReleasedWhenClosed = false
        window.isMovableByWindowBackground = true
        return window
    }

    private func present(_ window: NSWindow, activate: Bool) {
        if activate {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            window.orderFront(nil)
        }
    }

    /// The reattach path: closing runs through the same delegate as the red
    /// close button, so there is exactly one teardown.
    func close() {
        window?.close()
    }

    /// Tim, 2026-09-27: the window grows downward when a card expands. If
    /// that pushes its bottom below the screen's visible area, lift it so the
    /// whole deck stays in view (`DeckHeightLimit` keeps it short enough).
    func windowDidResize(_ notification: Notification) {
        guard let window, let visible = window.screen?.visibleFrame,
              window.frame.minY < visible.minY else { return }
        window.setFrameOrigin(NSPoint(x: window.frame.minX, y: visible.minY))
    }

    func windowWillClose(_ notification: Notification) {
        window?.delegate = nil
        window = nil
        // State only — `windowDidClose` is idempotent, so the close that a
        // reattach itself triggered is a harmless no-op here.
        model.windowDidClose()
    }
}

/// Issue #295: what the menu-bar popover shows while the deck is detached —
/// never a second live deck (one deck, two homes). Appearing also fronts
/// the floating window, so the menu bar click keeps meaning "show me the
/// deck"; the explicit buttons stay for discoverability and VoiceOver.
struct FloatingDeckPlaceholderView: View {
    @ObservedObject var model: FloatingDeckModel

    var body: some View {
        VStack(spacing: 10) {
            Text(FloatingDeckModel.placeholderTitle)
                .font(.system(size: 12, weight: .medium))
            HStack(spacing: 8) {
                Button(FloatingDeckModel.bringToFrontTitle) {
                    model.onDetach?()
                }
                .help("Bring the floating deck window to the front")
                Button(FloatingDeckModel.reattachTitle) {
                    model.reattach()
                }
                .help("Close the floating window and show the deck here again")
            }
        }
        .padding(16)
        .frame(width: 300)
        .onAppear { model.onDetach?() }
    }
}

/// Issue #295: the menu bar content switch — the live deck while attached,
/// the placeholder while the deck floats.
struct DeckMenuBarRootView<Deck: View>: View {
    @ObservedObject var floating: FloatingDeckModel
    @ViewBuilder let deck: () -> Deck

    var body: some View {
        if floating.isDetached {
            FloatingDeckPlaceholderView(model: floating)
        } else {
            deck()
        }
    }
}
