import Foundation
import Testing
@testable import ModelDeckMacCore

/// Canned transport: returns queued (status, body) pairs and records requests.
final class StubTransport: HTTPDataTransport, @unchecked Sendable {
    struct Stub {
        var status: Int
        var body: String
    }

    private let lock = NSLock()
    private var stubs: [Stub]
    private(set) var requests: [URLRequest] = []

    init(stubs: [Stub]) {
        self.stubs = stubs
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let stub = try nextStub(recording: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(stub.body.utf8), response)
    }

    private func nextStub(recording request: URLRequest) throws -> Stub {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
        guard !stubs.isEmpty else { throw URLError(.cannotConnectToHost) }
        return stubs.removeFirst()
    }
}

@Suite("Daemon configuration")
struct DaemonConfigurationTests {
    @Test func defaultsToLoopbackPort3867() {
        let config = DaemonConfiguration()
        #expect(config.host == "127.0.0.1")
        #expect(config.port == 3867)
        #expect(config.baseURL.absoluteString == "http://127.0.0.1:3867")
    }

    @Test func environmentPortWins() {
        let defaults = UserDefaults(suiteName: "modeldeck-tests-env")!
        defaults.set(4111, forKey: "modeldeck.daemon.port")
        defer { defaults.removePersistentDomain(forName: "modeldeck-tests-env") }
        let config = DaemonConfiguration.resolved(environment: ["MODELDECK_PORT": "4222"], defaults: defaults)
        #expect(config.port == 4222)
    }

    @Test func userDefaultsPortUsedWhenNoEnvironment() {
        let defaults = UserDefaults(suiteName: "modeldeck-tests-defaults")!
        defaults.set(4111, forKey: "modeldeck.daemon.port")
        defer { defaults.removePersistentDomain(forName: "modeldeck-tests-defaults") }
        let config = DaemonConfiguration.resolved(environment: [:], defaults: defaults)
        #expect(config.port == 4111)
    }

    @Test func garbageEnvironmentPortFallsThrough() {
        let defaults = UserDefaults(suiteName: "modeldeck-tests-garbage")!
        defaults.removePersistentDomain(forName: "modeldeck-tests-garbage")
        let config = DaemonConfiguration.resolved(environment: ["MODELDECK_PORT": "not-a-port"], defaults: defaults)
        #expect(config.port == 3867)
    }
}

@Suite("Daemon client decoding")
struct DaemonClientTests {
    // Response shapes mirror src/server.mjs + src/db.mjs row mappers.
    private let healthJSON = #"{"ok":true,"name":"ModelDeck","version":"0.1.0","projectsRoot":"/placeholder/projects"}"#

