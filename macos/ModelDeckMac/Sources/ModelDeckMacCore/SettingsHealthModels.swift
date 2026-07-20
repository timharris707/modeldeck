import Foundation
import Observation

// Issue #32 — Settings health actions: the per-account "Sign in again" flow
// (Accounts pane) and the CLI update pill (General pane). Pure orchestration
// over protocol seams, same pattern as the other Settings models.

// MARK: - Per-account sign in again

/// Daemon seam for re-authenticating an existing roster account;
/// `DaemonClient` conforms via its issue-#8 endpoints.
public protocol AccountReauthenticating: Sendable {
    /// `GET /api/accounts/:id/login` — the provider-owned login command for
    /// this account's isolated profile home (`CLAUDE_CONFIG_DIR=<profileRef>
    /// claude auth login` / `CODEX_HOME=<profileRef> codex login`), built by
    /// the daemon so the app never assembles shell commands itself.
    func loginCommand(accountID: String) async throws -> LoginCommand
    /// `POST /api/accounts/:id/verify` — provider status read-back (never a
    /// login or logout).
    func verifyAccount(accountID: String) async throws -> AccountVerification
}

extension DaemonClient: AccountReauthenticating {}

/// "Sign in again" from the Accounts roster (issue #32 item 2). Reuses the
/// add-account flow's exact machinery: the daemon supplies the per-profile
/// login command, the app layer's `LoginLaunching` runs it in the user's own
/// Terminal (so the provider's browser OAuth callback completes against a
/// process that stays alive), and the daemon's verify endpoint re-probes
/// health afterwards. ModelDeck never sees credentials.
@MainActor
public final class AccountSignInModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        /// Fetching the login command from the daemon.
        case launching
        /// The provider's login is running in Terminal; the command is kept
        /// for relaunch/copy if the user closed the window.
        case awaitingSignIn(command: String)
        /// The daemon is reading back the profile's auth status.
        case verifying
    }

    /// At most one sign-in flow at a time — per-account state keyed by id.
    @Published public private(set) var phases: [String: Phase] = [:]
    @Published public private(set) var errors: [String: String] = [:]

    /// Fresh daemon state after a verified sign-in (per-account authState
    /// now healthy); pushed into `MenuBarStatusModel` by the app.
    public var onStateChanged: ((DeckState) -> Void)?
    /// Fired after a verified sign-in so the app can refresh the cached CLI
    /// probe (General pane chip) without a forced re-probe.
    public var onSignedIn: (() -> Void)?

    private let reauth: any AccountReauthenticating
    private let launcher: any LoginLaunching
    private let stateProvider: any DeckStateProviding

    public init(
        reauth: any AccountReauthenticating,
        launcher: any LoginLaunching,
        stateProvider: any DeckStateProviding
    ) {
        self.reauth = reauth
        self.launcher = launcher
        self.stateProvider = stateProvider
    }

    public func phase(for accountID: String) -> Phase? { phases[accountID] }
    public func error(for accountID: String) -> String? { errors[accountID] }

    /// Kick off the flow: fetch the daemon's login command for this account
    /// and run it in Terminal. A failed Terminal launch is not fatal — the
    /// command stays available for relaunch.
    ///
    /// Every post-await write re-checks the phase first: if the user
    /// cancelled while the daemon call was in flight, the late result is
    /// dropped — no state resurrection and, crucially, no Terminal launch
    /// for a flow the user already dismissed.
    public func beginSignIn(account: DeckAccount) async {
        guard phases[account.id] == nil else { return }
        phases[account.id] = .launching
        errors[account.id] = nil
        let command: String
        do {
            command = try await reauth.loginCommand(accountID: account.id).command
        } catch {
            guard phases[account.id] == .launching else { return } // cancelled mid-fetch
            phases[account.id] = nil
            errors[account.id] = SettingsSyncModel.message(for: error)
            return
        }
        guard phases[account.id] == .launching else { return } // cancelled mid-fetch
        phases[account.id] = .awaitingSignIn(command: command)
        launch(command: command, accountID: account.id)
    }

    /// Re-open Terminal with the stored login command (e.g. after denying
    /// the automation prompt the first time).
    public func relaunch(accountID: String) {
        guard case .awaitingSignIn(let command) = phases[accountID] else { return }
        errors[accountID] = nil
        launch(command: command, accountID: accountID)
    }

    /// The user says the provider login finished — ask the daemon to verify.
    /// Stays on the awaiting step (with an honest message) while the provider
    /// still reports the profile signed out.
    @discardableResult
    public func confirmSignedIn(account: DeckAccount) async -> Bool {
        guard case .awaitingSignIn(let command) = phases[account.id] else { return false }
        phases[account.id] = .verifying
        errors[account.id] = nil
        let verification: AccountVerification
        do {
            verification = try await reauth.verifyAccount(accountID: account.id)
        } catch {
            guard phases[account.id] == .verifying else { return false } // cancelled mid-verify
            phases[account.id] = .awaitingSignIn(command: command)
            errors[account.id] = SettingsSyncModel.message(for: error)
            return false
        }
        // Cancelled while the daemon was verifying — drop the late result.
        guard phases[account.id] == .verifying else { return false }
        guard verification.authenticated else {
            phases[account.id] = .awaitingSignIn(command: command)
            errors[account.id] = "Still signed out. Finish the provider's login in Terminal, then verify again."
            return false
        }
        phases[account.id] = nil
        errors[account.id] = nil
        if let fresh = try? await stateProvider.deckState() {
            onStateChanged?(fresh)
        }
        onSignedIn?()
        return true
    }

    /// Abandon the flow for this account (nothing to undo — the login ran,
    /// or didn't, entirely in the provider's own Terminal session).
    public func cancel(accountID: String) {
        phases[accountID] = nil
        errors[accountID] = nil
    }

    private func launch(command: String, accountID: String) {
        do {
            try launcher.launchLogin(command: command)
        } catch {
            errors[accountID] = "Couldn't open Terminal — run the login yourself, then click Verify. (\(error.localizedDescription))"
        }
    }
}

