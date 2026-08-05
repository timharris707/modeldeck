import Foundation

// Issue #101 — Codex cards: floating reset times on unused windows and
// missing rollover context made CORRECT data look wrong during the v0.3
// hand test. The probes are faithful (source: codex-app-server); this file
// is pure presentation-side derivation over existing snapshot fields.
//
// Two states are detected per window, both documented here because the
// heuristics are the point of the issue:
//
// 1. UNANCHORED ("fresh window"). An account with no usage in the current
//    period has no anchored window; the provider computes
//    `resetsAt ≈ probeTime + windowDuration` fresh on every probe, so the
//    displayed reset time drifts on every refresh (observed 10:33 AM →
//    12:03 PM across probes). Detection: zero recorded usage
//    (used ≤ 0.05%) AND `resetsAt - observedAt` within ±5 minutes of the
//    window duration. `observedAt` — the probe time — is the comparison
//    base, NOT `now`: the server computed `resetsAt` at probe time, so the
//    relation holds regardless of how old the snapshot is. The ±5-minute
//    tolerance absorbs server-side rounding and probe latency while
//    staying far tighter than any plausible anchored window's remaining
//    time. Drift-tracking across refreshes was considered and rejected:
//    it needs cross-refresh state for something a single snapshot already
//    proves, and it cannot classify the FIRST snapshot after launch.
//
//    Issue #247 adds the NULL form of the same state: after a rollover and
//    before the first request, Anthropic's usage API reports 100%
//    remaining with `resetsAt=null` on every scope — no placeholder at
//    all. #145 rendered that as an empty reset slot, which Tim read in
//    the field (2026-08-04) as the account "not getting picked up" by the
//    proxy/daemon. Detection: zero recorded usage (same ceiling) AND no
//    `resetsAt`. Partial usage with a null reset is NOT reclassified —
//    that is genuinely missing data, and keeps the #145 empty slot.
//
// 2. RECENTLY ROLLED. A window that expired moments ago shows ~100% left
//    right after heavy use — factually right, cognitively wrong (Tim's
//    weekly rolled at 10:19 AM mid-hand-test after a heavy morning).
//    Detection: the window is anchored (fails test 1), usage is near zero
//    (used ≤ 1%), and the window's inferred start —
//    `resetsAt - windowDuration` — lies within the recency threshold
//    `min(windowDuration / 4, 3 hours)` before now. The annotation
//    ("Week reset just now" / "Week reset at 10:19 AM") preempts the
//    "this is broken" reaction and ages out on its own.
//
// The window duration comes from the daemon's `detail.windowDurationMins`
// (Codex snapshots carry it; additive decode in `UsageSnapshot`) with a
// scope-name fallback (5-hour / weekly families, Codex's "N-minute"
// scopes) so Claude windows classify consistently. No duration → no
// classification: `.anchored`, exactly the pre-#101 rendering.

/// How a usage window's reset time should be presented.
public enum WindowAnchor: Equatable, Sendable {
    /// Normal window: show the provider's reset time as-is.
    case anchored
    /// No usage this period — the provider's `resetsAt` is either a
    /// floating placeholder (probe time + duration) that drifts on every
    /// refresh, or null outright (#247: Anthropic after a rollover).
    /// Show "resets N after first use" copy instead of the fake timestamp
    /// (or the confusing blank).
    case unanchored(windowDuration: TimeInterval)
    /// The window rolled at `at` (its inferred start), recently enough
    /// that "100% left" needs the rollover annotation for context.
    case recentlyRolled(at: Date, windowDuration: TimeInterval)
}

public enum WindowPresentation {
    /// Unanchored test: how far `resetsAt - observedAt` may sit from the
    /// exact window duration. Absorbs provider rounding + probe latency.
    static let unanchoredTolerance: TimeInterval = 5 * 60
    /// Unanchored test: "no usage" ceiling, in used-percent.
    static let unanchoredMaxUsedPercent = 0.05
    /// Rollover test: "usage dropped to ~zero" ceiling, in used-percent.
    static let rolledMaxUsedPercent = 1.0
    /// Rollover annotation says "just now" within this window of the roll.
    static let rolloverJustNowWindow: TimeInterval = 5 * 60
    /// Rollover recency cap: annotation never outlives 3 hours (weekly
    /// windows) or a quarter of the window (shorter windows).
    static let rolloverRecencyCap: TimeInterval = 3 * 3600

    /// A weekly window's approximate duration, used to pick the "Week"
    /// noun in rollover copy.
    static let weekNounThreshold: TimeInterval = 6 * 86_400

    // MARK: Window duration

