import XCTest
@testable import ModelDeckMacCore

// Issue #194 — the VISIBLE statusline-capture control on Claude account
// rows. `StatuslineCaptureControl.display` is the single selection point the
// Settings row renders from: which rows earn a control, which state it
// shows, and the daemon-version-skew guarantee that a nil `claudeStatusline`
// renders nothing at all. All identities below are synthetic fixtures.

final class StatuslineCaptureControlTests: XCTestCase {
    // MARK: - Control visibility selection

    func testClaudeAccountWithCaptureOffShowsEnableAction() {
        let account = DeckAccount(
            id: "acct-1", provider: "claude", label: "Work",
            claudeStatusline: ClaudeStatuslineOptIn(installed: false)
        )
        XCTAssertEqual(StatuslineCaptureControl.display(for: account), .enable)
    }

    func testClaudeAccountWithCaptureOnShowsQuietConfirmation() {
        let account = DeckAccount(
            id: "acct-1", provider: "claude", label: "Work",
            claudeStatusline: ClaudeStatuslineOptIn(installed: true)
        )
        XCTAssertEqual(StatuslineCaptureControl.display(for: account), .installed)
    }

    func testClaudeAccountWithoutCapabilityShowsNoControl() {
        // Daemon-version skew: an old daemon omits `claudeStatusline`
        // entirely — the row must render NO new control (the #174 nil-guard
        // precedent).
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Work")
        XCTAssertNil(StatuslineCaptureControl.display(for: account))
    }

    func testCodexAccountShowsNoControlEvenIfFieldPresent() {
        // Belt and braces: the capability is Claude-only; a stray field on
        // a Codex account must not grow a Claude-specific control.
        let account = DeckAccount(
            id: "acct-2", provider: "codex", label: "Codex",
            claudeStatusline: ClaudeStatuslineOptIn(installed: false)
        )
        XCTAssertNil(StatuslineCaptureControl.display(for: account))
    }

    // MARK: - In-flight state

    func testBusyRowShowsSpinnerRegardlessOfInstalledState() {
        for installed in [true, false] {
            let account = DeckAccount(
                id: "acct-1", provider: "claude", label: "Work",
                claudeStatusline: ClaudeStatuslineOptIn(installed: installed)
            )
            XCTAssertEqual(StatuslineCaptureControl.display(for: account, isBusy: true), .busy)
        }
    }

    func testBusyNeverConjuresControlWithoutCapability() {
        // Even a (theoretical) in-flight flag can't make a skewed row grow
        // a control whose endpoint the daemon doesn't serve.
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Work")
        XCTAssertNil(StatuslineCaptureControl.display(for: account, isBusy: true))
    }

    @MainActor
    func testModelMarksStatuslineBusyOnlyWhileRequestIsInFlight() async {
        let statusline = StatuslineStub()
        let model = AccountsSettingsModel(
            editor: EditorStub(), stateProvider: StateStub(), statusline: statusline
        )
        let account = DeckAccount(
            id: "acct-1", provider: "claude", label: "Work",
            claudeStatusline: ClaudeStatuslineOptIn(installed: false)
        )
        let observed = Box()
        statusline.onCall = {
            await MainActor.run { observed.value = model.statuslineBusyAccountID }
        }
        XCTAssertNil(model.statuslineBusyAccountID)

        let ok = await model.setStatuslineCapture(account: account, enabled: true)

        XCTAssertTrue(ok)
        // Mid-flight the row was marked busy; after the call it is clear.
        XCTAssertEqual(observed.value, "acct-1")
        XCTAssertNil(model.statuslineBusyAccountID)
    }

    @MainActor
    func testStatuslineBusyClearsAfterFailureToo() async {
        let statusline = StatuslineStub()
        statusline.error = DaemonClientError.daemonError(message: "boom", status: 500)
        let model = AccountsSettingsModel(
            editor: EditorStub(), stateProvider: StateStub(), statusline: statusline
        )
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Work")

        let ok = await model.setStatuslineCapture(account: account, enabled: true)

        XCTAssertFalse(ok)
        XCTAssertNil(model.statuslineBusyAccountID)
        // The failure lands in the pane's existing error channel.
        XCTAssertEqual(model.lastError, "boom")
    }

