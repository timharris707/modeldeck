import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Issue #33 — "Check for App Updates" in the Settings → General "ModelDeck"
// section. This surface is deliberately SEPARATE from the CLI tools section:
// CLI updates (per-CLI Update pills, daemon-run installers) and ModelDeck's
// own update never share a control or wording — Tim's explicit design
// decision on issue #33.
//
// NO self-replacing updater lives here, on purpose: a real install step
// needs the signed, notarized DMG pipeline from issue #16 (Developer ID +
// Sparkle-or-equivalent decided there). Until that ships, "update available"
// links to the GitHub release page and the user installs by hand.

/// The newest published release of the PUBLIC repo
/// (github.com/timharris707/modeldeck).
public struct AppReleaseInfo: Equatable, Sendable {
    /// Normalized version ("0.3.0", tag "v" prefix stripped).
    public var version: String
    /// The release's human page — what "View Release" opens.
    public var url: URL

    public init(version: String, url: URL) {
        self.version = version
        self.url = url
    }
}

/// Failures from the releases feed. Its own error domain on purpose — the
/// GitHub check is not daemon traffic, so it never borrows
/// `DaemonClientError` (PR #44 review note).
public enum AppReleaseCheckError: Error, Equatable, Sendable {
    /// The feed answered with something that isn't a decodable release.
    case invalidResponse
    /// A non-2xx, non-404 HTTP answer (404 means "no releases yet" and is
    /// surfaced as nil, not an error).
    case httpStatus(Int)
}

/// Seam for the release feed; `GitHubReleaseChecker` conforms, tests stub it.
public protocol AppReleaseChecking: Sendable {
    /// The latest published release, or nil when the feed exists but has no
    /// releases yet (the public repo may 404 until the first release ships —
    /// that is the honest "no releases" case, not an error).
    func latestRelease() async throws -> AppReleaseInfo?
}

/// Checks the GitHub releases feed of the public repo. Read-only GET against
/// api.github.com; no token, no mutation, no daemon involvement.
public struct GitHubReleaseChecker: AppReleaseChecking {
    /// `GET /repos/{owner}/{repo}/releases/latest` for the PUBLIC repo.
    public static let defaultFeedURL =
        URL(string: "https://api.github.com/repos/timharris707/modeldeck/releases/latest")!

    private let feedURL: URL
    private let transport: any HTTPDataTransport

    public init(
        feedURL: URL = GitHubReleaseChecker.defaultFeedURL,
        transport: any HTTPDataTransport = URLSession.shared
    ) {
        self.feedURL = feedURL
        self.transport = transport
    }

    private struct ReleaseBody: Decodable {
        var tagName: String
        var htmlUrl: String

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case htmlUrl = "html_url"
        }
    }

    public func latestRelease() async throws -> AppReleaseInfo? {
        var request = URLRequest(url: feedURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AppReleaseCheckError.invalidResponse
        }
        // 404: the repo has no published release yet (expected until the
        // first public release) — that's "nothing to offer", not a failure.
        if http.statusCode == 404 { return nil }
        guard (200..<300).contains(http.statusCode) else {
            throw AppReleaseCheckError.httpStatus(http.statusCode)
        }
        guard let body = try? JSONDecoder().decode(ReleaseBody.self, from: data),
              let url = URL(string: body.htmlUrl) else {
            throw AppReleaseCheckError.invalidResponse
        }
        let version = AppVersion.normalized(tag: body.tagName)
        guard !version.isEmpty else { throw AppReleaseCheckError.invalidResponse }
        return AppReleaseInfo(version: version, url: url)
    }
}

