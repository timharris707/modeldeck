import AppKit
import ModelDeckMacCore
import Sparkle

// Issue #121 — the Sparkle 2 half of the in-app updater. Everything Sparkle
// lives in this file (the app target); ModelDeckMacCore only knows the
// `AppUpdateInstalling` seam and the phase enum.
//
// Configuration contract (documented on the PR):
// - Info.plist: SUFeedURL (stable appcast URL), SUEnableAutomaticChecks=NO
//   (AppUpdateAutoChecker stays the scheduling brain), and SUPublicEDKey —
//   stamped by scripts/release-dmg.sh from Tim's one-time `generate_keys`
//   run, never committed. Dev bundles lack the key, so `makeIfConfigured`
//   returns nil and the app keeps the pre-Sparkle "View Release" path.
// - The app is hardened-runtime + notarized but NOT sandboxed, so the
//   standard non-sandboxed Sparkle configuration applies: no XPC services,
//   no SUEnableInstallerLauncherService, no extra entitlements.

/// Sparkle-backed implementation of the core install seam. Owns the
/// SPUUpdater (headless — our own SPUUserDriver below, no Sparkle UI) and
/// funnels every state into the shared AppUpdateInstallModel.
@MainActor
final class SparkleUpdateDriver: NSObject, AppUpdateInstalling {
    private let updater: SPUUpdater
    private let userDriver: OneClickUserDriver

    /// Builds the driver only when the running bundle is fully configured
    /// for Sparkle (feed URL + EdDSA public key). Anything less returns nil
    /// and the app honestly stays on the release-page path.
    static func makeIfConfigured(installModel: AppUpdateInstallModel, bundle: Bundle = .main) -> SparkleUpdateDriver? {
        guard let feed = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String, !feed.isEmpty,
              let key = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String, !key.isEmpty
        else { return nil }
        return SparkleUpdateDriver(installModel: installModel, bundle: bundle)
    }

    private init?(installModel: AppUpdateInstallModel, bundle: Bundle) {
        let userDriver = OneClickUserDriver(installModel: installModel)
        self.userDriver = userDriver
        self.updater = SPUUpdater(
            hostBundle: bundle,
            applicationBundle: bundle,
            userDriver: userDriver,
            delegate: nil
        )
        super.init()
        // Our daily checker schedules; Sparkle's own timer stays off (also
        // pinned by SUEnableAutomaticChecks=NO in Info.plist, which prevents
        // Sparkle's first-run permission prompt).
        updater.automaticallyChecksForUpdates = false
        do {
            try updater.start()
        } catch {
            // Misconfigured bundle (Sparkle validates the feed/key setup at
            // start). Refuse the driver rather than carry a broken updater.
            return nil
        }
    }

    // MARK: AppUpdateInstalling

    func beginInstall() {
        guard updater.canCheckForUpdates else {
            // Issue #163: a silent return here left the model stuck on
            // "Checking…" forever (updateNow() already reported .checking).
            // Say why the click can't act instead of eating it.
            userDriver.reportBlockedStart()
            return
        }
        userDriver.mode = .userInitiated
        userDriver.beginUserInitiatedSession()
        updater.checkForUpdates()
    }

    func checkInBackground() {
        guard updater.canCheckForUpdates else { return }
        userDriver.mode = .background
        updater.checkForUpdatesInBackground()
    }

    func setAutomaticInstallEnabled(_ enabled: Bool) {
        updater.automaticallyDownloadsUpdates = enabled
    }
}

/// Headless SPUUserDriver: never shows Sparkle UI. User-initiated flows
/// auto-accept every step (that's what "one-click" means); background flows
/// stage quietly and only surface the pending-relaunch state. All outcomes
/// report into the shared install model, which the deck dialog and Settings
/// row render.
@MainActor
final class OneClickUserDriver: NSObject {
    enum Mode {
        /// "Update Now": proceed through download → verify → install →
        /// relaunch without further questions.
        case userInitiated
        /// Daily scheduled check: download/stage quietly (Sparkle only
        /// downloads when automaticallyDownloadsUpdates is on); never
        /// relaunch the running app.
        case background
    }

    var mode: Mode = .background
    private weak var installModel: AppUpdateInstallModel?
    private var expectedDownloadLength: UInt64 = 0
    private var receivedDownloadLength: UInt64 = 0
    private var foundVersion: String = ""
    /// Issue #163: set when the user's Cancel invoked Sparkle's cancellation
    /// block — the follow-up updater "error" (if Sparkle raises one) is the
    /// cancellation echo, never a failure to surface.
    private var userDidCancel = false
    /// Issue #163: the force-quit fallback runs at most once per session.
    private var relaunchTerminationScheduled = false

    init(installModel: AppUpdateInstallModel) {
        self.installModel = installModel
    }

    /// Fresh user-initiated session: reset the per-session flags.
    func beginUserInitiatedSession() {
        userDidCancel = false
        relaunchTerminationScheduled = false
    }

