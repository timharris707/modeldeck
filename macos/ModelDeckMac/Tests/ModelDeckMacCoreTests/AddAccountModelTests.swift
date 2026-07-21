import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #8 — add-account flow model. All identities in these fixtures are
// placeholders (user@example.invalid), per the repo privacy rule.

/// Scriptable daemon + terminal seams for the add-account flow.
final class StubOnboardingBackend: AccountOnboarding, LoginLaunching, DeckStateProviding, AccountActivating, @unchecked Sendable {
    private let lock = NSLock()
    var createError: Error?
    var loginCommandError: Error?
    var verifyError: Error?
    var refreshError: Error?
    var deleteError: Error?
    var launchError: Error?
    var activateError: Error?
    /// When set, deckState() throws — exercises the prior-active lookup
    /// failure path (issue #99, CodeRabbit PR #106).
    var stateError: Error?
    var verification: AccountVerification?
    /// Issue #99: nil keeps the legacy env-scoped spec; set to exercise the
    /// activation-driven flow.
    var loginResult: LoginCommand?
    var stateAfterMutation = DeckState()
    private(set) var created: [AccountCreate] = []
    private(set) var loginCommandRequests: [String] = []
    private(set) var launchedCommands: [String] = []
    private(set) var verifiedIDs: [String] = []
    private(set) var refreshCalls = 0
    private(set) var deletedIDs: [String] = []
    private(set) var stateReads = 0
    private(set) var activatedIDs: [String] = []

    func createAccount(_ create: AccountCreate) async throws -> DeckAccount {
        try locked {
            created.append(create)
            if let createError { throw createError }
            return DeckAccount(
                id: "acct-1",
                provider: create.provider,
                label: create.label,
                purpose: create.purpose,
                color: create.color,
                profileRef: "/profiles/\(create.label.lowercased())"
            )
        }
    }

    func loginCommand(accountID: String) async throws -> LoginCommand {
        try locked {
            loginCommandRequests.append(accountID)
            if let loginCommandError { throw loginCommandError }
            return loginResult
                ?? LoginCommand(provider: "claude", command: "CLAUDE_CONFIG_DIR='/profiles/x' 'claude' auth login")
        }
    }

    func activateAccount(id: String) async throws -> AccountActivation {
        try locked {
            activatedIDs.append(id)
            if let activateError { throw activateError }
            return AccountActivation(
                account: DeckAccount(id: id, provider: "claude", label: "Activated", isDefault: true)
            )
        }
    }

    func verifyAccount(accountID: String) async throws -> AccountVerification {
        try locked {
            verifiedIDs.append(accountID)
            if let verifyError { throw verifyError }
            return verification ?? AccountVerification(
                account: DeckAccount(id: accountID, provider: "claude", label: "Work", identity: "user@example.invalid"),
                authenticated: true,
                identity: "user@example.invalid"
            )
        }
    }

    func refreshUsage() async throws {
        try locked {
            refreshCalls += 1
            if let refreshError { throw refreshError }
        }
    }

    func deleteAccount(id: String) async throws {
        try locked {
            deletedIDs.append(id)
            if let deleteError { throw deleteError }
        }
    }

    func launchLogin(command: String) throws {
        try locked {
            launchedCommands.append(command)
            if let launchError { throw launchError }
        }
    }

