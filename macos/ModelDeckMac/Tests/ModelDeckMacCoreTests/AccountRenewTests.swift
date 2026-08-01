import XCTest
@testable import ModelDeckMacCore

// Issue #176 — the UI half of idle-account renewal: the additive `renew`
// account object decodes tolerantly (nil on old daemons/Codex accounts =
// nothing renders), the row-state selection is strictly limited to the
// expired-idle Claude state, the renew model relays the daemon's decided
// outcomes calmly, and the autoRenewEnabled setting round-trips (with the
// old-daemon unknown-key strip). All identities are synthetic fixtures.

final class AccountRenewTests: XCTestCase {
    // MARK: - Decoding

    func testAccountDecodesRenewObject() throws {
        let json = """
        {
          "id": "acct-1", "provider": "claude", "label": "Work",
          "enabled": true, "isDefault": false,
          "authState": "signin-required", "signinReason": "expired",
          "renew": {
            "available": true,
            "authOverride": false,
            "lastAttempt": { "at": "2026-07-31T10:00:00Z", "outcome": "renewed", "mechanism": "invoke" }
          }
        }
        """
        let account = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        XCTAssertEqual(account.renew?.available, true)
        XCTAssertEqual(account.renew?.authOverride, false)
        XCTAssertEqual(account.renew?.lastAttempt?.outcome, "renewed")
        XCTAssertEqual(account.renew?.lastAttempt?.mechanism, "invoke")
        XCTAssertEqual(account.renew?.lastAttempt?.at, "2026-07-31T10:00:00Z")
    }

    func testAccountWithoutRenewObjectDecodesNil() throws {
        // The whole `renew` object is optional for daemon-version skew (the
        // #174 claudeStatusline precedent): absent = capability unreported,
        // render nothing new.
        let json = """
        {
          "id": "acct-2", "provider": "claude", "label": "Idle",
          "enabled": true, "isDefault": false,
          "authState": "signin-required", "signinReason": "expired"
        }
        """
        let account = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        XCTAssertNil(account.renew)
        XCTAssertNil(AccountRenew.action(for: account))
    }

    func testUnexpectedRenewShapeDecodesInert() throws {
        // A malformed shape must never fail the whole account decode — it
        // reads as the inert empty capability (no affordance).
        let json = """
        {
          "id": "acct-3", "provider": "claude", "label": "Odd",
          "enabled": true, "isDefault": false,
          "authState": "signin-required", "signinReason": "expired",
          "renew": "unexpected"
        }
        """
        let account = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        XCTAssertEqual(account.renew, AccountRenewCapability())
        XCTAssertNil(AccountRenew.action(for: account))
    }

