import AppKit
import SwiftUI
import ModelDeckMacCore

/// Issue #7 — the standard macOS Settings window (spec "Settings window"):
/// two panes, Accounts and General. Every edit PUTs to the daemon and applies
/// live to the running popover/menu bar models via the settings sync.
struct SettingsWindowView: View {
    @ObservedObject var statusModel: MenuBarStatusModel
    @ObservedObject var settingsSync: SettingsSyncModel
    @ObservedObject var accountsModel: AccountsSettingsModel
    @ObservedObject var toolsModel: ToolsStatusModel
    @ObservedObject var addAccountModel: AddAccountModel
    /// Activation surface (spec amendment 2026-07-19): the deck model's
    /// existing activate machinery — optimistic flip, verify, revert — now
    /// driven from Settings → Accounts instead of the popover.
    @ObservedObject var deckModel: DeckPopoverModel
    /// Issue #32: per-account "Sign in again" flow and the CLI update pill.
    @ObservedObject var signInModel: AccountSignInModel
    /// Issue #176: per-account "Renew now" flow for expired-idle Claude
    /// accounts (same shared instance the deck popover observes).
    @ObservedObject var renewModel: AccountRenewModel
    /// Issue #279: per-account proxy pool membership + session routing.
    @ObservedObject var proxyPoolModel: ProxyPoolModel
    /// Issue #396: the in-app fix for an expired pool credential.
    @ObservedObject var proxyReloginModel: ProxyReloginModel
    /// Issue #280: the seeded pill's on-demand Verify.
    @ObservedObject var identityVerifyModel: IdentityVerifyModel
    @ObservedObject var updateModel: ToolUpdateModel
    /// Issue #33: the app's own update check — a strictly separate surface
    /// from CLI updates (never a shared control or wording).
    @ObservedObject var appUpdateModel: AppUpdateModel
    @ObservedObject var appRollbackModel: AppRollbackModel
    /// Issue #60: the "Check for updates automatically" toggle's model.
    @ObservedObject var appUpdateAutoChecker: AppUpdateAutoChecker
    /// Issue #121: in-app install state + "Install updates automatically".
    @ObservedObject var appUpdateInstallModel: AppUpdateInstallModel
    /// Issue #96: bundled background-service status + legacy takeover.
    @ObservedObject var daemonSetupModel: DaemonSetupModel
    /// Issue #422: the recorded first-launch choice — revisitable here, and
    /// only here. The launch flow never asks twice.
    @ObservedObject var proxyOnboardingModel: ManagedProxyOnboardingModel
    /// False in dev builds with no bundled proxy: the section stays hidden.
    let managedProxyAvailable: Bool
    /// Shared launch-at-login state; the SMAppService status read lives in
    /// the model's load(), not in any view-struct initializer.
    @ObservedObject var launchAtLoginModel: LaunchAtLoginModel
    /// Issue #204: shared user scope (tools & memory across Claude accounts)
    /// — confirmation-gated enable/disable with the disclosed merge outcome.
    @ObservedObject var sharedScopeModel: SharedScopeModel

    var body: some View {
        // Issue #118: the tab selection is model state so the deck's
        // "Sign in again…" action can land the window on Subscriptions even
        // when the user last viewed General.
        TabView(selection: $deckModel.settingsPane) {
            AccountsSettingsPane(
                statusModel: statusModel,
                accountsModel: accountsModel,
                addAccountModel: addAccountModel,
                deckModel: deckModel,
                signInModel: signInModel,
                renewModel: renewModel,
                proxyPoolModel: proxyPoolModel,
                proxyReloginModel: proxyReloginModel,
                identityVerifyModel: identityVerifyModel
            )
            .tabItem { Label("Subscriptions", systemImage: "person.2") }
            .tag(SettingsPane.accounts)

            GeneralSettingsPane(
                settingsSync: settingsSync,
                toolsModel: toolsModel,
                statusModel: statusModel,
                deckModel: deckModel,
                updateModel: updateModel,
                appUpdateModel: appUpdateModel,
                appRollbackModel: appRollbackModel,
                appUpdateAutoChecker: appUpdateAutoChecker,
                appUpdateInstallModel: appUpdateInstallModel,
                daemonSetupModel: daemonSetupModel,
                proxyOnboardingModel: proxyOnboardingModel,
                managedProxyAvailable: managedProxyAvailable,
                launchAtLoginModel: launchAtLoginModel,
                sharedScopeModel: sharedScopeModel
            )
            .tabItem { Label("General", systemImage: "gearshape") }
            .tag(SettingsPane.general)
        }
        .frame(width: 520, height: 520)
        .task {
            // The CLI probe now loads from the General pane itself (issue
            // #33: pane appear fires the debounced forced re-probe).
            if !settingsSync.isLoaded {
                await settingsSync.load()
            }
        }
    }
}

// MARK: - Accounts pane

/// Direction A (accounts-screen redesign, issue #61 thread): per-provider
/// Sections with a trailing radio control for activation. Healthy rows are
/// silent; Edit/Remove live in a context menu + hover ⋯; ALL activation
/// trouble consolidates into one amber banner at the affected provider's
/// section header. The activation machinery itself (optimistic flip,
/// verify-then-revert, new-sessions-only) is untouched.
struct AccountsSettingsPane: View {
    @ObservedObject var statusModel: MenuBarStatusModel
    @ObservedObject var accountsModel: AccountsSettingsModel
    @ObservedObject var addAccountModel: AddAccountModel
    @ObservedObject var deckModel: DeckPopoverModel
    @ObservedObject var signInModel: AccountSignInModel
    /// Issue #176: "Renew now" for expired-idle Claude rows.
    @ObservedObject var renewModel: AccountRenewModel
    /// Issue #279: the quiet per-row proxy line (pool membership + session
    /// routing). Renders nothing at all on a machine without the proxy.
    @ObservedObject var proxyPoolModel: ProxyPoolModel
    /// Issue #396: the in-app fix for an expired pool credential — the
    /// remedy that used to require a hand-run terminal login.
    @ObservedObject var proxyReloginModel: ProxyReloginModel
    /// Issue #280: Verify beside the seeded pill.
    @ObservedObject var identityVerifyModel: IdentityVerifyModel

    @State private var editingAccount: DeckAccount?
    @State private var removalCandidate: DeckAccount?
    @State private var isAddingAccount = false
    /// Issue #279 (Tim: "ask each time rather than make it automatic"):
    /// every proxy action passes through a confirmation naming exactly what
    /// will happen. Nil = no dialog up.
    @State private var proxyConfirmation: ProxyPoolConfirmation?