    /// Issue #163: `SPUUpdater.canCheckForUpdates` said no (a session is
    /// already running or the updater hasn't started) — land the click on an
    /// actionable, honest state instead of a stuck "Checking…".
    func reportBlockedStart() {
        // Phase + copy pinned in core (issue #170 verified #165's fix
        // actually presents): AppUpdateCheckOutcomePolicy owns the message.
        report(AppUpdateCheckOutcomePolicy.onBlockedExplicitStart())
    }

    private func report(_ phase: AppUpdateInstallPhase) {
        installModel?.report(phase)
    }

    /// Offers Sparkle's cancellation block to the shared model (Cancel in
    /// the dialog). User-initiated sessions only — background sessions have
    /// no visible flow to cancel.
    private func offerCancellation(_ cancellation: @escaping () -> Void) {
        guard mode == .userInitiated else { return }
        installModel?.setCancelHandler { [weak self] in
            self?.userDidCancel = true
            cancellation()
        }
    }

    /// Issue #163 root-cause fix: Sparkle's Autoupdate agent sends ONE quit
    /// Apple event and then KVO-waits for this process to die — in Tim's
    /// live 0.3.4→0.3.5 update that event never took effect, and the staged
    /// installer slept indefinitely ("Installing — ModelDeck will
    /// relaunch." forever). On an explicit Update Now the app finishes the
    /// job itself: give Sparkle's event a beat, re-send it via the
    /// sanctioned retry handler, then terminate in-process. The agent
    /// observes the termination, swaps the bundle, and relaunches the new
    /// version — the completion #121 promised.
    private func forceTerminationSoon(retry: @escaping () -> Void) {
        guard !relaunchTerminationScheduled else { return }
        relaunchTerminationScheduled = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard case .relaunching = installModel?.phase else { return }
            retry() // Sparkle re-sends the quit Apple event
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard case .relaunching = installModel?.phase else { return }
            NSApp.terminate(nil)
        }
    }
}

extension OneClickUserDriver: SPUUserDriver {
    // Sparkle drives the user driver on the main queue; hop assertions keep
    // Swift 6 strict concurrency honest without trusting annotations.

