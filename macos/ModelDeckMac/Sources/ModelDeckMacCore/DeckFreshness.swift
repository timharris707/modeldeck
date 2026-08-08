import Foundation

// Issue #42 — honest footer freshness. The old footer timestamped the APP's
// last GET of the daemon cache ("Updated just now" while the underlying
// provider observation was hours old). The footer now derives from usage
// snapshot `observedAt` values — the moment a provider actually reported
// numbers — and flags staleness when the age exceeds ~2x the configured
// auto-refresh interval or when the daemon marks rows stale.
//
// Issue #89 — per-ACCOUNT honesty. One account's fetch can fail silently for
// hours while the others keep refreshing; a footer keyed on the NEWEST
// observation then claims freshness the stale card doesn't have. The footer
// now keys on the OLDEST account's newest observation ("Oldest data N min
// ago"), and each card carries its own staleness marker via `cardStaleness`.
public enum DeckFreshness {
    /// Staleness threshold multiplier over the auto-refresh cadence: data
    /// older than two missed refresh ticks is presented as stale.
    public static let staleMultiplier: Double = 2
    /// Threshold fallback when auto-refresh is disabled (interval 0) — the
    /// spec's default 5-minute cadence, so "stale" still means something.
    public static let fallbackInterval: TimeInterval = 300

    /// The newest provider observation across all usage snapshots, or nil
    /// when no snapshot carries a parseable `observedAt` (older daemons) —
    /// callers then fall back to the app-side "Updated…" timestamp.
    public static func newestObservedAt(in state: DeckState) -> Date? {
        state.usage.compactMap { DeckDateParsing.date(from: $0.observedAt) }.max()
    }

    /// Issue #89: the footer's basis — each account's NEWEST observation,
    /// then the MINIMUM across accounts, so one silently failing account can
    /// no longer hide behind its siblings' fresh data. Disabled accounts are
    /// excluded (they don't refresh by design); usage rows whose account the
    /// state doesn't list are kept (honest default). Nil when no snapshot
    /// carries a parseable `observedAt`.
    public static func oldestAccountObservation(in state: DeckState) -> Date? {
        let disabled = Set(state.accounts.filter { !$0.enabled }.map(\.id))
        var newestByAccount: [String: Date] = [:]
        for snapshot in state.usage where !disabled.contains(snapshot.accountId) {
            guard let date = DeckDateParsing.date(from: snapshot.observedAt) else { continue }
            newestByAccount[snapshot.accountId] = max(newestByAccount[snapshot.accountId] ?? .distantPast, date)
        }
        return newestByAccount.values.min()
    }

    /// Whether the daemon flagged any snapshot as stale (per-row `stale`
    /// carried by the payload — honored verbatim, issue #42).
    public static func anyRowStale(in state: DeckState) -> Bool {
        state.usage.contains(where: \.stale)
    }

    /// "just now" / "5 min ago" / "2 hr ago" / "3 days ago". Future
    /// timestamps (clock skew) read as now.
    public static func ageText(observedAt: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(observedAt)
        if seconds < 60 { return "just now" }
        if seconds < 3_600 { return "\(Int(seconds / 60)) min ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600)) hr ago" }
        let days = Int(seconds / 86_400)
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }

    /// Footer line (issue #89 wording): "Oldest data just now" /
    /// "Oldest data 5 min ago" — global, but keyed on the account whose data
    /// is oldest, so it can never claim freshness a card doesn't have.
    public static func text(observedAt: Date, now: Date) -> String {
        "Oldest data \(ageText(observedAt: observedAt, now: now))"
    }

    /// Age-based staleness: strictly older than `staleMultiplier` × the
    /// auto-refresh interval (fallback cadence when refresh is disabled).
    public static func isStale(
        observedAt: Date,
        now: Date,
        autoRefreshInterval: TimeInterval
    ) -> Bool {
        let interval = autoRefreshInterval > 0 ? autoRefreshInterval : fallbackInterval
        return now.timeIntervalSince(observedAt) > staleMultiplier * interval
    }

