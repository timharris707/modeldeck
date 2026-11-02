import Foundation

// Issue #784 (slice 1 of #783) — one CLIProxyAPI pool, on one Mac.
//
// Tim is moving to a single pool hosted on the Mac Studio. Every other Mac
// reaches it through a forwarder that listens on that Mac's OWN
// 127.0.0.1:8317, so there the proxy port answers but nothing behind it is
// that Mac's to manage. The daemon owns the switch (`proxyRole`, host by
// default), reports it as `/api/state.proxy.role`, and in remote role
// refuses pool sign-in, sign-in repair, weight and credential reads with
// `code: "proxy-role-remote"` and the sentence below.
//
// The app's half: in remote role it never starts, adopts, probes, or offers
// to set up the bundled proxy; it stops the one it started when the role
// moves to remote; and the deck header says, quietly, where the pool is.
//
// Issue #788 (slice 4): once the daemon reports the pool host's usage page,
// that label opens the page and says when it last answered. The app never
// fetches the page itself; the daemon reads it.

/// Which Mac runs the proxy pool.
public enum ProxyRole: String, Codable, Equatable, Sendable {
    /// This Mac hosts the pool: the daemon's default, and every install's
    /// behaviour before #784.
    case host
    /// This Mac uses the pool on another machine, through a forwarder that
    /// holds this Mac's proxy port.
    case remote

    /// A role name from the daemon or from storage. Anything but `host` means
    /// this Mac is not the pool host, so a name this build does not know
    /// stands down like `remote` rather than reading as host.
    public init(named name: String) {
        self = ProxyRole(rawValue: name) ?? .remote
    }
}

/// The last pool role a daemon state reported, kept across launches so the
/// app decides at launch without waiting for the daemon (#784 review): a host
/// Mac's bundled proxy must not sit down while the daemon is busy after an
/// update. nil means never recorded, which reads as host — every install's
/// behaviour before #784. A recorded remote stays remote until a state says
/// host.
public protocol ProxyRoleRemembering: AnyObject, Sendable {
    var lastSeenRole: ProxyRole? { get set }
}

/// Keeps the role for this process only: tests, previews, and dev builds.
public final class EphemeralProxyRoleMemory: ProxyRoleRemembering, @unchecked Sendable {
    private let lock = NSLock()
    private var role: ProxyRole?

    public init(_ role: ProxyRole? = nil) {
        self.role = role
    }

    public var lastSeenRole: ProxyRole? {
        get { lock.withLock { role } }
        set { lock.withLock { role = newValue } }
    }
}

/// Every sentence the remote role speaks, in one tested place.
public enum ProxyRoleCopy {
    /// The daemon's own sentence (src/service.mjs `proxyRoleRemote`),
    /// verbatim, so a hidden control and a daemon refusal give one reason.
    public static let remoteReason = "This Mac uses the proxy pool on another machine; manage it there."

    /// The daemon's machine-readable refusal code for the same reason.
    public static let remoteRefusalCode = "proxy-role-remote"

    public static let remotePoolLabel = "Remote pool"

    /// Starts with the visible words, so a voice user can say what they see.
    public static let remotePoolAccessibilityLabel = "Remote pool: proxy pool on another machine"

    /// The deck header's label: "Remote pool" in remote role only. Host
    /// renders today's header unchanged.
    public static func headerLabel(for role: ProxyRole) -> String? {
        role == .remote ? remotePoolLabel : nil
    }

    /// True when a daemon refusal is the remote-role one: the daemon's
    /// stated reason for an attempt this Mac no longer makes, not a failure.
    public static func isRemoteRefusal(_ error: Error) -> Bool {
        guard case DaemonClientError.daemonCodedError(_, let code, _, _) = error else { return false }
        return code == remoteRefusalCode
    }

    // MARK: - Issue #788: the pool host's usage page

    public static let hubNotAnswering = "page not answering"
    /// The page answered, but its own read of the pool Mac failed.
    public static let hubNoFreshData = "page has no fresh data"
    /// The link's spoken hint: what the click does.
    public static let opensUsagePageHint = "Opens the pool's usage page"

    /// The deck header's pool label for this role and the daemon's hub
    /// report: nil on the pool host; the plain label on a remote Mac with no
    /// page this Mac may open; otherwise a link to the page, whose freshness
    /// the view words from the hub as time passes.
    public static func remotePoolHeader(role: ProxyRole, hub: DeckProxyHub?) -> RemotePoolHeader? {
        guard headerLabel(for: role) != nil else { return nil }
        guard let hub, let page = hubPage(hub.url) else { return .label }
        return .link(page: page, hub: hub)
    }

    /// The hub's page as a URL the deck may open: http or https, with a
    /// host. Anything else (javascript:, file:, ftp:, …) is never opened.
    public static func hubPage(_ raw: String) -> URL? {
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else { return nil }
        return url
    }

    /// What the header says about the page, relative to `now`. "page not
    /// answering" only when the daemon's latest finished read failed: an
    /// old answer alone (after sleep, or a daemon restart) blames nothing
    /// and shows its age in the deck's own words, however old. "page has no
    /// fresh data" when the page answered but its own read of the pool Mac
    /// failed. Nil before any answer or failure, so a read still in flight
    /// says nothing. A timestamp the deck cannot read counts as missing.
    public static func hubFreshness(_ hub: DeckProxyHub, now: Date) -> String? {
        let answered = DeckDateParsing.date(from: hub.lastAnsweredAt)
        if let failed = DeckDateParsing.date(from: hub.lastFailedAt), answered.map({ failed > $0 }) ?? true {
            return hubNotAnswering
        }
        guard let answered else { return nil }
        if hub.lastReadOk == false { return hubNoFreshData }
        return "answered \(DeckFreshness.ageText(observedAt: answered, now: now))"
    }

    /// The link's spoken label: the visible words, in order. The link's
    /// explicit label replaces its children's, so the freshness must be in
    /// it (#65/#113/#272); where the click goes is the hint.
    public static func remotePoolLinkAccessibilityLabel(freshness: String?) -> String {
        ([remotePoolLabel] + [freshness].compactMap { $0 }).joined(separator: ", ")
    }

    /// The link's tooltip: why the pool is elsewhere, where the click goes,
    /// and the freshness, which the single-column deck has no room to show.
    public static func remotePoolLinkTooltip(page: URL, freshness: String?) -> String {
        var lines = [remoteReason, "Click to open its usage page: \(page.absoluteString)"]
        if let freshness { lines.append(freshness.prefix(1).uppercased() + freshness.dropFirst() + ".") }
        return lines.joined(separator: "\n")
    }
}

/// Issue #788: what the deck header shows beside the wordmark on a remote
/// Mac (#784 shows nothing on the pool host).
public enum RemotePoolHeader: Equatable, Sendable {
    /// #784's quiet "Remote pool": the daemon reports no page this Mac may
    /// open.
    case label
    /// "Remote pool" opens the pool host's usage page; the freshness worded
    /// from `hub` follows it.
    case link(page: URL, hub: DeckProxyHub)

    /// The click: opens the page in the browser. The plain label opens
    /// nothing.
    public func open(with browser: any BrowserOpening) {
        if case .link(let page, _) = self { browser.open(page) }
    }
}
