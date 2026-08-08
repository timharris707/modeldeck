import Foundation
import Observation

// Issue #7 — view models behind the Settings window's Accounts and CLI tools
// sections. Pure orchestration over protocol seams so the logic is testable
// without a live daemon.

/// Seam for the Accounts pane's mutations; `DaemonClient` conforms.
public protocol AccountEditing: Sendable {
    /// Upsert via `POST /api/accounts` — used here strictly for editing an
    /// existing roster account (label / purpose / color).
    func saveAccount(_ edit: AccountEdit) async throws -> DeckAccount
    /// `DELETE /api/accounts/:id` — removes only ModelDeck's reference.
    func deleteAccount(id: String) async throws
}

extension DaemonClient: AccountEditing {}

/// Seam for the per-profile statusline capture opt-in (issue #174);
/// `DaemonClient` conforms.
public protocol StatuslineConfiguring: Sendable {
    /// `POST /api/accounts/:id/statusline/{install|uninstall}`.
    func setClaudeStatuslineCapture(accountID: String, enabled: Bool) async throws -> ClaudeStatuslineOptIn
}

extension DaemonClient: StatuslineConfiguring {}

/// Accounts pane logic: edit (label / purpose / color) and remove-behind-
/// confirm. After a successful mutation it re-reads `GET /api/state` and
/// hands the fresh state to `onStateChanged` so the popover/menu bar update
/// immediately.
@MainActor
public final class AccountsSettingsModel: ObservableObject {
    @Published public private(set) var busyAccountID: String?
    @Published public private(set) var lastError: String?
    /// Issue #194: non-nil while a statusline install/uninstall is in flight
    /// for that account — the row's visible capture control renders its
    /// spinner from this, distinct from the generic `busyAccountID` so an
    /// edit/remove never puts a spinner on the capture control.
    @Published public private(set) var statuslineBusyAccountID: String?

    /// Fresh daemon state after a successful edit/remove; the app pushes it
    /// into `MenuBarStatusModel.apply(deckState:)`.
    public var onStateChanged: ((DeckState) -> Void)?

    private let editor: any AccountEditing
    private let stateProvider: any DeckStateProviding
    /// Issue #174: optional so existing call sites (and old tests) build
    /// unchanged; without it the statusline toggle simply does nothing.
    private let statusline: (any StatuslineConfiguring)?

    public init(
        editor: any AccountEditing,
        stateProvider: any DeckStateProviding,
        statusline: (any StatuslineConfiguring)? = nil
    ) {
        self.editor = editor
        self.stateProvider = stateProvider
        self.statusline = statusline
    }

    /// Whether an account can be edited at all: the daemon must have
    /// reported its profileRef (required by the upsert endpoint).
    public static func canEdit(_ account: DeckAccount) -> Bool {
        !(account.profileRef ?? "").isEmpty
    }

    /// Save an edit. Returns true on success (the sheet closes).
    @discardableResult
    public func saveEdit(account: DeckAccount, label: String, purpose: String, color: String?) async -> Bool {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLabel.isEmpty else {
            lastError = "The label can't be empty."
            return false
        }
        guard let edit = AccountEdit(account: account, label: trimmedLabel, purpose: purpose, color: color) else {
            lastError = "This account can't be edited — the daemon didn't report its profile reference."
            return false
        }
        return await perform(accountID: account.id) {
            _ = try await self.editor.saveAccount(edit)
        }
    }

