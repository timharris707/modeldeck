import Foundation
import Testing
@testable import ModelDeckMacCore

@Suite("Issue #705 beta feeds")
struct Issue705BetaFeedTests {
    @Test func semverPrereleasesOrderBeforeFinalAndNumerically() {
        let ordered = ["1.1.15", "1.2.0-alpha", "1.2.0-beta.1", "1.2.0-beta.2", "1.2.0-beta.9", "1.2.0-beta.10", "1.2.0"]
        for (index, version) in ordered.enumerated() {
            for newer in ordered.dropFirst(index + 1) {
                #expect(AppVersion.isNewer(newer, than: version))
                #expect(!AppVersion.isNewer(version, than: newer))
            }
        }
        #expect(!AppVersion.isNewer("1.2.0+2", than: "1.2.0+1"))
        #expect(AppVersion.isNewer("1.2.0-beta.a", than: "1.2.0-beta.10"))
    }

    @Test func decoderCarriesChannelBuildAndRollbackFloor() throws {
        let xml = appcastXML(version: "1.2.0-beta.1").replacingOccurrences(of: "</item>", with: "<sparkle:channel>beta</sparkle:channel><modeldeck:rollbackFloor>1.1.15</modeldeck:rollbackFloor></item>")
        let item = try #require(AppcastDecoder.items(from: Data(xml.utf8)).first)
        #expect(item.channel == "beta")
        #expect(item.build == "512")
        #expect(item.rollbackFloor == "1.1.15")
        let stable = try #require(AppcastDecoder.items(from: Data(appcastXML(version: "1.1.15").utf8)).first)
        #expect(stable.channel == nil)
        #expect(stable.rollbackFloor == nil)
    }

    /// CodeRabbit (PR #710): the beta feed admits untagged and "beta" items
    /// only. The Sparkle delegate allows exactly ["beta"], so an item on any
    /// other channel found here would be refused by the installer.
    @Test func betaModeAdmitsOnlyUntaggedAndBetaItems() throws {
        func tagged(_ version: String, _ channel: String?) -> String {
            let one = appcastXML(version: version)
            guard let channel else { return one }
            return one.replacingOccurrences(of: "</item>", with: "<sparkle:channel>\(channel)</sparkle:channel></item>")
        }
        func feed(_ items: [String]) -> Data {
            let body = items.map { xml in
                let start = xml.range(of: "<item>")!.lowerBound
                let end = xml.range(of: "</item>")!.upperBound
                return String(xml[start..<end])
            }.joined()
            return Data(("<?xml version=\"1.0\"?><rss version=\"2.0\" xmlns:sparkle=\"http://www.andymatuschak.org/xml-namespaces/sparkle\"><channel>" + body + "</channel></rss>").utf8)
        }
        let data = feed([tagged("1.3.0", "nightly"), tagged("1.2.0-beta.1", "beta"), tagged("1.1.15", nil)])
        #expect(try AppcastDecoder.newestItem(from: data, betaEnabled: true)?.shortVersionString == "1.2.0-beta.1",
                "a nightly-tagged item must never win in beta mode")
        #expect(try AppcastDecoder.newestItem(from: data, betaEnabled: false)?.shortVersionString == "1.1.15")
    }

    @Test func betaBundleKeepsItsDisplayVersionForUpdateComparisons() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bundle")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let plist = ["CFBundleIdentifier": "invalid.example.beta-version", "CFBundleShortVersionString": "1.2.0", "ModelDeckDisplayVersion": "1.2.0-beta.1"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: root.appendingPathComponent("Info.plist"))
        let bundle = try #require(Bundle(url: root))
        #expect(AppVersion.current(bundle: bundle) == "1.2.0-beta.1")
        #expect(AppVersion.isNewer("1.2.0", than: AppVersion.current(bundle: bundle)!))
    }

    @Test func policyChangesOnlyTheFeedFilename() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bundle")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let plist: [String: String] = ["CFBundleIdentifier": "invalid.example.beta-test", "SUFeedURL": "https://example.invalid/releases/appcast.xml?key=1"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: root.appendingPathComponent("Info.plist"))
        let bundle = try #require(Bundle(url: root))
        #expect(AppUpdateFeedPolicy.feedURL(betaEnabled: false, bundle: bundle).absoluteString == plist["SUFeedURL"])
        #expect(AppUpdateFeedPolicy.feedURL(betaEnabled: true, bundle: bundle).absoluteString == "https://example.invalid/releases/appcast-beta.xml?key=1")
    }

    @Test func checkerReadsThePreferenceAgainAndStableFeedRejectsChannels() async throws {
        let defaults = ScratchDefaults.make("issue-705-beta-feed")
        let beta = appcastXML(version: "1.2.0-beta.1").replacingOccurrences(of: "</item>", with: "<sparkle:channel>beta</sparkle:channel></item>")
        let stableItem = appcastXML(version: "1.1.15").components(separatedBy: "<item>")[1].components(separatedBy: "</item>")[0]
        let mixed = beta.replacingOccurrences(of: "</channel>", with: "<item>\(stableItem)</item></channel>")
        let transport = StubTransport(stubs: Array(repeating: .init(status: 200, body: mixed), count: 3))
        let checker = AppcastReleaseChecker(transport: transport, defaults: defaults)
        #expect(!defaults.bool(forKey: AppUpdateFeedPolicy.betaReleasesKey))
        #expect(try await checker.latestRelease()?.version == "1.1.15")
        defaults.set(true, forKey: AppUpdateFeedPolicy.betaReleasesKey)
        #expect(try await checker.latestRelease()?.version == "1.2.0-beta.1")
        defaults.set(false, forKey: AppUpdateFeedPolicy.betaReleasesKey)
        #expect(try await checker.latestRelease()?.version == "1.1.15")
        #expect(transport.requests.map(\.url) == [false, true, false].map { AppUpdateFeedPolicy.feedURL(betaEnabled: $0) })
        #expect(!AppVersion.isNewer("1.1.15", than: "1.2.0-beta.1"))
    }

    // Issue #705: the app target cannot be imported by Core tests. Pin both
    // adapters to the tested policy so a second URL rule cannot drift.
    @Test func checkerAndSparkleDelegateUseTheSamePolicyCall() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
        let checker = try String(contentsOf: sources.appendingPathComponent("ModelDeckMacCore/AppUpdate.swift"), encoding: .utf8)
        let driver = try String(contentsOf: sources.appendingPathComponent("ModelDeckMac/SparkleUpdateDriver.swift"), encoding: .utf8)
        let call = "AppUpdateFeedPolicy.feedURL(betaEnabled: defaults.bool(forKey: AppUpdateFeedPolicy.betaReleasesKey), bundle: bundle)"
        #expect(checker.contains(call))
        #expect(driver.contains(call))
        #expect(driver.contains("func feedURLString(for updater: SPUUpdater) -> String?"))
    }
}
