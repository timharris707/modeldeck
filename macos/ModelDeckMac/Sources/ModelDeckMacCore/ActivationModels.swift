import Foundation

// Issue #55 (UI half) — honest activation state. The daemon (#56) verifies
// the PHYSICAL active link on every `GET /api/state` and reports, per
// provider, whether the DB-default account is actually the one new sessions
// consume. Everything here is pure derivation so it is directly unit
// testable; the views stay thin.

/// One provider's entry in the daemon's `activation` map
/// (`GET /api/state` → `activation.claude` / `activation.codex`).
public struct ProviderActivation: Codable, Equatable, Sendable {
    /// "effective" | "blocked" | "mismatched" | "unlinked".
    public var state: String?
    /// Where the active link physically resolves, when a symlink exists.
    public var resolvedProfileRef: String?

    public init(state: String? = nil, resolvedProfileRef: String? = nil) {
        self.state = state
        self.resolvedProfileRef = resolvedProfileRef
    }
}

/// The daemon's per-provider activation map. Optional everywhere — a
/// pre-#56 daemon simply omits the field and the UI keeps today's behavior.
public struct DeckActivation: Codable, Equatable, Sendable {
    public var claude: ProviderActivation?
    public var codex: ProviderActivation?

    public init(claude: ProviderActivation? = nil, codex: ProviderActivation? = nil) {
        self.claude = claude
        self.codex = codex
    }
}

/// Typed activation state for a provider. `.unknown` covers BOTH an absent
/// `activation` field (older daemon) and an unrecognized state string (newer
/// daemon) — in either case the UI must not invent warnings, so `.unknown`
/// renders exactly like today's behavior (full checkmark, no notice).
public enum ProviderActivationState: Equatable, Sendable {
    case effective
    case blocked
    case mismatched
    case unlinked
    /// PRs #63/#64: the active link is right, but the provider's signed-in
    /// identity belongs to a different account — only /login fixes this.
    case identityMismatch
    /// PRs #63/#64: the active link is right, but the identity can't be
    /// verified (yet) — secure storage degraded or no session run so far.
    case identityUnverified
    case unknown

    /// Lenient mapping from the daemon's state string.
    public static func from(_ raw: String?) -> ProviderActivationState {
        switch raw?.lowercased() {
        case "effective": return .effective
        case "blocked": return .blocked
        case "mismatched": return .mismatched
        case "unlinked": return .unlinked
        case "identity-mismatch": return .identityMismatch
        case "identity-unverified": return .identityUnverified
        default: return .unknown
        }
    }

    /// Issue #61: states the Complete Activation button can actually fix by
    /// re-running the daemon's activate — LINK-level problems only. The
    /// identity states need /login (or a session run), never another
    /// symlink flip, so the button stays away from them.
    public var needsLinkCompletion: Bool {
        switch self {
        case .blocked, .mismatched, .unlinked: return true
        case .effective, .identityMismatch, .identityUnverified, .unknown: return false
        }
    }
}

/// How the DB-default account's active marker renders (deck popover and
/// Settings → Accounts alike): the full checkmark only when activation is
/// physically effective — or when the daemon didn't report activation at
/// all (honest fallback, no false warnings). Every verified-not-effective
/// state gets the hollow warning-tinted marker with an honest caption.
public enum ActiveIndicator: Equatable, Sendable {
    case checkmark
    case pending(caption: String)

    /// Issue #61: every pending caption states the distinction explicitly —
    /// this account is SELECTED as active, but activation is not in effect
    /// yet (the solid marker means active AND in effect).
    public static func indicator(for state: ProviderActivationState) -> ActiveIndicator {
        switch state {
        case .effective, .unknown:
            return .checkmark
        case .blocked:
            return .pending(caption: "Selected as active, but not in effect yet — "
                + "a one-time migration is needed first")
        case .mismatched:
            return .pending(caption: "Selected as active, but the active link "
                + "points at a different account")
        case .unlinked:
            return .pending(caption: "Selected as active, but not in effect yet — "
                + "no active link exists")
        case .identityMismatch:
            return .pending(caption: "Selected as active, but the provider is signed in "
                + "as a different identity — log out and run /login as this account")
        case .identityUnverified:
            return .pending(caption: "Activation link is in place, but the signed-in "
                + "identity isn't verified yet — run one session or /login, then refresh")
        }
    }
}

/// Compact per-provider notice for Settings → Accounts (issue #55 item 3):
/// when a provider's activation isn't effective, say honestly what works
/// (usage tracking) and what doesn't (switching accounts) until the
/// one-time migration runs. Display + guidance only — the migration itself
/// stays a manual, deliberately gated ceremony.
public struct ActivationNotice: Equatable, Identifiable, Sendable {
    public var provider: DeckProvider
    public var message: String

    public var id: String { provider.rawValue }

    public init(provider: DeckProvider, message: String) {
        self.provider = provider
        self.message = message
    }

    /// Notices for every provider whose VERIFIED activation state is not
    /// effective. `.unknown` (absent field / unrecognized value) yields no
    /// notice, and a provider with no enabled accounts has nothing to warn
    /// about. Order is fixed: Claude first, then Codex.
    public static func notices(for state: DeckState) -> [ActivationNotice] {
        DeckProvider.allCases.compactMap { provider in
            guard state.accounts.contains(where: { $0.enabled && DeckProvider.from($0.provider) == provider })
            else { return nil }
            guard let message = message(for: state.activationState(for: provider), provider: provider)
            else { return nil }
            return ActivationNotice(provider: provider, message: message)
        }
    }

    static func message(for state: ProviderActivationState, provider: DeckProvider) -> String? {
        let name = provider.displayName
        switch state {
        case .effective, .unknown:
            return nil
        case .blocked:
            return "\(name) usage tracking is accurate today, but switching accounts "
                + "isn't in effect yet — a one-time migration is needed before "
                + "activation can take hold."
        case .mismatched:
            return "\(name) usage tracking is accurate today, but the active link "
                + "points at a different account than the one marked active, so "
                + "switching accounts hasn't taken hold."
        case .unlinked:
            // Issue #61: unlinked is the post-migration "ready" state (the
            // blocker directory is gone) — say so, and point at the button.
            return "\(name) usage tracking is accurate today, and the path is clear — "
                + "use Complete Activation on the active account to finish switching."
        case .identityMismatch:
            return "\(name) usage tracking is accurate today, but the provider is "
                + "signed in as a different identity than the active account — "
                + "log out and run /login as that account."
        case .identityUnverified:
            // Soft state (fresh profile, or secure storage unreadable) — the
            // marker tooltip explains it; a standing banner would be noise.
            return nil
        }
    }
}

public extension DeckState {
    /// Typed activation state for a provider, `.unknown` when the daemon
    /// didn't report the `activation` field (pre-#56 daemon).
    func activationState(for provider: DeckProvider) -> ProviderActivationState {
        let entry: ProviderActivation?
        switch provider {
        case .claude: entry = activation?.claude
        case .codex: entry = activation?.codex
        }
        guard let entry else { return .unknown }
        return ProviderActivationState.from(entry.state)
    }
}
