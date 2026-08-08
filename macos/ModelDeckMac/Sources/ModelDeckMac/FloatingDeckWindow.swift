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
        let hosting = NSHostingController(rootView: content())
        let window = NSWindow(contentViewController: hosting)
        // Tim's decisions: draggable, closable, NOT resizable — the deck
        // sizes itself (two-column 640 / single 420) exactly like the
        // popover. Miniaturizable stays: minimizing a parked window is
        // normal macOS behavior, and forbidding it buys nothing.
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.title = FloatingDeckModel.windowTitle
        // Tim's decision: a NORMAL window among the others — never
        // always-on-top.
        window.level = .normal
        window.isReleasedWhenClosed = false
        window.isMovableByWindowBackground = true
        window.setFrameAutosaveName(Self.frameAutosaveName)
        window.delegate = self
        self.window = window
        present(window, activate: activate)
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
