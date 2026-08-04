import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #241 — always-on installs never saw updates: with automatic install
// ON, background updates staged silently for a relaunch that never happens
// on an always-running menu-bar app. These tests pin the fix's state
// machine end to end: staged → prompt ONCE (banner + notification) →
// dismiss → passive badge (staged-invisible impossible) → Restart drives
// the existing #163 explicit path; a NEW staged version re-arms the prompt;
// and the check cadence for always-on installs is hours, not daily.
//
// Runtime verification of a real Sparkle staged update is not feasible in
// this environment — the state machine below compensates by exercising the
// exact phase reports the driver funnels through AppUpdateInstallModel.

// MARK: - Shared rig

@MainActor
private final class PromptDriver: AppUpdateInstalling {
    private(set) var beginInstallCount = 0
    private(set) var backgroundCheckCount = 0
    var lastAutoInstall: Bool?

    func beginInstall() { beginInstallCount += 1 }
    func checkInBackground() { backgroundCheckCount += 1 }
    func setAutomaticInstallEnabled(_ enabled: Bool) { lastAutoInstall = enabled }
}

@MainActor
private final class PromptLog {
    var posted: [AppUpdateNotification] = []
}

private func freshDefaults() -> UserDefaults {
    let suite = "issue241-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
}

@MainActor
private struct Rig {
    let installModel: AppUpdateInstallModel
    let driver: PromptDriver
    let prompt: AppUpdateStagedPromptModel
    let log: PromptLog
    let defaults: UserDefaults
}

@MainActor
private func makeRig(defaults: UserDefaults? = nil) -> Rig {
    let defaults = defaults ?? freshDefaults()
    let installModel = AppUpdateInstallModel(defaults: defaults)
    let driver = PromptDriver()
    installModel.attach(driver: driver)
    let log = PromptLog()
    let prompt = AppUpdateStagedPromptModel(
        installModel: installModel,
        defaults: defaults
    ) { log.posted.append($0) }
    return Rig(installModel: installModel, driver: driver, prompt: prompt, log: log, defaults: defaults)
}

// MARK: - Prompt state machine