    @MainActor
    func testConcurrentClickOnAnotherRowNeverStealsTheBusyMarker() async {
        // CodeRabbit PR #304: while account A's capture mutation is in
        // flight, clicking account B's control must be rejected BEFORE the
        // busy marker is touched. The regression: B's click set the marker
        // to B, `perform` rejected it, and B's defer then cleared the marker
        // while A still ran — A lost its control spinner mid-flight.
        let statusline = StatuslineStub()
        let model = AccountsSettingsModel(
            editor: EditorStub(), stateProvider: StateStub(), statusline: statusline
        )
        let accountA = DeckAccount(
            id: "acct-a", provider: "claude", label: "Work",
            claudeStatusline: ClaudeStatuslineOptIn(installed: false)
        )
        let accountB = DeckAccount(
            id: "acct-b", provider: "claude", label: "Deep",
            claudeStatusline: ClaudeStatuslineOptIn(installed: false)
        )
        let bResult = ResultBox()
        let markerDuringA = Box()
        statusline.onCall = {
            // Mid-flight for A: fire B's click concurrently, then observe
            // the marker AFTER B's attempt fully settled.
            let ok = await model.setStatuslineCapture(account: accountB, enabled: true)
            bResult.value = ok
            await MainActor.run { markerDuringA.value = model.statuslineBusyAccountID }
        }

        let ok = await model.setStatuslineCapture(account: accountA, enabled: true)

        XCTAssertTrue(ok)
        XCTAssertEqual(bResult.value, false)
        // A keeps its marker through B's rejected click…
        XCTAssertEqual(markerDuringA.value, "acct-a")
        // …the daemon only ever saw A's request…
        XCTAssertEqual(statusline.calls, [.init(accountID: "acct-a", enabled: true)])
        // …and the marker clears once A completes.
        XCTAssertNil(model.statuslineBusyAccountID)
    }

    // MARK: - Action wiring (visible control drives the same endpoints)

    @MainActor
    func testEnableFromControlCallsInstallAndRefreshesState() async {
        let statusline = StatuslineStub()
        let model = AccountsSettingsModel(
            editor: EditorStub(), stateProvider: StateStub(), statusline: statusline
        )
        var pushed: DeckState?
        model.onStateChanged = { pushed = $0 }
        let account = DeckAccount(
            id: "acct-1", provider: "claude", label: "Work",
            claudeStatusline: ClaudeStatuslineOptIn(installed: false)
        )

        // The off-state control fires enabled=true (install)…
        _ = await model.setStatuslineCapture(account: account, enabled: true)
        // …and the on-state pill fires enabled=false (uninstall).
        _ = await model.setStatuslineCapture(account: account, enabled: false)

        XCTAssertEqual(statusline.calls, [
            .init(accountID: "acct-1", enabled: true),
            .init(accountID: "acct-1", enabled: false)
        ])
        XCTAssertNotNil(pushed)
    }

    // MARK: - Pinned copy stays single-sourced

    func testPinnedHelpStringsExistAndDiffer() {
        // The #174 tooltips are the single source both the ⋯ toggle and the
        // visible control render; they must stay distinct per state.
        XCTAssertFalse(StatuslineCaptureControl.enableHelp.isEmpty)
        XCTAssertFalse(StatuslineCaptureControl.installedHelp.isEmpty)
        XCTAssertNotEqual(StatuslineCaptureControl.enableHelp, StatuslineCaptureControl.installedHelp)
        XCTAssertEqual(
            StatuslineCaptureControl.menuToggleLabel,
            "Capture usage from Claude Code statusline"
        )
    }
}

// MARK: - Stubs

private final class Box: @unchecked Sendable {
    var value: String?
}

private final class ResultBox: @unchecked Sendable {
    var value: Bool?
}

private final class StatuslineStub: StatuslineConfiguring, @unchecked Sendable {
    struct Call: Equatable { var accountID: String; var enabled: Bool }
    private(set) var calls: [Call] = []
    var error: Error?
    var onCall: (@Sendable () async -> Void)?

    func setClaudeStatuslineCapture(accountID: String, enabled: Bool) async throws -> ClaudeStatuslineOptIn {
        calls.append(Call(accountID: accountID, enabled: enabled))
        await onCall?()
        if let error { throw error }
        return ClaudeStatuslineOptIn(installed: enabled)
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
