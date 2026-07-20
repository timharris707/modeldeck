import Foundation

// Issue #42 — honest footer freshness. The old footer timestamped the APP's
// last GET of the daemon cache ("Updated just now" while the underlying
// provider observation was hours old). The footer now derives from the
// newest usage snapshot's `observedAt` — the moment a provider actually
// reported numbers — and flags staleness when that age exceeds ~2x the
// configured auto-refresh interval or when the daemon marks rows stale.
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

    /// Whether the daemon flagged any snapshot as stale (per-row `stale`
    /// carried by the payload — honored verbatim, issue #42).
    public static func anyRowStale(in state: DeckState) -> Bool {
        state.usage.contains(where: \.stale)
    }

    /// "Data from just now" / "Data from 5 min ago" / "Data from 2 hr ago" /
    /// "Data from 3 days ago". Future timestamps (clock skew) read as now.
    public static func text(observedAt: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(observedAt)
        if seconds < 60 { return "Data from just now" }
        if seconds < 3_600 { return "Data from \(Int(seconds / 60)) min ago" }
        if seconds < 86_400 { return "Data from \(Int(seconds / 3_600)) hr ago" }
        let days = Int(seconds / 86_400)
        return days == 1 ? "Data from 1 day ago" : "Data from \(days) days ago"
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
}
