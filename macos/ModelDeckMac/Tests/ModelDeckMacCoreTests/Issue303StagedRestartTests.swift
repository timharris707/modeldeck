import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #303 — Tim's 0.3.24→0.3.25 field report: a background-staged update
// showed him only "installs the next time ModelDeck relaunches" (the
// Settings caption) with nothing to click, and he quit the app by hand.
// Two contracts pinned here:
//
// 1. PAIRING — `.installedPendingRelaunch` never announces itself without a
//    co-located one-click action: `restartActionTitle(for:)` is non-nil for
//    exactly the staged phase (every surface that renders `statusText`
//    renders the button whenever the title is non-nil).
//
// 2. HANDOFF — Restart while the background session still holds the staged
//    install must complete, not shrug. `SPUUpdater.canCheckForUpdates` can
//    be false in that window; the driver consults
//    `AppUpdateCheckOutcomePolicy.onBlockedExplicitStart(stagedVersion:)`
//    and a staged install resolves to retry-when-idle, never to #165's
//    "An update is already in progress" message. `stagedVersion` is the
//    sticky core fact that decision reads.
//
// The real Sparkle round-trip (background session blocking the updater,
// then releasing it) cannot run in tests — the driver-side wait loop in
// SparkleUpdateDriver.beginInstallWhenUpdaterIdle is hand-test-only; these
// tests pin every decision it applies.

@MainActor
private final class RecordingDriver: AppUpdateInstalling {
    private(set) var beginInstallCount = 0
    private(set) var backgroundCheckCount = 0
    var lastAutoInstall: Bool?

    func beginInstall() { beginInstallCount += 1 }
    func checkInBackground() { backgroundCheckCount += 1 }
    func setAutomaticInstallEnabled(_ enabled: Bool) { lastAutoInstall = enabled }
}

private func freshDefaults() -> UserDefaults {
    let suite = "issue303-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
}

// MARK: - Pairing: staged status never renders without an action

@Suite("Issue #303 — staged status is always paired with a restart action")
struct StagedStatusPairingTests {
    private static let nonStagedPhases: [AppUpdateInstallPhase] = [
        .idle,
        .checking,
        .downloading(fraction: nil),
        .downloading(fraction: 0.5),
        .extracting(fraction: nil),
        .extracting(fraction: 0.5),
        .installing,
        .relaunching,
        .failed(message: "boom")
    ]

    @Test func stagedPhaseCarriesTheRestartAction() {
        let phase = AppUpdateInstallPhase.installedPendingRelaunch(version: "0.3.25")
        // The announcement Tim read…
        #expect(AppUpdateInstallModel.statusText(for: phase) ==
            "v0.3.25 is downloaded and installs the next time ModelDeck relaunches.")
        // …must come with the one-click follow-through.
        #expect(AppUpdateInstallModel.restartActionTitle(for: phase) == "Restart to Update")
    }

    @Test func noOtherPhaseGrowsARestartButton() {
        for phase in Self.nonStagedPhases {
            #expect(AppUpdateInstallModel.restartActionTitle(for: phase) == nil,
                "unexpected restart action for \(phase)")
        }
    }

    @Test func restartHelpNamesTheNoManualQuitPromise() {
        // The fix's product line: manual quit-to-update must never be
        // required. The shared tooltip states it.
        #expect(AppUpdateInstallModel.restartActionHelp.contains("no manual quit"))
    }
}

// MARK: - Handoff: blocked explicit start with a staged install

@Suite("Issue #303 — blocked start resolves by staged state")
struct BlockedStartResolutionTests {
    @Test func stagedInstallRetriesWhenUpdaterIdle() {
        #expect(AppUpdateCheckOutcomePolicy.onBlockedExplicitStart(stagedVersion: "0.3.25")
            == .retryWhenUpdaterIdle)
    }

    @Test func nothingStagedKeepsTheHonestBlockedMessage() {
        #expect(AppUpdateCheckOutcomePolicy.onBlockedExplicitStart(stagedVersion: nil)
            == .reportBlocked)
    }
}

// MARK: - stagedVersion: the sticky fact the driver's decision reads

@MainActor
@Suite("Issue #303 — stagedVersion tracking")
struct StagedVersionTrackingTests {
    @Test func freshModelHasNothingStaged() {
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        #expect(model.stagedVersion == nil)
    }

    @Test func stagedReportRecordsTheVersion() {
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        model.report(.installedPendingRelaunch(version: "0.3.25"))
        #expect(model.stagedVersion == "0.3.25")
    }

    @Test func restartClickKeepsStagedVersionThroughChecking() {
        // The exact window the defect lives in: updateNow() reports
        // `.checking` BEFORE the driver runs, so the driver's blocked-start
        // decision cannot read the phase — it reads stagedVersion, which
        // must survive the transition.
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        let driver = RecordingDriver()
        model.attach(driver: driver)
        model.report(.installedPendingRelaunch(version: "0.3.25"))
        model.updateNow()
        #expect(model.phase == .checking)
        #expect(driver.beginInstallCount == 1)
        #expect(model.stagedVersion == "0.3.25")
        // …so a blocked start inside beginInstall resolves to retry, never
        // to the #165 "already in progress" dead end.
        #expect(AppUpdateCheckOutcomePolicy.onBlockedExplicitStart(
            stagedVersion: model.stagedVersion) == .retryWhenUpdaterIdle)
    }

    @Test func stagedVersionSurvivesLaterPhaseTraffic() {
        // A staged install stays staged until this process quits: failures,
        // background re-checks, and dialog cleanups must not erase the fact.
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        model.report(.installedPendingRelaunch(version: "0.3.25"))
        model.report(.checking)
        model.report(.failed(message: "transient"))
        model.clearTransientProgress()
        #expect(model.stagedVersion == "0.3.25")
    }

    @Test func newerStagedVersionReplacesTheOld() {
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        model.report(.installedPendingRelaunch(version: "0.3.25"))
        model.report(.installedPendingRelaunch(version: "0.3.26"))
        #expect(model.stagedVersion == "0.3.26")
    }
}

