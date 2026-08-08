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
    /// Issue #163: the installer is waiting for THIS process to quit so it
    /// can swap the bundle and relaunch. On an explicit Update Now this is
    /// moments long (the driver terminates the app itself if Sparkle's quit
    /// event doesn't land) — never a silent stage-and-wait.
    case relaunching
    /// A background (automatic) install is staged; it applies on the next
    /// relaunch — nothing yanks the app out from under the user mid-session.
    case installedPendingRelaunch(version: String)
    case failed(message: String)
}

/// Issue #163 — the decision table the Sparkle driver applies when the
/// installer reaches its terminal callbacks. Pure and core-owned so tests
/// pin the split Tim's live 0.3.4→0.3.5 forensics exposed: an EXPLICIT
/// Update Now must drive quit → install → relaunch to completion, while
/// background (automatic) updates stay staged until the app next quits.
public enum AppUpdateRelaunchPolicy {
    public enum SessionMode: Equatable, Sendable {
        /// The user pressed Update Now.
        case userInitiated
        /// The periodic scheduled check (AppUpdateAutoChecker's cadence).
        case background
    }

    /// Response to Sparkle's "ready to install and relaunch" ask.
    public enum ReadyResponse: Equatable, Sendable {
        /// Install immediately and relaunch — the one-click promise (#121).
        case installAndRelaunchNow
        /// Keep the staged update; it applies on the next natural quit.
        case stageForNextLaunch
    }

    /// Response to Sparkle's "installing, app not necessarily terminated"
    /// callback (the stall point in issue #163's forensics: Autoupdate
    /// KVO-waits on app termination after sending a quit Apple event).
    public enum InstallingResponse: Equatable, Sendable {
        /// Show "relaunching"; when `forceTerminationIfNeeded` the driver
        /// must actively quit the app if Sparkle's own quit event doesn't
        /// take effect — waiting forever is the bug, not a state.
        case relaunchingNow(forceTerminationIfNeeded: Bool)
        /// Background staging: stay running, report the honest
        /// pending-relaunch story (never "Installing…" — that reads as
        /// stalled because it IS stalled until the next quit).
        case stagedUntilNextLaunch
    }

    public static func onReadyToInstall(mode: SessionMode) -> ReadyResponse {
        switch mode {
        case .userInitiated: return .installAndRelaunchNow
        case .background: return .stageForNextLaunch
        }
    }

    public static func onInstalling(
        mode: SessionMode, applicationTerminated: Bool
    ) -> InstallingResponse {
        switch mode {
        case .userInitiated:
            // Explicit click: completion is the contract. If the app is
            // still alive, the driver terminates it (retry signal first,
            // then a direct in-process terminate).
            return .relaunchingNow(forceTerminationIfNeeded: !applicationTerminated)
        case .background:
            return .stagedUntilNextLaunch
        }
    }
}

/// Issue #170 — outcome routing for a Sparkle session that ends WITHOUT an
/// update to install. Pure and core-owned (like AppUpdateRelaunchPolicy) so
/// tests pin the split: an EXPLICIT user-initiated session always lands on a
/// visible phase, a BACKGROUND session stays silent. The driver applies the
/// returned phase verbatim; nil means "report nothing".
public enum AppUpdateCheckOutcomePolicy {
    /// Explicit Update Now, but Sparkle's appcast re-check disagrees with
    /// the GitHub check that offered the button (rare) — say so, never spin.
    public static let feedNoNewerVersionMessage =
        "The update feed has no newer version yet. Try again later."
    /// Explicit click while `SPUUpdater.canCheckForUpdates` says no (a
    /// session is already running) — issue #165's fix for the silent no-op;
    /// pinned here so the presentation can never quietly drift away.
    public static let blockedStartMessage =
        "An update is already in progress. Give it a moment, then try again."

    /// Where Sparkle's no-update-found user-driver callback
    /// (`showUpdateNotFoundWithError`) lands, by session origin.
    public static func onUpdateNotFound(
        mode: AppUpdateRelaunchPolicy.SessionMode
    ) -> AppUpdateInstallPhase? {
        switch mode {
        case .userInitiated:
            return .failed(message: feedNoNewerVersionMessage)
        case .background:
            // Background checks that find nothing stay silent exactly as
            // always — no phase change, no dialog, tomorrow retries.
            return nil
        }
    }

