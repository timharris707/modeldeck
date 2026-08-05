import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #101 — window-anchor heuristics: unanchored ("fresh window")
// detection, recent-rollover annotation, and the anchored negative paths.
// Placeholder names/emails only — never real identities (spec privacy rule).

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let week: TimeInterval = 7 * 86_400
private let fiveHours: TimeInterval = 5 * 3600

private func iso(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
}

private func snapshot(
    scope: String,
    remaining: Double?,
    resetsAt: Date?,
    observedAt: Date? = now,
    durationMins: Double? = nil
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: "x1",
        scope: scope,
        remainingPercent: remaining,
        resetsAt: resetsAt.map(iso),
        observedAt: observedAt.map(iso),
        detail: durationMins.map { UsageSnapshotDetail(windowDurationMins: $0) }
    )
}

@Suite("WindowPresentation — anchor detection")
struct WindowAnchorDetectionTests {
    // The issue's core case: no usage in the current period, the server
    // returns resetsAt ≈ probeTime + windowLength (drifts every refresh).
    @Test func zeroUsageWithResetOneWindowAfterProbeIsUnanchored() {
        let anchor = WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: now.addingTimeInterval(week + 60), // 1 min of server rounding
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(anchor == .unanchored(windowDuration: week))
    }

    // The anchored negative: real usage in the window — never reclassified,
    // whatever the reset time looks like.
    @Test func windowWithUsageStaysAnchored() {
        let anchor = WindowPresentation.anchor(
            remainingPercent: 40,
            resetsAt: now.addingTimeInterval(2 * 86_400),
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(anchor == .anchored)
    }

    // Zero usage alone is NOT enough: a mid-window resetsAt means the
    // window is genuinely anchored (usage may have been reported as 0 by
    // rounding); no fake fresh-window copy.
    @Test func zeroUsageWithMidWindowResetStaysAnchored() {
        let anchor = WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: now.addingTimeInterval(3 * 86_400),
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(anchor == .anchored)
    }

    // The ±5-minute tolerance boundary.
    @Test func unanchoredToleranceBoundary() {
        let inside = WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: now.addingTimeInterval(week + 4 * 60),
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(inside == .unanchored(windowDuration: week))
        let outside = WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: now.addingTimeInterval(week + 6 * 60),
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(outside == .anchored)
    }

    // observedAt (probe time) is the comparison base, not `now`: a stale
    // snapshot from 2 hours ago still classifies by its own probe time.
    @Test func staleUnanchoredSnapshotClassifiesByObservedAt() {
        let observed = now.addingTimeInterval(-2 * 3600)
        let anchor = WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: observed.addingTimeInterval(week),
            observedAt: observed,
            windowDuration: week,
            now: now
        )
        #expect(anchor == .unanchored(windowDuration: week))
    }

    // Tim's 10:19 AM case: the weekly window rolled minutes ago, the new
    // window is anchored (heavy use continued), usage reads ~0.
    @Test func freshlyRolledAnchoredWindowIsRecentlyRolled() {
        let rolledAt = now.addingTimeInterval(-40 * 60)
        let anchor = WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: rolledAt.addingTimeInterval(week),
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(anchor == .recentlyRolled(at: rolledAt, windowDuration: week))
    }

    // The annotation ages out: a roll 4 hours ago (beyond the 3-hour cap
    // for weekly windows) is plain anchored.
    @Test func oldRolloverIsNotAnnotated() {
        let rolledAt = now.addingTimeInterval(-4 * 3600)
        let anchor = WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: rolledAt.addingTimeInterval(week),
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(anchor == .anchored)
    }

    // Rollover needs near-zero usage: 5% used right after the inferred
    // start is just a normal young window.
    @Test func rolloverRequiresNearZeroUsage() {
        let rolledAt = now.addingTimeInterval(-40 * 60)
        let anchor = WindowPresentation.anchor(
            remainingPercent: 95,
            resetsAt: rolledAt.addingTimeInterval(week),
            observedAt: now,
            windowDuration: week,
            now: now
        )
        #expect(anchor == .anchored)
    }

