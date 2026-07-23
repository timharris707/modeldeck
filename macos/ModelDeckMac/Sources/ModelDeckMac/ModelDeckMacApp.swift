import SwiftUI
import ModelDeckMacCore

@main
struct ModelDeckMacApp: App {
    @StateObject private var statusModel: MenuBarStatusModel
    @StateObject private var deckModel: DeckPopoverModel
    @StateObject private var settingsSync: SettingsSyncModel
    @StateObject private var accountsModel: AccountsSettingsModel
    @StateObject private var toolsModel: ToolsStatusModel
    @StateObject private var addAccountModel: AddAccountModel
    @StateObject private var signInModel: AccountSignInModel
    @StateObject private var toolUpdateModel: ToolUpdateModel
    @StateObject private var appUpdateModel: AppUpdateModel
    @StateObject private var appUpdateAutoChecker: AppUpdateAutoChecker
    /// Issue #121: in-app install state ("Update Now" + the automatic-install
    /// toggle). The Sparkle driver only exists in fully configured bundles.
    @StateObject private var appUpdateInstallModel: AppUpdateInstallModel
    /// Keeps the SPUUpdater alive for the app's lifetime (the install model
    /// holds it weakly on purpose — the seam must never own Sparkle).
    private let sparkleDriver: SparkleUpdateDriver?
    @StateObject private var notifications: UsageNotificationCoordinator
    /// Issue #96: bundled-daemon lifecycle — first-run consent, SMAppService
    /// registration, Keychain token, drift re-register, legacy takeover.
    @StateObject private var daemonSetupModel: DaemonSetupModel
    /// Launch-at-login state shared by the popover gear menu and the General
    /// settings pane. The SMAppService.status XPC read happens once in the
    /// model's load() (fired from a view .task) — NEVER in a view-struct
    /// initializer, which this App body re-runs on every evaluation (the
    /// hot stack behind the #68 re-render cost).
    @StateObject private var launchAtLoginModel = LaunchAtLoginModel()
    /// Issue #59: right-click context menu on the menu bar icon (Quit +
    /// Check for App Updates). Class ref held for the app's lifetime;
    /// installed from the label's .task.
    private let contextMenuController: MenuBarContextMenuController