    /// Phase for a blocked explicit start (`canCheckForUpdates == false`).
    public static func onBlockedExplicitStart() -> AppUpdateInstallPhase {
        .failed(message: blockedStartMessage)
    }

    /// Issue #303 — what a blocked explicit start (`canCheckForUpdates ==
    /// false`) means depends on WHY the updater is busy. When a background
    /// session has already staged an install (Tim's 0.3.24→0.3.25 path),
    /// the session holding the updater is the very update the user is
    /// trying to finish — "An update is already in progress, try again"
    /// is a shrug where a restart was promised. The driver keeps the click
    /// alive and starts the user-initiated session the moment the updater
    /// frees up; only a blocked start with NOTHING staged keeps the honest
    /// #165 blocked message.
    public enum BlockedExplicitStartResolution: Equatable, Sendable {
        /// A staged install exists: retry `beginInstall()` when
        /// `canCheckForUpdates` flips true (bounded wait; on timeout the
        /// driver falls back to `reportBlocked`'s message — never a silent
        /// stuck "Checking…", which was #163's bug).
        case retryWhenUpdaterIdle
        /// Nothing staged — present `blockedStartMessage` (#165).
        case reportBlocked
    }

    public static func onBlockedExplicitStart(
        stagedVersion: String?
    ) -> BlockedExplicitStartResolution {
        stagedVersion != nil ? .retryWhenUpdaterIdle : .reportBlocked
    }
}

/// Issue #303 (CodeRabbit, PR #307) — ONE absolute deadline per deferred
/// restart request. The driver's wait loop can re-enter itself (the retry's
/// `beginInstall()` may find the updater blocked again); a per-task budget
/// would restart the clock on every re-entry, letting repeated transitions
/// hold the model in `.checking` indefinitely. This budget arms on the
/// FIRST deferral and every re-entry reuses the same deadline; only
/// resolution (session started, superseded, or expiry → the honest blocked
/// message) clears it for the next restart request. Pure and clock-injected
/// so tests pin the re-entry arithmetic.
public struct AppUpdateStagedRetryBudget: Sendable {
    /// The whole restart request's wait window, across all re-entries.
    public static let window: TimeInterval = 10

    public private(set) var deadline: Date?

    public init() {}

    /// (Re-)entry into the deferred wait: arms on first use, REUSES the
    /// armed deadline on re-entry — never extends it.
    public mutating func armIfNeeded(now: Date) -> Date {
        if let deadline { return deadline }
        let armed = now.addingTimeInterval(Self.window)
        deadline = armed
        return armed
    }

    /// True once the armed deadline has passed — the driver must stop
    /// waiting and present the blocked message. False when unarmed.
    public func isExpired(now: Date) -> Bool {
        guard let deadline else { return false }
        return now >= deadline
    }

    /// The request resolved (session started, superseded, or expiry
    /// reported) — the NEXT restart click gets a fresh window.
    public mutating func clear() { deadline = nil }
}

/// Seam the app target's Sparkle driver implements. All methods are fire-and
/// -forget from the model's perspective; outcomes come back via
/// `AppUpdateInstallModel.report(_:)`.
@MainActor
public protocol AppUpdateInstalling: AnyObject {
    /// One-click "Update Now": check the feed, download, verify, install,
    /// relaunch. User-initiated — errors surface, progress reports.
    func beginInstall()
    /// Scheduled background check (driven by AppUpdateAutoChecker's
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
    /// Issue #163: true exactly while Sparkle permits cancelling the
    /// in-flight session (checking + downloading; never once extraction
    /// starts). The dialog's Cancel button renders from this.
    @Published public private(set) var canCancel: Bool = false
    private var cancelHandler: (() -> Void)?

