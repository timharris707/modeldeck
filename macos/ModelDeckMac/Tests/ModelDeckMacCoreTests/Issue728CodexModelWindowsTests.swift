import Foundation
import Testing
@testable import ModelDeckMacCore

/// Issue #728: a Codex card lists the account weekly (main) and a general
/// 5-hour window (sub); model-scoped Codex windows show only once they
/// carry usage. Claude cards are untouched.
@Suite("Issue #728 — Codex model-scoped windows hide while unused")
struct Issue728CodexModelWindowsTests {
    private let now = Date(timeIntervalSince1970: 1_753_000_000)

    private func account(_ id: String, provider: String) -> DeckAccount {
        DeckAccount(id: id, provider: provider, label: id, identity: "\(id)@example.com", enabled: true, isDefault: false)
    }

    private func snapshot(_ id: String, scope: String, remaining: Double, resetsIn: TimeInterval?) -> UsageSnapshot {
        UsageSnapshot(
            accountId: id,
            scope: scope,
            remainingPercent: remaining,
            resetsAt: resetsIn.map { ISO8601DateFormatter().string(from: now.addingTimeInterval($0)) }
        )
    }

    // TRIPWIRE #728: Tim's live card — one real weekly plus three untouched
    // model-scoped windows — renders exactly the weekly.
    @Test func untouchedCodexModelWindowsAreHidden() {
        let state = DeckState(
            accounts: [account("x1", provider: "codex")],
            usage: [
                snapshot("x1", scope: "weekly", remaining: 15, resetsIn: 3 * 86_400),
                snapshot("x1", scope: "GPT-5.3-Codex-Spark 5-hour", remaining: 100, resetsIn: nil),
                snapshot("x1", scope: "GPT-5.3-Codex-Spark weekly", remaining: 100, resetsIn: 7 * 86_400),
                snapshot("x1", scope: "gpt-reserve weekly", remaining: 100, resetsIn: 7 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.windows.map(\.scope) == ["weekly"])
        #expect(row.worstWindow?.scope == "weekly")
    }

    @Test func aGeneralFiveHourWindowStaysAsTheSubRow() {
        let state = DeckState(
            accounts: [account("x1", provider: "codex")],
            usage: [
                snapshot("x1", scope: "weekly", remaining: 15, resetsIn: 3 * 86_400),
                snapshot("x1", scope: "5-hour", remaining: 100, resetsIn: nil),
                snapshot("x1", scope: "GPT-5.3-Codex-Spark weekly", remaining: 100, resetsIn: 7 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.windows.map(\.scope) == ["5-hour", "weekly"])
    }

    @Test func aModelWindowWithRealUsageComesBack() {
        let state = DeckState(
            accounts: [account("x1", provider: "codex")],
            usage: [
                snapshot("x1", scope: "weekly", remaining: 15, resetsIn: 3 * 86_400),
                snapshot("x1", scope: "GPT-5.3-Codex-Spark weekly", remaining: 90, resetsIn: 7 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.windows.map(\.scope) == ["weekly", "GPT-5.3-Codex-Spark weekly"])
    }

    // CodeRabbit on PR #730: "openai" maps to Codex and must get the same rule.
    @Test func openaiSpelledProviderIsTreatedAsCodex() {
        let state = DeckState(
            accounts: [account("x1", provider: "openai")],
            usage: [
                snapshot("x1", scope: "weekly", remaining: 15, resetsIn: 3 * 86_400),
                snapshot("x1", scope: "GPT-5.3-Codex-Spark weekly", remaining: 100, resetsIn: 7 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.windows.map(\.scope) == ["weekly"])
    }

    @Test func claudeModelWeeklyIsNeverHidden() {
        let state = DeckState(
            accounts: [account("c1", provider: "claude")],
            usage: [
                snapshot("c1", scope: "week", remaining: 40, resetsIn: 3 * 86_400),
                snapshot("c1", scope: "week:fable", remaining: 100, resetsIn: 7 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.windows.map(\.scope) == ["week", "week:fable"])
    }
}
