import AppKit
import ModelDeckMacCore
import SwiftUI

/// Issue #230 (reopened): `NSWindow` already speaks the registry's whole
/// contract (`close()` resets SwiftUI presentation state, unlike a bare
/// `orderOut` — the PR #231 lesson), so the conformance is empty.
extension NSWindow: DeckPopoverWindow {}

/// Issue #230 (reopened): the deck's window accessor — a zero-size,
/// hit-test-inert NSView planted in `DeckPopoverView`'s background whose one
/// job is to hand the popover's own `NSWindow` to `DeckWindowRegistry` the
/// moment SwiftUI hosts the deck (`viewDidMoveToWindow`). Dismissal then
/// closes THE captured window instead of guessing private AppKit class names
/// (`MenuBarExtraWindow` matched macOS 13–15 but not Tim's macOS 26, which
/// is exactly how the v0.3.17 fix shipped broken).
struct DeckWindowCaptureView: NSViewRepresentable {
    final class CaptureView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // nil window = leaving the hierarchy (popover tear-down); keep
            // the last registration — the weak slot dies with the window.
            guard let window else { return }
            DeckWindowRegistry.shared.register(window)
            // Field evidence for occlusion reports (#230 reopen): the
            // runtime class name of the deck's host window on THIS macOS,
            // via the existing env-gated debug channel.
            IconDebugLog.log(
                "deck window captured: class=\(window.className) frame=\(window.frame)"
            )
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> CaptureView { CaptureView() }
    func updateNSView(_ nsView: CaptureView, context: Context) {}
}
