import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #175 — honest idle rollforward, presentation-only.
// Placeholder names/emails only — never real identities (spec privacy rule).

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let week: TimeInterval = 7 * 86_400
private let fiveHours: TimeInterval = 5 * 3600

private func iso(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
}

private func iso(_ offset: TimeInterval) -> String {
    iso(now.addingTimeInterval(offset))
}

/// A snapshot observed at `observedOffset` whose window resets at
/// `resetsOffset` (both relative to `now`).
private func snapshot(
    _ accountId: String = "a1",
    scope: String,
    remaining: Double?,
    resetsOffset: TimeInterval?,
    observedOffset: TimeInterval? = nil,
    stale: Bool = false
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: resetsOffset.map { iso($0) },
        observedAt: observedOffset.map { iso($0) },
        stale: stale
    )
}

private func account(
    _ id: String = "a1",
    provider: String = "claude",
    label: String = "Studio"
) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: provider,
        label: label,
        identity: "\(id)@example.com",
        enabled: true,
        isDefault: false
    )
}

/// The canonical idle fixture: observed 2 days ago, 5-hour window closed
/// ~1 day 19 hours ago, weekly window closed 1 hour ago.
private func idleState() -> DeckState {
    DeckState(
        accounts: [account()],
        usage: [
            snapshot(scope: "5h", remaining: 28, resetsOffset: -(2 * 86_400 - fiveHours), observedOffset: -2 * 86_400),
            snapshot(scope: "week", remaining: 61, resetsOffset: -3_600, observedOffset: -2 * 86_400),
        ]
    )
}

private func builtWindows(_ state: DeckState) -> [DeckWindow] {
    DeckBuilder.rows(state: state, now: now).first?.windows ?? []
}

// MARK: - Firing conditions

@Suite("IdleRollforward — firing conditions")
struct IdleRollforwardFiringTests {
    // The core provable fact: observed < resetsAt <= now → the window
    // closed while idle.
    @Test func firesWhenResetPassedSinceObservation() {
        let notice = IdleRollforward.notice(
            scope: "5h",
            anchor: .anchored,
            resetsAt: now.addingTimeInterval(-3_600),
            observedAt: now.addingTimeInterval(-2 * 86_400),
            windowDuration: fiveHours,
            now: now
        )
        #expect(notice != nil)
    }

    @Test func neverFiresWhileResetIsStillAhead() {
        let notice = IdleRollforward.notice(
            scope: "5h",
            anchor: .anchored,
            resetsAt: now.addingTimeInterval(60),
            observedAt: now.addingTimeInterval(-3_600),
            windowDuration: fiveHours,
            now: now
        )
        #expect(notice == nil)
    }

    // Data newer than the roll already describes the post-reset window —
    // there is nothing to roll forward.
    @Test func neverFiresWhenObservationIsNewerThanTheReset() {
        let notice = IdleRollforward.notice(
            scope: "week",
            anchor: .anchored,
            resetsAt: now.addingTimeInterval(-3_600),
            observedAt: now.addingTimeInterval(-60),
            windowDuration: week,
            now: now
        )
        #expect(notice == nil)
    }

    // The #101 unanchored placeholder resetsAt (probe time + duration) is
    // NOT a real close — an unanchored window must keep its fresh-window
    // copy however old the snapshot gets.
    @Test func neverFiresOnAnUnanchoredWindow() {
        let notice = IdleRollforward.notice(
            scope: "week",
            anchor: .unanchored(windowDuration: week),
            resetsAt: now.addingTimeInterval(-3_600),
            observedAt: now.addingTimeInterval(-week - 3_600),
            windowDuration: week,
            now: now
        )
        #expect(notice == nil)
    }

    @Test func neverFiresOnARecentlyRolledWindow() {
        let notice = IdleRollforward.notice(
            scope: "week",
            anchor: .recentlyRolled(at: now.addingTimeInterval(-600), windowDuration: week),
            resetsAt: now.addingTimeInterval(week - 600),
            observedAt: now.addingTimeInterval(-300),
            windowDuration: week,
            now: now
        )
        #expect(notice == nil)
    }

