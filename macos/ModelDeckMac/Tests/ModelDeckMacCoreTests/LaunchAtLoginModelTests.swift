import Foundation
import Testing
@testable import ModelDeckMacCore

// LaunchAtLoginModel — the shared observable behind both "Launch at Login"
// toggles. The SMAppService.status read is an XPC round-trip, so the model
// must read it exactly once via load() (off the view render path) and never
// from a view-struct initializer.

@MainActor
@Suite("Launch-at-login model")
struct LaunchAtLoginModelTests {
    @Test func loadReadsServiceStatusExactlyOnce() {
        var reads = 0
        let model = LaunchAtLoginModel(
            readEnabled: { reads += 1; return true },
            writeEnabled: { _ in }
        )
        #expect(model.isEnabled == false) // no XPC before load()

        model.load()
        #expect(model.isEnabled == true)
        #expect(reads == 1)

        model.load() // popover AND settings pane may both fire .task
        #expect(reads == 1)
    }

    @Test func setEnabledWritesAndPublishes() {
        var written: [Bool] = []
        let model = LaunchAtLoginModel(
            readEnabled: { false },
            writeEnabled: { written.append($0) }
        )
        model.load()

        model.setEnabled(true)
        #expect(model.isEnabled == true)
        #expect(model.lastError == nil)
        #expect(written == [true])

        model.setEnabled(true) // no-op: already enabled, no redundant register
        #expect(written == [true])

        model.setEnabled(false)
        #expect(model.isEnabled == false)
        #expect(written == [true, false])
    }

    @Test func writeFailureSurfacesErrorAndSnapsBackToServiceStatus() {
        struct RegisterError: LocalizedError {
            var errorDescription: String? { "Operation not permitted" }
        }
        let model = LaunchAtLoginModel(
            readEnabled: { false }, // service says still disabled
            writeEnabled: { _ in throw RegisterError() }
        )
        model.load()

        model.setEnabled(true)
        #expect(model.isEnabled == false)
        #expect(model.lastError == "Operation not permitted")
    }

    @Test func successAfterFailureClearsError() {
        var failNext = true
        struct RegisterError: LocalizedError {
            var errorDescription: String? { "nope" }
        }
        var serviceEnabled = false
        let model = LaunchAtLoginModel(
            readEnabled: { serviceEnabled },
            writeEnabled: { enabled in
                if failNext { throw RegisterError() }
                serviceEnabled = enabled
            }
        )
        model.load()

        model.setEnabled(true)
        #expect(model.lastError == "nope")

        failNext = false
        model.setEnabled(true)
        #expect(model.isEnabled == true)
        #expect(model.lastError == nil)
    }
}
