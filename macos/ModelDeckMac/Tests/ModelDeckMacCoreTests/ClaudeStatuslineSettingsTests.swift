import XCTest
@testable import ModelDeckMacCore

// Issue #174 — the Settings side of statusline capture: the additive
// `claudeStatusline` account field decodes tolerantly, and the roster model's
// opt-in toggle drives the daemon's install/uninstall endpoints. All
// identities below are synthetic fixtures.

final class ClaudeStatuslineSettingsTests: XCTestCase {
    func testAccountDecodesClaudeStatuslineField() throws {
        let json = """
        {
          "id": "acct-1", "provider": "claude", "label": "Work",
          "enabled": true, "isDefault": true,
          "claudeStatusline": { "installed": true }
        }
        """
        let account = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        XCTAssertEqual(account.claudeStatusline, ClaudeStatuslineOptIn(installed: true))
    }

    func testAccountWithoutStatuslineFieldDecodesNil() throws {
        // Old daemons (and Codex accounts) omit the field entirely.
        let json = """
        {
          "id": "acct-2", "provider": "codex", "label": "Codex",
          "enabled": true, "isDefault": false
        }
        """
        let account = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        XCTAssertNil(account.claudeStatusline)
    }

    func testInstallUninstallEnvelopeDecodes() throws {
        let json = #"{ "statusline": { "installed": true, "chained": false } }"#
        struct Envelope: Decodable { var statusline: ClaudeStatuslineOptIn }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8))
        XCTAssertTrue(envelope.statusline.installed)
        XCTAssertEqual(envelope.statusline.chained, false)
    }

    @MainActor
    func testToggleCallsInstallThenRefreshesState() async {
        let statusline = StatuslineStub()
        let state = StateStub()
        let model = AccountsSettingsModel(editor: EditorStub(), stateProvider: state, statusline: statusline)
        var pushed: DeckState?
        model.onStateChanged = { pushed = $0 }
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Work")

        let ok = await model.setStatuslineCapture(account: account, enabled: true)

        XCTAssertTrue(ok)
        XCTAssertEqual(statusline.calls, [.init(accountID: "acct-1", enabled: true)])
        XCTAssertNil(model.lastError)
        XCTAssertNotNil(pushed)
    }

    @MainActor
    func testToggleOffCallsUninstall() async {
        let statusline = StatuslineStub()
        let model = AccountsSettingsModel(editor: EditorStub(), stateProvider: StateStub(), statusline: statusline)
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Work")

        _ = await model.setStatuslineCapture(account: account, enabled: false)

        XCTAssertEqual(statusline.calls, [.init(accountID: "acct-1", enabled: false)])
    }

    @MainActor
    func testToggleFailureSurfacesDaemonMessage() async {
        let statusline = StatuslineStub()
        statusline.error = DaemonClientError.daemonError(
            message: "Claude profile settings.json is not valid JSON; fix it before enabling statusline capture",
            status: 400
        )
        let model = AccountsSettingsModel(editor: EditorStub(), stateProvider: StateStub(), statusline: statusline)
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Work")

        let ok = await model.setStatuslineCapture(account: account, enabled: true)

        XCTAssertFalse(ok)
        XCTAssertEqual(
            model.lastError,
            "Claude profile settings.json is not valid JSON; fix it before enabling statusline capture"
        )
    }

    @MainActor
    func testToggleWithoutSeamFailsHonestly() async {
        // Existing call sites may construct the model without the seam; the
        // toggle must fail with a message, never crash or pretend success.
        let model = AccountsSettingsModel(editor: EditorStub(), stateProvider: StateStub())
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Work")

        let ok = await model.setStatuslineCapture(account: account, enabled: true)

        XCTAssertFalse(ok)
        XCTAssertNotNil(model.lastError)
    }
}

// MARK: - Stubs

private final class StatuslineStub: StatuslineConfiguring, @unchecked Sendable {
    struct Call: Equatable { var accountID: String; var enabled: Bool }
    private(set) var calls: [Call] = []
    var error: Error?

    func setClaudeStatuslineCapture(accountID: String, enabled: Bool) async throws -> ClaudeStatuslineOptIn {
        calls.append(Call(accountID: accountID, enabled: enabled))
        if let error { throw error }
        return ClaudeStatuslineOptIn(installed: enabled, chained: enabled ? false : nil)
    }
}

private struct EditorStub: AccountEditing {
    func saveAccount(_ edit: AccountEdit) async throws -> DeckAccount {
        DeckAccount(id: "acct-1", provider: "claude", label: "Work")
    }

    func deleteAccount(id: String) async throws {}
}

private struct StateStub: DeckStateProviding {
    func deckState() async throws -> DeckState {
        DeckState(accounts: [], usage: [])
    }
}