    func deckState() async throws -> DeckState {
        try locked {
            stateReads += 1
            if let stateError { throw stateError }
            return stateAfterMutation
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

@Suite("Add-account flow model (issue #8)")
@MainActor
struct AddAccountModelTests {
    private func makeModel(_ backend: StubOnboardingBackend) -> AddAccountModel {
        AddAccountModel(onboarding: backend, launcher: backend, stateProvider: backend, activator: backend)
    }

    /// Issue #99: the daemon's activation-driven spec for current Claude
    /// Code (credentials key off the resolved ~/.claude).
    private var activationLogin: LoginCommand {
        LoginCommand(
            provider: "claude",
            command: "'claude' /login",
            flow: "activation",
            requiresActivation: true
        )
    }

    /// A deck state whose claude default is another, pre-existing account.
    private var stateWithPriorActive: DeckState {
        DeckState(accounts: [
            DeckAccount(id: "acct-prior", provider: "claude", label: "Prior", isDefault: true),
            DeckAccount(id: "acct-1", provider: "claude", label: "Work"),
        ])
    }

    @Test("Happy path: create, sign in, verify, land with first usage pull")
    func happyPath() async {
        let backend = StubOnboardingBackend()
        let model = makeModel(backend)
        var publishedStates = 0
        model.onStateChanged = { _ in publishedStates += 1 }

        let began = await model.begin(provider: .claude, label: "  Work  ", purpose: "client work", colorHex: "#d97757")
        #expect(began)
        #expect(model.step == .signIn)
        #expect(backend.created == [AccountCreate(provider: "claude", label: "Work", purpose: "client work", color: "#d97757")])
        #expect(backend.launchedCommands.count == 1)
        #expect(model.loginCommand?.contains("auth login") == true)
        // Never the HANDOFF pitfall.
        #expect(model.loginCommand?.contains("logout") == false)

        let confirmed = await model.confirmSignedIn()
        #expect(confirmed)
        #expect(model.step == .confirm)
        #expect(model.identity == "user@example.invalid")
        #expect(backend.verifiedIDs == ["acct-1"])
        #expect(backend.refreshCalls == 1)
        #expect(model.completionWarning == nil)
        #expect(publishedStates == 1)
    }

    @Test("Empty label never reaches the daemon")
    func emptyLabel() async {
        let backend = StubOnboardingBackend()
        let model = makeModel(backend)
        let began = await model.begin(provider: .codex, label: "   ", purpose: "", colorHex: nil)
        #expect(!began)
        #expect(model.step == .details)
        #expect(model.lastError != nil)
        #expect(backend.created.isEmpty)
    }

    @Test("Terminal launch failure keeps the flow alive with the command available for copy")
    func launchFailure() async {
        let backend = StubOnboardingBackend()
        backend.launchError = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "denied"])
        let model = makeModel(backend)
        let began = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)
        #expect(began)
        #expect(model.step == .signIn)
        #expect(model.loginCommand != nil)
        #expect(model.lastError?.contains("copy the command") == true)
    }

