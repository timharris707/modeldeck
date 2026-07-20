import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #33 — opening the General pane auto-re-probes CLI versions
// (/api/tools?refresh=1) with a debounce; no manual button remains.

/// Scriptable prober recording each call's refresh flag.
final class StubPaneProber: ToolsProbing, @unchecked Sendable {
    private let lock = NSLock()
    var error: Error?
    private(set) var refreshFlags: [Bool] = []

    func tools(refresh: Bool) async throws -> ToolsProbeResponse {
        try locked {
            refreshFlags.append(refresh)
            if let error { throw error }
            return ToolsProbeResponse(
                tools: .init(claude: ToolProbe(installed: true, version: "2.0.0"),
                             codex: ToolProbe(installed: true, version: "1.0.0"))
            )
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

@Suite("Pane-open CLI re-probe (issue #33)")
@MainActor
struct ToolsPaneProbeTests {
    private let base = Date(timeIntervalSince1970: 1_800_000_000)

    private func model(prober: StubPaneProber, now: @escaping @Sendable () -> Date) -> ToolsStatusModel {
        ToolsStatusModel(prober: prober, clock: now)
    }

    @Test func firstPaneOpenForcesTheProbe() async {
        let prober = StubPaneProber()
        let model = model(prober: prober) { [base] in base }
        await model.probeOnPaneOpen()
        #expect(prober.refreshFlags == [true])
        #expect(model.probe != nil)
        #expect(model.lastError == nil)
    }

    @Test func rapidReopenDebouncesToCachedRead() async {
        let prober = StubPaneProber()
        let model = model(prober: prober) { [base] in base }
        await model.probeOnPaneOpen()
        await model.probeOnPaneOpen() // same instant — inside the debounce
        #expect(prober.refreshFlags == [true, false])
    }

    @Test func reopenAfterDebounceWindowForcesAgain() async {
        let prober = StubPaneProber()
        let times = Clock(base: base)
        let model = model(prober: prober) { times.now() }
        await model.probeOnPaneOpen()
        times.advance(by: ToolsStatusModel.paneProbeDebounce + 1)
        await model.probeOnPaneOpen()
        #expect(prober.refreshFlags == [true, true])
    }

    @Test func failedProbeSurfacesErrorAndStaysDebounced() async {
        let prober = StubPaneProber()
        prober.error = URLError(.cannotConnectToHost)
        let model = model(prober: prober) { [base] in base }
        await model.probeOnPaneOpen()
        #expect(model.lastError != nil)
        // Within the window a retry stays cheap — the next pane open after
        // the debounce elapses re-forces.
        await model.probeOnPaneOpen()
        #expect(prober.refreshFlags == [true, false])
    }

    /// Mutable test clock, thread-safe for the @Sendable closure seam.
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var current: Date

        init(base: Date) { self.current = base }

        func now() -> Date {
            lock.lock()
            defer { lock.unlock() }
            return current
        }

        func advance(by seconds: TimeInterval) {
            lock.lock()
            defer { lock.unlock() }
            current = current.addingTimeInterval(seconds)
        }
    }
}
