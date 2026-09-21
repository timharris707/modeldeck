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
/// (github.com/timharris707/modeldeck), as the appcast describes it (#685).
public struct AppReleaseInfo: Equatable, Sendable {
    /// Normalized version ("0.3.0", tag "v" prefix stripped).
    public var version: String
    /// The release's human page — what "View Release" opens. From the
    /// appcast's `sparkle:releaseNotesLink`.
    public var url: URL
    /// Issue #675: the release's markdown body — the contents of
    /// docs/release-notes/<version>.md. Issue #685: read from the appcast
    /// item's `<description>`; nil when the feed carries none (an appcast
    /// built before #685), which every surface treats as "no notes to
    /// show", never as a failure.
    public var notes: String?

    public init(version: String, url: URL, notes: String? = nil) {
        self.version = version
        self.url = url
        self.notes = notes
    }
}

/// Issue #675: the release body as the update dialog renders it. The feed's
/// markdown opens with its own "# ModelDeck 1.1.12" heading and the dialog
/// title already names the version, so a leading level-1 heading is dropped;
/// blank edges go with it. nil for a release with nothing to read.
public enum AppReleaseNotes {
    public enum Destination: Equatable, Sendable {
        case inApp(version: String, body: String)
        case web(URL)
    }

    // Issue #704: Settings asks for the RUNNING version's notes, never
    // a newer release's body just because that is what the feed contains.
    public static func resolve(currentVersion: String?, latestRelease: AppReleaseInfo?) -> Destination {
        if let currentVersion, let latestRelease,
           latestRelease.version == currentVersion, let notes = latestRelease.notes {
            return .inApp(version: currentVersion, body: forDisplay(notes) ?? "")
        }
        return .web(AppcastReleaseChecker.releasePageURL(for: currentVersion))
    }

    public static func forDisplay(_ raw: String?) -> String? {
        guard let raw else { return nil }
        var lines = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")
        while let first = lines.first, first.trimmingCharacters(in: .whitespaces).isEmpty {
            lines.removeFirst()
        }
        if let first = lines.first, first.hasPrefix("# ") {
            lines.removeFirst()
        }
        let text = lines.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}

/// Failures from the update feed. Its own error domain on purpose — the
/// feed check is not daemon traffic, so it never borrows
/// `DaemonClientError` (PR #44 review note).
public enum AppReleaseCheckError: Error, Equatable, Sendable {
    /// The feed answered with something that isn't a decodable appcast.
    case invalidResponse
    /// A non-2xx HTTP answer. Issue #685: 404 is an error too — the appcast
    /// lives on the newest release, so "not found" means the feed is
    /// broken, not "no releases yet" (that is an EMPTY appcast).
    case httpStatus(Int)
}

/// Seam for the update feed; `AppcastReleaseChecker` conforms, tests stub it.
public protocol AppReleaseChecking: Sendable {
    /// The newest published release, or nil when the feed exists but lists
    /// no releases (an empty appcast channel — the honest "no releases"
    /// case, not an error).
    func latestRelease() async throws -> AppReleaseInfo?
}

/// Issue #685: reads the SAME Sparkle appcast the installer uses, so the
/// check that offers "Update Now" and the install that follows can never
/// disagree about whether an update exists. Read-only GET; no token, no
/// mutation, no daemon involvement. Version, notes, and release page all
/// come from the appcast item (`AppcastDecoder`).
// Issues #705/#706: immutable fields; UserDefaults supports concurrent reads/writes.
public struct AppcastReleaseChecker: AppReleaseChecking, @unchecked Sendable {
    /// The stable appcast redirect — GitHub serves the newest release's
    /// `appcast.xml` asset. Same value as `SUFeedURL` in Support/Info.plist.
    public static let defaultFeedURL =
        URL(string: "https://github.com/timharris707/modeldeck/releases/latest/download/appcast.xml")!

    public static func feedURL(bundle: Bundle = .main) -> URL {
        AppUpdateFeedPolicy.feedURL(betaEnabled: UserDefaults.standard.bool(forKey: AppUpdateFeedPolicy.betaReleasesKey), bundle: bundle)
    }

    private let overrideFeedURL: URL?
    private let bundle: Bundle
    private let defaults: UserDefaults
    public var feedURL: URL {
        overrideFeedURL ?? AppUpdateFeedPolicy.feedURL(betaEnabled: defaults.bool(forKey: AppUpdateFeedPolicy.betaReleasesKey), bundle: bundle)
    }
    private let transport: any HTTPDataTransport
    /// The macOS this process runs on (CodeRabbit, PR #686): items the
    /// feed marks as needing a newer macOS are not offered — Sparkle would
    /// refuse them at install time. Injectable so tests pin the filter.
    private let runningSystem: OperatingSystemVersion

