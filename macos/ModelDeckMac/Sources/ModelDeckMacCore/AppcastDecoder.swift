import Foundation

// Issue #685 — one feed decides whether an update exists. Discovery used to
// read the GitHub API while Sparkle installed from the appcast, and the two
// could disagree. The app now reads the same appcast Sparkle installs from;
// this is the small Foundation-only decoder behind that read.

/// One `<item>` of the Sparkle appcast, as the app needs it.
public struct AppcastItem: Equatable, Sendable {
    /// `sparkle:shortVersionString` — the marketing version ("1.1.13").
    public var shortVersionString: String
    /// `<description>` — the release notes, raw markdown (issue #685 embeds
    /// `docs/release-notes/<version>.md` verbatim). nil on an appcast built
    /// before #685, which the app treats as "no notes", never as an error.
    public var description: String?
    /// `sparkle:releaseNotesLink` — the release page on GitHub.
    public var releaseNotesLink: URL?
    /// `<enclosure url="…">` — the DMG Sparkle downloads.
    public var enclosureURL: URL?
    /// `sparkle:minimumSystemVersion` — the oldest macOS the item installs
    /// on ("14.0"). nil when the feed carries none: no floor, runs anywhere.
    public var minimumSystemVersion: String?

    public init(
        shortVersionString: String,
        description: String? = nil,
        releaseNotesLink: URL? = nil,
        enclosureURL: URL? = nil,
        minimumSystemVersion: String? = nil
    ) {
        self.shortVersionString = shortVersionString
        self.description = description
        self.releaseNotesLink = releaseNotesLink
        self.enclosureURL = enclosureURL
        self.minimumSystemVersion = minimumSystemVersion
    }

    /// Whether Sparkle would install this item on `system` (CodeRabbit,
    /// PR #686): an item whose `minimumSystemVersion` is above the running
    /// macOS is one Sparkle rejects at install time, so offering it as
    /// "Update Now" would end in a visible failure. A missing or unreadable
    /// floor means eligible — the app must never hide a release over a
    /// field it cannot read.
    public func isEligible(on system: OperatingSystemVersion) -> Bool {
        guard let floor = Self.parsedFloor(minimumSystemVersion) else { return true }
        let running = [system.majorVersion, system.minorVersion, system.patchVersion]
        for index in 0..<3 where floor[index] != running[index] {
            return running[index] > floor[index]
        }
        return true
    }

    /// A readable floor: one to three NON-EMPTY unsigned integer components
    /// ("14", "14.0", "14.0.1"), padded to three. Anything else is nil —
    /// unreadable, so eligible. Astra review (PR #686): a plain `split`
    /// drops empty components, which turned "14..1" into 14.1.0 and ".15"
    /// into 15.0.0 — real floors that hid releases Sparkle itself would
    /// install. Four or more components ("14.0.1.2") are also unreadable:
    /// Sparkle treats extra components as significant, so truncating to
    /// three could invent a floor it would not apply; eligible is the
    /// side that never hides a release.
    static func parsedFloor(_ raw: String?) -> [Int]? {
        guard let raw else { return nil }
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        var floor: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.allSatisfy(\.isNumber), let value = Int(part) else { return nil }
            floor.append(value)
        }
        return floor + Array(repeating: 0, count: 3 - floor.count)
    }
}

/// Decodes a Sparkle appcast (RSS 2.0 with the sparkle namespace) with
/// Foundation's XMLParser — no third-party parser, no Sparkle in Core.
public enum AppcastDecoder {
    public enum DecodeError: Error, Equatable, Sendable {
        /// Not an appcast: unparseable XML, or XML with no `<channel>`.
        case notAnAppcast
    }

    /// Every item carrying a version, in document order. Items without a
    /// `sparkle:shortVersionString` are skipped — the app has nothing to
    /// compare them against. An empty channel decodes as `[]`.
    public static func items(from data: Data) throws -> [AppcastItem] {
        let parser = XMLParser(data: data)
        let collector = Collector()
        parser.delegate = collector
        guard parser.parse(), collector.sawChannel else {
            throw DecodeError.notAnAppcast
        }
        return collector.items
    }

    /// The newest item by version that THIS Mac can install (the appcast is
    /// single-item today, but a multi-item feed must still answer with its
    /// newest eligible one). Items whose `minimumSystemVersion` is above
    /// `runningSystem` are skipped — Sparkle would refuse them, so they are
    /// not an update for this Mac. nil when nothing remains: an empty
    /// channel, or a feed whose every item needs a newer macOS.
    public static func newestItem(
        from data: Data,
        runningSystem: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion
    ) throws -> AppcastItem? {
        try items(from: data)
            .filter { $0.isEligible(on: runningSystem) }
            .max { lhs, rhs in
                AppVersion.isNewer(rhs.shortVersionString, than: lhs.shortVersionString)
            }
    }

    /// XMLParser's delegate must be an NSObject. Namespace processing stays
    /// off, so element names arrive qualified ("sparkle:version"); matching
    /// on the local part keeps a differently-prefixed feed decodable.
    private final class Collector: NSObject, XMLParserDelegate {
        var items: [AppcastItem] = []
        var sawChannel = false

        private var inItem = false
        private var text = ""
        private var version: String?
        private var notes: String?
        private var releaseNotesLink: String?
        private var enclosureURL: String?
        private var minimumSystemVersion: String?

        private static func localName(_ qualified: String) -> String {
            qualified.split(separator: ":").last.map(String.init) ?? qualified
        }

        func parser(
            _ parser: XMLParser,
            didStartElement elementName: String,
            namespaceURI: String?,
            qualifiedName: String?,
            attributes: [String: String]
        ) {
            switch Self.localName(elementName) {
            case "channel":
                sawChannel = true
            case "item":
                inItem = true
                version = nil
                notes = nil
                releaseNotesLink = nil
                enclosureURL = nil
                minimumSystemVersion = nil
            case "enclosure" where inItem:
                enclosureURL = attributes["url"]
            default:
                break
            }
            text = ""
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            text += string
        }

        func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
            text += String(decoding: CDATABlock, as: UTF8.self)
        }

        func parser(
            _ parser: XMLParser,
            didEndElement elementName: String,
            namespaceURI: String?,
            qualifiedName: String?
        ) {
            guard inItem else { return }
            switch Self.localName(elementName) {
            case "shortVersionString":
                version = text.trimmingCharacters(in: .whitespacesAndNewlines)
            case "description":
                notes = text
            case "releaseNotesLink":
                releaseNotesLink = text.trimmingCharacters(in: .whitespacesAndNewlines)
            case "minimumSystemVersion":
                minimumSystemVersion = text.trimmingCharacters(in: .whitespacesAndNewlines)
            case "item":
                inItem = false
                if let version, !version.isEmpty {
                    items.append(AppcastItem(
                        shortVersionString: version,
                        description: notes,
                        releaseNotesLink: releaseNotesLink.flatMap(URL.init(string:)),
                        enclosureURL: enclosureURL.flatMap(URL.init(string:)),
                        minimumSystemVersion: minimumSystemVersion
                    ))
                }
            default:
                break
            }
            text = ""
        }
    }
}
