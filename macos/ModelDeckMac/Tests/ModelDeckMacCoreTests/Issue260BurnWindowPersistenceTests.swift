import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #260 (Tim, 2026-08-05): the chip sat YELLOW all day on a measured
// ~13,500 pts/day Fable burn, he installed v0.3.20, and the verdict snapped
// to GREEN the moment the app relaunched itself. Nothing improved — the
// in-memory burn window was destroyed, `burstRate` went nil, and the burst
// scenario stopped degrading the steady-state GREEN. #241's self-announcing
// updates put that blind window on every release.
//
// These tests pin the relaunch as the scenario, not an abstract "encode and
// decode" round trip. Placeholder identities only.

private let fixedNow = Date(timeIntervalSince1970: 1_785_000_000)

private func iso(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
}

/// A Claude deck whose Fable weekly is being burned hard.
private func burningState(remaining: Double, observedAt: Date) -> DeckState {
    DeckState(
        accounts: [
            DeckAccount(
                id: "c1", provider: "claude", label: "Studio",
                metadata: DeckAccountMetadata(
                    claudePlan: ProviderPlanInfo(rateLimitTier: "max_20x")
                ),
                authState: "ok"
            ),
        ],
        usage: [
            UsageSnapshot(
                accountId: "c1", scope: "Fable weekly",
                remainingPercent: remaining,
                resetsAt: iso(fixedNow.addingTimeInterval(80 * 3600)),
                observedAt: iso(observedAt)
            ),
        ]
    )
}

private func freshDefaults(_ name: String) -> UserDefaults {
    let suite = "modeldeck-burnwindow-\(name)-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
}

