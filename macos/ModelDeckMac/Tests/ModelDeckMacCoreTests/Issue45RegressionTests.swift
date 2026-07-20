import Foundation
import Testing
@testable import ModelDeckMacCore

/// Issue #45 regressions.
///
/// Bug 1 ("menu bar icon never shows the percent") was debugged against the
/// LIVE daemon: `/api/capacity/worst` reported status=critical, worst=3% on
/// a scoped weekly window while the icon stayed plain. These tests pin the
/// whole client-side data path against the exact captured `/api/state`,
/// `/api/settings`, and `/api/capacity/worst` shapes (labels placeholdered),
/// proving the calc/threshold/decoding layers are correct — the live bug was
/// the MenuBarExtra label not observing the model (view-layer fix) — and
/// covering the new daemon-primary evaluator.
@Suite("Issue #45 regressions")
struct Issue45RegressionTests {
    // MARK: - Captured /api/state shape (placeholder labels)

    /// Faithful trim of the live `/api/state` at repro time: extra keys the
    /// app ignores (createdAt, detail, projects…), a 3%-left scoped weekly
    /// row ("Fable weekly"), healthier siblings, and spend rows that must
    /// never win the icon.
    private static let stateJSON = """
    {
      "accounts": [
        {"id": "acct-a", "provider": "claude", "label": "Account A", "identity": "", "purpose": "", "profileRef": "/tmp/profiles/a", "color": "#d97757", "enabled": true, "isDefault": true, "metadata": {"claudePlan": {"subscriptionType": null, "rateLimitTier": "default_claude_max_20x"}}, "createdAt": "2026-07-20T04:57:52.148Z", "updatedAt": "2026-07-20T06:00:32.880Z", "authState": "ok"},
        {"id": "acct-b", "provider": "claude", "label": "Account B", "identity": "", "purpose": "", "profileRef": "/tmp/profiles/b", "color": "#d97757", "enabled": true, "isDefault": false, "metadata": {"claudePlan": {"subscriptionType": null, "rateLimitTier": "default_claude_max_20x"}}, "createdAt": "2026-07-20T04:57:52.166Z", "updatedAt": "2026-07-20T06:00:32.881Z", "authState": "ok"},
        {"id": "acct-c", "provider": "codex", "label": "Account C", "identity": "", "purpose": "", "profileRef": "/tmp/profiles/c", "color": "#48a868", "enabled": true, "isDefault": true, "metadata": {"codexPlan": {"planType": "pro", "displayName": "Pro"}}, "createdAt": "2026-07-20T04:57:52.222Z", "updatedAt": "2026-07-20T07:55:38.014Z", "authState": "ok"}
      ],
      "usage": [
        {"accountId": "acct-a", "scope": "5-hour", "usedPercent": 0, "remainingPercent": 100, "resetsAt": null, "observedAt": "2026-07-20T08:28:24.034Z", "source": "claude-oauth-api", "stale": false, "detail": {}},
        {"accountId": "acct-a", "scope": "Fable weekly", "usedPercent": 96, "remainingPercent": 4, "resetsAt": "2026-07-23T00:59:59.943Z", "observedAt": "2026-07-20T08:28:24.035Z", "source": "claude-oauth-api", "stale": false, "detail": {}},
        {"accountId": "acct-a", "scope": "spend", "usedPercent": 99, "remainingPercent": 1, "resetsAt": null, "observedAt": "2026-07-20T08:28:24.035Z", "source": "claude-oauth-api", "stale": false, "detail": {}},
        {"accountId": "acct-b", "scope": "5-hour", "usedPercent": 38, "remainingPercent": 62, "resetsAt": "2026-07-20T08:29:59.968Z", "observedAt": "2026-07-20T08:28:24.072Z", "source": "claude-oauth-api", "stale": false, "detail": {}},
        {"accountId": "acct-b", "scope": "Fable weekly", "usedPercent": 97, "remainingPercent": 3, "resetsAt": "2026-07-22T05:59:59.968Z", "observedAt": "2026-07-20T08:28:24.072Z", "source": "claude-oauth-api", "stale": false, "detail": {}},
        {"accountId": "acct-b", "scope": "weekly", "usedPercent": 51, "remainingPercent": 49, "resetsAt": "2026-07-23T00:59:59.942Z", "observedAt": "2026-07-20T08:28:24.035Z", "source": "claude-oauth-api", "stale": false, "detail": {}},
        {"accountId": "acct-c", "scope": "GPT-5.3-Codex-Spark weekly", "usedPercent": 0, "remainingPercent": 100, "resetsAt": "2026-07-27T08:28:25.000Z", "observedAt": "2026-07-20T08:28:25.614Z", "source": "codex-app-server", "stale": false, "detail": {"planType": "pro", "limitId": "codex_bengalfox", "windowDurationMins": 10080, "credits": null}},
        {"accountId": "acct-c", "scope": "weekly", "usedPercent": 78, "remainingPercent": 22, "resetsAt": "2026-07-25T03:24:47.000Z", "observedAt": "2026-07-20T08:28:25.412Z", "source": "codex-app-server", "stale": false, "detail": {"planType": "pro", "limitId": "codex", "windowDurationMins": 10080, "credits": {"hasCredits": false, "unlimited": false, "balance": "0"}}}
      ],
      "projects": [],
      "launches": []
    }
    """