    private var sections: [AccountsRosterSection] {
        guard let state = statusModel.deckState else { return [] }
        return AccountsRoster.sections(
            state: state,
            guidanceForAccount: { deckModel.blockedActivationGuidance(for: $0) },
            errorForAccount: { deckModel.activationError(for: $0) },
            // Issue #100: keeps a failure visible even when the account it
            // concerns has since left the roster.
            troubleForProvider: { deckModel.activationTrouble(for: $0) },
            warningsForProvider: { deckModel.postActivationWarnings(for: $0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error = accountsModel.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
            }
            let sections = self.sections
            if sections.isEmpty {
                Spacer()
                Text(statusModel.deckState == nil
                    ? "Waiting for the daemon…"
                    : "No subscriptions yet. Click Add Subscription to connect one.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                List {
                    ForEach(sections) { section in
                        Section {
                            if let banner = section.banner {
                                ProviderActivationBannerView(
                                    banner: banner,
                                    isActivationInFlight: deckModel.activatingAccountID != nil,
                                    onRetry: { retry(banner: banner, in: section) }
                                )
                                .listRowSeparator(.hidden)
                            }
                            if let notice = section.notice {
                                PostActivationNoticeView(
                                    notice: notice,
                                    onDismiss: {
                                        deckModel.dismissPostActivationWarnings(for: notice.provider)
                                    }
                                )
                                .listRowSeparator(.hidden)
                            }
                            ForEach(section.accounts) { account in
                                accountRow(account, in: section)
                            }
                        } header: {
                            AccountsSectionHeader(section: section)
                        }
                    }
                }
                .listStyle(.inset)
            }
            Divider()
            HStack {
                // Issue #8 — the 3-step add-account flow (spec "Add account").
                Button("Add Subscription…") { isAddingAccount = true }
                    .disabled(statusModel.deckState == nil)
                    .help(statusModel.deckState == nil
                        ? "Waiting for the daemon"
                        : "Create an isolated profile and sign in via the provider's own flow")
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .sheet(isPresented: $isAddingAccount) {
            AddAccountSheet(model: addAccountModel)
        }
        // Issue #226: the deck popover's "Add Subscription…" entry points route
        // here — one-shot consume (the model clears the flag) so a later
        // tab switch or window reopen can never resurrect a request that
        // already presented the sheet. Both hooks are needed: onAppear for
        // a Settings window the request just opened, onChange for a window
        // already sitting on this pane when the deck fires.
        .onAppear {
            if deckModel.consumeAddAccountRequest() { isAddingAccount = true }
        }
        .onChange(of: deckModel.pendingAddAccountRequest) {
            if deckModel.consumeAddAccountRequest() { isAddingAccount = true }
        }
        .sheet(item: $editingAccount) { account in
            AccountEditSheet(account: account, accountsModel: accountsModel)
        }
        .confirmationDialog(
            "Remove \(removalCandidate?.label ?? "subscription")?",
            isPresented: Binding(
                get: { removalCandidate != nil },
                set: { if !$0 { removalCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let account = removalCandidate {
                    Task { await accountsModel.remove(account: account) }
                }
                removalCandidate = nil
            }
            Button("Cancel", role: .cancel) { removalCandidate = nil }
        } message: {
            Text("Removes only ModelDeck's reference to this subscription. Provider credentials and sign-ins are never touched.")
        }
        // Issue #279: EVERY proxy action confirms first (Tim: "ask each
        // time rather than make it automatic"), in one plain sentence. The
        // join's sentence names the browser sign-in explicitly, because a
        // browser window opening is the surprising part.
        .confirmationDialog(
            proxyConfirmation?.title ?? "",
            isPresented: Binding(
                get: { proxyConfirmation != nil },
                set: { if !$0 { proxyConfirmation = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let confirmation = proxyConfirmation {
                Button(confirmation.confirmTitle) {
                    run(confirmation)
                    proxyConfirmation = nil
                }
                Button("Cancel", role: .cancel) { proxyConfirmation = nil }
            }
        } message: {
            Text(proxyConfirmation?.message ?? "")
        }
        .task { await statusModel.refresh() }
    }

    /// Issue #279: the confirmed action, dispatched to the shared model.
    private func run(_ confirmation: ProxyPoolConfirmation) {
        switch confirmation.action {
        case .join:
            proxyPoolModel.beginJoin(account: confirmation.account)
        case .route:
            Task { await proxyPoolModel.setRouting(account: confirmation.account, enabled: true) }
        case .unroute:
            Task { await proxyPoolModel.setRouting(account: confirmation.account, enabled: false) }
        case .fixSignIn:
            proxyReloginModel.begin(account: confirmation.account)
        }
    }

    @ViewBuilder
    private func accountRow(_ account: DeckAccount, in section: AccountsRosterSection) -> some View {
        let state = statusModel.deckState
        let activationState = state?.activationState(for: section.provider) ?? .unknown
        AccountRosterRow(
            account: account,
            showActivation: state?.isManaged(section.provider) == true,
            isBusy: accountsModel.busyAccountID == account.id,
            canEdit: AccountsSettingsModel.canEdit(account),
            isActivating: deckModel.activatingAccountID == account.id,
            isActivationInFlight: deckModel.activatingAccountID != nil,
            activationState: activationState,
            isRadioPending: state.map { AccountsRoster.radioIsPending(account: account, state: $0) } ?? false,
            signInPhase: signInModel.phase(for: account.id),
            signInError: signInModel.error(for: account.id),
            // The radio drives activation for non-selected rows; the
            // selected row keeps issue #61's Complete Activation button when
            // its activation is link-pending. Both run the SAME unchanged
            // machinery (optimistic flip → POST → verify-or-revert).
            onActivate: deckModel.canActivate && state?.isManaged(section.provider) == true
                && (!account.isDefault || activationState.needsLinkCompletion)
                ? { Task { await deckModel.activate(activationRow(for: account)) } }
                : nil,
            onSignIn: { Task { await signInModel.beginSignIn(account: account) } },
            onVerifySignIn: { Task { await signInModel.confirmSignedIn(account: account) } },
            onRelaunchSignIn: { signInModel.relaunch(accountID: account.id) },
            onCancelSignIn: { signInModel.cancel(accountID: account.id) },
            // Issue #176: present only when the daemon reported the renew
            // capability on an expired-idle Claude row; nil renders nothing.
            renew: renewModel.presentation(for: account),
            onRenewNow: { Task { await renewModel.renew(account: account) } },
            onDismissRenewOutcome: { renewModel.dismissOutcome(accountID: account.id) },
            onEdit: { editingAccount = account },
            onRemove: { removalCandidate = account },
            // Issue #174: present only when the daemon reported the opt-in
            // state (Claude accounts on a statusline-capable daemon).
            statuslineInstalled: account.claudeStatusline?.installed,
            // Issue #194: the visible capture control's own in-flight state.
            isStatuslineBusy: accountsModel.statuslineBusyAccountID == account.id,
            // CodeRabbit PR #304: while ANY roster mutation is in flight the
            // model rejects further capture clicks, so every row's capture
            // control disables — never an enabled control whose click is
            // silently swallowed (the #100 lesson).
            isRosterMutationInFlight: accountsModel.busyAccountID != nil,
            onSetStatusline: { enabled in
                Task { await accountsModel.setStatuslineCapture(account: account, enabled: enabled) }
            },
            // Issue #279: nil on a machine without the proxy — no line, no
            // menu item, nothing (the #149/#174 discipline). Every action
            // routes through the confirmation, never straight to the daemon.
            proxy: proxyPoolModel.presentation(for: account),
            onProxyJoin: { proxyConfirmation = ProxyPoolConfirmation(account: account, action: .join) },
            onProxyRoute: { proxyConfirmation = ProxyPoolConfirmation(account: account, action: .route) },
            onProxyUnroute: { proxyConfirmation = ProxyPoolConfirmation(account: account, action: .unroute) },
            onProxyCancelJoin: { proxyPoolModel.cancelJoinWait(accountID: account.id) },
            onDismissProxyOutcome: { proxyPoolModel.dismissOutcome(accountID: account.id) },
            // Issue #396: the in-app repair. Nil on a machine without the
            // proxy or on a daemon that does not report it — same discipline.
            // Issue #515: the deck's own routed-failure streak rides along, so
            // a member serving nothing but 401s promotes its repair here even
            // while the recorded credential still reads healthy. The deck
            // banner reads this same derivation.
            relogin: proxyReloginModel.presentation(
                for: account,
                routedFailures: ProxyRelogin.routedFailures(for: account, in: state)
            ),
            onProxyFixSignIn: { proxyConfirmation = ProxyPoolConfirmation(account: account, action: .fixSignIn) },
            onProxyCancelRelogin: { proxyReloginModel.cancel(account: account) },
            onDismissReloginOutcome: { proxyReloginModel.dismissOutcome(accountID: account.id) },
            // Issue #280: nil unless the account is seeded (or an attempt
            // is still unanswered) — the button lives and dies with the pill.
            verify: identityVerifyModel.presentation(for: account),
            onVerifyIdentity: { Task { await identityVerifyModel.verify(account: account) } },
            onDismissVerifyOutcome: { identityVerifyModel.dismissOutcome(accountID: account.id) }
        )
    }

    /// [Retry] on the section banner: re-runs the daemon activate on the
    /// affected account for link-level trouble; for identity trouble (which
    /// another symlink flip can never fix) it re-reads state instead so a
    /// fix made outside the app is picked up.
    private func retry(banner: ProviderActivationBanner, in section: AccountsRosterSection) {
        if banner.retryRunsActivation,
           deckModel.canActivate,
           let account = section.accounts.first(where: { $0.id == banner.affectedAccountID }) {
            Task { await deckModel.activate(activationRow(for: account)) }
        } else {
            Task { await statusModel.refresh() }
        }
    }

    /// Minimal deck row for the activate machinery — activation only needs
    /// the account identity/active flag, not usage windows.
    private func activationRow(for account: DeckAccount) -> DeckAccountRow {
        DeckAccountRow(
            account: account,
            provider: DeckProvider.from(account.provider),
            windows: [],
            isActive: account.isDefault,
            activationState: activationState(for: account)
        )
    }

    /// The verified physical activation state for this account's provider
    /// (issue #55); `.unknown` for unknown providers or a pre-#56 daemon —
    /// which renders exactly like today (full checkmark, no warnings).
    private func activationState(for account: DeckAccount) -> ProviderActivationState {
        guard let provider = DeckProvider.from(account.provider),
              let state = statusModel.deckState
        else { return .unknown }
        return state.activationState(for: provider)
    }
}

/// Issue #279: one pending proxy confirmation — which account, which of the
/// three actions, and the plain sentence Core wrote for it. A value type so
/// the dialog can never drift out of sync with the row it came from.
struct ProxyPoolConfirmation: Identifiable {
    enum Action { case join, route, unroute, fixSignIn }

    let account: DeckAccount
    let action: Action

    var id: String { "\(account.id)-\(action)" }

    var title: String {
        switch action {
        case .join: return "Add \(account.label) to the proxy pool?"
        case .route: return "Route \(account.label) sessions through the proxy?"
        case .unroute: return "Stop routing \(account.label) sessions?"
        case .fixSignIn: return "Fix the proxy sign-in for \(account.label)?"
        }
    }

    var confirmTitle: String {
        switch action {
        case .join: return "Add to Pool"
        case .route: return "Route Sessions"
        case .unroute: return "Stop Routing"
        case .fixSignIn: return "Open Sign-in"
        }
    }

    /// Product copy lives in Core, tested — these are the sentences Tim's
    /// "ask each time" rule makes load-bearing, not view scratch.
    var message: String {
        switch action {
        case .join: return ProxyPool.joinConfirmation(label: account.label)
        case .route: return ProxyPool.routeConfirmation(label: account.label)
        case .unroute: return ProxyPool.unrouteConfirmation(label: account.label)
        case .fixSignIn: return ProxyRelogin.confirmation(label: account.label)
        }
    }
}

/// Direction A section header: provider mark + name + muted account count.
struct AccountsSectionHeader: View {
    let section: AccountsRosterSection

    var body: some View {
        HStack(spacing: 7) {
            ProviderMarkView(provider: section.provider, size: 15)
            Text(section.title)
                .font(.system(size: 11.5, weight: .semibold))
            Text("· \(section.countText)")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Direction A's consolidated amber banner at a provider's section header:
/// one surface for ALL activation trouble (link-pending states, identity
/// states, the daemon's clobber-guard guidance verbatim), with [Retry] and
/// [Why?]. Replaces the old per-row inline alerts and the roster-top
/// ActivationNotice strip.
struct ProviderActivationBannerView: View {
    let banner: ProviderActivationBanner
    var isActivationInFlight: Bool = false
    let onRetry: () -> Void

    @State private var isShowingWhy = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(severityColor(.warning))
            Text(banner.message)
                .font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                // Issue #227: the blocked banner's click-level action. The
                // app can't safely move a directory that may hold another
                // tool's live login, but it can put the user's hands on it:
                // reveal the blocking path in Finder so "move or rename it"
                // is one drag away. Offered only when the path actually
                // exists (revealURL checks) — never a reveal Finder can't
                // honor.
                if let revealURL = banner.blockedPath
                    .flatMap({ AccountsRoster.revealURL(forBlockedPath: $0) }) {
                    Button("Reveal in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([revealURL])
                    }
                    .controlSize(.small)
                    .help("Show the blocking directory in Finder so you can move or rename it")
                }
                // Issue #228: no dead Retry. A banner with no affected
                // account and no activation to re-run (fresh install with
                // no default; orphaned trouble) renders no button — its
                // message carries the next step instead.
                if banner.offersRetry {
                    Button("Retry", action: onRetry)
                        .controlSize(.small)
                        .disabled(isActivationInFlight)
                        .help(banner.retryRunsActivation
                            ? "Run activation again for the affected subscription. New sessions only — running sessions are never touched."
                            : "Re-check the provider's activation state")
                }
                Button("Why?") { isShowingWhy = true }
                    .controlSize(.small)
                    .buttonStyle(.borderless)
                    .popover(isPresented: $isShowingWhy, arrowEdge: .bottom) {
                        Text(banner.detail)
                            .font(.system(size: 11))
                            .frame(width: 260, alignment: .leading)
                            .padding(12)
                    }
                    .help(banner.detail)
            }
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 9)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(severityColor(.warning).opacity(0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(severityColor(.warning).opacity(0.28))
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(banner.provider.displayName) activation notice: \(banner.message) \(banner.detail)")
    }
}

/// Issue #93: the calm post-activation notice — the daemon warned that some
/// already-running sessions were launched without ModelDeck's pinned
/// environment and may lose session storage. Same visual family as the
/// Direction A banner (amber, section-level, [Why?]) but deliberately
/// quieter: info glyph instead of the warning triangle, a Dismiss control
/// instead of [Retry], because the switch already completed and nothing here
/// is actionable inside the app. VoiceOver reads ONE derived label carrying
/// the provider, the daemon's verbatim message, and the nuance (the #79
/// lesson: never let an explicit container label suppress the state).
struct PostActivationNoticeView: View {
    let notice: PostActivationNotice
    let onDismiss: () -> Void

    @State private var isShowingWhy = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "info.circle")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(severityColor(.warning))
            Text(notice.message)
                .font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                Button("Why?") { isShowingWhy = true }
                    .controlSize(.small)
                    .buttonStyle(.borderless)
                    .popover(isPresented: $isShowingWhy, arrowEdge: .bottom) {
                        Text(PostActivationNotice.detail)
                            .font(.system(size: 11))
                            .frame(width: 260, alignment: .leading)
                            .padding(12)
                    }
                    .help(PostActivationNotice.detail)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9))
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Dismiss this notice")
                .accessibilityLabel("Dismiss \(notice.provider.displayName) activation notice")
            }
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 9)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(severityColor(.warning).opacity(0.07))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(severityColor(.warning).opacity(0.20))
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(notice.accessibilityLabel)
    }
}

/// One Direction A roster row: label (+ honest active marker, + quiet
/// "seeded" provenance marker), identity line (email · purpose — always
/// shown on this management surface), and a trailing radio (◉/○) as the
/// activation control — the native exclusive-choice idiom, amber when
/// selected-but-pending. Healthy rows are silent; only degraded states show
/// a chip. Edit/Remove live in the right-click context menu and the hover ⋯
/// menu (both paths). No color dots anywhere.
struct AccountRosterRow: View {
    let account: DeckAccount
    var showActivation = true
    let isBusy: Bool
    let canEdit: Bool
    var isActivating: Bool = false
    /// True while ANY activation is in flight — every activation control disables.
    var isActivationInFlight: Bool = false
    /// Issue #55: this provider's verified physical activation state — the
    /// selected row's marker renders the full checkmark only when effective
    /// (or unreported by an older daemon).
    var activationState: ProviderActivationState = .unknown
    /// Whether the radio renders the amber selected-but-pending variant.
    var isRadioPending: Bool = false
    /// Issue #32: this account's own sign-in-again flow state.
    var signInPhase: AccountSignInModel.Phase?
    var signInError: String?
    /// Activation entry point: the radio for non-selected rows, the Complete
    /// Activation button for the selected-but-link-pending row (issue #61).
    var onActivate: (() -> Void)?
    var onSignIn: (() -> Void)?
    var onVerifySignIn: (() -> Void)?
    var onRelaunchSignIn: (() -> Void)?
    var onCancelSignIn: (() -> Void)?
    /// Issue #176: this row's renew state — non-nil only for an expired-idle
    /// Claude account whose daemon reported the `renew` capability (a
    /// pre-#176 daemon or a Codex account renders nothing new).
    var renew: AccountRenewPresentation?
    var onRenewNow: (() -> Void)?
    var onDismissRenewOutcome: (() -> Void)?
    let onEdit: () -> Void
    let onRemove: () -> Void
    /// Issue #174: the daemon-reported statusline capture opt-in state for
    /// Claude accounts. Nil (Codex accounts, old daemons) renders no control.
    var statuslineInstalled: Bool?
    /// Issue #194: true while THIS row's statusline install/uninstall is in
    /// flight — the visible capture control shows its spinner.
    var isStatuslineBusy: Bool = false
    /// CodeRabbit PR #304: true while ANY account's roster mutation (edit /
    /// remove / capture) is in flight — the model serializes mutations, so
    /// every row's capture control disables rather than swallowing clicks.
    var isRosterMutationInFlight: Bool = false
    /// Enables (true) or disables (false) statusline capture for this profile.
    var onSetStatusline: ((Bool) -> Void)?
    /// Issue #279: this row's proxy pool + routing state. Nil renders NOTHING
    /// — no line, no menu item — which is exactly what a machine without the
    /// proxy (and an old daemon) must show.
    var proxy: ProxyPoolRowPresentation?
    var onProxyJoin: (() -> Void)?
    var onProxyRoute: (() -> Void)?
    var onProxyUnroute: (() -> Void)?
    var onProxyCancelJoin: (() -> Void)?
    var onDismissProxyOutcome: (() -> Void)?
    /// Issue #396: this row's in-app credential repair. Nil renders NOTHING
    /// — the same discipline as `proxy` above.
    var relogin: ProxyReloginRowPresentation?
    var onProxyFixSignIn: (() -> Void)?
    var onProxyCancelRelogin: (() -> Void)?
    var onDismissReloginOutcome: (() -> Void)?
    /// Issue #280: the seeded pill's Verify affordance. Nil renders nothing.
    var verify: IdentityVerifyPresentation?
    var onVerifyIdentity: (() -> Void)?
    var onDismissVerifyOutcome: (() -> Void)?

    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(account.label)
                            .font(.system(size: 12.5, weight: .semibold))
                        if showActivation && account.isDefault {
                            ActiveMarkerView(indicator: ActiveIndicator.indicator(for: activationState))
                        }
                        if account.hasDuplicateToken {
                            // Issue #65: the usage-fingerprint check says two
                            // profiles hold the same login — hollow marker
                            // here, details in the section banner below.
                            // Issue #152: the marker's explanation names this
                            // profile and carries the same "Re-log in…"
                            // action as the row's button — it starts the
                            // roster's existing sign-in flow directly.
                            DuplicateTokenMarkerView(
                                explanation: .duplicateToken(
                                    reloginLabel: account.label,
                                    provider: DeckProvider.from(account.provider)
                                ),
                                onRelogin: onSignIn
                            )
                        }
                        if account.isIdentitySeeded {
                            Text("seeded")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Capsule().fill(Color.primary.opacity(0.08)))
                                // Issue #280 (Tim: the pill "just makes me
                                // question what's going on"): the tooltip
                                // now names BOTH exits, so the "yet" it
                                // promises finally has an arrival story.
                                .help(IdentityVerify.pillTooltip)
                                .accessibilityLabel(IdentityVerify.pillAccessibilityLabel)
                        }
                        // Issue #280: the Verify affordance renders ONLY
                        // beside the pill (its presentation is gated on
                        // `isIdentitySeeded`), so a verified account shows
                        // neither.
                        identityVerifyControls
                    }
                    if let subtitle = account.rosterSubtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                // Issue #194: statusline capture (#174) as a VISIBLE row
                // control — it was hidden in the hover-only ⋯ menu and sat
                // uninstalled for a week on Tim's machine; the ⋯ toggle
                // stays as the second path.
                statuslineCaptureControl
                signInControls
                // Issue #194: the capture control shows its OWN spinner, so
                // the generic busy spinner yields while a statusline
                // install/uninstall is the in-flight mutation (never two
                // spinners on one row).
                if (isBusy && !isStatuslineBusy) || isActivating {
                    ProgressView().controlSize(.small)
                }
                // Issue #61 semantics kept: the selected row shows Complete
                // Activation when its activation is link-pending (blocked/
                // mismatched/unlinked) — the radio can't re-select an
                // already-selected account, so the button carries the finish.
                if account.isDefault, activationState.needsLinkCompletion, let onActivate {
                    Button("Complete Activation", action: onActivate)
                        .controlSize(.small)
                        .disabled(isBusy || isActivating || isActivationInFlight)
                        .help("This subscription is selected as active but activation isn't in effect yet. Once any blocker is cleared, this lays the active link for new sessions. Running sessions are never touched.")
                        .accessibilityLabel("Complete activation for \(account.label)")
                }
                // Hover ⋯ — the visible path to Edit/Remove (the row's
                // right-click context menu is the second path).
                Menu {
                    editRemoveActions
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .opacity(isHovered ? 1 : 0)
                .help("Edit or remove this subscription (also on right-click)")
                .accessibilityLabel("Actions for \(account.label)")
                if showActivation { radio }
            }
            if let signInError {
                Text(signInError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Issue #279: the quiet proxy line, under the identity line and
            // in the same muted voice. The DECK stays calm — this surface
            // is Settings → Accounts, where managing an account is the job.
            proxyLine
            // Issue #396: the repair line, directly under the pool line it
            // is about. It appears only when there is something to say — a
            // broken credential, a flow in progress, or its outcome.
            reloginLine
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .contextMenu { editRemoveActions }
    }

    /// The trailing activation radio (◉/○) — one active account per
    /// provider, made structural. Amber ring + dot when the selection isn't
    /// physically in effect yet. Tooltips carry the new-sessions-only nuance.
    private var radio: some View {
        let color: Color = isRadioPending ? severityColor(.warning) : .accentColor
        // Issue #100: a disabled `.plain`-style button with a custom label
        // renders pixel-identical to an enabled one — the invisible state
        // that swallows clicks with zero feedback. Dim the radio whenever a
        // non-selected row can't accept a click (activation unavailable,
        // row busy, or another switch in flight) so unavailability is
        // visible; the selected row's radio IS the state display and keeps
        // full opacity.
        let isUnavailable = !account.isDefault
            && (onActivate == nil || isBusy || isActivating || isActivationInFlight)
        return Button {
            if !account.isDefault { onActivate?() }
        } label: {
            ZStack {
                Circle()
                    .strokeBorder(account.isDefault ? color : Color.secondary, lineWidth: 1.5)
                    .frame(width: 15, height: 15)
                if account.isDefault {
                    Circle()
                        .fill(color)
                        .frame(width: 7, height: 7)
                }
            }
            // Issue #228 (fresh-install field report): a stroked shape only
            // hit-tests on its painted band, and a `.plain` Button's click
            // area IS its label's content shape — so a non-selected row's
            // hollow ring accepted clicks only on the 1.5 pt stroke itself.
            // Clicking the CENTER of the radio (the natural target) fell
            // through to the List row and did nothing, silently, every
            // time. The explicit content shape makes the whole circle
            // clickable.
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(account.isDefault || onActivate == nil
            || isBusy || isActivating || isActivationInFlight)
        .opacity(isUnavailable ? 0.35 : 1)
        .help(radioHelp)
        .accessibilityLabel(radioAccessibilityLabel)
        .accessibilityAddTraits(account.isDefault ? [.isSelected] : [])
    }

    private var radioHelp: String {
        let providerName = DeckProvider.from(account.provider)?.displayName ?? "this provider"
        if account.isDefault {
            return isRadioPending
                ? "Selected as active, but activation isn't in effect yet — see the notice above. New sessions keep the previous subscription until activation completes."
                : "Active — new \(providerName) sessions use this subscription. Running sessions are never touched."
        }
        return onActivate == nil
            ? "Activation isn't available right now."
            : "Activate \(account.label) for new \(providerName) sessions. Running sessions are never touched."
    }

    private var radioAccessibilityLabel: String {
        if account.isDefault {
            return isRadioPending
                ? "\(account.label), selected as active, activation pending"
                : "\(account.label), active"
        }
        return "Activate \(account.label)"
    }

    @ViewBuilder
    private var editRemoveActions: some View {
        Button("Edit…", action: onEdit)
            .disabled(isBusy || !canEdit)
        // Issue #174: opt-in statusline capture for Claude profiles. The
        // toggle reflects the daemon's read of the profile's own
        // settings.json; an existing user statusline is chained, its output
        // untouched, and disabling restores the original config.
        if let statuslineInstalled, let onSetStatusline {
            Divider()
            Toggle(
                StatuslineCaptureControl.menuToggleLabel,
                isOn: Binding(
                    get: { statuslineInstalled },
                    set: { onSetStatusline($0) }
                )
            )
            .disabled(isBusy)
            // Issue #194: pinned #174 copy, single-sourced with the
            // visible row control so the two paths can't drift.
            .help(statuslineInstalled
                ? StatuslineCaptureControl.installedHelp
                : StatuslineCaptureControl.enableHelp)
        }
        // Issue #279: leaving the pool is not ModelDeck's operation, but
        // UNROUTING is — it's the reversible half, and the ⋯ menu is where
        // a reversal belongs (never a second button competing with the
        // row's one quiet action). Confirmed like every other proxy action.
        if proxy?.offersUnroute == true, let onProxyUnroute {
            Divider()
            Button("Stop routing sessions…", action: onProxyUnroute)
                .disabled(isBusy)
                .help("New sessions for this subscription stop going through the local proxy. "
                    + "Running sessions are never touched.")
        }
        // Issue #396: the repair stays reachable even for a member the proxy
        // still believes in — the row only PROMOTES it to a visible button
        // when the credential is actually broken. A user who knows a sign-in
        // is stale should never have to break it first to fix it.
        if let relogin, let onProxyFixSignIn {
            switch relogin.display {
            case .action:
                Divider()
                Button(ProxyRelogin.menuTitle, action: onProxyFixSignIn)
                    .disabled(isBusy)
                    .help(ProxyRelogin.confirmation(label: account.label))
            case .unavailable(let reason):
                Divider()
                Button(ProxyRelogin.menuTitle) {}
                    .disabled(true)
                    .help(reason)
            default:
                EmptyView()
            }
        }
        Button("Remove…", role: .destructive, action: onRemove)
            .disabled(isBusy)
    }

    /// Issue #194: the VISIBLE statusline-capture control (#174's biggest
    /// accuracy mechanism, previously reachable only through the hover ⋯
    /// menu). Selection lives in `StatuslineCaptureControl.display` — Claude
    /// rows with a daemon-reported `claudeStatusline` state only; a nil
    /// state (Codex, old daemon) renders nothing, the established skew
    /// precedent. Off → a small discoverable action button; on → a quiet
    /// green confirmation pill (the #118/#149 chip family); in flight → the
    /// row's spinner ON the control. Both states click through to the same
    /// install/uninstall endpoints as the ⋯ toggle; errors surface through
    /// the pane's existing `lastError` line, calm copy from the daemon.
    @ViewBuilder
    private var statuslineCaptureControl: some View {
        switch StatuslineCaptureControl.display(for: account, isBusy: isStatuslineBusy) {
        case .busy:
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Updating statusline capture for \(account.label)")
        case .enable:
            Button(StatuslineCaptureControl.enableLabel) { onSetStatusline?(true) }
                .controlSize(.small)
                .disabled(isBusy || isRosterMutationInFlight || isActivating
                    || isActivationInFlight || onSetStatusline == nil)
                .help(StatuslineCaptureControl.enableHelp)
                .accessibilityLabel("Turn on statusline capture for \(account.label)")
        case .installed:
            Button {
                onSetStatusline?(false)
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .semibold))
                    Text(StatuslineCaptureControl.installedLabel)
                        .font(.system(size: 10, weight: .medium))
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 2.5)
                .background(Capsule().fill(Color.green.opacity(0.16)))
                .foregroundStyle(.green)
            }
            .buttonStyle(.plain)
            .disabled(isBusy || isRosterMutationInFlight || isActivating
                || isActivationInFlight || onSetStatusline == nil)
            .help(StatuslineCaptureControl.installedHelp)
            .accessibilityLabel("Statusline capture is on for \(account.label) — click to turn off")
        case nil:
            EmptyView()
        }
    }

    /// Issue #279: "In pool · routed" and, when the account has earned one,
    /// exactly ONE quiet action beside it. The trailing slot follows the
    /// #199 precedence tested in Core: progress → unread outcome → action.
    @ViewBuilder
    private var proxyLine: some View {
        if let proxy {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 8.5))
                    .foregroundStyle(.tertiary)
                if !proxy.statusText.isEmpty {
                    Text(proxy.statusText)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                switch proxy.display {
                case .joinWaiting:
                    ProgressView().controlSize(.small)
                    Text(ProxyPool.joinWaitingText)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    if let onProxyCancelJoin {
                        Button("Stop waiting", action: onProxyCancelJoin)
                            .controlSize(.small)
                            .help(ProxyPool.joinWaitStopTooltip)
                            .accessibilityLabel("Stop waiting for \(account.label) sign-in")
                    }
                case .routing:
                    ProgressView().controlSize(.small)
                    Text(ProxyPool.routingProgressText)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                case .note(let text):
                    proxyOutcome(text, isFailure: false)
                case .error(let text):
                    proxyOutcome(text, isFailure: true)
                case .action(.join):
                    if let onProxyJoin {
                        Button("Add to proxy pool…", action: onProxyJoin)
                            .controlSize(.small)
                            .disabled(isBusy)
                            .help("Signs this subscription in to the local proxy so it can serve "
                                + "pooled traffic. A browser sign-in opens; nothing changes until "
                                + "it completes.")
                            .accessibilityLabel("Add \(account.label) to the proxy pool")
                    }
                case .action(.route):
                    if let onProxyRoute {
                        Button("Route sessions…", action: onProxyRoute)
                            .controlSize(.small)
                            .disabled(isBusy)
                            .help("New sessions for this subscription go through the local proxy. "
                                + "Running sessions are never touched, and this is reversible.")
                            .accessibilityLabel("Route \(account.label) sessions through the proxy")
                    }
                case .quiet:
                    EmptyView()
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 1)
        }
    }