    // MARK: - Per-card staleness (issue #89)

    /// What a stale card renders: a compact warning line ("Data from 16 hr
    /// ago"), a tooltip that adds the account's last refresh error, and a
    /// VoiceOver label carrying both. Nil (no marker) while the card's data
    /// is inside the staleness threshold — honest-states: stale data must
    /// LOOK stale, fresh data must not cry wolf.
    /// Issue #185: also carries WHY (`cause`), so the click-through
    /// explanation can lead with the right coaching instead of a raw error.
    public struct CardStaleness: Equatable, Sendable {
        /// Issue #185: why this card's data is old. `.helperMissing` is the
        /// daemon-binary-vanished state (launched from a since-deleted
        /// bundle): the raw "spawn /private/var/… ENOENT" Tim hit live is
        /// exactly what the classification exists to replace.
        public enum Cause: Equatable, Sendable {
            /// No refresh error on record — the provider simply hasn't
            /// reported newer numbers.
            case noNewData
            /// The account's last refresh failed for an ordinary reason;
            /// the daemon's message rides along verbatim.
            case refreshFailed
            /// The daemon's own executable is gone (issue #185) — the app
            /// repairs this automatically; the copy says so.
            case helperMissing
        }

        public var text: String
        public var tooltip: String
        public var accessibilityLabel: String
        public var cause: Cause

        public init(
            text: String,
            tooltip: String,
            accessibilityLabel: String,
            cause: Cause = .noNewData
        ) {
            self.text = text
            self.tooltip = tooltip
            self.accessibilityLabel = accessibilityLabel
            self.cause = cause
        }
    }

    /// Issue #185: the friendly replacement for the helper-missing refresh
    /// error — no dead spawn paths, and it says what happens next (the app
    /// reinstalls the service automatically; #185's repair path).
    public static let helperMissingReason = "ModelDeck's background helper lost its program file (this can happen after an app update or move). ModelDeck reinstalls it automatically — refresh to pull fresh data, and if this notice persists, quit and reopen ModelDeck."

    /// Issue #185: whether a per-account refresh error means the daemon's
    /// own binary is gone. Matches the daemon's HELPER_MISSING phrase
    /// (src/adapters/claude.mjs) AND the raw pre-#185 shape ("spawn
    /// /private/var/…/modeldeckd ENOENT") so cards against an old daemon
    /// get the friendly copy too. The legacy fallback requires the daemon
    /// binary's own name (CodeRabbit, PR #186): a provider CLI missing from
    /// PATH also spawns into ENOENT ("spawn codex ENOENT") and must stay an
    /// ordinary refresh failure, never the helper coaching.
    public static func refreshErrorIndicatesMissingHelper(_ message: String) -> Bool {
        let lowered = message.lowercased()
        if lowered.contains("background helper is missing") { return true }
        return lowered.contains("spawn") && lowered.contains("enoent")
            && lowered.contains("modeldeckd")
    }

    /// Card-level staleness for one account: its newest snapshot older than
    /// ~2x the effective refresh interval earns the marker. No observation
    /// at all means there is nothing to present as stale (the card already
    /// shows no meters). The daemon's `lastRefreshError` message, when
    /// present, rides along in the tooltip so the marker explains WHY —
    /// except the helper-missing class (issue #185), which renders the
    /// friendly coaching instead of a dead spawn path.
    public static func cardStaleness(
        newestObservedAt: Date?,
        lastRefreshError: AccountRefreshError?,
        now: Date,
        autoRefreshInterval: TimeInterval
    ) -> CardStaleness? {
        guard let newestObservedAt,
              isStale(observedAt: newestObservedAt, now: now, autoRefreshInterval: autoRefreshInterval)
        else { return nil }
        let text = "Data from \(ageText(observedAt: newestObservedAt, now: now))"
        let cause: CardStaleness.Cause
        let reason: String
        if let message = lastRefreshError?.message, !message.isEmpty {
            if refreshErrorIndicatesMissingHelper(message) {
                cause = .helperMissing
                reason = helperMissingReason
            } else {
                cause = .refreshFailed
                reason = "Last refresh failed: \(message)"
            }
        } else {
            cause = .noNewData
            reason = "No newer data has arrived from the provider."
        }
        return CardStaleness(
            text: text,
            tooltip: "\(text) — \(reason)",
            accessibilityLabel: "Stale data — \(text.lowercased()). \(reason)",
            cause: cause
        )
    }