    public init(
        feedURL: URL? = nil,
        transport: any HTTPDataTransport = URLSession.shared,
        runningSystem: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
        defaults: UserDefaults = .standard,
        bundle: Bundle = .main
    ) {
        self.overrideFeedURL = feedURL
        self.defaults = defaults
        self.bundle = bundle
        self.transport = transport
        self.runningSystem = runningSystem
    }

    public func latestRelease() async throws -> AppReleaseInfo? {
        let feedURL = self.feedURL
        var request = URLRequest(url: feedURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        // Never a cached copy: a release published minutes ago must be seen
        // by the next check, and the redirect target changes per release.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AppReleaseCheckError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AppReleaseCheckError.httpStatus(http.statusCode)
        }
        let newest: AppcastItem?
        do {
            newest = try AppcastDecoder.newestItem(from: data, runningSystem: runningSystem,
                                                   betaEnabled: feedURL.lastPathComponent == "appcast-beta.xml",
                                                   allowing: { AppUpdateSkipPolicy.allows(version: $0.shortVersionString, defaults: defaults) })
        } catch {
            throw AppReleaseCheckError.invalidResponse
        }
        // No installable item: the feed is fine, but nothing is published —
        // or nothing this Mac's macOS can run, which is the same answer.
        guard let item = newest else { return nil }
        guard let release = Self.releaseInfo(for: item) else {
            throw AppReleaseCheckError.invalidResponse
        }
        return release
    }

    /// Pure mapping from an appcast item to the app's release shape. The
    /// release page falls back to the tag page for an item without a
    /// `releaseNotesLink` (release-dmg.sh always writes one).
    public static func releaseInfo(for item: AppcastItem) -> AppReleaseInfo? {
        let version = AppVersion.normalized(tag: item.shortVersionString)
        guard !version.isEmpty else { return nil }
        let url = item.releaseNotesLink ?? releasePageURL(for: version)
        return AppReleaseInfo(version: version, url: url, notes: item.description)
    }