    /// The live `/api/settings` document at repro time.
    private static let settingsJSON = """
    {"autoRefreshEnabled": true, "autoRefreshIntervalSeconds": 300, "pauseWhileActive": true, "layout": "single-column", "defaultSort": "next-reset", "notificationThresholdPercent": 20, "menuBarStyle": "icon-only"}
    """

    /// The live `/api/capacity/worst` at repro time (labels placeholdered).
    private static let worstJSON = """
    {"status": "critical", "iconState": "red", "worst": {"accountId": "acct-b", "accountLabel": "Account B", "provider": "claude", "scope": "Fable weekly", "remainingPercent": 3, "resetsAt": "2026-07-22T05:59:59.968Z", "observedAt": "2026-07-20T08:28:24.072Z"}, "thresholdPercent": 20, "criticalPercent": 10, "notify": true, "accountsEvaluated": 7, "windowsEvaluated": 18, "excluded": [{"accountId": "acct-a", "scope": "spend", "reason": "spend scope deprioritized"}], "checkedAt": "2026-07-20T08:31:44.477Z"}
    """

    private func decodedState() throws -> DeckState {
        try JSONDecoder().decode(DeckState.self, from: Data(Self.stateJSON.utf8))
    }

    // MARK: - Client calc against the captured fixture

    @Test func clientCalcFindsTheThreePercentScopedWeeklyRow() throws {
        let state = try decodedState()
        #expect(state.accounts.count == 3)
        #expect(state.usage.count == 8)
        let worst = try #require(WorstRemainingCalculator.worstRemaining(in: state))
        #expect(worst.percent == 3)
        #expect(worst.accountId == "acct-b")
        #expect(worst.scope == "Fable weekly")
        #expect(worst.resetsAt == "2026-07-22T05:59:59.968Z")
        // The 1%-left spend row must NOT have won (issue #28 demotion).
        #expect(UsageScope.isSpend(worst.scope) == false)
    }

