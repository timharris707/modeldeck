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

/// Accounts pane logic: edit (label / purpose / color) and remove-behind-
/// confirm. After a successful mutation it re-reads `GET /api/state` and
/// hands the fresh state to `onStateChanged` so the popover/menu bar update
/// immediately.
@MainActor
public final class AccountsSettingsModel: ObservableObject {
    @Published public private(set) var busyAccountID: String?
    @Published public private(set) var lastError: String?

    /// Fresh daemon state after a successful edit/remove; the app pushes it
    /// into `MenuBarStatusModel.apply(deckState:)`.
    public var onStateChanged: ((DeckState) -> Void)?

    private let editor: any AccountEditing
    private let stateProvider: any DeckStateProviding

    public init(editor: any AccountEditing, stateProvider: any DeckStateProviding) {
        self.editor = editor
        self.stateProvider = stateProvider
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
/// state) and offers the token-gated forced re-check.
@MainActor
public final class ToolsStatusModel: ObservableObject {
    @Published public private(set) var probe: ToolsProbeResponse?
    @Published public private(set) var isChecking = false
    @Published public private(set) var lastError: String?

    private let prober: any ToolsProbing

    public init(prober: any ToolsProbing) {
        self.prober = prober
    }

    /// `refresh: false` reads the daemon's cache (cheap, no token);
    /// `refresh: true` is the Check for Updates button (token-gated,
    /// re-probes binaries and the npm registry).
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
}
