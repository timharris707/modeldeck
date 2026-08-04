import Combine
import Foundation

// Issue #241 — always-on installs never saw updates. With "Install updates
// automatically" ON (the default), the background path downloads and stages
// silently, installing on the next relaunch (#121/#163 design). ModelDeck is
// an always-running menu-bar app — there IS no next relaunch — so on the
// product's most loyal installs updates staged invisibly forever and the
// user experienced "auto-update doesn't exist" (Tim's live install:
// lastNotifiedVersion frozen five releases back).
//
// This model turns the silent stage into an OFFER: the moment a background
// update reaches `.installedPendingRelaunch`, it prompts once — deck banner
// plus a user notification, "ModelDeck <version> is ready" — with a
// one-click Restart that drives the EXISTING #163 explicit
// quit→install→relaunch machinery (`AppUpdateInstallModel.updateNow()`).
// No new install plumbing, and never a forced restart: dismissing the
// prompt degrades to a passive badge on the deck header, so a staged
// update can be ignored but never invisible.
//
// Layering: core-owned and Sparkle-free (#121 confinement). The model
// observes the shared install model's phase — the single funnel every
// Sparkle callback already reports through — so no driver change is needed.
@MainActor
public final class AppUpdateStagedPromptModel: ObservableObject {
    /// Once-per-staged-version memory for the PROMPT (banner +
    /// notification). Deliberately a separate key from the auto-checker's
    /// `lastNotifiedVersion` (which gates the "an update exists"
    /// availability banner): availability and readiness are different
    /// events with different copy, and #241's field data showed the
    /// availability key going stale exactly when staging took over.
    nonisolated public static let lastPromptedDefaultsKey =
        "modeldeck.appupdate.lastStagedPromptVersion"

    /// The prompt's presentation state.
    public enum State: Equatable, Sendable {
        /// Nothing staged (or a restart/install is in flight).
        case hidden
        /// The proactive prompt is up: deck banner with Restart + dismiss.
        case prompting(version: String)
        /// Dismissed (or already prompted for this version earlier): the
        /// passive deck badge — staged-invisible must be impossible.
        case badged(version: String)
    }

    @Published public private(set) var state: State = .hidden

    private let installModel: AppUpdateInstallModel
    private let defaults: UserDefaults
    /// Posts the "ready — restart to finish" user notification. Fired at
    /// most once per staged version, on the transition into `.prompting`.
    private let notify: @MainActor (AppUpdateNotification) -> Void
    private var phaseObservation: AnyCancellable?

    public init(
        installModel: AppUpdateInstallModel,
        defaults: UserDefaults = .standard,
        notify: @escaping @MainActor (AppUpdateNotification) -> Void
    ) {
        self.installModel = installModel
        self.defaults = defaults
        self.notify = notify
        // $phase replays the current value on subscribe, so an update that
        // staged before this model existed is picked up immediately.
        phaseObservation = installModel.$phase.sink { [weak self] phase in
            self?.reconcile(phase: phase)
        }
    }

    /// The single transition function; also directly callable by tests.
    /// Any non-staged phase hides the prompt: `.checking`/`.installing`/
    /// `.relaunching` mean a restart or new session is in flight, and a
    /// later `.installedPendingRelaunch` report (background checks re-find
    /// a staged update on every pass) restores the badge without
    /// re-prompting — the once-per-version memory below is what makes the
    /// 4-hourly cadence nag-free.
    public func reconcile(phase: AppUpdateInstallPhase) {
        guard case .installedPendingRelaunch(let version) = phase else {
            if state != .hidden { state = .hidden }
            return
        }
        noteStaged(version: version)
    }

    private func noteStaged(version: String) {
        switch state {
        case .prompting(let current) where current == version,
             .badged(let current) where current == version:
            // The same staged version re-reported (background re-check,
            // dialog dismissal cleanup) — whatever the user chose stands.
            return
        case .hidden, .prompting, .badged:
            break
        }
        guard defaults.string(forKey: Self.lastPromptedDefaultsKey) != version else {
            // Already prompted for this version (earlier this session or a
            // previous one) — badge only, never a second prompt.
            state = .badged(version: version)
            return
        }
        defaults.set(version, forKey: Self.lastPromptedDefaultsKey)
        state = .prompting(version: version)
        notify(Self.notification(version: version))
    }

    /// The banner's dismiss affordance: prompt → passive badge. The staged
    /// update stays offered (badge + its explanation popover), just quiet.
    public func dismissPrompt() {
        guard case .prompting(let version) = state else { return }
        state = .badged(version: version)
    }

    /// The one-click Restart (banner button and badge-popover primary
    /// action): hands off to the EXISTING #163 explicit path —
    /// `updateNow()` runs a user-initiated Sparkle session over the
    /// already-staged update, which `AppUpdateRelaunchPolicy` resolves to
    /// install-and-relaunch-now, force-terminating if Sparkle's quit event
    /// is ignored. Always the user's click, never automatic.
    public func restartNow() {
        guard state != .hidden else { return }
        installModel.updateNow()
    }

    /// Whether the passive deck badge renders (the view's `if` condition;
    /// also the liveness input for the #113 warning-slot reconcile).
    public var isBadgeVisible: Bool {
        if case .badged = state { return true }
        return false
    }

    /// The staged version while the prompt or badge shows; nil when hidden.
    public var stagedVersion: String? {
        switch state {
        case .hidden: return nil
        case .prompting(let version), .badged(let version): return version
        }
    }

    // MARK: Copy (single source for banner, notification, and badge popover)

    /// The user-notification announcing readiness. Notifications aren't
    /// click-actionable in this app (no UNUserNotificationCenter delegate),
    /// so the body points at the deck's Restart — and names the always-true
    /// fallback (quit and reopen) for users who never open the deck.
    nonisolated public static func notification(version: String) -> AppUpdateNotification {
        AppUpdateNotification(
            title: "ModelDeck \(version) is ready",
            body: "Restart to finish updating — use Restart in the ModelDeck deck, "
                + "or just quit and reopen ModelDeck."
        )
    }

    /// The deck banner's one-liner.
    nonisolated public static func bannerText(version: String) -> String {
        "ModelDeck \(version) is ready — restart to finish updating."
    }

    /// The badge's explanation popover (#113 slot). Body reuses the install
    /// model's existing pending-relaunch status line verbatim (the
    /// no-diverging-copy contract), then states the offer.
    nonisolated public static func badgeExplanation(version: String) -> DeckWarningExplanation {
        let staged = AppUpdateInstallModel.statusText(
            for: .installedPendingRelaunch(version: version)
        ) ?? "v\(version) is downloaded and installs the next time ModelDeck relaunches."
        return DeckWarningExplanation(
            title: "Update ready",
            body: staged + "\n\nRestart now to finish, or keep working — "
                + "nothing restarts until you choose to."
        )
    }
}
