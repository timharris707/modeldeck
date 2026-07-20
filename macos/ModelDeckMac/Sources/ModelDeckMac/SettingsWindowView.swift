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

    var body: some View {
        TabView {
            AccountsSettingsPane(
                statusModel: statusModel,
                accountsModel: accountsModel,
                addAccountModel: addAccountModel,
                deckModel: deckModel,
                signInModel: signInModel
            )
            .tabItem { Label("Accounts", systemImage: "person.2") }

            GeneralSettingsPane(
                settingsSync: settingsSync,
                toolsModel: toolsModel,
                statusModel: statusModel,
                updateModel: updateModel
            )
            .tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 520, height: 520)
        .task {
            // Cached read only — populating chips/versions never forces the
            // daemon to spawn probes; that's the explicit Check button.
            await toolsModel.load(refresh: false)
            if !settingsSync.isLoaded {
                await settingsSync.load()
            }
        }
    }
}

// MARK: - Accounts pane

struct AccountsSettingsPane: View {
    @ObservedObject var statusModel: MenuBarStatusModel
    @ObservedObject var accountsModel: AccountsSettingsModel
    @ObservedObject var addAccountModel: AddAccountModel
    @ObservedObject var deckModel: DeckPopoverModel
    @ObservedObject var signInModel: AccountSignInModel

    @State private var editingAccount: DeckAccount?
    @State private var removalCandidate: DeckAccount?
    @State private var isAddingAccount = false

    private var accounts: [DeckAccount] {
        let all = statusModel.deckState?.accounts ?? []
        // Claude column order first, then Codex, then anything unknown —
        // stable, mirrors the popover.
        return all.sorted { lhs, rhs in
            let l = providerRank(lhs.provider)
            let r = providerRank(rhs.provider)
            if l != r { return l < r }
            return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
        }
    }

