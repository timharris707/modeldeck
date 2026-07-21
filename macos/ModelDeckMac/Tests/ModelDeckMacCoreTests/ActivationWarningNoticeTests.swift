import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #93 — surfacing the daemon's additive activate `warnings` array
// (PR #92) as a calm post-activation notice in Settings → Accounts.
// Placeholder names/emails only — never real identities (spec privacy rule).

private func account(
    _ id: String,
    provider: String,
    label: String,
    isDefault: Bool = false
) -> DeckAccount {
    DeckAccount(id: id, provider: provider, label: label, isDefault: isDefault)
}

private func twoClaudeState(activeID: String = "c1") -> DeckState {
    DeckState(
        accounts: [
            account("c1", provider: "claude", label: "Studio", isDefault: activeID == "c1"),
            account("c2", provider: "claude", label: "Client", isDefault: activeID == "c2"),
            account("x1", provider: "codex", label: "Studio", isDefault: true),
        ],
        usage: []
    )
}

private let sampleWarning =
    "2 running Claude sessions may lose session storage if launched without ModelDeck's pinned environment"

// MARK: - Decoding (DaemonClient.activateAccount)

@Suite("Activate warnings decoding")
struct ActivateWarningsDecodingTests {
    private func client(activateBody: String) -> (DaemonClient, StubTransport) {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-1"}"#),
            .init(status: 200, body: activateBody),
        ])
        return (DaemonClient(configuration: DaemonConfiguration(), transport: transport), transport)
    }

    @Test func absentWarningsKeyDecodesToNoWarnings() async throws {
        // A pre-#92 daemon has no `warnings` key at all — must not break.
        let (client, _) = client(activateBody:
            #"{"account":{"id":"c2","provider":"claude","label":"Client","enabled":true,"isDefault":true}}"#)
        let activation = try await client.activateAccount(id: "c2")
        #expect(activation.account.id == "c2")
        #expect(activation.warnings == [])
    }

    @Test func emptyWarningsArrayDecodesToNoWarnings() async throws {
        let (client, _) = client(activateBody:
            #"{"account":{"id":"c2","provider":"claude","label":"Client","enabled":true,"isDefault":true},"warnings":[]}"#)
        let activation = try await client.activateAccount(id: "c2")
        #expect(activation.warnings == [])
    }

    @Test func presentWarningsAreCarriedVerbatim() async throws {
        let body = #"{"account":{"id":"c2","provider":"claude","label":"Client","enabled":true,"isDefault":true},"warnings":["\#(sampleWarning)"]}"#
        let (client, _) = client(activateBody: body)
        let activation = try await client.activateAccount(id: "c2")
        #expect(activation.warnings == [sampleWarning])
    }
}

// MARK: - View-model state (DeckPopoverModel)

/// Activator scripted with full `AccountActivation` outcomes so tests can
/// attach warnings per call.
private final class WarningActivator: AccountActivating, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<AccountActivation, Error>]
    private(set) var calls: [String] = []

    init(results: [Result<AccountActivation, Error>]) {
        self.results = results
    }

    func activateAccount(id: String) async throws -> AccountActivation {
        guard let result = nextResult(recording: id) else {
            throw DaemonClientError.invalidResponse
        }
        return try result.get()
    }

    private func nextResult(recording id: String) -> Result<AccountActivation, Error>? {
        lock.lock()
        defer { lock.unlock() }
        calls.append(id)
        return results.isEmpty ? nil : results.removeFirst()
    }
}

private struct FixedStateProvider: DeckStateProviding {
    var state: DeckState
    func deckState() async throws -> DeckState { state }
}

