import Foundation
import Observation

// Issue #176 — the UI half of idle-account renewal (spec: #173 findings
// §B2/§B3; Tim decision 2026-07-31: the scheduled variant is the product
// direction — zero user effort, honest disclosure of the tiny invocation and
// its possible 5-hour-window side effect). The daemon owns the entire op
// (process guard → activation flip → trivial CLI invocation → restore →
// verify); this model only asks for it, renders progress, and relays the
// daemon's decided outcome calmly. Nothing here ever touches credentials.

/// Daemon seam for the renew op; `DaemonClient` conforms and tests stub it.
public protocol AccountRenewing: Sendable {
    /// `POST /api/accounts/:id/renew`.
    func renewAccount(id: String) async throws -> AccountRenewal
}

extension DaemonClient: AccountRenewing {}

/// Which renew affordance an account row shows, if any (issue #176).
public enum AccountRenewAction: Equatable, Sendable {
    /// The small "Renew now" action.
    case renewNow
    /// The honest explanation instead of the button: this profile routes
    /// authentication elsewhere, so ModelDeck's renewal can't apply. Never
    /// an error tone — the profile is working exactly as configured.
    case authOverridden
}

/// Everything a row (deck card or Settings roster) needs to render its renew
/// state: derived by `AccountRenewModel.presentation(for:)`, plain values so
/// child views stay free of the model.
public struct AccountRenewPresentation: Equatable, Sendable {
    public var action: AccountRenewAction
    public var isRenewing: Bool
    /// Calm one-line outcome of the last finished attempt (daemon `detail`
    /// preferred verbatim); nil until an attempt finishes.
    public var outcomeText: String?
    /// Transport-level failure (daemon unreachable, 409 renewal-in-flight).
    public var errorText: String?

    public init(
        action: AccountRenewAction,
        isRenewing: Bool = false,
        outcomeText: String? = nil,
        errorText: String? = nil
    ) {
        self.action = action
        self.isRenewing = isRenewing
        self.outcomeText = outcomeText
        self.errorText = errorText
    }
}

/// Pure derivations + single-source strings for the renew surfaces.
public enum AccountRenew {
    /// The honest cost sheet (#173 §B2), stated wherever the action is
    /// offered: renewal may run one tiny invocation and can open a window.
    public static let disclosure = "Renewal may run one tiny Claude request and can start a fresh 5-hour usage window."

    /// Issue #176: the authOverride explanation — honest, never an error
    /// tone. The profile is configured to authenticate through its own
    /// mechanism; ModelDeck's renewal would be lying if it claimed to help.
    public static let authOverrideExplanation = "This profile routes authentication elsewhere — automatic renewal isn't available."

    /// The roster row's short caption for the authOverride state; the full
    /// sentence stays in the tooltip/explanation (single source above).
    public static let authOverrideShort = "Renewal handled elsewhere"

    /// Which renew affordance this account earns, if any. Strictly limited
    /// to the expired-idle state (#149 `.idleSignIn`: signin-required with
    /// reason "expired") on Claude accounts whose daemon reported the
    /// `renew` capability object — a nil object (old daemon, Codex account)
    /// renders nothing new, and a genuinely signed-out account keeps its
    /// alarm chip untouched (renewal can't fix a missing sign-in).
    public static func action(for account: DeckAccount) -> AccountRenewAction? {
        guard account.provider == "claude",
              account.healthChip == .idleSignIn,
              let renew = account.renew
        else { return nil }
        if renew.authOverride { return .authOverridden }
        return renew.available ? .renewNow : nil
    }

    /// Calm one-line text for a decided outcome. The daemon's own `detail`
    /// sentence is preferred verbatim; the fallbacks below cover a daemon
    /// that sent none. Refusals stay matter-of-fact — never alarm copy.
    public static func outcomeText(for renewal: AccountRenewal) -> String {
        if let detail = renewal.detail, !detail.isEmpty {
            return detail
        }
        switch renewal.outcome {
        case "renewed":
            return "Sign-in renewed."
        case "busy":
            return "Claude is in use right now — renewal will retry later."
        case "signin-required":
            return "This account needs a fresh sign-in — renewal can't fix that."
        case "auth-overridden":
            return authOverrideExplanation
        case "failed":
            return "Renewal didn't complete."
        case "rate-limited":
            // Daemon addendum (PR #196 review): manual renewals past the
            // daily cap. Calm by design — the cap protects the account.
            return "Today's renewal limit is reached — it can run again tomorrow."
        default:
            return "Renewal finished: \(renewal.outcome)."
        }
    }
}

/// "Renew now" state machine (issue #176), the `ToolUpdateModel` shape: one
/// phase per account id — idle → running → finished(outcome) — plus an error
/// slot for transport failures. After every attempt (either way) it re-reads
/// `GET /api/state` so the chips/notices reflect the daemon's truth: a
/// renewed account simply turns healthy again, which IS the calm feedback.
@MainActor
public final class AccountRenewModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case running
        case finished(AccountRenewal)
    }

    @Published public private(set) var phases: [String: Phase] = [:]
    @Published public private(set) var errors: [String: String] = [:]

    /// Fresh daemon state after a finished attempt; the app pushes it into
    /// `MenuBarStatusModel.apply(deckState:)` like every other mutation.
    public var onStateChanged: ((DeckState) -> Void)?

    private let renewer: any AccountRenewing
    private let stateProvider: any DeckStateProviding

    public init(renewer: any AccountRenewing, stateProvider: any DeckStateProviding) {
        self.renewer = renewer
        self.stateProvider = stateProvider
    }

    public func phase(for accountID: String) -> Phase? { phases[accountID] }
    public func isRenewing(_ accountID: String) -> Bool { phases[accountID] == .running }
    public func error(for accountID: String) -> String? { errors[accountID] }

    /// The row's complete renew rendering state; nil whenever the account
    /// doesn't earn a renew affordance (healthy, signed out, Codex, old
    /// daemon) — the daemon's state is authoritative, so a mid-run heal
    /// simply makes the affordance (and any leftover outcome) disappear.
    public func presentation(for account: DeckAccount) -> AccountRenewPresentation? {
        guard let action = AccountRenew.action(for: account) else { return nil }
        var outcome: String?
        if case .finished(let renewal) = phases[account.id] {
            outcome = AccountRenew.outcomeText(for: renewal)
        }
        return AccountRenewPresentation(
            action: action,
            isRenewing: isRenewing(account.id),
            outcomeText: outcome,
            errorText: errors[account.id]
        )
    }

    /// Run the daemon's guarded renew op for this account. Client-side
    /// re-entrancy guard on top of the daemon's own 409 single-flight.
    public func renew(account: DeckAccount) async {
        guard phases[account.id] != .running else { return }
        phases[account.id] = .running
        errors[account.id] = nil
        do {
            let renewal = try await renewer.renewAccount(id: account.id)
            phases[account.id] = .finished(renewal)
        } catch {
            // 409 (a renewal already in flight) and an old daemon without
            // the endpoint both land here with the daemon's own message.
            phases[account.id] = nil
            errors[account.id] = SettingsSyncModel.message(for: error)
        }
        // Either way, re-read state: success flips the account healthy
        // (the notice clears itself); a refusal leaves it untouched — but
        // the daemon may have recorded a lastAttempt worth reflecting.
        if let fresh = try? await stateProvider.deckState() {
            onStateChanged?(fresh)
        }
    }

    /// Clear a finished outcome or error (the row's dismiss affordance).
    public func dismissOutcome(accountID: String) {
        guard phases[accountID] != .running else { return }
        phases[accountID] = nil
        errors[accountID] = nil
    }
}