    // MARK: - Explained staleness (issue #168)

    /// One stale enabled account as the footer sees it: its label, the age
    /// basis (nil when the daemon flagged rows stale without a parseable
    /// observation), and WHY the data is old.
    public struct StaleAccountEntry: Equatable, Sendable {
        /// Why an account's data is old. Tim's decision (issue #168):
        /// staleness EXPLAINED by a card-level state (idle-decay #149,
        /// signed-out #114/#164, Keychain-blocked #98 — every state whose
        /// card notice already accounts for the age) is not an alarm; the
        /// footer's amber fires only for `.unexplained` — the #89 original
        /// mission, silent fetch failures.
        public enum Reason: Equatable, Sendable {
            case idle
            case signedOut
            case keychainAccess
            case unexplained(errorMessage: String?)

            public var isExplained: Bool {
                if case .unexplained = self { return false }
                return true
            }
        }

        public var label: String
        public var observedAt: Date?
        public var reason: Reason

        public init(label: String, observedAt: Date?, reason: Reason) {
            self.label = label
            self.observedAt = observedAt
            self.reason = reason
        }
    }

    /// The footer's per-account staleness picture (issue #168): every stale
    /// enabled account with its reason (oldest first), plus whether any
    /// enabled account is currently fresh (drives the "Live accounts
    /// current" lead segment).
    public struct FooterBreakdown: Equatable, Sendable {
        public var stale: [StaleAccountEntry]
        public var hasCurrentAccounts: Bool

        public init(stale: [StaleAccountEntry], hasCurrentAccounts: Bool) {
            self.stale = stale
            self.hasCurrentAccounts = hasCurrentAccounts
        }

        /// True when staleness exists and every bit of it is explained —
        /// the neutral-footer condition.
        public var allExplained: Bool {
            !stale.isEmpty && stale.allSatisfy(\.reason.isExplained)
        }

        /// True when at least one stale account has no explaining card
        /// state — the ONLY condition that ambers the footer.
        public var hasUnexplained: Bool {
            stale.contains { !$0.reason.isExplained }
        }
    }

    /// Classifies every enabled account the footer basis covers (issue
    /// #168). Same basis as `oldestAccountObservation`: per-account newest
    /// observation, disabled accounts excluded, usage rows without a listed
    /// account kept (honest default — they classify as unexplained). An
    /// account is stale when its age exceeds the threshold OR the daemon
    /// flagged any of its rows stale; the reason comes from the SAME
    /// card-state derivations the cards render from (#98/#114/#149), so the
    /// footer and the cards can never disagree about an account's story.
    public static func footerBreakdown(
        state: DeckState,
        now: Date,
        autoRefreshInterval: TimeInterval
    ) -> FooterBreakdown {
        let disabled = Set(state.accounts.filter { !$0.enabled }.map(\.id))
        var newestByAccount: [String: Date] = [:]
        var flagged: Set<String> = []
        for snapshot in state.usage where !disabled.contains(snapshot.accountId) {
            if snapshot.stale { flagged.insert(snapshot.accountId) }
            guard let date = DeckDateParsing.date(from: snapshot.observedAt) else { continue }
            newestByAccount[snapshot.accountId] = max(newestByAccount[snapshot.accountId] ?? .distantPast, date)
        }
        var accountsByID: [String: DeckAccount] = [:]
        for account in state.accounts where account.enabled {
            accountsByID[account.id] = accountsByID[account.id] ?? account
        }
        var ids = state.accounts.filter(\.enabled).map(\.id)
        for id in newestByAccount.keys.sorted() where !ids.contains(id) { ids.append(id) }
        for id in flagged.sorted() where !ids.contains(id) { ids.append(id) }

        var stale: [StaleAccountEntry] = []
        var hasCurrent = false
        for id in ids {
            let account = accountsByID[id]
            let observedAt = newestByAccount[id]
            let ageStale = observedAt.map {
                isStale(observedAt: $0, now: now, autoRefreshInterval: autoRefreshInterval)
            } ?? false
            guard ageStale || flagged.contains(id) else {
                if observedAt != nil { hasCurrent = true }
                continue
            }
            let reason: StaleAccountEntry.Reason
            if let account {
                if keychainRecovery(for: account) != nil {
                    reason = .keychainAccess
                } else if let recovery = signInRecovery(for: account) {
                    reason = recovery.tone == .idle ? .idle : .signedOut
                } else {
                    reason = .unexplained(errorMessage: account.lastRefreshError?.message)
                }
            } else {
                reason = .unexplained(errorMessage: nil)
            }
            stale.append(StaleAccountEntry(
                label: account?.label ?? id,
                observedAt: observedAt,
                reason: reason
            ))
        }
        stale.sort { ($0.observedAt ?? .distantFuture) < ($1.observedAt ?? .distantFuture) }
        return FooterBreakdown(stale: stale, hasCurrentAccounts: hasCurrent)
    }

