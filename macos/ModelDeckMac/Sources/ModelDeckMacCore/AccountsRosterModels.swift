import Foundation

// Accounts-screen redesign, Direction A (issue #61 follow-up): the Settings →
// Accounts roster becomes per-provider sections with a trailing radio for
// activation. All activation trouble consolidates into ONE amber banner at
// the affected provider's section header. Everything here is pure derivation
// over `DeckState` so the mapping is directly unit testable; the SwiftUI
// pane stays thin. Activation semantics (optimistic flip, verify-then-revert,
// new-sessions-only) are untouched — this file only decides what to show.

/// The consolidated amber banner under a provider's section header. Carries
/// every kind of activation trouble — link-level pending states (#55/#61),
/// identity states (#62–64), the daemon's verbatim clobber-guard guidance,
/// and generic activation failures — so the roster rows themselves stay
/// quiet (the affected row only gets the amber radio + Complete Activation).
public struct ProviderActivationBanner: Equatable, Sendable {
    public var provider: DeckProvider
    /// Headline. The daemon's clobber-guard guidance renders VERBATIM here
    /// (issue #55's requirement — never a silent failure); state-derived
    /// messages otherwise.
    public var message: String
    /// The honest nuance line: what still works (usage tracking) and what
    /// waits (new sessions), shown under the headline and behind [Why?].
    public var detail: String
    /// Whether [Retry] re-runs the daemon activate on the affected account.
    /// True only for LINK-level states (blocked/mismatched/unlinked, and the
    /// clobber-guard refusal) — the identity states need /login or a session
    /// run, never another symlink flip (issue #61's button semantics).
    public var retryRunsActivation: Bool
    /// The row the trouble concerns: the account whose activation attempt
    /// was refused, else the provider's DB-default account. That row renders
    /// the amber radio and (for link-level states) Complete Activation.
    public var affectedAccountID: String?

    public init(
        provider: DeckProvider,
        message: String,
        detail: String,
        retryRunsActivation: Bool,
        affectedAccountID: String? = nil
    ) {
        self.provider = provider
        self.message = message
        self.detail = detail
        self.retryRunsActivation = retryRunsActivation
        self.affectedAccountID = affectedAccountID
    }
}

/// Issue #93: the calm post-activation notice under a provider's section
/// header. Deliberately NOT a `ProviderActivationBanner`: the banner means
/// "activation is in trouble and may need action here", while this notice is
/// purely informational — the switch already completed, running sessions
/// were not interrupted, and nothing in the app can fix an unpinned session.
/// It carries the daemon's warning strings VERBATIM (honest-states: the
/// daemon counted the sessions, the app doesn't paraphrase numbers).
public struct PostActivationNotice: Equatable, Sendable {
    public var provider: DeckProvider
    /// The daemon's warning lines, verbatim (usually one).
    public var warnings: [String]
    /// The row whose activation earned the notice.
    public var affectedAccountID: String

    public init(provider: DeckProvider, warnings: [String], affectedAccountID: String) {
        self.provider = provider
        self.warnings = warnings
        self.affectedAccountID = affectedAccountID
    }

    /// Headline: the daemon's lines joined into one calm sentence run.
    public var message: String {
        warnings.joined(separator: " ")
    }

    /// The [Why?] nuance: what already happened, what is safe, and the one
    /// remedy that exists (relaunch unpinned sessions from a fresh
    /// terminal). Mirrors docs/CLAUDE_IDENTITY.md's pinning story.
    public static let detail =
        "The switch already completed and running sessions were not "
        + "interrupted. Sessions launched with ModelDeck's pinned environment "
        + "(new terminal windows, app launches) keep their session storage "
        + "across switches. A session that was started without it follows the "
        + "active profile and can split its history across profiles — when "
        + "convenient, finish it and start fresh from a new terminal."

    /// The #79 lesson: an explicit container accessibility label suppresses
    /// child labels, so the ONE label VoiceOver reads must be derived from
    /// the full notice state — provider, verbatim message, and nuance —
    /// never a static string that hides the warning.
    public var accessibilityLabel: String {
        "\(provider.displayName) activation notice: \(message) \(Self.detail)"
    }
}