    nonisolated func show(
        _ request: SPUUpdatePermissionRequest,
        reply: @escaping (SUUpdatePermissionResponse) -> Void
    ) {
        // Never reached in practice (SUEnableAutomaticChecks=NO +
        // automaticallyChecksForUpdates=false), but answer honestly anyway:
        // no Sparkle scheduling, no system profile telemetry.
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false))
    }

    nonisolated func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        nonisolated(unsafe) let cancellation = cancellation
        MainActor.assumeIsolated {
            report(.checking)
            // Issue #163: Sparkle permits cancelling until the check
            // completes — surface it as the dialog's Cancel.
            offerCancellation(cancellation)
        }
    }

    nonisolated func showUpdateFound(
        with appcastItem: SUAppcastItem,
        state: SPUUserUpdateState,
        reply: @escaping (SPUUserUpdateChoice) -> Void
    ) {
        // Sparkle's headers carry no Sendable/actor annotations, but its
        // documented contract delivers user-driver calls on the main queue;
        // assumeIsolated crashes loudly if that ever stops being true. The
        // unsafe transfers below exist ONLY to cross that annotation gap.
        nonisolated(unsafe) let appcastItem = appcastItem
        nonisolated(unsafe) let state = state
        nonisolated(unsafe) let reply = reply
        MainActor.assumeIsolated {
            foundVersion = appcastItem.displayVersionString
            switch mode {
            case .userInitiated:
                // The check's cancellation block is spent — the download
                // stage offers its own (showDownloadInitiated).
                installModel?.setCancelHandler(nil)
                // One-click: the user already said "Update Now".
                report(.downloading(fraction: nil))
                reply(.install)
            case .background:
                if state.stage == .downloaded || state.stage == .installing {
                    // Already staged from an earlier pass — keep it staged.
                    report(.installedPendingRelaunch(version: appcastItem.displayVersionString))
                    reply(.dismiss)
                } else if installModel?.isAutoInstallEnabled == true {
                    // Quiet download+stage; Sparkle installs on termination.
                    reply(.install)
                } else {
                    // Availability is the auto-checker's story (banner);
                    // nothing downloads without the toggle or Update Now.
                    reply(.dismiss)
                }
            }
        }
    }

    nonisolated func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        // Release notes render on the GitHub release page (secondary action
        // in both surfaces); the in-app flow never shows them.
    }

    nonisolated func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}

    nonisolated func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        nonisolated(unsafe) let acknowledgement = acknowledgement
        MainActor.assumeIsolated {
            // Issue #170: the no-update-found callback routes through the
            // core policy by session origin — explicit sessions present the
            // feed-disagreement message (the GitHub check offered the button,
            // Sparkle's re-check disagrees; rare), background sessions stay
            // silent exactly as always.
            if let phase = AppUpdateCheckOutcomePolicy.onUpdateNotFound(mode: policyMode) {
                report(phase)
            }
            acknowledgement()
        }
    }

    nonisolated func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        nonisolated(unsafe) let acknowledgement = acknowledgement
        MainActor.assumeIsolated {
            if userDidCancel {
                // Issue #163: the "error" is Sparkle acknowledging the
                // user's own Cancel — actionable idle, never a red failure.
                userDidCancel = false
                installModel?.clearTransientProgress()
            } else if mode == .userInitiated {
                report(.failed(message:
                    "Update failed — \(error.localizedDescription) Nothing was changed; you can retry or use the release page."))
            } else {
                // Background failures stay quiet (tomorrow retries); leave
                // the surfaces in their last honest state, never mid-progress
                // — and never clobber a staged pending-relaunch status.
                installModel?.clearTransientProgress()
            }
            acknowledgement()
        }
    }

    nonisolated func showDownloadInitiated(cancellation: @escaping () -> Void) {
        nonisolated(unsafe) let cancellation = cancellation
        MainActor.assumeIsolated {
            expectedDownloadLength = 0
            receivedDownloadLength = 0
            if mode == .userInitiated {
                report(.downloading(fraction: nil))
                // Issue #163: valid until extraction starts; the model
                // drops it automatically on the .extracting report.
                offerCancellation(cancellation)
            }
        }
    }

    nonisolated func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        MainActor.assumeIsolated {
            expectedDownloadLength = expectedContentLength
            receivedDownloadLength = 0
        }
    }

    nonisolated func showDownloadDidReceiveData(ofLength length: UInt64) {
        MainActor.assumeIsolated {
            receivedDownloadLength += length
            guard mode == .userInitiated else { return }
            if expectedDownloadLength > 0 {
                let fraction = min(1, Double(receivedDownloadLength) / Double(expectedDownloadLength))
                report(.downloading(fraction: fraction))
            } else {
                report(.downloading(fraction: nil))
            }
        }
    }

    nonisolated func showDownloadDidStartExtractingUpdate() {
        MainActor.assumeIsolated {
            if mode == .userInitiated { report(.extracting(fraction: nil)) }
        }
    }

    nonisolated func showExtractionReceivedProgress(_ progress: Double) {
        MainActor.assumeIsolated {
            if mode == .userInitiated { report(.extracting(fraction: progress)) }
        }
    }

    nonisolated func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        nonisolated(unsafe) let reply = reply
        MainActor.assumeIsolated {
            switch AppUpdateRelaunchPolicy.onReadyToInstall(mode: policyMode) {
            case .installAndRelaunchNow:
                // Issue #163: the explicit click drives the install to
                // COMPLETION — .install here, and the showInstallingUpdate
                // callback below guarantees the quit actually happens.
                report(.installing)
                reply(.install)
            case .stageForNextLaunch:
                // Staged; installs on the next quit/relaunch — never yank
                // the app out from under the user.
                report(.installedPendingRelaunch(version: foundVersion))
                reply(.dismiss)
            }
        }
    }

    nonisolated func showInstallingUpdate(
        withApplicationTerminated applicationTerminated: Bool,
        retryTerminatingApplication: @escaping () -> Void
    ) {
        nonisolated(unsafe) let retryTerminatingApplication = retryTerminatingApplication
        MainActor.assumeIsolated {
            switch AppUpdateRelaunchPolicy.onInstalling(
                mode: policyMode, applicationTerminated: applicationTerminated
            ) {
            case .relaunchingNow(let forceTerminationIfNeeded):
                report(.relaunching)
                if forceTerminationIfNeeded {
                    forceTerminationSoon(retry: retryTerminatingApplication)
                }
            case .stagedUntilNextLaunch:
                // Issue #163: a background-staged install waiting on the
                // next quit must never read as "Installing…" — that copy
                // describes a stall (and in Tim's live run, it WAS one).
                report(.installedPendingRelaunch(version: foundVersion))
            }
        }
    }

    private var policyMode: AppUpdateRelaunchPolicy.SessionMode {
        switch mode {
        case .userInitiated: return .userInitiated
        case .background: return .background
        }
    }

    nonisolated func showUpdateInstalledAndRelaunched(
        _ relaunched: Bool,
        acknowledgement: @escaping () -> Void
    ) {
        acknowledgement()
    }

    nonisolated func showUpdateInFocus() {}

    nonisolated func dismissUpdateInstallation() {
        MainActor.assumeIsolated {
            // Terminal cleanup — keep terminal states (failed / pending
            // relaunch) visible; clear only transient progress (which also
            // withdraws any still-offered cancellation, issue #163).
            userDidCancel = false
            installModel?.clearTransientProgress()
        }
    }
}
