import Foundation

// Issue #113 — reachable explanations. The deck popover's warning
// affordances (duplicate-login marker, stale line, keychain notice, the
// footer's oldest-data line, the slowed-refresh tortoise) explained
// themselves only via `.help` tooltips, which are unreliable inside an
// NSPopover/MenuBarExtra window (known AppKit/SwiftUI quirk) — Tim, live on
// v0.3.0, hovered AND clicked and got nothing. Honest states require the
// WHY to be reachable, so every affordance now opens a small anchored
// explanation popover on CLICK. The content here is pure selection over the
// EXISTING explanation strings — the tooltips stay as progressive
// enhancement, and nothing diverges from the single source of truth.

/// Which kind of warning affordance an explanation belongs to.
public enum DeckWarningTopic: Hashable, Sendable {
    /// The hollow amber duplicate-login marker (issue #65).
    case duplicateToken
    /// The per-card stale age line (issue #89).
    case staleData
    /// The per-card Keychain recovery notice (issue #98).
    case keychainAccess
    /// The per-card sign-in notice (issues #114/#118) — both #149 tones
    /// ("Sign in needed" and the calm idle variant) share this one topic:
    /// same affordance, same popover, same one-click action.
    case signInRequired
    /// The footer's slowed-refresh tortoise indicator (issue #90).
    case refreshCadence
    /// The footer's "Oldest data N min ago" line (issues #42/#89).
    case footerFreshness
}

/// Identity of ONE clickable warning affordance: the topic plus the element
/// it is attached to (an account id for per-card affordances; the shared
/// footer element for footer indicators). The popover model holds at most
/// one presented id at a time — a second click on the same affordance
/// dismisses, a click on a different one switches.
public struct DeckWarningID: Hashable, Sendable {
    /// The shared element id for footer-level affordances.
    public static let footerElementID = "footer"

    public var topic: DeckWarningTopic
    public var elementID: String

    public init(topic: DeckWarningTopic, elementID: String = DeckWarningID.footerElementID) {
        self.topic = topic
        self.elementID = elementID
    }
}

/// What an explanation popover renders: a short title line and the full
/// explanation body. Every builder below reuses an existing, already-tested
/// string verbatim — the click-to-explain surface must never grow its own
/// diverging copy.
public struct DeckWarningExplanation: Equatable, Sendable {
    public var title: String
    public var body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }

    /// The duplicate-login marker's explanation (issue #65): the marker
    /// caption as the lead sentence, then the accounts-banner [Why?] detail
    /// — both verbatim from their single sources.
    ///
    /// Issue #152: when the explanation carries the "Re-log in" action
    /// (`reloginLabel` non-nil), one more line names the exact profile the
    /// button re-logs and states that re-logging either member of the
    /// duplicate pair under its correct account clears both — the ambiguity
    /// Tim hit. Still single-source: the hint is
    /// `DuplicateTokenMarker.reloginHint`, verbatim.
    public static func duplicateToken(
        reloginLabel: String? = nil,
        provider: DeckProvider? = nil
    ) -> DeckWarningExplanation {
        var body = "\(DuplicateTokenMarker.caption).\n\n\(AccountsRoster.duplicateTokenDetail)"
        if let reloginLabel {
            body += "\n\n" + DuplicateTokenMarker.reloginHint(
                label: reloginLabel,
                providerName: provider?.displayName ?? "the provider"
            )
        }
        return DeckWarningExplanation(title: "Duplicate login", body: body)
    }

    /// A stale card line's explanation (issue #89): the existing tooltip,
    /// which already carries the data age plus the account's last refresh
    /// error when the daemon reported one.
    public static func stale(_ staleness: DeckFreshness.CardStaleness) -> DeckWarningExplanation {
        DeckWarningExplanation(title: "Stale data", body: staleness.tooltip)
    }

    /// The Keychain recovery notice's explanation (issue #98): the notice
    /// text as title, the existing recovery tooltip as body.
    public static func keychain(_ recovery: DeckFreshness.KeychainAccessRecovery) -> DeckWarningExplanation {
        DeckWarningExplanation(title: recovery.text, body: recovery.tooltip)
    }

    /// The sign-in notice's explanation (issues #114/#118): the notice text
    /// as title, the existing recovery tooltip as body — the same
    /// verbatim-reuse contract as every other builder here. The explanation
    /// popover additionally carries the #118 "Sign in again…" primary
    /// action, which is presentation (view-side), not copy. Issue #149:
    /// both tones flow through unchanged — the recovery already carries the
    /// tone-honest title and body, so this builder needs no split.
    public static func signIn(_ recovery: DeckFreshness.SignInRecovery) -> DeckWarningExplanation {
        DeckWarningExplanation(title: recovery.text, body: recovery.tooltip)
    }

    /// The slowed-refresh indicator's explanation (issue #90): the notice's
    /// existing text and tooltip.
    public static func cadence(_ notice: MenuBarStatusModel.RefreshCadenceNotice) -> DeckWarningExplanation {
        DeckWarningExplanation(title: notice.text, body: notice.tooltip)
    }
}

