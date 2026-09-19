import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #675 — every user-initiated "check for updates" click goes through
// explicitCheck().
//
// Issue #170 established why: plain check() no-ops while a check is already
// in flight, so a click that raced the background check produced no feedback
// at all. The gear menu and the status-item context menu were fixed then;
// Settings → General was missed and kept calling check() until this issue.
// The click surfaces live in the app target, which has no test target of its
// own, so this reads them as text — the same shape as the #614 tripwire.

private let clickSurfaces = [
    "Sources/ModelDeckMac/SettingsWindowView.swift",
    "Sources/ModelDeckMac/DeckPopoverView.swift",
    "Sources/ModelDeckMac/MenuBarContextMenuController.swift",
]

@Suite("Issue #675: update clicks route through explicitCheck")
struct Issue675ExplicitCheckTripwireTests {
    @Test("every click surface asks for an explicit check")
    func everyClickSurfaceUsesExplicitCheck() throws {
        for path in clickSurfaces {
            let source = try appSource(path)
            #expect(source.contains("appUpdateModel.explicitCheck()"),
                    "TRIPWIRE explicit-update-check: \(path) has no explicit check call")
            #expect(!source.contains("appUpdateModel.check()"),
                    "TRIPWIRE explicit-update-check: \(path) calls check(), which drops a click that races the background check")
        }
    }

    /// The background scheduler is the one caller that SHOULD stay on the
    /// quiet check() — it has no click to answer. Reading it here keeps the
    /// rule above from being read as "check() is banned".
    @Test("the background scheduler keeps the quiet check")
    func backgroundSchedulerStillUsesCheck() throws {
        let core = try appSource("Sources/ModelDeckMacCore/AppUpdate.swift")
        #expect(core.contains("await model.check()"))
    }

    private func appSource(_ relativePath: String) throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent(relativePath),
            encoding: .utf8
        )
    }
}