    // Old daemons without observedAt offer no proof the reset passed SINCE
    // the observation — the existing presentation stands.
    @Test func neverFiresWithoutAnObservationTimestamp() {
        let notice = IdleRollforward.notice(
            scope: "5h",
            anchor: .anchored,
            resetsAt: now.addingTimeInterval(-3_600),
            observedAt: nil,
            windowDuration: fiveHours,
            now: now
        )
        #expect(notice == nil)
    }

    @Test func neverFiresOnSpend() {
        let notice = IdleRollforward.notice(
            scope: "spend",
            anchor: .anchored,
            resetsAt: now.addingTimeInterval(-3_600),
            observedAt: now.addingTimeInterval(-2 * 86_400),
            windowDuration: nil,
            now: now
        )
        #expect(notice == nil)
    }
}

// MARK: - Pinned copy

@Suite("IdleRollforward — pinned copy")
struct IdleRollforwardCopyTests {
    private func notice(scope: String, duration: TimeInterval?) -> IdleRollforward.Notice? {
        IdleRollforward.notice(
            scope: scope,
            anchor: .anchored,
            resetsAt: now.addingTimeInterval(-3_600),
            observedAt: now.addingTimeInterval(-2 * 86_400),
            windowDuration: duration,
            now: now
        )
    }

    @Test func fiveHourRowCopyIsPinned() {
        #expect(notice(scope: "5h", duration: fiveHours)?.text
            == "5-hour window reset since last use")
    }

    @Test func fiveHourTooltipIsPinned() {
        #expect(notice(scope: "5h", duration: fiveHours)?.tooltip
            == "This window's reset time passed after the last observation, "
            + "so the stored numbers describe a window that has already ended. "
            + "A new 5-hour window starts with the next request — fresh "
            + "numbers arrive on next use.")
    }

    @Test func weeklyRowCopyIsPinned() {
        #expect(notice(scope: "week", duration: week)?.text
            == "Weekly window reset since last use")
    }

    // The #101 unanchored precedent: after the roll, the next weekly reset
    // is unanchored — "resets 7 days after first use".
    @Test func weeklyTooltipCarriesTheUnanchoredPrecedent() {
        #expect(notice(scope: "week", duration: week)?.tooltip
            == "This window's reset time passed after the last observation, "
            + "so the stored numbers describe a window that has already ended. "
            + "The next weekly window is unanchored — it resets 7 days after "
            + "first use. Fresh numbers arrive on next use.")
    }

    // Model-scoped weeklies share the weekly copy family.
    @Test func modelScopedWeeklyUsesWeeklyCopy() {
        #expect(notice(scope: "Fable weekly", duration: week)?.text
            == "Weekly window reset since last use")
    }

    @Test func unknownWindowKindUsesGenericCopy() {
        let generic = notice(scope: "90-minute", duration: 90 * 60)
        #expect(generic?.text == "Window reset since last use")
        #expect(generic?.tooltip
            == "This window's reset time passed after the last observation, "
            + "so the stored numbers describe a window that has already ended. "
            + "Fresh numbers arrive on next use.")
    }

    @Test func accessibilityLabelCarriesTextAndTooltip() {
        let n = notice(scope: "5h", duration: fiveHours)
        #expect(n?.accessibilityLabel == "\(n!.text) — \(n!.tooltip)")
    }
}

// MARK: - Row presentation

@Suite("IdleRollforward — row presentation")
struct IdleRollforwardRowTests {
    // The reset slot carries the fact; the percent is SUPPRESSED — a %
    // from a closed window must not render as if current, and no derived
    // % is ever fabricated.
    @Test func rolledWindowShowsFactAndSuppressesThePercent() {
        let windows = builtWindows(idleState())
        let fiveHour = windows.first { $0.scope == "5h" }
        #expect(fiveHour?.idleRollforward != nil)
        #expect(fiveHour?.displayedResetText == "5-hour window reset since last use")
        #expect(fiveHour?.remainingText == nil)
        #expect(fiveHour?.valueText == nil)
        #expect(fiveHour?.usedFraction == 0)
        #expect(fiveHour?.severity == .unknown)

        let weekly = windows.first { $0.scope == "week" }
        #expect(weekly?.displayedResetText == "Weekly window reset since last use")
        #expect(weekly?.remainingText == nil)
    }

