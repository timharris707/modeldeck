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
    /// the dialog offers "View Release" (opens the release page) beside
    /// Cancel; otherwise it's a plain OK dialog.
    public struct ResultDialog: Equatable, Sendable {
        public var title: String
        public var message: String
        public var releaseURL: URL?

        public init(title: String, message: String, releaseURL: URL? = nil) {
            self.title = title
            self.message = message
            self.releaseURL = releaseURL
        }
    }

    /// Pure derivation of the result dialog for a finished check; nil while
    /// idle or still checking (nothing to present yet). Nonisolated — no
    /// model state involved, so it's callable (and testable) anywhere.
    nonisolated public static func dialog(for phase: Phase, currentVersion: String?) -> ResultDialog? {
        switch phase {
        case .idle, .checking:
            return nil
        case .upToDate(let latest):
            return ResultDialog(
                title: "You're up to date",
                message: "ModelDeck v\(latest) is the latest release."
            )
        case .updateAvailable(let release):
            return ResultDialog(
                title: "Version \(release.version) is available",
                message: currentVersion.map { "You're running v\($0). View the release to download it." }
                    ?? "View the release to download it.",
                releaseURL: release.url
            )
        case .unavailable(let message):
            return ResultDialog(title: "Couldn't check for updates", message: message)
        }
    }

    /// The dialog for the current phase (see `dialog(for:currentVersion:)`).
    public var resultDialog: ResultDialog? {
        Self.dialog(for: phase, currentVersion: currentVersion)
    }
}
