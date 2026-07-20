import Foundation

// Typed mirrors of the Node daemon's JSON responses (src/server.mjs,
// src/db.mjs row mappers). Decoding is deliberately lenient — unknown keys
// are ignored and optional server fields stay optional — so the client keeps
// working as the daemon grows new fields in later phases.

/// `GET /api/health`
public struct DaemonHealth: Codable, Equatable, Sendable {
    public var ok: Bool
    public var name: String
    public var version: String
    public var projectsRoot: String?

    public init(ok: Bool, name: String, version: String, projectsRoot: String? = nil) {
        self.ok = ok
        self.name = name
        self.version = version
        self.projectsRoot = projectsRoot
    }
}

/// One account row from `GET /api/state` (`accounts[]`).
public struct DeckAccount: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var provider: String
    public var label: String
    public var identity: String?
    public var purpose: String?
    public var color: String?
    /// The provider profile reference (CLAUDE_CONFIG_DIR / CODEX_HOME
    /// path). Needed to round-trip edits through `POST /api/accounts`.
    public var profileRef: String?
    public var enabled: Bool
    public var isDefault: Bool
    /// Daemon-side account metadata (issue #26, Claude half): carries the
    /// plan/tier captured during verify/refresh. The daemon preserves
    /// metadata on edits, so this never round-trips through
    /// `POST /api/accounts`.
    public var metadata: DeckAccountMetadata?
    /// Per-account auth state from `GET /api/state` (issue #31 backend:
    /// "ok" / "signin-required" / "unknown"). Optional by design — a daemon
    /// without the per-account health backend simply omits the field, and
    /// the chip renders an honest "Unknown".
    public var authState: String?

    public init(
        id: String,
        provider: String,
        label: String,
        identity: String? = nil,
        purpose: String? = nil,
        color: String? = nil,
        profileRef: String? = nil,
        enabled: Bool = true,
        isDefault: Bool = false,
        metadata: DeckAccountMetadata? = nil,
        authState: String? = nil
    ) {
        self.id = id
        self.provider = provider
        self.label = label
        self.identity = identity
        self.purpose = purpose
        self.color = color
        self.profileRef = profileRef
        self.enabled = enabled
        self.isDefault = isDefault
        self.metadata = metadata
        self.authState = authState
    }

    /// Per-account health chip (issue #32): each roster row reads its OWN
    /// `authState` rather than the provider-wide probe. An absent field
    /// (daemon without the per-account backend) or an unrecognized value
    /// maps to the honest "Unknown" chip.
    public var healthChip: ToolProbe.HealthChip {
        switch authState {
        case "ok": return .healthy
        case "signin-required": return .signInAgain
        default: return .unknown
        }
    }

    /// Muted plan tier rendered inline beside the account name (issue #30,
    /// "Studio · Max (20x)"), or nil when the plan is unknown — absent
    /// tiers render nothing. Provider-generic: Claude's plan metadata is
    /// live today; the Codex tier lands with issue #26 and lights up here
    /// with no further UI work (`codexPlan` mirroring the Claude field, or
    /// a generic `plan` value — object or bare string alike).
    public var planLabel: String? {
        let candidates = [metadata?.claudePlan, metadata?.codexPlan, metadata?.plan]
        for plan in candidates.compactMap({ $0 }) {
            if let label = PlanTierFormatter.label(
                subscriptionType: plan.subscriptionType,
                rateLimitTier: plan.rateLimitTier
            ) {
                return label
            }
        }
        return nil
    }
}

/// The slice of the daemon's free-form account metadata the app reads.
/// Unknown metadata keys are ignored by Codable's lenient decoding.
///
/// `codexPlan`/`plan` are decoded tolerantly ahead of issue #26 landing on
/// the daemon side: whichever key the backend ships (mirroring the Claude
/// field or a generic one), the tier renders with no further UI change.
public struct DeckAccountMetadata: Codable, Equatable, Sendable {
    public var claudePlan: ProviderPlanInfo?
    public var codexPlan: ProviderPlanInfo?
    public var plan: ProviderPlanInfo?

