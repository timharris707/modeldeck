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
        /// Issue #99: the daemon's spec demanded activation-driven sign-in;
        /// the target account is being activated before the login runs.
        case activating
        /// The provider's login is running in Terminal; the command is kept
        /// for relaunch/copy if the user closed the window. Issue #217: a
        /// background poller verifies periodically so a finished login
        /// usually clears the flow without a Verify click.
        case awaitingSignIn(command: String)
        /// The daemon is reading back the profile's auth status.
        case verifying
    }

    /// At most one sign-in flow at a time — per-account state keyed by id.
    @Published public private(set) var phases: [String: Phase] = [:]
    @Published public private(set) var errors: [String: String] = [:]

    /// Issue #99: per-account restore bookkeeping for activation-driven
    /// sign-ins — the provider's previously active account id, captured
    /// before the flip so the flow can put it back when it settles.
    private var priorActiveByAccountID: [String: String] = [:]
    private var activatedForLogin: Set<String> = []

    /// Issue #217: while the provider's login runs in Terminal, the flow
    /// polls the daemon's verify endpoint in the background so a finished
    /// login usually clears the card without a Verify click. One poller per
    /// in-flight flow, keyed by account id; dies with the flow.
    private var autoVerifyTasks: [String: Task<Void, Never>] = [:]

    /// Clock seam for the auto-verify poller; tests swap in a gated stub.
    var autoVerifySleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }

    /// Issue #217: gentle backoff — first check 5s after Terminal opens
    /// (a browser OAuth is rarely faster), easing to a steady 10s cap so a
    /// slow login never sees the daemon hammered.
    static let autoVerifyDelays: [Duration] = [.seconds(5), .seconds(7), .seconds(10)]

    /// CodeRabbit PR #218: the poller is a convenience, not a watchdog —
    /// each verify spawns a provider CLI daemon-side, so an abandoned card
    /// must not keep spawning them forever. After this budget the poller
    /// stops and the manual Verify button is the completion path. Instance
    /// var so tests can shrink it.
    var autoVerifyDeadline: Duration = .seconds(600)

    /// Fresh daemon state after a verified sign-in (per-account authState
    /// now healthy); pushed into `MenuBarStatusModel` by the app.
    public var onStateChanged: ((DeckState) -> Void)?
    /// Fired after a verified sign-in so the app can refresh the cached CLI
    /// probe (General pane chip) without a forced re-probe.
    public var onSignedIn: (() -> Void)?

    private let reauth: any AccountReauthenticating
    private let launcher: any LoginLaunching
    private let stateProvider: any DeckStateProviding
    private let activator: any AccountActivating

    public init(
        reauth: any AccountReauthenticating,
        launcher: any LoginLaunching,
        stateProvider: any DeckStateProviding,
        activator: any AccountActivating
    ) {
        self.reauth = reauth
        self.launcher = launcher
        self.stateProvider = stateProvider
        self.activator = activator
    }

    public func phase(for accountID: String) -> Phase? { phases[accountID] }
    public func error(for accountID: String) -> String? { errors[accountID] }

    /// Kick off the flow: fetch the daemon's login command for this account
    /// and run it in Terminal. A failed Terminal launch is not fatal — the
    /// command stays available for relaunch.
    ///
    /// Issue #99: when the daemon's spec says `requiresActivation` (Claude
    /// Code >= 2.1.216 keys credentials off the resolved ~/.claude), the
    /// flow activates the target account first — after capturing the
    /// previously active one for restore — and only then opens Terminal
    /// with the plain login.
    ///
    /// Every post-await write re-checks the phase first: if the user
    /// cancelled while the daemon call was in flight, the late result is
    /// dropped — no state resurrection and, crucially, no Terminal launch
    /// for a flow the user already dismissed.
    public func beginSignIn(account: DeckAccount) async {
        guard phases[account.id] == nil else { return }
        phases[account.id] = .launching
        errors[account.id] = nil
        let login: LoginCommand
        do {
            login = try await reauth.loginCommand(accountID: account.id)
        } catch {
            guard phases[account.id] == .launching else { return } // cancelled mid-fetch
            phases[account.id] = nil
            errors[account.id] = SettingsSyncModel.message(for: error)
            return
        }
        guard phases[account.id] == .launching else { return } // cancelled mid-fetch
        if login.needsActivationFirst {
            phases[account.id] = .activating
            let prior = await priorActiveAccountID(provider: account.provider, excluding: account.id)
            guard phases[account.id] == .activating else { return } // cancelled mid-read
            do {
                _ = try await activator.activateAccount(id: account.id)
            } catch {
                guard phases[account.id] == .activating else { return } // cancelled mid-activate
                phases[account.id] = nil
                errors[account.id] = SettingsSyncModel.message(for: error)
                return
            }
            guard phases[account.id] == .activating else {
                // Cancelled while the daemon was flipping: the flip happened,
                // so put the prior account back rather than keeping a switch
                // the user never asked to keep. The bookkeeping slots were
                // never filled for this attempt, so restore the captured
                // value directly.
                await activatePrior(prior, accountID: account.id)
                return
            }
            priorActiveByAccountID[account.id] = prior
            activatedForLogin.insert(account.id)
        }
        phases[account.id] = .awaitingSignIn(command: login.command)
        launch(command: login.command, accountID: account.id)
        startAutoVerify(account: account)
    }

    /// Issue #217: the background poller behind `.awaitingSignIn`. Sleeps
    /// first (never probes the instant Terminal opens), then checks; a flow
    /// that ended while it slept ends the poller too. A manual Verify in
    /// flight (`.verifying`) just skips the beat — if that verify fails back
    /// to awaiting, polling resumes on the next tick.
    private func startAutoVerify(account: DeckAccount) {
        stopAutoVerify(accountID: account.id)
        autoVerifyTasks[account.id] = Task { [weak self] in
            var attempt = 0
            var elapsed = Duration.zero
            while !Task.isCancelled {
                guard let self else { return }
                let delays = Self.autoVerifyDelays
                let delay = delays[min(attempt, delays.count - 1)]
                attempt += 1
                elapsed += delay
                guard elapsed <= self.autoVerifyDeadline else { return }
                do { try await self.autoVerifySleep(delay) } catch { return }
                switch self.phases[account.id] {
                case .awaitingSignIn:
                    if await self.autoVerifyOnce(account: account) { return }
                case .verifying:
                    break
                default:
                    return
                }
            }
        }
    }

    /// One silent background check; returns true when it completed the flow
    /// (the poller is done). Only a clean success may touch state: the user
    /// may still be mid-login in the provider's browser, so a signed-out
    /// read, an identity mismatch, and a transport error are all invisible
    /// here — the manual Verify button stays the honest reporter for those,
    /// and cannot be spammed over by the poller.
    private func autoVerifyOnce(account: DeckAccount) async -> Bool {
        guard let verification = try? await reauth.verifyAccount(accountID: account.id) else { return false }
        guard verification.authenticated, verification.identityMismatch == nil else { return false }
        // Cancel or a manual Verify may have taken over while the daemon
        // read — the late success belongs to that path's outcome, not this
        // poller's.
        guard case .awaitingSignIn = phases[account.id] else { return false }
        await completeVerifiedSignIn(accountID: account.id, cancelPoller: false)
        return true
    }

    private func stopAutoVerify(accountID: String) {
        autoVerifyTasks.removeValue(forKey: accountID)?.cancel()
    }

    /// Shared success tail for the manual Verify and the issue-#217 poller.
    /// Issue #99: the previously active account comes back strictly AFTER
    /// verification — the identity read-back is only trustworthy while the
    /// target profile is active.
    ///
    /// CodeRabbit PR #218: `cancelPoller: false` is the poller completing
    /// ITSELF — cancelling its own task here would poison the restore and
    /// state-refresh awaits below (DaemonClient's URLSession calls are
    /// cancellation-aware), so the poller only unregisters and returns via
    /// `autoVerifyOnce`. The manual path cancels the (elsewhere-suspended)
    /// poller outright.
    private func completeVerifiedSignIn(accountID: String, cancelPoller: Bool) async {
        if cancelPoller {
            stopAutoVerify(accountID: accountID)
        } else {
            autoVerifyTasks[accountID] = nil
        }
        phases[accountID] = nil
        errors[accountID] = nil
        await restorePriorActive(accountID: accountID)
        if let fresh = try? await stateProvider.deckState() {
            onStateChanged?(fresh)
        }
        onSignedIn?()
    }

    /// The provider's current default (active) account id, for restoring
    /// after an activation-driven sign-in. Best effort: an unreadable state
    /// simply means there is nothing to restore.
    private func priorActiveAccountID(provider: String, excluding accountID: String) async -> String? {
        guard let state = try? await stateProvider.deckState() else { return nil }
        return state.accounts.first {
            $0.provider == provider && $0.isDefault && $0.id != accountID
        }?.id
    }

    /// Issue #99: put the previously active account back once the flow
    /// settles. Reads AND clears this account's bookkeeping synchronously
    /// (before the first await) so no concurrent reader can see stale slots.
    @discardableResult
    private func restorePriorActive(accountID: String) async -> Bool {
        let prior = priorActiveByAccountID.removeValue(forKey: accountID)
        activatedForLogin.remove(accountID)
        return await activatePrior(prior, accountID: accountID)
    }

    /// Activates an explicitly captured prior account id. Deliberately never
    /// touches the shared bookkeeping slots — a stale cancel task running
    /// after a retry began must not clobber the newer flow's captured prior.
    /// Best effort: a failed restore lands in the account's error slot,
    /// never blocks the flow outcome.
    @discardableResult
    private func activatePrior(_ prior: String?, accountID: String) async -> Bool {
        guard let prior else { return true }
        do {
            _ = try await activator.activateAccount(id: prior)
            return true
        } catch {
            errors[accountID] = "The previously active account could not be restored — "
                + "re-activate it from Settings → Accounts. "
                + "(\(SettingsSyncModel.message(for: error)))"
            return false
        }
    }

    /// Issue #213: the deck card's inline duplicate re-login has no Settings
    /// window to fall back to — a flow that fails to START (the clicked
    /// account resolved to nothing against fresh state) must land its reason
    /// in this account's error slot, where the click site renders it.
    /// Refused while a flow is in flight: the phase UI already owns the slot
    /// and a live flow's errors come from the flow itself.
    public func noteStartFailure(accountID: String, message: String) {
        guard phases[accountID] == nil else { return }
        errors[accountID] = message
    }

    /// Issue #213: explicit dismiss for an error shown with no active phase
    /// (the deck card's xmark). Mid-flow errors stay — the flow's own
    /// actions (verify/relaunch/cancel) clear them.
    public func dismissError(accountID: String) {
        guard phases[accountID] == nil else { return }
        errors[accountID] = nil
    }

    /// Issue #213: the start-failure wording for a duplicate re-login whose
    /// clicked account no longer resolves against fresh daemon state. In
    /// Core so the message ships with the mechanism it explains (and stays
    /// testable beside it).
    public static let duplicateReloginUnresolvedMessage =
        "Re-login didn't start: this account no longer matches the duplicate "
        + "warning (it may have been resolved or removed). Refresh the deck "
        + "if the warning persists."

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
        // Issue #99: the daemon refused the sign-in — the resulting identity
        // belongs to a different account. Never a success. The target stays
        // active (no restore) so a corrective /login lands in the right
        // profile's credential slot.
        if let mismatch = verification.identityMismatch {
            phases[account.id] = .awaitingSignIn(command: command)
            errors[account.id] = AddAccountModel.identityMismatchMessage(mismatch)
            return false
        }
        await completeVerifiedSignIn(accountID: account.id, cancelPoller: true)
        return true
    }

    /// Abandon the flow for this account (the login ran, or didn't, entirely
    /// in the provider's own Terminal session). Issue #99: if the flow had
    /// activated the target for an activation-driven sign-in, the previously
    /// active account is restored in the background — a cancelled sign-in
    /// must not silently keep the switch.
    public func cancel(accountID: String) {
        // Capture AND clear the restore bookkeeping synchronously: an
        // immediate retry beginSignIn for this account must find clean
        // slots, and the background restore below must use the value
        // captured HERE — never re-read a shared slot a newer flow may have
        // refilled in the meantime.
        let needsRestore = activatedForLogin.remove(accountID) != nil
        let prior = priorActiveByAccountID.removeValue(forKey: accountID)
        stopAutoVerify(accountID: accountID)
        phases[accountID] = nil
        errors[accountID] = nil
        guard needsRestore else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.activatePrior(prior, accountID: accountID)
            if let fresh = try? await self.stateProvider.deckState() {
                self.onStateChanged?(fresh)
            }
        }
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
