import Foundation

// Issue #175 — honest idle rollforward, PRESENTATION-ONLY (second half of
// spike #173's approved Avenue A; pairs with #174's statusline capture).
//
// The problem: an idle account's stored snapshot keeps rendering as if
// current long after its window has provably closed. Once `resetsAt` passes
// with no newer observation, exactly ONE local fact is provable: the window
// that was open at `observedAt` has ended. Everything else — how much the
// account has since been used from other devices/surfaces, spend accrual,
// plan changes, provider-side rebalancing — diverges silently, because
// limits are per-ACCOUNT while our idleness signal is per-machine-profile.
//
// The contract (#173 findings, Tim-approved):
// - Render FACTS, not numbers. After a 5-hour `resetsAt` passes idle the
//   row says "5-hour window reset since last use"; after a weekly
//   `resetsAt` passes it says the weekly variant, and the tooltip carries
//   the #101 unanchored-next-reset precedent ("resets 7 days after first
//   use" — post-reset there is no anchored next instant until the account
//   is used). A derived PERCENTAGE is never fabricated, and the stored
//   stale % must not render as if current once its window has closed.
// - Derivation lives entirely here, at render time, over the latest STORED
//   snapshot fields. Nothing is ever written back: `observedAt` never
//   advances, `recordUsage` never sees a derived row (protecting the
//   `weeklyResetFingerprint` duplicate-token detection, #65/#108), and the
//   #89 stale markers, #149 idle split, #168 footer, menu-bar percentage,
//   and /api/capacity all keep consuming the stored values unchanged.
// - One-line row footprint (#145 discipline): the notice replaces the reset
//   slot's text — never a second line; the fuller explanation lives in the
//   hover tooltip.
public enum IdleRollforward {
    /// What a rolled-while-idle window renders in its reset slot: the
    /// one-line fact, the fuller tooltip, and a VoiceOver label carrying
    /// both.
    public struct Notice: Equatable, Sendable {
        public var text: String
        public var tooltip: String
        public var accessibilityLabel: String

        public init(text: String, tooltip: String, accessibilityLabel: String) {
            self.text = text
            self.tooltip = tooltip
            self.accessibilityLabel = accessibilityLabel
        }
    }

    /// The window families the copy distinguishes.
    enum WindowKind {
        case fiveHour
        case weekly
        case other
    }

    static func kind(forScope scope: String) -> WindowKind {
        let title = DeckBuilder.windowTitle(for: scope)
        if title == "5-hour limit" { return .fiveHour }
        if title.hasPrefix("Weekly · ") { return .weekly }
        return .other
    }

    /// Shared tooltip lead: the provable fact, stated plainly.
    static let tooltipLead = "This window's reset time passed after the last "
        + "observation, so the stored numbers describe a window that has "
        + "already ended."

    /// Non-nil exactly when the stored window has PROVABLY closed since it
    /// was observed: a non-spend window whose `resetsAt` is real (never the
    /// #101 unanchored placeholder), was still ahead at `observedAt`, and
    /// now lies in the past. Missing `observedAt` (old daemons) or a
    /// `resetsAt` at/before the observation — data that already reflects
    /// the post-reset window — never fires: absent proof, the existing
    /// presentation stands.
    public static func notice(
        scope: String,
        anchor: WindowAnchor,
        resetsAt: Date?,
        observedAt: Date?,
        windowDuration: TimeInterval?,
        now: Date
    ) -> Notice? {
        guard !UsageScope.isSpend(scope) else { return nil }
        // Unanchored resetsAt is a drifting placeholder (probe time +
        // duration), not a real close; recently-rolled means fresh data
        // ARRIVED after the roll. Only a plainly anchored window can prove
        // an idle rollover.
        guard case .anchored = anchor else { return nil }
        guard let resetsAt, let observedAt else { return nil }
        guard observedAt < resetsAt, resetsAt <= now else { return nil }

        let text: String
        let tooltip: String
        switch kind(forScope: scope) {
        case .fiveHour:
            text = "5-hour window reset since last use"
            tooltip = tooltipLead + " A new 5-hour window starts with the "
                + "next request — fresh numbers arrive on next use."
        case .weekly:
            // #101 unanchored precedent: after the roll there is no anchored
            // next reset instant until the account is used again.
            let duration = WindowPresentation.durationPhrase(windowDuration ?? 7 * 86_400)
            text = "Weekly window reset since last use"
            tooltip = tooltipLead + " The next weekly window is unanchored — "
                + "it resets \(duration) after first use. Fresh numbers "
                + "arrive on next use."
        case .other:
            text = "Window reset since last use"
            tooltip = tooltipLead + " Fresh numbers arrive on next use."
        }
        return Notice(
            text: text,
            tooltip: tooltip,
            accessibilityLabel: "\(text) — \(tooltip)"
        )
    }
}
