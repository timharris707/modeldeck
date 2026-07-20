import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Where the local daemon lives. Localhost only, by design — the app is a
/// pure client of the Node daemon's loopback API.
public struct DaemonConfiguration: Equatable, Sendable {
    public static let defaultPort = 3867 // src/paths.mjs MODELDECK_PORT default

    public var host: String
    public var port: Int

    public init(host: String = "127.0.0.1", port: Int = DaemonConfiguration.defaultPort) {
        self.host = host
        self.port = port
    }

    /// Resolve the port the same way the daemon does: `MODELDECK_PORT` from
    /// the environment, else a user default, else 3867. Host is never
    /// configurable — 127.0.0.1 always.
    public static func resolved(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> DaemonConfiguration {
        if let raw = environment["MODELDECK_PORT"], let port = Int(raw), (1...65535).contains(port) {
            return DaemonConfiguration(port: port)
        }
        let stored = defaults.integer(forKey: "modeldeck.daemon.port")
        if (1...65535).contains(stored) {
            return DaemonConfiguration(port: stored)
        }
        return DaemonConfiguration()
    }

    public var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }
}

/// Minimal transport seam so tests can stub HTTP without a live daemon.
public protocol HTTPDataTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPDataTransport {}

public enum DaemonClientError: Error, Equatable, Sendable {
    case invalidResponse
    case httpStatus(Int)
    /// A non-2xx response whose body carried the daemon's `{"error": …}` shape.
    case daemonError(message: String, status: Int)
    /// A non-2xx response whose body carried BOTH `error` and a
    /// machine-readable `code` (issue #55: the activation clobber-guard
    /// refusal ships `code: "active-link-blocked"` so the UI can render the
    /// daemon's guidance prominently rather than as a generic failure).
    case daemonCodedError(message: String, code: String, status: Int)
}

public extension DaemonClientError {
    /// The activation clobber-guard's machine-readable refusal code.
    static let activeLinkBlockedCode = "active-link-blocked"
}

extension DaemonClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The daemon returned an unreadable response."
        case .httpStatus(let code):
            return "The daemon returned HTTP \(code)."
        case .daemonError(let message, _):
            return message
        case .daemonCodedError(let message, _, _):
            return message
        }
    }
}

/// `GET /api/session` — the daemon's mutation token. Held in memory only and
/// echoed back on POSTs (header + cookie); never persisted by the app. The
/// durable copy lives in the daemon's own Keychain entry (src/token.mjs).
public struct DaemonSession: Codable, Equatable, Sendable {
    public var token: String

    public init(token: String) {
        self.token = token
    }
}

/// Seam for the popover's Activate action; `DaemonClient` conforms and
/// tests stub it.
public protocol AccountActivating: Sendable {
    /// Switch the account's provider to use it for **new sessions only**
    /// (the daemon guarantees running sessions are untouched). Returns the
    /// daemon's post-switch view of the account.
    func activateAccount(id: String) async throws -> DeckAccount
}

/// Small typed HTTP client for the local ModelDeck daemon. GET-only in
/// Phase 3 — reading cached daemon state never triggers provider polling.
public struct DaemonClient: Sendable {
    public let configuration: DaemonConfiguration
    private let transport: any HTTPDataTransport

    public init(
        configuration: DaemonConfiguration = .resolved(),
        transport: any HTTPDataTransport = URLSession.shared
    ) {
        self.configuration = configuration
        self.transport = transport
    }

    /// `GET /api/health`
    public func health() async throws -> DaemonHealth {
        try await get("/api/health")
    }

    /// `GET /api/state` — accounts + latest usage snapshots.
    public func state() async throws -> DeckState {
        try await get("/api/state")
    }

    /// `GET /api/capacity/worst` — the daemon's own worst-remaining
    /// evaluation (issue #45: primary source for the menu bar icon).
    public func worstCapacity() async throws -> CapacityWorstReport {
        try await get("/api/capacity/worst")
    }

    /// `GET /api/session` — fetches the daemon's mutation token. The server
    /// requires the same token as BOTH the `x-modeldeck-token` header and the
    /// `modeldeck_session` cookie on every non-GET request (`mutationAllowed`
    /// in src/server.mjs), so POST calls fetch this first and echo it back
    /// both ways. The token is never stored anywhere by the app.
    public func session() async throws -> DaemonSession {
        try await get("/api/session")
    }

