import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #32 — per-account health chips, the "Sign in again" flow, and the
// CLI update pill. Placeholder account labels only, per the safety contract.

// MARK: - Per-account chip mapping

@Suite("Per-account health chips (issue #32)")
struct PerAccountHealthChipTests {
    @Test func authStatesMapToChipsPerAccount() {
        #expect(DeckAccount(id: "a", provider: "claude", label: "Deck One", authState: "ok").healthChip == .healthy)
        #expect(DeckAccount(id: "b", provider: "claude", label: "Deck Two", authState: "signin-required").healthChip == .signInAgain)
        #expect(DeckAccount(id: "c", provider: "codex", label: "Deck Three", authState: "unknown").healthChip == .unknown)
    }

    @Test func absentOrUnrecognizedAuthStateIsHonestUnknown() {
        // A daemon without the per-account backend omits the field entirely.
        #expect(DeckAccount(id: "a", provider: "claude", label: "Deck One").healthChip == .unknown)
        #expect(DeckAccount(id: "b", provider: "codex", label: "Deck Two", authState: "future-value").healthChip == .unknown)
    }

    @Test func decodesStateWithAndWithoutAuthState() throws {
        let json = #"""
        {"accounts":[
          {"id":"acct-1","provider":"claude","label":"Deck One","enabled":true,"isDefault":true,"authState":"ok"},
          {"id":"acct-2","provider":"claude","label":"Deck Two","enabled":true,"isDefault":false,"authState":"signin-required"},
          {"id":"acct-3","provider":"codex","label":"Deck Three","enabled":true,"isDefault":false}
        ],"usage":[]}
        """#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        #expect(state.accounts[0].healthChip == .healthy)
        #expect(state.accounts[1].healthChip == .signInAgain)
        // Same provider, different per-account states — chips are no longer
        // provider-wide.
        #expect(state.accounts[0].healthChip != state.accounts[1].healthChip)
        #expect(state.accounts[2].authState == nil)
        #expect(state.accounts[2].healthChip == .unknown)
    }
}

// MARK: - Sign in again

/// Scriptable reauth backend + launcher + state provider.
final class StubSignInBackend: AccountReauthenticating, DeckStateProviding, LoginLaunching, @unchecked Sendable {
    private let lock = NSLock()
    var loginCommandByID: [String: String] = [:]
    var loginCommandError: Error?
    var verifyResult: AccountVerification?
    var verifyError: Error?
    var launchError: Error?
    var stateAfterVerify = DeckState()
    /// When true, loginCommand/verifyAccount suspend until `release()` —
    /// lets tests interleave cancel() with an in-flight daemon call.
    var waitForRelease = false
    var onGated: (@Sendable () -> Void)?
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private(set) var launchedCommands: [String] = []
    private(set) var verifiedIDs: [String] = []
    private(set) var stateReads = 0

    func loginCommand(accountID: String) async throws -> LoginCommand {
        await gateIfNeeded()
        return try locked {
            if let loginCommandError { throw loginCommandError }
            let command = loginCommandByID[accountID] ?? "true"
            return LoginCommand(provider: "claude", command: command)
        }
    }

    func verifyAccount(accountID: String) async throws -> AccountVerification {
        locked { verifiedIDs.append(accountID) }
        await gateIfNeeded()
        return try locked {
            if let verifyError { throw verifyError }
            return verifyResult ?? AccountVerification(
                account: DeckAccount(id: accountID, provider: "claude", label: "Deck One", authState: "ok"),
                authenticated: true
            )
        }
    }

    func release() {
        let continuation: CheckedContinuation<Void, Never>? = locked {
            defer { releaseContinuation = nil }
            return releaseContinuation
        }
        continuation?.resume()
    }

    private func gateIfNeeded() async {
        guard locked({ waitForRelease }) else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            locked { releaseContinuation = continuation }
            onGated?()
        }
    }

    func launchLogin(command: String) throws {
        try locked {
            launchedCommands.append(command)
            if let launchError { throw launchError }
        }
    }

    func deckState() async throws -> DeckState {
        locked {
            stateReads += 1
            return stateAfterVerify
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

@Suite("Account sign-in-again model (issue #32)")
@MainActor
struct AccountSignInModelTests {
    private var account: DeckAccount {
        DeckAccount(
            id: "acct-1", provider: "claude", label: "Deck One",
            profileRef: "/placeholder/profiles/claude/acct-1", authState: "signin-required"
        )
    }

    private func makeModel(_ backend: StubSignInBackend) -> AccountSignInModel {
        AccountSignInModel(reauth: backend, launcher: backend, stateProvider: backend)
    }

    @Test func beginLaunchesTheDaemonsPerProfileLoginCommandVerbatim() async {
        let backend = StubSignInBackend()
        // The daemon builds the env-scoped command from the account's own
        // profileRef (src/service.mjs loginCommand) — the app passes it to
        // Terminal untouched.
        let command = "CLAUDE_CONFIG_DIR='/placeholder/profiles/claude/acct-1' 'claude' auth login"
        backend.loginCommandByID["acct-1"] = command
        let model = makeModel(backend)

        await model.beginSignIn(account: account)

        #expect(backend.launchedCommands == [command])
        #expect(model.phase(for: "acct-1") == .awaitingSignIn(command: command))
        #expect(model.error(for: "acct-1") == nil)
    }

    @Test func beginIsIgnoredWhileAFlowIsInFlight() async {
        let backend = StubSignInBackend()
        let model = makeModel(backend)
        await model.beginSignIn(account: account)
        await model.beginSignIn(account: account)
        #expect(backend.launchedCommands.count == 1)
    }

    @Test func loginCommandFailureClearsPhaseAndSurfacesMessage() async {
        let backend = StubSignInBackend()
        backend.loginCommandError = DaemonClientError.daemonError(message: "account not found", status: 404)
        let model = makeModel(backend)
        await model.beginSignIn(account: account)
        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == "account not found")
        #expect(backend.launchedCommands.isEmpty)
    }

    @Test func terminalLaunchFailureKeepsCommandForRelaunch() async {
        let backend = StubSignInBackend()
        backend.loginCommandByID["acct-1"] = "CODEX_HOME='/placeholder/profiles/codex/acct-1' 'codex' login"
        backend.launchError = CocoaError(.fileNoSuchFile)
        let model = makeModel(backend)

        await model.beginSignIn(account: account)
        #expect(model.error(for: "acct-1")?.contains("Couldn't open Terminal") == true)
        guard case .awaitingSignIn(let kept)? = model.phase(for: "acct-1") else {
            Issue.record("expected awaitingSignIn with the stored command")
            return
        }
        #expect(kept.contains("CODEX_HOME="))

        backend.launchError = nil
        model.relaunch(accountID: "acct-1")
        #expect(backend.launchedCommands.count == 2)
        #expect(model.error(for: "acct-1") == nil)
    }

    @Test func confirmVerifiedPublishesFreshStateAndSignals() async {
        let backend = StubSignInBackend()
        backend.stateAfterVerify = DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Deck One", authState: "ok"),
        ])
        let model = makeModel(backend)
        var pushedStates: [DeckState] = []
        var signedIn = 0
        model.onStateChanged = { pushedStates.append($0) }
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        let confirmed = await model.confirmSignedIn(account: account)

        #expect(confirmed)
        #expect(backend.verifiedIDs == ["acct-1"])
        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == nil)
        #expect(pushedStates.first?.accounts.first?.healthChip == .healthy)
        #expect(signedIn == 1)
    }

    @Test func confirmWhileStillSignedOutStaysAwaitingWithHonestMessage() async {
        let backend = StubSignInBackend()
        backend.verifyResult = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            authenticated: false
        )
        let model = makeModel(backend)
        var signedIn = 0
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        let confirmed = await model.confirmSignedIn(account: account)

        #expect(!confirmed)
        #expect(model.error(for: "acct-1")?.contains("Still signed out") == true)
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn")
        }
        #expect(signedIn == 0)
    }

    @Test func verifyErrorSurfacesAndReturnsToAwaiting() async {
        let backend = StubSignInBackend()
        backend.verifyError = DaemonClientError.daemonError(message: "mutation token or origin rejected", status: 403)
        let model = makeModel(backend)
        await model.beginSignIn(account: account)
        let confirmed = await model.confirmSignedIn(account: account)
        #expect(!confirmed)
        #expect(model.error(for: "acct-1") == "mutation token or origin rejected")
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn")
        }
    }

    @Test func cancelClearsTheFlow() async {
        let backend = StubSignInBackend()
        let model = makeModel(backend)
        await model.beginSignIn(account: account)
        model.cancel(accountID: "acct-1")
        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == nil)
    }

    // CodeRabbit PR #38: cancel racing an in-flight await must not let the
    // late daemon result resurrect the cancelled flow.

    @Test func cancelWhileFetchingLoginCommandDropsLateResultAndNeverLaunchesTerminal() async {
        let backend = StubSignInBackend()
        backend.waitForRelease = true
        let model = makeModel(backend)

        var begin: Task<Void, Never>?
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            backend.onGated = { ready.resume() }
            begin = Task { await model.beginSignIn(account: account) }
        }
        #expect(model.phase(for: "acct-1") == .launching)

        model.cancel(accountID: "acct-1")
        backend.release()
        await begin?.value

        // The late login command is dropped: no phase resurrection, no error,
        // and — crucially — Terminal was never opened for the dismissed flow.
        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == nil)
        #expect(backend.launchedCommands.isEmpty)
    }

    @Test func cancelWhileVerifyingDropsTheLateVerification() async {
        let backend = StubSignInBackend()
        backend.stateAfterVerify = DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Deck One", authState: "ok"),
        ])
        let model = makeModel(backend)
        var pushedStates = 0
        var signedIn = 0
        model.onStateChanged = { _ in pushedStates += 1 }
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        backend.waitForRelease = true
        var confirm: Task<Bool, Never>?
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            backend.onGated = { ready.resume() }
            confirm = Task { await model.confirmSignedIn(account: account) }
        }
        #expect(model.phase(for: "acct-1") == .verifying)

        model.cancel(accountID: "acct-1")
        backend.release()
        let confirmed = await confirm?.value

        // The verification completed daemon-side but the cancelled flow
        // drops it: no phase, no callbacks, confirm reports false.
        #expect(confirmed == false)
        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == nil)
        #expect(pushedStates == 0)
        #expect(signedIn == 0)
    }

    @Test func cancelWhileVerifyErrorInFlightDropsTheLateError() async {
        let backend = StubSignInBackend()
        backend.verifyError = DaemonClientError.daemonError(message: "mutation token or origin rejected", status: 403)
        let model = makeModel(backend)

        await model.beginSignIn(account: account)
        backend.waitForRelease = true
        var confirm: Task<Bool, Never>?
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            backend.onGated = { ready.resume() }
            confirm = Task { await model.confirmSignedIn(account: account) }
        }
        model.cancel(accountID: "acct-1")
        backend.release()
        _ = await confirm?.value

        // The late failure must not resurrect the awaiting step or its error.
        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == nil)
    }
}

// MARK: - Update pill

final class StubToolUpdater: ToolUpdating, @unchecked Sendable {
    private let lock = NSLock()
    var result: ToolUpdateResult?
    var error: Error?
    /// When true, updateTool suspends until `release()` — lets tests observe
    /// the running phase deterministically. `onGated` fires once the gate is
    /// armed.
    var waitForRelease = false
    var onGated: (@Sendable () -> Void)?
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private(set) var calls: [String] = []

    func updateTool(_ tool: String) async throws -> ToolUpdateResult {
        locked { calls.append(tool) }
        if waitForRelease {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                locked { releaseContinuation = continuation }
                onGated?()
            }
        }
        if let error { throw error }
        return result ?? ToolUpdateResult(ok: true, previousVersion: "1.0.0", newVersion: "1.1.0")
    }

    func release() {
        let continuation: CheckedContinuation<Void, Never>? = locked {
            defer { releaseContinuation = nil }
            return releaseContinuation
        }
        continuation?.resume()
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

@Suite("Tool update pill state machine (issue #32)")
@MainActor
struct ToolUpdateModelTests {
    @Test func successfulUpdateReportsNewVersionAndReloadsProbe() async {
        let updater = StubToolUpdater()
        updater.result = ToolUpdateResult(
            ok: true, previousVersion: "2.1.0", newVersion: "2.2.0",
            outputTail: "added 1 package in 4s"
        )
        let model = ToolUpdateModel(updater: updater)
        var finished = 0
        model.onFinished = { finished += 1 }

        await model.update(tool: "claude")

        #expect(updater.calls == ["claude"])
        #expect(model.phase(for: "claude") == .succeeded(newVersion: "2.2.0"))
        #expect(finished == 1)

        model.dismissOutcome(tool: "claude")
        #expect(model.phase(for: "claude") == nil)
    }

    @Test func updaterFailureShowsHonestOutputTail() async {
        let updater = StubToolUpdater()
        updater.result = ToolUpdateResult(
            ok: false, previousVersion: "1.0.0", newVersion: "1.0.0",
            outputTail: "npm ERR! network timeout\nnpm ERR! request failed"
        )
        let model = ToolUpdateModel(updater: updater)
        await model.update(tool: "codex")
        #expect(model.phase(for: "codex") == .failed(message: "npm ERR! request failed"))
    }

    @Test func conflict409SurfacesDaemonMessageVerbatim() async {
        let updater = StubToolUpdater()
        updater.error = DaemonClientError.daemonError(
            message: "cannot update claude: detected unsupported direct/native install method at /placeholder/bin/claude",
            status: 409
        )
        let model = ToolUpdateModel(updater: updater)
        var finished = 0
        model.onFinished = { finished += 1 }
        await model.update(tool: "claude")
        #expect(model.phase(for: "claude") == .failed(
            message: "cannot update claude: detected unsupported direct/native install method at /placeholder/bin/claude"
        ))
        #expect(finished == 1)
    }

    @Test func missingEndpointOnOlderDaemonFailsHonestly() async {
        let updater = StubToolUpdater()
        updater.error = DaemonClientError.httpStatus(404)
        let model = ToolUpdateModel(updater: updater)
        await model.update(tool: "claude")
        #expect(model.phase(for: "claude") == .failed(message: "The daemon returned HTTP 404."))
    }

    @Test func updateIsSingleFlightPerToolClientSide() async {
        let updater = StubToolUpdater()
        updater.waitForRelease = true
        let model = ToolUpdateModel(updater: updater)

        var firstRun: Task<Void, Never>?
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            updater.onGated = { ready.resume() }
            firstRun = Task { await model.update(tool: "claude") }
        }
        #expect(model.isRunning("claude"))
        // Re-entrancy: a second click while running must be a no-op.
        await model.update(tool: "claude")
        #expect(updater.calls.count == 1)

        updater.release()
        await firstRun?.value
        #expect(!model.isRunning("claude"))
        #expect(model.phase(for: "claude") == .succeeded(newVersion: "1.1.0"))
    }

    @Test func runningPhaseCannotBeDismissed() async {
        let updater = StubToolUpdater()
        updater.waitForRelease = true
        let model = ToolUpdateModel(updater: updater)
        var run: Task<Void, Never>?
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            updater.onGated = { ready.resume() }
            run = Task { await model.update(tool: "codex") }
        }
        model.dismissOutcome(tool: "codex")
        #expect(model.isRunning("codex"))
        updater.release()
        await run?.value
    }
}

// MARK: - DaemonClient.updateTool wire format

@Suite("Daemon client CLI update endpoint (issue #32)")
struct DaemonClientUpdateToolTests {
    @Test func postsTokenGatedUpdateAndDecodesOutputTail() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-9"}"#),
            .init(status: 200, body: #"{"ok":true,"previousVersion":"2.1.0","newVersion":"2.2.0","output-tail":"added 1 package"}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let result = try await client.updateTool("claude")
        #expect(result.ok)
        #expect(result.previousVersion == "2.1.0")
        #expect(result.newVersion == "2.2.0")
        #expect(result.outputTail == "added 1 package")
        let post = transport.requests[1]
        #expect(post.httpMethod == "POST")
        #expect(post.url?.path == "/api/tools/claude/update")
        #expect(post.value(forHTTPHeaderField: "x-modeldeck-token") == "tok-9")
        #expect(post.value(forHTTPHeaderField: "Cookie") == "modeldeck_session=tok-9")
    }

    @Test func failedUpdateWith500StillDecodesOutcome() async throws {
        // src/server.mjs answers `outcome.ok ? 200 : 500` with the outcome
        // body either way — a 500 here is a completed-but-failed update, not
        // a transport error.
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-9"}"#),
            .init(status: 500, body: #"{"ok":false,"previousVersion":"1.0.0","newVersion":"1.0.0","output-tail":"npm ERR! failed"}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let result = try await client.updateTool("codex")
        #expect(!result.ok)
        #expect(result.failureSummary == "npm ERR! failed")
    }

    @Test func conflict409ThrowsDaemonErrorWithMessage() async {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-9"}"#),
            .init(status: 409, body: #"{"error":"cannot update claude: detected unsupported direct/native install method"}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        await #expect(throws: DaemonClientError.daemonError(
            message: "cannot update claude: detected unsupported direct/native install method",
            status: 409
        )) {
            _ = try await client.updateTool("claude")
        }
    }

    @Test func missingEndpointFallsBackToHTTPStatus() async {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-9"}"#),
            .init(status: 404, body: "Not Found"),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        await #expect(throws: DaemonClientError.httpStatus(404)) {
            _ = try await client.updateTool("claude")
        }
    }
}
