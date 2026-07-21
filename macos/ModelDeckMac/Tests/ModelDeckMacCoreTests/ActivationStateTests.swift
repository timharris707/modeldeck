import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #55 (UI half) — honest activation state. Placeholder labels only.

private func account(
    _ id: String,
    provider: String,
    label: String,
    enabled: Bool = true,
    isDefault: Bool = false
) -> DeckAccount {
    DeckAccount(id: id, provider: provider, label: label, enabled: enabled, isDefault: isDefault)
}

/// Both providers with a default each — the roster shape that matters here.
private func rosterState(activation: DeckActivation?) -> DeckState {
    DeckState(
        accounts: [
            account("c1", provider: "claude", label: "Studio", isDefault: true),
            account("c2", provider: "claude", label: "Client"),
            account("x1", provider: "codex", label: "Studio", isDefault: true),
        ],
        usage: [],
        activation: activation
    )
}

@Suite("Activation state mapping")
struct ActivationStateMappingTests {
    @Test func mapsEveryDaemonStateString() {
        #expect(ProviderActivationState.from("effective") == .effective)
        #expect(ProviderActivationState.from("blocked") == .blocked)
        #expect(ProviderActivationState.from("mismatched") == .mismatched)
        #expect(ProviderActivationState.from("unlinked") == .unlinked)
        // PRs #63/#64: identity verification states.
        #expect(ProviderActivationState.from("identity-mismatch") == .identityMismatch)
        #expect(ProviderActivationState.from("identity-unverified") == .identityUnverified)
    }

    @Test func onlyLinkLevelStatesOfferCompleteActivation() {
        // Issue #61: the button re-runs the daemon activate, which lays the
        // symlink — it can fix link problems, never identity problems.
        #expect(ProviderActivationState.blocked.needsLinkCompletion)
        #expect(ProviderActivationState.mismatched.needsLinkCompletion)
        #expect(ProviderActivationState.unlinked.needsLinkCompletion)
        #expect(!ProviderActivationState.effective.needsLinkCompletion)
        #expect(!ProviderActivationState.identityMismatch.needsLinkCompletion)
        #expect(!ProviderActivationState.identityUnverified.needsLinkCompletion)
        #expect(!ProviderActivationState.unknown.needsLinkCompletion)
    }

    @Test func unrecognizedOrAbsentStateIsUnknown() {
        // A newer daemon's unrecognized value must not invent warnings.
        #expect(ProviderActivationState.from("half-migrated") == .unknown)
        #expect(ProviderActivationState.from("") == .unknown)
        #expect(ProviderActivationState.from(nil) == .unknown)
    }

    @Test func deckStateResolvesPerProviderStates() {
        let state = rosterState(activation: DeckActivation(
            claude: ProviderActivation(state: "effective"),
            codex: ProviderActivation(state: "blocked")
        ))
        #expect(state.activationState(for: .claude) == .effective)
        #expect(state.activationState(for: .codex) == .blocked)
    }

    @Test func absentActivationFieldIsUnknownForBothProviders() {
        // Pre-#56 daemon: no field, no warnings — current behavior.
        let state = rosterState(activation: nil)
        #expect(state.activationState(for: .claude) == .unknown)
        #expect(state.activationState(for: .codex) == .unknown)
    }

    @Test func missingProviderEntryIsUnknown() {
        let state = rosterState(activation: DeckActivation(
            claude: ProviderActivation(state: "effective")
        ))
        #expect(state.activationState(for: .codex) == .unknown)
    }
}

@Suite("Active indicator")
struct ActiveIndicatorTests {
    @Test func effectiveRendersTheFullCheckmark() {
        #expect(ActiveIndicator.indicator(for: .effective) == .checkmark)
    }

    @Test func absentFieldFallsBackToTheCheckmark() {
        // Honest fallback: an older daemon reports nothing, the UI keeps
        // today's behavior — never a false warning.
        #expect(ActiveIndicator.indicator(for: .unknown) == .checkmark)
    }

    /// Issue #61: every pending caption must state the distinction — the
    /// account is SELECTED as active, but activation isn't in effect.
    private func caption(for state: ProviderActivationState) -> String? {
        guard case .pending(let caption) = ActiveIndicator.indicator(for: state) else { return nil }
        return caption
    }

    @Test func blockedRendersPendingWithMigrationCaption() {
        let caption = caption(for: .blocked)
        #expect(caption?.contains("Selected as active, but not in effect yet") == true)
        #expect(caption?.contains("one-time migration") == true)
    }