    init() {
        let configuration = DaemonConfiguration.resolved()
        let client = DaemonClient(configuration: configuration)
        // Issue #45: the daemon's /api/capacity/worst is the primary icon
        // evaluator (single source of truth); MenuBarStatusModel falls back
        // to the client-side calc over /api/state when it fails.
        let evaluator = DaemonWorstCapacityEvaluator(provider: client)
        let statusModel = MenuBarStatusModel(
            evaluator: evaluator,
            stateProvider: client,
            // Issue #72: the popover's manual Refresh asks the daemon for a
            // real provider poll so the footer's data age visibly restarts.
            usageRefresher: client
        )
        // Phase 5: the same loopback client powers Activate (POST) and the
        // post-switch verification read; a verified state is pushed straight
        // into the status model so the badge and icon agree immediately.
        let deckModel = DeckPopoverModel(activator: client, stateProvider: client)
        deckModel.onVerifiedState = { [weak statusModel] state in
            statusModel?.apply(deckState: state)
        }

        // Phase 6 (issue #7): daemon-owned settings, Settings window models,
        // and threshold-crossing notifications.
        let settingsSync = SettingsSyncModel(sync: client)
        let accountsModel = AccountsSettingsModel(editor: client, stateProvider: client)
        let toolsModel = ToolsStatusModel(prober: client)
        // Phase 7 (issue #8): the 3-step add-account flow. The daemon creates
        // the isolated profile home; the provider's own login runs in
        // Terminal; the daemon reads back the identity.
        // Issue #99: both sign-in flows carry the activator seam — on Claude
        // Code >= 2.1.216 the daemon's login spec is activation-driven
        // (activate target → plain login → verify → restore prior active).
        let addAccountModel = AddAccountModel(
            onboarding: client,
            launcher: TerminalLoginLauncher(),
            stateProvider: client,
            activator: client
        )
        // Issue #32: per-account "Sign in again" (same Terminal launcher as
        // add-account — the provider's login stays alive through the browser
        // OAuth callback) and the CLI update pill.
        let signInModel = AccountSignInModel(
            reauth: client,
            launcher: TerminalLoginLauncher(),
            stateProvider: client,
            activator: client
        )
        let toolUpdateModel = ToolUpdateModel(updater: client)
        // Issue #33: the app's own update check against the PUBLIC repo's
        // GitHub releases feed. Strictly separate from CLI updates; no
        // self-replacing installer (that's issue #16's signed DMG work).
        let appUpdateModel = AppUpdateModel(checker: GitHubReleaseChecker())
        // Issue #121 (Tim directive 2026-07-22): Sparkle 2 one-click install.
        // The driver exists only when the bundle carries SUFeedURL +
        // SUPublicEDKey (release-dmg.sh stamps the key) — dev builds and
        // pre-Sparkle installs keep the honest "View Release" hand-off.
        let appUpdateInstallModel = AppUpdateInstallModel()
        let sparkleDriver = SparkleUpdateDriver.makeIfConfigured(installModel: appUpdateInstallModel)
        if let sparkleDriver {
            appUpdateInstallModel.attach(driver: sparkleDriver)
            appUpdateModel.canInstallUpdates = true
        }
        // Issue #60: optional daily check of the same releases feed — still
        // the scheduling brain. With Sparkle attached it hands a found
        // update to the install model (quiet install when the automatic
        // toggle allows); without, it stays notify-only.
        let appUpdateAutoChecker = AppUpdateAutoChecker(
            model: appUpdateModel,
            installModel: appUpdateInstallModel
        ) { notification in
            await AppUpdateNotificationPoster().post(notification)
        }
        let notifications = UsageNotificationCoordinator(poster: UserNotificationCenterPoster())
        // Issue #96: all seams live (SMAppService agent, Keychain, launchctl,
        // /api/health probe); in dev builds without a bundled daemon manifest
        // the whole surface stays quiet.
        let daemonSetupModel = DaemonSetupModel(dependencies: .live(client: client))
        // Issue #59: the status-item context menu shares the same update
        // model as the gear menu and Settings — one check state everywhere.
        contextMenuController = MenuBarContextMenuController(
            appUpdateModel: appUpdateModel,
            installModel: appUpdateInstallModel
        )

        // Every daemon-confirmed settings document applies live to the
        // running models: popover layout/sort, severity thresholds
        // (bars + icon + banners), and the auto-refresh schedule.
        settingsSync.onApply = { [weak statusModel, weak deckModel, weak notifications] settings in
            // Issue #58: applying a daemon-confirmed document is a
            // programmatic state change, not a user gesture — animations
            // stay off so the popover controls (sort segments, layout)
            // never flash during the cold-launch settings load.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                // adopt(...) applies WITHOUT firing onSelectionChange — a
                // daemon-confirmed document must never echo back to the
                // daemon. (Assigning the properties here used to do exactly
                // that: layout's didSet fired mid-apply with the stale
                // sortOrder captured and pushed it back, seeding the
                // settings ping-pong behind the idle re-render loop.)
                deckModel?.adopt(
                    confirmedLayout: settings.deckLayout,
                    // Provider grouping (issue #30) is popover-local — the
                    // daemon never stores it, so a daemon-confirmed document
                    // must not snap the user out of it.
                    confirmedSortOrder: deckModel?.sortOrder == .provider
                        ? nil
                        : settings.deckSortOrder
                )
                deckModel?.thresholds = settings.usageThresholds
                statusModel?.thresholds = settings.usageThresholds
                // Pinned menu-bar account (nil = lowest across accounts) —
                // display-only; notifications keep watching every account.
                // The deck model mirrors the raw setting for the cards'
                // right-click pin menus.
                statusModel?.pinnedAccountId = settings.menuBarPinnedAccountId
                deckModel?.menuBarPinnedSetting = settings.menuBarAccountId
                notifications?.thresholds = settings.usageThresholds
            }
            statusModel?.startAutoRefresh(interval: settings.effectiveAutoRefreshInterval)
        }
        // A card's right-click pin goes through the same daemon-backed
        // setting as the Settings picker; the confirmed document then flows
        // back through onApply above (icon + mirror update together).
        deckModel.onPinMenuBarAccount = { [weak settingsSync] value in
            Task { @MainActor [weak settingsSync] in
                await settingsSync?.setMenuBarAccount(id: value)
            }
        }
        // Popover-side layout/sort changes sync back to the daemon; the
        // per-field no-op guards in the sync model break the echo loop.
        deckModel.onSelectionChange = { [weak settingsSync] layout, sort in
            Task { @MainActor [weak settingsSync] in
                await settingsSync?.setLayout(layout)
                await settingsSync?.setDefaultSort(sort)
            }
        }
        // Every fresh daemon state feeds the notification transition check.
        statusModel.onStateUpdate = { [weak notifications, weak statusModel, weak deckModel] worst, state in
            Task { @MainActor [weak notifications] in
                await notifications?.evaluate(worst: worst, state: state)
            }
            // Issue #113 (CodeRabbit): SwiftUI never resets a popover's
            // isPresented binding when its anchor leaves the hierarchy, so
            // every fresh state reconciles the presented-warning slot —
            // a warning whose affordance just cleared (stale account
            // refreshed, keychain granted, cadence cap lifted) is dismissed
            // at the model, and the one-at-a-time slot can never desync.
            if let statusModel, let deckModel, let state {
                deckModel.reconcileWarnings(
                    rows: deckModel.interleavedRows(for: state),
                    staleness: { statusModel.cardStaleness(for: $0) },
                    cadenceNoticeVisible: statusModel.refreshCadenceNotice != nil
                )
            }
        }
        // Account edits/removals verified against a fresh /api/state land in
        // the status model immediately.
        accountsModel.onStateChanged = { [weak statusModel] state in
            statusModel?.apply(deckState: state)
        }
        // A finished (or cancelled-with-remove) add-account flow lands in the
        // deck immediately, same as edits.
        addAccountModel.onStateChanged = { [weak statusModel] state in
            statusModel?.apply(deckState: state)
        }
        // A verified re-sign-in refreshes both the roster chips (fresh
        // /api/state with per-account authState) and the General pane's
        // cached CLI probe. Cached reads only — no forced provider probes.
        signInModel.onStateChanged = { [weak statusModel] state in
            statusModel?.apply(deckState: state)
        }
        // Issue #118: the deck's sign-in-needed notice offers a one-click
        // "Sign in again…" that must run the SAME flow as the roster chip.
        // Resolve the requested id against the freshest state (no-op when
        // the account vanished between click and dispatch), then hand the
        // account to the existing beginSignIn — activation-driven on
        // Claude ≥ 2.1.216 (#99/#106), never any new credential machinery.
        deckModel.onSignInAgain = { [weak statusModel, weak signInModel] accountID in
            guard let account = DeckPopoverModel.signInAgainTarget(
                accountID: accountID,
                state: statusModel?.deckState
            ) else { return }
            Task { @MainActor [weak signInModel] in
                await signInModel?.beginSignIn(account: account)
            }
        }
        // Issue #152: the duplicate-login warning's "Re-log in" button runs
        // the SAME flow — resolve the id against fresh state (no-op when the
        // flag cleared or the account vanished), then the existing
        // beginSignIn launches the provider's own profile-scoped login
        // (CODEX_HOME=<profileRef> codex login / the Claude equivalent) in
        // Terminal for the user to complete. Never touches tokens or
        // running sessions; nothing automatic.
        deckModel.onDuplicateRelogin = { [weak statusModel, weak signInModel] accountID in
            guard let account = DeckPopoverModel.duplicateReloginTarget(
                accountID: accountID,
                state: statusModel?.deckState
            ) else { return }
            Task { @MainActor [weak signInModel] in
                await signInModel?.beginSignIn(account: account)
            }
        }
        signInModel.onSignedIn = { [weak toolsModel] in
            Task { @MainActor [weak toolsModel] in
                await toolsModel?.load(refresh: false)
            }
        }
        // A finished CLI update re-reads the daemon's probe cache (the
        // daemon refreshed it after installing) so the version line agrees.
        toolUpdateModel.onFinished = { [weak toolsModel] in
            Task { @MainActor [weak toolsModel] in
                await toolsModel?.load(refresh: false)
            }
        }