/// One per-provider section of the redesigned roster: header (provider mark,
/// display name, account count), optional trouble banner, optional
/// informational post-activation notice (issue #93), rows.
public struct AccountsRosterSection: Equatable, Identifiable, Sendable {
    public var provider: DeckProvider
    public var accounts: [DeckAccount]
    public var banner: ProviderActivationBanner?
    public var notice: PostActivationNotice?

    public var id: String { provider.rawValue }
    public var title: String { provider.displayName }
    public var countText: String {
        accounts.count == 1 ? "1 account" : "\(accounts.count) accounts"
    }

    public init(
        provider: DeckProvider,
        accounts: [DeckAccount],
        banner: ProviderActivationBanner? = nil,
        notice: PostActivationNotice? = nil
    ) {
        self.provider = provider
        self.accounts = accounts
        self.banner = banner
        self.notice = notice
    }
}

public enum AccountsRoster {
    /// Sections in fixed provider order (Claude, then Codex — mirroring the
    /// deck's columns); a provider with no accounts yields no section.
    /// Accounts whose provider string maps to neither are dropped from the
    /// sectioned roster (they cannot be activated or sectioned; none exist
    /// in practice).
    ///
    /// `guidanceForAccount` / `errorForAccount` are the deck model's per-
    /// account clobber-guard guidance and generic activation errors — they
    /// fold into the section banner instead of per-row alerts.
    ///
    /// `troubleForProvider` (issue #100) is the deck model's provider-level
    /// trouble record. It backs the per-account lookups up: when the record's
    /// account has left the roster (removed/re-added mid-recovery, daemon-
    /// side surgery), the per-account closures can never find it — the
    /// banner then surfaces the record at the provider level instead of
    /// letting the activation outcome vanish.
    public static func sections(
        state: DeckState,
        guidanceForAccount: (String) -> String? = { _ in nil },
        errorForAccount: (String) -> String? = { _ in nil },
        troubleForProvider: (DeckProvider) -> ActivationTrouble? = { _ in nil },
        warningsForProvider: (DeckProvider) -> PostActivationWarnings? = { _ in nil }
    ) -> [AccountsRosterSection] {
        DeckProvider.allCases.compactMap { provider in
            let accounts = state.accounts
                .filter { DeckProvider.from($0.provider) == provider }
                .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
            // A provider with no accounts renders no section (Direction A
            // contract) — DELIBERATELY including any orphaned trouble record
            // it may still hold. Removing the provider's last account is an
            // explicit, confirmation-gated action whose visible outcome is
            // the whole section disappearing; a trouble banner in an
            // otherwise empty section would be a permanent dead end (no
            // account left to activate means no attempt could ever supersede
            // it, and its Retry only re-reads state). The record itself
            // survives in the deck model, so a mid-recovery re-add brings
            // the orphan fallback back the moment the section exists again.
            guard !accounts.isEmpty else { return nil }
            return AccountsRosterSection(
                provider: provider,
                accounts: accounts,
                banner: banner(
                    for: provider,
                    state: state,
                    accounts: accounts,
                    guidanceForAccount: guidanceForAccount,
                    errorForAccount: errorForAccount,
                    troubleForProvider: troubleForProvider
                ),
                notice: notice(for: provider, warnings: warningsForProvider(provider))
            )
        }
    }

    /// Issue #93: the informational post-activation notice, or nil when the
    /// last activation carried no warnings (or none happened this run). An
    /// empty warnings list yields no notice — old daemons and warning-free
    /// switches stay silent, exactly like today.
    static func notice(
        for provider: DeckProvider,
        warnings: PostActivationWarnings?
    ) -> PostActivationNotice? {
        guard let warnings, !warnings.warnings.isEmpty else { return nil }
        return PostActivationNotice(
            provider: provider,
            warnings: warnings.warnings,
            affectedAccountID: warnings.accountID
        )
    }