    @Test func capturedFixtureRendersCriticalUnderTheLiveThresholds() throws {
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(Self.settingsJSON.utf8))
        let worst = WorstRemainingCalculator.worstRemaining(in: try decodedState())
        let icon = MenuBarIconState.state(for: worst, thresholds: settings.usageThresholds)
        #expect(icon == .critical(percentRemaining: 3))
        #expect(icon.percentLabel == "3%")
    }

    // MARK: - Thresholds wiring

    @Test func liveSettingsDocumentMapsToWarning20Critical10() throws {
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(Self.settingsJSON.utf8))
        #expect(settings.usageThresholds == UsageThresholds(warningPercent: 20, criticalPercent: 10))
        #expect(settings.effectiveAutoRefreshInterval == 300)
    }

    @Test func settingsSyncApplyPathRecomputesTheIcon() async throws {
        // Wiring regression: pushing daemon-confirmed thresholds into the
        // status model (what settingsSync.onApply does) must recompute the
        // icon from the already-known worst.
        let model = await MainActor.run {
            MenuBarStatusModel(evaluator: StubEvaluator(results: [
                .success(WorstRemaining(percent: 22, accountId: "acct-c", scope: "weekly"))
            ]))
        }
        await model.refresh()
        await MainActor.run {
            // Default thresholds: 22% is below warning(25) — gold.
            #expect(model.iconState == .warning(percentRemaining: 22))
            model.thresholds = UsageThresholds(warningPercent: 20, criticalPercent: 10)
            // Live thresholds: 22% is healthy — percent hides.
            #expect(model.iconState == .plain)
        }
    }

    // MARK: - Daemon-primary evaluator (/api/capacity/worst)

    private struct StubWorstProvider: WorstCapacityProviding {
        var result: Result<CapacityWorstReport, Error>
        func worstCapacity() async throws -> CapacityWorstReport { try result.get() }
    }

    @Test func capacityWorstReportDecodesTheLiveShape() throws {
        let report = try JSONDecoder().decode(CapacityWorstReport.self, from: Data(Self.worstJSON.utf8))
        #expect(report.status == "critical")
        let worst = try #require(report.worstRemaining)
        #expect(worst.percent == 3)
        #expect(worst.accountId == "acct-b")
        #expect(worst.scope == "Fable weekly")
        #expect(worst.displayPercent == 3)
    }

    @Test func daemonEvaluatorMapsReportToWorstRemaining() async throws {
        let report = try JSONDecoder().decode(CapacityWorstReport.self, from: Data(Self.worstJSON.utf8))
        let evaluator = DaemonWorstCapacityEvaluator(provider: StubWorstProvider(result: .success(report)))
        let worst = try #require(try await evaluator.evaluateWorstRemaining())
        #expect(worst.percent == 3)
        #expect(worst.scope == "Fable weekly")
    }

    @Test func daemonEvaluatorReportsNilWhenStatusUnknown() async throws {
        let evaluator = DaemonWorstCapacityEvaluator(
            provider: StubWorstProvider(result: .success(CapacityWorstReport(status: "unknown")))
        )
        #expect(try await evaluator.evaluateWorstRemaining() == nil)
    }

    // MARK: - Settings window matching (bug 2 pure logic)

    @Test func settingsWindowMatcherRecognizesTheSwiftUISettingsWindow() {
        // The identifier SwiftUI stamps on the Settings scene window.
        #expect(SettingsWindowMatcher.matches(identifier: "com_apple_SwiftUI_Settings_window", title: ""))
        // Title fallback, localized-capitalization tolerant.
        #expect(SettingsWindowMatcher.matches(identifier: nil, title: "ModelDeck Settings"))
        #expect(SettingsWindowMatcher.matches(identifier: nil, title: "SETTINGS"))
        // Locale-aware fallback (CodeRabbit, PR #46): localized titles must
        // still match when the identifier is absent.
        #expect(SettingsWindowMatcher.matches(identifier: nil, title: "ModelDeck Einstellungen"))
        #expect(SettingsWindowMatcher.matches(identifier: nil, title: "ModelDeck 設定"))
        #expect(!SettingsWindowMatcher.matches(identifier: nil, title: "ModelDeck Deck"))
        // Non-settings windows never match.
        #expect(!SettingsWindowMatcher.matches(identifier: "main-window", title: "ModelDeck"))
        #expect(!SettingsWindowMatcher.matches(identifier: nil, title: ""))
    }
}
