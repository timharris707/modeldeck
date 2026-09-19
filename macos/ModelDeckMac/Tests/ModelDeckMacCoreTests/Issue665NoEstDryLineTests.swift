import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #665 (Tim, 2026-09-16): the #503 "Est. dry …" caption is gone from
// every deck card. These pin the removal: a deck refresh never asks the
// daemon for the forecast, and the row's spoken label never claims a dry
// time. The daemon endpoint itself stays (the dashboard reads it), so the
// client decoding tests from #503 live on here.
@Suite("Issue 665 · no Est. dry line on deck cards")
struct Issue665NoEstDryLineTests {
    private struct StubEvaluatorOnly: UsageEvaluating {
        func evaluateWorstRemaining() async throws -> WorstRemaining? { nil }
    }

    private static let stateBody = #"{"accounts":[{"id":"a1","provider":"claude","label":"Studio","enabled":true}],"usage":[]}"#

    /// Tripwire: the forecast read used to ride every deck refresh. If it
    /// comes back, the refresh will hit the endpoint again.
    @MainActor
    @Test func aDeckRefreshNeverReadsTheForecastEndpoint() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: Self.stateBody),
            .init(status: 200, body: Self.stateBody),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(port: 65_000), transport: transport)
        let model = MenuBarStatusModel(evaluator: StubEvaluatorOnly(), stateProvider: client)
        await model.refresh()
        await model.refresh()
        let paths = transport.requests.compactMap { $0.url?.path }
        #expect(paths.contains("/api/state"))
        #expect(!paths.contains("/api/usage/exhaustion-forecast"))
    }

    /// The row's VoiceOver label speaks what the card shows; with no caption
    /// there is nothing about running dry to say.
    @Test func theRowLabelNeverSpeaksADryTime() {
        let row = DeckAccountRow(
            account: DeckAccount(id: "a1", provider: "claude", label: "Studio", proxyWeight: 8),
            provider: .claude,
            windows: [],
            isActive: false,
            activationState: .unknown
        )
        let label = row.accessibilityLabel(showsIdentity: false, isMenuBarSource: true)
        #expect(label == "Studio, shown in menu bar, proxy routing weight 8")
        #expect(!label.lowercased().contains("dry"))
    }
}

/// Decoding + transport for the daemon's forecast endpoint (#497), kept
/// from #503: the payload shape mirrors `exhaustionForecastReport` in
/// src/usage-analytics.mjs and the dashboard still reads it.
@Suite("Issue 665 · forecast payload still decodes")
struct Issue665ForecastPayloadTests {
    private static let payload = """
    {
      "estimateLabel": "Estimate",
      "basisWindow": {
        "source": "usage_snapshots",
        "label": "trailing 24 hours",
        "since": "2027-01-12T00:00:00.000Z",
        "until": "2027-01-13T00:00:00.000Z",
        "hours": 24,
        "minimumSpanMinutes": 45
      },
      "accounts": [
        {
          "accountId": "a1",
          "accountLabel": "Studio",
          "provider": "claude",
          "scope": "week",
          "status": "forecast",
          "dryAt": "2027-01-13T18:00:00.000Z",
          "burnRatePercentPerHour": 4.25,
          "resetsAt": "2027-01-14T00:00:00.000Z",
          "carryover": null,
          "reason": null
        },
        {
          "accountId": "a2",
          "accountLabel": "Overflow",
          "provider": "codex",
          "scope": null,
          "status": "no-forecast",
          "dryAt": null,
          "burnRatePercentPerHour": null,
          "resetsAt": null,
          "carryover": null,
          "reason": "Not enough recent usage to measure a pace."
        }
      ],
      "pool": {
        "status": "forecast",
        "worstCase": {
          "accountId": "a1",
          "accountLabel": "Studio",
          "status": "forecast",
          "dryAt": "2027-01-13T18:00:00.000Z"
        }
      }
    }
    """

    @Test func theFullPayloadDecodes() throws {
        let report = try JSONDecoder().decode(
            ExhaustionForecast.self, from: Data(Self.payload.utf8)
        )
        #expect(report.estimateLabel == "Estimate")
        #expect(report.basisWindow?.label == "trailing 24 hours")
        #expect(report.accounts.count == 2)
        #expect(report.account(id: "a2")?.status == "no-forecast")
        #expect(report.account(id: "a2")?.reason == "Not enough recent usage to measure a pace.")
        #expect(report.pool?.worstCase?.accountId == "a1")
    }

    /// Tolerant decoding, the house rule: a daemon that omits blocks yields
    /// nils and an empty roster instead of failing the whole read.
    @Test func anOlderShapeDecodesToEmptyRatherThanFailing() throws {
        let report = try JSONDecoder().decode(
            ExhaustionForecast.self, from: Data("{}".utf8)
        )
        #expect(report.accounts.isEmpty)
        #expect(report.pool == nil)
        #expect(report.basisWindow == nil)
    }

    @Test func theClientReadsTheForecastEndpoint() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: Self.payload)])
        let client = DaemonClient(
            configuration: DaemonConfiguration(port: 65_000),
            transport: transport
        )
        let report = try await client.exhaustionForecast()
        #expect(report.accounts.count == 2)
        #expect(transport.requests.first?.url?.path == "/api/usage/exhaustion-forecast")
    }
}