    public init(
        claudePlan: ProviderPlanInfo? = nil,
        codexPlan: ProviderPlanInfo? = nil,
        plan: ProviderPlanInfo? = nil
    ) {
        self.claudePlan = claudePlan
        self.codexPlan = codexPlan
        self.plan = plan
    }
}

/// Plan/tier facts a provider payload carries. For Claude the daemon
/// captures these with zero extra provider calls: `subscriptionType` from
/// `claude auth status` JSON ("max") and `rateLimitTier` from the profile's
/// `.claude.json` (`oauthAccount.organizationRateLimitTier`, e.g.
/// "default_claude_max_20x").
///
/// Decoding is deliberately shape-tolerant (issue #30, ahead of #26's Codex
/// payload): a bare string ("pro") reads as the subscription type, and an
/// object accepts `subscriptionType`/`planType`/`plan`/`type` for the plan
/// name plus `rateLimitTier`/`tier` for the tier string.
public struct ProviderPlanInfo: Codable, Equatable, Sendable {
    public var subscriptionType: String?
    public var rateLimitTier: String?

    public init(subscriptionType: String? = nil, rateLimitTier: String? = nil) {
        self.subscriptionType = subscriptionType
        self.rateLimitTier = rateLimitTier
    }

    private enum CodingKeys: String, CodingKey {
        case subscriptionType, planType, plan, type
        case rateLimitTier, tier
    }

    public init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer().decode(String.self) {
            self.init(subscriptionType: single)
            return
        }
        // Any other unexpected shape (number, bool, array, null) decodes as
        // empty plan info rather than failing the whole account decode —
        // the tier then simply renders nothing.
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init()
            return
        }
        func first(_ keys: [CodingKeys]) -> String? {
            for key in keys {
                if let value = try? container.decodeIfPresent(String.self, forKey: key),
                   !value.isEmpty {
                    return value
                }
            }
            return nil
        }
        self.init(
            subscriptionType: first([.subscriptionType, .planType, .plan, .type]),
            rateLimitTier: first([.rateLimitTier, .tier])
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(subscriptionType, forKey: .subscriptionType)
        try container.encodeIfPresent(rateLimitTier, forKey: .rateLimitTier)
    }
}

/// Derives the muted inline tier the way Anthropic renders it: subscription
/// type capitalized plus the multiplier parsed from the tier string when
/// present ("Max (20x)"), the subscription alone when no multiplier is
/// recognizable, nothing at all when the plan is unknown. Tolerates absent
/// or unrecognized tier strings gracefully. Provider-generic (issue #30):
/// Codex tiers ("Pro", "Plus") flow through the same derivation.
public enum PlanTierFormatter {
    public static func label(subscriptionType: String?, rateLimitTier: String?) -> String? {
        guard let base = baseName(subscriptionType: subscriptionType, rateLimitTier: rateLimitTier) else {
            return nil
        }
        if let multiplier = multiplier(in: rateLimitTier) {
            return "\(base) (\(multiplier))"
        }
        return base
    }

    private static func baseName(subscriptionType: String?, rateLimitTier: String?) -> String? {
        if let subscription = subscriptionType?.trimmingCharacters(in: .whitespacesAndNewlines),
           !subscription.isEmpty {
            return subscription.prefix(1).uppercased() + subscription.dropFirst()
        }
        // Fall back to a recognizable plan word inside the tier string.
        guard let tier = rateLimitTier?.lowercased() else { return nil }
        let tokens = tier.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        for plan in ["max", "pro", "plus", "team", "enterprise", "free"] where tokens.contains(Substring(plan)) {
            return plan.prefix(1).uppercased() + plan.dropFirst()
        }
        return nil
    }

    /// "default_claude_max_20x" → "20x". Nil when no numeric multiplier
    /// token exists.
    private static func multiplier(in rateLimitTier: String?) -> String? {
        guard let tier = rateLimitTier?.lowercased() else { return nil }
        let tokens = tier.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        for token in tokens where token.hasSuffix("x") && token.count > 1 {
            if token.dropLast().allSatisfy(\.isNumber) {
                return String(token)
            }
        }
        return nil
    }
}