    /// Issue #396: the in-app fix for an expired pool credential. Minimal by
    /// design — a broken credential says so and offers ONE button, and every
    /// calmer state (a healthy member, a repair that is merely available)
    /// keeps the affordance in the ⋯ menu instead of adding a second control
    /// to a quiet row.
    @ViewBuilder
    private var reloginLine: some View {
        if let relogin, reloginLineIsVisible(relogin) {
            HStack(spacing: 6) {
                Image(systemName: "key.slash")
                    .font(.system(size: 8.5))
                    .foregroundStyle(.tertiary)
                if let credentialText = relogin.credentialText {
                    Text(credentialText)
                        .font(.system(size: 10))
                        // Issue #515: the presentation already decided this on
                        // BOTH measures (recorded credential, routed-failure
                        // streak) — the row must not re-derive it and reach a
                        // calmer conclusion than the deck's banner.
                        .foregroundStyle(relogin.credentialIsBroken ? .orange : .secondary)
                        .lineLimit(1)
                        .help(reloginCredentialHelp(relogin, base: credentialText))
                }
                switch relogin.display {
                case .running(let text, let canCancel):
                    ProgressView().controlSize(.small)
                    Text(text)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    if canCancel, let onProxyCancelRelogin {
                        Button("Stop", action: onProxyCancelRelogin)
                            .controlSize(.small)
                            .help(ProxyRelogin.cancelTooltip)
                            .accessibilityLabel("Stop the proxy sign-in for \(account.label)")
                    }
                case .note(let text):
                    reloginOutcome(text, isFailure: false)
                case .error(let text):
                    reloginOutcome(text, isFailure: true)
                case .action(let prominent):
                    if prominent, let onProxyFixSignIn {
                        Button(ProxyRelogin.actionTitle, action: onProxyFixSignIn)
                            .controlSize(.small)
                            .disabled(isBusy)
                            .help(ProxyRelogin.confirmation(label: account.label))
                            .accessibilityLabel("Fix the proxy sign-in for \(account.label)")
                    }
                case .unavailable, .quiet:
                    EmptyView()
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 1)
        }
    }

    /// CodeRabbit (PR #435): an unavailable repair otherwise explains itself
    /// only in the disabled ⋯ menu item — the credential line's tooltip also
    /// carries the reason, so the broken row explains itself in place.
    private func reloginCredentialHelp(
        _ relogin: ProxyReloginRowPresentation,
        base: String
    ) -> String {
        guard case .unavailable(let reason) = relogin.display else { return base }
        return base + "\n" + reason
    }

    /// The line earns its space only when it carries news: a non-ok
    /// credential, a flow in progress, or an outcome to read.
    private func reloginLineIsVisible(_ relogin: ProxyReloginRowPresentation) -> Bool {
        switch relogin.display {
        case .running, .note, .error: return true
        case .action(let prominent): return prominent || relogin.credentialText != nil
        case .unavailable, .quiet: return relogin.credentialText != nil
        }
    }

    /// A settled repair outcome — held until dismissed, like every other
    /// click answer in this row (#199).
    @ViewBuilder
    private func reloginOutcome(_ text: String, isFailure: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: isFailure ? "exclamationmark.triangle" : "checkmark.circle")
                .font(.system(size: 9, weight: .semibold))
            Text(text)
                .font(.system(size: 10))
                .lineLimit(2)
                .help(text)
            if let onDismissReloginOutcome {
                Button(action: onDismissReloginOutcome) {
                    Image(systemName: "xmark").font(.system(size: 8))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Dismiss proxy sign-in result for \(account.label)")
            }
        }
        .font(.system(size: 10))
        .foregroundStyle(isFailure ? Color.orange : Color.secondary)
    }

