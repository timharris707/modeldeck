import Foundation
import Observation

// Issue #280 — the UI half of the seeded pill's exit. The daemon runs the
// same cheap read-only identity check the #263 renewal rung uses (scoped
// `claude auth status`; no `-p`, no quota spend, no flip) and promotes
// `identitySource` seed → verified itself on a match. This model only asks,
// renders the running state, and relays the decided outcome:
//   verified   → the fresh state drops `isIdentitySeeded`, the pill (and
//                this button) disappear — that IS the success feedback.
//   mismatch   → nothing promotes; the EXISTING identity-mismatch surface
//                takes over on the refreshed state, and the inline line
//                only points there.
//   unavailable→ the daemon's sanitized sentence, quiet inline.

/// Daemon seam; `DaemonClient` conforms and tests stub it.
public protocol IdentityVerifying: Sendable {
    /// `POST /api/accounts/:id/verify-identity`.
    func verifyIdentity(accountID: String) async throws -> IdentityVerification
}

extension DaemonClient: IdentityVerifying {}

/// Single-source strings for the seeded pill + Verify button (issue #280).
public enum IdentityVerify {
    /// The pill's tooltip names BOTH exits — the button and the automatic
    /// promotion — so "yet" finally has an arrival story (Tim's complaint:
    /// the old tooltip promised a verification that could never land).
    public static let pillTooltip =
        "Identity was entered at setup and hasn't been verified against the "
        + "provider yet — Verify checks now, or the next auto-renewal will."

    /// VoiceOver form of the same state (the pill's accessibility label).
    public static let pillAccessibilityLabel =
        "Identity seeded at setup, not yet verified. "
        + "Verify checks now, or the next auto-renewal will."

    public static let buttonTooltip =
        "Check this identity against the provider now — a read-only status "
        + "check, no sign-in, no usage spent."

    public static let runningText = "Verifying…"

    /// The quiet inline line for a decided non-success, or nil for
    /// "verified" (the disappearing pill is the answer). Unknown outcomes
    /// read as a plain failure — tolerate-unknowns, never a fake success.
    /// `expected` is the account's saved identity, when the caller has one.
    public static func failureText(
        for verification: IdentityVerification,
        expected: String? = nil
    ) -> String? {
        switch verification.outcome {
        case "verified":
            return nil
        case "mismatch":
            // Adversarial review MINOR-e: the old pointer ("see the identity
            // notice above") named the roster banner that exists only for
            // the provider's ACTIVE account — on any other row it pointed at
            // nothing. Self-contained instead: name expected vs actual.
            let reported = verification.reported.flatMap { $0.isEmpty ? nil : $0 }
            let saved = expected.flatMap { $0.isEmpty ? nil : $0 }
            switch (reported, saved) {
            case (let actual?, let saved?):
                return "The provider is signed in as \(actual), not \(saved)."
            case (let actual?, nil):
                return "The provider is signed in as \(actual), not this account's saved identity."
            case (nil, _):
                return "The provider reports a different identity than this account's saved one."
            }
        case "unavailable":
            if let detail = verification.detail, !detail.isEmpty { return detail }
            return "Couldn't check with the provider right now."
        default:
            return "Couldn't check with the provider right now."
        }
    }
}

/// Everything the roster row renders for the Verify affordance; nil when
/// the account isn't seeded and holds no attempt state.
public struct IdentityVerifyPresentation: Equatable, Sendable {
    public enum Display: Equatable, Sendable {
        /// The [Verify] button, armed (only ever beside the seeded pill).
        case verify
        case running
        /// Quiet inline failure text (daemon detail / mismatch pointer /
        /// transport error), dismissible.
        case failure(String)
    }

    public var display: Display

    public init(display: Display) {
        self.display = display
    }
}