    // 5-hour windows use the duration-scaled recency (75 min).
    @Test func fiveHourRolloverUsesScaledRecency() {
        let recent = now.addingTimeInterval(-30 * 60)
        #expect(WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: recent.addingTimeInterval(fiveHours),
            observedAt: now,
            windowDuration: fiveHours,
            now: now
        ) == .recentlyRolled(at: recent, windowDuration: fiveHours))
        let old = now.addingTimeInterval(-90 * 60)
        #expect(WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: old.addingTimeInterval(fiveHours),
            observedAt: now,
            windowDuration: fiveHours,
            now: now
        ) == .anchored)
    }

    // No duration or no percent → never second-guess: anchored. (The
    // no-reset case moved to the #247 suite below, where full remaining +
    // null resetsAt now classifies as a fresh window.)
    @Test func missingInputsStayAnchored() {
        #expect(WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: now.addingTimeInterval(week),
            observedAt: now,
            windowDuration: nil,
            now: now
        ) == .anchored)
        #expect(WindowPresentation.anchor(
            remainingPercent: nil,
            resetsAt: now.addingTimeInterval(week),
            observedAt: now,
            windowDuration: week,
            now: now
        ) == .anchored)
    }
}

// Issue #247 (Tim, 2026-08-04) — after a weekly rollover and before any
// new usage, Anthropic reports 100% remaining with resetsAt=null on every
// scope. Under #145 that rendered "100% left" with an EMPTY reset slot,
// which Tim read as the account not being picked up by the proxy/daemon.
// The null form is the same fresh-window state #101 named for Codex.
@Suite("WindowPresentation — null-reset fresh window (issue #247)")
struct NullResetFreshWindowTests {
    @Test func fullRemainingWithNullResetIsUnanchored() {
        #expect(WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: nil,
            observedAt: now,
            windowDuration: week,
            now: now
        ) == .unanchored(windowDuration: week))
        // Same for the 5-hour scope family.
        #expect(WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: nil,
            observedAt: now,
            windowDuration: fiveHours,
            now: now
        ) == .unanchored(windowDuration: fiveHours))
    }

    // The narrowing that keeps this honest: usage HAS landed but the
    // provider stated no reset — that is missing data, not a fresh
    // window, and keeps #145's empty slot.
    @Test func partialUsageWithNullResetStaysAnchored() {
        #expect(WindowPresentation.anchor(
            remainingPercent: 40,
            resetsAt: nil,
            observedAt: now,
            windowDuration: week,
            now: now
        ) == .anchored)
        // The 0.05%-used ceiling is shared with #101's placeholder form.
        #expect(WindowPresentation.anchor(
            remainingPercent: 99.5,
            resetsAt: nil,
            observedAt: now,
            windowDuration: week,
            now: now
        ) == .anchored)
    }

    // Unknown percent or unknown duration → no claim either way.
    @Test func unknownInputsWithNullResetStayAnchored() {
        #expect(WindowPresentation.anchor(
            remainingPercent: nil,
            resetsAt: nil,
            observedAt: now,
            windowDuration: week,
            now: now
        ) == .anchored)
        #expect(WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: nil,
            observedAt: now,
            windowDuration: nil,
            now: now
        ) == .anchored)
    }

    // A null-reset fresh window never depends on observedAt — there is no
    // timestamp to compare it against, so old daemons classify too.
    @Test func nullResetClassifiesWithoutObservedAt() {
        #expect(WindowPresentation.anchor(
            remainingPercent: 100,
            resetsAt: nil,
            observedAt: nil,
            windowDuration: week,
            now: now
        ) == .unanchored(windowDuration: week))
    }
}

@Suite("WindowPresentation — window duration")
struct WindowDurationTests {
    @Test func detailMinutesWinOverScopeName() {
        // Codex sends windowDurationMins even for prefixed scopes the
        // title mapper doesn't recognize.
        #expect(WindowPresentation.windowDuration(scope: "bonus 5-hour", detailMinutes: 300) == fiveHours)
    }