    private let stateJSON = #"""
    {
      "accounts": [
        {"id":"acct-1","provider":"claude","label":"Deck One","identity":"","purpose":"","profileRef":"profile-1","color":"#4A90D9","enabled":true,"isDefault":true,"metadata":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"},
        {"id":"acct-2","provider":"codex","label":"Deck Two","enabled":true,"isDefault":false}
      ],
      "usage": [
        {"accountId":"acct-1","scope":"5h","usedPercent":81.5,"remainingPercent":18.5,"resetsAt":"2026-07-19T21:00:00Z","observedAt":"2026-07-19T18:00:00Z","source":"probe","stale":false,"detail":{}},
        {"accountId":"acct-2","scope":"week","usedPercent":null,"remainingPercent":null,"resetsAt":null,"observedAt":"2026-07-19T18:00:00Z","source":"probe","stale":true,"detail":{}}
      ],
      "projects": [],
      "launches": []
    }
    """#

    @Test func decodesHealth() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: healthJSON)])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let health = try await client.health()
        #expect(health.ok)
        #expect(health.name == "ModelDeck")
        #expect(transport.requests.first?.url?.path == "/api/health")
    }

    @Test func decodesStateWithNullsAndExtraKeys() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: stateJSON)])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let state = try await client.state()
        #expect(state.accounts.count == 2)
        #expect(state.usage.count == 2)
        #expect(state.usage[0].remainingPercent == 18.5)
        #expect(state.usage[1].remainingPercent == nil)
        #expect(state.usage[1].stale)
        #expect(transport.requests.first?.url?.path == "/api/state")
    }

    @Test func non200WithErrorBodySurfacesDaemonMessage() async {
        let transport = StubTransport(stubs: [.init(status: 403, body: #"{"error":"unexpected host header"}"#)])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        await #expect(throws: DaemonClientError.daemonError(message: "unexpected host header", status: 403)) {
            _ = try await client.health()
        }
    }

    @Test func non200WithoutErrorBodyFallsBackToHTTPStatus() async {
        let transport = StubTransport(stubs: [.init(status: 502, body: "Bad Gateway")])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        await #expect(throws: DaemonClientError.httpStatus(502)) {
            _ = try await client.health()
        }
    }

    // Issue #6 — Activate. The daemon (src/server.mjs mutationAllowed)
    // demands the /api/session token as BOTH header and cookie on POSTs.
    @Test func activateFetchesSessionThenPostsTokenAsHeaderAndCookie() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok/abc+1"}"#),
            .init(status: 200, body: #"{"account":{"id":"acct-2","provider":"codex","label":"Deck Two","enabled":true,"isDefault":true}}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let account = try await client.activateAccount(id: "acct-2")
        #expect(account.id == "acct-2")
        #expect(account.isDefault)
        #expect(transport.requests.count == 2)
        #expect(transport.requests[0].url?.path == "/api/session")
        let post = transport.requests[1]
        #expect(post.httpMethod == "POST")
        #expect(post.url?.path == "/api/accounts/acct-2/activate")
        #expect(post.value(forHTTPHeaderField: "x-modeldeck-token") == "tok/abc+1")
        // Cookie value is percent-encoded the way the server decodeURIComponent-s it.
        #expect(post.value(forHTTPHeaderField: "Cookie") == "modeldeck_session=tok%2Fabc%2B1")
    }

    @Test func activateSurfacesDaemonErrorBody() async {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-1"}"#),
            .init(status: 400, body: #"{"error":"account is disabled"}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        await #expect(throws: DaemonClientError.daemonError(message: "account is disabled", status: 400)) {
            _ = try await client.activateAccount(id: "acct-9")
        }
    }

    // MARK: Issue #7 — settings, tools, account edit/remove

    private let settingsJSON = #"""
    {"autoRefreshEnabled":false,"autoRefreshIntervalSeconds":600,"pauseWhileActive":true,
     "layout":"single-column","defaultSort":"lowest-remaining","notificationThresholdPercent":20,
     "menuBarStyle":"icon-only"}
    """#

    @Test func decodesSettingsAndFillsMissingKeysWithDefaults() async throws {
        // Partial body: unknown + missing keys must both be tolerated.
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"layout":"single-column","futureKey":true}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let settings = try await client.settings()
        #expect(settings.layout == "single-column")
        #expect(settings.autoRefreshEnabled == DaemonSettings.defaults.autoRefreshEnabled)
        #expect(settings.notificationThresholdPercent == 25)
        #expect(transport.requests.first?.url?.path == "/api/settings")
        #expect(transport.requests.first?.httpMethod == "GET")
    }

    @Test func saveSettingsPutsTokenGatedPartialPatch() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-1"}"#),
            .init(status: 200, body: settingsJSON),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let merged = try await client.saveSettings(DaemonSettingsPatch(autoRefreshIntervalSeconds: 600))
        #expect(merged.autoRefreshIntervalSeconds == 600)
        #expect(merged.deckLayout == .singleColumn)
        #expect(merged.deckSortOrder == .lowestRemaining)
        let put = transport.requests[1]
        #expect(put.httpMethod == "PUT")
        #expect(put.url?.path == "/api/settings")
        #expect(put.value(forHTTPHeaderField: "x-modeldeck-token") == "tok-1")
        #expect(put.value(forHTTPHeaderField: "Cookie") == "modeldeck_session=tok-1")
        // Only the patched key goes over the wire — daemon merge semantics.
        let body = try JSONSerialization.jsonObject(with: put.httpBody ?? Data()) as? [String: Any]
        #expect(body?.count == 1)
        #expect(body?["autoRefreshIntervalSeconds"] as? Int == 600)
    }

    private let toolsJSON = #"""
    {"tools":{
      "claude":{"installed":true,"version":"2.1.0","latestVersion":"2.2.0","updateAvailable":true,"authState":"ok","error":null,"checkedAt":"2026-07-19T18:00:00Z"},
      "codex":{"installed":false,"version":null,"latestVersion":"1.0.0","updateAvailable":null,"authState":"signin-required","error":"codex is not installed","checkedAt":"2026-07-19T18:00:00Z"}
    },"checkedAt":"2026-07-19T18:00:00Z"}
    """#

    @Test func cachedToolsReadNeedsNoToken() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: toolsJSON)])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let probe = try await client.tools(refresh: false)
        #expect(transport.requests.count == 1)
        #expect(transport.requests[0].url?.path == "/api/tools")
        #expect(transport.requests[0].value(forHTTPHeaderField: "x-modeldeck-token") == nil)
        #expect(probe.tools.claude.updateAvailable == true)
        #expect(probe.tools.claude.healthChip == .healthy)
        #expect(probe.tools.codex.healthChip == .signInAgain)
        #expect(probe.tools.codex.versionSummary == "Not installed")
    }

    @Test func toolsRefreshCarriesTokenHeaderCookieAndQuery() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-2"}"#),
            .init(status: 200, body: toolsJSON),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        _ = try await client.tools(refresh: true)
        let request = transport.requests[1]
        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/api/tools")
        #expect(request.url?.query == "refresh=1")
        #expect(request.value(forHTTPHeaderField: "x-modeldeck-token") == "tok-2")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "modeldeck_session=tok-2")
    }

    @Test func saveAccountPostsEditPayload() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-3"}"#),
            .init(status: 201, body: ##"{"account":{"id":"acct-1","provider":"claude","label":"Renamed","purpose":"docs","color":"#112233","profileRef":"profile-1","enabled":true,"isDefault":true}}"##),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let edit = AccountEdit(
            id: "acct-1", provider: "claude", profileRef: "profile-1",
            label: "Renamed", purpose: "docs", color: "#112233"
        )
        let account = try await client.saveAccount(edit)
        #expect(account.label == "Renamed")
        let post = transport.requests[1]
        #expect(post.httpMethod == "POST")
        #expect(post.url?.path == "/api/accounts")
        let body = try JSONSerialization.jsonObject(with: post.httpBody ?? Data()) as? [String: Any]
        #expect(body?["id"] as? String == "acct-1")
        #expect(body?["profileRef"] as? String == "profile-1")
        #expect(body?["label"] as? String == "Renamed")
        #expect(body?["purpose"] as? String == "docs")
        #expect(body?["color"] as? String == "#112233")
        // Never sends identity/metadata/isDefault — the daemon preserves them.
        #expect(body?["identity"] == nil)
        #expect(body?["isDefault"] == nil)
    }

    @Test func accountEditRequiresProfileRef() {
        let bare = DeckAccount(id: "a", provider: "claude", label: "L")
        #expect(AccountEdit(account: bare, label: "X", purpose: "", color: nil) == nil)
        let full = DeckAccount(id: "a", provider: "claude", label: "L", profileRef: "p")
        #expect(AccountEdit(account: full, label: "X", purpose: "", color: nil) != nil)
    }

    @Test func deleteAccountSendsTokenGatedDelete() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"tok-4"}"#),
            .init(status: 200, body: #"{"deleted":true}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        try await client.deleteAccount(id: "acct-2")
        let request = transport.requests[1]
        #expect(request.httpMethod == "DELETE")
        #expect(request.url?.path == "/api/accounts/acct-2")
        #expect(request.value(forHTTPHeaderField: "x-modeldeck-token") == "tok-4")
        #expect(request.value(forHTTPHeaderField: "Cookie")?.contains("modeldeck_session=tok-4") == true)
    }

    @Test func clientSideEvaluatorComputesWorstFromState() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: stateJSON)])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let evaluator = ClientSideUsageEvaluator(client: client)
        let worst = try await evaluator.evaluateWorstRemaining()
        #expect(worst?.accountId == "acct-1")
        #expect(worst?.percent == 18.5)
        #expect(worst?.scope == "5h")
    }
}