    @Test func mismatchedRendersPendingWithLinkCaption() {
        #expect(caption(for: .mismatched)
            == "Selected as active, but the active link points at a different account")
    }

    @Test func unlinkedRendersPendingWithNoLinkCaption() {
        let caption = caption(for: .unlinked)
        #expect(caption?.contains("Selected as active, but not in effect yet") == true)
        #expect(caption?.contains("no active link") == true)
    }

    @Test func identityMismatchRendersPendingWithLoginCaption() {
        let caption = caption(for: .identityMismatch)
        #expect(caption?.contains("signed in as a different identity") == true)
        #expect(caption?.contains("/login") == true)
    }

    @Test func identityUnverifiedRendersPendingWithVerifyCaption() {
        let caption = caption(for: .identityUnverified)
        #expect(caption?.contains("identity isn't verified yet") == true)
        #expect(caption?.contains("/login") == true)
    }
}

@Suite("Deck rows carry activation state")
struct DeckRowActivationTests {
    @Test func rowsCarryTheirProvidersActivationState() {
        let state = rosterState(activation: DeckActivation(
            claude: ProviderActivation(state: "effective"),
            codex: ProviderActivation(state: "blocked")
        ))
        let rows = DeckBuilder.rows(state: state)
        #expect(rows.first { $0.id == "c1" }?.activationState == .effective)
        #expect(rows.first { $0.id == "c2" }?.activationState == .effective)
        #expect(rows.first { $0.id == "x1" }?.activationState == .blocked)
        #expect(rows.first { $0.id == "c1" }?.activeIndicator == .checkmark)
        #expect(rows.first { $0.id == "x1" }?.activeIndicator
            == ActiveIndicator.indicator(for: .blocked))
    }

    @Test func rowsWithoutActivationFieldRenderTheCheckmark() {
        let rows = DeckBuilder.rows(state: rosterState(activation: nil))
        #expect(rows.first { $0.id == "c1" }?.activationState == .unknown)
        #expect(rows.first { $0.id == "c1" }?.activeIndicator == .checkmark)
    }
}

@Suite("Activation notices")
struct ActivationNoticeTests {
    @Test func onlyNonEffectiveProvidersGetANotice() {
        let state = rosterState(activation: DeckActivation(
            claude: ProviderActivation(state: "effective"),
            codex: ProviderActivation(state: "blocked")
        ))
        let notices = ActivationNotice.notices(for: state)
        #expect(notices.map(\.provider) == [.codex])
        // The notice says what works and what doesn't, calmly.
        #expect(notices[0].message.contains("usage tracking is accurate"))
        #expect(notices[0].message.contains("switching accounts"))
        #expect(notices[0].message.contains("one-time migration"))
    }

    @Test func bothProvidersBlockedYieldsClaudeFirstThenCodex() {
        // The live machine's real shape today: both providers blocked.
        let state = rosterState(activation: DeckActivation(
            claude: ProviderActivation(state: "blocked"),
            codex: ProviderActivation(state: "blocked")
        ))
        #expect(ActivationNotice.notices(for: state).map(\.provider) == [.claude, .codex])
    }

    @Test func absentActivationFieldYieldsNoNotices() {
        #expect(ActivationNotice.notices(for: rosterState(activation: nil)).isEmpty)
    }

    @Test func providerWithoutEnabledAccountsYieldsNoNotice() {
        var state = rosterState(activation: DeckActivation(
            claude: ProviderActivation(state: "effective"),
            codex: ProviderActivation(state: "blocked")
        ))
        state.accounts.removeAll { $0.provider == "codex" }
        #expect(ActivationNotice.notices(for: state).isEmpty)
    }

    @Test func mismatchedAndUnlinkedGetHonestMessages() {
        #expect(ActivationNotice.message(for: .mismatched, provider: .claude)?
            .contains("points at a different account") == true)
        // Issue #61: unlinked is the post-migration "ready" state — the
        // banner flips from "migration needed" to pointing at the button.
        #expect(ActivationNotice.message(for: .unlinked, provider: .codex)?
            .contains("Complete Activation") == true)
        #expect(ActivationNotice.message(for: .effective, provider: .claude) == nil)
        #expect(ActivationNotice.message(for: .unknown, provider: .claude) == nil)
    }

    @Test func identityStatesNoticeSplit() {
        // identity-mismatch is actionable (log out, /login) → banner;
        // identity-unverified is a soft state → marker tooltip only, no
        // standing banner noise.
        #expect(ActivationNotice.message(for: .identityMismatch, provider: .claude)?
            .contains("/login") == true)
        #expect(ActivationNotice.message(for: .identityUnverified, provider: .claude) == nil)
    }
}

