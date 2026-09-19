import Foundation

// Issue #423 (1.0 build E) — the app window: the daemon-served dashboard in
// a real ModelDeck window instead of a browser tab (#402(a)(c), charter d2).
//
// Everything decidable without AppKit lives here so it is unit-testable; the
// app target owns only the NSWindow and the WKWebView that loads
// http://127.0.0.1:<port>/dashboard. There is NO second serving mechanism:
// the daemon's existing HTTP surface is the only source, exactly as the
// browser used it.

/// What the window shows right now.
public enum DashboardWindowPhase: Equatable, Sendable {
    /// The daemon is answering — the web view loads `url`.
    case live(URL)
    /// The daemon isn't answering. One honest line, one action.
    case daemonDown(DashboardDaemonDownState)
}

/// The window's empty state. Deliberately one message + one action (the
/// deck's own daemon card carries the full setup story); a window that can't
/// show data should say so and offer the one thing that fixes it.
public struct DashboardDaemonDownState: Equatable, Sendable {
    public var message: String
    public var actionTitle: String
    public var action: DashboardStartAction

    public init(message: String, actionTitle: String, action: DashboardStartAction) {
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }
}

/// The one action the empty state offers, resolved from the setup phase the
/// deck already tracks (issue #96) so the button never lies about what it
/// will do.
public enum DashboardStartAction: Equatable, Sendable {
    /// The bundled service was never installed (or was declined) — the
    /// action is the same install the deck's consent card runs.
    case installService
    /// The service exists but isn't answering yet (starting up, awaiting
    /// Login Items approval, failed), or this is a dev build without a
    /// bundled service — re-probe rather than claim we can install.
    case checkAgain
}

/// Copy + derivation for the app window. Pure so the strings are a contract
/// and the state machine is directly testable.
public enum DashboardWindowState {
    public static let windowTitle = "ModelDeck"

    /// The empty state's single line. Names the cause (the background
    /// service) rather than the symptom, because the action fixes the cause.
    public static let daemonDownMessage =
        "ModelDeck's background service isn't running, so there's nothing to show yet."

    /// Titles reuse the deck's existing wording verbatim — the same button
    /// must never have two names across surfaces.
    public static let installActionTitle = "Install Background Service"
    public static let checkAgainActionTitle = "Check Again"

    public static func actionTitle(for action: DashboardStartAction) -> String {
        switch action {
        case .installService: return installActionTitle
        case .checkAgain: return checkAgainActionTitle
        }
    }

    /// Which action honestly applies. Install is offered ONLY when the deck
    /// knows there is a bundled service that hasn't been installed yet;
    /// every other down state re-probes.
    public static func startAction(
        setupPhase: DaemonSetupModel.Phase,
        bundledServiceAvailable: Bool
    ) -> DashboardStartAction {
        guard bundledServiceAvailable else { return .checkAgain }
        switch setupPhase {
        case .consentNeeded, .declined:
            return .installService
        case .idle, .checking, .quiet, .installing, .awaitingApproval,
             .startingUp, .legacyNotRunning, .failed:
            return .checkAgain
        }
    }

    public static func daemonDown(
        setupPhase: DaemonSetupModel.Phase,
        bundledServiceAvailable: Bool
    ) -> DashboardDaemonDownState {
        let action = startAction(
            setupPhase: setupPhase,
            bundledServiceAvailable: bundledServiceAvailable
        )
        return DashboardDaemonDownState(
            message: daemonDownMessage,
            actionTitle: actionTitle(for: action),
            action: action
        )
    }

    /// The window is live exactly when the deck's own connection status says
    /// the daemon answered. `.unknown` (before the first read) is NOT live:
    /// pointing a web view at a port nobody has confirmed produces WebKit's
    /// error page, which is the opposite of an honest empty state.
    public static func phase(
        connection: MenuBarStatusModel.ConnectionStatus,
        dashboardURL: URL,
        setupPhase: DaemonSetupModel.Phase,
        bundledServiceAvailable: Bool
    ) -> DashboardWindowPhase {
        switch connection {
        // Issue #660: a slow daemon is still serving; the dashboard stays up.
        case .connected, .busy:
            return .live(dashboardURL)
        case .unknown, .unreachable:
            return .daemonDown(
                daemonDown(
                    setupPhase: setupPhase,
                    bundledServiceAvailable: bundledServiceAvailable
                )
            )
        }
    }

    /// WKWebView reports an HTTP error status as a SUCCESSFUL navigation —
    /// didFail never fires — so a daemon answering 404 (the analytics flag
    /// turned off with the window open) would render the raw error body.
    /// The web view's response policy routes non-2xx to the same load-failure
    /// fallback as a connection error.
    public static func responseStatusAllows(_ statusCode: Int) -> Bool {
        (200..<300).contains(statusCode)
    }
}

/// The window's view model. Holds the loopback URL for the window's whole
/// life (the daemon's port doesn't move under a running app) and republishes
/// the phase as the deck's daemon health changes, so a window opened with the
/// daemon down recovers live the moment the daemon answers.
@MainActor
public final class DashboardWindowModel: ObservableObject {
    public let dashboardURL: URL

    @Published public private(set) var phase: DashboardWindowPhase