    @Test func scopeFamiliesFallBackWithoutDetail() {
        #expect(WindowPresentation.windowDuration(scope: "5-hour", detailMinutes: nil) == fiveHours)
        #expect(WindowPresentation.windowDuration(scope: "5h", detailMinutes: nil) == fiveHours)
        #expect(WindowPresentation.windowDuration(scope: "weekly", detailMinutes: nil) == week)
        #expect(WindowPresentation.windowDuration(scope: "week", detailMinutes: nil) == week)
        #expect(WindowPresentation.windowDuration(scope: "week:fable", detailMinutes: nil) == week)
        #expect(WindowPresentation.windowDuration(scope: "Fable weekly", detailMinutes: nil) == week)
        // Codex's generic label for non-standard windows.
        #expect(WindowPresentation.windowDuration(scope: "90-minute", detailMinutes: nil) == TimeInterval(90 * 60))
    }

    @Test func unknownScopesHaveNoDuration() {
        #expect(WindowPresentation.windowDuration(scope: "spend", detailMinutes: nil) == nil)
        #expect(WindowPresentation.windowDuration(scope: "mystery", detailMinutes: nil) == nil)
    }
}

@Suite("WindowPresentation — copy")
struct WindowPresentationCopyTests {
    @Test func unanchoredResetText() {
        #expect(WindowPresentation.unanchoredResetText(windowDuration: week)
            == "Resets 7 days after first use")
        #expect(WindowPresentation.unanchoredResetText(windowDuration: fiveHours)
            == "Resets 5 hours after first use")
        #expect(WindowPresentation.unanchoredResetText(windowDuration: 90 * 60)
            == "Resets 90 minutes after first use")
    }

    // Issue #247: the tooltip must not claim a placeholder timestamp
    // exists when the provider reported none.
    @Test func unanchoredTooltipMatchesWhatTheProviderReported() {
        let placeholder = WindowPresentation.unanchoredTooltip(
            windowDuration: week,
            reportsPlaceholder: true
        )
        #expect(placeholder.contains("Fresh window"))
        #expect(placeholder.hasSuffix("a placeholder reset time that shifts on every refresh."))

        let none = WindowPresentation.unanchoredTooltip(
            windowDuration: week,
            reportsPlaceholder: false
        )
        #expect(none.contains("Fresh window"))
        #expect(none.contains("7 days"))
        #expect(none.hasSuffix("no reset time."))
        #expect(!none.contains("placeholder"))
    }

    @Test func rolloverTextJustNowThenClockTime() {
        #expect(WindowPresentation.rolloverText(
            rolledAt: now.addingTimeInterval(-2 * 60),
            windowDuration: week,
            now: now
        ) == "Week reset just now")
        let rolledAt = now.addingTimeInterval(-40 * 60)
        let formatter = DateFormatter()
        formatter.calendar = .current
        formatter.timeZone = Calendar.current.timeZone
        formatter.dateFormat = "h:mm a"
        #expect(WindowPresentation.rolloverText(
            rolledAt: rolledAt,
            windowDuration: week,
            now: now
        ) == "Week reset at \(formatter.string(from: rolledAt))")
        // Shorter windows say "Window", not "Week".
        #expect(WindowPresentation.rolloverText(
            rolledAt: now.addingTimeInterval(-60),
            windowDuration: fiveHours,
            now: now
        ) == "Window reset just now")
    }
}

@Suite("DeckBuilder — issue #101 window presentation")
struct DeckBuilderWindowPresentationTests {
    private func build(_ snapshot: UsageSnapshot) -> DeckWindow {
        DeckBuilder.window(from: snapshot, thresholds: .default, now: now)
    }

