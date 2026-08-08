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

    @Test func signinReasonSplitsTheChipIntoIdleVsAlarm() {
        // Issue #149: "expired" is idle-decay — calm chip, same click path;
        // "missing" or an absent reason (old daemon) keeps the alarm chip.
        #expect(DeckAccount(
            id: "a", provider: "claude", label: "Deck One",
            authState: "signin-required", signinReason: "expired"
        ).healthChip == .idleSignIn)
        #expect(DeckAccount(
            id: "b", provider: "claude", label: "Deck Two",
            authState: "signin-required", signinReason: "missing"
        ).healthChip == .signInAgain)
        #expect(DeckAccount(
            id: "c", provider: "claude", label: "Deck Three",
            authState: "signin-required"
        ).healthChip == .signInAgain)
        // An UNRECOGNIZED reason from a future daemon must fall back to the
        // alarm chip too — calm is only ever an explicit "expired".
        #expect(DeckAccount(
            id: "d", provider: "claude", label: "Deck Four",
            authState: "signin-required", signinReason: "revoked-future-value"
        ).healthChip == .signInAgain)
        // The chip copy is the at-a-glance distinction Tim asked for.
        // Tim's 0.3.15 report: the long form wrapped the roster pill —
        // the pill states the fact, the tooltip carries the mechanics.
        #expect(ToolProbe.HealthChip.idleSignIn.text == "Idle")
        #expect(ToolProbe.HealthChip.signInAgain.text == "Sign in again")
    }

    @Test func providerLevelProbeNeverYieldsTheIdleChip() {
        // The CLI tools probe carries no signinReason — the #149 split is
        // per-account only, so the provider chip mapping is unchanged.
        #expect(ToolProbe(installed: true, authState: "signin-required").healthChip == .signInAgain)
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

/// Scriptable reauth backend + launcher + state provider + activator.
final class StubSignInBackend: AccountReauthenticating, DeckStateProviding, LoginLaunching, AccountActivating, @unchecked Sendable {
    private let lock = NSLock()
    var loginCommandByID: [String: String] = [:]
    /// Issue #99: full login specs by account id — takes precedence over
    /// `loginCommandByID` so tests can demand the activation-driven flow.
    var loginResultByID: [String: LoginCommand] = [:]
    var loginCommandError: Error?
    var verifyResult: AccountVerification?
    var verifyError: Error?
    var launchError: Error?
    var activateError: Error?
    var stateAfterVerify = DeckState()
    /// When true, loginCommand/verifyAccount suspend until `release()` —
    /// lets tests interleave cancel() with an in-flight daemon call.
    var waitForRelease = false
    var onGated: (@Sendable () -> Void)?
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private(set) var launchedCommands: [String] = []
    private(set) var verifiedIDs: [String] = []
    private(set) var stateReads = 0
    private(set) var activatedIDs: [String] = []

    func loginCommand(accountID: String) async throws -> LoginCommand {
        await gateIfNeeded()
        return try locked {
            if let loginCommandError { throw loginCommandError }
            if let login = loginResultByID[accountID] { return login }
            let command = loginCommandByID[accountID] ?? "true"
            return LoginCommand(provider: "claude", command: command)
        }
    }

    func activateAccount(id: String) async throws -> AccountActivation {
        // CodeRabbit PR #218: DaemonClient's URLSession calls are
        // cancellation-aware, so the stub throws on a cancelled task too —
        // a success tail running on a task it just cancelled fails here
        // exactly like production would.
        try Task.checkCancellation()
        return try locked {
            activatedIDs.append(id)
            if let activateError { throw activateError }
            return AccountActivation(
                account: DeckAccount(id: id, provider: "claude", label: "Activated", isDefault: true)
            )
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
        try Task.checkCancellation() // mirrors the cancellation-aware client
        return locked {
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
        AccountSignInModel(reauth: backend, launcher: backend, stateProvider: backend, activator: backend)
    }

    /// Issue #99: the daemon's activation-driven spec for current Claude
    /// Code, plus a state whose claude default is a different account.
    private func scriptActivationFlow(_ backend: StubSignInBackend) {
        backend.loginResultByID["acct-1"] = LoginCommand(
            provider: "claude",
            command: "'claude' /login",
            flow: "activation",
            requiresActivation: true
        )
        backend.stateAfterVerify = DeckState(accounts: [
            DeckAccount(id: "acct-prior", provider: "claude", label: "Prior", isDefault: true),
            DeckAccount(id: "acct-1", provider: "claude", label: "Deck One", authState: "ok"),
        ])
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

    @Test func defaultKeychainVerifyHintReplacesGenericSignedOutMessage() async {
        let backend = StubSignInBackend()
        let hint = "A Claude credential exists in the default Keychain slot, but none was found for this ModelDeck profile."
        backend.verifyResult = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            authenticated: false,
            verifyHint: hint
        )
        let model = makeModel(backend)

        await model.beginSignIn(account: account)
        let confirmed = await model.confirmSignedIn(account: account)

        #expect(!confirmed)
        #expect(model.error(for: "acct-1") == hint)
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn")
        }
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

    // MARK: - Issue #99: activation-driven re-sign-in

    @Test func activationSpecActivatesTargetBeforeTerminalOpens() async {
        let backend = StubSignInBackend()
        scriptActivationFlow(backend)
        let model = makeModel(backend)

        await model.beginSignIn(account: account)

        #expect(backend.activatedIDs == ["acct-1"])
        #expect(backend.launchedCommands == ["'claude' /login"])
        #expect(model.phase(for: "acct-1") == .awaitingSignIn(command: "'claude' /login"))
        #expect(model.error(for: "acct-1") == nil)
    }

    @Test func verifiedActivationFlowRestoresPriorActive() async {
        let backend = StubSignInBackend()
        scriptActivationFlow(backend)
        let model = makeModel(backend)
        var signedIn = 0
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        let confirmed = await model.confirmSignedIn(account: account)

        #expect(confirmed)
        // Restore strictly AFTER the verify read-back.
        #expect(backend.activatedIDs == ["acct-1", "acct-prior"])
        #expect(model.phase(for: "acct-1") == nil)
        #expect(signedIn == 1)
    }

    @Test func identityMismatchIsARefusalAndKeepsTargetActive() async {
        let backend = StubSignInBackend()
        scriptActivationFlow(backend)
        backend.verifyResult = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            authenticated: true,
            identity: "wrong@example.invalid",
            identityMismatch: .init(expected: "intended@example.invalid", actual: "wrong@example.invalid")
        )
        let model = makeModel(backend)
        var signedIn = 0
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        let confirmed = await model.confirmSignedIn(account: account)

        #expect(!confirmed)
        #expect(model.error(for: "acct-1")?.contains("intended@example.invalid") == true)
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn for a corrective /login")
        }
        // No restore: the target must stay active so a retry lands right.
        #expect(backend.activatedIDs == ["acct-1"])
        #expect(signedIn == 0)
    }

    @Test func cancelAfterActivationRestoresPriorActive() async {
        let backend = StubSignInBackend()
        scriptActivationFlow(backend)
        let model = makeModel(backend)

        await model.beginSignIn(account: account)
        model.cancel(accountID: "acct-1")

        // The restore runs in a background task off the sync cancel.
        for _ in 0..<200 {
            if backend.activatedIDs.count == 2 { break }
            await Task.yield()
        }
        #expect(backend.activatedIDs == ["acct-1", "acct-prior"])
        #expect(model.phase(for: "acct-1") == nil)
    }

    // CodeRabbit PR #106: cancel clears phases synchronously, so an
    // immediate retry passes the reentrancy guard while the cancel's restore
    // task is still pending. The bookkeeping must be captured and cleared
    // inside cancel itself — the stale task restores the RIGHT prior and
    // never clobbers the retry's freshly captured slots.
    @Test func cancelThenImmediateRetryDoesNotRaceTheRestore() async {
        let backend = StubSignInBackend()
        scriptActivationFlow(backend)
        let model = makeModel(backend)

        await model.beginSignIn(account: account)
        #expect(backend.activatedIDs == ["acct-1"])
        model.cancel(accountID: "acct-1")

        // Immediate retry: gate its login-command fetch so the pending
        // cancel-restore task deterministically lands mid-retry.
        backend.waitForRelease = true
        var retry: Task<Void, Never>?
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            backend.onGated = { ready.resume() }
            retry = Task { await model.beginSignIn(account: account) }
        }
        for _ in 0..<200 {
            if backend.activatedIDs.count == 2 { break }
            await Task.yield()
        }
        // The stale restore used the prior captured at cancel time.
        #expect(backend.activatedIDs == ["acct-1", "acct-prior"])

        backend.waitForRelease = false
        backend.release()
        await retry?.value

        // The retry re-activated the target with its own fresh bookkeeping…
        #expect(backend.activatedIDs == ["acct-1", "acct-prior", "acct-1"])
        // …and a verified success restores the RIGHT prior, not a stale or
        // dropped one.
        let confirmed = await model.confirmSignedIn(account: account)
        #expect(confirmed)
        #expect(backend.activatedIDs == ["acct-1", "acct-prior", "acct-1", "acct-prior"])
    }

    @Test func activationFailureSurfacesAndNeverOpensTerminal() async {
        let backend = StubSignInBackend()
        scriptActivationFlow(backend)
        backend.activateError = DaemonClientError.daemonError(message: "account is disabled", status: 400)
        let model = makeModel(backend)

        await model.beginSignIn(account: account)

        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == "account is disabled")
        #expect(backend.launchedCommands.isEmpty)
    }

    @Test func legacySpecNeverActivates() async {
        let backend = StubSignInBackend()
        backend.loginCommandByID["acct-1"] = "CLAUDE_CONFIG_DIR='/placeholder/profiles/claude/acct-1' 'claude' auth login"
        let model = makeModel(backend)

        await model.beginSignIn(account: account)
        _ = await model.confirmSignedIn(account: account)

        #expect(backend.activatedIDs.isEmpty)
    }
}