        _statusModel = StateObject(wrappedValue: statusModel)
        _deckModel = StateObject(wrappedValue: deckModel)
        _settingsSync = StateObject(wrappedValue: settingsSync)
        _accountsModel = StateObject(wrappedValue: accountsModel)
        _toolsModel = StateObject(wrappedValue: toolsModel)
        _addAccountModel = StateObject(wrappedValue: addAccountModel)
        _signInModel = StateObject(wrappedValue: signInModel)
        _toolUpdateModel = StateObject(wrappedValue: toolUpdateModel)
        _appUpdateModel = StateObject(wrappedValue: appUpdateModel)
        _appUpdateAutoChecker = StateObject(wrappedValue: appUpdateAutoChecker)
        _appUpdateInstallModel = StateObject(wrappedValue: appUpdateInstallModel)
        self.sparkleDriver = sparkleDriver
        _notifications = StateObject(wrappedValue: notifications)
        _daemonSetupModel = StateObject(wrappedValue: daemonSetupModel)
    }

    /// Issue #45 reopen diagnostics: log every status-bar window's frame and
    /// its hosted view hierarchy sizes so the label-vs-status-item width can
    /// be compared without seeing the menu bar.
    @MainActor
    private static func dumpStatusWindows(tag: String) {
        for window in NSApp.windows {
            let className = String(describing: type(of: window))
            guard className.contains("StatusBar") else { continue }
            IconDebugLog.log("[\(tag)] window \(className) frame=\(window.frame)")
            if let content = window.contentView {
                dumpViewTree(content, indent: "  ", tag: tag)
            }
        }
    }

    @MainActor
    private static func dumpViewTree(_ view: NSView, indent: String, tag: String) {
        IconDebugLog.log("[\(tag)]\(indent)\(String(describing: type(of: view))) frame=\(view.frame) fitting=\(view.fittingSize)")
        if let button = view as? NSStatusBarButton {
            let image = button.image
            IconDebugLog.log("[\(tag)]\(indent)  button.image=\(image.map { "size=\($0.size) template=\($0.isTemplate) desc=\(String(describing: $0.accessibilityDescription))" } ?? "nil") title=\(button.title)")
        }
        for sub in view.subviews {
            dumpViewTree(sub, indent: indent + "  ", tag: tag)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            DeckPopoverView(
                statusModel: statusModel,
                deckModel: deckModel,
                appUpdateModel: appUpdateModel,
                appUpdateInstallModel: appUpdateInstallModel,
                setupModel: daemonSetupModel,
                launchAtLoginModel: launchAtLoginModel
            )
        } label: {
            // Issue #45: the view observes the model ITSELF — passing a
            // value snapshot from this Scene body left the status-item
            // label frozen at its launch-time render (.plain) because
            // MenuBarExtra label invalidation doesn't reliably reach
            // value-type dependencies captured up here.
            MenuBarIconView(statusModel: statusModel)
                .task {
                    IconDebugLog.log("label .task fired; starting initial refresh")
                    contextMenuController.install()
                    // Issue #96: evaluate the bundled-service state before
                    // the first refresh so a true first run shows the
                    // consent card, not a bare "daemon unreachable".
                    await daemonSetupModel.evaluateOnLaunch()
                    // Issue #60: honors the stored preference; no-op when
                    // automatic checks are off.
                    appUpdateAutoChecker.start()
                    if IconDebugLog.enabled {
                        Self.dumpStatusWindows(tag: "pre-refresh")
                    }
                    await statusModel.refresh()
                    if IconDebugLog.enabled {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        Self.dumpStatusWindows(tag: "post-refresh+2s")
                    }
                    // Daemon settings are the source of truth; a successful
                    // load applies them (including the refresh schedule). If
                    // the daemon is unreachable, fall back to the spec
                    // default cadence until it comes back.
                    await settingsSync.load()
                    if !settingsSync.isLoaded {
                        statusModel.startAutoRefresh(
                            interval: DaemonSettings.defaults.effectiveAutoRefreshInterval
                        )
                    }
                }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsWindowView(
                statusModel: statusModel,
                settingsSync: settingsSync,
                accountsModel: accountsModel,
                toolsModel: toolsModel,
                addAccountModel: addAccountModel,
                deckModel: deckModel,
                signInModel: signInModel,
                updateModel: toolUpdateModel,
                appUpdateModel: appUpdateModel,
                appUpdateAutoChecker: appUpdateAutoChecker,
                appUpdateInstallModel: appUpdateInstallModel,
                daemonSetupModel: daemonSetupModel,
                launchAtLoginModel: launchAtLoginModel
            )
        }
    }
}