@Suite("Staged update restart prompt (issue #241)")
@MainActor
struct StagedUpdatePromptTests {
    @Test func stagingSurfacesTheProactivePromptWithNotification() {
        let rig = makeRig()
        #expect(rig.prompt.state == .hidden)

        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))

        #expect(rig.prompt.state == .prompting(version: "0.3.19"))
        #expect(rig.log.posted.count == 1)
        #expect(rig.log.posted.first?.title == "ModelDeck 0.3.19 is ready")
        #expect(rig.log.posted.first?.body.contains("Restart to finish updating") == true)
        // The once-per-version memory persists under its OWN key — never
        // the auto-checker's lastNotifiedVersion (whose freeze at 0.3.10
        // was #241's smoking gun).
        #expect(rig.defaults.string(
            forKey: AppUpdateStagedPromptModel.lastPromptedDefaultsKey) == "0.3.19")
        #expect(AppUpdateStagedPromptModel.lastPromptedDefaultsKey
            != AppUpdateAutoChecker.lastNotifiedDefaultsKey)
    }

    @Test func reReportedStagedVersionNeverNags() {
        // Every 4-hourly background check re-finds the staged update and
        // re-reports the same phase — the prompt must not re-fire.
        let rig = makeRig()
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))

        #expect(rig.prompt.state == .prompting(version: "0.3.19"))
        #expect(rig.log.posted.count == 1)
    }

    @Test func dismissalDegradesToThePassiveBadge() {
        let rig = makeRig()
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.prompt.dismissPrompt()

        #expect(rig.prompt.state == .badged(version: "0.3.19"))
        #expect(rig.prompt.isBadgeVisible)
        #expect(rig.prompt.stagedVersion == "0.3.19")

        // The badge survives re-reports without re-promoting to a prompt —
        // the user's dismissal stands until the version changes.
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        #expect(rig.prompt.state == .badged(version: "0.3.19"))
        #expect(rig.log.posted.count == 1)
    }

    @Test func dismissIsAPromptOnlyAffordance() {
        let rig = makeRig()
        rig.prompt.dismissPrompt() // hidden: no-op
        #expect(rig.prompt.state == .hidden)
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.prompt.dismissPrompt()
        rig.prompt.dismissPrompt() // badged: no-op, stays badged
        #expect(rig.prompt.state == .badged(version: "0.3.19"))
    }

    @Test func restartClickDrivesTheExistingExplicitInstallPath() {
        // The one-click Restart is a hand-off to AppUpdateInstallModel.
        // updateNow() — the #163 user-initiated path (quit → install →
        // relaunch, force-termination fallback included). No new plumbing.
        let rig = makeRig()
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.prompt.restartNow()

        #expect(rig.driver.beginInstallCount == 1)
        // updateNow() reported .checking; the prompt yields to the running
        // session (the #121 progress line owns the story from here).
        #expect(rig.installModel.phase == .checking)
        #expect(rig.prompt.state == .hidden)
    }

    @Test func restartWorksFromTheBadgeToo() {
        let rig = makeRig()
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.prompt.dismissPrompt()
        rig.prompt.restartNow()
        #expect(rig.driver.beginInstallCount == 1)
    }

    @Test func restartWhileHiddenIsANoOp() {
        // The offer only exists while something is staged — a stray click
        // path must never start a Sparkle session on its own.
        let rig = makeRig()
        rig.prompt.restartNow()
        #expect(rig.driver.beginInstallCount == 0)
    }

    @Test func aNewStagedVersionReArmsThePrompt() {
        // Staged 0.3.19, dismissed; 0.3.20 ships and stages while the app
        // keeps running — the NEW version prompts again (once).
        let rig = makeRig()
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.prompt.dismissPrompt()
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.20"))

        #expect(rig.prompt.state == .prompting(version: "0.3.20"))
        #expect(rig.log.posted.count == 2)
        #expect(rig.log.posted.last?.title == "ModelDeck 0.3.20 is ready")
    }

    @Test func alreadyPromptedVersionLandsOnTheBadgeNotThePrompt() {
        // A second model over the same defaults (app restarted with the
        // update still staged, or the model rebuilt mid-session): the
        // persisted once-per-version memory keeps the prompt quiet, but the
        // badge still shows — staged-invisible must be impossible.
        let defaults = freshDefaults()
        let first = makeRig(defaults: defaults)
        first.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        #expect(first.log.posted.count == 1)

        let second = makeRig(defaults: defaults)
        second.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        #expect(second.prompt.state == .badged(version: "0.3.19"))
        #expect(second.log.posted.isEmpty)
    }

    @Test func promptPicksUpAPhaseStagedBeforeItExisted() {
        // $phase replays its current value on subscribe: an update staged
        // before the prompt model was constructed is surfaced immediately.
        let defaults = freshDefaults()
        let installModel = AppUpdateInstallModel(defaults: defaults)
        installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        let log = PromptLog()
        let prompt = AppUpdateStagedPromptModel(
            installModel: installModel, defaults: defaults
        ) { log.posted.append($0) }
        #expect(prompt.state == .prompting(version: "0.3.19"))
        #expect(log.posted.count == 1)
    }

    @Test func nonStagedPhasesHideThePromptAndBadge() {
        let rig = makeRig()
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        rig.installModel.report(.installing)
        #expect(rig.prompt.state == .hidden)
        #expect(rig.prompt.stagedVersion == nil)

        // Staged again (background check re-finds it) after a failure in
        // between: the badge returns without a second notification.
        rig.installModel.report(.failed(message: "boom"))
        #expect(rig.prompt.state == .hidden)
        rig.installModel.report(.installedPendingRelaunch(version: "0.3.19"))
        #expect(rig.prompt.state == .badged(version: "0.3.19"))
        #expect(rig.log.posted.count == 1)
    }

    @Test func copyIsSingleSourced() {
        let banner = AppUpdateStagedPromptModel.bannerText(version: "0.4.0")
        #expect(banner == "ModelDeck 0.4.0 is ready — restart to finish updating.")
        let explanation = AppUpdateStagedPromptModel.badgeExplanation(version: "0.4.0")
        #expect(explanation.title == "Update ready")
        // The badge popover reuses the install model's existing
        // pending-relaunch status line verbatim (no diverging copy), then
        // states that the restart is an offer, never automatic.
        let staged = AppUpdateInstallModel.statusText(
            for: .installedPendingRelaunch(version: "0.4.0"))!
        #expect(explanation.body.hasPrefix(staged))
        #expect(explanation.body.contains("nothing restarts until you choose to"))
    }
}

