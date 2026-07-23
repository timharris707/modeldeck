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
        guard updater.canCheckForUpdates else { return }
        userDriver.mode = .userInitiated
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

    init(installModel: AppUpdateInstallModel) {
        self.installModel = installModel
    }

    private func report(_ phase: AppUpdateInstallPhase) {
        installModel?.report(phase)
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
        MainActor.assumeIsolated {
            report(.checking)
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
            // Feed disagrees with the GitHub check that offered the button —
            // rare, but say so instead of spinning.
            if mode == .userInitiated {
                report(.failed(message: "The update feed has no newer version yet. Try again later."))
            }
            acknowledgement()
        }
    }

    nonisolated func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        nonisolated(unsafe) let acknowledgement = acknowledgement
        MainActor.assumeIsolated {
            if mode == .userInitiated {
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
        MainActor.assumeIsolated {
            expectedDownloadLength = 0
            receivedDownloadLength = 0
            if mode == .userInitiated { report(.downloading(fraction: nil)) }
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
            switch mode {
            case .userInitiated:
                report(.installing)
                reply(.install)
            case .background:
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
        MainActor.assumeIsolated {
            report(.installing)
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
            // relaunch) visible; clear only transient progress.
            installModel?.clearTransientProgress()
        }
    }
}