    func testRenewPostEnvelopeDecodes() throws {
        let json = """
        {
          "renew": {
            "outcome": "renewed",
            "mechanism": "auth-status",
            "at": "2026-07-31T12:34:56Z",
            "detail": "Sign-in renewed without starting a usage window."
          }
        }
        """
        struct Envelope: Decodable { var renew: AccountRenewal }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.renew.outcome, "renewed")
        XCTAssertEqual(envelope.renew.mechanism, "auth-status")
        XCTAssertEqual(envelope.renew.detail, "Sign-in renewed without starting a usage window.")
    }

    func testRenewOutcomeWithNullMechanismDecodes() throws {
        let json = """
        { "renew": { "outcome": "busy", "mechanism": null, "at": "2026-07-31T12:34:56Z", "detail": "A Claude session is running." } }
        """
        struct Envelope: Decodable { var renew: AccountRenewal }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.renew.outcome, "busy")
        XCTAssertNil(envelope.renew.mechanism)
    }

    // MARK: - Row-state selection

    private func claudeAccount(
        authState: String? = "signin-required",
        signinReason: String? = "expired",
        provider: String = "claude",
        renew: AccountRenewCapability? = nil
    ) -> DeckAccount {
        DeckAccount(
            id: "acct-1",
            provider: provider,
            label: "Work",
            authState: authState,
            signinReason: signinReason,
            renew: renew
        )
    }

    func testExpiredIdleWithAvailableRenewGetsRenewNow() {
        let account = claudeAccount(renew: AccountRenewCapability(available: true))
        XCTAssertEqual(AccountRenew.action(for: account), .renewNow)
    }

    func testAuthOverrideWinsOverAvailable() {
        // The daemon says this profile routes authentication elsewhere —
        // the honest explanation replaces the button, never an error tone.
        let account = claudeAccount(renew: AccountRenewCapability(available: true, authOverride: true))
        XCTAssertEqual(AccountRenew.action(for: account), .authOverridden)
    }

    func testUnavailableRenewRendersNothing() {
        let account = claudeAccount(renew: AccountRenewCapability(available: false))
        XCTAssertNil(AccountRenew.action(for: account))
    }

    func testHealthyAccountNeverGetsRenew() {
        let account = claudeAccount(
            authState: "ok",
            signinReason: nil,
            renew: AccountRenewCapability(available: true)
        )
        XCTAssertNil(AccountRenew.action(for: account))
    }

    func testGenuinelySignedOutAccountNeverGetsRenew() {
        // signinReason "missing" (or absent) is the real sign-out — renewal
        // can't fix it, so the alarm chip stays untouched.
        let account = claudeAccount(
            signinReason: "missing",
            renew: AccountRenewCapability(available: true)
        )
        XCTAssertNil(AccountRenew.action(for: account))
    }

    func testNonClaudeProviderNeverGetsRenew() {
        let account = claudeAccount(
            provider: "codex",
            renew: AccountRenewCapability(available: true)
        )
        XCTAssertNil(AccountRenew.action(for: account))
    }

    // MARK: - Outcome copy

    func testOutcomeTextPrefersDaemonDetailVerbatim() {
        let renewal = AccountRenewal(outcome: "failed", detail: "The invocation timed out after 60 seconds.")
        XCTAssertEqual(AccountRenew.outcomeText(for: renewal), "The invocation timed out after 60 seconds.")
    }

    func testOutcomeTextFallbacksCoverEveryContractOutcome() {
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(outcome: "renewed")),
            "Sign-in renewed."
        )
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(outcome: "busy")),
            "Claude is in use right now — renewal will retry later."
        )
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(outcome: "signin-required")),
            "This account needs a fresh sign-in — renewal can't fix that."
        )
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(outcome: "auth-overridden")),
            AccountRenew.authOverrideExplanation
        )
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(outcome: "failed")),
            "Renewal didn't complete."
        )
        // An outcome this client doesn't know yet still reads honestly.
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(outcome: "surprise")),
            "Renewal finished: surprise."
        )
    }

    func testRateLimitedOutcomeHasPinnedCalmFallback() {
        // Daemon addendum (PR #196 review): manual renewals past the daily
        // cap answer "rate-limited". The daemon's detail sentence still wins
        // verbatim; without one, the pinned calm fallback renders.
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(outcome: "rate-limited")),
            "Today's renewal limit is reached — it can run again tomorrow."
        )
        XCTAssertEqual(
            AccountRenew.outcomeText(for: AccountRenewal(
                outcome: "rate-limited", detail: "Renewal already ran twice today."
            )),
            "Renewal already ran twice today."
        )
    }

    // MARK: - Explanation composition

    func testSignInExplanationAppendsDisclosureForRenewNow() {
        let account = claudeAccount(renew: AccountRenewCapability(available: true))
        let recovery = DeckFreshness.signInRecovery(for: account)!
        let explanation = DeckWarningExplanation.signIn(
            recovery,
            renew: AccountRenewPresentation(action: .renewNow)
        )
        XCTAssertTrue(explanation.body.contains(AccountRenew.disclosure))
        XCTAssertFalse(explanation.body.contains(AccountRenew.authOverrideExplanation))
    }

    func testSignInExplanationCarriesAuthOverrideSentence() {
        let account = claudeAccount(renew: AccountRenewCapability(authOverride: true))
        let recovery = DeckFreshness.signInRecovery(for: account)!
        let explanation = DeckWarningExplanation.signIn(
            recovery,
            renew: AccountRenewPresentation(action: .authOverridden)
        )
        XCTAssertTrue(explanation.body.contains(AccountRenew.authOverrideExplanation))
    }

    func testSignInExplanationAppendsLastAttemptOutcome() {
        let account = claudeAccount(renew: AccountRenewCapability(available: true))
        let recovery = DeckFreshness.signInRecovery(for: account)!
        let explanation = DeckWarningExplanation.signIn(
            recovery,
            renew: AccountRenewPresentation(action: .renewNow, outcomeText: "Renewal didn't complete.")
        )
        XCTAssertTrue(explanation.body.contains("Last renewal attempt: Renewal didn't complete."))
    }

    func testSignInExplanationWithoutRenewIsUnchanged() {
        // Pre-#176 rendering must be byte-identical when no renew state exists.
        let account = claudeAccount()
        let recovery = DeckFreshness.signInRecovery(for: account)!
        let explanation = DeckWarningExplanation.signIn(recovery)
        XCTAssertEqual(explanation.body, recovery.tooltip)
    }

    // MARK: - Renew model

    @MainActor
    func testRenewSuccessStoresOutcomeAndRefreshesState() async {
        let renewer = RenewStub(result: .success(AccountRenewal(
            outcome: "renewed", mechanism: "invoke", at: "2026-07-31T12:00:00Z", detail: "Sign-in renewed."
        )))
        let model = AccountRenewModel(renewer: renewer, stateProvider: RenewStateStub())
        var pushed: DeckState?
        model.onStateChanged = { pushed = $0 }
        let account = claudeAccount(renew: AccountRenewCapability(available: true))

        await model.renew(account: account)

        XCTAssertEqual(renewer.renewedIDs, ["acct-1"])
        XCTAssertEqual(model.phase(for: "acct-1"), .finished(AccountRenewal(
            outcome: "renewed", mechanism: "invoke", at: "2026-07-31T12:00:00Z", detail: "Sign-in renewed."
        )))
        XCTAssertNil(model.error(for: "acct-1"))
        XCTAssertNotNil(pushed)
    }

    @MainActor
    func testRenewFailureSurfacesDaemonMessageAndStillRefreshesState() async {
        // The daemon's 409 (a renewal already in flight) arrives as the
        // standard daemon error — shown verbatim, no pretending.
        let renewer = RenewStub(result: .failure(DaemonClientError.daemonError(
            message: "A renewal for this account is already running", status: 409
        )))
        let model = AccountRenewModel(renewer: renewer, stateProvider: RenewStateStub())
        var pushed: DeckState?
        model.onStateChanged = { pushed = $0 }
        let account = claudeAccount(renew: AccountRenewCapability(available: true))

        await model.renew(account: account)

        XCTAssertNil(model.phase(for: "acct-1"))
        XCTAssertEqual(model.error(for: "acct-1"), "A renewal for this account is already running")
        XCTAssertNotNil(pushed)
    }

    @MainActor
    func testDismissOutcomeClearsFinishedPhaseAndError() async {
        let renewer = RenewStub(result: .success(AccountRenewal(outcome: "busy")))
        let model = AccountRenewModel(renewer: renewer, stateProvider: RenewStateStub())
        let account = claudeAccount(renew: AccountRenewCapability(available: true))
        await model.renew(account: account)
        XCTAssertNotNil(model.phase(for: "acct-1"))

        model.dismissOutcome(accountID: "acct-1")

        XCTAssertNil(model.phase(for: "acct-1"))
        XCTAssertNil(model.error(for: "acct-1"))
    }

    @MainActor
    func testPresentationCarriesActionOutcomeAndError() async {
        let renewer = RenewStub(result: .success(AccountRenewal(outcome: "busy", detail: "A Claude session is running.")))
        let model = AccountRenewModel(renewer: renewer, stateProvider: RenewStateStub())
        let account = claudeAccount(renew: AccountRenewCapability(available: true))

        XCTAssertEqual(
            model.presentation(for: account),
            AccountRenewPresentation(action: .renewNow)
        )

        await model.renew(account: account)

        XCTAssertEqual(
            model.presentation(for: account),
            AccountRenewPresentation(
                action: .renewNow,
                isRenewing: false,
                outcomeText: "A Claude session is running."
            )
        )
    }

    @MainActor
    func testPresentationIsNilForAccountsWithoutRenewAffordance() {
        let model = AccountRenewModel(renewer: RenewStub(result: .success(AccountRenewal(outcome: "renewed"))), stateProvider: RenewStateStub())
        // Healthy account, old-daemon account, Codex account: all nil.
        XCTAssertNil(model.presentation(for: claudeAccount(authState: "ok", signinReason: nil, renew: AccountRenewCapability(available: true))))
        XCTAssertNil(model.presentation(for: claudeAccount(renew: nil)))
        XCTAssertNil(model.presentation(for: claudeAccount(provider: "codex", renew: AccountRenewCapability(available: true))))
    }

    // MARK: - autoRenewEnabled setting

    func testSettingsDecodeDefaultsAutoRenewOn() throws {
        // A pre-#176 daemon's document has no autoRenewEnabled key — the
        // typed default (ON, Tim's zero-effort direction) fills in.
        let json = #"{ "autoRefreshEnabled": true }"#
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(json.utf8))
        XCTAssertTrue(settings.autoRenewEnabled)
    }

    func testSettingsDecodeReadsExplicitAutoRenewOff() throws {
        let json = #"{ "autoRenewEnabled": false }"#
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(json.utf8))
        XCTAssertFalse(settings.autoRenewEnabled)
    }

    func testPatchEncodesOnlyAutoRenewKey() throws {
        let patch = DaemonSettingsPatch(autoRenewEnabled: false)
        let data = try JSONEncoder().encode(patch)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object.count, 1)
        XCTAssertEqual(object["autoRenewEnabled"] as? Bool, false)
        XCTAssertFalse(patch.isEmpty)
        XCTAssertTrue(DaemonSettingsPatch().isEmpty)
    }

    func testPatchMergingLaterAutoRenewWins() {
        let merged = DaemonSettingsPatch(autoRenewEnabled: true)
            .merging(DaemonSettingsPatch(autoRenewEnabled: false))
        XCTAssertEqual(merged.autoRenewEnabled, false)
    }

    @MainActor
    func testSetAutoRenewEnabledPushesPatchAndAdoptsResponse() async {
        var confirmed = DaemonSettings.defaults
        confirmed.autoRenewEnabled = false
        let sync = StubSettingsSync(results: [.success(confirmed)])
        let model = SettingsSyncModel(sync: sync)

        await model.setAutoRenewEnabled(false)

        XCTAssertEqual(sync.pushedPatches.count, 1)
        XCTAssertEqual(sync.pushedPatches.first?.autoRenewEnabled, false)
        XCTAssertFalse(model.settings.autoRenewEnabled)
        XCTAssertNil(model.lastError)
    }

    @MainActor
    func testSetAutoRenewEnabledIsNoOpWhenUnchanged() async {
        let sync = StubSettingsSync(results: [])
        let model = SettingsSyncModel(sync: sync)

        await model.setAutoRenewEnabled(true) // defaults are already true

        XCTAssertTrue(sync.pushedPatches.isEmpty)
    }

    @MainActor
    func testOldDaemonRejectingAutoRenewKeyIsASuccessfulNoOp() async {
        // Pre-#176 daemons answer "unknown setting: autoRenewEnabled" — the
        // key is stripped and a patch reduced to nothing is a successful
        // no-op (that daemon has no renew scheduler to configure anyway).
        let sync = StubSettingsSync(results: [
            .failure(DaemonClientError.daemonError(
                message: "unknown setting: autoRenewEnabled", status: 400
            )),
        ])
        let model = SettingsSyncModel(sync: sync)

        await model.setAutoRenewEnabled(false)

        XCTAssertEqual(sync.pushedPatches.count, 1)
        XCTAssertNil(model.lastError)
        XCTAssertTrue(model.settings.autoRenewEnabled) // unchanged: nothing was saved
    }
}

// MARK: - Stubs

private final class RenewStub: AccountRenewing, @unchecked Sendable {
    enum Result {
        case success(AccountRenewal)
        case failure(Error)
    }

    private let result: Result
    private(set) var renewedIDs: [String] = []

    init(result: Result) {
        self.result = result
    }

    func renewAccount(id: String) async throws -> AccountRenewal {
        renewedIDs.append(id)
        switch result {
        case .success(let renewal): return renewal
        case .failure(let error): throw error
        }
    }
}

private struct RenewStateStub: DeckStateProviding {
    func deckState() async throws -> DeckState {
        DeckState(accounts: [], usage: [])
    }
}