    /// Whether a row's radio renders the amber (selected-but-pending)
    /// variant: it is the provider's selected account, but the verified
    /// activation state says the selection is not physically in effect.
    /// `.unknown` (pre-#56 daemon) stays honest-silent — plain selected.
    public static func radioIsPending(account: DeckAccount, state: DeckState) -> Bool {
        guard account.isDefault, let provider = DeckProvider.from(account.provider) else { return false }
        switch state.activationState(for: provider) {
        case .effective, .unknown: return false
        case .blocked, .mismatched, .unlinked, .identityMismatch, .identityUnverified: return true
        }
    }

    /// The consolidated banner for one provider, or nil when there is no
    /// activation trouble to report. Precedence: the daemon's verbatim
    /// refusal guidance, then a generic activation error, then the verified
    /// activation state.
    static func banner(
        for provider: DeckProvider,
        state: DeckState,
        accounts: [DeckAccount],
        guidanceForAccount: (String) -> String?,
        errorForAccount: (String) -> String?,
        troubleForProvider: (DeckProvider) -> ActivationTrouble? = { _ in nil }
    ) -> ProviderActivationBanner? {
        let selected = accounts.first(where: \.isDefault)
        let detail = detailText(for: provider, selectedLabel: selected?.label)

        // 1. A refused activation attempt (clobber guard) — daemon guidance
        //    verbatim, attached to the account that attempted it.
        if let (accountID, guidance) = firstValue(guidanceForAccount, in: accounts) {
            return ProviderActivationBanner(
                provider: provider,
                message: guidance,
                detail: detail,
                retryRunsActivation: true,
                affectedAccountID: accountID
            )
        }
        // 2. A generic activation failure surfaced by the deck model.
        if let (accountID, error) = firstValue(errorForAccount, in: accounts) {
            return ProviderActivationBanner(
                provider: provider,
                message: error,
                detail: detail,
                retryRunsActivation: true,
                affectedAccountID: accountID
            )
        }
        // 2.5 (issue #100): trouble whose account has since left the roster.
        //    The per-account lookups above can never find it, so surface the
        //    record at the provider level rather than letting the outcome of
        //    an activation attempt vanish. [Retry] can't re-run activation
        //    for an account that no longer exists — it re-reads state.
        if let trouble = troubleForProvider(provider),
           !accounts.contains(where: { $0.id == trouble.accountID }) {
            return ProviderActivationBanner(
                provider: provider,
                message: trouble.message
                    + " (The account this concerns is no longer in the roster.)",
                detail: detail,
                retryRunsActivation: false,
                affectedAccountID: nil
            )
        }
        // 3. The verified activation state. Only providers with an enabled
        //    account can have live trouble (mirrors ActivationNotice).
        if accounts.contains(where: \.enabled),
           let message = stateMessage(
               for: state.activationState(for: provider),
               provider: provider,
               selectedLabel: selected?.label
           ) {
            return ProviderActivationBanner(
                provider: provider,
                message: message,
                detail: detail,
                retryRunsActivation: state.activationState(for: provider).needsLinkCompletion,
                affectedAccountID: selected?.id
            )
        }
        // 4. The usage-fingerprint duplicate-token flag (issue #65). Ranked
        //    below activation trouble — the section shows ONE banner, and a
        //    broken activation is the more immediately actionable problem.
        //    Treated like the identity states (#62): Retry only re-checks,
        //    never flips a symlink — only /login fixes a shared credential.
        if let message = duplicateTokenMessage(for: accounts) {
            return ProviderActivationBanner(
                provider: provider,
                message: message,
                detail: duplicateTokenDetail,
                retryRunsActivation: false,
                affectedAccountID: accounts.first(where: \.hasDuplicateToken)?.id
            )
        }
        return nil
    }