/// Body for `POST /api/accounts` when editing an existing account from the
/// Settings window. Carries the account's id + required provider/profileRef
/// unchanged plus the three editable fields (label, purpose, color). Fields
/// the daemon preserves when omitted (identity, metadata, default flag) are
/// deliberately absent.
public struct AccountEdit: Codable, Equatable, Sendable {
    public var id: String
    public var provider: String
    public var profileRef: String
    public var label: String
    public var purpose: String
    public var color: String?

    public init(
        id: String,
        provider: String,
        profileRef: String,
        label: String,
        purpose: String,
        color: String? = nil
    ) {
        self.id = id
        self.provider = provider
        self.profileRef = profileRef
        self.label = label
        self.purpose = purpose
        self.color = color
    }

    /// Edit payload for an existing roster account; nil when the daemon
    /// didn't report the account's profileRef (editing then stays disabled
    /// rather than risking a mis-keyed upsert).
    public init?(account: DeckAccount, label: String, purpose: String, color: String?) {
        guard let profileRef = account.profileRef, !profileRef.isEmpty else { return nil }
        self.init(
            id: account.id,
            provider: account.provider,
            profileRef: profileRef,
            label: label,
            purpose: purpose,
            color: color
        )
    }
}

/// One usage snapshot from `GET /api/state` (`usage[]`) — the latest snapshot
/// per (account, scope). `scope` is the rate-limit window name the daemon
/// recorded (e.g. "5h", "week", or a model-scoped window).
public struct UsageSnapshot: Codable, Equatable, Sendable {
    public var accountId: String
    public var scope: String
    public var usedPercent: Double?
    public var remainingPercent: Double?
    public var resetsAt: String?
    public var observedAt: String?
    public var source: String?
    public var stale: Bool

    public init(
        accountId: String,
        scope: String,
        usedPercent: Double? = nil,
        remainingPercent: Double? = nil,
        resetsAt: String? = nil,
        observedAt: String? = nil,
        source: String? = nil,
        stale: Bool = false
    ) {
        self.accountId = accountId
        self.scope = scope
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.observedAt = observedAt
        self.source = source
        self.stale = stale
    }
}

/// `GET /api/state` — only the slices Phase 3 needs. The daemon also returns
/// `projects` and `launches`; they are ignored here and picked up in Phase 4+.
public struct DeckState: Codable, Equatable, Sendable {
    public var accounts: [DeckAccount]
    public var usage: [UsageSnapshot]

    public init(accounts: [DeckAccount] = [], usage: [UsageSnapshot] = []) {
        self.accounts = accounts
        self.usage = usage
    }
}

// MARK: - Add-account flow (issue #8)

/// Body for `POST /api/accounts` when creating a brand-new account (add-
/// account step 1). No `profileRef`: the daemon creates the isolated
/// owner-only profile home (native Claude profile home / CODEX_HOME) and
/// returns it on the created account.
public struct AccountCreate: Codable, Equatable, Sendable {
    public var provider: String
    public var label: String
    public var purpose: String
    public var color: String?

    public init(provider: String, label: String, purpose: String, color: String? = nil) {
        self.provider = provider
        self.label = label
        self.purpose = purpose
        self.color = color
    }
}

/// `GET /api/accounts/:id/login` — the provider's own login command for this
/// account's profile home (step 2). ModelDeck runs it in the user's terminal;
/// the OAuth flow is entirely the provider's and credentials never pass
/// through ModelDeck.
public struct LoginCommand: Codable, Equatable, Sendable {
    public var provider: String
    public var command: String

    public init(provider: String, command: String) {
        self.provider = provider
        self.command = command
    }
}

/// `POST /api/accounts/:id/verify` — step 3 read-back. `identity` is whatever
/// the provider's status command chose to print (placeholder emails only in
/// fixtures/docs); nil when the provider doesn't reveal one.
public struct AccountVerification: Codable, Equatable, Sendable {
    public var account: DeckAccount
    public var authenticated: Bool
    public var identity: String?

    public init(account: DeckAccount, authenticated: Bool, identity: String? = nil) {
        self.account = account
        self.authenticated = authenticated
        self.identity = identity
    }
}