/// Verify-button state machine (issue #280), the `AccountRenewModel` shape:
/// idle → running → decided, with a transport-error slot; after every
/// attempt it re-reads `GET /api/state` so the pill reflects the daemon's
/// promotion truth. The view stays dumb.
@MainActor
public final class IdentityVerifyModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case running
        case finished(IdentityVerification)
    }

    @Published public private(set) var phases: [String: Phase] = [:]
    @Published public private(set) var errors: [String: String] = [:]

    /// Fresh daemon state after a finished attempt (the promotion lives
    /// there); pushed into `MenuBarStatusModel.apply(deckState:)` by the app.
    public var onStateChanged: ((DeckState) -> Void)?

    private let verifier: any IdentityVerifying
    private let stateProvider: any DeckStateProviding

    public init(verifier: any IdentityVerifying, stateProvider: any DeckStateProviding) {
        self.verifier = verifier
        self.stateProvider = stateProvider
    }

    public func phase(for accountID: String) -> Phase? { phases[accountID] }

    /// The row's Verify rendering state. The armed button renders ONLY
    /// while the pill does (`isIdentitySeeded`); a running attempt or an
    /// unread failure keeps answering even if the pill just cleared — the
    /// #199 rule: a click's outcome must land at the click site.
    public func presentation(for account: DeckAccount) -> IdentityVerifyPresentation? {
        switch phases[account.id] {
        case .running:
            return IdentityVerifyPresentation(display: .running)
        case .finished(let verification):
            if let failure = IdentityVerify.failureText(for: verification, expected: account.identity) {
                return IdentityVerifyPresentation(display: .failure(failure))
            }
            // Verified: the refreshed state cleared the pill, so there is
            // nothing to render — the disappearance IS the feedback. The
            // phase itself is left intact; this only declines to present it
            // once the account is no longer seeded (CodeRabbit, PR #285).
            return account.isIdentitySeeded
                ? IdentityVerifyPresentation(display: .verify)
                : nil
        case nil:
            if let error = errors[account.id] {
                return IdentityVerifyPresentation(display: .failure(error))
            }
            return account.isIdentitySeeded
                ? IdentityVerifyPresentation(display: .verify)
                : nil
        }
    }

    /// Run the daemon's read-only identity check for this account.
    /// Client-side re-entrancy guard on top of the daemon's own 409.
    public func verify(account: DeckAccount) async {
        guard phases[account.id] != .running else { return }
        phases[account.id] = .running
        errors[account.id] = nil
        do {
            let verification = try await verifier.verifyIdentity(accountID: account.id)
            phases[account.id] = .finished(verification)
        } catch {
            // 409 (renewal/activation in flight), 400, and an old daemon
            // without the endpoint all land here with the daemon's message.
            phases[account.id] = nil
            errors[account.id] = SettingsSyncModel.message(for: error)
        }
        // Either way, re-read state: a promotion clears the pill; a
        // mismatch feeds the existing identity-mismatch surface.
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let fresh = try await stateProvider.deckState()
            // Adversarial review M6: an older attempt's late response must
            // never overwrite state a newer attempt already applied.
            guard generation == refreshGeneration else { return }
            onStateChanged?(fresh)
        } catch {
            guard generation == refreshGeneration else { return }
            // Adversarial review M7: `try?` dropped this failure — the pill
            // then contradicted the daemon's promotion until the next
            // auto-refresh. Surface it on the row's existing failure line
            // (single-source copy with the proxy row's).
            let line = ProxyPool.stateRefreshFailedText
            var parts: [String] = []
            if case .finished(let verification)? = phases[account.id],
               let failure = IdentityVerify.failureText(for: verification, expected: account.identity) {
                parts.append(failure)
            } else if let existing = errors[account.id] {
                guard !existing.contains(line) else { return }
                parts.append(existing)
            }
            parts.append(line)
            phases[account.id] = nil
            errors[account.id] = parts.joined(separator: " ")
        }
    }

    /// Post-mutation refresh generation (adversarial review M6): captured
    /// before the await so a stale refresh can never win the race.
    private var refreshGeneration = 0

    /// Clear a finished failure or transport error (the row's dismiss).
    public func dismissOutcome(accountID: String) {
        guard phases[accountID] != .running else { return }
        phases[accountID] = nil
        errors[accountID] = nil
    }
}
