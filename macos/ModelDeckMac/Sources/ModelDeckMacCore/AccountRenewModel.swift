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
///
/// Issue #199 (Tim field report, first hour on 0.3.11): `action` is now
/// optional — a just-renewed account heals its chip and loses the renew
/// affordance, but the decided outcome ("Sign-in renewed.") must still
/// render where the button was, so the click can never look like a no-op.
public struct AccountRenewPresentation: Equatable, Sendable {
    public var action: AccountRenewAction?
    public var isRenewing: Bool
    /// Calm one-line outcome of the last finished attempt (daemon `detail`
    /// preferred verbatim); nil until an attempt finishes.
    public var outcomeText: String?
    /// Issue #199: which family the finished outcome belongs to, so the
    /// click site can style busy prominently-but-calmly without re-parsing
    /// the text. nil whenever `outcomeText` is nil.
    public var outcomeKind: AccountRenew.OutcomeKind?
    /// Transport-level failure (daemon unreachable, 409 renewal-in-flight).
    public var errorText: String?

    public init(
        action: AccountRenewAction?,
        isRenewing: Bool = false,
        outcomeText: String? = nil,
        outcomeKind: AccountRenew.OutcomeKind? = nil,
        errorText: String? = nil
    ) {
        self.action = action
        self.isRenewing = isRenewing
        self.outcomeText = outcomeText
        self.outcomeKind = outcomeKind
        self.errorText = errorText
    }

    /// Issue #199 — the ONE thing the click site renders right now, in
    /// strict precedence: progress while the daemon runs, then the decided
    /// outcome (or transport error) until dismissed, and only then the
    /// armed action. Encoding the precedence here (not in each view) is
    /// what makes "the button never silently re-arms over an unread
    /// answer" a testable invariant instead of a per-surface hope.
    public enum Display: Equatable, Sendable {
        case progress
        case outcome(text: String, kind: AccountRenew.OutcomeKind)
        case action(AccountRenewAction)
    }

    public var display: Display? {
        if isRenewing { return .progress }
        if let outcomeText {
            return .outcome(text: outcomeText, kind: outcomeKind ?? .other)
        }
        if let errorText {
            // Transport failures answer at the click site too — the failed
            // styling, the daemon's own message verbatim.
            return .outcome(text: errorText, kind: .failed)
        }
        if let action { return .action(action) }
        return nil
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

    /// Issue #199: the busy fallback matches the engine's own pinned detail
    /// sentence for the deferred case, so a daemon that omits `detail`
    /// reads identically to one that sends it — busy is a promise to renew
    /// at the next quiet moment, never a shrug.
    /// Issue #251 (Tim field report): promise-first wording — the automatic
    /// part must lead so the card's one-line truncation can never cut it;
    /// the old order truncated to "…ModelDeck will renew…", which read as a
    /// failed to-do instead of queued automation.
    public static let busyFallback = "Will renew automatically at the next quiet moment — a Claude session is running right now."

    /// Issue #199: the outcome families the click site styles differently
    /// (busy prominent-and-calm, renewed a quiet confirmation, failures
    /// matter-of-fact). Unknown daemon outcomes land in `.other` — the
    /// #196 tolerate-unknowns contract, unchanged.
    public enum OutcomeKind: Equatable, Sendable {
        case renewed
        case busy
        case rateLimited
        case failed
        case other
    }

    public static func outcomeKind(for renewal: AccountRenewal) -> OutcomeKind {
        switch renewal.outcome {
        case "renewed": return .renewed
        case "busy": return .busy
        case "rate-limited": return .rateLimited
        case "failed": return .failed
        default: return .other
        }
    }

    /// Issue #199: the click-site outcome line's SF Symbol per family —
    /// single-sourced here so the deck card and the Settings row can never
    /// drift apart. Calm glyphs by design: busy is an hourglass, not an
    /// alarm.
    public static func glyph(for kind: OutcomeKind) -> String {
        switch kind {
        case .renewed: return "checkmark.circle"
        case .busy: return "hourglass"
        case .rateLimited: return "clock"
        case .failed: return "exclamationmark.circle"
        case .other: return "info.circle"
        }
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
            return busyFallback
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
    /// daemon) AND holds no attempt state.
    ///
    /// Issue #199: a finished attempt (or transport error) keeps the
    /// presentation alive even after the affordance itself is gone — the
    /// success path heals the chip via the fresh state, which removes the
    /// action, but the decided outcome must still answer at the click site
    /// until dismissed. Tim's field report: an outcome that lives only in
    /// the explanation's small print reads as a dead button.
    public func presentation(for account: DeckAccount) -> AccountRenewPresentation? {
        let action = AccountRenew.action(for: account)
        let phase = phases[account.id]
        let error = errors[account.id]
        guard action != nil || phase != nil || error != nil else { return nil }
        var outcome: String?
        var kind: AccountRenew.OutcomeKind?
        if case .finished(let renewal) = phase {
            outcome = AccountRenew.outcomeText(for: renewal)
            kind = AccountRenew.outcomeKind(for: renewal)
        }
        return AccountRenewPresentation(
            action: action,
            isRenewing: phase == .running,
            outcomeText: outcome,
            outcomeKind: kind,
            errorText: error
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