    /// Issue #174: enable/disable the per-profile statusline capture tee.
    /// Claude accounts only — the view offers the control solely where the
    /// daemon reported a `claudeStatusline` state. Returns true on success;
    /// the fresh daemon state (with the flipped `claudeStatusline.installed`)
    /// flows through `onStateChanged` like every other roster mutation.
    @discardableResult
    public func setStatuslineCapture(account: DeckAccount, enabled: Bool) async -> Bool {
        guard let statusline else {
            lastError = "Statusline capture isn't available in this build."
            return false
        }
        // CodeRabbit PR #304: mirror `perform`'s single-mutation guard BEFORE
        // touching the busy marker. Without this, clicking row B's capture
        // control while row A's mutation is in flight would set the marker to
        // B, have `perform` reject the call, and B's defer would then clear
        // the marker while A still runs — stealing A's control spinner.
        guard busyAccountID == nil else { return false }
        statuslineBusyAccountID = account.id
        defer { statuslineBusyAccountID = nil }
        return await perform(accountID: account.id) {
            _ = try await statusline.setClaudeStatuslineCapture(accountID: account.id, enabled: enabled)
        }
    }

    /// Remove an account (the confirmation dialog lives in the view).
    /// Deletes only ModelDeck's reference — never provider credentials.
    @discardableResult
    public func remove(account: DeckAccount) async -> Bool {
        await perform(accountID: account.id) {
            try await self.editor.deleteAccount(id: account.id)
        }
    }

    private func perform(accountID: String, _ mutation: () async throws -> Void) async -> Bool {
        guard busyAccountID == nil else { return false }
        busyAccountID = accountID
        lastError = nil
        defer { busyAccountID = nil }
        do {
            try await mutation()
        } catch {
            lastError = SettingsSyncModel.message(for: error)
            return false
        }
        // The mutation succeeded; a failed follow-up state read must not be
        // reported as a failed edit/delete — surface it as a soft warning.
        do {
            let fresh = try await stateProvider.deckState()
            onStateChanged?(fresh)
        } catch {
            lastError = "Saved, but refreshing state failed: \(SettingsSyncModel.message(for: error))"
        }
        return true
    }
}

/// Seam for the CLI tools probe; `DaemonClient` conforms.
public protocol ToolsProbing: Sendable {
    func tools(refresh: Bool) async throws -> ToolsProbeResponse
}

extension DaemonClient: ToolsProbing {}

/// CLI tools section: shows the cached probe (installed vs. latest vs. auth
/// state). Since issue #33 there is NO manual re-check control — opening the
/// General pane fires the token-gated forced probe automatically (debounced),
/// and the per-CLI Update pills render from the fresh result.
@MainActor
public final class ToolsStatusModel: ObservableObject {
    /// Minimum spacing between pane-open forced probes. Rapid pane
    /// open/close inside this window degrades to cheap cached reads (the
    /// daemon's own probe cache already absorbs most of the cost).
    public static let paneProbeDebounce: TimeInterval = 30

    @Published public private(set) var probe: ToolsProbeResponse?
    @Published public private(set) var isChecking = false
    @Published public private(set) var lastError: String?

    private let prober: any ToolsProbing
    private let clock: @Sendable () -> Date
    private var lastPaneProbeAt: Date?

    public init(prober: any ToolsProbing, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.prober = prober
        self.clock = clock
    }

    /// `refresh: false` reads the daemon's cache (cheap, no token);
    /// `refresh: true` is the forced probe (`/api/tools?refresh=1`,
    /// mutation-token gated — re-probes binaries and the npm registry).
    public func load(refresh: Bool = false) async {
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        do {
            probe = try await prober.tools(refresh: refresh)
            lastError = nil
        } catch {
            lastError = SettingsSyncModel.message(for: error)
        }
    }

    /// Issue #33: General pane appear → automatic forced re-probe, so users
    /// never have to ask the app to look for CLI updates. Debounced: within
    /// `paneProbeDebounce` of the last forced probe it only re-reads the
    /// daemon cache (still populates on first show). The debounce stamp is
    /// taken up front so overlapping appears can't double-fire the forced
    /// path; a failed probe stays debounced too — the next pane open after
    /// the window retries.
    public func probeOnPaneOpen() async {
        let now = clock()
        if let last = lastPaneProbeAt, now.timeIntervalSince(last) < Self.paneProbeDebounce {
            await load(refresh: false)
            return
        }
        lastPaneProbeAt = now
        await load(refresh: true)
    }
}