extension DeckFreshness {
    /// Issue #113 addendum (Tim, live): after a Refresh updated some cards,
    /// the unchanged "Oldest data 14 hr ago" footer read as a refresh bug —
    /// nothing said WHICH account was dragging the number. Clicking the
    /// footer line now explains the oldest-account basis and names the
    /// stale account(s) with their ages, derived from the SAME per-card
    /// staleness math the cards use (single source of truth).
    public static func footerFreshnessExplanation(
        state: DeckState?,
        now: Date,
        autoRefreshInterval: TimeInterval
    ) -> DeckWarningExplanation {
        let title = "Data freshness"
        let lead = "This is the age of the OLDEST account's newest "
            + "provider-reported data — one lagging account sets this number "
            + "even while the others refresh."
        guard let state, !state.accounts.isEmpty else {
            return DeckWarningExplanation(
                title: title,
                body: "\(lead)\n\nNo account data has arrived yet."
            )
        }
        // Per-account newest observation — the same basis as
        // `oldestAccountObservation` (issue #89), kept per account so each
        // laggard can be named with its own age.
        var newestByAccount: [String: Date] = [:]
        for snapshot in state.usage {
            guard let date = DeckDateParsing.date(from: snapshot.observedAt) else { continue }
            newestByAccount[snapshot.accountId] = max(newestByAccount[snapshot.accountId] ?? .distantPast, date)
        }
        // Disabled accounts don't refresh by design and are excluded from
        // the footer basis, so they are excluded here too. Note: no
        // keychain-notice suppression — the footer's job is to name every
        // account whose age drags the number, whatever the reason.
        let laggards = state.accounts
            .filter(\.enabled)
            .compactMap { account -> (label: String, observedAt: Date, staleness: CardStaleness)? in
                guard let observedAt = newestByAccount[account.id],
                      let staleness = cardStaleness(
                          newestObservedAt: observedAt,
                          lastRefreshError: account.lastRefreshError,
                          now: now,
                          autoRefreshInterval: autoRefreshInterval
                      )
                else { return nil }
                return (account.label, observedAt, staleness)
            }
            .sorted { $0.observedAt < $1.observedAt } // oldest first
        guard !laggards.isEmpty else {
            return DeckWarningExplanation(
                title: title,
                body: "\(lead)\n\nAll accounts are currently fresh."
            )
        }
        let lines = laggards.map { laggard in
            // "Data from 16 hr ago" → "• Client — data from 16 hr ago"
            "• \(laggard.label) — \(laggard.staleness.text.prefix(1).lowercased() + laggard.staleness.text.dropFirst())"
        }
        return DeckWarningExplanation(
            title: title,
            body: "\(lead)\n\nWaiting on:\n\(lines.joined(separator: "\n"))"
        )
    }
}