    /// Issue #303 — the last version Sparkle reported as staged
    /// (`.installedPendingRelaunch`). Sticky for the process lifetime once
    /// set: a staged install stays staged through later phase traffic
    /// (`updateNow()`'s `.checking`, a failed resume, background re-checks)
    /// until this process quits and the installer applies it. The driver
    /// reads it to tell "blocked because MY staged update holds the
    /// updater" (retry when idle) from "blocked, nothing staged" (#165's
    /// honest message).
    public private(set) var stagedVersion: String?

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

    /// Driver callback funnel — every Sparkle state lands here. Any phase
    /// past the cancellable window (checking/downloading) drops the cancel
    /// handler: Sparkle's cancellation blocks are only valid before
    /// extraction starts (issue #163).
    public func report(_ phase: AppUpdateInstallPhase) {
        self.phase = phase
        if case .installedPendingRelaunch(let version) = phase {
            stagedVersion = version // #303: sticky — see the property doc
        }
        switch phase {
        case .checking, .downloading:
            break // an offered cancellation stays valid through these
        case .idle, .extracting, .installing, .relaunching,
             .installedPendingRelaunch, .failed:
            dropCancelHandler()
        }
    }

    /// Issue #163: the Sparkle driver offers (and withdraws) the session's
    /// cancellation block here. Nil withdraws.
    public func setCancelHandler(_ handler: (() -> Void)?) {
        cancelHandler = handler
        canCancel = handler != nil
    }

    /// The dialog's Cancel button. Returns the flow to an actionable idle
    /// immediately; the handler tells Sparkle to abort its session.
    public func cancelUpdate() {
        guard let cancelHandler else { return }
        dropCancelHandler()
        phase = .idle
        cancelHandler()
    }

    private func dropCancelHandler() {
        cancelHandler = nil
        if canCancel { canCancel = false }
    }

    public var isBusy: Bool {
        switch phase {
        case .checking, .downloading, .extracting, .installing, .relaunching: return true
        case .idle, .installedPendingRelaunch, .failed: return false
        }
    }

    /// Clears transient progress back to idle while PRESERVING terminal
    /// states — a staged pending-relaunch or a surfaced failure must stay
    /// visible through background-check errors and dialog dismissals alike.
    /// `.relaunching` is preserved too (issue #163): after an explicit
    /// Update Now it is terminal for THIS process — the app is about to
    /// quit for the installer, and clearing it would both lie to the user
    /// and disarm the driver's force-termination fallback. Only a driver
    /// report (e.g. `.failed`) moves the model off it.
    public func clearTransientProgress() {
        if isBusy, phase != .relaunching { phase = .idle }
        dropCancelHandler()
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
        case .relaunching:
            return "Relaunching ModelDeck…"
        case .installedPendingRelaunch(let version):
            return "v\(version) is downloaded and installs the next time ModelDeck relaunches."
        case .failed(let message):
            return message
        }
    }

    /// Issue #303 — the one-click follow-through that must sit NEXT TO the
    /// staged status text on every surface that renders it. Tim's field
    /// report: the settings row said "installs the next time ModelDeck
    /// relaunches" with nothing to click, so he quit the app by hand. The
    /// contract: wherever `statusText` announces `.installedPendingRelaunch`,
    /// the view renders a button with this title wired to `updateNow()` —
    /// nil for every other phase (no stray restart buttons).
    nonisolated public static func restartActionTitle(for phase: AppUpdateInstallPhase) -> String? {
        if case .installedPendingRelaunch = phase { return "Restart to Update" }
        return nil
    }

    /// Shared tooltip for the #303 restart action (same promise as the deck
    /// banner's Restart: the #163 explicit quit→install→relaunch path).
    nonisolated public static let restartActionHelp =
        "Quits, installs the downloaded update, and reopens ModelDeck — no manual quit needed."

    /// Determinate progress for the dialog's bar, when Sparkle reports one
    /// (download with a known content length; extraction). Nil = show an
    /// indeterminate bar/spinner for that phase.
    nonisolated public static func progressFraction(for phase: AppUpdateInstallPhase) -> Double? {
        switch phase {
        case .downloading(let fraction), .extracting(let fraction):
            return fraction
        case .idle, .checking, .installing, .relaunching,
             .installedPendingRelaunch, .failed:
            return nil
        }
    }
}
