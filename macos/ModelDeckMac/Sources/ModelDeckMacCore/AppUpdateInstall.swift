import Foundation

// Issue #121 — in-app updates via Sparkle 2 (Tim directive 2026-07-22,
// superseding the #60-era "notify only, never install" line): the
// update-found experience must not hand users to a GitHub release page.
//
// Layering rule: Sparkle itself never appears in ModelDeckMacCore. This file
// holds the testable state machine and preference plumbing; the app target
// provides a Sparkle-backed `AppUpdateInstalling` driver
// (SparkleUpdateDriver). Dev builds without a Sparkle-configured bundle
// (no SUFeedURL/SUPublicEDKey) run driverless and keep the pre-#121
// "View Release" hand-off — the model degrades honestly, never pretends.

/// Where a one-click install currently is. Progress fractions are 0…1;
/// nil means the total is unknown (indeterminate).
public enum AppUpdateInstallPhase: Equatable, Sendable {
    case idle
    /// Update Now pressed; Sparkle is re-reading the appcast.
    case checking
    case downloading(fraction: Double?)
    case extracting(fraction: Double?)
    /// Download verified (EdDSA + Apple code signature); installer running.
    /// The app is about to terminate and relaunch.
    case installing
    /// A background (automatic) install is staged; it applies on the next
    /// relaunch — nothing yanks the app out from under the user mid-session.
    case installedPendingRelaunch(version: String)
    case failed(message: String)
}

/// Seam the app target's Sparkle driver implements. All methods are fire-and
/// -forget from the model's perspective; outcomes come back via
/// `AppUpdateInstallModel.report(_:)`.
@MainActor
public protocol AppUpdateInstalling: AnyObject {
    /// One-click "Update Now": check the feed, download, verify, install,
    /// relaunch. User-initiated — errors surface, progress reports.
    func beginInstall()
    /// Scheduled background check (driven by AppUpdateAutoChecker's daily
    /// cadence, never by Sparkle's own timer). With automatic install ON the
    /// update downloads and stages quietly; OFF it only reports availability.
    func checkInBackground()
    /// Mirrors the "Install updates automatically" toggle into the updater.
    func setAutomaticInstallEnabled(_ enabled: Bool)
}

/// State + preference for the in-app installer. Shared by the deck dialog
/// and the Settings General section, so both surfaces always agree.
@MainActor
public final class AppUpdateInstallModel: ObservableObject {
    /// "Install updates automatically" — app-local preference like Launch at
    /// Login / the auto-check toggle; the daemon never stores it.
    nonisolated public static let autoInstallDefaultsKey = "modeldeck.appupdate.autoInstallEnabled"

    @Published public private(set) var phase: AppUpdateInstallPhase = .idle
    @Published public private(set) var isAutoInstallEnabled: Bool

    private let defaults: UserDefaults
    /// Nil in builds without a Sparkle-configured bundle (dev builds, and
    /// any release predating the appcast) — those keep the release-page path.
    public private(set) weak var driver: (any AppUpdateInstalling)?

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.isAutoInstallEnabled = Self.storedAutoInstall(defaults)
    }

    /// Default ON (Tim's call on issue #121): an absent key reads true, so
    /// fresh installs auto-install without a first-run decision. Turning it
    /// off is one honest toggle away.
    nonisolated public static func storedAutoInstall(_ defaults: UserDefaults) -> Bool {
        (defaults.object(forKey: autoInstallDefaultsKey) as? Bool) ?? true
    }

    /// Whether "Update Now" can actually install in this build.
    public var canInstall: Bool { driver != nil }

    /// One-time wiring at launch; pushes the stored preference into the
    /// updater so Sparkle's idea of automatic installs matches the toggle.
    public func attach(driver: any AppUpdateInstalling) {
        self.driver = driver
        driver.setAutomaticInstallEnabled(isAutoInstallEnabled)
    }

    public func setAutoInstall(_ enabled: Bool) {
        guard enabled != isAutoInstallEnabled else { return }
        isAutoInstallEnabled = enabled
        defaults.set(enabled, forKey: Self.autoInstallDefaultsKey)
        driver?.setAutomaticInstallEnabled(enabled)
    }

    /// The "Update Now" action. Honest without a driver: states that this
    /// build cannot install in-app instead of silently doing nothing.
    public func updateNow() {
        guard !isBusy else { return }
        guard let driver else {
            phase = .failed(message:
                "In-app install isn't available in this build — use the release page to download the update.")
            return
        }
        phase = .checking
        driver.beginInstall()
    }

    /// Scheduled path (AppUpdateAutoChecker). No-op without a driver or
    /// while an install is already running.
    public func backgroundCheck() {
        guard let driver, !isBusy else { return }
        driver.checkInBackground()
    }

    /// Driver callback funnel — every Sparkle state lands here.
    public func report(_ phase: AppUpdateInstallPhase) {
        self.phase = phase
    }

    public var isBusy: Bool {
        switch phase {
        case .checking, .downloading, .extracting, .installing: return true
        case .idle, .installedPendingRelaunch, .failed: return false
        }
    }

    /// Clears transient progress back to idle while PRESERVING terminal
    /// states — a staged pending-relaunch or a surfaced failure must stay
    /// visible through background-check errors and dialog dismissals alike.
    public func clearTransientProgress() {
        if isBusy { phase = .idle }
    }

    /// Honest one-line status for the Settings row / dialog body. Nil when
    /// idle (nothing to say).
    nonisolated public static func statusText(for phase: AppUpdateInstallPhase) -> String? {
        switch phase {
        case .idle:
            return nil
        case .checking:
            return "Checking the update feed…"
        case .downloading(let fraction):
            guard let fraction else { return "Downloading update…" }
            return "Downloading update… \(Int((fraction * 100).rounded()))%"
        case .extracting(let fraction):
            guard let fraction else { return "Preparing update…" }
            return "Preparing update… \(Int((fraction * 100).rounded()))%"
        case .installing:
            return "Installing — ModelDeck will relaunch."
        case .installedPendingRelaunch(let version):
            return "v\(version) is downloaded and installs the next time ModelDeck relaunches."
        case .failed(let message):
            return message
        }
    }
}
