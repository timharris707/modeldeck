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
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var launchAtLoginError: String?

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
        .task { await statusModel.refresh() }
    }

    // MARK: - Header

    /// Issue #30 item 10: the product name sits top-left as a quiet
    /// wordmark — system semibold with a touch of tracking, no color, no
    /// glyph (Anthropic usage-panel restraint). The sort control shrinks to
    /// compact icon segments (clock = next reset, percent = lowest
    /// remaining, grid = by provider; tooltips + accessibility labels carry
    /// the names) and sits beside the settings gear, which stays top-right.
    /// No version/update chrome — that surface is issue #33's.
    private var header: some View {
        HStack(spacing: 8) {
            Text("ModelDeck")
                .font(.system(size: 13, weight: .semibold))
                .tracking(0.4)
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
                SettingsLink {
                    Text("Settings…")
                }
                Divider()
                Toggle("Launch at Login", isOn: $launchAtLogin)
                Picker("Layout", selection: $deckModel.layout) {
                    Text("Two columns").tag(DeckLayout.twoColumn)
                    Text("Single column").tag(DeckLayout.singleColumn)
                }
                Divider()
                Button("Quit ModelDeck") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "gearshape")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .onChange(of: launchAtLogin) { _, enabled in
                do {
                    try LaunchAtLogin.setEnabled(enabled)
                    launchAtLoginError = nil
                } catch {
                    launchAtLoginError = error.localizedDescription
                    launchAtLogin = LaunchAtLogin.isEnabled
                }
            }
        }
    }

    @ViewBuilder
    private var connectionBanner: some View {
        if case .unreachable(let message) = statusModel.connection {
            Label("Daemon unreachable", systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.orange)
                .help(message)
        }
        if let launchAtLoginError {
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
                        DeckColumnView(column: column, deckModel: deckModel)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
            case .singleColumn:
                VStack(spacing: 6) {
                    ForEach(deckModel.interleavedRows(for: state)) { row in
                        DeckAccountRowView(
                            row: row,
                            showsProviderMark: true,
                            isExpanded: deckModel.isExpanded(row.id)
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

    private var footer: some View {
        HStack {
            // TimelineView keeps "Updated N min ago" fresh while the
            // popover stays open (the placeholder's timestamp went stale).
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(statusModel.updatedAgoText(now: context.date) ?? "Not updated yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await statusModel.refresh() }
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
        }
    }
}

// MARK: - Column

struct DeckColumnView: View {
    let column: DeckColumn
    @ObservedObject var deckModel: DeckPopoverModel

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
                        isExpanded: deckModel.isExpanded(row.id)
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
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                collapsedLine
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(row.account.label)\(row.isActive ? ", active" : "")")
            .accessibilityHint(isExpanded ? "Collapse usage windows" : "Expand usage windows")

            if isExpanded {
                expandedWindows
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
                    ActiveCheckmark()
                }
                Spacer(minLength: 8)
                if let worst = row.worstWindow, let remainingText = worst.remainingText {
                    Text(remainingText)
                        .font(DeckType.value)
                        .foregroundStyle(valueColor(for: worst))
                        .monospacedDigit()
                }
            }
            if let identity = row.account.identity, !identity.isEmpty {
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
                        Text(worst.resetText)
                            .font(DeckType.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                UsageBarView(window: row.worstWindow)
            }
        }
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
                            Text(window.resetText)
                                .font(DeckType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Text(window.remainingText ?? "—")
                                .font(DeckType.value)
                                .foregroundStyle(valueColor(for: window))
                                .monospacedDigit()
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
            .help("Active account — new sessions use this account")
            .accessibilityLabel("Active")
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