    /// Bumped every time the window (re)enters `.live`. The web view loads
    /// on a change, so recovery after a daemon restart reloads the page
    /// instead of leaving WebKit's stale failure showing.
    @Published public private(set) var loadGeneration = 0

    /// Issue #424: where the window is pointed. The web view loads
    /// `dashboardURL` with THIS route on its fragment; the bundle parses it
    /// and lands there. Swift never navigates past setting this value.
    @Published public private(set) var route: DashboardRoute

    /// Wired by the app to the daemon setup model's own install/retry.
    public var onStart: ((DashboardStartAction) -> Void)?

    /// Fires whenever the reader's position changes — either because a jump
    /// point pointed the window somewhere or because the bundle reported a
    /// navigation back. The app persists it so a relaunch restores it.
    public var onRouteChanged: ((DashboardRoute) -> Void)?

    /// The last resolved empty state, so a load failure can fall back to it
    /// without re-deriving from inputs it doesn't have.
    private var lastDaemonDown: DashboardDaemonDownState

    public init(dashboardURL: URL, route: DashboardRoute = .overview) {
        self.dashboardURL = dashboardURL
        self.route = route.isCoherent ? route : .overview
        let down = DashboardWindowState.daemonDown(
            setupPhase: .idle,
            bundledServiceAvailable: false
        )
        self.lastDaemonDown = down
        self.phase = .daemonDown(down)
    }

    /// The URL for the current route — the daemon's own `/dashboard` with the
    /// route on the fragment, and nothing else added.
    public var routedURL: URL {
        DashboardRouteCodec.url(base: dashboardURL, route: route)
    }

    /// A jump point asking for a position (#402(b)). Re-invoking the menu-bar
    /// entry for the SAME route only fronts the window — the reader is
    /// already looking at it, and a reload would throw away where he had
    /// scrolled to. A different route reloads at the new fragment, which is
    /// how the bundle's parser gets to run again: there is no second
    /// navigator to poke.
    public func open(_ next: DashboardRoute) {
        let wanted = next.isCoherent ? next : .overview
        guard wanted != route else { return }
        route = wanted
        onRouteChanged?(wanted)
        guard case .live = phase else { return }
        phase = .live(routedURL)
        loadGeneration += 1
    }

    /// The bundle reporting where the reader navigated to (dashboard/src/
    /// route.js `reportRoute`). Advisory and one-way: it records the position
    /// WITHOUT reloading, because the page is already showing it. Untrusted
    /// in exactly the same sense as the fragment — an undecodable or
    /// incoherent payload is ignored rather than stored.
    public func noteReportedRoute(json: String) {
        guard let reported = DashboardRouteCodec.route(fromJSON: json) else { return }
        guard reported != route else { return }
        route = reported
        onRouteChanged?(reported)
    }

    /// Apply the deck's current daemon health. Idempotent: re-applying the
    /// same inputs never bumps `loadGeneration`, so a 5-minute refresh
    /// cadence can't reload the page under the user.
    public func apply(
        connection: MenuBarStatusModel.ConnectionStatus,
        setupPhase: DaemonSetupModel.Phase,
        bundledServiceAvailable: Bool
    ) {
        let next = DashboardWindowState.phase(
            connection: connection,
            dashboardURL: routedURL,
            setupPhase: setupPhase,
            bundledServiceAvailable: bundledServiceAvailable
        )
        if case .daemonDown(let down) = next {
            lastDaemonDown = down
        }
        set(next)
    }

    /// The web view could not load the page even though the deck believed
    /// the daemon was up (it died between refreshes). Show the empty state
    /// rather than WebKit's error page.
    public func noteLoadFailure() {
        set(.daemonDown(lastDaemonDown))
    }

    /// The empty state's button.
    public func start() {
        guard case .daemonDown(let down) = phase else { return }
        onStart?(down.action)
    }

    private func set(_ next: DashboardWindowPhase) {
        guard next != phase else { return }
        let wasLive: Bool
        if case .live = phase { wasLive = true } else { wasLive = false }
        phase = next
        if case .live = next, !wasLive {
            loadGeneration += 1
        }
    }
}

/// Issue #423, #402(c): ONE window. The single operation the rule needs —
/// the app target's `NSWindow` satisfies it.
@MainActor
public protocol DashboardHostingWindow: AnyObject {
    /// Order front AND activate: under the accessory activation policy a
    /// bare `orderFront` can land behind the frontmost app (the #45 lesson).
    func bringToFront()
}

/// The one-window rule, Core-side so it is unit-tested: the first request
/// builds the window, every later one fronts the window that already exists.
@MainActor
public final class DashboardWindowPresenter {
    public enum Outcome: Equatable, Sendable {
        case created
        case focusedExisting
    }

    private var window: DashboardHostingWindow?

    public init() {}

    public var hasWindow: Bool { window != nil }

    /// Re-invoking the menu-bar entry must focus the existing window, never
    /// open a second one. `make` is called at most once per window life.
    @discardableResult
    public func present(make: () -> DashboardHostingWindow) -> Outcome {
        if let window {
            window.bringToFront()
            return .focusedExisting
        }
        let created = make()
        window = created
        created.bringToFront()
        return .created
    }

    /// The window closed (red button or programmatic) — the next request
    /// builds a fresh one.
    public func windowDidClose() {
        window = nil
    }
}
