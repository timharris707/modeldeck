import Foundation

// Issue #677 (the deck half of #676).
//
// The daemon moves `~/.codex-profiles/<name>` under ModelDeck's own data
// directory. On Tim's machine that move has never run: ChatGPT, a Codex CLI
// session and stale helpers hold the old folder open, so the daemon defers
// and retries roughly every ten minutes. Before this issue the only trace was
// the sentence in `/api/health.warning`, which read like a repair nobody can
// perform ("close Codex sessions and retry at next start" is not achievable
// with ChatGPT open). The deck now says what is holding it, in plain words,
// and offers to run the move on demand.

/// `/api/state.codexProfilesMigration`. Absent when nothing needed moving.
public struct CodexProfilesMigration: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        /// The move is pending because processes hold the old folder open.
        case deferred
        /// The move happened. The daemon reports this for the rest of its
        /// lifetime, so the deck stays quiet rather than repeating it.
        case done
    }

    public var status: Status
    /// Executable basenames of the processes holding the old folder open.
    /// De-duplicated daemon-side, no promised order, possibly empty.
    public var holders: [String]
    public var since: String?
    public var movedAt: String?

    public init(
        status: Status,
        holders: [String] = [],
        since: String? = nil,
        movedAt: String? = nil
    ) {
        self.status = status
        self.holders = holders
        self.since = since
        self.movedAt = movedAt
    }

    private enum CodingKeys: String, CodingKey { case status, holders, since, movedAt }

    /// Strict on `status`, lenient on everything else. A status this build
    /// does not know throws here, and `DeckState`'s `try?` turns that into
    /// "nothing to report" instead of failing the whole state decode. A
    /// missing `holders` reads as empty, which has its own sentence.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.status = try container.decode(Status.self, forKey: .status)
        self.holders = (try? container.decode([String].self, forKey: .holders)) ?? []
        self.since = try? container.decodeIfPresent(String.self, forKey: .since)
        self.movedAt = try? container.decodeIfPresent(String.self, forKey: .movedAt)
    }
}

/// The daemon's answer to `POST /api/codex-profiles/migrate`.
public enum CodexProfilesMigrationOutcome: Equatable, Sendable {
    case moved
    case deferred(holders: [String])
    case notNeeded
}

/// Seam for the header line's "Move now". `DaemonClient` conforms; tests stub
/// it.
public protocol CodexProfilesMigrating: Sendable {
    func migrateCodexProfiles() async throws -> CodexProfilesMigrationOutcome
}

/// Every user-facing string for the header line, kept out of the view so the
/// copy is testable (the #675 rule).
public enum CodexProfilesMigrationCopy {
    public static let moveNowTitle = "Move now"
    public static let movingTitle = "Moving…"
    public static let movedNotice = "Codex profiles moved."
    /// Shown when the daemon could name no holder. It still knows something
    /// has the folder open; it just could not read which process.
    public static let unnamedHolders = "running Codex processes"
    /// Beyond this many names the sentence stops listing and counts.
    static let namedHolderLimit = 3

    /// "ChatGPT", "ChatGPT and codex", "A, B, and C", "A, B, C, and 2 more".
    public static func holderPhrase(_ holders: [String]) -> String {
        let named = holders.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !named.isEmpty else { return unnamedHolders }
        var parts = Array(named.prefix(namedHolderLimit))
        if named.count > namedHolderLimit {
            parts.append("\(named.count - namedHolderLimit) more")
        }
        if parts.count == 1 { return parts[0] }
        if parts.count == 2 { return "\(parts[0]) and \(parts[1])" }
        return parts.dropLast().joined(separator: ", ") + ", and " + parts[parts.count - 1]
    }

    /// The whole line: one sentence, plain words, no blame.
    public static func waitingSentence(holders: [String]) -> String {
        "Codex profile move is waiting on \(holderPhrase(holders))."
    }

    /// What a refused or failed "Move now" adds after the sentence. The line
    /// itself stays, because the move is still waiting.
    public static func failure(_ reason: String) -> String {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let short = trimmed.isEmpty ? "the daemon did not say why" : trimmed
        guard short.count > 120 else { return "Couldn't move: \(short)" }
        return "Couldn't move: \(short.prefix(119))…"
    }
}

public extension CodexProfilesMigration {
    /// Issue #677 item 6: the header line now carries this fact with an
    /// action, so the daemon's own `/api/health` sentence must not render a
    /// second, repair-shaped copy of it. Any other daemon warning is
    /// unrelated and still shows.
    ///
    /// Nothing in the app renders `/api/health.warning` today, so there was
    /// no banner to strip. This is the rule a future health-warning surface
    /// has to obey, pinned by a test so the fact cannot start appearing
    /// twice.
    static func healthWarningToShow(
        _ warning: String?,
        migration: CodexProfilesMigration?
    ) -> String? {
        guard let warning, !warning.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        guard migration != nil, isMigrationWarning(warning) else { return warning }
        return nil
    }

    /// The two shapes `src/codex-profiles-migration.mjs` can produce for this
    /// move, matched on their stable leading words.
    static func isMigrationWarning(_ warning: String) -> Bool {
        warning.hasPrefix("Codex profile move is waiting on")
            || warning.hasPrefix("Codex profiles migration failed or deferred")
    }
}