    private func providerRank(_ raw: String) -> Int {
        switch DeckProvider.from(raw) {
        case .claude: return 0
        case .codex: return 1
        case nil: return 2
        }
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
            if accounts.isEmpty {
                Spacer()
                Text(statusModel.deckState == nil
                    ? "Waiting for the daemon…"
                    : "No accounts yet. Click Add Account to connect one.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                List {
                    ForEach(accounts) { account in
                        AccountRosterRow(
                            account: account,
                            isBusy: accountsModel.busyAccountID == account.id,
                            canEdit: AccountsSettingsModel.canEdit(account),
                            isActivating: deckModel.activatingAccountID == account.id,
                            isActivationInFlight: deckModel.activatingAccountID != nil,
                            activationError: deckModel.activationError(for: account.id),
                            signInPhase: signInModel.phase(for: account.id),
                            signInError: signInModel.error(for: account.id),
                            onActivate: deckModel.canActivate && !account.isDefault
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

    /// Minimal deck row for the activate machinery — activation only needs
    /// the account identity/active flag, not usage windows.
    private func activationRow(for account: DeckAccount) -> DeckAccountRow {
        DeckAccountRow(
            account: account,
            provider: DeckProvider.from(account.provider),
            windows: [],
            isActive: account.isDefault
        )
    }
}

/// One Settings → Accounts roster row. This is the activation surface (spec
/// amendment 2026-07-19): the active account shows the same checkmark glyph
/// as the deck; every other account gets a small trailing Activate control
/// wired to the unchanged new-sessions-only daemon switch.
struct AccountRosterRow: View {
    let account: DeckAccount
    let isBusy: Bool
    let canEdit: Bool
    var isActivating: Bool = false
    /// True while ANY activation is in flight — every Activate button disables.
    var isActivationInFlight: Bool = false
    var activationError: String?
    /// Issue #32: this account's own sign-in-again flow state.
    var signInPhase: AccountSignInModel.Phase?
    var signInError: String?
    /// Non-nil only for non-active rows with the activator wired up.
    var onActivate: (() -> Void)?
    var onSignIn: (() -> Void)?
    var onVerifySignIn: (() -> Void)?
    var onRelaunchSignIn: (() -> Void)?
    var onCancelSignIn: (() -> Void)?
    let onEdit: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                // Provider brand mark (issue #32 item 1) — the deck's own
                // ProviderMarkView, alongside a smaller user-color dot.
                if let provider = DeckProvider.from(account.provider) {
                    ProviderMarkView(provider: provider, size: 18)
                } else {
                    Circle()
                        .fill(Color(hexString: account.color) ?? .secondary)
                        .frame(width: 10, height: 10)
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        if DeckProvider.from(account.provider) != nil {
                            Circle()
                                .fill(Color(hexString: account.color) ?? .secondary)
                                .frame(width: 7, height: 7)
                                .accessibilityHidden(true)
                        }
                        Text(account.label)
                            .font(.system(size: 12.5, weight: .semibold))
                        if account.isDefault {
                            ActiveCheckmark()
                        }
                    }
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                signInControls
                if isBusy || isActivating {
                    ProgressView().controlSize(.small)
                }
                if !account.isDefault, let onActivate {
                    Button("Activate", action: onActivate)
                        .controlSize(.small)
                        .disabled(isBusy || isActivating || isActivationInFlight)
                        .help("Switch \(DeckProvider.from(account.provider)?.displayName ?? "this provider") to this account for new sessions. Running sessions are never touched.")
                        .accessibilityLabel("Activate \(account.label)")
                }
                Button("Edit", action: onEdit)
                    .controlSize(.small)
                    .disabled(isBusy || !canEdit)
                    .help(canEdit
                        ? "Rename, set purpose, or change color"
                        : "This account can't be edited — the daemon didn't report its profile reference")
                Button("Remove", role: .destructive, action: onRemove)
                    .controlSize(.small)
                    .disabled(isBusy)
            }
            if let activationError {
                Text(activationError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 28)
            }
            if let signInError {
                Text(signInError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 28)
            }
        }
        .padding(.vertical, 3)
    }

    /// Per-account health chip + the sign-in-again flow it launches (issue
    /// #32 items 2 and 5). The chip reads this account's OWN `authState`;
    /// "Sign in again" is clickable and drives the Terminal login flow.
    @ViewBuilder
    private var signInControls: some View {
        switch signInPhase {
        case .launching, .verifying:
            HStack(spacing: 5) {
                ProgressView().controlSize(.small)
                Text(signInPhase == .verifying ? "Verifying…" : "Opening Terminal…")
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
            if account.healthChip == .signInAgain, let onSignIn {
                Button(action: onSignIn) {
                    HealthChipView(chip: account.healthChip)
                }
                .buttonStyle(.plain)
                .help("Launch \(DeckProvider.from(account.provider)?.displayName ?? "the provider")'s own login for this account in Terminal")
                .accessibilityLabel("Sign in again: \(account.label)")
            } else {
                HealthChipView(chip: account.healthChip)
                    .help(account.authState == nil
                        ? "The daemon didn't report this account's auth state"
                        : "This account's own sign-in state")
            }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        parts.append(DeckProvider.from(account.provider)?.displayName ?? account.provider)
        if let identity = account.identity, !identity.isEmpty { parts.append(identity) }
        if let purpose = account.purpose, !purpose.isEmpty { parts.append(purpose) }
        return parts.joined(separator: " · ")
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
    @ObservedObject var updateModel: ToolUpdateModel

    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var launchAtLoginError: String?

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
                .help("Stored for the daemon; automatic pause takes effect once active-session detection ships.")
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

            Section("CLI tools") {
                if let probe = toolsModel.probe {
                    ToolStatusRow(
                        name: "Claude Code",
                        provider: .claude,
                        probe: probe.tools.claude,
                        activeAccount: activeAccountStatus(for: .claude),
                        updatePhase: updateModel.phase(for: "claude"),
                        onUpdate: { Task { await updateModel.update(tool: "claude") } },
                        onDismissOutcome: { updateModel.dismissOutcome(tool: "claude") }
                    )
                    ToolStatusRow(
                        name: "Codex CLI",
                        provider: .codex,
                        probe: probe.tools.codex,
                        activeAccount: activeAccountStatus(for: .codex),
                        updatePhase: updateModel.phase(for: "codex"),
                        onUpdate: { Task { await updateModel.update(tool: "codex") } },
                        onDismissOutcome: { updateModel.dismissOutcome(tool: "codex") }
                    )
                } else {
                    Text(toolsModel.isChecking ? "Checking…" : "No probe data yet.")
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Button("Check for Updates") {
                        Task { await toolsModel.load(refresh: true) }
                    }
                    .disabled(toolsModel.isChecking)
                    if toolsModel.isChecking {
                        ProgressView().controlSize(.small)
                    }
                }
                if let error = toolsModel.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, enabled in
                        do {
                            try LaunchAtLogin.setEnabled(enabled)
                            launchAtLoginError = nil
                        } catch {
                            launchAtLoginError = error.localizedDescription
                            launchAtLogin = LaunchAtLogin.isEnabled
                        }
                    }
                if let launchAtLoginError {
                    Text(launchAtLoginError)
                        .font(.caption)
                        .foregroundStyle(.red)
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