@Suite("Activation payload decoding")
struct ActivationDecodingTests {
    @Test func decodesTheDaemonsActivationShape() async throws {
        // Mirrors src/service.mjs state(): per-provider state +
        // resolvedProfileRef when a symlink exists.
        let json = #"""
        {
          "accounts": [
            {"id":"c1","provider":"claude","label":"Studio","enabled":true,"isDefault":true}
          ],
          "usage": [],
          "activation": {
            "claude": {"state":"blocked"},
            "codex": {"state":"mismatched","resolvedProfileRef":"/placeholder/profiles/codex-two"}
          },
          "scheduler": {"pausedForActiveSessions":false}
        }
        """#
        let transport = StubTransport(stubs: [.init(status: 200, body: json)])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let state = try await client.state()
        #expect(state.activationState(for: .claude) == .blocked)
        #expect(state.activationState(for: .codex) == .mismatched)
        #expect(state.activation?.codex?.resolvedProfileRef == "/placeholder/profiles/codex-two")
    }

    @Test func stateWithoutActivationFieldStillDecodes() async throws {
        // Pre-#56 daemon payload.
        let json = #"{"accounts":[],"usage":[]}"#
        let transport = StubTransport(stubs: [.init(status: 200, body: json)])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let state = try await client.state()
        #expect(state.activation == nil)
        #expect(state.activationState(for: .claude) == .unknown)
    }

    @Test func malformedActivationFieldReadsAsAbsent() throws {
        // An unexpected shape must not fail the whole state decode.
        let json = #"{"accounts":[],"usage":[],"activation":"nope"}"#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        #expect(state.activation == nil)
        #expect(state.activationState(for: .codex) == .unknown)
    }
}

@Suite("Blocked-activation error decoding")
struct BlockedActivationErrorTests {
    @Test func codedErrorBodyThrowsTheCodedCase() async {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-1"}"#),
            .init(status: 409, body: #"{"error":"codex activation requires a one-time migration: move the existing directory aside at a quiet moment before activating: /placeholder/home/.codex","code":"active-link-blocked"}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        await #expect(throws: DaemonClientError.daemonCodedError(
            message: "codex activation requires a one-time migration: move the existing directory aside at a quiet moment before activating: /placeholder/home/.codex",
            code: "active-link-blocked",
            status: 409
        )) {
            _ = try await client.activateAccount(id: "x2")
        }
    }

    @Test func errorBodyWithoutCodeKeepsTheClassicCase() async {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-1"}"#),
            .init(status: 400, body: #"{"error":"account is disabled"}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        await #expect(throws: DaemonClientError.daemonError(message: "account is disabled", status: 400)) {
            _ = try await client.activateAccount(id: "x2")
        }
    }

    @Test func blockedGuidanceExtractsOnlyTheGuardCode() {
        let guard409 = DaemonClientError.daemonCodedError(
            message: "guidance text", code: "active-link-blocked", status: 409)
        #expect(DeckPopoverModel.blockedGuidance(for: guard409) == "guidance text")
        let otherCode = DaemonClientError.daemonCodedError(
            message: "other", code: "something-else", status: 400)
        #expect(DeckPopoverModel.blockedGuidance(for: otherCode) == nil)
        #expect(DeckPopoverModel.blockedGuidance(
            for: DaemonClientError.daemonError(message: "plain", status: 400)) == nil)
    }
}

// MARK: - Blocked activate flow (state machine)

private final class QueueActivator: AccountActivating, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<DeckAccount, Error>]
    private(set) var calls: [String] = []

    init(results: [Result<DeckAccount, Error>]) {
        self.results = results
    }

    func activateAccount(id: String) async throws -> DeckAccount {
        guard let result = nextResult(recording: id) else {
            throw DaemonClientError.invalidResponse
        }
        return try result.get()
    }

    private func nextResult(recording id: String) -> Result<DeckAccount, Error>? {
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

@Suite("Blocked activate flow")
@MainActor
struct BlockedActivateFlowTests {
    private static let guidance = "codex activation requires a one-time migration: "
        + "move the existing directory aside at a quiet moment before activating: "
        + "/placeholder/home/.codex"

    private func freshDefaults() -> UserDefaults {
        let suite = "activation-flow-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func blockedError() -> DaemonClientError {
        .daemonCodedError(message: Self.guidance, code: "active-link-blocked", status: 409)
    }

    private func nonActiveCodexRow(_ model: DeckPopoverModel) -> DeckAccountRow {
        let state = rosterState(activation: DeckActivation(codex: ProviderActivation(state: "blocked")))
        var extended = state
        extended.accounts.append(account("x2", provider: "codex", label: "Client"))
        return model.columns(for: extended)[1].rows.first { $0.id == "x2" }!
    }

    @Test func clobberGuardRefusalSurfacesGuidanceVerbatimAndRevertsTheFlip() async {
        let activator = QueueActivator(results: [.failure(blockedError())])
        var state = rosterState(activation: DeckActivation(codex: ProviderActivation(state: "blocked")))
        state.accounts.append(account("x2", provider: "codex", label: "Client"))
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: FixedStateProvider(state: state)
        )

        await model.activate(nonActiveCodexRow(model))

        // Verbatim daemon guidance, in the guidance channel — not the
        // generic error channel.
        #expect(model.blockedActivationGuidance(for: "x2") == Self.guidance)
        #expect(model.activationError(for: "x2") == nil)
        // The optimistic flip reverted: the DB default keeps the marker.
        let columns = model.columns(for: state)
        #expect(columns[1].rows.first { $0.id == "x1" }?.isActive == true)
        #expect(columns[1].rows.first { $0.id == "x2" }?.isActive == false)
        #expect(model.activatingAccountID == nil)
    }

    @Test func genericFailureUsesTheErrorChannelNotGuidance() async {
        let activator = QueueActivator(results: [
            .failure(DaemonClientError.daemonError(message: "account is disabled", status: 400)),
        ])
        var state = rosterState(activation: nil)
        state.accounts.append(account("x2", provider: "codex", label: "Client"))
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: FixedStateProvider(state: state)
        )

        await model.activate(nonActiveCodexRow(model))

        #expect(model.blockedActivationGuidance(for: "x2") == nil)
        #expect(model.activationError(for: "x2")?.contains("account is disabled") == true)
    }

    @Test func retryClearsStaleGuidance() async {
        var switched = rosterState(activation: DeckActivation(codex: ProviderActivation(state: "effective")))
        switched.accounts.append(account("x2", provider: "codex", label: "Client"))
        switched.accounts = switched.accounts.map { account in
            var account = account
            if account.provider == "codex" { account.isDefault = account.id == "x2" }
            return account
        }
        let activator = QueueActivator(results: [
            .failure(blockedError()),
            .success(account("x2", provider: "codex", label: "Client", isDefault: true)),
        ])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: FixedStateProvider(state: switched)
        )

        let row = nonActiveCodexRow(model)
        await model.activate(row)
        #expect(model.blockedActivationGuidance(for: "x2") != nil)

        await model.activate(row)
        #expect(model.blockedActivationGuidance(for: "x2") == nil)
        #expect(model.activationError(for: "x2") == nil)
        #expect(activator.calls == ["x2", "x2"])
    }
}

// MARK: - Complete activation on the active row (issue #61)

@Suite("Complete activation for the active row")
@MainActor
struct CompleteActivationTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "complete-activation-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    /// The DB-active codex row under the given activation state string.
    private func activeCodexRow(_ model: DeckPopoverModel, state raw: String?) -> DeckAccountRow {
        let activation = raw.map { DeckActivation(codex: ProviderActivation(state: $0)) }
        let state = rosterState(activation: activation)
        return model.columns(for: state)[1].rows.first { $0.id == "x1" }!
    }

    @Test func activeRowWithPendingLinkCanRerunActivation() async {
        // The ceremony gap: blocker cleared (state now "unlinked"), the
        // active account just needs the symlink laid — the re-run must go
        // through instead of being swallowed by the isActive guard.
        let activator = QueueActivator(results: [
            .success(account("x1", provider: "codex", label: "Studio", isDefault: true)),
        ])
        let verified = rosterState(activation: DeckActivation(
            codex: ProviderActivation(state: "effective")))
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: FixedStateProvider(state: verified)
        )

        await model.activate(activeCodexRow(model, state: "unlinked"))

        #expect(activator.calls == ["x1"])
        #expect(model.activationError(for: "x1") == nil)
        #expect(model.blockedActivationGuidance(for: "x1") == nil)
    }

    @Test func activeRowStillBlockedSurfacesGuidanceVerbatim() async {
        let guidance = "codex activation requires a one-time migration: "
            + "move the existing directory aside at a quiet moment before "
            + "activating: /placeholder/home/.codex"
        let activator = QueueActivator(results: [
            .failure(DaemonClientError.daemonCodedError(
                message: guidance, code: "active-link-blocked", status: 409)),
        ])
        let state = rosterState(activation: DeckActivation(
            codex: ProviderActivation(state: "blocked")))
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: FixedStateProvider(state: state)
        )

        await model.activate(activeCodexRow(model, state: "blocked"))

        #expect(activator.calls == ["x1"])
        #expect(model.blockedActivationGuidance(for: "x1") == guidance)
        // The active marker never moved: x1 stays the DB default.
        #expect(model.columns(for: state)[1].rows.first { $0.id == "x1" }?.isActive == true)
    }

    @Test func effectiveActiveRowStaysANoOp() async {
        // Nothing to complete: an active row whose activation is effective
        // (or unreported, or identity-level) must never re-POST.
        let activator = QueueActivator(results: [])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: FixedStateProvider(state: rosterState(activation: nil))
        )

        await model.activate(activeCodexRow(model, state: "effective"))
        await model.activate(activeCodexRow(model, state: nil))
        await model.activate(activeCodexRow(model, state: "identity-unverified"))
        await model.activate(activeCodexRow(model, state: "identity-mismatch"))

        #expect(activator.calls.isEmpty)
    }
}