    @Test("Verify while the provider still reports signed-out stays on the sign-in step")
    func notSignedInYet() async {
        let backend = StubOnboardingBackend()
        backend.verification = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Work"),
            authenticated: false,
            identity: nil
        )
        let model = makeModel(backend)
        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)

        let confirmed = await model.confirmSignedIn()
        #expect(!confirmed)
        #expect(model.step == .signIn)
        #expect(model.lastError?.contains("isn't signed in yet") == true)
        #expect(backend.refreshCalls == 0)
    }

    @Test("A failed first usage pull is a soft warning, not a failed flow")
    func softUsageFailure() async {
        let backend = StubOnboardingBackend()
        backend.refreshError = NSError(domain: "test", code: 7, userInfo: [NSLocalizedDescriptionKey: "provider timed out"])
        let model = makeModel(backend)
        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)

        let confirmed = await model.confirmSignedIn()
        #expect(confirmed)
        #expect(model.step == .confirm)
        #expect(model.completionWarning?.contains("usage refresh failed") == true)
    }

    @Test("Cancel can remove the created reference — and only the reference")
    func cancelDiscards() async {
        let backend = StubOnboardingBackend()
        let model = makeModel(backend)
        _ = await model.begin(provider: .codex, label: "Spare", purpose: "", colorHex: nil)

        let cancelled = await model.cancel(discardAccount: true)
        #expect(cancelled)
        #expect(backend.deletedIDs == ["acct-1"])
        #expect(model.step == .details)
        #expect(model.account == nil)
        #expect(model.loginCommand == nil)
    }

    @Test("A failed reference removal surfaces the error instead of silently resetting")
    func cancelDiscardFailure() async {
        let backend = StubOnboardingBackend()
        backend.deleteError = NSError(domain: "test", code: 9, userInfo: [NSLocalizedDescriptionKey: "daemon unreachable"])
        let model = makeModel(backend)
        _ = await model.begin(provider: .codex, label: "Spare", purpose: "", colorHex: nil)

        let cancelled = await model.cancel(discardAccount: true)
        #expect(!cancelled)
        // The flow state survives so the sheet stays open and can retry;
        // lastError is NOT wiped by a reset.
        #expect(model.lastError == "daemon unreachable")
        #expect(model.step == .signIn)
        #expect(model.account != nil)
        #expect(backend.deletedIDs == ["acct-1"])
    }

    @Test("Cancel keeping the account deletes nothing")
    func cancelKeeps() async {
        let backend = StubOnboardingBackend()
        let model = makeModel(backend)
        _ = await model.begin(provider: .codex, label: "Spare", purpose: "", colorHex: nil)

        let cancelled = await model.cancel(discardAccount: false)
        #expect(cancelled)
        #expect(backend.deletedIDs.isEmpty)
        #expect(model.step == .details)
    }

    // MARK: - Issue #99: activation-driven sign-in on current Claude Code

    @Test("An activation-required spec activates the new profile before Terminal opens")
    func activationDrivenBegin() async {
        let backend = StubOnboardingBackend()
        backend.loginResult = activationLogin
        backend.stateAfterMutation = stateWithPriorActive
        let model = makeModel(backend)

        let began = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)
        #expect(began)
        #expect(model.step == .signIn)
        #expect(backend.activatedIDs == ["acct-1"])
        #expect(model.didActivateForLogin)
        // The plain login runs only after the flip; no env-scoped command.
        #expect(backend.launchedCommands == ["'claude' /login"])
    }

    @Test("A verified activation-driven flow restores the previously active account")
    func activationDrivenRestoreAfterVerify() async {
        let backend = StubOnboardingBackend()
        backend.loginResult = activationLogin
        backend.stateAfterMutation = stateWithPriorActive
        let model = makeModel(backend)
        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)

        let confirmed = await model.confirmSignedIn()
        #expect(confirmed)
        #expect(model.step == .confirm)
        // Restore happens strictly AFTER verification.
        #expect(backend.activatedIDs == ["acct-1", "acct-prior"])
        #expect(model.completionWarning == nil)
    }

    @Test("An identity mismatch is a refusal, never a landed account")
    func identityMismatchRefusal() async {
        let backend = StubOnboardingBackend()
        backend.loginResult = activationLogin
        backend.stateAfterMutation = stateWithPriorActive
        backend.verification = AccountVerification(
            account: DeckAccount(id: "acct-1", provider: "claude", label: "Work"),
            authenticated: true,
            identity: "wrong@example.invalid",
            identityMismatch: .init(expected: "intended@example.invalid", actual: "wrong@example.invalid")
        )
        let model = makeModel(backend)
        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)

        let confirmed = await model.confirmSignedIn()
        #expect(!confirmed)
        #expect(model.step == .signIn)
        #expect(model.lastError?.contains("intended@example.invalid") == true)
        #expect(model.lastError?.contains("wrong@example.invalid") == true)
        #expect(backend.refreshCalls == 0)
        // The target stays active for a corrective /login — no restore yet.
        #expect(backend.activatedIDs == ["acct-1"])
    }

    @Test("Cancelling an activation-driven flow restores the prior account before removal")
    func activationDrivenCancelRestores() async {
        let backend = StubOnboardingBackend()
        backend.loginResult = activationLogin
        backend.stateAfterMutation = stateWithPriorActive
        let model = makeModel(backend)
        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)

        let cancelled = await model.cancel(discardAccount: true)
        #expect(cancelled)
        #expect(backend.activatedIDs == ["acct-1", "acct-prior"])
        #expect(backend.deletedIDs == ["acct-1"])
        #expect(model.didActivateForLogin == false)
    }

    @Test("A failed activation surfaces honestly and never opens Terminal")
    func activationFailureBlocksLogin() async {
        let backend = StubOnboardingBackend()
        backend.loginResult = activationLogin
        backend.stateAfterMutation = stateWithPriorActive
        backend.activateError = DaemonClientError.daemonError(message: "account is disabled", status: 400)
        let model = makeModel(backend)

        let began = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)
        #expect(!began)
        #expect(model.lastError == "account is disabled")
        #expect(backend.launchedCommands.isEmpty)
        #expect(model.didActivateForLogin == false)
    }

    @Test("A failed prior-active lookup is surfaced, never silently unrestored")
    func priorLookupFailureWarns() async {
        let backend = StubOnboardingBackend()
        backend.loginResult = activationLogin
        backend.stateError = DaemonClientError.httpStatus(503)
        let model = makeModel(backend)
        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)
        #expect(model.didActivateForLogin)

        // Verification succeeds, but the flow must admit it couldn't learn
        // (and therefore couldn't restore) the previously active account.
        backend.stateError = nil
        let confirmed = await model.confirmSignedIn()
        #expect(confirmed)
        #expect(model.completionWarning?.contains("couldn't read which account was active") == true)
        // Only the target was ever activated — nothing restored.
        #expect(backend.activatedIDs == ["acct-1"])
    }

    @Test("A genuine no-prior-account flow stays silent")
    func noPriorAccountStaysSilent() async {
        let backend = StubOnboardingBackend()
        backend.loginResult = activationLogin
        // Readable state, but nothing else is default for the provider.
        backend.stateAfterMutation = DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Work"),
        ])
        let model = makeModel(backend)
        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)

        let confirmed = await model.confirmSignedIn()
        #expect(confirmed)
        #expect(model.completionWarning == nil)
        #expect(backend.activatedIDs == ["acct-1"])
    }

    @Test("A legacy env-scoped spec never activates anything")
    func legacySpecSkipsActivation() async {
        let backend = StubOnboardingBackend()
        backend.stateAfterMutation = stateWithPriorActive
        let model = makeModel(backend)

        _ = await model.begin(provider: .claude, label: "Work", purpose: "", colorHex: nil)
        _ = await model.confirmSignedIn()
        #expect(backend.activatedIDs.isEmpty)
        #expect(model.didActivateForLogin == false)
    }
}

