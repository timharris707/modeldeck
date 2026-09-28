import AppKit
import SwiftUI
import Testing
import ModelDeckMacCore
@testable import ModelDeckMac

/// Issue #719 tripwire. 1.1.17 measured the deck with a GeometryReader
/// preference that, on macOS 27, reported 0 once and never again, so hidden
/// cards left the deck centered in a too-tall window. A source-text check
/// passed the whole time. This hosts the real `DeckWindowFitting` modifier
/// in an offscreen window (never ordered front) and fails if a content
/// change stops reaching the registry.
@MainActor
struct DeckWindowFittingTests {
    final class Rows: ObservableObject { @Published var count = 4 }

    struct Probe: View {
        @ObservedObject var rows: Rows
        let isEnabled: Bool
        let registry: DeckWindowRegistry

        var body: some View {
            VStack(spacing: 0) {
                ForEach(0..<rows.count, id: \.self) { _ in Color.clear.frame(height: 50) }
            }
            .frame(width: 200)
            .modifier(DeckWindowFitting(isEnabled: isEnabled, registry: registry))
        }
    }

    final class RecordingWindow: DeckPopoverWindow {
        var deckContentHeight: CGFloat = 1000
        var fits: [CGFloat] = []
        func close() {}
        func fitContentHeight(_ height: CGFloat) {
            fits.append(height)
            deckContentHeight = height
        }
    }

