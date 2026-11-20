import Foundation
import Testing
@testable import ModelDeckMacCore

@Suite("Issue #832 — pool-only sign-in presentation")
struct Issue832RemoteSignInTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func state(role: ProxyRole, failed: Bool = false, readOk: Bool = true, reason: String = "missing") -> DeckState {
        let answered = ISO8601DateFormatter().string(from: now.addingTimeInterval(-60))
        let failure = ISO8601DateFormatter().string(from: now)
        return DeckState(
            accounts: [DeckAccount(id: "test", provider: "codex", label: "Test", authState: "signin-required", signinReason: reason)],
            usage: [UsageSnapshot(accountId: "test", scope: "5h", remainingPercent: 50, observedAt: answered, stale: true)],
            proxy: DeckProxyStatus(role: role, hub: DeckProxyHub(
                url: "https://pool.example.test/usage", lastAnsweredAt: answered,
                lastFailedAt: failed ? failure : nil, lastReadOk: readOk
            ))
        )
    }

    private func footer(_ state: DeckState) -> String {
        DeckFreshness.explainedFooterText(DeckFreshness.footerBreakdown(
            state: state, now: now, autoRefreshInterval: 300
        ))
    }

    @Test func remoteHealthyMissingIsNotSignedOut() throws {
        let state = state(role: .remote)
        let row = try #require(DeckBuilder.rows(state: state, now: now).first)
        #expect(row.signInRecovery == nil)
        #expect(row.remotePoolNotice(now: now)?.text == "Uses the pool on pool.example.test")
        #expect(row.remotePoolNotice(now: now)?.isWarning == false)
        #expect(row.staleness(now: now, autoRefreshInterval: 300) == nil)
        #expect(row.signInRecovery(now: now, autoRefreshInterval: 300) == nil)
        #expect(footer(state).isEmpty)
        #expect(DeckPopoverModel.signInAgainTarget(accountID: "test", state: state) == nil)
    }

    @Test func remoteFailedMissingDoesNotAskForLocalSignIn() throws {
        let state = state(role: .remote, failed: true)
        let row = try #require(DeckBuilder.rows(state: state, now: now).first)
        #expect(row.signInRecovery == nil)
        #expect(footer(state).isEmpty)
        #expect(row.remotePoolNotice(now: now)?.text == "Pool hub on pool.example.test is not answering")
        #expect(row.remotePoolNotice(now: now)?.isWarning == true)
        #expect(ProxyRoleCopy.hubFreshness(try #require(state.proxy?.hub), now: now) == ProxyRoleCopy.hubNotAnswering)
    }

    @Test func remoteNoFreshDataWarnsWithoutLocalSignIn() throws {
        let state = state(role: .remote, readOk: false)
        let row = try #require(DeckBuilder.rows(state: state, now: now).first)
        #expect(row.signInRecovery == nil)
        #expect(footer(state).isEmpty)
        #expect(row.remotePoolNotice(now: now)?.text == "Pool hub on pool.example.test has no fresh data")
        #expect(row.remotePoolNotice(now: now)?.isWarning == true)
    }

    @Test func hostMissingKeepsRecoveryAndCount() throws {
        let state = state(role: .host)
        let row = try #require(DeckBuilder.rows(state: state, now: now).first)
        #expect(row.remotePoolNotice(now: now) == nil)
        #expect(row.signInRecovery?.tone == .signedOut)
        #expect(footer(state) == "1 signed out")
        #expect(DeckPopoverModel.signInAgainTarget(accountID: "test", state: state) != nil)
    }

    @Test(arguments: ["expired", "revoked"])
    func otherReasonsKeepRecovery(reason: String) throws {
        for role in [ProxyRole.host, .remote] {
            let state = state(role: role, reason: reason)
            let row = try #require(DeckBuilder.rows(state: state, now: now).first)
            #expect(row.remotePoolNotice(now: now) == nil)
            #expect(row.signInRecovery != nil)
            #expect(footer(state) == (reason == "expired" ? "1 idle" : "1 signed out"))
        }
    }
}