    /// The duplicate-token banner's honest [Why?] nuance (issue #65): the
    /// activation-centric detail line would be wrong here — activation can
    /// be fully in effect while two profiles share one login. Explains how
    /// the flag was earned and how it clears. Mechanism-neutral wording
    /// (issue #108): Claude flags come from matching usage fingerprints,
    /// Codex flags from matching credential identifiers — both mean the
    /// profiles share one provider login.
    /// Public since issue #113: the click-to-explain popover on the deck's
    /// duplicate-login marker reuses this exact detail — one source of
    /// truth for the duplicate-login WHY, banner and marker alike.
    public static let duplicateTokenDetail =
        "These profiles appear to share the same provider login — the "
        + "evidence each one presents matches another profile's. Any usage "
        + "shown reflects one shared account. The warning clears on its "
        + "own after a fresh /login gives each profile its own credential. "
        + "Running sessions are never touched."

    /// Banner headline for the daemon's duplicate-token flag (issue #65),
    /// naming the flagged accounts; nil when no account is flagged. A lone
    /// flagged account (its partner removed between refreshes) falls back
    /// to the generic two-profiles phrasing rather than naming one.
    static func duplicateTokenMessage(for accounts: [DeckAccount]) -> String? {
        let flagged = accounts.filter(\.hasDuplicateToken)
        guard !flagged.isEmpty else { return nil }
        let subject: String
        if flagged.count >= 2 {
            let labels = flagged.map(\.label)
            subject = labels.dropLast().joined(separator: ", ")
                + " and " + labels[labels.count - 1]
        } else {
            subject = "two profiles"
        }
        return "Duplicate login — \(subject) appear to hold the same login. "
            + "Redo /login for one of them."
    }

    private static func firstValue(
        _ lookup: (String) -> String?,
        in accounts: [DeckAccount]
    ) -> (String, String)? {
        for account in accounts {
            if let value = lookup(account.id), !value.isEmpty {
                return (account.id, value)
            }
        }
        return nil
    }

    /// The banner's honest nuance line (mock: "Usage tracking works; new
    /// sessions won't use Insight until activation completes.").
    static func detailText(for provider: DeckProvider, selectedLabel: String?) -> String {
        let target = selectedLabel.map { "use \($0)" } ?? "switch accounts"
        return "Usage tracking works; new \(provider.displayName) sessions won't "
            + "\(target) until activation completes. Running sessions are never touched."
    }

    /// State-derived banner headline; nil for effective/unknown (healthy is
    /// silent, and a pre-#56 daemon must not invent warnings).
    static func stateMessage(
        for state: ProviderActivationState,
        provider: DeckProvider,
        selectedLabel: String?
    ) -> String? {
        let selected = selectedLabel ?? "the selected account"
        switch state {
        case .effective, .unknown:
            return nil
        case .blocked:
            return "Activation pending — a one-time migration must run before "
                + "\(provider.displayName) activation can take hold."
        case .mismatched:
            return "Activation pending — the active link on disk points at a "
                + "different profile than \(selected)."
        case .unlinked:
            return "Activation ready — no active link exists yet. "
                + "Complete Activation on \(selected) finishes the switch."
        case .identityMismatch:
            return "Identity mismatch — \(provider.displayName) is signed in as a "
                + "different identity than \(selected). Log out and run /login as that account."
        case .identityUnverified:
            return "Identity unverified — the signed-in identity hasn't been "
                + "confirmed yet. Run one session or /login, then refresh."
        }
    }
}

public extension DeckAccount {
    /// Identity provenance (issue #62): true when the daemon captured this
    /// account's identity as a setup-time seed rather than verifying it
    /// against the provider. Rendered as a quiet "seeded" marker with a
    /// tooltip on the management surface only.
    var isIdentitySeeded: Bool {
        metadata?.identitySource?.lowercased() == "seed"
    }

    /// The Settings → Accounts identity line: "email · purpose" (this is the
    /// management surface — emails always show here, independent of the deck
    /// email-visibility toggle, issue #73). Nil when both are empty.
    var rosterSubtitle: String? {
        var parts: [String] = []
        if let identity, !identity.isEmpty { parts.append(identity) }
        if let purpose, !purpose.isEmpty { parts.append(purpose) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
