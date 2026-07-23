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
    @ObservedObject var updateModel: ToolUpdateModel
    /// Issue #33: the app's own update check — a strictly separate surface
    /// from CLI updates (never a shared control or wording).
    @ObservedObject var appUpdateModel: AppUpdateModel
    /// Issue #60: the "Check for updates automatically" toggle's model.
    @ObservedObject var appUpdateAutoChecker: AppUpdateAutoChecker
    /// Issue #121: in-app install state + "Install updates automatically".
    @ObservedObject var appUpdateInstallModel: AppUpdateInstallModel
    /// Issue #96: bundled background-service status + legacy takeover.
    @ObservedObject var daemonSetupModel: DaemonSetupModel
    /// Shared launch-at-login state; the SMAppService status read lives in
    /// the model's load(), not in any view-struct initializer.
    @ObservedObject var launchAtLoginModel: LaunchAtLoginModel

    var body: some View {
        // Issue #118: the tab selection is model state so the deck's
        // "Sign in again…" action can land the window on Accounts even
        // when the user last viewed General.
        TabView(selection: $deckModel.settingsPane) {
            AccountsSettingsPane(
                statusModel: statusModel,
                accountsModel: accountsModel,
                addAccountModel: addAccountModel,
                deckModel: deckModel,
                signInModel: signInModel
            )
            .tabItem { Label("Accounts", systemImage: "person.2") }
            .tag(SettingsPane.accounts)

            GeneralSettingsPane(
                settingsSync: settingsSync,
                toolsModel: toolsModel,
                statusModel: statusModel,
                deckModel: deckModel,
                updateModel: updateModel,
                appUpdateModel: appUpdateModel,
                appUpdateAutoChecker: appUpdateAutoChecker,
                appUpdateInstallModel: appUpdateInstallModel,
                daemonSetupModel: daemonSetupModel,
                launchAtLoginModel: launchAtLoginModel
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

    @State private var editingAccount: DeckAccount?
    @State private var removalCandidate: DeckAccount?
    @State private var isAddingAccount = false

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
                    : "No accounts yet. Click Add Account to connect one.")
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
                Button("Add Account…") { isAddingAccount = true }
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
        .sheet(item: $editingAccount) { account in
            AccountEditSheet(account: account, accountsModel: accountsModel)
        }
        .confirmationDialog(
            "Remove \(removalCandidate?.label ?? "account")?",
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
            Text("Removes only ModelDeck's reference to this account. Provider credentials and sign-ins are never touched.")
        }
        .task { await statusModel.refresh() }
    }

    @ViewBuilder
    private func accountRow(_ account: DeckAccount, in section: AccountsRosterSection) -> some View {
        let state = statusModel.deckState
        let activationState = state?.activationState(for: section.provider) ?? .unknown
        AccountRosterRow(
            account: account,
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
            onActivate: deckModel.canActivate
                && (!account.isDefault || activationState.needsLinkCompletion)
                ? { Task { await deckModel.activate(activationRow(for: account)) } }
                : nil,
            onSignIn: { Task { await signInModel.beginSignIn(account: account) } },
            onVerifySignIn: { Task { await signInModel.confirmSignedIn(account: account) } },
            onRelaunchSignIn: { signInModel.relaunch(accountID: account.id) },
            onCancelSignIn: { signInModel.cancel(accountID: account.id) },
            onEdit: { editingAccount = account },
            onRemove: { removalCandidate = account }
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
                Button("Retry", action: onRetry)
                    .controlSize(.small)
                    .disabled(isActivationInFlight)
                    .help(banner.retryRunsActivation
                        ? "Run activation again for the affected account. New sessions only — running sessions are never touched."
                        : "Re-check the provider's activation state")
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
    let onEdit: () -> Void
    let onRemove: () -> Void

    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(account.label)
                            .font(.system(size: 12.5, weight: .semibold))
                        if account.isDefault {
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
                                .help("Identity was entered at setup and hasn't been verified against the provider yet")
                                .accessibilityLabel("Identity seeded at setup, not yet verified")
                        }
                    }
                    if let subtitle = account.rosterSubtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                signInControls
                if isBusy || isActivating {
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
                        .help("This account is selected as active but activation isn't in effect yet. Once any blocker is cleared, this lays the active link for new sessions. Running sessions are never touched.")
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
                .help("Edit or remove this account (also on right-click)")
                .accessibilityLabel("Actions for \(account.label)")
                radio
            }
            if let signInError {
                Text(signInError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
                ? "Selected as active, but activation isn't in effect yet — see the notice above. New sessions keep the previous account until activation completes."
                : "Active — new \(providerName) sessions use this account. Running sessions are never touched."
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
        Button("Remove…", role: .destructive, action: onRemove)
            .disabled(isBusy)
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
                Text("Finish login in Terminal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Verify") { onVerifySignIn?() }
                    .controlSize(.small)
                    .help("Check with the provider that this profile is now signed in")
                Button("Relaunch") { onRelaunchSignIn?() }
                    .controlSize(.small)
                    .help("Open Terminal with the provider's login command again")
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
                            ? "This account's sign-in renews when it is next used; its usage data is paused until then"
                            : "This account needs a fresh sign-in"))
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
        }
    }

    /// Issue #149: the clickable chip's base tooltip, honest per tone. Both
    /// launch the exact same provider login in Terminal.
    private var signInChipActionableHelp: String {
        let providerName = DeckProvider.from(account.provider)?.displayName ?? "the provider"
        if account.healthChip == .idleSignIn {
            return "This account's sign-in renews when it is next used; its usage data is paused until then. Launch \(providerName)'s own login in Terminal to refresh now"
        }
        return "Launch \(providerName)'s own login for this account in Terminal"
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
        case .activating: return "Activating this account for sign-in…"
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
    @ObservedObject var settingsSync: SettingsSyncModel
    @ObservedObject var toolsModel: ToolsStatusModel
    /// Issue #32 item 4: the CLI-row chip is the ACTIVE account's auth state
    /// (daemon contract), so the row names that account explicitly.
    @ObservedObject var statusModel: MenuBarStatusModel
    /// Issue #73: owns the app-local "Show account emails" preference the
    /// deck rows read (default off; never synced to the daemon).
    @ObservedObject var deckModel: DeckPopoverModel
    @ObservedObject var updateModel: ToolUpdateModel
    /// Issue #33: app-update check state (GitHub releases feed of the public
    /// repo). Deliberately separate from every CLI update control.
    @ObservedObject var appUpdateModel: AppUpdateModel
    /// Issue #60: the "Check for updates automatically" toggle — daily check
    /// of the SAME releases feed; issue #121 made it the scheduling brain
    /// for Sparkle's quiet install as well.
    @ObservedObject var appUpdateAutoChecker: AppUpdateAutoChecker
    /// Issue #121: "Update Now" + "Install updates automatically" state.
    @ObservedObject var appUpdateInstallModel: AppUpdateInstallModel
    /// Issue #96: bundled background-service status + the only home of the
    /// legacy-LaunchAgent takeover action.
    @ObservedObject var daemonSetupModel: DaemonSetupModel
    /// Shared with the popover gear menu — one status read at load(), one
    /// published value behind both toggles.
    @ObservedObject var launchAtLoginModel: LaunchAtLoginModel

    @Environment(\.openURL) private var openURL

    /// Interval choices inside the daemon's validated 60–3600 s range.
    private static let intervalChoices: [Int] = [60, 120, 300, 600, 900, 1800, 3600]

    var body: some View {
        Form {
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
                Toggle("Show account emails", isOn: $deckModel.showAccountEmails)
                    .help("Show each account's identity (email) under its name in the popover. Off by default; applies to both providers. The Accounts pane always shows identities.")
            }

            // Menu bar percent source (Tim, 2026-07-22): "lowest across
            // accounts" only helps when you're actually using the lowest
            // account — pinning one account makes the menu bar answer
            // "where am I on MY account" at a glance, continuously.
            Section("Menu bar") {
                Picker("Show percentage for", selection: binding(
                    get: { $0.menuBarAccountId },
                    set: { model, value in await model.setMenuBarAccount(id: value) }
                )) {
                    Text("Lowest across all accounts").tag("")
                    // Tim's follow-up: after an account switch the menu bar
                    // should usually track the newly active account — these
                    // follow the provider's ACTIVE account automatically.
                    Text("Active Claude account")
                        .tag(MenuBarPinResolver.followActiveSentinel(for: .claude))
                    Text("Active Codex account")
                        .tag(MenuBarPinResolver.followActiveSentinel(for: .codex))
                    ForEach(menuBarAccountOptions, id: \.id) { option in
                        Text(option.title).tag(option.id)
                    }
                }
                .help("A pinned account shows its lowest non-spend usage window in the menu bar continuously when one is available — normal color while healthy, gold at warning, red at critical; without a usable window the plain glyph is shown. \"Active … account\" follows whichever account is currently active for that provider. \"Lowest across all accounts\" shows a percentage only when some account drops below the warning threshold.")
                Text(settingsSync.settings.menuBarAccountId.isEmpty
                    ? "The percentage appears only when any account drops below the warning threshold."
                    : "The pinned account's percentage stays visible while it has a usable non-spend window; otherwise the plain glyph is shown. Notifications still watch every account.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
                HStack {
                    Button("Check for App Updates") {
                        Task { await appUpdateModel.check() }
                    }
                    .disabled(appUpdateModel.isChecking)
                    .help(appUpdateInstallModel.canInstall
                        ? "Check the ModelDeck releases feed on GitHub. Installing is a separate, explicit step."
                        : "Check the ModelDeck releases feed on GitHub. Nothing installs automatically.")
                    if appUpdateModel.isChecking {
                        ProgressView().controlSize(.small)
                    }
                }
                appUpdateStatusLine
                installStatusLine
                // Issue #60: automatic checks reuse the exact same feed and
                // model as the manual button above — the only difference is
                // who initiates. App-local preference (like Launch at
                // Login); the daemon never stores it.
                Toggle("Check for updates automatically", isOn: Binding(
                    get: { appUpdateAutoChecker.isEnabled },
                    set: { appUpdateAutoChecker.setEnabled($0) }
                ))
                .help(appUpdateInstallModel.canInstall
                    ? "Once a day, check the update feed for a newer version."
                    : "Once a day, check the releases feed and show a notification when a newer version is out. Nothing installs automatically.")
                if appUpdateInstallModel.canInstall {
                    // Issue #121 (Tim directive 2026-07-22, default ON):
                    // quiet install on relaunch. App-local preference; the
                    // daemon never stores it.
                    Toggle("Install updates automatically", isOn: Binding(
                        get: { appUpdateInstallModel.isAutoInstallEnabled },
                        set: { appUpdateInstallModel.setAutoInstall($0) }
                    ))
                    .help("Downloads a found update in the background and installs it the next time ModelDeck relaunches. Off: updates wait for Update Now.")
                    Text(appUpdateAutoChecker.isEnabled
                        ? (appUpdateInstallModel.isAutoInstallEnabled
                            ? "Daily check; new versions download quietly and install when ModelDeck relaunches."
                            : "Daily check with a notification when a new version exists — installs only when you choose Update Now.")
                        : "Automatic checks are off — updates are found only when you check manually.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Daily check with a notification when a new version exists — nothing installs automatically in this build.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let error = settingsSync.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
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
            HStack(spacing: 8) {
                Text("Version \(release.version) is available.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                if appUpdateModel.canInstallUpdates {
                    Button("Update Now") { appUpdateInstallModel.updateNow() }
                        .controlSize(.small)
                        .disabled(appUpdateInstallModel.isBusy)
                        .help("Downloads, verifies, and installs the update, then relaunches ModelDeck.")
                    Button("Release Notes") { openURL(release.url) }
                        .controlSize(.small)
                        .help("Opens the GitHub release page.")
                } else {
                    Button("View Release") { openURL(release.url) }
                        .controlSize(.small)
                        .help("Opens the GitHub release page — download and install from there.")
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
    @ViewBuilder
    private var installStatusLine: some View {
        if let status = AppUpdateInstallModel.statusText(for: appUpdateInstallModel.phase) {
            HStack(spacing: 6) {
                if appUpdateInstallModel.isBusy {
                    ProgressView().controlSize(.small)
                }
                Text(status)
                    .font(.caption)
                    .foregroundStyle(installFailed ? .red : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var installFailed: Bool {
        if case .failed = appUpdateInstallModel.phase { return true }
        return false
    }

    /// The provider's active (default) account, for the CLI-row chip
    /// caption. Distinguishes "no accounts at all" from "accounts exist but
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
        let current = settingsSync.settings.menuBarAccountId
        // Follow-active sentinels have their own static rows above.
        if !current.isEmpty && !current.hasPrefix("active:")
            && !options.contains(where: { $0.id == current }) {
            options.append((id: current, title: "Removed account"))
        }
        return options
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
        case .noneActive: return "No active account"
        case .noAccounts: return "No accounts"
        }
    }

    private var activeAccountHelp: String {
        switch activeAccount {
        case .active(let label):
            return "Auth state of the active account (\(label)). Per-account health is in the Accounts pane."
        case .noneActive:
            return "\(provider.displayName) accounts exist but none is active — activate one in the Accounts pane."
        case .noAccounts:
            return "No \(provider.displayName) accounts are set up yet"
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
