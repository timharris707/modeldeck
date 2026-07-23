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
    /// Issue #89: the account's last failed refresh (`{message, at}`),
    /// present only while its most recent refresh attempt failed — the
    /// daemon clears it on the next success. Optional by design: a daemon
    /// without the error-propagation backend omits it.
    public var lastRefreshError: AccountRefreshError?
    /// Issue #149: WHY the daemon reported `signin-required` — "expired"
    /// (stored sign-in present but idle-decayed; the provider CLI renews it
    /// the next time the account is used) vs "missing" (the only genuine
    /// sign-out). Optional by design: an old daemon omits it and the account
    /// renders exactly the pre-#149 alarming treatment.
    public var signinReason: String?

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
        authState: String? = nil,
        lastRefreshError: AccountRefreshError? = nil,
        signinReason: String? = nil
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
        self.lastRefreshError = lastRefreshError
        self.signinReason = signinReason
    }

    /// Per-account health chip (issue #32): each roster row reads its OWN
    /// `authState` rather than the provider-wide probe. An absent field
    /// (daemon without the per-account backend) or an unrecognized value
    /// maps to the honest "Unknown" chip. `duplicate-token` (issue #65)
    /// deliberately stays on the "Unknown" chip too — the duplicate-login
    /// warning renders as its own hollow marker, never as a false
    /// "Sign in again" (the account IS signed in, just as the wrong login).
    /// `keychain-denied` (issue #98) likewise never maps to "Sign in again"
    /// — the account IS signed in; macOS refused the daemon's read. Its
    /// dedicated recovery notice renders on the deck card, and the chip's
    /// tooltip carries the honest `lastRefreshError` message.
    /// Issue #149: `signin-required` splits by the daemon's additive
    /// `signinReason` — "expired" is idle-decay (credentials present, the
    /// provider CLI renews them on next use) and earns the calm idle chip;
    /// any other reason, or none at all (old daemon), keeps the alarming
    /// "Sign in again" verbatim as the conservative default. Reason-based,
    /// never activation-based: an ACTIVE account with an expired token is
    /// idle too.
    public var healthChip: ToolProbe.HealthChip {
        switch authState {
        case "ok": return .healthy
        case "signin-required":
            return signinReason?.lowercased() == "expired" ? .idleSignIn : .signInAgain
        default: return .unknown
        }
    }

    /// Issue #98: macOS refused the daemon's read of this account's
    /// EXISTING Keychain credential item — the state a dismissed first-run
    /// Keychain prompt leaves behind. Lenient by design: only the daemon's
    /// explicit `keychain-denied` authState sets it, so older daemons never
    /// trigger a false recovery notice.
    public var keychainAccessDenied: Bool {
        authState?.lowercased() == "keychain-denied"
    }

    /// Issue #65 (UI half): the daemon's duplicate-credential check flagged
    /// this account — Claude via matching weekly-reset usage fingerprints,
    /// Codex via matching credential identifiers (issue #108) — so two
    /// profiles appear to hold the same login. Lenient by design:
    /// a daemon without the check never sets the value, so this stays
    /// false and nothing renders (no false warnings on older daemons).
    public var hasDuplicateToken: Bool {
        authState?.lowercased() == "duplicate-token"
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

/// Issue #89: one account's last failed refresh as the daemon reports it —
/// `message` is the per-account fetch error refreshAll captured, `at` the
/// ISO timestamp of the failed pass. Decoding is deliberately shape-tolerant
/// (same policy as `ProviderPlanInfo`): a bare string reads as the message,
/// and any other unexpected shape decodes as empty rather than failing the
/// whole account decode.
public struct AccountRefreshError: Codable, Equatable, Sendable {
    public var message: String?
    public var at: String?

    public init(message: String? = nil, at: String? = nil) {
        self.message = message
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case message, at
    }

    public init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer().decode(String.self) {
            self.init(message: single)
            return
        }
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init()
            return
        }
        self.init(
            message: (try? container.decodeIfPresent(String.self, forKey: .message)) ?? nil,
            at: (try? container.decodeIfPresent(String.self, forKey: .at)) ?? nil
        )
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
    /// Identity provenance (issue #62 daemon capture): "seed" when the
    /// identity was read from a profile that isn't the verified active one,
    /// "verified" when confirmed against the provider. Absent on accounts
    /// whose identity came from onboarding verify (treated as verified).
    public var identitySource: String?

    public init(
        claudePlan: ProviderPlanInfo? = nil,
        codexPlan: ProviderPlanInfo? = nil,
        plan: ProviderPlanInfo? = nil,
        identitySource: String? = nil
    ) {
        self.claudePlan = claudePlan
        self.codexPlan = codexPlan
        self.plan = plan
        self.identitySource = identitySource
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
    /// Issue #101: the slice of the daemon's per-snapshot `detail` JSON the
    /// deck needs. Optional end to end so states from older daemons (or
    /// providers whose adapters send `detail: {}`) decode unchanged.
    public var detail: UsageSnapshotDetail?

    public init(
        accountId: String,
        scope: String,
        usedPercent: Double? = nil,
        remainingPercent: Double? = nil,
        resetsAt: String? = nil,
        observedAt: String? = nil,
        source: String? = nil,
        stale: Bool = false,
        detail: UsageSnapshotDetail? = nil
    ) {
        self.accountId = accountId
        self.scope = scope
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.observedAt = observedAt
        self.source = source
        self.stale = stale
        self.detail = detail
    }
}

/// The deck-relevant subset of a usage snapshot's `detail` JSON. The Codex
/// adapter records the provider-reported window length here
/// (`detail.windowDurationMins`, src/adapters/codex.mjs); issue #101's
/// window-anchor heuristics prefer it over the scope-name fallback. Unknown
/// detail keys are ignored by Codable as usual.
public struct UsageSnapshotDetail: Codable, Equatable, Sendable {
    public var windowDurationMins: Double?
    /// Issue #139: payload-stated spend amounts for the `spend` scope
    /// (src/adapters/claude.mjs `parseClaudeSpendAmounts`). Optional end to
    /// end — older daemons and providers without amounts decode unchanged.
    public var spend: SpendAmounts?

    public init(windowDurationMins: Double? = nil, spend: SpendAmounts? = nil) {
        self.windowDurationMins = windowDurationMins
        self.spend = spend
    }
}

/// Issue #139: the provider-stated extra-usage budget in MINOR currency
/// units (cents when `exponent` is 2), with the payload's own currency code.
/// The deck renders "$X.XX of $Y.YY" from these ONLY when `currency` is
/// present — a currency is never assumed.
public struct SpendAmounts: Codable, Equatable, Sendable {
    public var usedMinor: Double?
    public var limitMinor: Double?
    public var currency: String?
    public var exponent: Double?

    public init(
        usedMinor: Double? = nil,
        limitMinor: Double? = nil,
        currency: String? = nil,
        exponent: Double? = nil
    ) {
        self.usedMinor = usedMinor
        self.limitMinor = limitMinor
        self.currency = currency
        self.exponent = exponent
    }
}

/// `GET /api/state` `scheduler` — the daemon's honest refresh-cadence surface
/// (issue #90). `effectiveRefreshIntervalSeconds` is the cadence the daemon
/// is ACTUALLY running (nil while auto-refresh is disabled);
/// `effectiveRefreshReason` names why it is slower than the configured
/// setting when it is ("active-session-cap": the 30-minute throttle on the
/// never-customized default interval). Every field is optional so an older
/// daemon (which sent only `pausedForActiveSessions`, or nothing) decodes
/// cleanly with no indicator and no behavior change.
public struct DeckScheduler: Codable, Equatable, Sendable {
    public var pausedForActiveSessions: Bool?
    public var configuredRefreshIntervalSeconds: Int?
    public var effectiveRefreshIntervalSeconds: Int?
    public var effectiveRefreshReason: String?

    public init(
        pausedForActiveSessions: Bool? = nil,
        configuredRefreshIntervalSeconds: Int? = nil,
        effectiveRefreshIntervalSeconds: Int? = nil,
        effectiveRefreshReason: String? = nil
    ) {
        self.pausedForActiveSessions = pausedForActiveSessions
        self.configuredRefreshIntervalSeconds = configuredRefreshIntervalSeconds
        self.effectiveRefreshIntervalSeconds = effectiveRefreshIntervalSeconds
        self.effectiveRefreshReason = effectiveRefreshReason
    }
}

/// `GET /api/state` — only the slices Phase 3 needs. The daemon also returns
/// `projects` and `launches`; they are ignored here and picked up in Phase 4+.
public struct DeckState: Codable, Equatable, Sendable {
    public var accounts: [DeckAccount]
    public var usage: [UsageSnapshot]
    /// Per-provider PHYSICAL activation truth (issue #55/#56). Optional by
    /// design: a pre-#56 daemon omits the field entirely, and the UI then
    /// keeps its previous behavior with no false warnings. Decoded
    /// tolerantly — an unexpected shape reads as absent rather than failing
    /// the whole state decode.
    public var activation: DeckActivation?
    /// Issue #90: the daemon's effective refresh cadence + why it differs
    /// from the configured one. Same tolerant-decode contract as
    /// `activation` — absent or unexpectedly shaped reads as nil.
    public var scheduler: DeckScheduler?

    public init(
        accounts: [DeckAccount] = [],
        usage: [UsageSnapshot] = [],
        activation: DeckActivation? = nil,
        scheduler: DeckScheduler? = nil
    ) {
        self.accounts = accounts
        self.usage = usage
        self.activation = activation
        self.scheduler = scheduler
    }

    private enum CodingKeys: String, CodingKey {
        case accounts, usage, activation, scheduler
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.accounts = try container.decodeIfPresent([DeckAccount].self, forKey: .accounts) ?? []
        self.usage = try container.decodeIfPresent([UsageSnapshot].self, forKey: .usage) ?? []
        self.activation = try? container.decodeIfPresent(DeckActivation.self, forKey: .activation)
        self.scheduler = try? container.decodeIfPresent(DeckScheduler.self, forKey: .scheduler)
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
    /// Issue #99: the daemon's version-detected Claude sign-in flow —
    /// "config-dir" (pre-2.1.216 env-scoped login) or "activation"
    /// (>= 2.1.216: credentials key off the resolved ~/.claude, so the
    /// target profile must be ACTIVATED before the plain login runs).
    /// Absent on Codex specs and on pre-#99 daemons.
    public var flow: String?
    /// Issue #99: when true, the caller must activate this account before
    /// launching `command`, verify identity while it is still active, and
    /// only then optionally restore the previously active account. Optional
    /// by design — an older daemon omits it and the flow stays login-only.
    public var requiresActivation: Bool?

    public init(
        provider: String,
        command: String,
        flow: String? = nil,
        requiresActivation: Bool? = nil
    ) {
        self.provider = provider
        self.command = command
        self.flow = flow
        self.requiresActivation = requiresActivation
    }

    /// Whether the sign-in must be driven through activation first.
    public var needsActivationFirst: Bool {
        requiresActivation == true
    }
}

/// `POST /api/accounts/:id/verify` — step 3 read-back. `identity` is whatever
/// the provider's status command chose to print (placeholder emails only in
/// fixtures/docs); nil when the provider doesn't reveal one.
public struct AccountVerification: Codable, Equatable, Sendable {
    /// Issue #99 fix direction 2: the daemon compared the read-back identity
    /// against the intended account and refused — nothing was recorded. The
    /// UI must surface this loudly; it is never a success.
    public struct IdentityMismatch: Codable, Equatable, Sendable {
        public var expected: String?
        public var actual: String?

        public init(expected: String? = nil, actual: String? = nil) {
            self.expected = expected
            self.actual = actual
        }
    }

    public var account: DeckAccount
    public var authenticated: Bool
    public var identity: String?
    /// Present only when the daemon refused the sign-in because the resulting
    /// identity belongs to a different account (issue #99). Optional by
    /// design: older daemons never send it.
    public var identityMismatch: IdentityMismatch?

    public init(
        account: DeckAccount,
        authenticated: Bool,
        identity: String? = nil,
        identityMismatch: IdentityMismatch? = nil
    ) {
        self.account = account
        self.authenticated = authenticated
        self.identity = identity
        self.identityMismatch = identityMismatch
    }
}
