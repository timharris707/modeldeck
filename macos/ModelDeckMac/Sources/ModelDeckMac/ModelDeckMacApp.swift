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
    @StateObject private var notifications: UsageNotificationCoordinator

    init() {
        let configuration = DaemonConfiguration.resolved()
        let client = DaemonClient(configuration: configuration)
        // Issue #45: the daemon's /api/capacity/worst is the primary icon
        // evaluator (single source of truth); MenuBarStatusModel falls back
        // to the client-side calc over /api/state when it fails.
        let evaluator = DaemonWorstCapacityEvaluator(provider: client)
        let statusModel = MenuBarStatusModel(
            evaluator: evaluator,
            stateProvider: client
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
        let addAccountModel = AddAccountModel(
            onboarding: client,
            launcher: TerminalLoginLauncher(),
            stateProvider: client
        )
        // Issue #32: per-account "Sign in again" (same Terminal launcher as
        // add-account — the provider's login stays alive through the browser
        // OAuth callback) and the CLI update pill.
        let signInModel = AccountSignInModel(
            reauth: client,
            launcher: TerminalLoginLauncher(),
            stateProvider: client
        )
        let toolUpdateModel = ToolUpdateModel(updater: client)
        // Issue #33: the app's own update check against the PUBLIC repo's
        // GitHub releases feed. Strictly separate from CLI updates; no
        // self-replacing installer (that's issue #16's signed DMG work).
        let appUpdateModel = AppUpdateModel(checker: GitHubReleaseChecker())
        let notifications = UsageNotificationCoordinator(poster: UserNotificationCenterPoster())

        // Every daemon-confirmed settings document applies live to the
        // running models: popover layout/sort, severity thresholds
        // (bars + icon + banners), and the auto-refresh schedule.
        settingsSync.onApply = { [weak statusModel, weak deckModel, weak notifications] settings in
            deckModel?.layout = settings.deckLayout
            // Provider grouping (issue #30) is popover-local — the daemon
            // never stores it, so a daemon-confirmed document must not snap
            // the user out of it.
            if deckModel?.sortOrder != .provider {
                deckModel?.sortOrder = settings.deckSortOrder
            }
            deckModel?.thresholds = settings.usageThresholds
            statusModel?.thresholds = settings.usageThresholds
            notifications?.thresholds = settings.usageThresholds
            statusModel?.startAutoRefresh(interval: settings.effectiveAutoRefreshInterval)
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
        statusModel.onStateUpdate = { [weak notifications] worst, state in
            Task { @MainActor [weak notifications] in
                await notifications?.evaluate(worst: worst, state: state)
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
        _notifications = StateObject(wrappedValue: notifications)
    }

    var body: some Scene {
        MenuBarExtra {
            DeckPopoverView(
                statusModel: statusModel,
                deckModel: deckModel,
                appUpdateModel: appUpdateModel
            )
        } label: {
            // Issue #45: the view observes the model ITSELF — passing a
            // value snapshot from this Scene body left the status-item
            // label frozen at its launch-time render (.plain) because
            // MenuBarExtra label invalidation doesn't reliably reach
            // value-type dependencies captured up here.
            MenuBarIconView(statusModel: statusModel)
                .task {
                    await statusModel.refresh()
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
                appUpdateModel: appUpdateModel
            )
        }
    }
}
