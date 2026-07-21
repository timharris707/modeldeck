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
    /// Issue #99: true when the daemon's login spec required activating the
    /// new profile before the sign-in (Claude Code >= 2.1.216 keys
    /// credentials off the resolved ~/.claude). The sheet explains the flip.
    @Published public private(set) var didActivateForLogin = false

    /// Issue #99: the provider's previously active account, captured before
    /// the sign-in activation so it can be restored once the flow settles.
    private var priorActiveAccountID: String?
    /// True when the pre-activation state read FAILED — distinct from a
    /// genuine "no prior active account". A failed lookup means the restore
    /// silently can't happen, and honesty demands saying so instead of
    /// leaving the new profile active with zero warning.
    private var priorActiveLookupFailed = false

    /// Fresh daemon state after the flow lands (or after a cancel that
    /// removed the created account); pushed into `MenuBarStatusModel`.
    public var onStateChanged: ((DeckState) -> Void)?

    private let onboarding: any AccountOnboarding
    private let launcher: any LoginLaunching
    private let stateProvider: any DeckStateProviding
    private let activator: any AccountActivating

    public init(
        onboarding: any AccountOnboarding,
        launcher: any LoginLaunching,
        stateProvider: any DeckStateProviding,
        activator: any AccountActivating
    ) {
        self.onboarding = onboarding
        self.launcher = launcher
        self.stateProvider = stateProvider
        self.activator = activator
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
            // Issue #99: on current Claude Code the credential lands in
            // whichever profile ~/.claude resolves to, so the daemon's spec
            // demands activating the new profile BEFORE the plain login.
            // The prior active account is captured first (best effort) so
            // a successful flow can put it back.
            if login.needsActivationFirst {
                priorActiveAccountID = await priorActiveAccountID(
                    provider: created.provider,
                    excluding: created.id
                )
                _ = try await activator.activateAccount(id: created.id)
                didActivateForLogin = true
            }
            loginCommand = login.command
            step = .signIn
            launchLogin()
            return true
        } catch {
            lastError = SettingsSyncModel.message(for: error)
            return false
        }
    }

    /// The provider's current default (active) account id, for restoring
    /// after an activation-driven sign-in. A failed state read is tracked in
    /// `priorActiveLookupFailed` — never conflated with a genuine
    /// "no prior active account", which stays silent.
    private func priorActiveAccountID(provider: String, excluding accountID: String) async -> String? {
        priorActiveLookupFailed = false
        do {
            let state = try await stateProvider.deckState()
            return state.accounts.first {
                $0.provider == provider && $0.isDefault && $0.id != accountID
            }?.id
        } catch {
            priorActiveLookupFailed = true
            return nil
        }
    }

    /// Issue #99: put the previously active account back after an
    /// activation-driven sign-in settled (verified success or cancel).
    /// Best effort — a failed restore is reported, never fatal.
    private func restorePriorActiveIfNeeded() async -> String? {
        guard didActivateForLogin, let prior = priorActiveAccountID else { return nil }
        do {
            _ = try await activator.activateAccount(id: prior)
            priorActiveAccountID = nil
            return nil
        } catch {
            return "The previously active account could not be restored — "
                + "re-activate it from Settings → Accounts. "
                + "(\(SettingsSyncModel.message(for: error)))"
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
        // Issue #99: the daemon refused the sign-in because the resulting
        // identity belongs to a different account. Never a success — stay on
        // the sign-in step with an honest message. The target profile stays
        // active so a corrective /login lands in the right place.
        if let mismatch = verification.identityMismatch {
            lastError = Self.identityMismatchMessage(mismatch)
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
        // Issue #99: the sign-in is verified, so the pre-flow active account
        // can come back now (adding an account never used to change the
        // active one). Restore happens strictly AFTER verification — the
        // identity read-back is only trustworthy while the target is active.
        if let warning = await restorePriorActiveIfNeeded() {
            completionWarning = [completionWarning, warning].compactMap { $0 }.joined(separator: " ")
        }
        // A failed pre-activation lookup means the restore above silently
        // had nothing to work with — say so instead of leaving the switch
        // unannounced (never-silent, per this file's contract).
        if didActivateForLogin, priorActiveLookupFailed {
            let warning = "ModelDeck couldn't read which account was active before this "
                + "sign-in, so nothing was restored — this profile is now the active one. "
                + "Re-activate another account from Settings → Accounts if needed."
            completionWarning = [completionWarning, warning].compactMap { $0 }.joined(separator: " ")
        }
        await publishFreshState()
        return true
    }

    /// Honest, provider-neutral mismatch message (issue #99). Identities are
    /// shown in the UI only — never logged.
    static func identityMismatchMessage(_ mismatch: AccountVerification.IdentityMismatch) -> String {
        let actual = mismatch.actual ?? "a different account"
        let expected = mismatch.expected ?? "the intended account"
        return "The sign-in landed as \(actual), but this account is \(expected). "
            + "Nothing was recorded. Run the login again and sign in as \(expected)."
    }

    /// Cancel mid-flow. When an account was already created, `discardAccount`
    /// decides whether to remove ModelDeck's reference (reference-only delete
    /// — provider credentials are never touched) or keep it for a later
    /// sign-in from the roster. Returns false — leaving the flow state and
    /// `lastError` intact so the sheet stays open and shows the failure —
    /// when the requested removal didn't happen.
    @discardableResult
    public func cancel(discardAccount: Bool) async -> Bool {
        // Issue #99: an activation-driven flow flipped the active account to
        // the new profile — a cancelled flow must not silently leave it
        // there. Restore FIRST (so a discarded account is never the default
        // when it gets deleted); a failed restore keeps the sheet open with
        // the honest error rather than silently abandoning the flip.
        if let warning = await restorePriorActiveIfNeeded() {
            lastError = warning
            return false
        }
        if discardAccount, let account {
            do {
                try await onboarding.deleteAccount(id: account.id)
            } catch {
                lastError = SettingsSyncModel.message(for: error)
                return false
            }
        }
        if discardAccount || didActivateForLogin {
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
        didActivateForLogin = false
        priorActiveAccountID = nil
        priorActiveLookupFailed = false
    }

    private func publishFreshState() async {
        guard let onStateChanged else { return }
        if let fresh = try? await stateProvider.deckState() {
            onStateChanged(fresh)
        }
    }
}
