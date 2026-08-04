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
    /// Issue #227: the filesystem path blocking activation, when the banner
    /// knows one — parsed from the daemon's clobber-guard guidance (which
    /// ends with the exact path), or the provider's conventional active-link
    /// location for the state-derived blocked banner. Drives the view's
    /// "Reveal in Finder" action; nil renders no reveal affordance.
    public var blockedPath: String?

    public init(
        provider: DeckProvider,
        message: String,
        detail: String,
        retryRunsActivation: Bool,
        affectedAccountID: String? = nil,
        blockedPath: String? = nil
    ) {
        self.provider = provider
        self.message = message
        self.detail = detail
        self.retryRunsActivation = retryRunsActivation
        self.affectedAccountID = affectedAccountID
        self.blockedPath = blockedPath
    }

    /// Issue #228: whether the banner renders a [Retry] button at all.
    /// Retry is offered only when it can DO something — re-run activation
    /// (link-level trouble on a known account) or re-check state for a
    /// specific affected row (identity states, duplicate-token flag). A
    /// banner with no affected account and no activation to re-run (fresh
    /// install with no default selected; orphaned trouble whose account
    /// left the roster) must not offer a button whose click can never
    /// change what the banner reports — the message carries the real next
    /// step instead.
    public var offersRetry: Bool {
        retryRunsActivation || affectedAccountID != nil
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
        //    verbatim, attached to the account that attempted it. Issue #227:
        //    the guidance names WHAT to do but not what comes after — append
        //    the click-level next step (the radio re-runs this activation,
        //    per #234's semantics) and carry the parsed blocking path so the
        //    view can offer Reveal in Finder.
        if let (accountID, guidance) = firstValue(guidanceForAccount, in: accounts) {
            let label = accounts.first { $0.id == accountID }?.label
            return ProviderActivationBanner(
                provider: provider,
                message: guidance + " "
                    + blockedResolutionSentence(accountLabel: label, afterDaemonGuidance: true),
                detail: detail,
                retryRunsActivation: true,
                affectedAccountID: accountID,
                blockedPath: blockedPath(inGuidance: guidance)
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
                affectedAccountID: nil,
                // Issue #227: an orphaned clobber-guard record still names a
                // real on-disk blocker — keep the reveal affordance.
                blockedPath: trouble.kind == .guidance
                    ? blockedPath(inGuidance: trouble.message) : nil
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
                // Issue #228 (fresh install): with NO selected account there
                // is no row [Retry] could re-activate — `affectedAccountID`
                // is nil, so the old `retryRunsActivation: true` promised an
                // activation the retry handler could never run (it silently
                // degraded to a state re-read). Honest gating: retry runs
                // activation only when a selected row exists to run it on.
                retryRunsActivation: state.activationState(for: provider).needsLinkCompletion
                    && selected != nil,
                affectedAccountID: selected?.id,
                // Issue #227: the state-derived blocked banner has no daemon
                // guidance to parse a path from, so the provider's
                // conventional active-link location is the honest pointer —
                // the view double-checks it exists before offering Reveal.
                blockedPath: state.activationState(for: provider) == .blocked
                    ? conventionalActiveLinkPath(for: provider) : nil
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

    // MARK: - Issue #227: blocked-path naming + click-level resolution

    /// The click-level next step for a blocked activation, appended to both
    /// the daemon's verbatim guidance and the state-derived blocked message.
    /// Post-#234 the radio click IS the working retry path, so the copy
    /// points there (mirroring the "Pick an account below" pattern) instead
    /// of leaving the user to rediscover Retry. `afterDaemonGuidance` skips
    /// the move instruction the daemon's own text already gives.
    static func blockedResolutionSentence(
        accountLabel: String?,
        afterDaemonGuidance: Bool = false
    ) -> String {
        let target = accountLabel.map { "click \($0)'s radio" }
            ?? "pick an account below"
        return afterDaemonGuidance
            ? "Once it's moved or renamed, \(target) to activate."
            : "Move or rename that directory, then \(target) to activate."
    }

    /// The blocking path named by the daemon's clobber-guard guidance —
    /// `activeLinkBlockedError` always ends "…before activating: <path>" —
    /// or nil when the text carries no trailing path. Parsed, never
    /// guessed: only a trailing absolute or tilde path counts.
    static func blockedPath(inGuidance guidance: String) -> String? {
        guard let range = guidance.range(of: ": ", options: .backwards) else { return nil }
        let candidate = guidance[range.upperBound...]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard candidate.hasPrefix("/") || candidate.hasPrefix("~") else { return nil }
        return candidate
    }

    /// The provider's conventional active-link location (`~/.claude` /
    /// `~/.codex` — the daemon's defaults). Display copy for the
    /// state-derived blocked banner, which knows no exact path.
    static func conventionalActiveLinkPath(for provider: DeckProvider) -> String {
        "~/.\(provider.rawValue)"
    }

    /// The URL "Reveal in Finder" should select for a banner's
    /// `blockedPath`, or nil when nothing exists there (a custom
    /// active-link override, or the user already moved it) — never offer a
    /// reveal that Finder can't honor.
    public static func revealURL(
        forBlockedPath path: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> URL? {
        let expanded = (path as NSString).expandingTildeInPath
        guard fileExists(expanded) else { return nil }
        return URL(fileURLWithPath: expanded)
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
            // Issue #227 (Tim's fresh-install field data): "a one-time
            // migration must run" named neither the blocker nor an action,
            // so repeated Retry read as a bug. Name the KIND of thing and
            // WHERE (the daemon's blocked verdict comes from lstat'ing the
            // active link — conventionally ~/.claude / ~/.codex — but the
            // state payload carries no path, so "usually" stays honest),
            // then give the click-level resolution.
            return "Activation blocked — an existing \(provider.displayName) "
                + "directory from a previous install is in the way (usually "
                + "\(conventionalActiveLinkPath(for: provider))). "
                + blockedResolutionSentence(accountLabel: selectedLabel)
        case .mismatched:
            return "Activation pending — the active link on disk points at a "
                + "different profile than \(selected)."
        case .unlinked:
            // Issue #228 (fresh install): with no selected account there is
            // no Complete Activation button anywhere — pointing at it was a
            // dead end. The real next step is picking an account: its radio
            // runs the same activation.
            guard selectedLabel != nil else {
                return "Activation ready — no \(provider.displayName) account is "
                    + "active yet. Pick an account below to activate it."
            }
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
