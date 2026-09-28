import AppKit
import ModelDeckMacCore
import SwiftUI

/// Issue #230 (reopened): `NSWindow` speaks the registry's close contract;
/// issue #719 adds the shrink-only fit operation for the menu-bar window.
extension NSWindow: DeckPopoverWindow {
    public var deckContentHeight: CGFloat { contentRect(forFrameRect: frame).height }

    public func fitContentHeight(_ height: CGFloat) {
        // CodeRabbit (PR #720): `height` is CONTENT height; the frame may
        // carry chrome, so convert before sizing or the content gets clipped.
        var content = contentRect(forFrameRect: frame)
        content.size.height = height
        var next = frameRect(forContentRect: content)
        next.origin.y = frame.maxY - next.height
        setFrame(next, display: true, animate: false)
    }
}

/// Issue #719: reports the deck's laid-out height to the registry, which
/// shrinks the captured menu-bar window when it is taller than that. Uses
/// `onGeometryChange`: on macOS 27 the 1.1.17 GeometryReader preference
/// reported 0 once and never again, so the fit never ran. The deck view
/// stays alive while closed, so a hide made in Settings fits the window
/// before the next open.
struct DeckWindowFitting: ViewModifier {
    let isEnabled: Bool
    var registry: DeckWindowRegistry = .shared

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
            guard isEnabled else { return }
            registry.fitContentHeight(height)
        }
    }
}

/// Tim, 2026-09-27: expanding cards cut the deck off at top and bottom with
/// no way to scroll, and collapsing them left blank bands. This pins the deck
/// to its full height (wrapping text otherwise lets SwiftUI report a squeezed
/// one), caps it at what its screen can show, past which `DeckCardScroller`
/// scrolls, and sizes the deck's window to it both ways, top edge fixed.
///
/// Checked on the Mac mini's real screen (macOS 27): neither window followed
/// the deck on its own. The floating window's hosting controller raised the
/// window's minimum and maximum to the expanded height and left the frame
/// where it was, and the menu-bar window stayed at its opening height.
/// Offscreen windows do resize themselves, which is how the first version of
/// this fix passed its tests and failed on screen. Apply before
/// `DeckWindowFitting`, which must measure the pinned height.
struct DeckHeightLimit: ViewModifier {
    /// Weak, like `DeckWindowRegistry`: the deck lives inside this window,
    /// so a strong reference would keep a closed floating window (and its
    /// live deck) around forever.
    final class HostWindow { weak var window: NSWindow? }

    @State private var limit: CGFloat = .infinity
    @State private var host = HostWindow()
    @State private var size: CGSize = .zero

    func body(content: Content) -> some View {
        content
            .frame(maxHeight: limit)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { newSize in
                size = newSize
                fit(host.window, to: newSize)
            }
            .background(DeckScreenHeightReader { newWindow, newLimit in
                host.window = newWindow
                limit = newLimit
                fit(newWindow, to: size)
            })
    }

    private func fit(_ window: NSWindow?, to size: CGSize) {
        guard let window, size.width > 0, size.height > 0 else { return }
        var content = window.contentRect(forFrameRect: window.frame)
        guard abs(content.width - size.width) > 0.5 || abs(content.height - size.height) > 0.5 else { return }
        content.size = size
        var next = window.frameRect(forContentRect: content)
        next.origin.y = window.frame.maxY - next.height
        window.setFrame(next, display: true, animate: false)
    }
}

/// The deck's card area: scrolls once `DeckHeightLimit` caps the deck, and
/// lays out exactly like unwrapped content until then. The scroll view
/// reaches past the deck's padding and insets its content by the same
/// amount, so the card change glow (7 pt shadow) is not clipped.
struct DeckCardScroller<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            content
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
        }
        .scrollBounceBehavior(.basedOnSize)
        .padding(.horizontal, -14)
        .padding(.vertical, -7)
    }
}

/// Reports the deck's window and `DeckWindowSizing.maxContentHeight` for
/// the screen it is on, again whenever the window moves to another screen or
/// the screen's usable area changes (resolution, Dock size).
struct DeckScreenHeightReader: NSViewRepresentable {
    let onChange: @MainActor (NSWindow, CGFloat) -> Void

    final class ReaderView: NSView {
        var onChange: (@MainActor (NSWindow, CGFloat) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self)
            guard let window else { return }
            NotificationCenter.default.addObserver(
                self, selector: #selector(report),
                name: NSWindow.didChangeScreenNotification, object: window
            )
            NotificationCenter.default.addObserver(
                self, selector: #selector(report),
                name: NSApplication.didChangeScreenParametersNotification, object: nil
            )
            report()
        }

        @objc private func report() {
            guard let window, let screen = window.screen ?? NSScreen.main else { return }
            let chrome = window.frame.height - window.contentRect(forFrameRect: window.frame).height
            let limit = DeckWindowSizing.maxContentHeight(
                visibleHeight: screen.visibleFrame.height, chrome: chrome
            )
            // Called during SwiftUI's own update, so the state change waits
            // a run-loop turn (which nested run loops also service).
            RunLoop.main.perform { [weak self] in
                MainActor.assumeIsolated { self?.onChange?(window, limit) }
            }
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ nsView: ReaderView, context: Context) {
        nsView.onChange = onChange
    }
}

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