// MARK: - Issue #217: auto-verify while awaiting sign-in

/// Gated clock for the auto-verify poller: every sleep suspends until the
/// test ticks it, so poll beats are fully deterministic. Cancellation (flow
/// ended) resumes pending sleeps by throwing, like the real Task.sleep.
final class StubSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [CheckedContinuation<Void, Error>] = []
    private(set) var requestedDelays: [Duration] = []

    private var cancelled = false

    func sleep(_ duration: Duration) async throws {
        locked { requestedDelays.append(duration) }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                // CodeRabbit PR #218: the cancelled check and the append
                // must share one critical section — onCancel draining
                // between them would strand the continuation forever.
                let alreadyCancelled: Bool = locked {
                    if cancelled || Task.isCancelled { return true }
                    pending.append(continuation)
                    return false
                }
                if alreadyCancelled { continuation.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let drained: [CheckedContinuation<Void, Error>] = locked {
                defer {
                    cancelled = true
                    pending.removeAll()
                }
                return pending
            }
            for continuation in drained { continuation.resume(throwing: CancellationError()) }
        }
    }

    /// Release the oldest pending sleep — one poll beat.
    func tick() {
        let continuation: CheckedContinuation<Void, Error>? = locked {
            pending.isEmpty ? nil : pending.removeFirst()
        }
        continuation?.resume()
    }

    var armedSleeps: Int { locked { requestedDelays.count } }
    /// Sleeps currently suspended and tickable — the settle target before a
    /// tick (armedSleeps alone races the continuation arming).
    var pendingSleeps: Int { locked { pending.count } }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