// MARK: - Restart-while-background-session-live, core half end to end

@MainActor
@Suite("Issue #303 — staged→restart handoff flow")
struct StagedRestartHandoffTests {
    @Test func promptRestartDrivesUpdateNowAndKeepsTheClickAlive() {
        // Full core-side walk of Tim's intended path: background stage →
        // prompt → Restart → (driver blocked by the live background
        // session) → retry decision → resumed user-initiated session
        // reports flow through to relaunch.
        let defaults = freshDefaults()
        let model = AppUpdateInstallModel(defaults: defaults)
        let driver = RecordingDriver()
        model.attach(driver: driver)
        let prompt = AppUpdateStagedPromptModel(
            installModel: model, defaults: defaults, notify: { _ in }
        )

        // Background session stages 0.3.25.
        model.report(.installedPendingRelaunch(version: "0.3.25"))
        #expect(prompt.state == .prompting(version: "0.3.25"))

        // Restart clicked.
        prompt.restartNow()
        #expect(driver.beginInstallCount == 1)
        #expect(model.phase == .checking)

        // Driver-side: updater still held by the background session —
        // resolution is retry, and the model NEVER shows the blocked
        // message on this path.
        #expect(AppUpdateCheckOutcomePolicy.onBlockedExplicitStart(
            stagedVersion: model.stagedVersion) == .retryWhenUpdaterIdle)
        if case .failed = model.phase {
            Issue.record("blocked message surfaced on a staged restart")
        }

        // The background session's terminal report can land mid-wait (it
        // re-reports the staged state); the retry decision must still hold.
        model.report(.installedPendingRelaunch(version: "0.3.25"))
        #expect(AppUpdateCheckOutcomePolicy.onBlockedExplicitStart(
            stagedVersion: model.stagedVersion) == .retryWhenUpdaterIdle)

        // Updater frees up; the resumed user-initiated session runs the
        // #163 explicit path to completion.
        model.report(.checking)
        model.report(.installing)
        model.report(.relaunching)
        #expect(model.phase == .relaunching)
        // The prompt yields the moment a restart is in flight.
        #expect(prompt.state == .hidden)
    }

    @Test func repeatedBlockedReentriesShareOneAbsoluteDeadline() {
        // CodeRabbit (PR #307): a per-task wait budget would restart the
        // 10 s clock every time the retry's beginInstall() found the
        // updater blocked again, holding `.checking` indefinitely. The
        // budget is armed ONCE per restart request; every re-entry reuses
        // the same absolute deadline.
        var budget = AppUpdateStagedRetryBudget()
        let t0 = Date(timeIntervalSinceReferenceDate: 1_000)
        let deadline = budget.armIfNeeded(now: t0)
        #expect(deadline == t0.addingTimeInterval(AppUpdateStagedRetryBudget.window))

        // First blocked re-entry, 6 s in: SAME deadline — not t0+16.
        #expect(budget.armIfNeeded(now: t0.addingTimeInterval(6)) == deadline)
        #expect(!budget.isExpired(now: t0.addingTimeInterval(9.9)))

        // Second blocked re-entry, 9.5 s in: still the same deadline…
        #expect(budget.armIfNeeded(now: t0.addingTimeInterval(9.5)) == deadline)
        // …so half a second later the request is over, no matter how many
        // re-entries happened along the way.
        #expect(budget.isExpired(now: t0.addingTimeInterval(10)))

        // A re-entry that arrives AFTER expiry reuses the spent deadline
        // and reads expired immediately — the driver's wait loop never
        // runs and reportBlockedStart() presents the honest message.
        #expect(budget.armIfNeeded(now: t0.addingTimeInterval(12)) == deadline)
        #expect(budget.isExpired(now: t0.addingTimeInterval(12)))
    }

    @Test func resolvingTheRequestArmsAFreshWindowForTheNextClick() {
        var budget = AppUpdateStagedRetryBudget()
        let t0 = Date(timeIntervalSinceReferenceDate: 2_000)
        _ = budget.armIfNeeded(now: t0)
        // Session started (or expiry was reported): the request resolves.
        budget.clear()
        #expect(!budget.isExpired(now: t0.addingTimeInterval(60)))
        // The NEXT restart click gets its own full window.
        let t1 = t0.addingTimeInterval(60)
        #expect(budget.armIfNeeded(now: t1)
            == t1.addingTimeInterval(AppUpdateStagedRetryBudget.window))
    }

    @Test func timeoutFallbackMessageIsTheHonestBlockedCopy() {
        // If the updater never frees (pathological), the driver falls back
        // to reportBlockedStart() — pin that the fallback phase is the
        // actionable #165 message, not a silent state.
        let phase = AppUpdateCheckOutcomePolicy.onBlockedExplicitStart()
        #expect(phase == .failed(
            message: AppUpdateCheckOutcomePolicy.blockedStartMessage))
    }
}