/// State machine behind "Check for App Updates": idle → checking →
/// upToDate / updateAvailable / unavailable. Degrades honestly — offline or
/// feed-less states say "couldn't check", never a fake "up to date".
@MainActor
public final class AppUpdateModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        /// Never checked in this session.
        case idle
        case checking
        case upToDate(latest: String)
        /// A newer release exists; the action is "View Release" (open the
        /// release page) — never an in-place install (deferred to #16).
        case updateAvailable(AppReleaseInfo)
        /// The check couldn't produce an answer — offline, feed missing, or
        /// the running build has no comparable version. Honest message.
        case unavailable(message: String)
    }

    @Published public private(set) var phase: Phase = .idle

    /// The running app's version (bundle authority — see `AppVersion`).
    public let currentVersion: String?

    private let checker: any AppReleaseChecking

    public init(checker: any AppReleaseChecking, currentVersion: String? = AppVersion.current()) {
        self.checker = checker
        self.currentVersion = currentVersion
    }

    public var isChecking: Bool { phase == .checking }

    public func check() async {
        guard phase != .checking else { return }
        phase = .checking
        let release: AppReleaseInfo?
        do {
            release = try await checker.latestRelease()
        } catch {
            phase = .unavailable(message: "Update check unavailable — couldn't reach the releases feed.")
            return
        }
        guard let release else {
            phase = .unavailable(message: "Update check unavailable — no releases published yet.")
            return
        }
        guard let currentVersion else {
            // Development builds carry no bundle version; refusing to compare
            // beats claiming this unstamped binary is (or isn't) current.
            phase = .unavailable(message: "This build has no version to compare (development build).")
            return
        }
        phase = AppVersion.isNewer(release.version, than: currentVersion)
            ? .updateAvailable(release)
            : .upToDate(latest: release.version)
    }

    // MARK: Result dialog (issue #33 final placement decision)

    /// What the gear-menu "Check for App Updates…" flow presents once a
    /// check finishes: a standard small dialog. `releaseURL` non-nil means
    /// the dialog carries a release-page action; `offersInstall` (issue
    /// #121, Sparkle builds) upgrades the primary action to "Update Now"
    /// with "Release Notes" secondary. Otherwise it's a plain OK dialog.
    public struct ResultDialog: Equatable, Sendable {
        public var title: String
        public var message: String
        public var releaseURL: URL?
        /// True only when this build can install in-app (a Sparkle driver is
        /// attached) — the dialog's primary button becomes "Update Now".
        public var offersInstall: Bool

        public init(title: String, message: String, releaseURL: URL? = nil, offersInstall: Bool = false) {
            self.title = title
            self.message = message
            self.releaseURL = releaseURL
            self.offersInstall = offersInstall
        }
    }

    /// Whether this build carries a working in-app installer (issue #121).
    /// Set once at launch from `AppUpdateInstallModel.canInstall`; stays
    /// false in dev builds and pre-Sparkle releases so every surface keeps
    /// the honest "View Release" hand-off.
    public var canInstallUpdates: Bool = false

    /// Pure derivation of the result dialog for a finished check; nil while
    /// idle or still checking (nothing to present yet). Nonisolated — no
    /// model state involved, so it's callable (and testable) anywhere.
    nonisolated public static func dialog(
        for phase: Phase,
        currentVersion: String?,
        canInstall: Bool = false
    ) -> ResultDialog? {
        switch phase {
        case .idle, .checking:
            return nil
        case .upToDate(let latest):
            return ResultDialog(
                title: "You're up to date",
                message: "ModelDeck v\(latest) is the latest release."
            )
        case .updateAvailable(let release):
            let running = currentVersion.map { "You're running v\($0). " } ?? ""
            return ResultDialog(
                title: "Version \(release.version) is available",
                message: canInstall
                    ? running + "Update Now downloads, verifies, and installs it, then relaunches ModelDeck."
                    : running + "View the release to download it.",
                releaseURL: release.url,
                offersInstall: canInstall
            )
        case .unavailable(let message):
            return ResultDialog(title: "Couldn't check for updates", message: message)
        }
    }

    /// The dialog for the current phase (see `dialog(for:currentVersion:canInstall:)`).
    public var resultDialog: ResultDialog? {
        Self.dialog(for: phase, currentVersion: currentVersion, canInstall: canInstallUpdates)
    }
}

// MARK: - Automatic checks (issue #60)

/// A banner announcing that a newer release exists. Notify + link only —
/// the user still downloads and installs by hand.
public struct AppUpdateNotification: Equatable, Sendable {
    public var title: String
    public var body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }
}

/// Issue #60 — the Settings → General "Check for updates automatically"
/// toggle. Periodic check against the same public GitHub releases feed as
/// the manual check (never any other endpoint), daily cadence per the app's
/// restraint bar — never a tight loop. The preference is app-local
/// (UserDefaults), like Launch at Login: the daemon never stores it.
///
/// Issue #121 (Tim directive 2026-07-22): this checker stays the scheduling
/// brain. Sparkle's own timer is disabled (`SUEnableAutomaticChecks` NO);
/// when a newer version is found AND a Sparkle driver is attached, the daily
/// tick hands off to `AppUpdateInstallModel.backgroundCheck()` — quiet
/// download + stage when "Install updates automatically" is on, availability
/// notice otherwise. Without a driver (dev builds, pre-Sparkle releases) the
/// original notify-only behavior is unchanged.
@MainActor
public final class AppUpdateAutoChecker: ObservableObject {
    nonisolated public static let enabledDefaultsKey = "modeldeck.appupdate.autoCheckEnabled"
    nonisolated public static let lastCheckDefaultsKey = "modeldeck.appupdate.lastAutoCheckAt"
    nonisolated public static let lastNotifiedDefaultsKey = "modeldeck.appupdate.lastNotifiedVersion"
    /// Daily — infrequent on purpose.
    nonisolated public static let checkInterval: TimeInterval = 24 * 60 * 60
    /// The scheduler wakes hourly to ask "is the daily check due yet?" —
    /// cheap clock math only; the feed is hit at most once per interval.
    nonisolated static let wakeInterval: TimeInterval = 60 * 60

    @Published public private(set) var isEnabled: Bool