    /// A settled join/routing outcome — the daemon's sentence verbatim, held
    /// until dismissed (the #199 rule: a click's answer lands at the click
    /// site, not only in a state refresh).
    @ViewBuilder
    private func proxyOutcome(_ text: String, isFailure: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: isFailure ? "exclamationmark.triangle" : "checkmark.circle")
                .font(.system(size: 9, weight: .semibold))
            Text(text)
                .font(.system(size: 10))
                .lineLimit(2)
                .help(text)
            if let onDismissProxyOutcome {
                Button(action: onDismissProxyOutcome) {
                    Image(systemName: "xmark").font(.system(size: 8))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Dismiss proxy result for \(account.label)")
            }
        }
        .foregroundStyle(isFailure ? AnyShapeStyle(severityColor(.warning)) : AnyShapeStyle(.secondary))
    }

    /// Issue #280: idle → [Verify], running → calm progress, decided
    /// non-success → the quiet inline sentence (mismatch points at the
    /// EXISTING identity-mismatch surface rather than inventing a new one).
    /// Success renders nothing: the pill and this button both disappear on
    /// the refreshed state, which IS the answer.
    @ViewBuilder
    private var identityVerifyControls: some View {
        if let verify {
            switch verify.display {
            case .verify:
                if let onVerifyIdentity {
                    Button("Verify", action: onVerifyIdentity)
                        .controlSize(.small)
                        .disabled(isBusy)
                        .help(IdentityVerify.buttonTooltip)
                        .accessibilityLabel("Verify \(account.label)'s identity with the provider")
                }
            case .running:
                HStack(spacing: 4) {
                    ProgressView().controlSize(.small)
                    Text(IdentityVerify.runningText)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Verifying \(account.label)'s identity")
            case .failure(let text):
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 9, weight: .semibold))
                    Text(text)
                        .font(.system(size: 10))
                        .lineLimit(1)
                        .help(text)
                    if let onDismissVerifyOutcome {
                        Button(action: onDismissVerifyOutcome) {
                            Image(systemName: "xmark").font(.system(size: 8))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Dismiss verification result for \(account.label)")
                    }
                }
                .foregroundStyle(severityColor(.warning))
            }
        }
    }

    /// Sign-in-again flow (issue #32). Direction A: healthy rows are SILENT
    /// — the chip appears only for the degraded sign-in-required state (and
    /// stays clickable); "Healthy"/"Unknown" render nothing.
    @ViewBuilder
    private var signInControls: some View {
        switch signInPhase {
        case .launching, .activating, .verifying:
            HStack(spacing: 5) {
                ProgressView().controlSize(.small)
                Text(signInProgressText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .awaitingSignIn:
            HStack(spacing: 5) {
                Text("Waiting for login in Terminal…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Verify") { onVerifySignIn?() }
                    .controlSize(.small)
                    .help("Check with the provider that this profile is now signed in")
                Button("Re-log in") { onRelaunchSignIn?() }
                    .controlSize(.small)
                    .help("Open Terminal with the provider's login command again — use this if no Terminal window appeared or you closed it")
                Button {
                    onCancelSignIn?()
                } label: {
                    Image(systemName: "xmark")
                }
                .controlSize(.small)
                .accessibilityLabel("Cancel sign-in for \(account.label)")
            }
        case nil:
            // Issue #149: the idle-decay chip shares this branch verbatim —
            // same one-click flow, same slot; only wording and color calm
            // down. `.signInAgain` (genuine sign-out, or an old daemon
            // without the reason field) keeps the amber chip unchanged.
            if account.healthChip == .signInAgain || account.healthChip == .idleSignIn {
                if let onSignIn {
                    Button(action: onSignIn) {
                        HealthChipView(chip: account.healthChip)
                    }
                    .buttonStyle(.plain)
                    .help(signInAgainHelp(base: signInChipActionableHelp))
                    .accessibilityLabel(signInChipAccessibilityLabel)
                } else {
                    HealthChipView(chip: account.healthChip)
                        .help(signInAgainHelp(base: account.healthChip == .idleSignIn
                            ? "This subscription's sign-in renews when it is next used; its usage data is paused until then"
                            : "This subscription needs a fresh sign-in"))
                        // CodeRabbit PR #222: the pill shrank to "Idle", so
                        // VoiceOver needs the renewal context spoken here —
                        // stated as fact, no "Sign in now" (no action exists
                        // on this branch).
                        .accessibilityLabel(account.healthChip == .idleSignIn
                            ? "Idle, sign-in renews on next use: \(account.label)"
                            : "\(account.healthChip.text): \(account.label)")
                }
            } else if account.hasDuplicateToken, let onSignIn {
                // Issue #152 (Tim: "I need something clickable to fix the
                // issue"): a duplicate-flagged row keeps its honest Unknown
                // chip semantics (the account IS signed in — just as a
                // shared login), so the clickable remedy renders as its own
                // small button in the same slot. It runs the roster's
                // EXISTING sign-in flow (daemon-built profile-scoped login
                // in Terminal); re-logging either duplicate under its
                // correct account clears both. Nothing automatic.
                Button("Re-log in", action: onSignIn)
                    .controlSize(.small)
                    .help(DuplicateTokenMarker.reloginHint(
                        label: account.label,
                        providerName: DeckProvider.from(account.provider)?.displayName ?? "the provider"
                    ))
                    .accessibilityLabel("Re-log in \(account.label)")
            }
            // Issue #176: the renew surface rides in the same trailing slot
            // (nil presentation — old daemon, Codex, signed-out alarm —
            // renders nothing at all). Issue #199: it now renders OUTSIDE
            // the idle-chip condition, because a just-renewed row heals its
            // chip immediately while the decided outcome ("Sign-in
            // renewed.") must still answer where the button was until
            // dismissed — the heal alone read as a dead button in Tim's
            // field report.
            renewControls
        }
    }

    /// Issue #176: the expired-idle row's renew surface, in the same
    /// trailing slot family as the sign-in flow above. Running → calm
    /// progress; finished → the daemon's decided outcome verbatim, held
    /// until dismissed (issue #199: the chip flipping healthy is nice, but
    /// the outcome line itself is the answer to the click — busy especially
    /// must be seen, not inferred); otherwise the small "Renew now" action,
    /// or the honest authOverride caption instead of the button (never an
    /// error tone — that profile is configured to authenticate elsewhere).
    @ViewBuilder
    private var renewControls: some View {
        // Issue #199: the row renders the presentation's single display
        // slot (progress → decided outcome → armed action), so a finished
        // attempt always answers AT the click site and the button never
        // silently re-arms over an unread answer — the precedence lives in
        // `AccountRenewPresentation.display`, where it's tested.
        if let renew {
            switch renew.display {
            case .progress:
                HStack(spacing: 5) {
                    ProgressView().controlSize(.small)
                    Text("Renewing…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Renewing sign-in for \(account.label)")
            case .outcome(let text, let kind):
                // Daemon detail verbatim, dismissible (#196's pattern).
                // Busy is prominent-and-calm (#199): primary tone and an
                // hourglass — a promise to renew at the next quiet moment,
                // never an alarm.
                HStack(spacing: 5) {
                    Image(systemName: AccountRenew.glyph(for: kind))
                        .font(.system(size: 9, weight: .semibold))
                    Text(text)
                        .font(.system(size: 10))
                        .lineLimit(1)
                        .help(text)
                    if let onDismissRenewOutcome {
                        Button(action: onDismissRenewOutcome) {
                            Image(systemName: "xmark")
                                .font(.system(size: 8))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Dismiss renewal result for \(account.label)")
                    }
                }
                .foregroundStyle(kind == .busy ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            case .action(.renewNow):
                if let onRenewNow {
                    Button("Renew now", action: onRenewNow)
                        .controlSize(.small)
                        .help("Renews this subscription's sign-in in the background — no Terminal, no browser. "
                            + AccountRenew.disclosure)
                        .accessibilityLabel("Renew sign-in for \(account.label)")
                }
            case .action(.authOverridden):
                // Tim's 0.3.15 report: the "Renewal handled elsewhere"
                // caption was verbose noise on the row. The state renders
                // nothing — calm absence of a Renew button — and the full
                // explanation stays available on the row's health chip.
                EmptyView()
            case nil:
                EmptyView()
            }
        }
    }

    /// Issue #149: the clickable chip's base tooltip, honest per tone. Both
    /// launch the exact same provider login in Terminal.
    private var signInChipActionableHelp: String {
        let providerName = DeckProvider.from(account.provider)?.displayName ?? "the provider"
        if account.healthChip == .idleSignIn {
            return "This subscription's sign-in renews when it is next used; its usage data is paused until then. Launch \(providerName)'s own login in Terminal to refresh now"
        }
        return "Launch \(providerName)'s own login for this subscription in Terminal"
    }

    /// Issue #149: VoiceOver hears WHICH case it is, then the same action.
    private var signInChipAccessibilityLabel: String {
        account.healthChip == .idleSignIn
            ? "Idle, sign-in renews on next use. Sign in now: \(account.label)"
            : "Sign in again: \(account.label)"
    }

    /// Issue #99: `.activating` names the pre-login account flip honestly
    /// instead of pretending Terminal is already opening.
    private var signInProgressText: String {
        switch signInPhase {
        case .verifying: return "Verifying…"
        case .activating: return "Activating this subscription for sign-in…"
        default: return "Opening Terminal…"
        }
    }

    /// Issue #89: the chip's tooltip carries the daemon's per-account
    /// refresh error verbatim when one was reported — the WHY behind the
    /// "Sign in again", not just the state.
    private func signInAgainHelp(base: String) -> String {
        guard let message = account.lastRefreshError?.message, !message.isEmpty else { return base }
        return "\(base)\nLast refresh failed: \(message)"
    }
}

struct HealthChipView: View {
    let chip: ToolProbe.HealthChip

    var body: some View {
        Text(chip.text)
            .font(.system(size: 10, weight: .medium))
            // A pill must never text-wrap (Tim's 0.3.15 report): one line,
            // sized to its text, always.
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(Capsule().fill(color.opacity(0.16)))
            .foregroundStyle(color)
    }

    private var color: Color {
        switch chip {
        case .healthy: return .green
        case .signInAgain: return .orange
        // Issue #149: idle-decay is calm by design — neutral, never amber.
        case .idleSignIn: return .secondary
        case .unknown: return .secondary
        }
    }
}

/// Edit sheet: label, purpose, color — the fields the daemon's upsert
/// endpoint supports for an existing account.
struct AccountEditSheet: View {
    let account: DeckAccount
    @ObservedObject var accountsModel: AccountsSettingsModel
    @Environment(\.dismiss) private var dismiss

    @State private var label: String = ""
    @State private var purpose: String = ""
    @State private var color: Color = .accentColor

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Edit \(account.label)")
                .font(.headline)
            Form {
                TextField("Label", text: $label)
                TextField("Purpose", text: $purpose, prompt: Text("e.g. client work"))
                ColorPicker("Color", selection: $color, supportsOpacity: false)
            }
            if let error = accountsModel.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    Task {
                        let saved = await accountsModel.saveEdit(
                            account: account,
                            label: label,
                            purpose: purpose,
                            color: color.hexString
                        )
                        if saved { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(accountsModel.busyAccountID != nil
                    || label.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(18)
        .frame(width: 340)
        .onAppear {
            label = account.label
            purpose = account.purpose ?? ""
            color = Color(hexString: account.color) ?? .accentColor
        }
    }
}

// MARK: - General pane

struct GeneralSettingsPane: View {
    @State private var rollbackConfirmation: AppcastItem?
    @AppStorage(AppUpdateFeedPolicy.betaReleasesKey) private var betaReleases = false
    @ObservedObject var settingsSync: SettingsSyncModel
    @ObservedObject var toolsModel: ToolsStatusModel
    /// Issue #32 item 4: the CLI-row chip is the ACTIVE account's auth state
    /// (daemon contract), so the row names that account explicitly.
    @ObservedObject var statusModel: MenuBarStatusModel
    /// Issue #73: owns the app-local "Show subscription emails" preference the
    /// deck rows read (default off; never synced to the daemon).
    @ObservedObject var deckModel: DeckPopoverModel
    @ObservedObject var updateModel: ToolUpdateModel
    /// Issue #33: app-update check state (GitHub releases feed of the public
    /// repo). Deliberately separate from every CLI update control.
    @ObservedObject var appUpdateModel: AppUpdateModel
    @ObservedObject var appRollbackModel: AppRollbackModel
    /// Issue #60: the "Check for updates automatically" toggle — periodic
    /// check (every few hours since #241; was daily) of the SAME releases
    /// feed; issue #121 made it the scheduling brain for Sparkle's quiet
    /// install as well.
    @ObservedObject var appUpdateAutoChecker: AppUpdateAutoChecker
    /// Issue #121: "Update Now" + "Install updates automatically" state.
    @ObservedObject var appUpdateInstallModel: AppUpdateInstallModel
    /// Issue #96: bundled background-service status + the only home of the
    /// legacy-LaunchAgent takeover action.
    @ObservedObject var daemonSetupModel: DaemonSetupModel
    /// Issue #422: the managed-proxy choice, its upgrade path from a
    /// decline, and the "stop managing" rollback with its restore steps.
    @ObservedObject var proxyOnboardingModel: ManagedProxyOnboardingModel
    let managedProxyAvailable: Bool
    /// Shared with the popover gear menu — one status read at load(), one
    /// published value behind both toggles.
    @ObservedObject var launchAtLoginModel: LaunchAtLoginModel
    /// Issue #204: the shared-user-scope section's state machine. The
    /// section renders only when `/api/state` reported the `sharedScope`
    /// object — a pre-#204 daemon renders nothing at all (the contract).
    @ObservedObject var sharedScopeModel: SharedScopeModel

    @State private var releaseNotes: String?

    private static let lastCheckFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    @Environment(\.openURL) private var openURL

    /// Interval choices inside the daemon's validated 60–3600 s range.
    private static let intervalChoices: [Int] = [60, 120, 300, 600, 900, 1800, 3600]

    /// Issue #319: the Hide/Show section's one-line explanation of what the
    /// current selection does — state-honest, including the off state.
    private var hideShowCaption: String {
        guard deckModel.hideShowEnabled else {
            return "Hiding is off — every subscription is shown. Your mode and hidden subscriptions are kept for when it's back on."
        }
        switch deckModel.hideMode {
        case .byAccount:
            // Issue #321: the right-click gesture line moved to the STATIC
            // caption under the mode picker (Settings parity, decision 4),
            // so this state-honest line keeps only what that caption
            // doesn't say.
            return "Nothing hides until you hide a subscription."
        case .byRemaining:
            return deckModel.byRemainingCaption
        case .byZeroWeightings:
            return "Subscriptions whose row shows routing weight 0 hide automatically. The right-click Hide line is off in this mode."
        }
    }

    var body: some View {
        Form {
            Section("Switching") {
                ForEach([DeckProvider.claude, .codex], id: \.self) { provider in
                    VStack(alignment: .leading, spacing: 3) {
                        let state = statusModel.deckState
                        let reason = state?.managementDisabledReason(for: provider)
                        Toggle("Manage account switching for \(provider.displayName)", isOn: Binding(
                            get: { provider == .claude ? settingsSync.settings.claudeManaged == true : settingsSync.settings.codexManaged == true },
                            set: { enabled in
                                Task {
                                    await settingsSync.setProviderManaged(provider, enabled: enabled)
                                    await statusModel.refresh()
                                }
                            }
                        ))
                        .disabled(!settingsSync.isLoaded || settingsSync.isSaving || state?.managed == nil || reason != nil)
                        Text(reason ?? (state?.managed == nil
                            ? "Update the background service to change this setting."
                            : provider == .claude
                                ? "Moves ~/.claude; verify the sign-in afterwards."
                                : "With switching on, ~/.codex follows your selection."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Section("Refresh") {
                Toggle("Refresh usage automatically", isOn: binding(
                    get: { $0.autoRefreshEnabled },
                    set: { model, value in await model.setAutoRefreshEnabled(value) }
                ))
                Picker("Every", selection: binding(
                    get: { $0.autoRefreshIntervalSeconds },
                    set: { model, value in await model.setAutoRefreshInterval(seconds: value) }
                )) {
                    ForEach(intervalOptions, id: \.self) { seconds in
                        Text(Self.intervalLabel(seconds)).tag(seconds)
                    }
                }
                .disabled(!settingsSync.settings.autoRefreshEnabled)
                Toggle("Pause while a session is active", isOn: binding(
                    get: { $0.pauseWhileActive },
                    set: { model, value in await model.setPauseWhileActive(value) }
                ))
                // Issue #90 semantics (Tim's call): a chosen interval always
                // wins; the pause only slows the never-chosen default cadence.
                .help("While a claude or codex CLI session is running, scheduled refresh slows to every 30 minutes — but only until you choose a refresh interval. Choosing one (or clicking Keep below) makes your cadence stick regardless of sessions.")
                // Issue #90 affordance (CodeRabbit, PR #111): SwiftUI's
                // Picker never fires its binding when the already-selected
                // row is re-picked, so a user whose deliberate choice equals
                // the stored value (Tim: 300s) had no working way to assert
                // it. This one-line row is that way: it PUTs the current
                // value + the provenance flag via the same model path a
                // picker change uses, and disappears for good once the
                // daemon confirms the flag.
                if !settingsSync.settings.autoRefreshIntervalCustomized
                    && settingsSync.settings.autoRefreshEnabled
                    && settingsSync.settings.pauseWhileActive {
                    HStack(spacing: 6) {
                        Text("Sessions may slow refresh to every 30 min until you choose an interval.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Keep \(Self.intervalLabel(settingsSync.settings.autoRefreshIntervalSeconds).lowercased())") {
                            Task {
                                await settingsSync.setAutoRefreshInterval(
                                    seconds: settingsSync.settings.autoRefreshIntervalSeconds
                                )
                            }
                        }
                        .buttonStyle(.link)
                        .font(.caption)
                        .help("Make the current interval your explicit choice — active sessions will no longer slow it.")
                    }
                }
                // Issue #176 (Tim decision 2026-07-31): scheduled renewal of
                // expired-idle Claude accounts — zero user effort, honest
                // disclosure of the tiny invocation and its possible
                // 5-hour-window side effect. The daemon owns the schedule
                // and every guard; this is only the switch.
                Toggle("Keep idle Claude subscriptions fresh automatically", isOn: binding(
                    get: { $0.autoRenewEnabled },
                    set: { model, value in await model.setAutoRenewEnabled(value) }
                ))
                .help("When an idle Claude subscription's stored sign-in expires, ModelDeck renews it in the background — no Terminal, no browser. "
                    + AccountRenew.disclosure)
                // State-honest caption (CodeRabbit, PR #196; the Menu bar /
                // ModelDeck section precedent): describe what is actually
                // running, never the behavior a disabled toggle would have.
                Text(settingsSync.settings.autoRenewEnabled
                    ? "When an idle subscription's sign-in expires, ModelDeck renews it automatically. \(AccountRenew.disclosure)"
                    : "Automatic renewal is off — an idle subscription's expired sign-in stays paused until you renew it or use the subscription.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // Issue #343 (usage-analytics decision 12): the dashboard
                // kill switch. 0.4.6 defaults on; while off the daemon serves
                // no dashboard route and the deck shows no menu item.
                Toggle("Enable the usage analytics dashboard", isOn: binding(
                    get: { $0.usageAnalyticsEnabled },
                    set: { model, value in await model.setUsageAnalyticsEnabled(value) }
                ))
                .help("Serves a local usage-analytics page from the ModelDeck daemon and adds a Usage Analytics… item to the deck's gear menu. Local only — nothing leaves this Mac.")
                // State-honest caption (the auto-renew precedent above):
                // describe what is running, never what a disabled toggle
                // would do.
                Text(settingsSync.settings.usageAnalyticsEnabled
                    ? "The dashboard is on — open it from the deck's gear menu → Usage Analytics…. Served only on this Mac."
                    : "Usage analytics is off — no dashboard page is served and no menu item appears.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Popover") {
                Picker("Layout", selection: binding(
                    get: { $0.deckLayout },
                    set: { model, value in await model.setLayout(value) }
                )) {
                    Text("Two columns").tag(DeckLayout.twoColumn)
                    Text("Single column").tag(DeckLayout.singleColumn)
                }
                Picker("Default sort", selection: binding(
                    get: { $0.deckSortOrder },
                    set: { model, value in await model.setDefaultSort(value) }
                )) {
                    Text("Next reset").tag(DeckSortOrder.nextReset)
                    Text("Lowest remaining").tag(DeckSortOrder.lowestRemaining)
                }
                // Issue #73: identity display is a choice — OFF by default.
                // App-local preference (like Launch at Login); the daemon
                // never stores it. Settings → Accounts always shows
                // identities: it's the management surface.
                Toggle("Show subscription emails", isOn: $deckModel.showAccountEmails)
                    .help("Show each subscription's identity (email) under its name in the popover. Off by default; applies to both providers. The Subscriptions pane always shows identities.")
                // Tim directive 2026-08-02: the model window (e.g. Fable
                // weekly) is the quota he plans around; the 5-hour burst
                // limit kept stealing the headline. Off by default —
                // today's lowest-window behavior stays until chosen.
                Toggle("Lead with the model window (e.g. Fable)", isOn: $deckModel.preferModelWindowHeadline)
                    .help("Claude cards headline the model-specific weekly window (like Fable) instead of whichever window is lowest. The 5-hour and all-model windows stay visible when a card is expanded, and sorting follows the displayed window. Cards without a model window are unaffected.")
            }

            // Issue #319 (Tim, 2026-08-08): the Hide/Show system — a master
            // switch (default ON) over three mutually exclusive modes. Same
            // state as the deck footer's eye toggle (one flag, two
            // surfaces). Everything here is display-only: hidden accounts
            // keep routing, refreshing, and feeding the menu bar, and the
            // deck's counts keep stating roster totals.
            Section("Hide/Show Subscriptions") {
                Toggle("Hide subscriptions from the deck", isOn: $deckModel.hideShowEnabled)
                    .help("The master switch for hiding — the deck footer's eye toggles the same thing. Display only: hidden subscriptions still count for routing, health, and the menu bar.")
                Picker("Mode", selection: $deckModel.hideMode) {
                    ForEach(DeckPopoverModel.DeckHideMode.allCases, id: \.self) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
                .pickerStyle(.radioGroup)
                .disabled(!deckModel.hideShowEnabled)
                // Issue #321 decision 4 (Settings parity): a static caption
                // for the By-account gesture, copy verbatim per the grilling
                // record. Rendered exactly while the right-click Hide line
                // is enabled (By account and By remaining) — the SAME
                // `contextMenuHideShowEnabled` condition the deck's context
                // menu keys on, referenced not duplicated. In By zero
                // weightings the gesture is off, and an instruction sitting
                // beside the dynamic caption's "the right-click Hide line
                // is off in this mode" would contradict it (PR #322
                // adversarial review, minor finding).
                if deckModel.contextMenuHideShowEnabled {
                    Text("Right-click a subscription on the deck to hide it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if deckModel.hideMode == .byRemaining {
                    // Issue #330 Variant A: each criterion owns its dropdown
                    // and a trailing mini switch. Turning one off leaves its
                    // remembered value visible but quiet; only the switch
                    // remains interactive so the rule can be re-enabled.
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Remaining at least")
                            Text("Hides subscriptions below the threshold")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .opacity(deckModel.hideRemainingThresholdEnabled ? 1 : 0.45)
                        Spacer()
                        Picker(
                            "Remaining threshold",
                            selection: $deckModel.hideRemainingThreshold
                        ) {
                            ForEach(
                                DeckPopoverModel.DeckRemainingThreshold.allCases,
                                id: \.self
                            ) { threshold in
                                Text(threshold.displayName).tag(threshold)
                            }
                        }
                        .labelsHidden()
                        .accessibilityLabel("Remaining threshold")
                        .disabled(
                            !deckModel.hideShowEnabled
                                || !deckModel.hideRemainingThresholdEnabled)
                        .opacity(deckModel.hideRemainingThresholdEnabled ? 1 : 0.45)
                        Toggle(
                            "Use remaining threshold",
                            isOn: $deckModel.hideRemainingThresholdEnabled
                        )
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                        .disabled(!deckModel.hideShowEnabled)
                        .accessibilityLabel("Use remaining threshold")
                    }
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Renewing within")
                            Text(DeckPopoverModel.byRemainingRenewalCriterionCaption)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .opacity(deckModel.hideRenewingSoonEnabled ? 1 : 0.45)
                        Spacer()
                        Picker("Renewal window", selection: $deckModel.hideResetsHorizon) {
                            ForEach(
                                DeckPopoverModel.DeckResetsHorizon.allCases,
                                id: \.self
                            ) { horizon in
                                Text(horizon.displayName).tag(horizon)
                            }
                        }
                        .labelsHidden()
                        .accessibilityLabel("Renewal window")
                        .disabled(
                            !deckModel.hideShowEnabled || !deckModel.hideRenewingSoonEnabled)
                        .opacity(deckModel.hideRenewingSoonEnabled ? 1 : 0.45)
                        Toggle(
                            "Use renewal window",
                            isOn: $deckModel.hideRenewingSoonEnabled
                        )
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                        .disabled(!deckModel.hideShowEnabled)
                        .accessibilityLabel("Use renewal window")
                    }
                }
                // State-honest caption (the PR #196 precedent): describe
                // what the CURRENT selection actually does.
                Text(hideShowCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if deckModel.hideMode == .byRemaining,
                   let missingDataCaption = deckModel.byRemainingMissingDataCaption {
                    Text(missingDataCaption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // Menu bar percent source (Tim, 2026-07-22): "lowest across
            // accounts" only helps when you're actually using the lowest
            // account — pinning one account makes the menu bar answer
            // "where am I on MY account" at a glance, continuously.
            Section("Menu bar") {
                // Issue #238: renamed from "Show percentage for" — since
                // #229/#235 the picker also selects Availability Health and
                // None, so the label names the two-level structure instead:
                // "Menu bar shows" = WHAT, "Show it" (below) = WHEN.
                // Issue #292: the selection runs on the pin's BASE (the
                // account id with any "|win:" window choice stripped), so
                // a pin carrying a window choice still highlights its
                // account row. Picking a different row writes the plain
                // value — a new pin starts at the Lowest-window default.
                Picker("Menu bar shows", selection: binding(
                    get: { MenuBarPinResolver.pinBase($0.menuBarAccountId) },
                    set: { model, value in await model.setMenuBarAccount(id: value) }
                )) {
                    // Issue #229: no number at all — just the glyph. At the
                    // top: it's the "least menu bar" end of the spectrum.
                    Text("None — icon only").tag(MenuBarPinResolver.noneSentinel)
                    Text("Lowest across all subscriptions").tag("")
                    // Tim's follow-up: after an account switch the menu bar
                    // should usually track the newly active account — these
                    // follow the provider's ACTIVE account automatically.
                    Text("Active Claude subscription")
                        .tag(MenuBarPinResolver.followActiveSentinel(for: .claude))
                    Text("Active Codex subscription")
                        .tag(MenuBarPinResolver.followActiveSentinel(for: .codex))
                    // Issue #235: the Availability Health display modes —
                    // the menu bar shows the provider's tier-aware 7-day
                    // runway verdict (Green / Yellow / Red) instead of a
                    // percentage. Same free-string setting, "health:…"
                    // sentinels; older builds read them as an unresolvable
                    // pin and fall back to lowest-across (#229's downgrade
                    // contract).
                    Text("Claude availability health")
                        .tag(MenuBarPinResolver.healthSentinel(for: .claude))
                    Text("Codex availability health")
                        .tag(MenuBarPinResolver.healthSentinel(for: .codex))
                    // Issue #482 (Tim's request): the provider pool totals
                    // — the deck column header's #458 aggregate ("474%
                    // left") in the menu bar. Same free-string setting,
                    // "total:…" sentinels, same downgrade contract as the
                    // health sentinels. The "Total shown as" picker below
                    // chooses sum vs share of capacity.
                    Text("Claude total % left")
                        .tag(MenuBarPinResolver.totalSentinel(for: .claude))
                    Text("Codex total % left")
                        .tag(MenuBarPinResolver.totalSentinel(for: .codex))
                    ForEach(menuBarAccountOptions, id: \.id) { option in
                        Text(option.title).tag(option.id)
                    }
                }
                .help("A pinned subscription shows its lowest non-spend usage window in the menu bar continuously when one is available — normal color while healthy, gold at warning, red at critical; without a usable window the plain glyph is shown. The Pinned window control below can show a specific window (like the Fable weekly) instead of the lowest. \"Active … subscription\" follows whichever subscription is currently active for that provider. \"Lowest across all subscriptions\" shows a percentage only when some subscription drops below the warning threshold. \"… availability health\" shows that provider's Availability Health verdict as a colored status dot beside the icon (green circle, yellow triangle, red octagon — the deck column chip's 7-day runway simulation) instead of a percentage. \"… total % left\" shows that provider's pool total — the deck column header's summed % left, or its share of capacity via the Total shown as picker below. \"None — icon only\" never shows a percentage; notifications still watch every subscription.")
                // Issue #292 (Tim's field report): pinning Click AI to
                // watch the Fable weekly showed the 5-hour window instead —
                // the pin always displayed the account's lowest window.
                // Account pins can now choose a window CLASS; "Lowest
                // window" is the unchanged default, and a chosen class the
                // account doesn't report falls back to the lowest window
                // (the popover source line says so).
                // Issue #482: the total modes' format choice — Tim's "flip
                // back and forth between 474% and 68%". Sum is the header's
                // own number; share divides it by the counted
                // subscriptions' combined capacity. Also flippable from the
                // menu bar icon's right-click menu.
                if let totalProvider = MenuBarPinResolver.totalProvider(
                    settingsSync.settings.menuBarAccountId
                ) {
                    Picker("Total shown as", selection: totalFormatBinding(provider: totalProvider)) {
                        Text("Sum — e.g. 474%").tag(MenuBarPinResolver.TotalFormat.sum)
                        Text("Share of capacity — e.g. 68%").tag(MenuBarPinResolver.TotalFormat.share)
                    }
                    .help("\"Sum\" shows every counted subscription's % left added together, so 7 subscriptions can read 474%. \"Share of capacity\" divides that sum by the counted subscriptions' combined capacity (100% each): 474% of 700% shows as 68%. One choice per provider: the deck's column header shows the same format, and clicking the header's number or right-clicking the menu bar icon flips both. Subscriptions that are hidden, stale, or without a current reading stay out of both numbers.")
                }
                if let pinnedBase = pinnedAccountBase {
                    // Only window classes the account actually reports are
                    // offered (CodeRabbit, this PR) — plus a ghost row for
                    // a stored choice whose class has since vanished, so
                    // the picker always contains its current selection.
                    Picker("Pinned window", selection: pinWindowBinding(base: pinnedBase)) {
                        ForEach(pinWindowOptions(base: pinnedBase), id: \.key) { option in
                            Text(option.title).tag(option.key)
                        }
                    }
                    .help("Which of the pinned subscription's usage windows the menu bar shows. \"Lowest window\" follows whichever non-spend window has the least left — the previous behavior. A chosen window the subscription stops reporting falls back to the lowest window; the deck's menu-bar source line always names the window actually shown.")
                }
                // Issue #238 quiet mode — the mode-specific WHEN row (Tim's
                // refinement): percentage modes gate on an editable inline
                // threshold, health modes gate on the verdict; hidden for
                // None (there is nothing to gate). Default Always in both
                // — existing users see zero change. Display-only
                // throughout: notifications keep watching every account.
                if !MenuBarPinResolver.isNone(settingsSync.settings.menuBarAccountId) {
                    if MenuBarPinResolver.isHealth(settingsSync.settings.menuBarAccountId) {
                        Picker("Show it", selection: healthShowWhenBinding) {
                            Text("Always").tag(MenuBarShowWhen.alwaysStored)
                            Text("When yellow or worse").tag(MenuBarShowWhen.yellowOrWorse.stored)
                            Text("Only when red").tag(MenuBarShowWhen.redOnly.stored)
                        }
                        .help("\"When yellow or worse\" shows the status dot only while the availability verdict is Yellow or Red — a green deck renders the plain icon. Display only: notifications keep watching every subscription regardless.")
                    } else {
                        Picker("Show it", selection: percentQuietEnabledBinding) {
                            Text("Always").tag(false)
                            Text("Only below a threshold").tag(true)
                        }
                        .help("\"Only below a threshold\" shows the percentage only while it is under the level you set — above it, just the icon. Display only: notifications keep watching every subscription regardless.")
                        if quietPercentThreshold != nil {
                            HStack(spacing: 6) {
                                Text("Show when below")
                                TextField("", value: quietThresholdBinding, format: .number)
                                    .textFieldStyle(.roundedBorder)
                                    .multilineTextAlignment(.trailing)
                                    .frame(width: 48)
                                    .accessibilityLabel("Show when below percent")
                                Text("%")
                                Stepper("", value: quietThresholdBinding, in: 1...99)
                                    .labelsHidden()
                                    .accessibilityLabel("Adjust show-when-below percent")
                            }
                        }
                    }
                }
                Text(menuBarCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Issue #242 (Tim's suggestion): an Accessibility home for
            // presentation aids that are OFF by default because the
            // defaults already don't rely on color alone.
            Section("Accessibility") {
                Toggle("Show health verdict labels", isOn: binding(
                    get: { $0.deckHealthLabelsMode.showsVerdictWord },
                    set: { model, on in
                        await model.setDeckHealthLabels(
                            on ? DeckHealthLabels.showStored
                               : DeckHealthLabels.dotOnlyStored
                        )
                    }
                ))
                .help("Shows the verdict word (Green / Yellow / Red) beside each provider's availability dot on the deck. Off, the dot alone carries the verdict — its shape changes with the verdict (green circle, yellow triangle, red octagon, hollow ring while there is no data), so color is never the only signal, and the word stays one click away in the chip's detail popover. VoiceOver always speaks the full verdict either way.")
            }

            // Issue #204 (Tim approved direction): shared user scope —
            // user-scope MCP registrations + user memory as one set across
            // every managed Claude account, opt-in, enable runs a disclosed
            // one-time merge. Rendered ONLY when the daemon reports the
            // feature (`/api/state` `sharedScope` — the #174 precedent: an
            // old daemon shows no control instead of a dead one).
            if statusModel.deckState?.sharedScope != nil {
                Section("Claude subscriptions") {
                    sharedScopeControls
                }
            }

            Section("Notifications") {
                Picker("Notify when % left drops below", selection: binding(
                    get: { $0.notificationThresholdPercent },
                    set: { model, value in await model.setNotificationThreshold(percent: value) }
                )) {
                    ForEach(thresholdOptions, id: \.self) { percent in
                        Text("\(percent)%").tag(percent)
                    }
                }
                Text("One banner per crossing — never repeated on every refresh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Issue #33: NO manual "Check for Updates" button here anymore —
            // opening this pane fires the debounced forced re-probe (see the
            // .task below), the version lines carry a subtle checking state
            // while it runs, and the per-CLI Update pills (PR #38) render
            // from the fresh result. CLI updates and the app's own update
            // (ModelDeck section below) never share a control or wording.
            Section("CLI tools") {
                if let probe = toolsModel.probe {
                    ToolStatusRow(
                        name: "Claude Code",
                        provider: .claude,
                        probe: probe.tools.claude,
                        activeAccount: activeAccountStatus(for: .claude),
                        updatePhase: updateModel.phase(for: "claude"),
                        isProbing: toolsModel.isChecking,
                        onUpdate: { Task { await updateModel.update(tool: "claude") } },
                        onDismissOutcome: { updateModel.dismissOutcome(tool: "claude") }
                    )
                    ToolStatusRow(
                        name: "Codex CLI",
                        provider: .codex,
                        probe: probe.tools.codex,
                        activeAccount: activeAccountStatus(for: .codex),
                        updatePhase: updateModel.phase(for: "codex"),
                        isProbing: toolsModel.isChecking,
                        onUpdate: { Task { await updateModel.update(tool: "codex") } },
                        onDismissOutcome: { updateModel.dismissOutcome(tool: "codex") }
                    )
                } else {
                    Text(toolsModel.isChecking ? "Checking versions…" : "No probe data yet.")
                        .foregroundStyle(.secondary)
                }
                if let error = toolsModel.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Issue #96: bundled background-service status; when a dev
            // LaunchAgent install exists this section is the ONLY place the
            // takeover can be triggered (explicit, confirmed action).
            BackgroundServiceSection(model: daemonSetupModel)

            // Issue #422: the first-launch choice, revisitable — the ONLY
            // place it can be changed after launch, and the only home of the
            // rollback that prints the user's own launchd restore steps.
            ManagedProxySection(
                model: proxyOnboardingModel,
                available: managedProxyAvailable
            )

            // Issue #524: whether receipts can name the profile that spent a
            // request, plus the consented config-write flow when one is in
            // progress. Both inputs are nil until the per-profile key path has
            // an owner in the app, and the surface is silent until then by
            // decision (ClientKeyAttributionSurface) rather than by accident —
            // a permanent row about a feature nothing can reach yet is the
            // nagging #445 ruled out.
            ClientKeyAttributionSection(wiring: nil, consentModel: nil)

            Section {
                Toggle("Launch at login", isOn: Binding(
                    get: { launchAtLoginModel.isEnabled },
                    set: { launchAtLoginModel.setEnabled($0) }
                ))
                if let launchAtLoginError = launchAtLoginModel.lastError {
                    Text(launchAtLoginError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            // Issue #33: ModelDeck's OWN update surface — a clearly separate
            // section so app updates can never be conflated with the CLI
            // rows above (distinct wording throughout: "Check for App
            // Updates" / "View Release" vs. the CLI "Update" pills).
            // Final placement decision (Tim, 2026-07-20): the PRIMARY
            // affordance is the gear-menu "Check for App Updates…" item in
            // the popover; this section keeps the version display and this
            // check button as a deliberate mirror — both drive the same
            // shared AppUpdateModel, so their states always agree.
            Section("ModelDeck") {
                LabeledContent("Version") {
                    Text(appUpdateModel.currentVersion ?? "Unknown (development build)")
                        .foregroundStyle(.secondary)
                }
                Text("Last checked: " + (appUpdateAutoChecker.lastCheckAt.map {
                    Self.lastCheckFormatter.string(from: $0)
                } ?? "Never"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // Issue #60: automatic checks reuse the exact same feed and
                // model as the manual button below — the only difference is
                // who initiates. App-local preference (like Launch at
                // Login); the daemon never stores it.
                Toggle("Check for updates automatically", isOn: Binding(
                    get: { appUpdateAutoChecker.isEnabled },
                    set: { appUpdateAutoChecker.setEnabled($0) }
                ))
                // Issue #241: cadence copy tracks AppUpdateAutoChecker's
                // interval (now every few hours, was daily) — the toggle's
                // behavior is otherwise untouched.
                .help(appUpdateInstallModel.canInstall
                    ? "Every few hours, check the update feed for a newer version."
                    : "Every few hours, check the releases feed and show a notification when a newer version is out. Nothing installs automatically.")
                if appUpdateInstallModel.canInstall {
                    // Issue #121 (Tim directive 2026-07-22, default ON):
                    // quiet install on relaunch. App-local preference; the
                    // daemon never stores it.
                    Toggle("Install updates automatically", isOn: Binding(
                        get: { appUpdateInstallModel.isAutoInstallEnabled },
                        set: { appUpdateInstallModel.setAutoInstall($0) }
                    ))
                    // Issue #241: "installs the next time ModelDeck
                    // relaunches" promised an event that never happens on
                    // an always-running menu-bar app — the staged prompt's
                    // restart offer is the honest follow-through.
                    .help("Downloads a found update in the background; ModelDeck then offers a one-click restart to finish. Off: updates wait for Update Now.")
                    Text(appUpdateAutoChecker.isEnabled
                        ? (appUpdateInstallModel.isAutoInstallEnabled
                            ? "Checks every few hours; new versions download quietly and ModelDeck offers a restart when they're ready."
                            : "Checks every few hours, with a notification when a new version exists — installs only when you choose Update Now.")
                        : "Automatic checks are off — updates are found only when you check manually.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Checks every few hours, with a notification when a new version exists — nothing installs automatically in this build.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Toggle("Beta Releases", isOn: $betaReleases)
                    .help("Opt in to preview builds that may be unstable.")
                HStack {
                    Button("Check for App Updates") {
                        // Issue #675: explicitCheck(), like the gear menu and
                        // the context menu since #170 — plain check() no-ops
                        // when the 4-hourly background check is already in
                        // flight, which silently dropped this click. The
                        // dialog it returns is unused here: the inline status
                        // line below is this surface's feedback.
                        Task { _ = await appUpdateModel.explicitCheck() }
                    }
                    .disabled(appUpdateModel.isChecking)
                    .help(appUpdateInstallModel.canInstall
                        ? "Check the ModelDeck releases feed on GitHub. Installing is a separate, explicit step."
                        : "Check the ModelDeck releases feed on GitHub. Nothing installs automatically.")
                    if appUpdateModel.isChecking {
                        ProgressView().controlSize(.small)
                    }
                    Button("Release Notes") {
                        switch AppReleaseNotes.resolve(
                            currentVersion: appUpdateModel.currentVersion,
                            latestRelease: appUpdateModel.latestKnownRelease
                        ) {
                        case .inApp(_, let body): releaseNotes = body
                        case .web(let url): openURL(url)
                        }
                    }
                    if case .updateAvailable = appUpdateModel.phase,
                       appUpdateModel.canInstallUpdates, !appUpdateInstallModel.isBusy {
                        Button("Update Now") { appUpdateInstallModel.updateNow() }
                            .help("Downloads, verifies, and installs the update, then relaunches ModelDeck.")
                    }
                    if let target = appRollbackModel.target {
                        Button("Rollback to \(target.shortVersionString)") { rollbackConfirmation = target }
                            .disabled(appRollbackModel.isBusy)
                    }
                    Button("Get Previous Builds") {
                        openURL(URL(string: "https://github.com/timharris707/modeldeck/releases")!)
                    }
                }
                .task { await appRollbackModel.refreshTarget() }
                .sheet(isPresented: Binding(
                    get: { rollbackConfirmation != nil },
                    set: { if !$0 { rollbackConfirmation = nil } }
                )) {
                    if let target = rollbackConfirmation {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Rollback to \(target.shortVersionString)?").font(.headline)
                            Text("ModelDeck will download this version, replace the app, and restart. Your settings and data are kept. Version \(appUpdateModel.currentVersion ?? "you are leaving") will not be offered again until you choose Check for App Updates.")
                            HStack {
                                Spacer()
                                Button("Cancel") { rollbackConfirmation = nil }
                                    .keyboardShortcut(.cancelAction)
                                Button("Rollback and Restart") {
                                    rollbackConfirmation = nil
                                    Task { await appRollbackModel.rollback(to: target) }
                                }
                            }
                        }
                        .padding(24)
                        .frame(width: 420)
                    }
                }
                rollbackStatusLine
                appUpdateStatusLine
                installStatusLine
            }

            if let error = settingsSync.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: Binding(
            get: { releaseNotes != nil },
            set: { if !$0 { releaseNotes = nil } }
        )) {
            VStack(alignment: .leading, spacing: 12) {
                Text("ModelDeck \(appUpdateModel.currentVersion ?? "")")
                    .font(.headline)
                ScrollView {
                    Text(AppUpdateDialogView.attributedNotes(releaseNotes ?? ""))
                        .font(.callout)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                HStack {
                    Spacer()
                    Button("Done") { releaseNotes = nil }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
            .frame(width: 360, alignment: .leading)
        }
        // Issue #204: nothing is sent to the daemon until this sheet's
        // explicit confirm — the toggle itself never mutates anything.
        .sheet(isPresented: Binding(
            get: { sharedScopeModel.confirmationTarget != nil },
            set: { if !$0 { sharedScopeModel.cancelConfirmation() } }
        )) {
            SharedScopeConfirmationSheet(
                target: sharedScopeModel.confirmationTarget ?? true,
                // confirmPending() consumes the target SYNCHRONOUSLY before
                // the sheet's dismissal echo (`isPresented` → cancel) can
                // clear it — the PR #207 review race: a Task that read the
                // target after dismissal would silently no-op.
                onConfirm: { sharedScopeModel.confirmPending() },
                onCancel: { sharedScopeModel.cancelConfirmation() }
            )
        }
        // Issue #33: pane appear → automatic CLI re-probe (debounced in the
        // model; the daemon's /api/tools?refresh=1 cache absorbs the rest).
        // Users never have to ask the app to look for CLI updates.
        .task {
            // Settings can open before the popover ever shows; load() is a
            // one-shot, so whichever surface appears first pays the single
            // SMAppService status read.
            launchAtLoginModel.load()
            await toolsModel.probeOnPaneOpen()
        }
    }

    /// Issue #204 — the shared-user-scope controls. State honesty: the
    /// toggle always renders the daemon-reported `sharedScope.enabled`
    /// (state wins over local optimism, the #68 echo-loop discipline); its
    /// setter only raises the confirmation sheet, so a cancelled sheet
    /// simply snaps the switch back to the truth. While the op runs the
    /// controls disable behind a calm progress line; the finished op's
    /// disclosed outcome (merged counts, conflicts, skipped) renders inline
    /// until dismissed.
    @ViewBuilder
    private var sharedScopeControls: some View {
        let enabled = SharedScopeModel.isEnabled(
            state: statusModel.deckState,
            settings: settingsSync.settings
        )
        Toggle(SharedScope.toggleTitle, isOn: Binding(
            get: { enabled },
            set: { sharedScopeModel.requestChange(to: $0, currentlyEnabled: enabled) }
        ))
        .disabled(sharedScopeModel.isBusy)
        .help(SharedScope.toggleHelp)
        if let target = sharedScopeModel.runningTarget {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(target ? SharedScope.enableProgress : SharedScope.disableProgress)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            // State-honest caption (the #196 precedent): describe what is
            // actually in effect, never a hypothetical.
            Text(enabled ? SharedScope.enabledCaption : SharedScope.disabledCaption)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if case .finished(let outcome) = sharedScopeModel.phase {
            SharedScopeOutcomeView(
                presentation: SharedScope.presentation(for: outcome),
                onDismiss: { sharedScopeModel.dismissOutcome() }
            )
        }
        if let info = sharedScopeModel.infoText {
            // The tolerated 409 — calm, never an error tone.
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(info)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                sharedScopeDismiss
            }
        }
        if let error = sharedScopeModel.errorText {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                sharedScopeDismiss
            }
        }
    }

    private var sharedScopeDismiss: some View {
        Button(action: { sharedScopeModel.dismissOutcome() }) {
            Image(systemName: "xmark")
                .font(.system(size: 8))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Dismiss shared-scope result")
    }

    // Issue #706: rollback uses the same compact feedback as app installs.
    @ViewBuilder private var rollbackStatusLine: some View {
        switch appRollbackModel.phase {
        case .idle: EmptyView()
        case .failed(let message):
            Text(message).font(.caption).foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        default:
            HStack(spacing: 8) {
                if case .downloading(let fraction) = appRollbackModel.phase {
                    ProgressView(value: fraction).frame(width: 80)
                } else {
                    ProgressView().controlSize(.small)
                }
                Text(rollbackStatusText).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var rollbackStatusText: String {
        switch appRollbackModel.phase {
        case .downloading: "Downloading previous version…"
        case .verifying: "Verifying previous version…"
        case .swapping: "Replacing ModelDeck…"
        case .relaunching: "Restarting ModelDeck…"
        case .idle, .failed: ""
        }
    }

    /// Outcome line under "Check for App Updates". Issue #121 (Tim
    /// directive 2026-07-22): in Sparkle-configured builds the primary
    /// action is "Update Now" (download → verify → install → relaunch) with
    /// "Release Notes" secondary; builds without the installer keep the
    /// honest "View Release" hand-off.
    @ViewBuilder
    private var appUpdateStatusLine: some View {
        switch appUpdateModel.phase {
        case .idle:
            EmptyView()
        case .checking:
            EmptyView()
        case .upToDate(let latest):
            Text("Up to date — \(latest) is the latest release.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .updateAvailable(let release):
            // Issue #163: the instant Update Now is clicked this actionable
            // row is REPLACED by the progress surface (installStatusLine
            // below) — a still-enabled-looking offer next to an invisible
            // install is exactly Tim's "it's not working" report.
            if !appUpdateInstallModel.isBusy {
                HStack(spacing: 8) {
                    Text("Version \(release.version) is available.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    if !appUpdateModel.canInstallUpdates {
                        Button("View Release") { openURL(release.url) }
                            .controlSize(.small)
                            .help("Opens the GitHub release page — download and install from there.")
                    }
                }
            }
        case .unavailable(let message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Issue #121: honest install progress/outcome under the row — the same
    /// shared state the deck popover renders, so the surfaces always agree.
    /// Issue #163: while the install runs this is the full progress surface
    /// (stage copy + bar + Cancel while Sparkle permits), not a caption.
    @ViewBuilder
    private var installStatusLine: some View {
        if appUpdateInstallModel.isBusy {
            AppUpdateInstallProgressView(installModel: appUpdateInstallModel)
        } else if let status = AppUpdateInstallModel.statusText(for: appUpdateInstallModel.phase) {
            // Issue #303 (Tim's 0.3.24→0.3.25 field report): THIS caption is
            // where he read "installs the next time ModelDeck relaunches"
            // and found nothing to click — he quit the app by hand. A staged
            // status never renders without its one-click follow-through.
            HStack(spacing: 8) {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(installFailed ? .red : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let restart = AppUpdateInstallModel.restartActionTitle(
                    for: appUpdateInstallModel.phase
                ) {
                    Button(restart) { appUpdateInstallModel.updateNow() }
                        .controlSize(.small)
                        .help(AppUpdateInstallModel.restartActionHelp)
                        .accessibilityLabel("Restart ModelDeck to finish updating")
                }
            }
        }
    }

    private var installFailed: Bool {
        if case .failed = appUpdateInstallModel.phase { return true }
        return false
    }

    /// The provider's active (default) account, for the CLI-row chip
    /// caption. Distinguishes "no subscriptions at all" from "subscriptions exist but
    /// none is active" so the caption never claims nothing is set up when
    /// something is.
    private func activeAccountStatus(for provider: DeckProvider) -> ToolStatusRow.ActiveAccountStatus {
        let accounts = (statusModel.deckState?.accounts ?? []).filter {
            DeckProvider.from($0.provider) == provider
        }
        if let active = accounts.first(where: { $0.isDefault }) {
            return .active(label: active.label)
        }
        return accounts.isEmpty ? .noAccounts : .noneActive
    }

    /// The menu-bar pin picker's account rows: every account in the deck
    /// (provider-prefixed so same-named accounts across providers stay
    /// distinguishable), plus a placeholder row for a pinned id that no
    /// longer resolves — SwiftUI Pickers must always contain their current
    /// selection, and the fallback row keeps a removed account's pin
    /// visible (and re-pickable away from) instead of rendering blank.
    private var menuBarAccountOptions: [(id: String, title: String)] {
        var options = (statusModel.deckState?.accounts ?? []).map { account in
            let provider = DeckProvider.from(account.provider)?.displayName ?? account.provider
            return (id: account.id, title: "\(provider) — \(account.label)")
        }
        // Issue #292: matched on the pin's base so a window-choice suffix
        // never earns a spurious "Removed subscription" ghost row.
        let current = MenuBarPinResolver.pinBase(settingsSync.settings.menuBarAccountId)
        // Follow-active sentinels, the #229 "none" sentinel, and the #235
        // health sentinels have their own static rows above. (An
        // unrecognized "health:<future>" value still earns the fallback
        // row — this build treats it exactly like a removed pin.)
        if !current.isEmpty && !current.hasPrefix("active:")
            && !MenuBarPinResolver.isNone(current)
            && !MenuBarPinResolver.isHealth(current)
            && !MenuBarPinResolver.isTotal(current)
            && !options.contains(where: { $0.id == current }) {
            options.append((id: current, title: "Removed subscription"))
        }
        return options
    }

    /// Issue #482/#488: the Total shown as selection — the SHARED
    /// per-provider format (`poolTotalFormat` first, the pin's 1.0.2
    /// `|fmt:` suffix as the migration read). Writes go through
    /// `setPoolTotalFormat`, which updates the shared key and keeps the
    /// pin suffix in agreement — the deck header flips with it.
    private func totalFormatBinding(provider: DeckProvider) -> Binding<MenuBarPinResolver.TotalFormat> {
        binding(
            get: {
                MenuBarPinResolver.resolvedTotalFormat(
                    provider: provider,
                    poolFormats: $0.poolTotalFormat,
                    menuBarSetting: $0.menuBarAccountId
                )
            },
            set: { model, format in
                await model.setPoolTotalFormat(provider: provider, format: format)
            }
        )
    }

    /// Issue #292: the pinned account id when the current selection is a
    /// plain account pin — nil for every sentinel mode, so the Pinned
    /// window picker renders only where a window choice can apply.
    private var pinnedAccountBase: String? {
        let base = MenuBarPinResolver.pinBase(settingsSync.settings.menuBarAccountId)
        guard !base.isEmpty,
              !base.hasPrefix("active:"),
              !MenuBarPinResolver.isNone(base),
              !MenuBarPinResolver.isHealth(base),
              !MenuBarPinResolver.isTotal(base)
        else { return nil }
        return base
    }

    /// Issue #292: the Pinned window selection — the stored pin's window
    /// key ("" = lowest, the default). Writes recompose the full pin value
    /// so the account and its window choice travel as one setting.
    private func pinWindowBinding(base: String) -> Binding<String> {
        binding(
            get: { MenuBarPinResolver.pinWindow($0.menuBarAccountId)?.rawValue ?? "" },
            set: { model, key in
                await model.setMenuBarAccount(id: MenuBarPinResolver.pinnedValue(
                    accountId: base,
                    window: MenuBarPinResolver.PinWindow(rawValue: key)
                ))
            }
        )
    }

    /// Issue #292: the Pinned window rows — "Lowest window" plus only the
    /// window classes the account actually reports (CodeRabbit, this PR:
    /// offering a class the account never has invites a dead choice), each
    /// named from the account's own window ("Weekly · Fable"). A stored
    /// choice whose class isn't reported right now earns a ghost row —
    /// SwiftUI pickers must contain their current selection, and the
    /// "(not reported)" suffix says why the number fell back to lowest.
    private func pinWindowOptions(base: String) -> [(key: String, title: String)] {
        var options: [(key: String, title: String)] = [(key: "", title: "Lowest window")]
        let scopes = (statusModel.deckState?.usage ?? [])
            .filter { $0.accountId == base }
            .map(\.scope)
        for choice in MenuBarPinResolver.PinWindow.allCases {
            if let scope = scopes.first(where: { choice.matches(scope: $0) }) {
                options.append((key: choice.rawValue, title: DeckBuilder.windowTitle(for: scope)))
            }
        }
        if let current = MenuBarPinResolver.pinWindow(settingsSync.settings.menuBarAccountId),
           !options.contains(where: { $0.key == current.rawValue }) {
            options.append((key: current.rawValue, title: "\(current.genericTitle) (not reported)"))
        }
        return options
    }

    /// The Menu bar section's state-honest caption (issue #229 adds the
    /// icon-only branch): every mode names its own display behavior, and
    /// the modes that change what's shown reaffirm that notifications keep
    /// watching every account.
    /// Issue #238: WHEN the menu bar shows its indicator, as stored —
    /// values that don't apply to the selected display mode read as always,
    /// so switching modes shows the honest effective state, not a stale
    /// selection from the other mode.
    private var effectiveShowWhen: MenuBarShowWhen {
        let mode = settingsSync.settings.menuBarShowWhenMode
        if MenuBarPinResolver.isHealth(settingsSync.settings.menuBarAccountId) {
            switch mode {
            case .yellowOrWorse, .redOnly: return mode
            case .always, .belowPercent: return .always
            }
        }
        if case .belowPercent = mode { return mode }
        return .always
    }

    /// The active percentage-mode visibility threshold; nil while Always.
    private var quietPercentThreshold: Int? {
        effectiveShowWhen.percentThreshold
    }

    /// Health-mode "Show it" selection: stored value in, stored value out.
    private var healthShowWhenBinding: Binding<String> {
        binding(
            get: { [effectiveShowWhen] _ in effectiveShowWhen.stored },
            set: { model, value in await model.setMenuBarShowWhen(value) }
        )
    }

    /// Percentage-mode "Show it" selection (Always / Only below a
    /// threshold). Enabling prefills the threshold from the notification
    /// setting ("Notify when % left drops below") — the natural "needs
    /// attention" line the user already chose — but the value is stored
    /// independently in `menuBarShowWhen`, so editing one never moves the
    /// other.
    private var percentQuietEnabledBinding: Binding<Bool> {
        binding(
            get: { [quietPercentThreshold] _ in quietPercentThreshold != nil },
            set: { model, enabled in
                await model.setMenuBarShowWhen(
                    enabled
                        ? MenuBarShowWhen.belowPercent(
                            Self.clampPercent(model.settings.notificationThresholdPercent)
                        ).stored
                        : MenuBarShowWhen.alwaysStored
                )
            }
        )
    }

    /// The inline editable threshold (1–99; out-of-range input clamps).
    private var quietThresholdBinding: Binding<Int> {
        binding(
            get: { [quietPercentThreshold] settings in
                quietPercentThreshold ?? Self.clampPercent(settings.notificationThresholdPercent)
            },
            set: { model, value in
                await model.setMenuBarShowWhen(
                    MenuBarShowWhen.belowPercent(Self.clampPercent(value)).stored
                )
            }
        )
    }

    private static func clampPercent(_ value: Int) -> Int {
        min(max(value, 1), 99)
    }

    private var menuBarCaption: String {
        let current = settingsSync.settings.menuBarAccountId
        if MenuBarPinResolver.isNone(current) {
            return "The menu bar shows only the ModelDeck icon — never a percentage. Notifications still watch every subscription."
        }
        // Issue #235: the health modes name their own display behavior,
        // like every other branch here; #238 adds the quiet variants —
        // each states that hiding is display-only so silence never reads
        // as "no alerts".
        if let provider = MenuBarPinResolver.healthProvider(current) {
            switch effectiveShowWhen {
            case .yellowOrWorse:
                return "The \(provider.displayName) availability status dot appears only while the verdict is Yellow or Red — while it's green, just the plain icon. Display only: notifications still watch every subscription."
            case .redOnly:
                return "The \(provider.displayName) availability status dot appears only while the verdict is Red — otherwise just the plain icon. Display only: notifications still watch every subscription."
            case .always, .belowPercent:
                return "The menu bar shows \(provider.displayName)'s availability health as a colored status dot — green circle, yellow triangle, or red octagon from the 7-day runway simulation — instead of a percentage. Notifications still watch every subscription."
            }
        }
        // Issue #482: the total modes name their number's construction —
        // a sum can read above 100%, and the quiet threshold gates on the
        // share form in either format (a 1–99 gate can't judge a 474).
        if let provider = MenuBarPinResolver.totalProvider(current) {
            let base = MenuBarPinResolver.resolvedTotalFormat(
                provider: provider,
                poolFormats: settingsSync.settings.poolTotalFormat,
                menuBarSetting: current
            ) == .share
                ? "The menu bar shows \(provider.displayName)'s pool total as a share of capacity — the summed % left divided by the counted subscriptions' combined capacity (100% each)."
                : "The menu bar shows the total % left summed across \(provider.displayName) subscriptions — the deck column header's number, so it can read above 100%."
            if let threshold = quietPercentThreshold {
                return base + " It appears only while the share of capacity is below \(threshold)% — otherwise just the icon. Display only: notifications still watch every subscription."
            }
            return base + " Notifications still watch every subscription."
        }
        if let threshold = quietPercentThreshold {
            if current.isEmpty {
                return "The percentage appears only when the lowest subscription drops below \(threshold)% — otherwise just the icon. Display only: notifications still watch every subscription."
            }
            return "The pinned subscription's percentage appears only when it drops below \(threshold)% — otherwise just the icon. Display only: notifications still watch every subscription."
        }
        if current.isEmpty {
            return "The percentage appears only when any subscription drops below the warning threshold."
        }
        // Issue #292: a pin carrying a window choice names the window it
        // shows — and the honest fallback when that window isn't reported.
        if let choice = MenuBarPinResolver.pinWindow(current) {
            let window = pinnedAccountBase.flatMap { base in
                (statusModel.deckState?.usage ?? [])
                    .first { $0.accountId == base && choice.matches(scope: $0.scope) }
                    .map { DeckBuilder.windowTitle(for: $0.scope) }
            } ?? choice.genericTitle
            return "The pinned subscription's \(window) percentage stays visible while that window is reported; if it isn't, the subscription's lowest usable window is shown instead. Notifications still watch every subscription."
        }
        return "The pinned subscription's percentage stays visible while it has a usable non-spend window; otherwise the plain glyph is shown. Notifications still watch every subscription."
    }

    /// Threshold choices (daemon validates 1–99). Includes the current value
    /// even if it isn't one of the presets.
    private var thresholdOptions: [Int] {
        var options = [5, 10, 15, 20, 25, 30, 40, 50]
        let current = settingsSync.settings.notificationThresholdPercent
        if !options.contains(current) { options.append(current) }
        return options.sorted()
    }

    private var intervalOptions: [Int] {
        var options = Self.intervalChoices
        let current = settingsSync.settings.autoRefreshIntervalSeconds
        if !options.contains(current) { options.append(current) }
        return options.sorted()
    }

    private static func intervalLabel(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds) s" }
        let minutes = seconds / 60
        if seconds % 60 != 0 { return "\(minutes) min \(seconds % 60) s" }
        if minutes < 60 { return minutes == 1 ? "1 minute" : "\(minutes) minutes" }
        return "1 hour"
    }

    /// A binding over the daemon-confirmed settings: reads come from the
    /// last accepted document; writes go through the async PUT (which only
    /// republishes on daemon confirmation, so a rejected save snaps the
    /// control back).
    private func binding<Value: Equatable & Sendable>(
        get: @escaping (DaemonSettings) -> Value,
        set: @escaping @MainActor (SettingsSyncModel, Value) async -> Void
    ) -> Binding<Value> {
        Binding(
            get: { get(settingsSync.settings) },
            set: { newValue in
                guard newValue != get(settingsSync.settings) else { return }
                let model = settingsSync
                Task { @MainActor in await set(model, newValue) }
            }
        )
    }
}

struct ToolStatusRow: View {
    /// Whether the provider has an active (default) account — and if not,
    /// whether that's because there are no accounts at all or because none
    /// of the existing ones is active. The two get distinct captions.
    enum ActiveAccountStatus: Equatable {
        case active(label: String)
        case noneActive
        case noAccounts
    }

    let name: String
    let provider: DeckProvider
    let probe: ToolProbe
    var activeAccount: ActiveAccountStatus = .noAccounts
    var updatePhase: ToolUpdateModel.Phase?
    /// Issue #33: true while the pane-open forced probe is in flight — the
    /// version line dims with a mini spinner (subtle checking state) until
    /// the fresh result lands.
    var isProbing: Bool = false
    var onUpdate: (() -> Void)?
    var onDismissOutcome: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ProviderMarkView(provider: provider, size: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.system(size: 12.5, weight: .medium))
                HStack(spacing: 6) {
                    Text(probe.versionSummary)
                        .font(.caption)
                        .foregroundStyle(probe.updateAvailable == true ? .orange : .secondary)
                        .opacity(isProbing ? 0.45 : 1)
                    if isProbing {
                        ProgressView()
                            .controlSize(.mini)
                            .help("Re-checking installed and latest versions")
                    }
                    // Issue #32 item 3 — the update pill. Shown while an
                    // update is available and no attempt is in flight or
                    // pending dismissal; the daemon single-flights the run.
                    if probe.updateAvailable == true, updatePhase == nil, let onUpdate {
                        Button("Update", action: onUpdate)
                            .font(.system(size: 10, weight: .medium))
                            .buttonStyle(.borderedProminent)
                            .controlSize(.mini)
                            .help("Run \(name)'s own updater via the daemon (npm or Homebrew, whichever installed it)")
                            .accessibilityLabel("Update \(name)")
                    }
                }
                updateOutcomeLine
                if let error = probe.error {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            // Item 4: the chip is the ACTIVE account's auth state (daemon
            // contract) — captioned with that account's name so the row
            // never reads as a provider-wide claim. Health for every other
            // account lives in the Accounts pane.
            VStack(alignment: .trailing, spacing: 2) {
                HealthChipView(chip: probe.healthChip)
                Text(activeAccountCaption)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            .help(activeAccountHelp)
        }
    }

    private var activeAccountCaption: String {
        switch activeAccount {
        case .active(let label): return "Active: \(label)"
        case .noneActive: return "No active subscription"
        case .noAccounts: return "No subscriptions"
        }
    }

    private var activeAccountHelp: String {
        switch activeAccount {
        case .active(let label):
            return "Auth state of the active subscription (\(label)). Per-subscription health is in the Subscriptions pane."
        case .noneActive:
            return "\(provider.displayName) subscriptions exist but none is active — activate one in the Subscriptions pane."
        case .noAccounts:
            return "No \(provider.displayName) subscriptions are set up yet"
        }
    }

    @ViewBuilder
    private var updateOutcomeLine: some View {
        switch updatePhase {
        case .running:
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text("Updating…")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        case .succeeded(let newVersion):
            HStack(spacing: 5) {
                Text(newVersion.map { "Updated to \($0)" } ?? "Updated")
                    .font(.caption2)
                    .foregroundStyle(.green)
                dismissButton
            }
        case .failed(let message):
            HStack(alignment: .top, spacing: 5) {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                dismissButton
            }
        case nil:
            EmptyView()
        }
    }

    @ViewBuilder
    private var dismissButton: some View {
        if let onDismissOutcome {
            Button(action: onDismissOutcome) {
                Image(systemName: "xmark")
                    .font(.system(size: 8))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Dismiss update result for \(name)")
        }
    }
}

// MARK: - Shared user scope (issue #204)

/// The pre-op confirmation sheet, house style (the AccountEditSheet frame):
/// what will be shared, what never is, and that the one-time merge is
/// reversible — stated BEFORE anything runs. All copy is single-sourced in
/// `SharedScope` so the sheet and the toggle's tooltip can never drift.
struct SharedScopeConfirmationSheet: View {
    /// True = enabling (merge), false = disabling (restore).
    let target: Bool
    // Both actions clear the model's confirmationTarget, and the sheet's
    // `isPresented` binding dismisses on that — no environment dismiss()
    // here, so dismissal can never race the confirm capture (PR #207
    // review).
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(target ? SharedScope.enableTitle : SharedScope.disableTitle)
                .font(.headline)
            VStack(alignment: .leading, spacing: 8) {
                if target {
                    sheetLine(glyph: "arrow.triangle.merge", text: SharedScope.enableShares)
                    sheetLine(glyph: "lock", text: SharedScope.enableNeverShares)
                    sheetLine(glyph: "arrow.uturn.backward", text: SharedScope.enableMerge)
                } else {
                    sheetLine(glyph: "arrow.uturn.backward", text: SharedScope.disableRestores)
                    sheetLine(glyph: "lock", text: SharedScope.disableNeverShared)
                }
            }
            HStack {
                Spacer()
                Button("Cancel") {
                    onCancel()
                }
                .keyboardShortcut(.cancelAction)
                Button(target ? SharedScope.enableConfirm : SharedScope.disableConfirm) {
                    onConfirm()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 380)
    }

    private func sheetLine(glyph: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: glyph)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 14)
            Text(text)
                .font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The finished op's disclosed outcome, rendered calmly inline under the
/// toggle: merged counts headline, one line per resolved conflict (name +
/// which account's version won), one line per skipped item with the
/// daemon's reason verbatim. Dismissible; never an alarm tone — every line
/// here describes work that completed as disclosed.
struct SharedScopeOutcomeView: View {
    let presentation: SharedScope.OutcomePresentation
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(presentation.headline)
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Dismiss shared-scope result")
            }
            // Position-keyed ids (PR #207 review): identical lines are
            // legitimate — the same skip reason from two profiles — and
            // `id: \.self` would collide and drop rows. The lists are
            // rebuilt whole per outcome, so offsets are stable ids here.
            ForEach(Array(presentation.conflictLines.enumerated()), id: \.offset) { _, line in
                detailLine(line)
            }
            ForEach(Array(presentation.skippedLines.enumerated()), id: \.offset) { _, line in
                detailLine(line)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func detailLine(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, 14)
    }
}

// MARK: - Hex color helpers

extension Color {
    /// "#RRGGBB" → Color; nil for anything else. Accounts store colors as
    /// hex strings in the daemon (src/db.mjs defaults e.g. "#d97757").
    init?(hexString: String?) {
        guard var hex = hexString?.trimmingCharacters(in: .whitespaces), !hex.isEmpty else { return nil }
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    /// Color → "#rrggbb" (sRGB); nil when the color can't be resolved.
    var hexString: String? {
        guard let rgb = NSColor(self).usingColorSpace(.sRGB) else { return nil }
        let r = Int((rgb.redComponent * 255).rounded())
        let g = Int((rgb.greenComponent * 255).rounded())
        let b = Int((rgb.blueComponent * 255).rounded())
        return String(format: "#%02x%02x%02x", r, g, b)
    }
}
