import SwiftUI
import ModelDeckMacCore

/// Phase 4 popover — the two-column deck (design/mac-app-spec.md, mockups
/// §02). Claude column left, Codex right, brand-mark headers, collapsing
/// account rows, per-column ACTIVE badge, sort control, footer with a live
/// "Updated N min ago" and manual Refresh. The single-column alternate
/// layout renders from the same view model.
struct DeckPopoverView: View {
    @ObservedObject var statusModel: MenuBarStatusModel
    @ObservedObject var deckModel: DeckPopoverModel
    /// Issue #33 final placement: the gear menu carries the PRIMARY
    /// "Check for App Updates…" affordance, wired to the same shared model
    /// as the Settings mirror — one check state, two entry points.
    @ObservedObject var appUpdateModel: AppUpdateModel
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
            content
            Divider()
            footer
        }
        .padding(14)
        // Issue #30 widths: at the standard roster (7 accounts, longest
        // label ~"Side Project") nothing may truncate in either layout —
        // meter rows carry "Weekly · all models" left and
        // "Resets Wed 5:59 PM PDT" right on every card.
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
                if let releaseURL = dialog.releaseURL {
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
            switch deckModel.layout {
            case .twoColumn:
                HStack(alignment: .top, spacing: 12) {
                    ForEach(deckModel.columns(for: state)) { column in
                        DeckColumnView(
                            column: column,
                            deckModel: deckModel,
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
                            showsProviderMark: true,
                            showsIdentity: deckModel.showAccountEmails,
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
                    Text(statusModel.isRefreshing
                        ? "Refreshing…"
                        : (status?.text ?? "Not updated yet"))
                        .font(.caption)
                        .foregroundStyle(status?.isStale == true && !statusModel.isRefreshing
                            ? AnyShapeStyle(severityColor(.warning))
                            : AnyShapeStyle(.secondary))
                        .help(status?.isStale == true
                            ? "Usage data is older than expected — Refresh forces a fresh provider poll."
                            : "Age of the oldest account's newest provider-reported usage")
                    // Issue #90: calm honesty indicator — shown only while
                    // the daemon's effective refresh cadence is slower than
                    // the configured setting (active-session cap on the
                    // never-customized default interval). The tooltip
                    // explains the cap and that an explicit interval lifts
                    // it; footer family, Direction-A restraint.
                    if let notice = statusModel.refreshCadenceNotice {
                        HStack(spacing: 3) {
                            Image(systemName: "tortoise")
                                .font(.system(size: 9))
                            Text(notice.text)
                                .font(.caption)
                        }
                        .foregroundStyle(.secondary)
                        .help(notice.tooltip)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(notice.text). \(notice.tooltip)")
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
                        showsProviderMark: false,
                        showsIdentity: deckModel.showAccountEmails,
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
enum DeckType {
    /// Account name.
    static let name = Font.system(size: 12, weight: .semibold)
    /// Inline plan tier ("· Max (20x)") and identity line.
    static let tier = Font.system(size: 10.5)
    /// Meter captions: limit labels and reset info.
    static let caption = Font.system(size: 10.5)
    /// Expanded meter row's limit label (primary color, per issue #28).
    static let meterLabel = Font.system(size: 11, weight: .medium)
    /// "% left" values, collapsed headline and expanded rows alike.
    static let value = Font.system(size: 11, weight: .semibold)
}

// MARK: - Account row

/// One deck card. Activation moved to Settings → Accounts (spec amendment
/// 2026-07-19, Tim's call) — the popover carries zero activation controls;
/// the active account shows a small checkmark beside its title and its
/// headline slot carries the usage summary like every other card.
struct DeckAccountRowView: View {
    let row: DeckAccountRow
    let showsProviderMark: Bool
    /// Issue #73: identity (email) under the label renders only when the
    /// Settings → General "Show account emails" toggle is on (default off).
    /// Uniform for both providers — no identity, no line.
    var showsIdentity: Bool = false
    let isExpanded: Bool
    /// Issue #89: non-nil when this card's newest snapshot is older than
    /// ~2x the effective refresh interval — the card then carries a visible
    /// warning-tinted age line so fossil data can never pass as fresh.
    var staleness: DeckFreshness.CardStaleness? = nil
    let onToggle: () -> Void

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
            .accessibilityLabel(row.accessibilityLabel(showsIdentity: showsIdentity))
            .accessibilityHint(isExpanded ? "Collapse usage windows" : "Expand usage windows")

            if isExpanded {
                expandedWindows
            }

            // Issue #98: the Keychain recovery notice — macOS refused the
            // daemon's read of this account's existing credentials (the
            // dismissed-prompt state). Actionable, honest, and it OUTRANKS
            // the bare stale line (row.staleness already yields nil while
            // this is up): the tooltip says exactly what happened and what
            // to click. Same visual family as the #89 stale line.
            if let recovery = row.keychainRecovery {
                HStack(spacing: 4) {
                    Image(systemName: "key.slash")
                        .font(.system(size: 9, weight: .semibold))
                    Text(recovery.text)
                        .font(.system(size: 10))
                }
                .foregroundStyle(severityColor(.warning))
                .help(recovery.tooltip)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(recovery.accessibilityLabel)
            }

            // Issue #89: the stale line renders in BOTH collapsed and
            // expanded states, outside the card button so it keeps its own
            // accessibility element. Tooltip carries the data age plus the
            // account's last refresh error (when the daemon reported one).
            if let staleness {
                HStack(spacing: 4) {
                    Image(systemName: "clock.badge.exclamationmark")
                        .font(.system(size: 9, weight: .semibold))
                    Text(staleness.text)
                        .font(.system(size: 10))
                }
                .foregroundStyle(severityColor(.warning))
                .help(staleness.tooltip)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(staleness.accessibilityLabel)
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
    }

    /// Collapsed card (issue #30 anatomy, both layouts): title row — inline
    /// provider mark, name with the muted plan tier inline ("Studio ·
    /// Max (20x)"), active checkmark, right-aligned % left — then a meter
    /// caption row with the limit label LEFT and reset info (incl. time
    /// zone) RIGHT, then the thin bar. The provider mark stays inline in the
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
                if row.isActive {
                    // Issue #55: the marker is honest — full checkmark only
                    // when the daemon verified activation is physically in
                    // effect (or didn't report activation at all).
                    ActiveMarkerView(indicator: row.activeIndicator)
                }
                if row.account.hasDuplicateToken {
                    // Issue #65: two profiles appear to hold the same login.
                    DuplicateTokenMarkerView()
                }
                Spacer(minLength: 8)
                // Issue #33 amendment: the headline percent only exists
                // while collapsed — expanded rows carry their own numbers.
                if let worst = row.headlineWindow(isExpanded: isExpanded),
                   let remainingText = worst.remainingText {
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
            .help(DeckBuilder.absoluteResetText(for: window.resetsAt)
                ?? "The provider didn't report a reset time for this window")
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
    /// in primary color, reset info (incl. time zone) and the semibold
    /// percent right-aligned on the same line, a thin full-width bar below,
    /// and generous vertical rhythm between rows. The number keeps the
    /// locked "% left" semantics. Spend rows render muted with no severity
    /// color.
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
                                .font(DeckType.meterLabel)
                                .foregroundStyle(window.isSpend ? Color.secondary : Color.primary)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            // Issue #67: the complete reset phrase (weekday,
                            // time, timezone) is the one thing expansion
                            // exists to show — it must never ellipsize. The
                            // label truncates first; the phrase may wrap.
                            resetTextView(for: window)
                            Text(window.remainingText ?? "—")
                                .font(DeckType.value)
                                .foregroundStyle(valueColor(for: window))
                                .monospacedDigit()
                                .layoutPriority(2)
                        }
                        UsageBarView(window: window)
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

// MARK: - Pieces

/// Active marker (spec amendment 2026-07-19): a small checkmark glyph
/// beside the account title replaces the ACTIVE pill, in the popover and in
/// Settings → Accounts alike.
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
struct DuplicateTokenMarkerView: View {
    var body: some View {
        Image(systemName: "exclamationmark.circle")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(severityColor(.warning))
            .help(DuplicateTokenMarker.caption)
            .accessibilityLabel(DuplicateTokenMarker.accessibilityLabel)
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