// MARK: - CLI update pill

/// Daemon seam for the CLI updater; `DaemonClient` conforms.
public protocol ToolUpdating: Sendable {
    func updateTool(_ tool: String) async throws -> ToolUpdateResult
}

extension DaemonClient: ToolUpdating {}

/// Update-pill state machine (issue #32 item 3). One phase per tool key
/// ("claude" / "codex"): idle → running → succeeded/failed. Client-side
/// re-entrancy guard on top of the daemon's single-flight coalescing; the
/// pill disables while running.
@MainActor
public final class ToolUpdateModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case running
        case succeeded(newVersion: String?)
        case failed(message: String)
    }

    @Published public private(set) var phases: [String: Phase] = [:]

    /// Fired after every finished update attempt (success or failure) so the
    /// app can re-read the daemon's tool probe cache — the daemon already
    /// refreshed it after installing, so a cached read suffices.
    public var onFinished: (() -> Void)?

    private let updater: any ToolUpdating

    public init(updater: any ToolUpdating) {
        self.updater = updater
    }

    public func phase(for tool: String) -> Phase? { phases[tool] }
    public func isRunning(_ tool: String) -> Bool { phases[tool] == .running }

    public func update(tool: String) async {
        guard phases[tool] != .running else { return }
        phases[tool] = .running
        do {
            let result = try await updater.updateTool(tool)
            phases[tool] = result.ok
                ? .succeeded(newVersion: result.newVersion)
                : .failed(message: result.failureSummary)
        } catch {
            // 409 (install method not auto-updatable) and a missing endpoint
            // (daemon without the update backend) both land here with the
            // daemon's own message — shown verbatim, no pretending.
            phases[tool] = .failed(message: SettingsSyncModel.message(for: error))
        }
        onFinished?()
    }

    /// Clear a finished outcome (the pill's dismiss affordance).
    public func dismissOutcome(tool: String) {
        guard phases[tool] != .running else { return }
        phases[tool] = nil
    }
}