    private func host(_ view: some View) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 200, height: 1000),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = NSHostingView(rootView: view)
        return window
    }

    private func settle(_ window: NSWindow) {
        for _ in 0..<5 {
            window.contentView?.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
    }

    @Test func contentChangesReachTheWindowFit() {
        let registry = DeckWindowRegistry()
        let recorder = RecordingWindow()
        registry.register(recorder)
        let rows = Rows()
        let window = host(Probe(rows: rows, isEnabled: true, registry: registry))
        settle(window)
        #expect(recorder.fits.last == 200)

        rows.count = 1
        settle(window)
        #expect(recorder.fits.last == 50)
    }

    @Test func floatingDeckIsNeverFitted() {
        let registry = DeckWindowRegistry()
        let recorder = RecordingWindow()
        registry.register(recorder)
        let rows = Rows()
        let window = host(Probe(rows: rows, isEnabled: false, registry: registry))
        settle(window)
        rows.count = 1
        settle(window)
        #expect(recorder.fits.isEmpty)
    }

    @Test func menuBarDeckAppliesTheFittingAfterItsWidth() throws {
        let package = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: package.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
        let padding = try #require(source.range(of: ".padding(14)"))
        let width = try #require(source.range(of: ".frame(width: deckWidth)", range: padding.upperBound..<source.endIndex))
        let limit = try #require(source.range(of: ".modifier(DeckHeightLimit())"))
        let fitting = try #require(source.range(of: ".modifier(DeckWindowFitting(isEnabled: !isFloating))"))
        #expect(width.upperBound <= limit.lowerBound)
        #expect(limit.upperBound <= fitting.lowerBound)
        #expect(source.contains("DeckCardScroller { content }"))
    }

    // MARK: - Tim, 2026-09-27: floating deck cut off when a card expands

    final class Edges { var top = CGFloat.nan, bottom = CGFloat.nan, lastRow = CGFloat.nan }

    /// Deck-shaped: fixed header and footer around the real card scroller,
    /// with wrapping text like the real deck's.
    struct DeckProbe: View {
        @ObservedObject var rows: Rows
        let edges: Edges
        var fitting = DeckWindowFitting(isEnabled: false)

        var body: some View {
            VStack(spacing: 10) {
                Color.clear.frame(height: 20)
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { edges.top = $0 }
                DeckCardScroller {
                    VStack(spacing: 0) {
                        Text(String(repeating: "Wrapping card text. ", count: 12))
                        ForEach(0..<rows.count, id: \.self) { index in
                            Color.clear.frame(height: 50)
                                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: {
                                    if index == rows.count - 1 { edges.lastRow = $0 }
                                }
                        }
                    }
                }
                Color.clear.frame(height: 20)
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { edges.bottom = $0 }
            }
            .padding(14)
            .frame(width: 300)
            .modifier(DeckHeightLimit())
            .modifier(fitting)
        }
    }

    /// The real floating deck window, never ordered front. Its automatic
    /// sizing is off, as in the app: offscreen it resized with the deck, on
    /// screen it did not, so these tests only pass if the deck sizes it.
    private func floatingHost(_ view: some View) -> NSWindow {
        FloatingDeckWindowController.makeWindow(rootView: view)
    }

    private func contentHeight(_ window: NSWindow) -> CGFloat {
        window.contentRect(forFrameRect: window.frame).height
    }

    /// `.global` here runs from the window's top edge, title bar included.
    private func expectFullyVisible(_ edges: Edges, in window: NSWindow) {
        #expect(edges.top >= window.frame.height - contentHeight(window))
        #expect(edges.bottom <= window.frame.height)
    }

    /// On screen, the hosting controller's automatic sizing left the window
    /// at its old height (Mac mini, macOS 27); offscreen it works, so the
    /// tests below could not see that failure come back. Keep it off.
    @Test func floatingWindowLeavesSizingToTheDeck() throws {
        let window = floatingHost(EmptyView())
        let hosting = try #require(window.contentViewController as? NSHostingController<EmptyView>)
        #expect(hosting.sizingOptions.isEmpty)
    }

    /// CodeRabbit on PR #739: the deck sizes the window it lives in, so it
    /// must not keep that window alive, or every closed floating window
    /// stays in memory with a live deck inside.
    @Test func closedFloatingWindowIsReleased() {
        weak var released: NSWindow?
        autoreleasepool {
            let window = floatingHost(DeckProbe(rows: Rows(), edges: Edges()))
            settle(window)
            released = window
            window.close()
        }
        for _ in 0..<5 { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        #expect(released == nil)
    }

    @Test func floatingWindowGrowsToShowExpandedCards() {
        let rows = Rows()
        let edges = Edges()
        let window = floatingHost(DeckProbe(rows: rows, edges: edges))
        settle(window)
        let collapsed = contentHeight(window)

        rows.count = 12
        settle(window)
        #expect(contentHeight(window) - collapsed == 400)
        expectFullyVisible(edges, in: window)

        rows.count = 4
        settle(window)
        #expect(contentHeight(window) == collapsed)
    }

    @Test func deckTallerThanTheScreenScrollsInsideIt() throws {
        let rows = Rows()
        let edges = Edges()
        let window = floatingHost(DeckProbe(rows: rows, edges: edges))
        settle(window)
        rows.count = 400
        settle(window)
        let screen = try #require(window.screen ?? NSScreen.main)
        #expect(window.frame.height <= screen.visibleFrame.height)
        expectFullyVisible(edges, in: window)

        // The last card starts below the window and scrolls into view.
        #expect(edges.lastRow > window.frame.height)
        let content = try #require(window.contentView)
        let scroller = try #require(scrollView(in: content))
        let document = try #require(scroller.documentView)
        let bottom = document.isFlipped ? document.frame.height - scroller.contentView.bounds.height : 0
        scroller.contentView.scroll(to: NSPoint(x: 0, y: bottom))
        scroller.reflectScrolledClipView(scroller.contentView)
        settle(window)
        #expect(edges.lastRow <= edges.bottom)
        expectFullyVisible(edges, in: window)
    }

    private func scrollView(in view: NSView) -> NSScrollView? {
        if let scroller = view as? NSScrollView { return scroller }
        return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
    }

    /// The menu-bar window stayed at its opening height on screen while
    /// cards expanded. A hosting view with its automatic sizing off stands in
    /// for it here (offscreen, the automatic sizing would hide the failure).
    @Test func menuBarWindowFollowsTheDeckBothWays() {
        let rows = Rows()
        let edges = Edges()
        let hosting = NSHostingView(rootView: DeckProbe(rows: rows, edges: edges))
        hosting.sizingOptions = []
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 1000),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = hosting
        settle(window)
        let top = window.frame.maxY
        let collapsed = contentHeight(window)
        #expect(collapsed < 1000)

        rows.count = 12
        settle(window)
        #expect(contentHeight(window) - collapsed == 400)
        #expect(window.frame.maxY == top)
        expectFullyVisible(edges, in: window)

        rows.count = 4
        settle(window)
        #expect(contentHeight(window) == collapsed)
    }

    /// Issue #719 interplay: the card scroller is flexible, so without the
    /// height pin the menu-bar deck would fill its stale window and the fit
    /// would never see it shrink.
    @Test func menuBarFitStillSeesTheDeckShrinkAroundTheScroller() {
        let registry = DeckWindowRegistry()
        let recorder = RecordingWindow()
        registry.register(recorder)
        let rows = Rows()
        let window = host(DeckProbe(
            rows: rows, edges: Edges(),
            fitting: DeckWindowFitting(isEnabled: true, registry: registry)
        ))
        settle(window)
        let expanded = recorder.fits.last

        rows.count = 1
        settle(window)
        #expect(expanded.map { $0 - (recorder.fits.last ?? 0) } == 150)
    }
}