@Suite("Auto-verify while awaiting sign-in (issue #217)")
@MainActor
struct AutoVerifyTests {
    private var account: DeckAccount {
        DeckAccount(
            id: "acct-1", provider: "claude", label: "Deck One",
            profileRef: "/placeholder/profiles/claude/acct-1", authState: "signin-required"
        )
    }

    private func makeModel(_ backend: StubSignInBackend, sleeper: StubSleeper) -> AccountSignInModel {
        let model = AccountSignInModel(reauth: backend, launcher: backend, stateProvider: backend, activator: backend)
        model.autoVerifySleep = { try await sleeper.sleep($0) }
        return model
    }

    /// Yield until `condition` holds (the poller is an unstructured task).
    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<2000 {
            if condition() { return }
            await Task.yield()
        }
    }

    @Test func finishedLoginClearsTheFlowWithoutAVerifyClick() async {
        let backend = StubSignInBackend()
        backend.stateAfterVerify = DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Deck One", authState: "ok"),
        ])
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)
        var pushedStates: [DeckState] = []
        var signedIn = 0
        model.onStateChanged = { pushedStates.append($0) }
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        await settle { sleeper.pendingSleeps == 1 }
        sleeper.tick()
        await settle { signedIn == 1 }

        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == nil)
        #expect(backend.verifiedIDs == ["acct-1"])
        #expect(pushedStates.first?.accounts.first?.healthChip == .healthy)
        #expect(signedIn == 1)
    }

    @Test func signedOutReadsStaySilentAndPollingContinues() async {
        let backend = StubSignInBackend()
        backend.verifyResult = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            authenticated: false
        )
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)
        var signedIn = 0
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        await settle { sleeper.pendingSleeps == 1 }
        sleeper.tick()
        // The poller went back to sleep — the failed read changed nothing.
        await settle { sleeper.pendingSleeps == 1 }
        #expect(sleeper.armedSleeps == 2)
        #expect(backend.verifiedIDs == ["acct-1"])
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn")
        }
        #expect(model.error(for: "acct-1") == nil)
        #expect(signedIn == 0)

        // The login finishes; the next beat completes the flow.
        backend.verifyResult = nil
        sleeper.tick()
        await settle { signedIn == 1 }
        #expect(model.phase(for: "acct-1") == nil)
        #expect(signedIn == 1)
    }

    @Test func transportErrorsStaySilent() async {
        let backend = StubSignInBackend()
        backend.verifyError = DaemonClientError.daemonError(message: "mutation token or origin rejected", status: 403)
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)

        await model.beginSignIn(account: account)
        await settle { sleeper.pendingSleeps == 1 }
        sleeper.tick()
        await settle { sleeper.pendingSleeps == 1 }

        #expect(sleeper.armedSleeps == 2)
        #expect(backend.verifiedIDs == ["acct-1"])
        #expect(model.error(for: "acct-1") == nil)
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn")
        }
    }

    @Test func identityMismatchStaysSilentUntilManualVerify() async {
        // The poller must never auto-complete (or auto-alarm) a wrong-identity
        // login; the manual Verify keeps reporting it honestly.
        let backend = StubSignInBackend()
        backend.verifyResult = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            authenticated: true,
            identity: "wrong@example.invalid",
            identityMismatch: .init(expected: "intended@example.invalid", actual: "wrong@example.invalid")
        )
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)
        var signedIn = 0
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        await settle { sleeper.pendingSleeps == 1 }
        sleeper.tick()
        await settle { sleeper.pendingSleeps == 1 }
        #expect(model.error(for: "acct-1") == nil)
        #expect(signedIn == 0)

        let confirmed = await model.confirmSignedIn(account: account)
        #expect(!confirmed)
        #expect(model.error(for: "acct-1")?.contains("intended@example.invalid") == true)
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn for a corrective /login")
        }
    }

    @Test func backoffEasesToTheCap() async {
        let backend = StubSignInBackend()
        backend.verifyResult = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            authenticated: false
        )
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)

        await model.beginSignIn(account: account)
        for _ in 1...3 {
            await settle { sleeper.pendingSleeps == 1 }
            sleeper.tick()
        }
        await settle { sleeper.pendingSleeps == 1 }

        #expect(Array(sleeper.requestedDelays.prefix(4)) == [
            .seconds(5), .seconds(7), .seconds(10), .seconds(10),
        ])
    }

    @Test func pollerStopsAtItsDeadlineLeavingManualVerifyAsThePath() async {
        // CodeRabbit PR #218: an abandoned card must not poll forever —
        // each verify spawns a provider CLI daemon-side. After the budget
        // the poller stops silently; the manual Verify button still works.
        let backend = StubSignInBackend()
        backend.verifyResult = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            authenticated: false
        )
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)
        // 5s + 7s fit the budget; the third beat (17s cumulative + 10s) does not.
        model.autoVerifyDeadline = .seconds(12)
        var signedIn = 0
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        for _ in 1...2 {
            await settle { sleeper.pendingSleeps == 1 }
            sleeper.tick()
        }
        for _ in 0..<200 { await Task.yield() }

        // Budget exhausted: no third sleep, no verify spam, still awaiting,
        // and still silent.
        #expect(sleeper.armedSleeps == 2)
        #expect(backend.verifiedIDs == ["acct-1", "acct-1"])
        if case .awaitingSignIn? = model.phase(for: "acct-1") {} else {
            Issue.record("expected to stay on awaitingSignIn")
        }
        #expect(model.error(for: "acct-1") == nil)

        backend.verifyResult = nil
        let confirmed = await model.confirmSignedIn(account: account)
        #expect(confirmed)
        #expect(signedIn == 1)
    }

    @Test func cancelStopsThePoller() async {
        let backend = StubSignInBackend()
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)

        await model.beginSignIn(account: account)
        await settle { sleeper.pendingSleeps == 1 }
        model.cancel(accountID: "acct-1")

        // A late tick is a no-op: the cancelled poller never verifies.
        sleeper.tick()
        for _ in 0..<50 { await Task.yield() }
        #expect(backend.verifiedIDs.isEmpty)
        #expect(model.phase(for: "acct-1") == nil)
        #expect(sleeper.armedSleeps == 1)
    }

    @Test func manualVerifySuccessStopsThePoller() async {
        let backend = StubSignInBackend()
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)

        await model.beginSignIn(account: account)
        await settle { sleeper.pendingSleeps == 1 }
        let confirmed = await model.confirmSignedIn(account: account)
        #expect(confirmed)

        sleeper.tick()
        for _ in 0..<50 { await Task.yield() }
        // Only the manual verify ever reached the daemon.
        #expect(backend.verifiedIDs == ["acct-1"])
        #expect(sleeper.armedSleeps == 1)
    }

    @Test func lateAutoSuccessAfterCancelIsDropped() async {
        // The poller's verify is in flight when the user dismisses the flow —
        // the late success must not resurrect it (same contract as the manual
        // path's cancel guards).
        let backend = StubSignInBackend()
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)
        var pushedStates = 0
        var signedIn = 0
        model.onStateChanged = { _ in pushedStates += 1 }
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        await settle { sleeper.pendingSleeps == 1 }
        backend.waitForRelease = true
        await withCheckedContinuation { (gated: CheckedContinuation<Void, Never>) in
            backend.onGated = { gated.resume() }
            sleeper.tick()
        }
        #expect(backend.verifiedIDs == ["acct-1"])

        model.cancel(accountID: "acct-1")
        backend.release()
        for _ in 0..<200 { await Task.yield() }

        #expect(model.phase(for: "acct-1") == nil)
        #expect(model.error(for: "acct-1") == nil)
        #expect(pushedStates == 0)
        #expect(signedIn == 0)
    }

    @Test func autoSuccessRestoresPriorActiveStrictlyAfterVerify() async {
        // Issue #99 sequencing holds on the zero-click path too.
        let backend = StubSignInBackend()
        backend.loginResultByID["acct-1"] = LoginCommand(
            provider: "claude",
            command: "'claude' /login",
            flow: "activation",
            requiresActivation: true
        )
        backend.stateAfterVerify = DeckState(accounts: [
            DeckAccount(id: "acct-prior", provider: "claude", label: "Prior", isDefault: true),
            DeckAccount(id: "acct-1", provider: "claude", label: "Deck One", authState: "ok"),
        ])
        let sleeper = StubSleeper()
        let model = makeModel(backend, sleeper: sleeper)
        var signedIn = 0
        model.onSignedIn = { signedIn += 1 }

        await model.beginSignIn(account: account)
        #expect(backend.activatedIDs == ["acct-1"])
        await settle { sleeper.pendingSleeps == 1 }
        sleeper.tick()
        await settle { signedIn == 1 }

        #expect(backend.activatedIDs == ["acct-1", "acct-prior"])
        #expect(model.phase(for: "acct-1") == nil)
        #expect(signedIn == 1)
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

// Issue #213 — the deck card's inline duplicate re-login: a flow that fails
// to START must land its reason at the click site (this path has no Settings
// window to fall back to), and a parked error needs an explicit dismiss that
// can never clobber a live flow's state.
@Suite("Inline sign-in start failures (issue #213)")
@MainActor
struct SignInStartFailureTests {
    private func makeModel(_ backend: StubSignInBackend) -> AccountSignInModel {
        AccountSignInModel(reauth: backend, launcher: backend, stateProvider: backend, activator: backend)
    }

    @Test func startFailureLandsInTheAccountsErrorSlot() {
        let model = makeModel(StubSignInBackend())
        model.noteStartFailure(
            accountID: "acct-1",
            message: AccountSignInModel.duplicateReloginUnresolvedMessage
        )
        #expect(model.error(for: "acct-1") == AccountSignInModel.duplicateReloginUnresolvedMessage)
        #expect(model.phase(for: "acct-1") == nil)
    }

    @Test func startFailureNeverClobbersALiveFlow() async {
        // A stale refusal arriving while a newer flow runs must not overwrite
        // that flow's slot — the phase UI already owns it.
        let backend = StubSignInBackend()
        backend.loginCommandByID["acct-1"] = "true"
        let model = makeModel(backend)
        await model.beginSignIn(account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"))
        model.noteStartFailure(accountID: "acct-1", message: "late refusal")
        #expect(model.error(for: "acct-1") == nil)
        #expect(model.phase(for: "acct-1") == .awaitingSignIn(command: "true"))
    }

    @Test func dismissClearsAParkedError() {
        let model = makeModel(StubSignInBackend())
        model.noteStartFailure(accountID: "acct-1", message: "didn't start")
        model.dismissError(accountID: "acct-1")
        #expect(model.error(for: "acct-1") == nil)
    }

    @Test func dismissLeavesALiveFlowsErrorAlone() async {
        // Mid-flow errors (a failed Terminal launch, "Still signed out…")
        // clear via the flow's own actions — the parked-error dismiss must
        // not offer a second, conflicting path into a running flow.
        let backend = StubSignInBackend()
        backend.loginCommandByID["acct-1"] = "true"
        backend.launchError = CocoaError(.fileNoSuchFile)
        let model = makeModel(backend)
        await model.beginSignIn(account: DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"))
        #expect(model.error(for: "acct-1") != nil)
        model.dismissError(accountID: "acct-1")
        #expect(model.error(for: "acct-1") != nil)
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