    /// The neutral footer line for the all-explained state (issue #168,
    /// Tim's example copy): "Live accounts current · 3 idle". Segments in
    /// fixed order, joined with " · ": the live lead (only when a fresh
    /// enabled account exists), then idle, signed-out, and Keychain counts
    /// (only when non-zero).
    public static func explainedFooterText(_ breakdown: FooterBreakdown) -> String {
        var idle = 0, signedOut = 0, keychain = 0
        for entry in breakdown.stale {
            switch entry.reason {
            case .idle: idle += 1
            case .signedOut: signedOut += 1
            case .keychainAccess: keychain += 1
            case .unexplained: break
            }
        }
        var parts: [String] = []
        if breakdown.hasCurrentAccounts { parts.append("Live accounts current") }
        if idle > 0 { parts.append("\(idle) idle") }
        if signedOut > 0 { parts.append("\(signedOut) signed out") }
        if keychain > 0 {
            parts.append(keychain == 1 ? "1 needs Keychain access" : "\(keychain) need Keychain access")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - Keychain access recovery (issue #98)

    /// What a keychain-denied card renders instead of the bare stale line: a
    /// short actionable notice ("ModelDeck needs Keychain access") whose
    /// tooltip explains what happened (macOS refused the daemon's read —
    /// usually a dismissed prompt) and exactly how to recover (Refresh, then
    /// Always Allow). Honest-states: the card must never sit on
    /// stale-looking data when the real problem has a one-click fix.
    public struct KeychainAccessRecovery: Equatable, Sendable {
        public var text: String
        public var tooltip: String
        public var accessibilityLabel: String

        public init(text: String, tooltip: String, accessibilityLabel: String) {
            self.text = text
            self.tooltip = tooltip
            self.accessibilityLabel = accessibilityLabel
        }
    }

    /// The recovery detail shared by the tooltip and VoiceOver label.
    static let keychainRecoveryDetail = "macOS blocked ModelDeck's background service from reading this account's Claude sign-in — usually a dismissed Keychain prompt. Click Refresh and choose Always Allow when macOS asks (one prompt per account; properly signed app updates won't re-prompt)."

    /// Non-nil exactly when the daemon reported `keychain-denied` for this
    /// account (issue #98). Pure derivation, no clock involved — the denial
    /// is a state, not an age.
    public static func keychainRecovery(for account: DeckAccount) -> KeychainAccessRecovery? {
        guard account.keychainAccessDenied else { return nil }
        let text = "ModelDeck needs Keychain access"
        return KeychainAccessRecovery(
            text: text,
            tooltip: keychainRecoveryDetail,
            accessibilityLabel: "\(text) — \(keychainRecoveryDetail)"
        )
    }

    // MARK: - Sign-in recovery (issue #114)

    /// What a signin-required card renders instead of the bare stale line.
    /// Issue #114 found three non-active Claude accounts sitting on plain
    /// "Data from N hr ago" markers while the daemon had been reporting
    /// `signin-required` (expired stored sign-in) the whole time — the only
    /// honest signal lived in a tooltip and the Settings roster chip. Same
    /// visual family as the #98 Keychain notice: the actionable state, not
    /// the age, is the headline.
    public struct SignInRecovery: Equatable, Sendable {
        /// Issue #149: how the notice presents. `.signedOut` is the amber
        /// alarm ("Sign in needed" — the stored sign-in is genuinely gone);
        /// `.idle` is the calm neutral idle-decay state ("Idle — renews on
        /// next use": the sign-in exists and renews the next time the
        /// account is used; its data is merely paused). Tim directive
        /// (issue #149 comment): SAME footprint, SAME click → explanation →
        /// one-click sign-in path in both tones — this is a
        /// wording/tone/color split on one affordance, never a second
        /// notice. The idle text is deliberately as terse as the alarm so
        /// it stays single-line in the two-column card width; the full
        /// renewal sentence lives in the tooltip/explanation body.
        public enum Tone: Equatable, Sendable {
            case signedOut
            case idle
            /// Issue #264: idle-flagged BUT currently producing fresh
            /// server-truth — a running session's statusline captures are
            /// keeping this account's numbers current while its stored
            /// sign-in is still marked expired (and ModelDeck's auto-renew
            /// keeps firing in the background). Only the clocked
            /// `signInRecovery(for:newestObservedAt:now:autoRefreshInterval:)`
            /// derivation produces this tone; the clock-free variant never
            /// does, so age-blind surfaces (footer breakdown, Settings
            /// roster) keep their existing idle story.
            case liveIdle
        }

        public var text: String
        public var tooltip: String
        public var accessibilityLabel: String
        public var tone: Tone

        public init(
            text: String,
            tooltip: String,
            accessibilityLabel: String,
            tone: Tone = .signedOut
        ) {
            self.text = text
            self.tooltip = tooltip
            self.accessibilityLabel = accessibilityLabel
            self.tone = tone
        }
    }

    /// Shared recovery coaching for the tooltip and VoiceOver label.
    static let signInRecoveryDetail = "This account's stored sign-in is missing or has expired, so ModelDeck can't refresh its usage. Sign in again from Settings → Accounts."

    /// Issue #149: the calm idle-decay lead — the stored sign-in EXISTS but
    /// expired while the account sat idle; the provider CLI renews it
    /// automatically on next use, so the data is paused, not broken. The
    /// same one-click sign-in path stays for "fresh data now".
    static let idleSignInDetail = "This account's stored sign-in expired while idle, so its usage data is paused. Using the account again renews the sign-in automatically — or sign in now from Settings → Accounts to refresh right away."

    /// Issue #264: the live lead — the stored sign-in is still marked
    /// expired, but a running session is reporting current usage
    /// (server-truth statusline captures), so the numbers on the card are
    /// live, not paused. ModelDeck's automatic renewal keeps working in the
    /// background; the same one-click sign-in path stays for doing it now.
    static let liveIdleSignInDetail = "A running session is reporting this account's current usage, so its numbers are live. Its stored sign-in still needs renewal — ModelDeck keeps renewing it automatically in the background, or sign in now from Settings → Accounts."

    /// Claude-only context (issue #114 root cause): Claude Code ≥ 2.1.216
    /// renews only the ACTIVE account's stored sign-in, so every other
    /// account's sign-in expires within hours of its last use and stays
    /// expired. Worth saying on the card — otherwise a healthy-looking
    /// multi-account deck decays into sign-in failures with no visible cause.
    static let signInRecoveryClaudeDetail = "Claude keeps only the active account's sign-in fresh, so other accounts' sign-ins expire until they are next signed in. Activating this account and running Claude Code once may also renew it."

    /// Non-nil exactly when the daemon reported `signin-required` for this
    /// account (issue #89's authState) — pure derivation, no clock. The
    /// keychain-denied notice never coexists with this one: `authState` is
    /// single-valued, and the row model gives #98's notice precedence.
    ///
    /// Issue #149: the notice splits by tone on `signinReason`. "expired"
    /// (idle-decay) renders the calm neutral idle text; "missing" — or an
    /// absent reason from an old daemon — keeps the pre-#149 "Sign in
    /// needed" alarm VERBATIM. Both tones keep the full #114 structural
    /// story for Claude and the last-refresh-error line; both occupy the
    /// same single notice slot and drive the same #118 one-click path.
    public static func signInRecovery(for account: DeckAccount) -> SignInRecovery? {
        let tone: SignInRecovery.Tone
        switch account.healthChip {
        case .signInAgain: tone = .signedOut
        case .idleSignIn: tone = .idle
        default: return nil
        }
        var detail = tone == .idle ? idleSignInDetail : signInRecoveryDetail
        if account.provider == "claude" {
            detail += " \(signInRecoveryClaudeDetail)"
        }
        if let message = account.lastRefreshError?.message, !message.isEmpty {
            detail += " Last refresh failed: \(message)"
        }
        // Orchestrator verify on PR #150: the notice must stay ONE line in
        // the two-column card width (Tim's constraint 1 — same footprint),
        // so the deck copy matches the Settings chip verbatim and the full
        // "renews when this account is next used" sentence stays in the
        // tooltip and explanation popover where it always was.
        let text = tone == .idle
            ? "Idle — renews on next use"
            : "Sign in needed"
        return SignInRecovery(
            text: text,
            tooltip: detail,
            accessibilityLabel: "\(text) — \(detail)",
            tone: tone
        )
    }

    /// Issue #264 — the clocked derivation: presentation split from renewal
    /// candidacy. Statusline captures (#174) record server-truth usage for
    /// an account whose stored sign-in is still flagged expired; the flag
    /// must SURVIVE (it is what keeps `performClaudeRenewal` firing), but
    /// the card must stop claiming "Idle — renews on next use" over numbers
    /// a live session updated seconds ago. When the `.idle` tone's account
    /// has an observation inside the deck's own staleness rule (the same
    /// 2×-interval basis as `cardStaleness`), the notice upgrades to the
    /// `.liveIdle` tone — same slot, same footprint, same click-through and
    /// one-click sign-in path (Tim's #149 directive: one affordance, tone
    /// splits only). Every other case returns the clock-free derivation
    /// unchanged, including the `.signedOut` alarm: a genuinely missing
    /// sign-in stays an alarm even while old data sits on the card.
    public static func signInRecovery(
        for account: DeckAccount,
        newestObservedAt: Date?,
        now: Date,
        autoRefreshInterval: TimeInterval
    ) -> SignInRecovery? {
        guard let base = signInRecovery(for: account) else { return nil }
        guard base.tone == .idle,
              let newestObservedAt,
              !isStale(observedAt: newestObservedAt, now: now, autoRefreshInterval: autoRefreshInterval)
        else { return base }
        // Same composition as the base derivation: lead, Claude structural
        // context, then the honest last-refresh-error line (the error is
        // exactly WHY the account is still flagged — hiding it would make
        // the live state look like a cleared flag, which it is not).
        var detail = liveIdleSignInDetail
        if account.provider == "claude" {
            detail += " \(signInRecoveryClaudeDetail)"
        }
        if let message = account.lastRefreshError?.message, !message.isEmpty {
            detail += " Last refresh failed: \(message)"
        }
        // Terse like both existing tones (the PR #150 one-line contract);
        // the full story lives in the tooltip/explanation body.
        let text = "Live — renews automatically"
        return SignInRecovery(
            text: text,
            tooltip: detail,
            accessibilityLabel: "\(text) — \(detail)",
            tone: .liveIdle
        )
    }
}
