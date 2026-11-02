import AppKit
import SwiftUI
import Testing
import ModelDeckMacCore
@testable import ModelDeckMac

/// Issue #784: the deck header's "Remote pool" label, rendered for real in an
/// offscreen window that is never ordered front (the #719 precedent). Remote
/// role shows it; host role renders nothing, so today's header is unchanged.
/// Its placement and spoken name are pinned at source level in
/// Issue784ProxyRoleTests: offscreen, SwiftUI builds no accessibility tree
/// without an assistive client to ask for one.
@MainActor
struct Issue784RemotePoolLabelTests {
    private func fittingSize(_ role: ProxyRole) -> NSSize {
        let header = ProxyRoleCopy.remotePoolHeader(role: role, hub: nil)
        let view = NSHostingView(rootView: RemotePoolHeaderLabel(header: header))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 200, height: 40),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = view
        view.layoutSubtreeIfNeeded()
        return withExtendedLifetime(window) { view.fittingSize }
    }

    @Test func remoteRoleRendersTheLabel() {
        let size = fittingSize(.remote)
        #expect(size.width > 0)
        #expect(size.height > 0)
    }

    @Test func hostRoleRendersNothing() {
        #expect(fittingSize(.host) == .zero)
    }
}