@Suite("Burn window survives relaunch (issue #260)")
@MainActor
struct BurnWindowPersistenceTests {
    /// Feeds 40 minutes of samples — past `minimumActiveSpan` — so the
    /// window is genuinely ACTIVE before the simulated relaunch.
    private func warmModel(defaults: UserDefaults?, now: Date) -> MenuBarStatusModel {
        let model = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { now },
            burnWindowStore: defaults
        )
        for minute in stride(from: 0, through: 40, by: 5) {
            model.recordBurnSample(
                state: burningState(
                    remaining: 90 - Double(minute),          // 1 %-point/min
                    observedAt: now.addingTimeInterval(Double(minute - 40) * 60)
                )
            )
        }
        return model
    }

    @Test func aWarmWindowReportsARate() {
        let model = warmModel(defaults: nil, now: fixedNow)
        #expect(model.burstRate(for: .claude) != nil)
    }

    @Test func relaunchWithoutPersistenceLosesTheRate() {
        // The v0.3.20 behavior, kept as the explicit contrast: a new model
        // with no store starts blind, which is what flipped the verdict.
        let warm = warmModel(defaults: nil, now: fixedNow)
        #expect(warm.burstRate(for: .claude) != nil)
        let relaunched = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []), clock: { fixedNow }, burnWindowStore: nil
        )
        #expect(relaunched.burstRate(for: .claude) == nil)
    }

    @Test func relaunchWithPersistenceKeepsTheRate() {
        let defaults = freshDefaults("relaunch")
        let warm = warmModel(defaults: defaults, now: fixedNow)
        let before = warm.burstRate(for: .claude)
        #expect(before != nil)

        // The upgrade: a brand-new process, same stored samples, same clock.
        let relaunched = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { fixedNow },
            burnWindowStore: defaults
        )
        #expect(relaunched.burstRate(for: .claude) == before)
    }

    @Test func theVerdictDoesNotJumpToGreenAcrossARelaunch() {
        // End to end, the thing Tim watched: a burst-degraded YELLOW must
        // still be YELLOW after the app restarts.
        let defaults = freshDefaults("verdict")
        let warm = warmModel(defaults: defaults, now: fixedNow)
        // Steady state is comfortably GREEN here, so the YELLOW below is
        // produced BY the burst — which is exactly the signal the relaunch
        // used to throw away.
        let state = burningState(remaining: 95, observedAt: fixedNow)
        let before = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow,
            burstPointsPerDay: warm.burstRate(for: .claude)
        )
        #expect(before.verdict == .yellow)
        #expect(before.burstDegraded)

        let relaunched = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { fixedNow },
            burnWindowStore: defaults
        )
        let after = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow,
            burstPointsPerDay: relaunched.burstRate(for: .claude)
        )
        #expect(after.verdict == before.verdict)
        #expect(after.burstDegraded)
    }

    @Test func aLongClosedAppResumesColdRatherThanFabricatingARate() {
        // Samples older than the 3h window are pruned on restore: coming
        // back after a night away must not invent a rate across the gap.
        let defaults = freshDefaults("stale")
        _ = warmModel(defaults: defaults, now: fixedNow)
        let muchLater = fixedNow.addingTimeInterval(9 * 3600)
        let relaunched = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { muchLater },
            burnWindowStore: defaults
        )
        #expect(relaunched.burstRate(for: .claude) == nil)
        #expect(relaunched.burnWindow.sampleCount(for: .claude) == 0)
    }

    @Test func corruptOrForeignStorageDecodesToAColdWindow() throws {
        // Never a crash, never a guess: unreadable data reads as no history.
        let garbage = BurnRateWindow(restoring: Data("not json".utf8), now: fixedNow)
        #expect(garbage.sampleCount(for: .claude) == 0)
        #expect(BurnRateWindow(restoring: nil, now: fixedNow).sampleCount(for: .claude) == 0)
        // CodeRabbit (PR #259): prove the unknown key is IGNORED rather than
        // fatal — a fresh sibling series in the same payload must survive.
        // (The earlier fixture held only an unknown, stale key, so age
        // pruning alone would have satisfied it.)
        // Built from a REAL encoded payload with an unknown key spliced in,
        // so the fixture can't drift from the encoder's date format.
        let warm = warmModel(defaults: nil, now: fixedNow)
        let realData = try #require(warm.burnWindow.encoded())
        var object = try #require(
            JSONSerialization.jsonObject(with: realData) as? [String: Any]
        )
        let validSeries = try #require(object.values.first)
        object["martian|a1"] = validSeries
        let mixed = try JSONSerialization.data(withJSONObject: object)

        let restored = BurnRateWindow(restoring: mixed, now: fixedNow)
        #expect(restored.sampleCount(for: .claude) == warm.burnWindow.sampleCount(for: .claude))
        #expect(restored.sampleCount(for: .claude) > 0)
        #expect(restored.sampleCount(for: .codex) == 0)
    }

    @Test func aRemovedAccountStopsDrivingTheRateAfterRelaunch() {
        // CodeRabbit (PR #259) — a bug persistence created: restored samples
        // for an account that is gone (deleted or disabled) used to keep
        // summing into the provider's burn rate for the whole 3h window.
        let defaults = freshDefaults("removed")
        _ = warmModel(defaults: defaults, now: fixedNow)
        let relaunched = MenuBarStatusModel(
            evaluator: StubEvaluator(results: []),
            clock: { fixedNow },
            burnWindowStore: defaults
        )
        #expect(relaunched.burstRate(for: .claude) != nil)

        // The account is gone from the next fresh state; its history must go
        // with it rather than degrade the verdict from beyond the grave.
        let withoutC1 = DeckState(
            accounts: [
                DeckAccount(
                    id: "c2", provider: "claude", label: "Other",
                    metadata: DeckAccountMetadata(
                        claudePlan: ProviderPlanInfo(rateLimitTier: "max_20x")
                    ),
                    authState: "ok"
                ),
            ],
            usage: []
        )
        relaunched.recordBurnSample(state: withoutC1)
        #expect(relaunched.burnWindow.sampleCount(for: .claude) == 0)
        #expect(relaunched.burstRate(for: .claude) == nil)
    }

    @Test func aDegenerateEmptyStateDoesNotWipeTheWindow() {
        // The guard on the pruning above: a daemon momentarily reporting no
        // accounts must not blank a healthy window.
        let defaults = freshDefaults("empty")
        let model = warmModel(defaults: defaults, now: fixedNow)
        let before = model.burnWindow.sampleCount(for: .claude)
        model.recordBurnSample(state: DeckState(accounts: [], usage: []))
        #expect(model.burnWindow.sampleCount(for: .claude) == before)
        #expect(model.burstRate(for: .claude) != nil)
    }

    @Test func aColdWindowSaysItIsStillMeasuring() {
        // The honesty half: with no burst opinion, the detail says so
        // instead of letting a steady-state GREEN imply a measured
        // all-clear.
        let state = burningState(remaining: 50, observedAt: fixedNow)
        let report = AvailabilityHealthEngine.report(
            for: .claude, state: state, now: fixedNow, burstPointsPerDay: nil
        )
        let presentation = AvailabilityHealthPresentation.make(report: report, now: fixedNow)
        #expect(presentation.factLines.contains("Today's burn: still measuring"))
    }
}