    private let model: AppUpdateModel
    /// Issue #121: optional install hand-off; nil keeps notify-only behavior.
    private let installModel: AppUpdateInstallModel?
    private let defaults: UserDefaults
    private let clock: @Sendable () -> Date
    private let notify: @MainActor (AppUpdateNotification) async -> Void
    private var schedulerTask: Task<Void, Never>?

    public init(
        model: AppUpdateModel,
        installModel: AppUpdateInstallModel? = nil,
        defaults: UserDefaults = .standard,
        clock: @escaping @Sendable () -> Date = { Date() },
        notify: @escaping @MainActor (AppUpdateNotification) async -> Void
    ) {
        self.model = model
        self.installModel = installModel
        self.defaults = defaults
        self.clock = clock
        self.notify = notify
        self.isEnabled = defaults.bool(forKey: Self.enabledDefaultsKey)
    }

    deinit {
        schedulerTask?.cancel()
    }

    /// The Settings toggle. Enabling starts the schedule (with an immediate
    /// catch-up check when one is due); disabling stops it. Persisted
    /// app-locally.
    public func setEnabled(_ enabled: Bool) {
        guard enabled != isEnabled else { return }
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.enabledDefaultsKey)
        if enabled {
            start()
        } else {
            stop()
        }
    }

    /// Call once at launch: starts the schedule when the stored preference
    /// is on; a no-op otherwise (and when already running).
    public func start() {
        guard isEnabled, schedulerTask == nil else { return }
        schedulerTask = Task { [weak self] in
            await self?.checkIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.wakeInterval * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.checkIfDue()
            }
        }
    }

    private func stop() {
        schedulerTask?.cancel()
        schedulerTask = nil
    }

    /// Pure due-ness rule: never checked → due; otherwise due once the
    /// daily interval has elapsed since the last automatic check.
    nonisolated public static func isDue(now: Date, lastCheck: Date?) -> Bool {
        guard let lastCheck else { return true }
        return now.timeIntervalSince(lastCheck) >= checkInterval
    }

    var lastCheckAt: Date? {
        defaults.object(forKey: Self.lastCheckDefaultsKey) as? Date
    }

    public func checkIfDue() async {
        guard isEnabled, Self.isDue(now: clock(), lastCheck: lastCheckAt) else { return }
        await runCheck()
    }

    /// One automatic check through the SHARED model — Settings and the gear
    /// menu mirror the outcome. The check is stamped regardless of result
    /// (a failed feed retries tomorrow, never in a loop) and each discovered
    /// version notifies at most once.
    func runCheck() async {
        // A manual check in flight makes model.check() a no-op; don't stamp
        // lastCheckAt for a check that never ran — the next tick retries.
        guard !model.isChecking else { return }
        await model.check()
        defaults.set(clock(), forKey: Self.lastCheckDefaultsKey)
        guard case .updateAvailable(let release) = model.phase else { return }
        // Issue #121: with a Sparkle driver attached and auto-install on,
        // every due tick hands off to the quiet background install — even a
        // version that was already announced (a notified-but-uninstalled
        // update must still install once the toggle allows it).
        let mode = notificationMode
        if mode == .automaticInstall {
            installModel?.backgroundCheck()
        }
        guard release.version != defaults.string(forKey: Self.lastNotifiedDefaultsKey) else { return }
        defaults.set(release.version, forKey: Self.lastNotifiedDefaultsKey)
        await notify(Self.notification(for: release, currentVersion: model.currentVersion, mode: mode))
    }

    /// How a discovered update proceeds in this build (issue #121).
    public enum UpdateHandOff: Equatable, Sendable {
        /// No installer in this build — notify with the manual-check path.
        case notifyOnly
        /// Installer present, automatic install off — notify about Update Now.
        case updateNow
        /// Installer present, automatic install on — install quietly.
        case automaticInstall
    }

    private var notificationMode: UpdateHandOff {
        guard let installModel, installModel.canInstall else { return .notifyOnly }
        return installModel.isAutoInstallEnabled ? .automaticInstall : .updateNow
    }

    /// Banner copy — explicit that nothing installs by itself.
    nonisolated public static func notification(
        for release: AppReleaseInfo,
        currentVersion: String?
    ) -> AppUpdateNotification {
        notification(for: release, currentVersion: currentVersion, mode: .notifyOnly)
    }

    /// Banner copy per hand-off mode. Always states exactly what happens
    /// next — "nothing installs automatically" only when that is true.
    nonisolated public static func notification(
        for release: AppReleaseInfo,
        currentVersion: String?,
        mode: UpdateHandOff
    ) -> AppUpdateNotification {
        let running = currentVersion.map { "You're running v\($0). " } ?? ""
        let body: String
        switch mode {
        case .notifyOnly:
            body = running + "Use Check for App Updates to view the release — nothing installs automatically."
        case .updateNow:
            body = running + "Use Update Now in ModelDeck to install it — nothing installs until you do."
        case .automaticInstall:
            body = running + "It's downloading in the background and installs the next time ModelDeck relaunches."
        }
        return AppUpdateNotification(
            title: "ModelDeck \(release.version) is available",
            body: body
        )
    }
}