// MARK: - Wire format (issue #99 additive fields)

@Suite("Login command and verification decoding (issue #99)")
struct LoginCommandDecodingTests {
    @Test("A pre-#99 daemon's login payload decodes with no activation demand")
    func legacyLoginPayload() throws {
        let json = #"{"provider":"claude","command":"'claude' auth login"}"#
        let login = try JSONDecoder().decode(LoginCommand.self, from: Data(json.utf8))
        #expect(login.flow == nil)
        #expect(login.requiresActivation == nil)
        #expect(!login.needsActivationFirst)
    }

    @Test("An activation-driven login payload decodes the flow fields")
    func activationLoginPayload() throws {
        let json = #"{"provider":"claude","command":"'claude' /login","flow":"activation","requiresActivation":true}"#
        let login = try JSONDecoder().decode(LoginCommand.self, from: Data(json.utf8))
        #expect(login.flow == "activation")
        #expect(login.needsActivationFirst)
    }

    @Test("A verification with an identity mismatch decodes the refusal")
    func mismatchVerificationPayload() throws {
        let json = #"""
        {"account":{"id":"a","provider":"claude","label":"Work","enabled":true,"isDefault":false},
         "authenticated":true,"identity":"wrong@example.invalid",
         "identityMismatch":{"expected":"intended@example.invalid","actual":"wrong@example.invalid"}}
        """#
        let verification = try JSONDecoder().decode(AccountVerification.self, from: Data(json.utf8))
        #expect(verification.authenticated)
        #expect(verification.identityMismatch?.expected == "intended@example.invalid")
        #expect(verification.identityMismatch?.actual == "wrong@example.invalid")
    }

    @Test("A pre-#99 verification payload decodes with no mismatch")
    func legacyVerificationPayload() throws {
        let json = #"""
        {"account":{"id":"a","provider":"claude","label":"Work","enabled":true,"isDefault":false},
         "authenticated":true,"identity":"user@example.invalid"}
        """#
        let verification = try JSONDecoder().decode(AccountVerification.self, from: Data(json.utf8))
        #expect(verification.identityMismatch == nil)
    }
}
