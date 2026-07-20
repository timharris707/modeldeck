import Foundation
import Testing
@testable import ModelDeckMacCore

/// Scriptable account editor + state provider for the Accounts pane model.
final class StubAccountBackend: AccountEditing, DeckStateProviding, ToolsProbing, @unchecked Sendable {
    private let lock = NSLock()
    var saveError: Error?
    var deleteError: Error?
    var stateAfterMutation = DeckState()
    var toolsResponse: ToolsProbeResponse?
    var toolsError: Error?
    private(set) var savedEdits: [AccountEdit] = []
    private(set) var deletedIDs: [String] = []
    private(set) var stateReads = 0
    private(set) var toolsCalls: [Bool] = []

    func saveAccount(_ edit: AccountEdit) async throws -> DeckAccount {
        try locked {
            savedEdits.append(edit)
            if let saveError { throw saveError }
            return DeckAccount(id: edit.id, provider: edit.provider, label: edit.label, profileRef: edit.profileRef)
        }
    }

    func deleteAccount(id: String) async throws {
        try locked {
            deletedIDs.append(id)
            if let deleteError { throw deleteError }
        }
    }

    func deckState() async throws -> DeckState {
        locked {
            stateReads += 1
            return stateAfterMutation
        }
    }

    func tools(refresh: Bool) async throws -> ToolsProbeResponse {
        try locked {
            toolsCalls.append(refresh)
            if let toolsError { throw toolsError }
            return toolsResponse ?? ToolsProbeResponse(
                tools: .init(claude: ToolProbe(installed: true), codex: ToolProbe(installed: false))
            )
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

@Suite("Accounts settings model (issue #7)")
@MainActor
struct AccountsSettingsModelTests {
    private var editable: DeckAccount {
        DeckAccount(
            id: "acct-1", provider: "claude", label: "Deck One",
            purpose: "docs", color: "#d97757", profileRef: "profile-1"
        )
    }

    @Test func saveEditPostsAndPushesFreshState() async {
        let backend = StubAccountBackend()
        backend.stateAfterMutation = DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Renamed", profileRef: "profile-1"),
        ])
        let model = AccountsSettingsModel(editor: backend, stateProvider: backend)
        var pushedStates: [DeckState] = []
        model.onStateChanged = { pushedStates.append($0) }

        let saved = await model.saveEdit(account: editable, label: "  Renamed  ", purpose: "writing", color: "#112233")

        #expect(saved)
        #expect(model.lastError == nil)
        #expect(backend.savedEdits.count == 1)
        #expect(backend.savedEdits.first?.label == "Renamed") // trimmed
        #expect(backend.savedEdits.first?.purpose == "writing")
        #expect(backend.savedEdits.first?.color == "#112233")
        #expect(backend.savedEdits.first?.profileRef == "profile-1")
        #expect(pushedStates.count == 1)
        #expect(pushedStates.first?.accounts.first?.label == "Renamed")
    }

    @Test func emptyLabelIsRejectedLocally() async {
        let backend = StubAccountBackend()
        let model = AccountsSettingsModel(editor: backend, stateProvider: backend)
        let saved = await model.saveEdit(account: editable, label: "   ", purpose: "", color: nil)
        #expect(!saved)
        #expect(backend.savedEdits.isEmpty)
        #expect(model.lastError == "The label can't be empty.")
    }

    @Test func missingProfileRefDisablesEditing() async {
        let backend = StubAccountBackend()
        let model = AccountsSettingsModel(editor: backend, stateProvider: backend)
        let bare = DeckAccount(id: "acct-9", provider: "codex", label: "No Ref")
        #expect(!AccountsSettingsModel.canEdit(bare))
        let saved = await model.saveEdit(account: bare, label: "New", purpose: "", color: nil)
        #expect(!saved)
        #expect(backend.savedEdits.isEmpty)
        #expect(model.lastError?.contains("profile reference") == true)
    }

    @Test func saveErrorSurfacesDaemonMessage() async {
        let backend = StubAccountBackend()
        backend.saveError = DaemonClientError.daemonError(message: "account label is required", status: 400)
        let model = AccountsSettingsModel(editor: backend, stateProvider: backend)
        var pushed = 0
        model.onStateChanged = { _ in pushed += 1 }
        let saved = await model.saveEdit(account: editable, label: "X", purpose: "", color: nil)
        #expect(!saved)
        #expect(model.lastError == "account label is required")
        #expect(pushed == 0)
    }

    @Test func removeDeletesAndPushesFreshState() async {
        let backend = StubAccountBackend()
        backend.stateAfterMutation = DeckState(accounts: [])
        let model = AccountsSettingsModel(editor: backend, stateProvider: backend)
        var pushedStates: [DeckState] = []
        model.onStateChanged = { pushedStates.append($0) }

        let removed = await model.remove(account: editable)

        #expect(removed)
        #expect(backend.deletedIDs == ["acct-1"])
        #expect(pushedStates.count == 1)
        #expect(pushedStates.first?.accounts.isEmpty == true)
    }

    @Test func removeErrorSurfaces() async {
        let backend = StubAccountBackend()
        backend.deleteError = DaemonClientError.daemonError(message: "account not found", status: 404)
        let model = AccountsSettingsModel(editor: backend, stateProvider: backend)
        let removed = await model.remove(account: editable)
        #expect(!removed)
        #expect(model.lastError == "account not found")
    }
}

@Suite("Tools status model (issue #7)")
@MainActor
struct ToolsStatusModelTests {
    @Test func loadReadsCacheThenRefreshForcesProbe() async {
        let backend = StubAccountBackend()
        backend.toolsResponse = ToolsProbeResponse(
            tools: .init(
                claude: ToolProbe(installed: true, version: "2.1.0", latestVersion: "2.1.0", updateAvailable: false, authState: "ok"),
                codex: ToolProbe(installed: true, version: "1.0.0", authState: "signin-required")
            ),
            checkedAt: "2026-07-19T18:00:00Z"
        )
        let model = ToolsStatusModel(prober: backend)

        await model.load(refresh: false)
        await model.load(refresh: true)

        #expect(backend.toolsCalls == [false, true])
        #expect(model.probe?.tools.claude.healthChip == .healthy)
        #expect(model.probe?.probe(for: .codex).healthChip == .signInAgain)
        #expect(model.lastError == nil)
    }

    @Test func probeErrorSurfacesAndKeepsLastGoodProbe() async {
        let backend = StubAccountBackend()
        let model = ToolsStatusModel(prober: backend)
        await model.load(refresh: false)
        #expect(model.probe != nil)

        backend.toolsError = DaemonClientError.daemonError(message: "mutation token or origin rejected", status: 403)
        await model.load(refresh: true)
        #expect(model.lastError == "mutation token or origin rejected")
        #expect(model.probe != nil) // last good probe kept
    }
}
