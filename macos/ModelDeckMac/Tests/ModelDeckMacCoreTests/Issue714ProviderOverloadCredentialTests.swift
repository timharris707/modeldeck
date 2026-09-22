import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #714 — a provider overload is not an expired sign-in.
//
// 2026-09-20 15:25 PT: the rebalance job benched a Codex member because the
// provider answered `server_is_overloaded`. The proxy marked the credential
// unavailable, the daemon reported `proxyCredential: "error"` with that JSON
// as the detail, and the card tooltip and the Settings row both said "Proxy
// sign-in expired (…)" with the Fix sign-in button promoted. The refresh
// token was fine; a browser sign-in would have changed nothing.
//
// Placeholder identities only — this repo mirrors publicly.

/// The proxy's own status message on 2026-09-20, verbatim.
private let overloadDetail = #"{"error":{"type":"service_unavailable_error","code":"server_is_overloaded","headers":{"x-retry-metadata":"NO_MORE_RETRY"},"message":"Our servers are currently overloaded. Please try again later."}}"#
/// A dead refresh token, the #542 shape.
private let deadLoginDetail = #"{"error":"invalid_grant","error_description":"refresh token expired"}"#

private func member(
    proxyCredential: String? = "error",
    proxyCredentialDetail: String?
) -> DeckAccount {
    DeckAccount(
        id: "placeholder-codex", provider: "codex", label: "Placeholder Codex",
        enabled: true, isDefault: false,
        authState: "ok",
        proxyPool: "member",
        proxyCredential: proxyCredential,
        proxyCredentialDetail: proxyCredentialDetail,
        proxyRelogin: ProxyReloginCapability(available: true)
    )
}

@Suite("A provider overload is not an expired sign-in (issue #714)")
@MainActor
struct Issue714ProviderOverloadCredentialTests {
    /// THE TRIPWIRE: the two detail strings, the two wordings.
    @Test func theTwoDetailsGetTheTwoWordings() {
        let overloaded = member(proxyCredentialDetail: overloadDetail)
        let dead = member(proxyCredentialDetail: deadLoginDetail)
        #expect(ProxyRelogin.credentialText(for: overloaded) == "Provider overloaded · proxy retrying")
        #expect(ProxyRelogin.credentialText(for: dead) == "Proxy sign-in expired (\(deadLoginDetail))")
        // The same sentence reaches the Settings row and the card.
        let model = makeModel()
        #expect(model.presentation(for: overloaded)?.credentialText == "Provider overloaded · proxy retrying")
        #expect(model.presentation(for: dead)?.credentialText == "Proxy sign-in expired (\(deadLoginDetail))")
    }

    /// CodeRabbit (PR #715): an overloaded member that ALSO carries a
    /// routed-failure streak the daemon did not mark transient must still not
    /// promote the repair. The proxy's own overload verdict outranks the
    /// streak: it is the same incident, and signing in fixes nothing.
    @Test func anOverloadWithANonTransientStreakStillOffersNoFix() throws {
        let model = makeModel()
        let overloaded = member(proxyCredentialDetail: overloadDetail)
        for transient in [Bool?.none, false] {
            let streak = MemberBlackoutAlert(
                accountId: "placeholder-codex", provider: "codex", label: "Placeholder Codex",
                consecutiveFailures: 4,
                firstFailureAt: "2026-09-20T22:17:01.000Z", lastFailureAt: "2026-09-20T22:25:07.000Z",
                statusCode: 503, remedy: "Sign in again to restore proxy routing.", transient: transient
            )
            #expect(!ProxyRelogin.credentialIsBroken(overloaded, routedFailures: streak))
            let row = try #require(model.presentation(for: overloaded, routedFailures: streak))
            #expect(row.credentialIsBroken == false)
            #expect(row.display != .action(prominent: true))
        }
    }

    /// The Fix sign-in offer stays with the dead login only. The overloaded
    /// member still lights the card, but as a quiet glyph: no promoted
    /// repair, no browser promise in the popover.
    @Test func onlyTheDeadLoginPromotesTheRepair() throws {
        let model = makeModel()
        let overloaded = member(proxyCredentialDetail: overloadDetail)
        let dead = member(proxyCredentialDetail: deadLoginDetail)

        let overloadedRow = try #require(model.presentation(for: overloaded))
        #expect(overloadedRow.credentialIsBroken == false)
        #expect(overloadedRow.credentialIsOverloaded == true)
        #expect(overloadedRow.display == .action(prominent: false))
        let overloadedCard = try #require(ProxyRelogin.cardIndicator(overloadedRow))
        let overloadedExplanation = DeckWarningExplanation.proxyCredential(for: overloaded, presentation: overloadedCard)
        #expect(overloadedExplanation.title == "Provider overloaded · Placeholder Codex (Codex)")
        #expect(overloadedExplanation.body.contains(ProxyRelogin.overloadedExplanation))
        #expect(!overloadedExplanation.body.contains(ProxyRelogin.confirmation(label: "Placeholder Codex")))

        let deadRow = try #require(model.presentation(for: dead))
        #expect(deadRow.credentialIsBroken == true)
        #expect(deadRow.credentialIsOverloaded == false)
        #expect(deadRow.display == .action(prominent: true))
        let deadExplanation = DeckWarningExplanation.proxyCredential(for: dead, presentation: deadRow)
        #expect(deadExplanation.title == "Proxy sign-in expired · Placeholder Codex (Codex)")
        #expect(deadExplanation.body.contains(ProxyRelogin.confirmation(label: "Placeholder Codex")))
    }

    /// An empty detail is still a dead login (the 2026-09-17 shape), and an
    /// `ok` credential with overload words in its detail is not an overload.
    @Test func theClassifierFailsTowardsTheDeadLoginReading() {
        #expect(ProxyRelogin.detailIsProviderOverload(nil) == false)
        #expect(ProxyRelogin.detailIsProviderOverload("") == false)
        #expect(ProxyRelogin.detailIsProviderOverload("token expired") == false)
        #expect(ProxyRelogin.detailIsProviderOverload("Our servers are currently overloaded") == true)
        #expect(ProxyRelogin.credentialIsOverloaded(member(proxyCredential: "ok", proxyCredentialDetail: overloadDetail)) == false)
    }
}

@MainActor
private func makeModel() -> ProxyReloginModel {
    ProxyReloginModel(
        manager: SilentStub(),
        stateProvider: SilentStub(),
        browser: SilentStub(),
        pollInterval: .zero,
        sleep: { _ in }
    )
}

private struct SilentStub: ProxyReloginManaging, DeckStateProviding, BrowserOpening {
    func startProxyRelogin(accountID: String) async throws -> ProxyReloginState { ProxyReloginState(phase: "idle") }
    func proxyReloginState(accountID: String) async throws -> ProxyReloginState { ProxyReloginState(phase: "idle") }
    func cancelProxyRelogin(accountID: String) async throws -> ProxyReloginState { ProxyReloginState(phase: "cancelled") }
    func deckState() async throws -> DeckState { DeckState(accounts: [], usage: []) }
    func open(_ url: URL) {}
}
