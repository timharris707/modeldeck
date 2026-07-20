import Foundation
import Observation

// Issue #8 — the add-account flow's view model (spec "Add account",
// mockups §05). Three steps:
//   1. details  — provider + label + purpose + color; the daemon creates the
//                 isolated owner-only profile home.
//   2. signIn   — the provider's own login command runs in the user's
//                 terminal; browser OAuth is entirely the provider's flow and
//                 ModelDeck never sees or stores credentials.
//   3. confirm  — the daemon reads back the authenticated identity ("Signed
//                 in as …"), pulls the first usage snapshot, and the account
//                 lands in the deck.
// Safety: nothing here (or in the daemon endpoints it calls) ever runs
// `claude auth logout` — the known pitfall in docs/HANDOFF.md.

/// Daemon seam for the add-account flow; `DaemonClient` conforms.
public protocol AccountOnboarding: Sendable {
    func createAccount(_ create: AccountCreate) async throws -> DeckAccount
    func loginCommand(accountID: String) async throws -> LoginCommand
    func verifyAccount(accountID: String) async throws -> AccountVerification
    func refreshUsage() async throws
    func deleteAccount(id: String) async throws
}

extension DaemonClient: AccountOnboarding {}

/// Seam for step 2's "drive the provider's login": the app layer opens the
/// user's terminal with the exact command the daemon returned. Kept as a
/// protocol so the flow is testable without touching Terminal.
public protocol LoginLaunching: Sendable {
    func launchLogin(command: String) throws
}

@MainActor
public final class AddAccountModel: ObservableObject {
    public enum Step: Equatable, Sendable {
        case details
        case signIn
        case confirm
    }

    @Published public private(set) var step: Step = .details
    @Published public private(set) var isBusy = false
    @Published public private(set) var lastError: String?
    /// The account created in step 1 (nil until then).
    @Published public private(set) var account: DeckAccount?
    /// The provider's login command — kept visible so the user can copy and
    /// run it manually if the terminal launch fails or they close the window.
    @Published public private(set) var loginCommand: String?
    /// The identity the provider reported after verification; nil when the
    /// provider's status output doesn't reveal one.
    @Published public private(set) var identity: String?
    /// Non-fatal step 3 problem (e.g. the first usage pull failed). The flow
    /// still completes; the deck will fill in on the next refresh.
    @Published public private(set) var completionWarning: String?

    /// Fresh daemon state after the flow lands (or after a cancel that
    /// removed the created account); pushed into `MenuBarStatusModel`.
    public var onStateChanged: ((DeckState) -> Void)?

    private let onboarding: any AccountOnboarding
    private let launcher: any LoginLaunching
    private let stateProvider: any DeckStateProviding

    public init(
        onboarding: any AccountOnboarding,
        launcher: any LoginLaunching,
        stateProvider: any DeckStateProviding
    ) {
        self.onboarding = onboarding
        self.launcher = launcher
        self.stateProvider = stateProvider
    }

    /// Step 1 → 2: create the account (the daemon builds the profile home),
    /// fetch the provider's login command, and kick it off in the terminal.
    /// A failed terminal launch is not fatal — the command stays available
    /// for copy/paste and retry.
    @discardableResult
    public func begin(provider: DeckProvider, label: String, purpose: String, colorHex: String?) async -> Bool {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLabel.isEmpty else {
            lastError = "The label can't be empty."
            return false
        }
        guard !isBusy else { return false }
        isBusy = true
        lastError = nil
        defer { isBusy = false }
        do {
            let created = try await onboarding.createAccount(AccountCreate(
                provider: provider.rawValue,
                label: trimmedLabel,
                purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                color: colorHex
            ))
            account = created
            let login = try await onboarding.loginCommand(accountID: created.id)
            loginCommand = login.command
            step = .signIn
            launchLogin()
            return true
        } catch {
            lastError = SettingsSyncModel.message(for: error)
            return false
        }
    }

    /// (Re-)open the terminal with the provider's login command.
    public func launchLogin() {
        guard let loginCommand else { return }
        do {
            try launcher.launchLogin(command: loginCommand)
        } catch {
            lastError = "Couldn't open Terminal — copy the command below and run it yourself. (\(error.localizedDescription))"
        }
    }

    /// Step 2 → 3: ask the daemon to read back the authenticated identity.
    /// Stays on the sign-in step (returning false) while the provider still
    /// reports the profile as signed out.
    @discardableResult
    public func confirmSignedIn() async -> Bool {
        guard let account, !isBusy else { return false }
        isBusy = true
        lastError = nil
        defer { isBusy = false }
        let verification: AccountVerification
        do {
            verification = try await onboarding.verifyAccount(accountID: account.id)
        } catch {
            lastError = SettingsSyncModel.message(for: error)
            return false
        }
        guard verification.authenticated else {
            lastError = "This profile isn't signed in yet. Finish the provider's login in Terminal, then try again."
            return false
        }
        self.account = verification.account
        identity = verification.identity
        step = .confirm
        // First usage snapshot + fresh state. Failures here are soft: the
        // account exists and is signed in; the deck fills in on next refresh.
        do {
            try await onboarding.refreshUsage()
        } catch {
            completionWarning = "Signed in, but the first usage refresh failed: \(SettingsSyncModel.message(for: error))"
        }
        await publishFreshState()
        return true
    }

    /// Cancel mid-flow. When an account was already created, `discardAccount`
    /// decides whether to remove ModelDeck's reference (reference-only delete
    /// — provider credentials are never touched) or keep it for a later
    /// sign-in from the roster. Returns false — leaving the flow state and
    /// `lastError` intact so the sheet stays open and shows the failure —
    /// when the requested removal didn't happen.
    @discardableResult
    public func cancel(discardAccount: Bool) async -> Bool {
        if discardAccount, let account {
            do {
                try await onboarding.deleteAccount(id: account.id)
            } catch {
                lastError = SettingsSyncModel.message(for: error)
                return false
            }
            await publishFreshState()
        }
        reset()
        return true
    }

    /// Back to a pristine step 1 (used when the sheet reopens).
    public func reset() {
        step = .details
        isBusy = false
        lastError = nil
        account = nil
        loginCommand = nil
        identity = nil
        completionWarning = nil
    }

    private func publishFreshState() async {
        guard let onStateChanged else { return }
        if let fresh = try? await stateProvider.deckState() {
            onStateChanged(fresh)
        }
    }
}