    /// `POST /api/accounts/:id/activate` — switch the account's provider to
    /// it for new sessions only. Acquires a fresh session token per call so a
    /// daemon restart (which rotates ephemeral tokens) never strands us with
    /// a stale credential.
    public func activateAccount(id: String) async throws -> DeckAccount {
        struct Envelope: Decodable { var account: DeckAccount }
        let request = try await authorizedRequest(
            method: "POST",
            pathComponents: ["api", "accounts", id, "activate"]
        )
        let envelope: Envelope = try await send(request)
        return envelope.account
    }

    // MARK: - Settings (issue #7)

    /// `GET /api/settings` — the daemon's full settings document with typed
    /// defaults filled in server-side.
    public func settings() async throws -> DaemonSettings {
        try await get("/api/settings")
    }

    /// `PUT /api/settings` — token-gated partial update. The daemon validates
    /// each key, merges with the stored document, and returns the merged
    /// result, which becomes the client's authoritative copy.
    public func saveSettings(_ patch: DaemonSettingsPatch) async throws -> DaemonSettings {
        var request = try await authorizedRequest(
            method: "PUT",
            pathComponents: ["api", "settings"]
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(patch)
        return try await send(request)
    }

    // MARK: - CLI tools (issue #7)

    /// `GET /api/tools` — cached CLI probe (installed/latest/auth state).
    /// `refresh: true` adds `?refresh=1`, which the daemon gates behind the
    /// mutation token (it forces process spawns + a registry fetch), so that
    /// variant runs through the same token+cookie flow as mutations.
    public func tools(refresh: Bool = false) async throws -> ToolsProbeResponse {
        guard refresh else { return try await get("/api/tools") }
        var request = try await authorizedRequest(
            method: "GET",
            pathComponents: ["api", "tools"],
            queryItems: [URLQueryItem(name: "refresh", value: "1")]
        )
        // The forced probe spawns CLI processes and hits the npm registry;
        // give it more room than the instant cached reads.
        request.timeoutInterval = 30
        return try await send(request)
    }

    // MARK: - CLI updates (issue #32)

    /// `POST /api/tools/{claude|codex}/update` — runs the CLI's own updater
    /// via the daemon (token-gated like every mutation; concurrent calls
    /// coalesce server-side). The daemon answers with the outcome shape on
    /// both success (200) and updater failure (500, `ok: false`), so both
    /// decode to a `ToolUpdateResult`; a 409 ("install method can't be
    /// auto-updated") or a missing endpoint (older daemon) surfaces as the
    /// standard daemon error.
    public func updateTool(_ tool: String) async throws -> ToolUpdateResult {
        var request = try await authorizedRequest(
            method: "POST",
            pathComponents: ["api", "tools", tool, "update"]
        )
        // npm/Homebrew updates can legitimately take minutes (the daemon's
        // own updater timeout is 10 minutes).
        request.timeoutInterval = 620
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DaemonClientError.invalidResponse
        }
        if let outcome = try? JSONDecoder().decode(ToolUpdateResult.self, from: data),
           (200..<300).contains(http.statusCode) || http.statusCode == 500 {
            return outcome
        }
        if let body = try? JSONDecoder().decode(DaemonErrorBody.self, from: data) {
            throw body.clientError(status: http.statusCode)
        }
        if (200..<300).contains(http.statusCode) {
            throw DaemonClientError.invalidResponse
        }
        throw DaemonClientError.httpStatus(http.statusCode)
    }

    // MARK: - Account editing (issue #7)