// MARK: - Relaunch policy (issue #163 decision table, unchanged)

@Suite("Staged prompt respects the #163 relaunch policy")
struct StagedPromptRelaunchPolicyTests {
    @Test func restartClickIsCoveredByTheExistingUserInitiatedRows() {
        // The Restart button runs updateNow() → a user-initiated Sparkle
        // session over the already-staged update. The EXISTING decision
        // table already resolves that to install-and-relaunch-now with the
        // force-termination fallback — no new row needed; this test pins
        // that the staged-prompt case rides those rows verbatim.
        #expect(AppUpdateRelaunchPolicy.onReadyToInstall(mode: .userInitiated)
            == .installAndRelaunchNow)
        #expect(AppUpdateRelaunchPolicy.onInstalling(
            mode: .userInitiated, applicationTerminated: false)
            == .relaunchingNow(forceTerminationIfNeeded: true))
    }

    @Test func backgroundSessionsStillOnlyStageNeverRestart() {
        // The prompt is an OFFER: nothing in #241 makes a background
        // session yank the app — staging remains the background terminal.
        #expect(AppUpdateRelaunchPolicy.onReadyToInstall(mode: .background)
            == .stageForNextLaunch)
        #expect(AppUpdateRelaunchPolicy.onInstalling(
            mode: .background, applicationTerminated: false)
            == .stagedUntilNextLaunch)
    }
}

// MARK: - Check cadence for always-on installs

@Suite("Auto-check cadence (issue #241)")
struct AutoCheckCadenceTests {
    @Test func checkIntervalIsFourHoursNotDaily() {
        // Once-daily checks (~07:30 on Tim's install) lost every race
        // against a same-day release; an always-on app checks every ~4h.
        #expect(AppUpdateAutoChecker.checkInterval == 4 * 60 * 60)
    }

    @Test func hourlyWakeStillDividesTheInterval() {
        // The scheduler's cheap hourly wake must remain at most the check
        // interval, or due checks would be missed by construction.
        #expect(AppUpdateAutoChecker.wakeInterval <= AppUpdateAutoChecker.checkInterval)
    }

    @Test func dueRuleFollowsTheNewInterval() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(!AppUpdateAutoChecker.isDue(
            now: now, lastCheck: now.addingTimeInterval(-(4 * 60 * 60) + 60)))
        #expect(AppUpdateAutoChecker.isDue(
            now: now, lastCheck: now.addingTimeInterval(-(4 * 60 * 60))))
    }
}

// MARK: - #113 warning-slot integration for the badge popover

@Suite("Update-ready badge rides the #113 slot (issue #241)")
@MainActor
struct UpdateReadyBadgeSlotTests {
    @Test func badgeIsLiveExactlyWhileVisible() {
        let live = DeckPopoverModel.liveWarningIDs(
            rows: [], staleness: { _ in nil },
            cadenceNoticeVisible: false,
            updateBadgeVisible: true
        )
        #expect(live.contains(DeckWarningID(topic: .updateReady)))

        let gone = DeckPopoverModel.liveWarningIDs(
            rows: [], staleness: { _ in nil },
            cadenceNoticeVisible: false,
            updateBadgeVisible: false
        )
        #expect(!gone.contains(DeckWarningID(topic: .updateReady)))
    }

    @Test func reconcileReleasesTheSlotWhenTheBadgeGoes() {
        // Restart clicked (or the staged phase cleared): the badge's open
        // popover must not hold the one-at-a-time slot hostage.
        let model = DeckPopoverModel(
            defaults: UserDefaults(suiteName: "issue241-slot-\(UUID().uuidString)")!)
        let id = DeckWarningID(topic: .updateReady)
        model.toggleWarning(id)
        #expect(model.isWarningPresented(id))

        model.reconcileWarnings(
            rows: [], staleness: { _ in nil },
            cadenceNoticeVisible: false,
            updateBadgeVisible: true
        )
        #expect(model.isWarningPresented(id)) // still live → still up

        model.reconcileWarnings(
            rows: [], staleness: { _ in nil },
            cadenceNoticeVisible: false,
            updateBadgeVisible: false
        )
        #expect(!model.isWarningPresented(id)) // badge gone → slot released
    }
}
