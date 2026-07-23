import SwiftUI
import ModelDeckMacCore

/// Phase 4 popover — the two-column deck (design/mac-app-spec.md, mockups
/// §02). Claude column left, Codex right, brand-mark headers, collapsing
/// account rows, ONE menu-bar-source checkmark deck-wide (issue #131), sort
/// control, footer with a live "Updated N min ago" and manual Refresh. The
/// single-column alternate layout renders from the same view model.
struct DeckPopoverView: View {
    @ObservedObject var statusModel: MenuBarStatusModel
    @ObservedObject var deckModel: DeckPopoverModel
    /// Issue #33 final placement: the gear menu carries the PRIMARY
    /// "Check for App Updates…" affordance, wired to the same shared model
    /// as the Settings mirror — one check state, two entry points.
    @ObservedObject var appUpdateModel: AppUpdateModel
    /// Issue #121: in-app install state — "Update Now" in the result dialog
    /// drives this; progress/failure render in the dialog re-summon and the
    /// Settings row (both read the same shared model).
    @ObservedObject var appUpdateInstallModel: AppUpdateInstallModel
    /// Issue #96: bundled background-service lifecycle. The popover hosts
    /// the calm one-screen first-run consent and its follow-on states.
    @ObservedObject var setupModel: DaemonSetupModel
    /// Shared with the Settings pane; the SMAppService status read happens
    /// once in the model's load(), never in this struct's initializer (an
    /// XPC round-trip per App-body evaluation — the #68 re-render tax).
    @ObservedObject var launchAtLoginModel: LaunchAtLoginModel
    /// Presents the standard result dialog once a gear-menu check finishes.
    @State private var updateDialog: AppUpdateModel.ResultDialog?
    @Environment(\.openURL) private var openURL
    /// Issue #45: Settings opens via the environment action wrapped in
    /// activation + fronting (see SettingsWindowFronting) instead of a bare
    /// SettingsLink, which with the accessory activation policy opened the
    /// window behind the frontmost app or failed to raise an existing one.
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            connectionBanner
            installProgressLine
            content
            Divider()
            footer
        }
        .padding(14)
        // Issue #30 widths: at the standard roster (7 accounts, longest
        // label ~"Side Project") nothing may truncate in either layout —
        // meter rows carry "Weekly · all models" left and
        // "Resets Wed 5:59 PM" right on every card (zone-free per #137).
        .frame(width: deckModel.layout == .twoColumn ? 640 : 420)
        .task {
            launchAtLoginModel.load()
            await statusModel.refresh()
        }
    }

    // MARK: - Header

    /// Issue #30 item 10: the product name sits top-left as a quiet
    /// wordmark — system semibold with a touch of tracking, no color
    /// (Anthropic usage-panel restraint). Issue #33 amendment (2026-07-20):
    /// the site/favicon's three-bar brand mark sits immediately left of the
    /// wordmark for app ⇄ site ⇄ favicon consistency. The sort control
    /// shrinks to compact icon segments (clock = next reset, percent =
    /// lowest remaining, grid = by provider; tooltips + accessibility labels
    /// carry the names) and sits beside the settings gear, top-right.
    /// Update chrome stays out of the header — the version is a muted footer
    /// detail and update checks live in Settings (issue #33).
    private var header: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                ModelDeckBrandMark()
                Text("ModelDeck")
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(0.4)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            Spacer()

            Picker("Sort", selection: $deckModel.sortOrder) {
                ForEach(DeckSortOrder.allCases, id: \.self) { order in
                    Label(order.displayName, systemImage: order.iconName)
                        .labelStyle(.iconOnly)
                        .help(order.displayName)
                        .accessibilityLabel(order.displayName)
                        .tag(order)
                }
            }
            .pickerStyle(.segmented)
            .controlSize(.small) // issue #30: smaller sort control
            .labelsHidden()
            .fixedSize()
            .help("Sort accounts: next reset, lowest remaining, or grouped by provider")

            Menu {
                Button("Settings…") {
                    openSettings()
                    SettingsWindowFronting.activateAndFront()
                }
                Divider()
                Toggle("Launch at Login", isOn: Binding(
                    get: { launchAtLoginModel.isEnabled },
                    set: { launchAtLoginModel.setEnabled($0) }
                ))
                Picker("Layout", selection: $deckModel.layout) {
                    Text("Two columns").tag(DeckLayout.twoColumn)
                    Text("Single column").tag(DeckLayout.singleColumn)
                }
                Divider()
                // Issue #33 final placement (Tim, 2026-07-20): the canonical
                // macOS spot for the app's own update check. Runs the shared
                // AppUpdateModel and presents a standard result dialog.
                // Never a CLI-update control — those live in Settings.
                Button("Check for App Updates…") {
                    Task {
                        await appUpdateModel.check()
                        // Issue #45: same accessory-policy pitfall as the
                        // Settings window — activate so the result dialog
                        // presents in front of whatever app was frontmost.
                        SettingsWindowFronting.activateForDialog()
                        updateDialog = appUpdateModel.resultDialog
                    }
                }
                .disabled(appUpdateModel.isChecking)
                Divider()
                Button("Quit ModelDeck") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "gearshape")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .alert(
                updateDialog?.title ?? "",
                isPresented: Binding(
                    get: { updateDialog != nil },
                    set: { if !$0 { updateDialog = nil } }
                ),
                presenting: updateDialog
            ) { dialog in
                if dialog.offersInstall, let releaseURL = dialog.releaseURL {
                    // Issue #121 (Tim directive 2026-07-22): Update Now is
                    // the primary action; the release page demotes to a
                    // secondary "Release Notes" link.
                    Button("Update Now") { appUpdateInstallModel.updateNow() }
                    Button("Release Notes") { openURL(releaseURL) }
                    Button("Cancel", role: .cancel) {}
                } else if let releaseURL = dialog.releaseURL {
                    Button("View Release") { openURL(releaseURL) }
                    Button("Cancel", role: .cancel) {}
                } else {
                    Button("OK", role: .cancel) {}
                }
            } message: { dialog in
                Text(dialog.message)
            }
        }
    }

    /// Issue #121: once "Update Now" starts (the dialog closes on press),
    /// the install's progress/failure lives HERE so it never disappears —
    /// the same honest status line the Settings row renders.
    @ViewBuilder
    private var installProgressLine: some View {
        if let status = AppUpdateInstallModel.statusText(for: appUpdateInstallModel.phase) {
            HStack(spacing: 6) {
                if appUpdateInstallModel.isBusy {
                    ProgressView().controlSize(.small)
                }
                Text(status)
                    .font(.caption)
                    .foregroundStyle(installStatusIsFailure ? .red : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var installStatusIsFailure: Bool {
        if case .failed = appUpdateInstallModel.phase { return true }
        return false
    }

    @ViewBuilder
    private var connectionBanner: some View {
        // Issue #96: when the setup card is up it owns the story — the
        // orange unreachable label would just repeat it louder.
        if setupModel.phase.needsPopoverCard {
            DaemonSetupCard(model: setupModel)
        } else if case .unreachable(let message) = statusModel.connection {
            Label("Daemon unreachable", systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.orange)
                .help(message)
        }
        if setupModel.didReregisterForUpdate {
            // Drift re-register happened this launch — note it subtly.
            Text("Background service updated to match this app version.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        if let launchAtLoginError = launchAtLoginModel.lastError {
            Text(launchAtLoginError)
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let state = statusModel.deckState {
            // Issue #131: the ONE account whose window currently feeds the
            // menu bar percentage — the deck's single checkmark. Resolved
            // here (pin → fallback, MenuBarSourceResolver) so both layouts
            // mark from the same value and can never disagree. The tooltip
            // is likewise single-valued: only the source row renders it.
            let sourceID = statusModel.menuBarSourceAccountId
            let sourceTooltip = sourceID.map {
                MenuBarSourceResolver.checkmarkTooltip(
                    pinnedSetting: statusModel.pinnedAccountId,
                    resolvedPinnedAccountID: statusModel.resolvedPinnedAccountId,
                    accountID: $0
                )
            } ?? ""
            switch deckModel.layout {
            case .twoColumn:
                HStack(alignment: .top, spacing: 12) {
                    ForEach(deckModel.columns(for: state)) { column in
                        DeckColumnView(
                            column: column,
                            deckModel: deckModel,
                            menuBarSourceAccountID: sourceID,
                            menuBarSourceTooltip: sourceTooltip,
                            staleness: { statusModel.cardStaleness(for: $0) }
                        )
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
            case .singleColumn:
                VStack(spacing: 6) {
                    ForEach(deckModel.interleavedRows(for: state)) { row in
                        DeckAccountRowView(
                            row: row,
                            deckModel: deckModel,
                            showsProviderMark: true,
                            showsIdentity: deckModel.showAccountEmails,
                            isMenuBarSource: row.id == sourceID,
                            menuBarSourceTooltip: sourceTooltip,
                            isExpanded: deckModel.isExpanded(row.id),
                            staleness: statusModel.cardStaleness(for: row)
                        ) {
                            withAnimation(.easeOut(duration: 0.15)) {
                                deckModel.toggleExpansion(of: row.id)
                            }
                        }
                    }
                }
            }
        } else if case .unknown = statusModel.connection {
            placeholder("Connecting to daemon…")
        } else {
            placeholder("No usage data yet.")
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 60)
    }

    // MARK: - Footer

    /// The running app's version (bundle authority — see `AppVersion`); nil
    /// on unstamped dev builds, which then render no version at all.
    private let appVersionText = AppVersion.footerText(for: AppVersion.current())

    private var footer: some View {
        HStack {
            // Issue #42: the freshness line derives from provider
            // observations (observedAt), not this app's last GET of the
            // daemon cache — and turns a muted warning gold once the age
            // exceeds ~2x the auto-refresh interval or the daemon flags
            // rows stale. Issue #89: keyed on the OLDEST account's newest
            // snapshot ("Oldest data N min ago"), so one failing account
            // can't hide behind its siblings' fresh data. TimelineView
            // keeps it live while the popover stays open.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let status = statusModel.footerStatus(now: context.date)
                HStack(spacing: 6) {
                    // Issue #72: while the manual provider poll runs, say so —
                    // the age line would otherwise look unresponsive for the
                    // seconds the poll takes.
                    // Issue #113 addendum (Tim, live): after a Refresh
                    // updated some cards, the unchanged oldest-data line
                    // read as a refresh bug. Clicking it now explains the
                    // oldest-account basis and names the account(s)
                    // dragging the number, with their ages.
                    Button {
                        deckModel.toggleWarning(DeckWarningID(topic: .footerFreshness))
                    } label: {
                        Text(statusModel.isRefreshing
                            ? "Refreshing…"
                            : (status?.text ?? "Not updated yet"))
                            .font(.caption)
                            .foregroundStyle(status?.isStale == true && !statusModel.isRefreshing
                                ? AnyShapeStyle(severityColor(.warning))
                                : AnyShapeStyle(.secondary))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(status?.isStale == true
                        ? "Usage data is older than expected — Refresh forces a fresh provider poll."
                        : "Age of the oldest account's newest provider-reported usage")
                    .popover(
                        isPresented: deckModel.warningBinding(DeckWarningID(topic: .footerFreshness)),
                        arrowEdge: .bottom
                    ) {
                        WarningExplanationView(
                            explanation: statusModel.footerFreshnessExplanation(now: context.date)
                        )
                    }
                    // Issue #90: calm honesty indicator — shown only while
                    // the daemon's effective refresh cadence is slower than
                    // the configured setting (active-session cap on the
                    // never-customized default interval). The tooltip
                    // explains the cap and that an explicit interval lifts
                    // it; footer family, Direction-A restraint.
                    // Issue #113: clickable — the cap explanation must be
                    // reachable without a working tooltip.
                    if let notice = statusModel.refreshCadenceNotice {
                        Button {
                            deckModel.toggleWarning(DeckWarningID(topic: .refreshCadence))
                        } label: {
                            HStack(spacing: 3) {
                                Image(systemName: "tortoise")
                                    .font(.system(size: 9))
                                Text(notice.text)
                                    .font(.caption)
                            }
                            .foregroundStyle(.secondary)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(notice.tooltip)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(notice.text). \(notice.tooltip)")
                        .popover(
                            isPresented: deckModel.warningBinding(DeckWarningID(topic: .refreshCadence)),
                            arrowEdge: .bottom
                        ) {
                            WarningExplanationView(explanation: .cadence(notice))
                        }
                    }
                    // Issue #33: the app's own version, muted and small,
                    // beside the freshness line (restraint bar applies).
                    if let appVersionText {
                        Text(appVersionText)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .help("ModelDeck app version")
                    }
                }
            }
            Spacer()
            Button {
                // Issue #72: manual Refresh = forced provider poll + state
                // re-read, so the "Data from…" counter actually restarts
                // (the plain cached read never advanced observedAt).
                Task { await statusModel.refreshFromProviders() }
            } label: {
                HStack(spacing: 4) {
                    if statusModel.isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                    Text("Refresh")
                }
            }
            .disabled(statusModel.isRefreshing)
            .help("Ask the daemon to poll the providers for fresh usage now")
        }
    }
}

// MARK: - Column

struct DeckColumnView: View {
    let column: DeckColumn
    @ObservedObject var deckModel: DeckPopoverModel
    /// Issue #131: the account whose window feeds the menu bar — at most one
    /// row across the WHOLE deck matches, so the two columns can never show
    /// two checkmarks.
    var menuBarSourceAccountID: String? = nil
    /// Issue #131: the source checkmark's tooltip (only the source row
    /// renders it).
    var menuBarSourceTooltip: String = ""
    /// Issue #89: per-card staleness derivation, supplied by the popover so
    /// the column stays free of the status model (interval + clock live
    /// there). Defaults to no markers for previews/tests.
    var staleness: (DeckAccountRow) -> DeckFreshness.CardStaleness? = { _ in nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                ProviderMarkView(provider: column.provider, size: 20)
                Text(column.title)
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(column.accountCountText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .padding(.bottom, 2)

            if column.rows.isEmpty {
                Text("No accounts")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 40)
            } else {
                ForEach(column.rows) { row in
                    DeckAccountRowView(
                        row: row,
                        deckModel: deckModel,
                        showsProviderMark: false,
                        showsIdentity: deckModel.showAccountEmails,
                        isMenuBarSource: row.id == menuBarSourceAccountID,
                        menuBarSourceTooltip: menuBarSourceTooltip,
                        isExpanded: deckModel.isExpanded(row.id),
                        staleness: staleness(row)
                    ) {
                        withAnimation(.easeOut(duration: 0.15)) {
                            deckModel.toggleExpansion(of: row.id)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Type scale

/// Issue #30's canonical card type scale, shared identically by both
/// layouts: restrained sizes modeled on Anthropic's own usage panel.
/// The account name leads at 12 semibold; everything else — inline plan
/// tier, meter captions, reset info — is a muted 10.5; the "% left" value
/// is an 11-semibold accent, right-aligned and color-coded but no longer
/// dominant.
///
/// Issue #134 (Tim directive 2026-07-22, supersedes the #30 scale's
/// "meter labels 11 medium" entry): expanded per-window labels use the
/// SAME caption font and non-bold weight as the collapsed row's label —
/// the dedicated heavier `meterLabel` style is gone.
enum DeckType {
    /// Account name.
    static let name = Font.system(size: 12, weight: .semibold)
    /// Inline plan tier ("· Max (20x)") and identity line.
    static let tier = Font.system(size: 10.5)
    /// Meter captions: limit labels (collapsed AND expanded, issue #134)
    /// and reset info.
    static let caption = Font.system(size: 10.5)
    /// "% left" values, collapsed headline and expanded rows alike.
    static let value = Font.system(size: 11, weight: .semibold)
}

// MARK: - Account row

/// One deck card. Activation moved to Settings → Accounts (spec amendment
/// 2026-07-19, Tim's call) — the popover carries zero activation controls.
/// Issue #131 (Tim directive 2026-07-22): the card checkmark no longer marks
/// CLI-active state — it marks the ONE account across the whole deck whose
/// window currently feeds the menu bar percentage (resolved pin or
/// lowest-across fallback). CLI-active state stays visible in Settings →
/// Accounts (activation radio + marker) and the "Follow Active …" labels.
struct DeckAccountRowView: View {
    let row: DeckAccountRow
    /// Issue #113: the shared popover model also holds which warning
    /// affordance's explanation is presented (one at a time, click to
    /// toggle) — kept in the model so presentation state stays testable.
    @ObservedObject var deckModel: DeckPopoverModel
    let showsProviderMark: Bool
    /// Issue #73: identity (email) under the label renders only when the
    /// Settings → General "Show account emails" toggle is on (default off).
    /// Uniform for both providers — no identity, no line.
    var showsIdentity: Bool = false
    /// Issue #131: whether THIS account's window feeds the menu bar — the
    /// deck's single checkmark. At most one row in the whole deck is true.
    var isMenuBarSource: Bool = false
    /// Issue #131: the checkmark's mode-honest tooltip (pinned /
    /// follow-active / lowest-across / fallback), computed once at the
    /// popover level from the same resolution that chose the source row.
    var menuBarSourceTooltip: String = ""
    let isExpanded: Bool
    /// Issue #89: non-nil when this card's newest snapshot is older than
    /// ~2x the effective refresh interval — the card then carries a visible
    /// warning-tinted age line so fossil data can never pass as fresh.
    var staleness: DeckFreshness.CardStaleness? = nil
    let onToggle: () -> Void
    /// Issue #118: the "Sign in again…" action opens the Settings window
    /// (Accounts pane, via the model's routed selection) — the environment
    /// action lives here because only views can reach it.
    @Environment(\.openSettings) private var openSettings

    /// Issue #118 — the one-click path from the sign-in-needed notice into
    /// the roster's existing re-login flow: dismiss the explanation, route
    /// Settings to the Accounts pane, fire the model's sign-in request
    /// (which the app hands to `AccountSignInModel.beginSignIn`, the same
    /// path as the roster's own "Sign in again" chip), and front the
    /// Settings window so the in-progress flow is visible.
    private func beginSignInAgain() {
        deckModel.requestSignInAgain(for: row)
        openSettings()
        SettingsWindowFronting.activateAndFront()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                collapsedLine
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Issue #55 (CodeRabbit): VoiceOver must hear the pending state,
            // not just silence, for a DB-active-but-blocked row. Issue #73:
            // opted-in emails are spoken too. Issue #65 (CodeRabbit): the
            // explicit parent label suppresses the child markers' labels, so
            // the duplicate-token warning is folded in here as well. The
            // derivation lives in Core (DeckAccountRow) where it is tested.
            .accessibilityLabel(row.accessibilityLabel(
                showsIdentity: showsIdentity,
                isMenuBarSource: isMenuBarSource
            ))
            .accessibilityHint(isExpanded ? "Collapse usage windows" : "Expand usage windows")
            // Issue #113 (CodeRabbit): the row button's explicit label
            // suppresses the marker's own accessibility element, so the
            // click-to-explain behavior is offered here as a named action
            // whenever the marker renders.
            .accessibilityActions {
                if row.account.hasDuplicateToken {
                    Button("Show duplicate login explanation") {
                        deckModel.toggleWarning(
                            DeckWarningID(topic: .duplicateToken, elementID: row.id)
                        )
                    }
                }
            }

            if isExpanded {
                expandedWindows
            }

            // Issue #98: the Keychain recovery notice — macOS refused the
            // daemon's read of this account's existing credentials (the
            // dismissed-prompt state). Actionable, honest, and it OUTRANKS
            // the bare stale line (row.staleness already yields nil while
            // this is up): the tooltip says exactly what happened and what
            // to click. Same visual family as the #89 stale line.
            // Issue #113: clickable — the tooltip never appeared inside the
            // MenuBarExtra window, so the coaching opens as an anchored
            // popover on click (same strings).
            if let recovery = row.keychainRecovery {
                let warningID = DeckWarningID(topic: .keychainAccess, elementID: row.id)
                Button {
                    deckModel.toggleWarning(warningID)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "key.slash")
                            .font(.system(size: 9, weight: .semibold))
                        Text(recovery.text)
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(severityColor(.warning))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(recovery.tooltip)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(recovery.accessibilityLabel)
                .popover(isPresented: deckModel.warningBinding(warningID), arrowEdge: .bottom) {
                    WarningExplanationView(explanation: .keychain(recovery))
                }
            }

            // Issue #114: the sign-in recovery notice — the daemon reported
            // `signin-required` (stored sign-in missing or expired; for
            // Claude, the fate of every non-active account under CLI
            // ≥ 2.1.216). Same visual family as the #98 notice above, and it
            // likewise OUTRANKS the bare stale line (row.staleness yields
            // nil while this is up): "Sign in needed" is the cause, the age
            // is only the symptom. Mutually exclusive with the Keychain
            // notice — authState is single-valued.
            // Issue #113/#118: clickable — the click opens the anchored
            // explanation, whose primary "Sign in again…" button drops the
            // user into the roster's EXISTING #99-correct sign-in flow for
            // exactly this account (Settings → Accounts opens alongside).
            if let recovery = row.signInRecovery {
                let warningID = DeckWarningID(topic: .signInRequired, elementID: row.id)
                Button {
                    deckModel.toggleWarning(warningID)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "person.crop.circle.badge.exclamationmark")
                            .font(.system(size: 9, weight: .semibold))
                        Text(recovery.text)
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(severityColor(.warning))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(recovery.tooltip)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(recovery.accessibilityLabel)
                // VoiceOver can skip the popover hop: the named action runs
                // the same one-click path the popover's button offers.
                .accessibilityAction(named: "Sign in again") {
                    beginSignInAgain()
                }
                .popover(isPresented: deckModel.warningBinding(warningID), arrowEdge: .bottom) {
                    SignInExplanationView(explanation: .signIn(recovery)) {
                        beginSignInAgain()
                    }
                }
            }

            // Issue #89: the stale line renders in BOTH collapsed and
            // expanded states, outside the card button so it keeps its own
            // accessibility element. Tooltip carries the data age plus the
            // account's last refresh error (when the daemon reported one).
            // Issue #113: clickable for the same reason — the age + last
            // refresh error must be reachable, not tooltip-theoretical.
            if let staleness {
                let warningID = DeckWarningID(topic: .staleData, elementID: row.id)
                Button {
                    deckModel.toggleWarning(warningID)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "clock.badge.exclamationmark")
                            .font(.system(size: 9, weight: .semibold))
                        Text(staleness.text)
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(severityColor(.warning))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(staleness.tooltip)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(staleness.accessibilityLabel)
                .popover(isPresented: deckModel.warningBinding(warningID), arrowEdge: .bottom) {
                    WarningExplanationView(explanation: .stale(staleness))
                }
            }
        }
        .padding(9)
        // Issue #30: cards sit clearly darker than the panel so each account
        // reads as a distinct card — a black scrim (darkens in BOTH light
        // and dark appearance, unlike the near-invisible system fills) plus
        // a hairline edge.
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.black.opacity(0.13))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.07))
        )
        // Menu bar pin (account percentage picker follow-up, Tim's call):
        // right-click a card to pin its percentage to the menu bar — or
        // follow the provider's ACTIVE account so the menu bar tracks every
        // activation switch — without opening Settings. Same daemon-backed
        // setting as the Settings → General picker.
        .contextMenu {
            Button(deckModel.isMenuBarPinned(row.account.id)
                ? "Unpin from Menu Bar"
                : "Pin to Menu Bar") {
                deckModel.toggleMenuBarPin(accountID: row.account.id)
            }
            if let provider = DeckProvider.from(row.account.provider) {
                Toggle(
                    "Follow Active \(provider.displayName) Account",
                    isOn: Binding(
                        get: { deckModel.isMenuBarFollowingActive(provider: provider) },
                        set: { _ in deckModel.toggleMenuBarFollowActive(provider: provider) }
                    )
                )
            }
        }
    }

    /// Collapsed card (issue #30 anatomy, both layouts): title row — inline
    /// provider mark, name with the muted plan tier inline ("Studio ·
    /// Max (20x)"), the menu-bar-source checkmark when this account feeds
    /// the menu bar (issue #131), right-aligned % left — then a meter
    /// caption row with the limit label LEFT and reset info (zone-free per
    /// issue #137) RIGHT, then the thin bar. The provider mark stays inline in the
    /// title row — never a leading gutter — so every element shares one left
    /// edge (issue #28).
    private var collapsedLine: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                if showsProviderMark, let provider = row.provider {
                    ProviderMarkView(provider: provider, size: 13)
                }
                titleText
                    .lineLimit(1)
                if isMenuBarSource {
                    // Issue #131: the deck's ONE checkmark — this account's
                    // window feeds the menu bar percentage (resolved pin,
                    // follow-active, or lowest-across). Never an
                    // activation/CLI-active marker; that state lives in
                    // Settings → Accounts.
                    MenuBarSourceCheckmark(tooltip: menuBarSourceTooltip)
                }
                if row.account.hasDuplicateToken {
                    // Issue #65: two profiles appear to hold the same login.
                    // Issue #113: clicking the marker opens the explanation
                    // (a tap gesture on the marker's own hit area — never a
                    // nested Button; see DuplicateTokenMarkerView).
                    DuplicateTokenMarkerView(
                        isExplaining: deckModel.warningBinding(
                            DeckWarningID(topic: .duplicateToken, elementID: row.id)
                        )
                    )
                }
                Spacer(minLength: 8)
                // Issue #33 amendment: the headline percent only exists
                // while collapsed — expanded rows carry their own numbers.
                // Issue #139: on a spend-headlined card (spend-only account)
                // the value is the payload-stated dollars, like the row.
                if let worst = row.headlineWindow(isExpanded: isExpanded),
                   let remainingText = worst.valueText {
                    Text(remainingText)
                        .font(DeckType.value)
                        .foregroundStyle(valueColor(for: worst))
                        .monospacedDigit()
                }
            }
            if showsIdentity, let identity = row.account.identity, !identity.isEmpty {
                Text(identity)
                    .font(DeckType.tier)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if !isExpanded {
                if let worst = row.worstWindow {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(worst.title)
                            .font(DeckType.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        // Issue #67: the reset phrase never ellipsizes — the
                        // window label truncates first; the phrase wraps if
                        // it must. Tooltip carries the absolute timestamp.
                        resetTextView(for: worst)
                    }
                }
                UsageBarView(window: row.worstWindow)
                // Issue #101: "100% left" minutes after heavy use is
                // factually right but cognitively wrong — the rollover
                // annotation supplies the missing context.
                if let rollover = row.worstWindow?.rolloverText {
                    Text(rollover)
                        .font(DeckType.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Issue #67: shared reset-text treatment for collapsed and expanded
    /// rows. Layout priority keeps the phrase whole (the sibling label
    /// truncates first); wrapping is allowed as the last resort — never an
    /// ellipsis that hides the reset time. Every reset text carries a hover
    /// tooltip with the full absolute timestamp as backstop.
    private func resetTextView(for window: DeckWindow) -> some View {
        Text(window.resetText)
            .font(DeckType.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
            .fixedSize(horizontal: false, vertical: true)
            .layoutPriority(1)
            // Issue #101: unanchored windows explain the fresh-window state
            // here instead of surfacing the placeholder timestamp; anchored
            // windows keep the issue #67 absolute-timestamp backstop.
            .help(window.resetTooltip)
    }

    /// "Studio · Max (20x)" — the plan tier inline beside the name, muted
    /// and smaller (issue #30, item 5); just the name when the tier is
    /// unknown. Concatenated Text so the pair truncates as one run.
    private var titleText: Text {
        let name = Text(row.account.label).font(DeckType.name)
        guard let tier = row.account.planLabel else { return name }
        return name
            + Text(" · \(tier)")
                .font(DeckType.tier)
                .foregroundStyle(.secondary)
    }

    /// Expanded state — row anatomy modeled on Claude Code's own usage
    /// panel (issue #28), on issue #30's shared type scale: limit label left
    /// in primary color, reset info (zone-free per issue #137; the tooltip
    /// keeps the zone) and the semibold
    /// percent right-aligned on the same line, a thin full-width bar below,
    /// and generous vertical rhythm between rows. The number keeps the
    /// locked "% left" semantics. Spend rows render muted with no severity
    /// color. Issue #134 (Tim directive 2026-07-22): the window label uses
    /// EXACTLY the collapsed row's caption font and non-bold weight — the
    /// former 11-medium `meterLabel` read as bold next to the collapsed
    /// presentation. Typography only; label color and layout unchanged.
    private var expandedWindows: some View {
        VStack(alignment: .leading, spacing: 12) {
            if row.windows.isEmpty {
                Text("No usage windows reported")
                    .font(DeckType.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(row.windows) { window in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(window.title)
                                .font(DeckType.caption)
                                .foregroundStyle(window.isSpend ? Color.secondary : Color.primary)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            // Issue #67: the complete reset phrase (weekday
                            // and time; zone lives in the tooltip per #137)
                            // is the one thing expansion exists to show — it
                            // must never ellipsize. The label truncates
                            // first; the phrase may wrap.
                            resetTextView(for: window)
                            // Issue #139: spend rows show "$X.XX of $Y.YY"
                            // when the payload stated amounts + currency;
                            // the bare percent otherwise (unchanged).
                            Text(window.valueText ?? "—")
                                .font(DeckType.value)
                                .foregroundStyle(valueColor(for: window))
                                .monospacedDigit()
                                .layoutPriority(2)
                        }
                        UsageBarView(window: window)
                        // Issue #101: rollover context for a window that
                        // just rolled — "Week reset just now / at 10:19 AM".
                        if let rollover = window.rolloverText {
                            Text(rollover)
                                .font(DeckType.caption)
                                .foregroundStyle(.secondary)
                        }
                        if window.stale {
                            Text("stale")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .padding(.top, 4)
    }
}

// MARK: - Reachable explanations (issue #113)

/// The anchored explanation a warning affordance opens on click. `.help`
/// tooltips are unreliable inside the MenuBarExtra window (hover produced
/// nothing on Tim's live v0.3.0), so every warning affordance presents this
/// small popover instead — calm Direction-A framing, existing strings only,
/// dismissed by clicking anywhere outside (standard transient behavior).
struct WarningExplanationView: View {
    let explanation: DeckWarningExplanation

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(explanation.title)
                .font(.system(size: 12, weight: .semibold))
            Text(explanation.body)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
    }
}

/// Issue #118: the sign-in-needed notice's explanation popover — the same
/// calm anatomy as WarningExplanationView (existing strings only) plus ONE
/// primary action: "Sign in again…", the one-click path into the roster's
/// existing re-login flow for this exact account. Direction-A restraint: a
/// single small prominent button, no competing affordances.
struct SignInExplanationView: View {
    let explanation: DeckWarningExplanation
    let onSignInAgain: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(explanation.title)
                .font(.system(size: 12, weight: .semibold))
            Text(explanation.body)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onSignInAgain) {
                Text("Sign in again…")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .padding(.top, 4)
            .help("Opens Settings → Accounts and starts this account's sign-in flow")
            .accessibilityLabel("Sign in again for this account")
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
    }
}

extension DeckPopoverModel {
    /// SwiftUI presentation binding over the model's single presented-
    /// warning slot, so which explanation is up stays unit-testable state
    /// rather than scattered view-local `@State`.
    func warningBinding(_ id: DeckWarningID) -> Binding<Bool> {
        Binding(
            get: { self.isWarningPresented(id) },
            set: { self.setWarningPresented(id, $0) }
        )
    }
}

// MARK: - Pieces

/// Issue #131 (Tim directive 2026-07-22): the deck's single checkmark —
/// "shown in menu bar". It marks exactly ONE account across the whole deck:
/// the one whose window currently feeds the menu bar percentage (pinned,
/// follow-active, or the lowest-across default, INCLUDING the #123 fallback
/// when a pin doesn't resolve). Same quiet glyph the old active marker used
/// — deliberately not a new visual language — but the meaning is the menu
/// bar source, never CLI-active state (that lives in Settings → Accounts).
struct MenuBarSourceCheckmark: View {
    /// Mode-honest hover copy from `MenuBarSourceResolver.checkmarkTooltip`.
    let tooltip: String

    var body: some View {
        Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .help(tooltip)
            .accessibilityLabel("Shown in menu bar")
    }
}

/// Active marker (spec amendment 2026-07-19; re-scoped by issue #131): a
/// small checkmark glyph beside the account title replaces the ACTIVE pill.
/// Since #131 this activation marker renders ONLY in Settings → Accounts —
/// deck cards carry the menu-bar-source checkmark instead.
struct ActiveCheckmark: View {
    var body: some View {
        Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            // Issue #61: state the solid/amber distinction on hover —
            // solid means active AND in effect (the amber marker's tooltip
            // carries the "selected but not in effect" side).
            .help("Active and in effect — new sessions use this account")
            .accessibilityLabel("Active")
    }
}

/// Issue #55: honest active marker. Full checkmark only when the provider's
/// activation is physically effective (or the daemon didn't report
/// activation — older daemon, no false warnings); otherwise a hollow,
/// warning-tinted mark whose tooltip carries the honest caption.
/// Issue #131: Settings → Accounts only — deck cards no longer render it.
struct ActiveMarkerView: View {
    let indicator: ActiveIndicator

    var body: some View {
        switch indicator {
        case .checkmark:
            ActiveCheckmark()
        case .pending(let caption):
            Image(systemName: "checkmark.circle")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(severityColor(.warning))
                .help(caption)
                .accessibilityLabel("Marked active, pending — \(caption)")
        }
    }
}

/// Issue #65: duplicate-token marker — the daemon's usage-fingerprint check
/// flagged this account as sharing a login with another profile. Same
/// hollow-marker treatment as the pending active marker (#55/#62): hollow
/// warning-tinted glyph, tooltip with the honest caption, VoiceOver carries
/// the state. Renders on every flagged row — deck popover and Settings →
/// Accounts alike — because the problem is per-account, not per-selection.
/// Issue #113: the marker is now a click target — tooltips never appeared
/// inside the MenuBarExtra window, so clicking opens an anchored
/// explanation popover (marker caption + the banner's [Why?] detail, both
/// verbatim). Deck rows pass a model-backed presentation binding (testable,
/// one explanation at a time); Settings → Accounts uses local state. The
/// `.help` tooltip stays as progressive enhancement and the VoiceOver label
/// is unchanged.
struct DuplicateTokenMarkerView: View {
    /// Model-backed presentation when provided (deck popover); local state
    /// otherwise (Settings roster, where the marker is self-contained).
    var isExplaining: Binding<Bool>?
    @State private var localExplaining = false

    private var explaining: Binding<Bool> { isExplaining ?? $localExplaining }

    var body: some View {
        Image(systemName: "exclamationmark.circle")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(severityColor(.warning))
            // The glyph alone is a ~11 pt target; pad the hit area so
            // clicks land. 15 pt matches the title row's text height,
            // so the row's vertical rhythm is unchanged.
            .frame(width: 15, height: 15)
            .contentShape(Rectangle())
            // CodeRabbit on #113: NOT a Button — in the deck this marker
            // sits inside the row's expand/collapse Button, and nested
            // SwiftUI Buttons are an unsupported pattern (the parent can
            // swallow or misroute the click). A tap gesture on the deepest
            // view takes precedence over the enclosing plain-style button
            // for exactly this hit area, which is the supported shape of
            // "clickable region inside a clickable row".
            .onTapGesture { explaining.wrappedValue.toggle() }
            .help(DuplicateTokenMarker.caption)
            .accessibilityLabel(DuplicateTokenMarker.accessibilityLabel)
            // VoiceOver can invoke the explanation wherever the marker is
            // its own element (Settings roster); in the deck the row button
            // carries an equivalent named action (its explicit label
            // suppresses this child element).
            .accessibilityAction { explaining.wrappedValue.toggle() }
            .popover(isPresented: explaining, arrowEdge: .bottom) {
                WarningExplanationView(explanation: .duplicateToken())
            }
    }
}

/// Usage bar: fills with **usage**, colored by remaining severity —
/// blue healthy, gold low, red critical (locked spec decision).
/// The empty track uses `Color.primary` at low opacity (issue #25) so a
/// 0%/unknown bar still reads as a meter: it resolves to a light gray in
/// light mode and a near-white gray in dark mode, unlike the system fill
/// colors which were nearly invisible on the popover background.
struct UsageBarView: View {
    let window: DeckWindow?

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.16))
                if let window {
                    Capsule()
                        .fill(window.isSpend ? Color.secondary.opacity(0.5) : severityColor(window.severity))
                        .frame(width: max(proxy.size.width * window.usedFraction, window.usedFraction > 0 ? 3 : 0))
                }
            }
        }
        .frame(height: 4)
    }
}

/// Number color for a window: spend is always muted (issue #28 — no
/// severity color on the tertiary spend row), everything else follows the
/// locked severity palette.
func valueColor(for window: DeckWindow) -> Color {
    window.isSpend ? .secondary : severityColor(window.severity)
}

/// Bar/number colors per the locked decision: blue healthy, yellow-gold
/// below warning, red at critical.
func severityColor(_ severity: UsageSeverity) -> Color {
    switch severity {
    case .healthy: return .blue
    case .warning: return Color(red: 0.85, green: 0.63, blue: 0.13)
    case .critical: return .red
    case .unknown: return .secondary
    }
}