    /// `POST /api/accounts` — upsert. With an existing account's `id` and
    /// `profileRef` this edits label / purpose / color in place (the daemon's
    /// saveAccount preserves identity/metadata when they are omitted and
    /// never changes the default flag).
    public func saveAccount(_ edit: AccountEdit) async throws -> DeckAccount {
        struct Envelope: Decodable { var account: DeckAccount }
        var request = try await authorizedRequest(
            method: "POST",
            pathComponents: ["api", "accounts"]
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(edit)
        let envelope: Envelope = try await send(request)
        return envelope.account
    }

    /// `DELETE /api/accounts/:id` — removes only ModelDeck's reference to the
    /// account; provider credentials are never touched (spec "Remove
    /// account"). The confirmation dialog lives in the UI layer.
    public func deleteAccount(id: String) async throws {
        struct Envelope: Decodable { var deleted: Bool }
        let request = try await authorizedRequest(
            method: "DELETE",
            pathComponents: ["api", "accounts", id]
        )
        let _: Envelope = try await send(request)
    }

    // MARK: - Add-account flow (issue #8)

    /// `POST /api/accounts` with no profileRef — the daemon creates the
    /// isolated owner-only profile home (step 1) and returns the new account.
    public func createAccount(_ create: AccountCreate) async throws -> DeckAccount {
        struct Envelope: Decodable { var account: DeckAccount }
        var request = try await authorizedRequest(
            method: "POST",
            pathComponents: ["api", "accounts"]
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(create)
        let envelope: Envelope = try await send(request)
        return envelope.account
    }

    /// `GET /api/accounts/:id/login` — the provider's own login command for
    /// step 2. Read-only; running it is the app layer's job (in the user's
    /// terminal, never inside the daemon).
    public func loginCommand(accountID: String) async throws -> LoginCommand {
        var url = configuration.baseURL
        for component in ["api", "accounts", accountID, "login"] {
            url.appendPathComponent(component)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await send(request)
    }

    /// `POST /api/accounts/:id/verify` — step 3: the daemon runs the
    /// provider's status command (never a login or logout — the HANDOFF
    /// pitfall) and reports the authenticated identity.
    public func verifyAccount(accountID: String) async throws -> AccountVerification {
        var request = try await authorizedRequest(
            method: "POST",
            pathComponents: ["api", "accounts", accountID, "verify"]
        )
        // Spawns a provider CLI; allow more than the instant reads.
        request.timeoutInterval = 30
        return try await send(request)
    }

    /// `POST /api/refresh` — full usage refresh; used once after a
    /// successful verify to pull the new account's first snapshot.
    public func refreshUsage() async throws {
        struct Ack: Decodable { var checkedAt: String? }
        var request = try await authorizedRequest(
            method: "POST",
            pathComponents: ["api", "refresh"]
        )
        // Provider usage probes can be slow; this is a deliberate one-off.
        request.timeoutInterval = 60
        let _: Ack = try await send(request)
    }

    /// Builds a token-gated request: fetches a fresh `/api/session` token and
    /// echoes it back as BOTH the `x-modeldeck-token` header and the
    /// `modeldeck_session` cookie (`mutationAllowed` in src/server.mjs
    /// requires both). Fresh per call so a daemon restart (which rotates
    /// ephemeral tokens) never strands us with a stale credential.
    private func authorizedRequest(
        method: String,
        pathComponents: [String],
        queryItems: [URLQueryItem] = []
    ) async throws -> URLRequest {
        let session = try await session()
        var url = configuration.baseURL
        for component in pathComponents {
            url.appendPathComponent(component)
        }
        if !queryItems.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.queryItems = queryItems
            url = components.url!
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 5
        // The manual Cookie header must be authoritative; never let the shared
        // cookie jar merge a stale modeldeck_session value in.
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(session.token, forHTTPHeaderField: "x-modeldeck-token")
        request.setValue(
            "modeldeck_session=\(Self.cookieEncoded(session.token))",
            forHTTPHeaderField: "Cookie"
        )
        return request
    }

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await send(request)
    }

    private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DaemonClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if let body = try? JSONDecoder().decode(DaemonErrorBody.self, from: data) {
                throw body.clientError(status: http.statusCode)
            }
            throw DaemonClientError.httpStatus(http.statusCode)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    /// Percent-encode a token for cookie transport the way the server
    /// decodes it (`decodeURIComponent`): only RFC 3986 unreserved
    /// characters pass through unescaped.
    static func cookieEncoded(_ value: String) -> String {
        let unreserved = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}

/// The daemon's non-2xx `{"error": …}` body shape, optionally carrying a
/// machine-readable `code` (issue #55: "active-link-blocked").
private struct DaemonErrorBody: Decodable {
    var error: String
    var code: String?

    /// The typed error for this body: coded when the daemon attached a
    /// machine-readable code, the classic message-only error otherwise.
    func clientError(status: Int) -> DaemonClientError {
        if let code, !code.isEmpty {
            return .daemonCodedError(message: error, code: code, status: status)
        }
        return .daemonError(message: error, status: status)
    }
}

extension DaemonClient: AccountActivating {}

extension DaemonClient: WorstCapacityProviding {}
