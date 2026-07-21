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
    public struct CardStaleness: Equatable, Sendable {
        public var text: String
        public var tooltip: String
        public var accessibilityLabel: String

        public init(text: String, tooltip: String, accessibilityLabel: String) {
            self.text = text
            self.tooltip = tooltip
            self.accessibilityLabel = accessibilityLabel
        }
    }

    /// Card-level staleness for one account: its newest snapshot older than
    /// ~2x the effective refresh interval earns the marker. No observation
    /// at all means there is nothing to present as stale (the card already
    /// shows no meters). The daemon's `lastRefreshError` message, when
    /// present, rides along in the tooltip so the marker explains WHY.
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
        let reason: String
        if let message = lastRefreshError?.message, !message.isEmpty {
            reason = "Last refresh failed: \(message)"
        } else {
            reason = "No newer data has arrived from the provider."
        }
        return CardStaleness(
            text: text,
            tooltip: "\(text) — \(reason)",
            accessibilityLabel: "Stale data — \(text.lowercased()). \(reason)"
        )
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
}
