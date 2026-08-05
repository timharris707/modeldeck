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
    /// Issue #176: "Renew now" state for expired-idle Claude cards — the
    /// popover observes the shared model (same instance as Settings →
    /// Accounts) and hands each card plain presentation values.
    @ObservedObject var renewModel: AccountRenewModel
    /// Issue #213: the duplicate "Re-log in…" flow renders inline on the
    /// deck card, so the popover observes the SAME sign-in model instance
    /// as Settings → Accounts — one flow, two honest surfaces, and the
    /// roster's own controls can never restart what the deck launched.
    @ObservedObject var signInModel: AccountSignInModel
    /// Issue #33 final placement: the gear menu carries the PRIMARY
    /// "Check for App Updates…" affordance, wired to the same shared model
    /// as the Settings mirror — one check state, two entry points.
    @ObservedObject var appUpdateModel: AppUpdateModel
    /// Issue #121: in-app install state — "Update Now" in the result dialog
    /// drives this; progress/failure render in the dialog re-summon and the
    /// Settings row (both read the same shared model).
    @ObservedObject var appUpdateInstallModel: AppUpdateInstallModel
    /// Issue #241: the staged-update restart prompt. Prompting renders the
    /// dismissible "restart to finish updating" banner under the header;
    /// dismissed renders the passive header badge whose popover (via the
    /// #113 one-at-a-time slot) re-offers the Restart. Both drive the
    /// existing #163 explicit install path — never a forced restart.
    @ObservedObject var stagedPromptModel: AppUpdateStagedPromptModel
    /// Issue #96: bundled background-service lifecycle. The popover hosts
    /// the calm one-screen first-run consent and its follow-on states.
    @ObservedObject var setupModel: DaemonSetupModel
    /// Shared with the Settings pane; the SMAppService status read happens
    /// once in the model's load(), never in this struct's initializer (an
    /// XPC round-trip per App-body evaluation — the #68 re-render tax).
    @ObservedObject var launchAtLoginModel: LaunchAtLoginModel
    /// Issue #45: Settings opens via the environment action wrapped in
    /// activation + fronting (see SettingsWindowFronting) instead of a bare
    /// SettingsLink, which with the accessory activation policy opened the
    /// window behind the frontmost app or failed to raise an existing one.
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            menuBarSourceLine
            stagedUpdateBanner
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
        // Issue #230 (reopened): capture the popover's own NSWindow into
        // DeckWindowRegistry the moment SwiftUI hosts the deck, so the
        // dismissal choke point closes THE window instead of guessing
        // private class names (the guess broke on macOS 26). Background:
        // zero-size, hit-test-inert, renders nothing.
        .background(DeckWindowCaptureView())
        .onAppear {
            // Tim directive 2026-08-02: one diff per open, against the
            // snapshot stored at the PREVIOUS open — the changed cards glow
            // and roll their percent (see DeckAccountRowView). Cards animate
            // via onChange, so parent-after-child onAppear ordering is fine.
            deckModel.captureUsageChanges(state: statusModel.deckState)
        }
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
    /// Issue #178: clicking the active segment flips that mode's direction
    /// (see `sortControl`).
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

            // Issue #241 amendment to the "update chrome stays out of the
            // header" line below: the PASSIVE staged-update badge is the one
            // exception — a dismissed restart prompt must leave something
            // visible (staged-invisible is the #241 bug), and the header
            // corner is the deck's only always-rendered chrome.
            updateReadyBadge

            weeklyFocusControl

            sortControl

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
                        // Issue #163: the result presents in the floating
                        // update panel (activation handled inside), which
                        // transitions IN PLACE to the progress surface on
                        // Update Now and outlives this popover — a SwiftUI
                        // .alert here closed on the click and left no
                        // feedback at all (Tim's live 0.3.5 report).
                        // Issue #170: explicitCheck() never returns nil —
                        // an explicit check ALWAYS presents its outcome
                        // (up to date / update available / couldn't check);
                        // the old `if let resultDialog` silently dropped
                        // the click when a check was already in flight.
                        let dialog = await appUpdateModel.explicitCheck()
                        AppUpdateDialogPanel.present(
                            dialog: dialog,
                            installModel: appUpdateInstallModel
                        )
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
        }
    }

    /// Issue #249 (Tim's 2026-08-04 field report): the menu bar read "36%"
    /// while the cards, toggled to the model-window headline, showed 81%
    /// for the same account — the number looked like a tracking bug. This
    /// muted caption is the answer to "what is that number?": it names the
    /// account and WINDOW feeding the menu bar percent, and its tooltip
    /// states the mode's selection rule. Rendered only while the menu bar
    /// is actually showing a percent — a hidden number needs no explaining,
    /// and the icon-only / health modes keep their clean chrome.
    @ViewBuilder
    private var menuBarSourceLine: some View {
        if let line = statusModel.menuBarNumberSourceLine {
            Text(line.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .help(line.tooltip)
        }
    }

    /// Issue #254 (Tim, 2026-08-05): the window-focus toggle. ON makes every
    /// Claude card headline "Weekly · all models"; OFF restores whatever the
    /// card showed before (the model window when the Settings preference is
    /// on — so for that setup the button reads as the plain Fable ↔ Weekly
    /// switch it was asked for). Same visual language as the #30/#178 sort
    /// segments — one 16pt icon segment, selected background when active,
    /// tooltip and accessibility carrying the words — so the header gains a
    /// control, not a new idiom. Claude-only by construction (see
    /// `DeckAccountRow.worstWindow`); the glyph is a calendar because the
    /// thing it selects is the weekly window.
    private var weeklyFocusControl: some View {
        let isOn = deckModel.focusGeneralWeeklyHeadline
        return Button {
            deckModel.toggleGeneralWeeklyFocus()
        } label: {
            Image(systemName: "calendar")
                .font(.system(size: 10, weight: .medium))
                .frame(height: 16)
                .padding(.horizontal, 6)
                .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(isOn ? Color(nsColor: .controlBackgroundColor) : .clear)
                        .shadow(color: .black.opacity(isOn ? 0.15 : 0), radius: 0.75, y: 0.5)
                )
        }
        .buttonStyle(.plain)
        .foregroundStyle(isOn ? Color.primary : Color.secondary)
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .quaternarySystemFill))
        )
        .fixedSize()
        .help(isOn
            ? "Claude cards are showing the weekly (all models) window. Click to go back."
            : "Show the weekly (all models) window on Claude cards instead of the model window.")
        .accessibilityLabel("Weekly window on Claude cards")
        .accessibilityValue(isOn ? "on" : "off")
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
    }

    /// Issue #178 (Tim): the compact icon-segment sort control, hand-rolled
    /// because a segmented `Picker` cannot report a click on the segment
    /// that is already selected — and that click is now the direction
    /// toggle. Same visual language as the #30 control (small icon
    /// segments, tooltips + accessibility labels carry the names); the
    /// active segment additionally shows a tiny chevron (up = ascending,
    /// down = descending) — subtle, no header growth. First click on an
    /// inactive segment activates it with its remembered direction
    /// (unchanged behavior); a second click flips.
    private var sortControl: some View {
        HStack(spacing: 1) {
            ForEach(DeckSortOrder.allCases, id: \.self) { order in
                sortSegment(order)
            }
        }
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .quaternarySystemFill))
        )
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sort")
        .help("Sort accounts: next reset, lowest remaining, or grouped by provider. Click the active mode again to flip its direction.")
    }

    private func sortSegment(_ order: DeckSortOrder) -> some View {
        let isActive = deckModel.sortOrder == order
        let direction = deckModel.sortDirection(for: order)
        return Button {
            deckModel.selectSort(order)
        } label: {
            HStack(spacing: 2) {
                Image(systemName: order.iconName)
                    .font(.system(size: 10, weight: .medium))
                if isActive {
                    Image(systemName: direction == .ascending ? "chevron.up" : "chevron.down")
                        .font(.system(size: 6, weight: .bold))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(height: 16)
            .padding(.horizontal, isActive ? 5 : 6)
            .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(isActive ? Color(nsColor: .controlBackgroundColor) : .clear)
                    .shadow(color: .black.opacity(isActive ? 0.15 : 0), radius: 0.75, y: 0.5)
            )
        }
        .buttonStyle(.plain)
        .help(isActive
            ? "\(order.displayName) — \(order.directionDescription(direction)). Click again to flip."
            : order.displayName)
        .accessibilityLabel(order.displayName)
        .accessibilityValue(isActive ? order.directionDescription(direction) : "")
        .accessibilityHint(isActive
            ? "Reverses the sort direction"
            : "Sorts accounts by \(order.displayName.lowercased())")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    // MARK: - Staged-update restart prompt (issue #241)

    /// The proactive banner: a background update finished staging, offer
    /// the restart. Dismissible (→ the passive header badge), fires from
    /// the prompt model at most once per staged version, and Restart hands
    /// off to the existing #163 explicit quit→install→relaunch path.
    @ViewBuilder
    private var stagedUpdateBanner: some View {
        if case .prompting(let version) = stagedPromptModel.state {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(AppUpdateStagedPromptModel.bannerText(version: version))
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("Restart") {
                    stagedPromptModel.restartNow()
                }
                .controlSize(.small)
                .help("Quit, install v\(version), and reopen ModelDeck — the same one-click path as Update Now")
                .accessibilityLabel("Restart ModelDeck to finish updating")
                Button {
                    stagedPromptModel.dismissPrompt()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Dismiss — a small badge stays in the header until you restart")
                .accessibilityLabel("Dismiss update prompt")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .quaternarySystemFill))
            )
        }
    }

    /// The passive badge after a dismissal (#241): a quiet header glyph;
    /// clicking opens the explanation popover (via the #113 slot) that
    /// re-offers the one-click Restart.
    @ViewBuilder
    private var updateReadyBadge: some View {
        if case .badged(let version) = stagedPromptModel.state {
            let id = DeckWarningID(topic: .updateReady)
            Button {
                deckModel.toggleWarning(id)
            } label: {
                Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
            .help("ModelDeck \(version) is ready — click for the restart offer")
            .accessibilityLabel("Update ready: ModelDeck \(version)")
            .popover(isPresented: deckModel.warningBinding(id), arrowEdge: .bottom) {
                SignInExplanationView(
                    explanation: AppUpdateStagedPromptModel.badgeExplanation(version: version),
                    actionTitle: "Restart ModelDeck",
                    actionHelp: "Quit, install v\(version), and reopen ModelDeck — the same one-click path as Update Now",
                    actionAccessibilityLabel: "Restart ModelDeck to finish updating",
                    onSignInAgain: {
                        deckModel.setWarningPresented(id, false)
                        stagedPromptModel.restartNow()
                    }
                )
            }
        }
    }

    /// Issue #121: once "Update Now" starts (the dialog closes on press),
    /// the install's progress/failure lives HERE so it never disappears —
    /// the same honest status line the Settings row renders.
    /// Issue #241: while the staged restart prompt (banner or badge) owns
    /// the pending-relaunch story, the caption would say the same thing
    /// twice — it yields for exactly that phase and no other.
    @ViewBuilder
    private var installProgressLine: some View {
        if stagedPromptOwnsStatus {
            EmptyView()
        } else if let status = AppUpdateInstallModel.statusText(for: appUpdateInstallModel.phase) {
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

    /// Issue #241: true exactly when the phase is pending-relaunch AND the
    /// prompt model is presenting it (banner or badge) — the one case the
    /// #121 caption would duplicate.
    private var stagedPromptOwnsStatus: Bool {
        if case .installedPendingRelaunch = appUpdateInstallModel.phase {
            return stagedPromptModel.state != .hidden
        }
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

    /// Issue #226: launches the SAME add-account flow Settings uses — route
    /// the deck model's pending request to the Accounts pane (which presents
    /// the existing #8 `AddAccountSheet`), then open + front Settings. The
    /// #118 `beginSignInAgain` anatomy exactly; presenting the sheet inside
    /// the MenuBarExtra window instead would die the moment the popover
    /// auto-closes for the flow's own Terminal sign-in step.
    private func beginAddAccount() {
        deckModel.requestAddAccount()
        openSettings()
        SettingsWindowFronting.activateAndFront()
    }

    @ViewBuilder
    private var content: some View {
        if let state = statusModel.deckState, deckModel.isDeckEmpty(state: state) {
            // Issue #226: the fresh-install dead end (Tim's 2026-08-04 field
            // report) becomes the surface's ONE prominent next step. A single
            // provider-neutral CTA — the add flow's first screen already asks
            // Claude vs Codex — replaces two "No accounts" columns that
            // offered nothing actionable.
            emptyDeckCTA
        } else if let state = statusModel.deckState {
            // Issue #131: the ONE account whose window currently feeds the
            // menu bar percentage — the deck's single checkmark. Resolved
            // here (pin → fallback, MenuBarSourceResolver) so both layouts
            // mark from the same value and can never disagree. The tooltip
            // is likewise single-valued: only the source row renders it.
            let sourceID = statusModel.menuBarSourceAccountId
            // Issue #249: when the menu bar is showing this account's
            // percent, the tooltip also names the WINDOW feeding it.
            let numberSource = statusModel.menuBarPercentSource
            let sourceTooltip = sourceID.map { id in
                MenuBarSourceResolver.checkmarkTooltip(
                    pinnedSetting: statusModel.pinnedAccountId,
                    resolvedPinnedAccountID: statusModel.resolvedPinnedAccountId,
                    accountID: id,
                    windowTitle: numberSource.flatMap {
                        $0.accountId == id
                            ? MenuBarSourceResolver.windowDescriptor(for: $0.scope)
                            : nil
                    }
                )
            } ?? ""
            switch deckModel.layout {
            case .twoColumn:
                HStack(alignment: .top, spacing: 12) {
                    ForEach(deckModel.columns(for: state)) { column in
                        DeckColumnView(
                            column: column,
                            deckModel: deckModel,
                            healthPresentation: healthPresentation(for: column.provider, state: state),
                            menuBarSourceAccountID: sourceID,
                            menuBarSourceTooltip: sourceTooltip,
                            staleness: { statusModel.cardStaleness(for: $0) },
                            renewPresentation: { renewModel.presentation(for: $0.account) },
                            onRenewNow: { row in
                                Task { await renewModel.renew(account: row.account) }
                            },
                            onDismissRenewOutcome: { row in
                                // Issue #199: explicit dismiss re-arms the
                                // affordance — never a silent timeout.
                                renewModel.dismissOutcome(accountID: row.account.id)
                            },
                            signInPhase: { signInModel.phase(for: $0.id) },
                            signInError: { signInModel.error(for: $0.id) },
                            onVerifySignIn: { row in
                                Task { await signInModel.confirmSignedIn(account: row.account) }
                            },
                            onRelaunchSignIn: { signInModel.relaunch(accountID: $0.id) },
                            onCancelSignIn: { signInModel.cancel(accountID: $0.id) },
                            onDismissSignInError: { signInModel.dismissError(accountID: $0.id) }
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
                            staleness: statusModel.cardStaleness(for: row),
                            renew: renewModel.presentation(for: row.account),
                            onRenewNow: {
                                Task { await renewModel.renew(account: row.account) }
                            },
                            onDismissRenewOutcome: {
                                renewModel.dismissOutcome(accountID: row.account.id)
                            },
                            signInPhase: signInModel.phase(for: row.id),
                            signInError: signInModel.error(for: row.id),
                            onVerifySignIn: {
                                Task { await signInModel.confirmSignedIn(account: row.account) }
                            },
                            onRelaunchSignIn: { signInModel.relaunch(accountID: row.id) },
                            onCancelSignIn: { signInModel.cancel(accountID: row.id) },
                            onDismissSignInError: { signInModel.dismissError(accountID: row.id) }
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

    /// Issue #226: the empty-deck call to action — quiet copy in the deck's
    /// muted voice plus one small prominent button (the same Direction-A
    /// restraint as SignInExplanationView's single primary action; never an
    /// oversized hero button in a menu-bar popover).
    private var emptyDeckCTA: some View {
        VStack(spacing: 6) {
            Text("No accounts yet")
                .font(.system(size: 12, weight: .semibold))
            Text("Connect a Claude or Codex account to see its usage here.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Add Account…") { beginAddAccount() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .padding(.top, 4)
                .help("Create an isolated profile and sign in via the provider's own flow")
                .accessibilityLabel("Add account")
                .accessibilityHint("Opens Settings and starts the add-account flow")
        }
        .frame(maxWidth: .infinity, minHeight: 96)
    }

    /// Issue #226: the populated deck carries the quiet footer affordance
    /// instead — never both at once, so each state offers exactly ONE
    /// "Add Account" entry point (Tim's clarification on #226). Gated on a
    /// live connection too (CodeRabbit on PR #232): a failed refresh RETAINS
    /// the last deckState while flipping connection to `.unreachable`, and
    /// the flow's first step needs the daemon — same reason Settings
    /// disables its button — so retained stale state must not keep the
    /// affordance up while the daemon is down.
    private var showsFooterAddAccount: Bool {
        guard statusModel.connection == .connected,
              let state = statusModel.deckState else { return false }
        return !deckModel.isDeckEmpty(state: state)
    }

    /// Issue #235: one Availability Health evaluation per provider column,
    /// derived fresh from the same state render the columns use. Pure and
    /// cheap (a few dozen 168-step sims), so per-render recomputation is
    /// fine; tests exercise the engine with an injected clock.
    private func healthPresentation(
        for provider: DeckProvider,
        state: DeckState
    ) -> AvailabilityHealthPresentation {
        let now = Date()
        return AvailabilityHealthPresentation.make(
            report: AvailabilityHealthEngine.report(
                for: provider, state: state, now: now,
                // Issue #244: the short-window burn rate makes an active
                // burst a first-class scenario; nil (cold window) keeps
                // the pre-#244 evaluation exactly.
                burstPointsPerDay: statusModel.burstRate(for: provider)
            ),
            now: now
        )
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
                            // Issue #168 (review): the explained summary
                            // grows with account counts — the footer's
                            // one-line footprint is a Tim contract.
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .foregroundStyle(status?.isStale == true && !statusModel.isRefreshing
                                ? AnyShapeStyle(severityColor(.warning))
                                : AnyShapeStyle(.secondary))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // Issue #168: the tooltip rides on the model's
                    // FooterStatus so the neutral explained-staleness
                    // summary ("Live accounts current · 3 idle") explains
                    // itself instead of claiming to be an age readout.
                    .help(status?.tooltip
                        ?? MenuBarStatusModel.FooterStatus.freshTooltip)
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
            if showsFooterAddAccount {
                // Issue #226: growing the pool never requires the Settings
                // detour. One modest surface-level affordance in the footer —
                // where the deck's other surface action (Refresh) already
                // lives — never per-column buttons (the add flow's next
                // screen asks Claude vs Codex itself).
                Button {
                    beginAddAccount()
                } label: {
                    Label("Add account", systemImage: "plus")
                }
                .help("Create an isolated profile and sign in via the provider's own flow")
                .accessibilityLabel("Add account")
                .accessibilityHint("Opens Settings and starts the add-account flow")
            }
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
    /// Issue #235: the provider's Availability Health chip content — the
    /// tier-aware 7-day runway verdict beside the column title. Nil renders
    /// no chip (previews/tests default).
    var healthPresentation: AvailabilityHealthPresentation? = nil
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
    /// Issue #176: per-row renew state + action, supplied by the popover so
    /// the column stays free of the renew model (same seam shape as
    /// `staleness`). Defaults render nothing for previews/tests.
    var renewPresentation: (DeckAccountRow) -> AccountRenewPresentation? = { _ in nil }
    var onRenewNow: (DeckAccountRow) -> Void = { _ in }
    /// Issue #199: per-row dismiss for the inline renew outcome line.
    var onDismissRenewOutcome: (DeckAccountRow) -> Void = { _ in }
    /// Issue #213: per-row sign-in flow state + actions, supplied by the
    /// popover so the column stays free of the sign-in model (same seam
    /// shape as `renewPresentation`). Defaults render nothing for
    /// previews/tests.
    var signInPhase: (DeckAccountRow) -> AccountSignInModel.Phase? = { _ in nil }
    var signInError: (DeckAccountRow) -> String? = { _ in nil }
    var onVerifySignIn: (DeckAccountRow) -> Void = { _ in }
    var onRelaunchSignIn: (DeckAccountRow) -> Void = { _ in }
    var onCancelSignIn: (DeckAccountRow) -> Void = { _ in }
    var onDismissSignInError: (DeckAccountRow) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                ProviderMarkView(provider: column.provider, size: 20)
                Text(column.title)
                    .font(.system(size: 13, weight: .semibold))
                if let healthPresentation {
                    // Issue #235: the Availability Health chip — a colored
                    // dot + verdict word in the deck's quiet caption voice.
                    // Click opens the detail popover (gauge, readout,
                    // facts); never a banner.
                    AvailabilityHealthChip(
                        presentation: healthPresentation,
                        deckModel: deckModel,
                        warningID: DeckWarningID(
                            topic: .availabilityHealth,
                            elementID: column.provider.rawValue
                        )
                    )
                }
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
                        staleness: staleness(row),
                        renew: renewPresentation(row),
                        onRenewNow: { onRenewNow(row) },
                        onDismissRenewOutcome: { onDismissRenewOutcome(row) },
                        signInPhase: signInPhase(row),
                        signInError: signInError(row),
                        onVerifySignIn: { onVerifySignIn(row) },
                        onRelaunchSignIn: { onRelaunchSignIn(row) },
                        onCancelSignIn: { onCancelSignIn(row) },
                        onDismissSignInError: { onDismissSignInError(row) }
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
    /// Issue #176: this account's renew rendering state (nil = no renew
    /// affordance: healthy, signed out, Codex, or a pre-#176 daemon), and
    /// the action that runs the daemon's guarded renew op. Plain values so
    /// the card stays free of the renew model (the popover observes it).
    var renew: AccountRenewPresentation? = nil
    var onRenewNow: (() -> Void)? = nil
    /// Issue #199: clears the inline outcome line (the click site's answer)
    /// and re-arms the renew affordance — the row's explicit dismiss, same
    /// contract as the Settings row's xmark.
    var onDismissRenewOutcome: (() -> Void)? = nil
    /// Issue #213: this account's sign-in-flow state (`AccountSignInModel`,
    /// the SAME per-account slots the Settings roster renders), so the
    /// duplicate "Re-log in…" flow answers on the card that launched it.
    /// Plain values + callbacks, same seam shape as `renew` — the card
    /// stays free of the sign-in model (the popover observes it).
    var signInPhase: AccountSignInModel.Phase? = nil
    var signInError: String? = nil
    var onVerifySignIn: (() -> Void)? = nil
    var onRelaunchSignIn: (() -> Void)? = nil
    var onCancelSignIn: (() -> Void)? = nil
    /// Issue #213: dismisses an error shown with no active phase (a flow
    /// that failed to start); mid-flow errors clear via the flow's own
    /// actions instead.
    var onDismissSignInError: (() -> Void)? = nil
    let onToggle: () -> Void
    /// Issue #118: the "Sign in again…" action opens the Settings window
    /// (Accounts pane, via the model's routed selection) — the environment
    /// action lives here because only views can reach it.
    @Environment(\.openSettings) private var openSettings

    // Tim directive 2026-08-02 ("what changed since I last looked"): when
    // the popover-open diff says this card's headline moved, the card glows
    // softly for a moment and the percent rolls from the old value to the
    // new one. Purely decorative — VoiceOver reads the live values only.
    @State private var glowOpacity: Double = 0
    /// Non-nil only during the roll: the value the headline TEXT renders
    /// while the odometer transition plays; cleared afterwards so a mid-open
    /// refresh can never leave a stale number on screen.
    @State private var rollingRemaining: Double?
    /// The last capture generation this card animated for. Generation-keyed
    /// (not a one-shot flag) because MenuBarExtra window content can stay
    /// alive across opens — surviving @State must not silence later opens.
    @State private var animatedGeneration = 0

    private var usageChange: DeckUsageChange? {
        deckModel.usageChange(for: row.id)
    }

    private func animateChangeIfNeeded() {
        guard animatedGeneration != deckModel.usageCaptureGeneration else { return }
        animatedGeneration = deckModel.usageCaptureGeneration
        guard let change = usageChange else { return }
        glowOpacity = 1
        rollingRemaining = change.previousRemaining
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            withAnimation(.easeOut(duration: 1.1)) {
                rollingRemaining = change.currentRemaining
            }
            withAnimation(.easeOut(duration: 2.6).delay(0.4)) {
                glowOpacity = 0
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            rollingRemaining = nil
        }
    }

    /// The collapsed headline's text: the old value only while the roll
    /// plays AND the diffed window is still the one displayed (same scope,
    /// percent form) — a card whose binding window switched mid-open renders
    /// the live truth immediately.
    private func headlineText(worst: DeckWindow, live: String) -> String {
        guard let rolling = rollingRemaining,
              let change = usageChange,
              change.scope == worst.scope,
              worst.remainingText != nil
        else { return live }
        return "\(Int(rolling.rounded()))% left"
    }

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

    /// Issue #152 — the duplicate-login warning's one-click path: dismiss
    /// the explanation and fire the model's re-login request, which the app
    /// resolves against fresh state and hands to the SAME
    /// `AccountSignInModel.beginSignIn` flow as the roster chip.
    ///
    /// Issue #213 (Tim's field report 2026-08-02): NO Settings hop anymore.
    /// The old `openSettings()` + fronting raced Terminal's own `activate`
    /// and lost to the status-level deck window, so the click read as a
    /// no-op — and the roster's identical "Re-log in" button then invited a
    /// restart. The flow now renders inline on this card (`signInFlow`
    /// below), and Terminal — the thing the user must interact with — is
    /// the only window the launch brings forward.
    private func beginDuplicateRelogin() {
        deckModel.requestDuplicateRelogin(for: row)
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
                    // Issue #152: VoiceOver can skip the popover hop — the
                    // named action runs the same one-click re-login path the
                    // popover's "Re-log in…" button offers.
                    Button("Re-log in this profile") {
                        beginDuplicateRelogin()
                    }
                }
            }

            if isExpanded {
                expandedWindows
            }

            // Issue #213: the sign-in flow answers ON the card that
            // launched it — progress, the awaiting step (Verify /
            // Re-log in / cancel, the same anatomy as the Settings
            // roster's slot), and any error, all from the shared
            // per-account `AccountSignInModel` state. The roster and this
            // card render the same flow; neither can restart it behind the
            // other's back (`beginSignIn` is re-entrancy-guarded).
            signInFlow

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
            // Issue #149 (Tim directive): the idle-decay tone renders in the
            // SAME slot with the SAME click path — only glyph, color, and
            // wording calm down (neutral secondary, never amber). Zero
            // functionality lost in either tone.
            if renew?.display == .progress {
                // Issue #176: while the daemon runs this account's renewal
                // the notice slot itself carries the progress — the SAME
                // single-line footprint (Tim's constraint on PR #150: the
                // notice may never grow the card), calm secondary tone.
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Renewing sign-in…")
                        .font(.system(size: 10))
                        .lineLimit(1)
                }
                .foregroundStyle(Color.secondary)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Renewing sign-in for \(row.account.label)")
            } else if case .outcome(let text, let kind)? = renew?.display {
                // Issue #199 (Tim's field report, first hour on 0.3.11): the
                // decided outcome renders HERE, in the very slot the progress
                // line just occupied — never only in the explanation's "Last
                // renewal attempt" small print, where a busy refusal read as
                // a dead button. Same one-line footprint (the PR #150
                // no-growth contract), daemon detail verbatim, and it holds
                // the slot until dismissed (the #196 Settings outcome-line
                // pattern) so the button can't silently re-arm into an
                // apparent no-op. Busy is prominent-and-calm: primary tone,
                // hourglass — a promise to renew, not an alarm.
                HStack(spacing: 4) {
                    Image(systemName: AccountRenew.glyph(for: kind))
                        .font(.system(size: 9, weight: .semibold))
                    Text(text)
                        .font(.system(size: 10))
                        .lineLimit(1)
                    if let onDismissRenewOutcome {
                        Button(action: onDismissRenewOutcome) {
                            Image(systemName: "xmark")
                                .font(.system(size: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Dismiss renewal result for \(row.account.label)")
                    }
                }
                .foregroundStyle(kind == .busy ? Color.primary : Color.secondary)
                .help(text)
            } else if let recovery = row.signInRecovery {
                let warningID = DeckWarningID(topic: .signInRequired, elementID: row.id)
                Button {
                    deckModel.toggleWarning(warningID)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: recovery.tone == .idle
                            ? "moon.zzz"
                            : "person.crop.circle.badge.exclamationmark")
                            .font(.system(size: 9, weight: .semibold))
                        Text(recovery.text)
                            .font(.system(size: 10))
                            // Orchestrator verify on PR #150 (Tim's
                            // constraint 1): the notice may NEVER grow the
                            // card — one line, both tones, truncation beats
                            // growth if wording ever drifts. The full copy
                            // stays reachable in the click-through
                            // explanation and the tooltip.
                            .lineLimit(1)
                    }
                    .foregroundStyle(recovery.tone == .idle
                        ? Color.secondary
                        : severityColor(.warning))
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
                // Issue #176: VoiceOver can renew without the popover hop
                // too — same action the explanation's button runs, INCLUDING
                // the dismissal (CodeRabbit, PR #196): the notice swaps to
                // the progress line mid-renewal, and a presented-warning slot
                // left set on a vanished anchor re-presents the popover the
                // moment the notice returns.
                .accessibilityActions {
                    if renew?.action == .renewNow, let onRenewNow {
                        Button("Renew sign-in now") {
                            deckModel.setWarningPresented(warningID, false)
                            onRenewNow()
                        }
                    }
                }
                .popover(isPresented: deckModel.warningBinding(warningID), arrowEdge: .bottom) {
                    // Issue #176: the idle explanation carries the renew
                    // story — the "Renew now" secondary action (with the
                    // honest tiny-invocation / 5-hour-window disclosure in
                    // the body and tooltip) when the daemon says it can, or
                    // the calm authOverride sentence in the body when it
                    // honestly can't. The #118 sign-in path stays primary.
                    SignInExplanationView(
                        explanation: .signIn(recovery, renew: renew),
                        secondaryTitle: renew?.action == .renewNow ? "Renew now" : nil,
                        secondaryHelp: "Renews this account's sign-in in the background. "
                            + AccountRenew.disclosure,
                        secondaryAccessibilityLabel: "Renew sign-in for \(row.account.label)",
                        onSecondary: renew?.action == .renewNow && onRenewNow != nil
                            ? {
                                deckModel.setWarningPresented(warningID, false)
                                onRenewNow?()
                            }
                            : nil
                    ) {
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
            // Issue #185 (Tim, live): the explanation must offer the FIX,
            // not just the diagnosis — same anatomy as the #118 sign-in
            // popover, with "Refresh now" running the footer button's
            // forced provider poll (#72). The body copy is cause-classified
            // (helper-missing renders coaching, never a dead spawn path).
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
                // VoiceOver can skip the popover hop: the named action runs
                // the same one-click refresh the popover's button offers.
                .accessibilityAction(named: "Refresh now") {
                    deckModel.requestStaleRefresh()
                }
                .popover(isPresented: deckModel.warningBinding(warningID), arrowEdge: .bottom) {
                    SignInExplanationView(
                        explanation: .stale(staleness),
                        actionTitle: "Refresh now",
                        actionHelp: "Ask the daemon to poll the providers for fresh usage now",
                        actionAccessibilityLabel: "Refresh usage data now"
                    ) {
                        deckModel.requestStaleRefresh()
                    }
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
        // The change glow: a soft accent halo (hairline + shadow, no fill)
        // that fades out over ~3 s — noticeable when you look, invisible
        // when you don't. Accent, never a severity color: "this moved" is
        // information, not an alarm. Decorative only (glowOpacity is 0 for
        // unchanged cards and the overlay hit-tests nothing).
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(0.5 * glowOpacity), lineWidth: 1)
                .allowsHitTesting(false)
        )
        .shadow(color: Color.accentColor.opacity(0.32 * glowOpacity), radius: 7)
        .onAppear(perform: animateChangeIfNeeded)
        // The open-diff publishes AFTER children appear (parent onAppear
        // ordering), so the trigger listens for the capture generation too;
        // the per-generation guard keeps it one-shot per open.
        .onChange(of: deckModel.usageCaptureGeneration) { animateChangeIfNeeded() }
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

    /// Issue #213: the card's inline sign-in flow surface — the same phase
    /// grammar as the Settings roster's `signInControls`, sized to the card
    /// (10 pt text, mini controls). The awaiting step keeps all three
    /// affordances — Verify (daemon read-back), Re-log in (reopens Terminal
    /// with the SAME stored command, never a flow restart), cancel —
    /// because Terminal can be closed or its automation prompt denied. The
    /// error line renders in warning tint; a flow that never started
    /// (phase nil) carries its own dismiss xmark.
    @ViewBuilder
    private var signInFlow: some View {
        switch signInPhase {
        case .launching, .activating, .verifying:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text(signInProgressText)
                    .font(.system(size: 10))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.secondary)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(signInProgressText) \(row.account.label)")
        case .awaitingSignIn:
            HStack(spacing: 5) {
                Text("Waiting for login in Terminal…")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Button("Verify") { onVerifySignIn?() }
                    .controlSize(.mini)
                    .help("Check with the provider that this profile is now signed in")
                Button("Re-log in") { onRelaunchSignIn?() }
                    .controlSize(.mini)
                    .help("Open Terminal with the provider's login command again — use this if no Terminal window appeared or you closed it")
                Button {
                    onCancelSignIn?()
                } label: {
                    Image(systemName: "xmark")
                }
                .controlSize(.mini)
                .accessibilityLabel("Cancel sign-in for \(row.account.label)")
            }
        case nil:
            EmptyView()
        }
        if let signInError {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 9, weight: .semibold))
                Text(signInError)
                    .font(.system(size: 10))
                    .fixedSize(horizontal: false, vertical: true)
                if signInPhase == nil, let onDismissSignInError {
                    Button(action: onDismissSignInError) {
                        Image(systemName: "xmark")
                            .font(.system(size: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss sign-in error for \(row.account.label)")
                }
            }
            .foregroundStyle(severityColor(.warning))
            .help(signInError)
        }
    }

    /// Issue #213: same wording as the Settings roster's progress line.
    private var signInProgressText: String {
        switch signInPhase {
        case .verifying: return "Verifying…"
        case .activating: return "Activating this account for sign-in…"
        default: return "Opening Terminal…"
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
                    // Issue #152: the explanation names THIS profile and
                    // carries the "Re-log in…" one-click action — the deck
                    // row itself stays one line (the action lives inside
                    // the popover, never on the collapsed row).
                    DuplicateTokenMarkerView(
                        isExplaining: deckModel.warningBinding(
                            DeckWarningID(topic: .duplicateToken, elementID: row.id)
                        ),
                        explanation: .duplicateToken(
                            reloginLabel: row.account.label,
                            provider: row.provider
                        ),
                        onRelogin: { beginDuplicateRelogin() }
                    )
                }
                if let weight = row.account.proxyWeight {
                    // Proxy routing weight: deliberately the quietest element
                    // on the row — tier-scale, secondary, grouped with the
                    // title cluster so it never competes with the headline
                    // percent. Absent field (no proxy) renders nothing.
                    ProxyWeightBadge(weight: weight)
                }
                Spacer(minLength: 8)
                // Issue #33 amendment: the headline percent only exists
                // while collapsed — expanded rows carry their own numbers.
                // Issue #139: on a spend-headlined card (spend-only account)
                // the value is the payload-stated dollars, like the row.
                if let worst = row.headlineWindow(isExpanded: isExpanded),
                   let remainingText = worst.valueText {
                    Text(headlineText(worst: worst, live: remainingText))
                        .font(DeckType.value)
                        .foregroundStyle(valueColor(for: worst))
                        .monospacedDigit()
                        // The old→new odometer roll during the change
                        // animation; inert (no text change) otherwise.
                        .contentTransition(.numericText(
                            countsDown: (usageChange?.currentRemaining ?? 0) < (usageChange?.previousRemaining ?? 0)
                        ))
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
    /// Issue #145 (generalizing #143): ANY window without a real reset —
    /// rate-limit or spend — suppresses the former "no reset data"
    /// placeholder (`displayedResetText` is nil) and the slot renders
    /// nothing at all. The #101 unanchored copy and real timestamps render
    /// as always; the tooltip keeps the fuller explanation either way.
    @ViewBuilder
    private func resetTextView(for window: DeckWindow) -> some View {
        if let reset = window.displayedResetText {
            Text(reset)
                .font(DeckType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
                // Issue #101: unanchored windows explain the fresh-window
                // state here instead of surfacing the placeholder timestamp;
                // anchored windows keep the issue #67 absolute-timestamp
                // backstop.
                .help(window.resetTooltip)
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
/// Issue #152: the duplicate-login explanation reuses this exact anatomy
/// with "Re-log in…" wording — the action parameters exist so the two
/// surfaces share one view instead of growing parallel popovers.
struct SignInExplanationView: View {
    let explanation: DeckWarningExplanation
    var actionTitle: String = "Sign in again…"
    var actionHelp: String = "Opens Settings → Accounts and starts this account's sign-in flow"
    var actionAccessibilityLabel: String = "Sign in again for this account"
    /// Issue #176: optional second action beside the primary — the idle
    /// notice's "Renew now" renders here (the #152 lesson: row actions live
    /// inside the explanation popover, never on the collapsed row). Nil
    /// keeps every existing call site pixel-identical.
    var secondaryTitle: String?
    var secondaryHelp: String = ""
    var secondaryAccessibilityLabel: String = ""
    var onSecondary: (() -> Void)?
    let onSignInAgain: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(explanation.title)
                .font(.system(size: 12, weight: .semibold))
            Text(explanation.body)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(action: onSignInAgain) {
                    Text(actionTitle)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .help(actionHelp)
                .accessibilityLabel(actionAccessibilityLabel)
                if let secondaryTitle, let onSecondary {
                    Button(action: onSecondary) {
                        Text(secondaryTitle)
                    }
                    .controlSize(.small)
                    .help(secondaryHelp)
                    .accessibilityLabel(secondaryAccessibilityLabel)
                }
            }
            .padding(.top, 4)
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
    }
}

// MARK: - Availability Health (issue #235)

/// The verdict's display color: green/gold/red matching the band names
/// (the deck's blue-healthy palette is per-window severity; the health
/// verdict is its own locked traffic-light language). Nil verdict — no
/// usable accounts — renders the muted secondary tone.
func availabilityColor(_ verdict: AvailabilityVerdict?) -> Color {
    switch verdict {
    case .green: return Color(nsColor: .systemGreen)
    case .yellow: return severityColor(.warning)
    case .red: return .red
    case nil: return .secondary
    }
}

/// Issue #235: the per-provider Availability Health chip beside the column
/// title — a shape-coded dot, deliberately in the deck's quiet caption
/// voice. Issue #242: the verdict word is OFF by default (noise for most
/// users, per Tim) and returns behind Settings → General → Accessibility's
/// "Show health verdict labels" toggle; the dot carries the menu bar's #235
/// shape coding (shared `AvailabilityVerdictShape`) so color is never the
/// only signal even without the word. Clicking opens the detail popover
/// through the model's one-at-a-time presentation slot (the #113
/// click-to-explain idiom; tooltips are unreliable inside MenuBarExtra
/// windows) — tooltip, popover, and the VoiceOver summary are identical in
/// both label modes.
struct AvailabilityHealthChip: View {
    let presentation: AvailabilityHealthPresentation
    @ObservedObject var deckModel: DeckPopoverModel
    let warningID: DeckWarningID

    var body: some View {
        let display = AvailabilityHealthChipDisplay.make(
            verdict: presentation.verdict,
            chipWord: presentation.chipWord,
            showsVerdictLabels: deckModel.showsHealthVerdictLabels
        )
        Button {
            deckModel.toggleWarning(warningID)
        } label: {
            HStack(spacing: 4) {
                VerdictDotView(
                    shape: display.shape,
                    color: availabilityColor(presentation.verdict)
                )
                if let word = display.word {
                    Text(word)
                        .font(DeckType.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(presentation.chipTooltip)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.accessibilitySummary)
        .accessibilityHint("Shows the availability details")
        .popover(isPresented: deckModel.warningBinding(warningID), arrowEdge: .bottom) {
            AvailabilityHealthPopoverView(presentation: presentation)
        }
    }
}

/// Issue #242: the chip's verdict dot — the same shape coding as the menu
/// bar's status dot (green circle / yellow triangle / red octagon / hollow
/// no-data ring), drawn from the shared Core geometry so the two surfaces
/// can never drift apart.
struct VerdictDotView: View {
    let shape: AvailabilityVerdictShape
    let color: Color
    var size: CGFloat = 7

    var body: some View {
        let dotShape = VerdictDotShape(shape: shape)
        Group {
            if shape.isStroked {
                dotShape.stroke(
                    color,
                    lineWidth: AvailabilityVerdictShape.ringLineWidth
                )
            } else {
                dotShape.fill(color)
            }
        }
        .frame(width: size, height: size)
    }
}

/// SwiftUI wrapper over the shared Core path geometry. The Core paths are
/// authored in AppKit's unflipped coordinates (triangle apex at maxY = top);
/// SwiftUI's space is flipped, so the path is mirrored about the rect's
/// vertical midline to keep the triangle pointing up.
struct VerdictDotShape: Shape {
    let shape: AvailabilityVerdictShape

    func path(in rect: CGRect) -> Path {
        let flip = CGAffineTransform(translationX: 0, y: 2 * rect.midY)
            .scaledBy(x: 1, y: -1)
        return Path(shape.path(in: rect)).applying(flip)
    }
}

/// Tim's #235 refinement: the 0–100 sustainable-pace bar — three colored
/// segments (red 0–33, yellow 33–66, green 66–100) with a needle at the
/// current score, so "where within the band" is visible at a glance.
/// Decorative: the readout sentence beside it speaks the same value.
struct AvailabilityGaugeView: View {
    /// 0–100, from `AvailabilityHealthEngine.displayScore(forMultiple:)`.
    let score: Double

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                HStack(spacing: 2) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Color.red.opacity(0.35))
                        .frame(width: width * 0.33)
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(severityColor(.warning).opacity(0.4))
                        .frame(width: width * 0.33)
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Color(nsColor: .systemGreen).opacity(0.4))
                        .frame(maxWidth: .infinity)
                }
                .frame(height: 6)
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.primary)
                    .frame(width: 2, height: 12)
                    .offset(x: min(max(score / 100, 0), 1) * (width - 2))
            }
            .frame(height: 12)
        }
        .frame(height: 12)
        .accessibilityHidden(true)
    }
}

/// Issue #235: the chip's click-open detail popover — gauge + needle, the
/// plain-language sustainable-pace readout, the non-jargon decision
/// paragraph, then the numbers (pool, pace, 7-day low, drought time when
/// applicable, burst headroom, next big reset) and the honest exclusions.
/// Every string comes from `AvailabilityHealthPresentation` (Core, tested).
struct AvailabilityHealthPopoverView: View {
    let presentation: AvailabilityHealthPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(presentation.title)
                .font(.system(size: 12, weight: .semibold))
            if let score = presentation.score {
                AvailabilityGaugeView(score: score)
            }
            Text(presentation.readout)
                .font(.system(size: 11, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            Text(AvailabilityHealthPresentation.meaningParagraph)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !presentation.factLines.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(presentation.factLines, id: \.self) { line in
                        Text(line)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if let excluded = presentation.excludedLine {
                Text(excluded)
                    .font(.system(size: 10))
                    .foregroundStyle(severityColor(.warning))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let unknownTiers = presentation.unknownTierLine {
                Text(unknownTiers)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(AvailabilityHealthPresentation.pointsFootnote)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(width: 300, alignment: .leading)
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

/// CLIProxyAPI routing weight beside the account title: a small branch
/// glyph + digit at the tier scale, secondary throughout — ambient context
/// (which accounts the proxy currently favors), never a headline. The
/// tooltip explains the number; the glyph is routing, not health, so it
/// never uses severity color. Weight 0 renders too: "the proxy has parked
/// this account" is exactly the fact worth seeing.
struct ProxyWeightBadge: View {
    let weight: Int

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 8.5))
            Text("\(weight)")
                .font(DeckType.tier)
                .monospacedDigit()
        }
        .foregroundStyle(.secondary)
        .help("Proxy routing weight \(weight) — rebalanced hourly from remaining quota")
        .accessibilityLabel("Proxy routing weight \(weight)")
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
    /// Issue #152: the explanation this marker's popover shows. Call sites
    /// that can name the account pass `.duplicateToken(reloginLabel:provider:)`
    /// so the popover says WHICH profile the action re-logs; the default
    /// keeps the label-free #65/#113 copy.
    var explanation: DeckWarningExplanation = .duplicateToken()
    /// Issue #152 (Tim: "I need something clickable to fix the issue"):
    /// when set, the explanation popover carries a "Re-log in…" primary
    /// action — the same one-click anatomy as #118's sign-in path. The
    /// action only launches the provider's own login flow for this profile;
    /// nothing automatic, running sessions never touched.
    var onRelogin: (() -> Void)?
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
                if let onRelogin {
                    SignInExplanationView(
                        explanation: explanation,
                        actionTitle: "Re-log in…",
                        actionHelp: "Opens Settings → Accounts and launches "
                            + "the provider's own login for this profile",
                        actionAccessibilityLabel: "Re-log in this profile",
                        onSignInAgain: onRelogin
                    )
                } else {
                    WarningExplanationView(explanation: explanation)
                }
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
