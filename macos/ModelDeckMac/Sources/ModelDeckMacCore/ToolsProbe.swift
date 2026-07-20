import Foundation

// Typed mirror of `GET /api/tools` (src/service.mjs probeTools) — the cached
// CLI tool probe: installed vs. latest version, update availability, and auth
// state for the Claude Code and Codex CLIs. The same probe feeds the Settings
// window's CLI tools section and the Accounts pane's health chips.

/// One CLI tool's probe result.
public struct ToolProbe: Codable, Equatable, Sendable {
    public var installed: Bool
    public var version: String?
    public var latestVersion: String?
    public var updateAvailable: Bool?
    public var authState: String?
    public var error: String?
    public var checkedAt: String?

    public init(
        installed: Bool,
        version: String? = nil,
        latestVersion: String? = nil,
        updateAvailable: Bool? = nil,
        authState: String? = nil,
        error: String? = nil,
        checkedAt: String? = nil
    ) {
        self.installed = installed
        self.version = version
        self.latestVersion = latestVersion
        self.updateAvailable = updateAvailable
        self.authState = authState
        self.error = error
        self.checkedAt = checkedAt
    }

    /// Health chip per the spec's Accounts pane: "Healthy" / "Sign in again"
    /// (plus an honest "Unknown" when the probe couldn't tell).
    public enum HealthChip: Equatable, Sendable {
        case healthy
        case signInAgain
        case unknown

        public var text: String {
            switch self {
            case .healthy: return "Healthy"
            case .signInAgain: return "Sign in again"
            case .unknown: return "Unknown"
            }
        }
    }

    /// Maps the daemon's auth states (src/service.mjs: "ok" /
    /// "signin-required" / "unknown") onto the chip.
    public var healthChip: HealthChip {
        switch authState {
        case "ok": return .healthy
        case "signin-required": return .signInAgain
        default: return .unknown
        }
    }

    /// "1.2.3 (latest 1.3.0)" style summary; "Not installed" when missing.
    public var versionSummary: String {
        guard installed, let version else { return "Not installed" }
        if let latestVersion, updateAvailable == true {
            return "\(version) — update available (\(latestVersion))"
        }
        if latestVersion != nil {
            return "\(version) — up to date"
        }
        return version
    }
}

/// `GET /api/tools` response envelope.
public struct ToolsProbeResponse: Codable, Equatable, Sendable {
    public struct Tools: Codable, Equatable, Sendable {
        public var claude: ToolProbe
        public var codex: ToolProbe

        public init(claude: ToolProbe, codex: ToolProbe) {
            self.claude = claude
            self.codex = codex
        }
    }

    public var tools: Tools
    public var checkedAt: String?

    public init(tools: Tools, checkedAt: String? = nil) {
        self.tools = tools
        self.checkedAt = checkedAt
    }

    /// Probe for a deck provider (feeds per-account health chips).
    public func probe(for provider: DeckProvider) -> ToolProbe {
        switch provider {
        case .claude: return tools.claude
        case .codex: return tools.codex
        }
    }
}

/// `POST /api/tools/{claude|codex}/update` outcome (issue #31 backend). The
/// daemon runs the CLI's own updater (npm/Homebrew), single-flighted, and
/// reports both versions plus the tail of the updater's output. `ok: false`
/// with HTTP 500 means the updater ran and failed; HTTP 409 (install method
/// not auto-updatable) arrives as the daemon's standard `{"error": …}` body
/// instead of this shape.
public struct ToolUpdateResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var previousVersion: String?
    public var newVersion: String?
    public var outputTail: String?

    private enum CodingKeys: String, CodingKey {
        case ok
        case previousVersion
        case newVersion
        case outputTail = "output-tail"
    }

    public init(ok: Bool, previousVersion: String? = nil, newVersion: String? = nil, outputTail: String? = nil) {
        self.ok = ok
        self.previousVersion = previousVersion
        self.newVersion = newVersion
        self.outputTail = outputTail
    }

    /// Honest one-line failure summary: the last non-empty output line the
    /// updater printed, or a generic fallback when it printed nothing.
    public var failureSummary: String {
        let lines = (outputTail ?? "")
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return lines.last ?? "The update failed without any output."
    }
}