@Suite("Post-activation warnings state")
@MainActor
struct PostActivationWarningsModelTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "activation-warning-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func model(
        activator: WarningActivator,
        verifiedState: DeckState
    ) -> DeckPopoverModel {
        DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: FixedStateProvider(state: verifiedState)
        )
    }

    private func claudeRow(_ id: String, isActive: Bool = false) -> DeckAccountRow {
        DeckAccountRow(
            account: account(id, provider: "claude", label: "Client", isDefault: isActive),
            provider: .claude,
            windows: [],
            isActive: isActive,
            activationState: .unknown
        )
    }

    private func switched(_ id: String) -> AccountActivation {
        AccountActivation(
            account: account(id, provider: "claude", label: "Client", isDefault: true),
            warnings: [sampleWarning]
        )
    }

    @Test func verifiedActivationRecordsWarningsForTheProvider() async {
        let activator = WarningActivator(results: [.success(switched("c2"))])
        let model = model(activator: activator, verifiedState: twoClaudeState(activeID: "c2"))
        await model.activate(claudeRow("c2"))
        let recorded = model.postActivationWarnings(for: .claude)
        #expect(recorded == PostActivationWarnings(accountID: "c2", warnings: [sampleWarning]))
        // Scoped to the provider that switched — Codex stays silent.
        #expect(model.postActivationWarnings(for: .codex) == nil)
        #expect(model.activationError(for: "c2") == nil)
    }

    @Test func warningFreeActivationLeavesNoNotice() async {
        let activator = WarningActivator(results: [.success(
            AccountActivation(account: account("c2", provider: "claude", label: "Client", isDefault: true))
        )])
        let model = model(activator: activator, verifiedState: twoClaudeState(activeID: "c2"))
        await model.activate(claudeRow("c2"))
        #expect(model.postActivationWarnings(for: .claude) == nil)
    }

    @Test func dismissClearsTheNotice() async {
        let activator = WarningActivator(results: [.success(switched("c2"))])
        let model = model(activator: activator, verifiedState: twoClaudeState(activeID: "c2"))
        await model.activate(claudeRow("c2"))
        #expect(model.postActivationWarnings(for: .claude) != nil)
        model.dismissPostActivationWarnings(for: .claude)
        #expect(model.postActivationWarnings(for: .claude) == nil)
    }

    @Test func nextActivationSupersedesThePreviousNotice() async {
        // Second switch carries no warnings — the stale notice must not linger.
        let activator = WarningActivator(results: [
            .success(switched("c2")),
            .success(AccountActivation(
                account: account("c1", provider: "claude", label: "Studio", isDefault: true))),
        ])
        let model = model(activator: activator, verifiedState: twoClaudeState(activeID: "c2"))
        await model.activate(claudeRow("c2"))
        #expect(model.postActivationWarnings(for: .claude) != nil)
        // Verification of the second switch fails (fresh state still says
        // c2) — but the POST happened, so the stale c2 notice is gone and,
        // with no new warnings, nothing replaces it.
        await model.activate(claudeRow("c1"))
        #expect(model.postActivationWarnings(for: .claude) == nil)
    }

    @Test func failedPostRecordsNoWarnings() async {
        let activator = WarningActivator(results: [
            .failure(DaemonClientError.daemonError(message: "account is disabled", status: 400)),
        ])
        let model = model(activator: activator, verifiedState: twoClaudeState())
        await model.activate(claudeRow("c2"))
        #expect(model.postActivationWarnings(for: .claude) == nil)
        #expect(model.activationError(for: "c2") != nil)
    }

    @Test func verificationFailureStillKeepsTheWarnings() async {
        // The POST succeeded — the daemon has flipped and counted the
        // running sessions. A later verification failure must not swallow
        // that honest heads-up.
        let activator = WarningActivator(results: [.success(switched("c2"))])
        let model = model(activator: activator, verifiedState: twoClaudeState(activeID: "c1"))
        await model.activate(claudeRow("c2"))
        #expect(model.activationError(for: "c2") != nil)
        #expect(model.postActivationWarnings(for: .claude)
            == PostActivationWarnings(accountID: "c2", warnings: [sampleWarning]))
    }
}

// MARK: - Roster notice derivation + VoiceOver label

@Suite("Post-activation notice derivation")
struct PostActivationNoticeTests {
    @Test func warningsProduceANoticeOnTheProviderSection() {
        let sections = AccountsRoster.sections(
            state: twoClaudeState(activeID: "c2"),
            warningsForProvider: { provider in
                provider == .claude
                    ? PostActivationWarnings(accountID: "c2", warnings: [sampleWarning])
                    : nil
            }
        )
        let claude = sections.first { $0.provider == .claude }
        #expect(claude?.notice == PostActivationNotice(
            provider: .claude, warnings: [sampleWarning], affectedAccountID: "c2"))
        let codex = sections.first { $0.provider == .codex }
        #expect(codex?.notice == nil)
    }

    @Test func noWarningsMeansNoNotice() {
        let sections = AccountsRoster.sections(state: twoClaudeState())
        #expect(sections.allSatisfy { $0.notice == nil })
        // An empty list (new daemon, quiet switch) is also silent.
        #expect(AccountsRoster.notice(
            for: .claude,
            warnings: PostActivationWarnings(accountID: "c2", warnings: [])) == nil)
    }

    @Test func noticeIsIndependentOfTheTroubleBanner() {
        // An unlinked provider shows its amber trouble banner AND the
        // informational notice — one does not suppress the other.
        var state = twoClaudeState(activeID: "c2")
        state.activation = DeckActivation(claude: ProviderActivation(state: "unlinked"))
        let sections = AccountsRoster.sections(
            state: state,
            warningsForProvider: { provider in
                provider == .claude
                    ? PostActivationWarnings(accountID: "c2", warnings: [sampleWarning])
                    : nil
            }
        )
        let claude = sections.first { $0.provider == .claude }
        #expect(claude?.banner != nil)
        #expect(claude?.notice != nil)
    }

    @Test func messageJoinsTheDaemonLinesVerbatim() {
        let notice = PostActivationNotice(
            provider: .claude,
            warnings: [sampleWarning, "second line"],
            affectedAccountID: "c2"
        )
        #expect(notice.message == "\(sampleWarning) second line")
    }

    @Test func accessibilityLabelCarriesProviderMessageAndDetail() {
        // The #79 lesson: the container's ONE derived label must speak the
        // state — provider, the daemon's verbatim warning, and the nuance —
        // so VoiceOver never gets a static label that hides the warning.
        let notice = PostActivationNotice(
            provider: .claude, warnings: [sampleWarning], affectedAccountID: "c2")
        #expect(notice.accessibilityLabel.hasPrefix("Claude activation notice: "))
        #expect(notice.accessibilityLabel.contains(sampleWarning))
        #expect(notice.accessibilityLabel.contains(PostActivationNotice.detail))
    }

    @Test func detailStatesTheSwitchAlreadyCompletedAndTheRemedy() {
        #expect(PostActivationNotice.detail.contains("switch already completed"))
        #expect(PostActivationNotice.detail.contains("pinned environment"))
        #expect(PostActivationNotice.detail.contains("new terminal"))
    }
}
