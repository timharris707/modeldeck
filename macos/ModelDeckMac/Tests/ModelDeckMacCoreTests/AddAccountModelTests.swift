import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #8 — add-account flow model. All identities in these fixtures are
// placeholders (user@example.invalid), per the repo privacy rule.

/// Scriptable daemon + terminal seams for the add-account flow.
final class StubOnboardingBackend: AccountOnboarding, LoginLaunching, DeckStateProviding, @unchecked Sendable {
    private let lock = NSLock()
    var createError: Error?
    var loginCommandError: Error?
    var verifyError: Error?
    var refreshError: Error?
    var deleteError: Error?
    var launchError: Error?
    var verification: AccountVerification?
    var stateAfterMutation = DeckState()
    private(set) var created: [AccountCreate] = []
    private(set) var loginCommandRequests: [String] = []
    private(set) var launchedCommands: [String] = []
    private(set) var verifiedIDs: [String] = []
    private(set) var refreshCalls = 0
    private(set) var deletedIDs: [String] = []
    private(set) var stateReads = 0

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
            return LoginCommand(provider: "claude", command: "CLAUDE_CONFIG_DIR='/profiles/x' 'claude' auth login")
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
        locked {
            stateReads += 1
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
        AddAccountModel(onboarding: backend, launcher: backend, stateProvider: backend)
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
}