    @Test func unanchoredCodexWindowShowsFreshWindowCopy() {
        let window = build(snapshot(
            scope: "weekly",
            remaining: 100,
            resetsAt: now.addingTimeInterval(week),
            durationMins: 10_080
        ))
        #expect(window.anchor == .unanchored(windowDuration: week))
        #expect(window.resetText == "Resets 7 days after first use")
        #expect(window.rolloverText == nil)
        #expect(window.resetTooltip.contains("Fresh window"))
        #expect(window.resetTooltip.contains("placeholder"))
    }

    // Claude windows classify consistently via the scope-name fallback
    // (the Claude adapter sends detail: {}).
    @Test func unanchoredClaudeWindowClassifiesWithoutDetail() {
        let window = build(snapshot(
            scope: "week",
            remaining: 100,
            resetsAt: now.addingTimeInterval(week)
        ))
        #expect(window.anchor == .unanchored(windowDuration: week))
        #expect(window.resetText == "Resets 7 days after first use")
    }

    @Test func recentlyRolledWindowCarriesAnnotationAndRealResetText() {
        let rolledAt = now.addingTimeInterval(-30 * 60)
        let window = build(snapshot(
            scope: "weekly",
            remaining: 100,
            resetsAt: rolledAt.addingTimeInterval(week),
            durationMins: 10_080
        ))
        #expect(window.anchor == .recentlyRolled(at: rolledAt, windowDuration: week))
        #expect(window.rolloverText?.hasPrefix("Week reset at ") == true)
        // The reset slot keeps the REAL timestamp — the roll is annotated,
        // never substituted.
        #expect(window.resetText.hasPrefix("Resets "))
        #expect(window.resetText != "Resets 7 days after first use")
    }

    @Test func anchoredWindowRendersExactlyAsBefore() {
        let window = build(snapshot(
            scope: "weekly",
            remaining: 40,
            resetsAt: now.addingTimeInterval(2 * 86_400),
            durationMins: 10_080
        ))
        #expect(window.anchor == .anchored)
        #expect(window.rolloverText == nil)
        #expect(window.resetText == DeckBuilder.resetText(
            for: now.addingTimeInterval(2 * 86_400),
            now: now
        ))
        #expect(window.resetTooltip == DeckBuilder.absoluteResetText(
            for: now.addingTimeInterval(2 * 86_400)
        ))
    }

    // Spend rows carry no rate-limit window — never classified even when a
    // duration is (wrongly) present in detail.
    @Test func spendRowsAreNeverClassified() {
        let window = build(snapshot(
            scope: "spend",
            remaining: 100,
            resetsAt: now.addingTimeInterval(week),
            durationMins: 10_080
        ))
        #expect(window.anchor == .anchored)
        #expect(window.rolloverText == nil)
    }

    // Issue #247, the field shape: Anthropic's post-rollover payload —
    // 100% left, resetsAt absent — must SAY it is a fresh window rather
    // than leave the slot blank.
    @Test func nullResetFreshWindowShowsFreshWindowCopy() {
        let window = build(snapshot(scope: "week", remaining: 100, resetsAt: nil))
        #expect(window.anchor == .unanchored(windowDuration: week))
        #expect(window.displayedResetText == "Resets 7 days after first use")
        #expect(window.resetTooltip.contains("Fresh window"))
        // No placeholder was reported, so the tooltip must not claim one.
        #expect(!window.resetTooltip.contains("placeholder"))
    }

    // The other side of the same payload: every scope reports the state,
    // so the 5-hour row must not stay blank either.
    @Test func nullResetFiveHourShowsFreshWindowCopy() {
        let window = build(snapshot(scope: "5h", remaining: 100, resetsAt: nil))
        #expect(window.displayedResetText == "Resets 5 hours after first use")
    }

    // Spend rows keep their empty slot — 100% with no reset there is the
    // meaningless-spend shape (#28/#139), not a fresh rate-limit window.
    @Test func nullResetSpendRowStaysEmpty() {
        let window = build(snapshot(scope: "spend", remaining: 100, resetsAt: nil))
        #expect(window.anchor == .anchored)
        #expect(window.displayedResetText == nil)
    }
}