    /// The window duration for a snapshot, preferring the daemon's
    /// `detail.windowDurationMins` (Codex carries it) and falling back to
    /// the scope-name families both adapters emit. Nil when the duration
    /// is unknowable — the window then always renders `.anchored`.
    public static func windowDuration(scope: String, detailMinutes: Double?) -> TimeInterval? {
        if let detailMinutes, detailMinutes > 0 {
            return detailMinutes * 60
        }
        let title = DeckBuilder.windowTitle(for: scope)
        if title == "5-hour limit" { return 5 * 3600 }
        if title.hasPrefix("Weekly · ") { return 7 * 86_400 }
        // Codex labels non-standard windows "N-minute" (src/adapters/codex.mjs).
        let lower = scope.lowercased()
        for suffix in ["-minute", " minute"] where lower.hasSuffix(suffix) {
            if let minutes = Double(lower.dropLast(suffix.count).split(separator: " ").last ?? ""),
               minutes > 0 {
                return minutes * 60
            }
        }
        return nil
    }

    // MARK: Detection

    /// Classify a window. Pure function of snapshot-derived fields so the
    /// heuristic is directly unit-testable.
    public static func anchor(
        remainingPercent: Double?,
        resetsAt: Date?,
        observedAt: Date?,
        windowDuration: TimeInterval?,
        now: Date
    ) -> WindowAnchor {
        guard let windowDuration, windowDuration > 0, let remainingPercent else { return .anchored }
        let usedPercent = 100 - remainingPercent

        // Unanchored, null form (#247): full remaining and no resetsAt at
        // all — an untouched window whose provider omits even the
        // placeholder. Partial usage with a null reset stays .anchored
        // (missing data, not a fresh window; the slot renders empty per #145).
        guard let resetsAt else {
            return usedPercent <= unanchoredMaxUsedPercent
                ? .unanchored(windowDuration: windowDuration)
                : .anchored
        }

        // Unanchored, placeholder form: zero usage + resetsAt sits exactly
        // one window length after the probe that produced it.
        let reference = observedAt ?? now
        if usedPercent <= unanchoredMaxUsedPercent,
           abs(resetsAt.timeIntervalSince(reference) - windowDuration) <= unanchoredTolerance {
            return .unanchored(windowDuration: windowDuration)
        }

        // Recently rolled: anchored window whose inferred start is moments
        // ago and whose usage has (re)started from ~zero.
        if usedPercent <= rolledMaxUsedPercent {
            let rolledAt = resetsAt.addingTimeInterval(-windowDuration)
            let age = now.timeIntervalSince(rolledAt)
            let recency = min(windowDuration / 4, rolloverRecencyCap)
            if age > 0, age <= recency {
                return .recentlyRolled(at: rolledAt, windowDuration: windowDuration)
            }
        }
        return .anchored
    }

    // MARK: Copy

    /// "7 days" / "5 hours" / "90 minutes" — the human duration phrase.
    static func durationPhrase(_ duration: TimeInterval) -> String {
        let minutes = Int((duration / 60).rounded())
        if minutes % 1440 == 0 {
            let days = minutes / 1440
            return days == 1 ? "1 day" : "\(days) days"
        }
        if minutes % 60 == 0 {
            let hours = minutes / 60
            return hours == 1 ? "1 hour" : "\(hours) hours"
        }
        return minutes == 1 ? "1 minute" : "\(minutes) minutes"
    }

    /// Reset-slot text for an unanchored window — replaces the drifting
    /// placeholder timestamp. "Resets 7 days after first use".
    public static func unanchoredResetText(windowDuration: TimeInterval) -> String {
        "Resets \(durationPhrase(windowDuration)) after first use"
    }

    /// Hover tooltip for an unanchored window — explains WHY there is no
    /// timestamp (the backstop tooltip normally carries the absolute time).
    /// `reportsPlaceholder` picks the honest trailing clause: the #101 form
    /// reports a drifting placeholder, the #247 null form reports nothing.
    public static func unanchoredTooltip(
        windowDuration: TimeInterval,
        reportsPlaceholder: Bool
    ) -> String {
        let tail = reportsPlaceholder
            ? "a placeholder reset time that shifts on every refresh."
            : "no reset time."
        return "Fresh window — no usage in this period yet. The \(durationPhrase(windowDuration)) "
            + "countdown starts with the first request; until then the provider reports "
            + tail
    }

    /// The rollover annotation: "Week reset just now" within five minutes,
    /// then "Week reset at 10:19 AM". Shorter windows say "Window".
    public static func rolloverText(
        rolledAt: Date,
        windowDuration: TimeInterval,
        now: Date,
        calendar: Calendar = .current
    ) -> String {
        let noun = windowDuration >= weekNounThreshold ? "Week" : "Window"
        if now.timeIntervalSince(rolledAt) <= rolloverJustNowWindow {
            return "\(noun) reset just now"
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "h:mm a"
        return "\(noun) reset at \(formatter.string(from: rolledAt))"
    }
}
