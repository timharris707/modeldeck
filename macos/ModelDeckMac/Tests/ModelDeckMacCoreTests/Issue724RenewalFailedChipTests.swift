import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #724 — repeated automatic renewal failures must stop presenting an
// expired sign-in as harmless idle decay, while old daemons keep their copy.

@Suite("Issue #724: failed renewal recovery chip")
struct Issue724RenewalFailedChipTests {
    private func account(failures: Int?, detail: String? = nil) -> DeckAccount {
        DeckAccount(
            id: "acct-724",
            provider: "claude",
            label: "Renewal fixture",
            authState: "signin-required",
            signinReason: "expired",
            renew: failures.map {
                AccountRenewCapability(
                    consecutiveFailures: $0,
                    lastAttempt: detail.map {
                        AccountRenewAttempt(outcome: "failed", cause: "network", detail: $0)
                    }
                )
            }
        )
    }

    @Test("twoConsecutiveFailuresStopTheIdleCopy")
    func twoConsecutiveFailuresStopTheIdleCopy() {
        let failed = DeckFreshness.signInRecovery(for: account(failures: 2))
        #expect(failed?.text == "Renewal failed — sign in needed")
        #expect(failed?.tone == .signedOut)
        #expect(failed?.text.contains("renews on next use") == false)
        #expect(DeckFreshness.signInRecovery(for: account(failures: 1))?.text == "Idle — renews on next use")
        #expect(DeckFreshness.signInRecovery(for: account(failures: nil))?.text == "Idle — renews on next use")
    }

    @Test("detailLeadsTheTooltip")
    func detailLeadsTheTooltip() {
        let recovery = DeckFreshness.signInRecovery(
            for: account(failures: 2, detail: "Could not reach Anthropic (DNS lookup failed)")
        )
        #expect(recovery?.tooltip.hasPrefix("Automatic renewal failed 2 times. Last: Could not reach Anthropic") == true)
    }

    @Test("deckFreshnessReferencesConsecutiveFailures")
    func deckFreshnessReferencesConsecutiveFailures() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/ModelDeckMacCore/DeckFreshness.swift"),
            encoding: .utf8
        )
        #expect(source.contains("consecutiveFailures"))
    }
}
