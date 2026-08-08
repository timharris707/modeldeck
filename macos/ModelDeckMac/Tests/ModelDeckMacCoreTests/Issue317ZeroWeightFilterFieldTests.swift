import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #317: field failure of the #315/#316 zero-weight filter on Tim's
// live deck (0.4.0). This fixture mirrors the REAL /api/state payload shape
// captured from the local daemon on 2026-08-08 (identities scrubbed to
// placeholders; weights, flags, and window scopes are the real shape):
//
//   7 Claude accounts, ALL pool members with LIVE proxyWeight > 0
//   (3, 1, 1, 3, 3, 10, 10) — none carried a nil or 0 weight.
//   6 of 7 had proxyFableExcluded == true, and each of those six's worst
//   window was its model-scoped "Fable weekly" (2–5% remaining), NOT the
//   general weekly — so the badge rendered the EFFECTIVE ⑂ 0 (#272/#287)
//   while the live weight stayed positive.
//
// The #316 predicate read the live weight only, so the toggle hid nothing:
// six rows said ⑂ 0, the filter saw 3/1/1/3/3/10/10, and the control
// looked dead. These tests pin the corrected contract: the filter hides
// exactly the rows whose badge displays 0.

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
}

/// One Claude pool member shaped like the captured payload rows.
private func member(
    _ id: String,
    label: String,
    weight: Int,
    fableExcluded: Bool?
) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: "claude",
        label: label,
        identity: "\(id)@example.com",
        enabled: true,
        isDefault: false,
        proxyWeight: weight,
        proxyFableExcluded: fableExcluded,
        proxyPool: "member"
    )
}

private func window(
    _ accountId: String,
    scope: String,
    remaining: Double
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: iso(3_600),
        stale: false
    )
}

/// The captured deck: account ids/labels are placeholders; the weight,
/// benching, and per-window shape match the live payload account for
/// account. `p5` is the one unbenched account (Tim's seventh).
private func capturedFieldState() -> DeckState {
    let roster: [(id: String, weight: Int, fableExcluded: Bool?, fableWeekly: Double, fiveHour: Double, weekly: Double)] = [
        ("p1", 3, true, 3, 100, 50),
        ("p2", 1, true, 5, 53, 52),
        ("p3", 1, true, 4, 100, 50),
        ("p4", 3, true, 5, 100, 50),
        ("p5", 3, nil, 83, 56, 91),
        ("p6", 10, true, 2, 99, 43),
        ("p7", 10, true, 0, 97, 42),
    ]
    return DeckState(
        accounts: roster.map {
            member($0.id, label: "Account \($0.id)", weight: $0.weight, fableExcluded: $0.fableExcluded)
        },
        usage: roster.flatMap {
            [
                window($0.id, scope: "5-hour", remaining: $0.fiveHour),
                window($0.id, scope: "Fable weekly", remaining: $0.fableWeekly),
                window($0.id, scope: "weekly", remaining: $0.weekly),
                window($0.id, scope: "spend", remaining: 100),
            ]
        }
    )
}

@Suite("Issue #317 zero-weight filter field regression")
@MainActor
struct Issue317ZeroWeightFilterFieldTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "issue317-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test func sixBenchedRowsDisplayZeroWhileLiveWeightsArePositive() {
        // The input diagnosis itself, pinned: nobody's weight is nil or 0,
        // yet six badges render 0. Any change that breaks this precondition
        // invalidates the filter tests below.
        let rows = DeckBuilder.rows(state: capturedFieldState(), now: now)
        #expect(rows.count == 7)
        #expect(rows.allSatisfy { ($0.account.proxyWeight ?? 0) > 0 })
        let displayedZero = rows.filter { $0.proxyWeightPresentation?.weight == 0 }
        #expect(Set(displayedZero.map(\.id)) == ["p1", "p2", "p3", "p4", "p6", "p7"])
        #expect(rows.first { $0.id == "p5" }?.proxyWeightPresentation?.weight == 3)
    }

    @Test func toggleHidesExactlyTheSixRowsShowingZero() {
        // Tim's click, replayed: filter ON hides the six ⑂ 0 rows and keeps
        // the one row showing a positive weight; the count line still says 7.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideZeroWeightAccounts = true
        let claude = model.columns(for: capturedFieldState(), now: now)
            .first { $0.provider == .claude }!
        #expect(claude.rows.map(\.id) == ["p5"])
        #expect(claude.hiddenZeroWeightCount == 6)
        #expect(claude.accountCountText == "7 accounts")
    }

    @Test func fullClickPathTogglePersistsAndRederives() {
        // The footer button's whole path: toggle → UserDefaults → row
        // re-derivation, including a relaunch (fresh model, same defaults).
        let defaults = freshDefaults()
        let state = capturedFieldState()
        let model = DeckPopoverModel(defaults: defaults)
        #expect(model.columns(for: state, now: now)
            .first { $0.provider == .claude }!.rows.count == 7)
        model.toggleZeroWeightFilter()
        #expect(defaults.bool(forKey: DeckPopoverModel.hideZeroWeightDefaultsKey))
        #expect(model.columns(for: state, now: now)
            .first { $0.provider == .claude }!.rows.count == 1)
        let relaunched = DeckPopoverModel(defaults: defaults)
        #expect(relaunched.columns(for: state, now: now)
            .first { $0.provider == .claude }!.rows.count == 1)
        relaunched.toggleZeroWeightFilter()
        #expect(relaunched.columns(for: state, now: now)
            .first { $0.provider == .claude }!.rows.count == 7)
    }

    @Test func toggleIsOfferedOnThisDeck() {
        #expect(DeckPopoverModel.offersZeroWeightToggle(state: capturedFieldState()))
    }
}