    // Issue #704: the feed fallback and Settings must name the same tag;
    // an unstamped development build can only link to the releases list.
    public static func releasePageURL(for version: String?) -> URL {
        let releases = "https://github.com/timharris707/modeldeck/releases"
        return URL(string: version.map { "\(releases)/tag/v\($0)" } ?? releases)!
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
    @Published public private(set) var latestKnownRelease: AppReleaseInfo?

    /// The running app's version (bundle authority — see `AppVersion`).
    public let currentVersion: String?

    private let checker: any AppReleaseChecking
    private let defaults: UserDefaults
    private let clock: @Sendable () -> Date
    private var completedCheckAt: Date?

    public init(
        checker: any AppReleaseChecking,
        currentVersion: String? = AppVersion.current(),
        defaults: UserDefaults = .standard,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.checker = checker
        self.currentVersion = currentVersion
        self.defaults = defaults
        self.clock = clock
    }

    public var isChecking: Bool { phase == .checking }

    public func check() async {
        guard phase != .checking else { return }
        completedCheckAt = nil
        phase = .checking
        let release: AppReleaseInfo?
        do {
            release = try await checker.latestRelease()
        } catch {
            // Issue #704: HTTP/decoding errors still reached the feed;
            // a transport failure must not replace the last-check date.
            if error is AppReleaseCheckError { completedCheckAt = clock() }
            phase = .unavailable(message: "Update check unavailable — couldn't reach the releases feed.")
            return
        }
        completedCheckAt = clock()
        latestKnownRelease = release
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
        guard AppUpdateSkipPolicy.allows(version: release.version, defaults: defaults) else {
            phase = .upToDate(latest: currentVersion)
            return
        }
        phase = AppVersion.isNewer(release.version, than: currentVersion)
            ? .updateAvailable(release)
            : .upToDate(latest: release.version)
    }

    /// Issue #170 — the explicit "Check for App Updates" entry point. An
    /// explicit user-initiated check must ALWAYS end in a presentable
    /// outcome: `check()` silently no-ops when a check is already in flight
    /// (the daily auto-check racing the click), which left `resultDialog`
    /// nil and the click with zero feedback. This waits the in-flight check
    /// out instead and returns the finished phase's dialog — never nil, so
    /// every explicit-check surface has something to present.
    ///
    /// Background scheduled checks keep calling `check()` directly and stay
    /// exactly as silent as before — this path is for user clicks only.
    public func explicitCheck() async -> ResultDialog {
        let hadSkip = defaults.string(forKey: AppUpdateSkipPolicy.key) != nil
        AppUpdateSkipPolicy.clear(defaults: defaults)
        // Issue #706: a check already selecting an item may have read the old
        // skip. Wait it out, then fetch again for this explicit request.
        if hadSkip {
            while isChecking { try? await Task.sleep(nanoseconds: 50_000_000) }
        }
        if !isChecking {
            await check()
        }
        // Another caller owns the in-flight check; its outcome serves this
        // click too. Poll cheaply — checks finish in network time.
        while isChecking {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        if let completedCheckAt {
            objectWillChange.send()
            // Issue #704: an explicit check intentionally delays the next
            // automatic one. Keep the existing key so installed dates survive.
            defaults.set(completedCheckAt, forKey: AppUpdateAutoChecker.lastCheckDefaultsKey)
        }
        // A finished check never rests on .idle/.checking, so this fallback
        // is defensive only — but "no feedback" is the bug, so never nil.
        return resultDialog ?? ResultDialog(
            title: "Couldn't check for updates",
            message: "The update check didn't finish. Try again in a moment."
        )
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
        /// Issue #675: the release notes to read INSIDE the dialog, heading
        /// stripped (`AppReleaseNotes.forDisplay`). nil means no notes are
        /// available and the dialog shows none — it never says so.
        public var releaseNotes: String?

        public init(
            title: String,
            message: String,
            releaseURL: URL? = nil,
            offersInstall: Bool = false,
            releaseNotes: String? = nil
        ) {
            self.title = title
            self.message = message
            self.releaseURL = releaseURL
            self.offersInstall = offersInstall
            self.releaseNotes = releaseNotes
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
                offersInstall: canInstall,
                releaseNotes: AppReleaseNotes.forDisplay(release.notes)
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
/// toggle. Periodic check against the same appcast as the manual check
/// (never any other endpoint; #685), a few hours between checks
/// per the app's restraint bar (#241 tightened it from daily) — never a
/// tight loop. The preference is app-local (UserDefaults), like Launch at
/// Login: the daemon never stores it.
///
/// Issue #121 (Tim directive 2026-07-22): this checker stays the scheduling
/// brain. Sparkle's own timer is disabled (`SUEnableAutomaticChecks` NO);
/// when a newer version is found AND a Sparkle driver is attached, the due
/// tick hands off to `AppUpdateInstallModel.backgroundCheck()` — quiet
/// download + stage when "Install updates automatically" is on, availability
/// notice otherwise. Without a driver (dev builds, pre-Sparkle releases) the
/// original notify-only behavior is unchanged.
///
/// Issue #675 (Tim, 2026-09-19): the toggle DEFAULTS ON. It shipped off, so
/// a fresh install never checked at all until someone found the switch —
/// while "Install updates automatically" was already on by spec, waiting for
/// a check that never ran. Turning it off is still honoured forever; only
/// the never-touched case changed.
@MainActor
public final class AppUpdateAutoChecker: ObservableObject {
    nonisolated public static let enabledDefaultsKey = "modeldeck.appupdate.autoCheckEnabled"
    nonisolated public static let lastCheckDefaultsKey = "modeldeck.appupdate.lastAutoCheckAt"
    nonisolated public static let lastNotifiedDefaultsKey = "modeldeck.appupdate.lastNotifiedVersion"
    /// Every ~4 hours (issue #241; was daily). ModelDeck is an always-on
    /// menu-bar app, so a once-daily check lost every race against a
    /// same-day release — Tim's install checked at ~07:30 and never saw a
    /// version shipped that afternoon before he updated by hand. Still
    /// restrained: at most six feed GETs a day against the appcast, and only
    /// while the auto-check toggle is on.
    nonisolated public static let checkInterval: TimeInterval = 4 * 60 * 60
    /// The scheduler wakes hourly to ask "is the check due yet?" —
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
        self.isEnabled = Self.storedEnabled(in: defaults)
    }

    deinit {
        schedulerTask?.cancel()
    }

    /// Issue #675: unset means ON. An explicit choice — either way — is
    /// written to the key and wins from then on, so a user who turned
    /// automatic checks off never has them turned back on by this default.
    nonisolated static func storedEnabled(in defaults: UserDefaults) -> Bool {
        guard defaults.object(forKey: enabledDefaultsKey) != nil else { return true }
        return defaults.bool(forKey: enabledDefaultsKey)
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
    /// check interval has elapsed since the last automatic or explicit check.
    nonisolated public static func isDue(now: Date, lastCheck: Date?) -> Bool {
        guard let lastCheck else { return true }
        return now.timeIntervalSince(lastCheck) >= checkInterval
    }

    public var lastCheckAt: Date? {
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
        objectWillChange.send()
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
            // Issue #241: the old "installs the next time ModelDeck
            // relaunches" promised an event that never happens on an
            // always-running menu-bar app. The staged-restart prompt
            // (AppUpdateStagedPromptModel) is the follow-through; say so.
            body = running + "It's downloading in the background — ModelDeck will offer a restart when it's ready."
        }
        return AppUpdateNotification(
            title: "ModelDeck \(release.version) is available",
            body: body
        )
    }
}
