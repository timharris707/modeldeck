import Foundation
import Testing
@testable import ModelDeckMacCore

@Suite("Issue #836 — remote cards show the usage page's numbers")
struct Issue836HubUsageTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let iso = ISO8601DateFormatter()

    private func state(usage: [UsageSnapshot], failed: Bool = false) -> DeckState {
        DeckState(
            accounts: [DeckAccount(id: "deck", provider: "claude", label: "ModelDeck", authState: "signin-required", signinReason: "missing")],
            usage: usage,
            proxy: DeckProxyStatus(role: .remote, hub: DeckProxyHub(
                url: "http://100.72.124.113:3871", lastAnsweredAt: iso.string(from: now.addingTimeInterval(-30)),
                lastFailedAt: failed ? iso.string(from: now) : nil, lastReadOk: true
            ))
        )
    }

    private func pageRow(minutesAgo: Double, source: String?) -> UsageSnapshot {
        UsageSnapshot(accountId: "deck", scope: "weekly", usedPercent: 12, remainingPercent: 88,
                      observedAt: iso.string(from: now.addingTimeInterval(-minutesAgo * 60)),
                      source: "pool-hub", hubSource: source)
    }

    @Test func pageReadingSaysHowOldAndWhere() throws {
        let row = try #require(DeckBuilder.rows(state: state(usage: [pageRow(minutesAgo: 9, source: "Linux · T3")]), now: now).first)
        #expect(row.remotePoolNotice(now: now)?.text == "Read 9 min ago · Linux · T3")
        #expect(row.remotePoolNotice(now: now)?.isWarning == false)
        #expect(row.signInRecovery == nil)
        #expect(row.windows.first?.remainingPercent == 88)
    }

    @Test func newestPageReadingWinsAndAMissingSourceIsLeftOut() throws {
        let rows = [pageRow(minutesAgo: 120, source: "M5"), pageRow(minutesAgo: 1, source: nil)]
        let row = try #require(DeckBuilder.rows(state: state(usage: rows), now: now).first)
        #expect(row.remotePoolNotice(now: now)?.text == "Read 1 min ago")
    }

    @Test func ownRowsKeepThePoolLineAndAFailingPageStillWarns() throws {
        let own = UsageSnapshot(accountId: "deck", scope: "weekly", remainingPercent: 50,
                                observedAt: iso.string(from: now.addingTimeInterval(-60)), source: "claude-oauth-api")
        let plain = try #require(DeckBuilder.rows(state: state(usage: [own]), now: now).first)
        #expect(plain.remotePoolNotice(now: now)?.text == "Uses the pool on 100.72.124.113")
        let failing = try #require(DeckBuilder.rows(state: state(usage: [pageRow(minutesAgo: 9, source: "Linux · T3")], failed: true), now: now).first)
        #expect(failing.remotePoolNotice(now: now)?.text == "Pool hub on 100.72.124.113 is not answering")
    }

    @Test func hubSourceDecodesAndIsOptional() throws {
        let json = #"[{"accountId":"a","scope":"weekly","source":"pool-hub","stale":false,"hubSource":"Studio · T3"},{"accountId":"b","scope":"weekly","stale":false}]"#
        let rows = try JSONDecoder().decode([UsageSnapshot].self, from: Data(json.utf8))
        #expect(rows.map(\.hubSource) == ["Studio · T3", nil])
    }
}
