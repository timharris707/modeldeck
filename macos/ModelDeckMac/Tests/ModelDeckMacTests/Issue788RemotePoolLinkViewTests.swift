import AppKit
import SwiftUI
import Testing
import ModelDeckMacCore
@testable import ModelDeckMac

/// Issue #788: the header's "Remote pool" label as a link to the pool host's
/// usage page, rendered for real in an offscreen window that is never ordered
/// front (the #719 precedent). Copy, guard and spoken label are pinned in
/// Core (Issue788RemotePoolHubTests); these pin what the view draws.
@MainActor
struct Issue788RemotePoolLinkViewTests {
    private final class Width { var value = CGFloat.nan }

    /// A page that answered `answeredAgo` seconds before now. The view words
    /// the age from its own timeline, so the stamp is taken from the clock.
    private static func hub(url: String = "http://studio:3871", answeredAgo: TimeInterval) -> DeckProxyHub {
        let stamp = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-answeredAgo))
        return DeckProxyHub(url: url, lastAttemptAt: stamp, lastAnsweredAt: stamp, lastReadOk: true)
    }

    private static func header(_ role: ProxyRole, _ hub: DeckProxyHub?) -> RemotePoolHeader? {
        ProxyRoleCopy.remotePoolHeader(role: role, hub: hub)
    }

    /// The width the label takes when offered `offered` points, or all it
    /// wants when nil.
    private func width(_ header: RemotePoolHeader?, offered: CGFloat? = nil) -> CGFloat {
        let width = Width()
        let label = RemotePoolHeaderLabel(header: header)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width.value = $0 }
        let root = offered.map { AnyView(label.frame(width: $0, alignment: .leading)) } ?? AnyView(label.fixedSize())
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 40),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = NSHostingView(rootView: root)
        for _ in 0..<3 {
            window.contentView?.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        return withExtendedLifetime(window) { width.value }
    }

    private func fittingSize(_ header: RemotePoolHeader?) -> NSSize {
        let view = NSHostingView(rootView: RemotePoolHeaderLabel(header: header))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 40),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = view
        view.layoutSubtreeIfNeeded()
        return withExtendedLifetime(window) { view.fittingSize }
    }

    @Test func hostRoleRendersNothingEvenWithAHub() {
        #expect(fittingSize(Self.header(.host, Self.hub(answeredAgo: 60))) == .zero)
    }

    /// No page, or one this Mac may not open, is #784's label: the words
    /// alone, the same size as a link whose page has neither answered nor
    /// failed yet.
    @Test func remoteWithoutAnOpenablePageIsTheLabelAlone() {
        let plain = fittingSize(Self.header(.remote, nil))
        #expect(plain.width > 0)
        #expect(fittingSize(Self.header(.remote, Self.hub(url: "javascript:alert(1)", answeredAgo: 60))) == plain)
        let unasked = DeckProxyHub(url: "http://studio:3871")
        #expect(width(.link(page: URL(string: unasked.url)!, hub: unasked)) == width(.label))
    }

    @Test func theFreshnessFollowsTheLabelWhenThereIsRoom() {
        let label = width(.label)
        let link = width(Self.header(.remote, Self.hub(answeredAgo: 3 * 60)))
        // "answered 3 min ago" at 10 pt is far wider than 20 pt.
        #expect(link > label + 20)
        #expect(width(Self.header(.remote, Self.hub(answeredAgo: 3 * 60)), offered: 400) == link)
    }

    /// The single-column deck has no room for the freshness: it drops from
    /// view and the label keeps its full width rather than truncating.
    @Test func aNarrowHeaderDropsTheFreshnessAndKeepsTheLabel() {
        let label = width(.label)
        let link = Self.header(.remote, Self.hub(answeredAgo: 3 * 60))
        #expect(width(link, offered: label + 10) == label)
    }
}