    @Test func rolledWindowTooltipExplainsInsteadOfPastTimestamp() {
        let fiveHour = builtWindows(idleState()).first { $0.scope == "5h" }
        #expect(fiveHour?.resetTooltip.hasPrefix("This window's reset time passed") == true)
    }

    // One-line row footprint (#145): the notice REPLACES the reset slot's
    // text; it never adds a second line (rolloverText stays nil).
    @Test func rolledWindowKeepsTheOneLineFootprint() {
        for window in builtWindows(idleState()) {
            #expect(window.rolloverText == nil)
        }
    }

    // The stored fields pass through untouched — the suppression is in the
    // display accessors, never a mutation of the data.
    @Test func storedFieldsSurviveUnderneathThePresentation() {
        let fiveHour = builtWindows(idleState()).first { $0.scope == "5h" }
        #expect(fiveHour?.remainingPercent == 28)
        #expect(fiveHour?.resetsAt == DeckDateParsing.date(from: iso(-(2 * 86_400 - fiveHours))))
    }

    // A live (future-reset) window is pixel-identical to pre-#175.
    @Test func liveWindowsAreUntouched() {
        let state = DeckState(
            accounts: [account()],
            usage: [snapshot(scope: "5h", remaining: 72, resetsOffset: 57 * 60, observedOffset: -60)]
        )
        let window = builtWindows(state).first
        #expect(window?.idleRollforward == nil)
        #expect(window?.remainingText == "72% left")
        #expect(window?.displayedResetText == "Resets in 57 min")
        #expect(window?.severity == .healthy)
    }
}

// MARK: - Derived state stays presentation-only

@Suite("IdleRollforward — nothing else consumes derived state")
struct IdleRollforwardIsolationTests {
    // Menu-bar % (WorstRemainingCalculator is the client-side menu-bar
    // basis): still the STORED percent, never suppressed, never derived.
    @Test func menuBarWorstRemainingStillUsesStoredPercents() {
        let worst = WorstRemainingCalculator.worstRemaining(in: idleState())
        #expect(worst?.percent == 28)
        #expect(worst?.scope == "5h")
    }

    // #89 stale marker: unchanged — keyed on the stored observedAt, which
    // the rollforward never advances.
    @Test func staleMarkerStillKeysOnTheStoredObservation() {
        let rows = DeckBuilder.rows(state: idleState(), now: now)
        #expect(rows.first?.newestObservedAt == DeckDateParsing.date(from: iso(-2 * 86_400)))
        let marker = rows.first?.staleness(now: now, autoRefreshInterval: 300)
        #expect(marker?.text == "Data from 2 days ago")
    }

    // #168 footer: the breakdown classifies the account exactly as before
    // (unexplained staleness here — no signin/keychain state in fixture).
    @Test func footerBreakdownIsUnchanged() {
        let breakdown = DeckFreshness.footerBreakdown(
            state: idleState(),
            now: now,
            autoRefreshInterval: 300
        )
        #expect(breakdown.stale.count == 1)
        #expect(breakdown.stale.first?.reason == .unexplained(errorMessage: nil))
        #expect(breakdown.stale.first?.observedAt == DeckDateParsing.date(from: iso(-2 * 86_400)))
    }

    // #149 idle split: signInRecovery derives from authState/signinReason
    // only — a rolled window alone never conjures a sign-in notice.
    @Test func idleSplitNeverTriggersFromARolledWindow() {
        let rows = DeckBuilder.rows(state: idleState(), now: now)
        #expect(rows.first?.signInRecovery == nil)
        #expect(rows.first?.keychainRecovery == nil)
    }

    // Regression (#65/#108 weeklyResetFingerprint protection): building
    // rows derives at render time and NEVER mutates the state that came
    // from the daemon — no derived row can ever flow back through
    // recordUsage because nothing is written anywhere.
    @Test func buildingRowsNeverMutatesTheDaemonState() {
        let state = idleState()
        let before = state
        _ = DeckBuilder.rows(state: state, now: now)
        _ = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
        #expect(state == before)
        // And the snapshots' stored resetsAt/observedAt strings are the
        // originals, byte for byte.
        #expect(state.usage.map(\.resetsAt) == before.usage.map(\.resetsAt))
        #expect(state.usage.map(\.observedAt) == before.usage.map(\.observedAt))
    }
}
