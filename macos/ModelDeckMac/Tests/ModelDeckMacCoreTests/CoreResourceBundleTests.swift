import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #158 (escalation of #151, public report modeldeck#1): plain
// `swift build`'s generated Bundle.module accessor checks only the app
// ROOT and a hardcoded builder .build path — never Contents/Resources,
// where the release stages the bundle. Every install resolved provider
// icons through the baked builder path and trapped wherever it did not
// exist. CoreResourceBundle is the explicit, non-trapping replacement;
// these tests pin its contract.
@Suite("CoreResourceBundle resolver (issue #158)")
struct CoreResourceBundleTests {
    /// release-dmg.sh's release gate asserts the staged bundle path ends in
    /// exactly this name; pin the Swift-side constant so script and
    /// resolver cannot drift apart silently.
    @Test func bundleFileNameMatchesTheSwiftPMGeneratedName() {
        #expect(CoreResourceBundle.bundleFileName == "ModelDeckMac_ModelDeckMacCore.bundle")
    }

    /// The shipped-app scenario: the bundle sits in a fixture
    /// Contents/Resources directory (the ONLY location an install may
    /// depend on) and the resolver finds it there — with no help from
    /// Bundle.module or any builder path.
    @Test func resolvesFromAFixtureAppLayout() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("CoreResourceBundleTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }
        let resources = root.appendingPathComponent("Fixture.app/Contents/Resources", isDirectory: true)
        try fileManager.createDirectory(at: resources, withIntermediateDirectories: true)
        // The real bundle (valid under swift test) is the fixture payload,
        // so the test also proves the STAGED artifact shape resolves.
        let staged = resources.appendingPathComponent(CoreResourceBundle.bundleFileName, isDirectory: true)
        try fileManager.copyItem(at: Bundle.module.bundleURL, to: staged)

        let bundle = try #require(CoreResourceBundle.resolve(searching: [resources]),
                                  "resolver should find the bundle staged in a fixture Contents/Resources")
        #expect(bundle.bundleURL.standardizedFileURL == staged.standardizedFileURL,
                "resolver should return the fixture-staged bundle, not some other location")
        // And it actually serves the artwork the app draws.
        #expect(bundle.url(forResource: "provider-claude-32", withExtension: "png") != nil)
    }

    /// Priority: the first directory containing a loadable bundle wins, so
    /// a packaged app can never be shadowed by a later dev-build candidate.
    @Test func earlierCandidateDirectoryWins() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("CoreResourceBundleTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }
        let first = root.appendingPathComponent("first", isDirectory: true)
        let second = root.appendingPathComponent("second", isDirectory: true)
        for dir in [first, second] {
            try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
            try fileManager.copyItem(
                at: Bundle.module.bundleURL,
                to: dir.appendingPathComponent(CoreResourceBundle.bundleFileName, isDirectory: true))
        }
        let bundle = try #require(CoreResourceBundle.resolve(searching: [first, second]))
        #expect(bundle.bundleURL.standardizedFileURL
                == first.appendingPathComponent(CoreResourceBundle.bundleFileName).standardizedFileURL)
    }

    /// The crash scenario made safe: nothing resolvable anywhere must mean
    /// nil — reaching the assertion at all proves no trap. (Pre-fix, the
    /// equivalent Bundle.module miss was a fatalError/SIGTRAP.)
    @Test func degradesToNilWhenNoCandidateExists() throws {
        let fileManager = FileManager.default
        let empty = fileManager.temporaryDirectory
            .appendingPathComponent("CoreResourceBundleTests-empty-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: empty, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: empty) }
        let missing = empty.appendingPathComponent("does-not-exist", isDirectory: true)
        // A plain FILE at the bundle path must not fool the resolver either.
        let decoy = empty.appendingPathComponent("decoy", isDirectory: true)
        try fileManager.createDirectory(at: decoy, withIntermediateDirectories: true)
        try Data().write(to: decoy.appendingPathComponent(CoreResourceBundle.bundleFileName))

        #expect(CoreResourceBundle.resolve(searching: [empty, missing, decoy]) == nil,
                "no candidate -> nil, never a trap")
    }

    /// Dev builds keep working: under swift test the default candidate
    /// directories include the build products directory (via the linked
    /// test bundle's parent), so the shared resolved bundle exists and is
    /// the core target's own resource bundle.
    @Test func devBuildResolvesViaDefaultCandidates() throws {
        // Resolve through the default candidates DIRECTLY — the shared
        // `CoreResourceBundle.bundle` could also succeed via the guarded
        // Bundle.module dev fallback, which would mask a candidate-list
        // regression (CodeRabbit, PR #159).
        let bundle = try #require(
            CoreResourceBundle.resolve(searching: CoreResourceBundle.defaultCandidateDirectories()),
            "default candidate directories should find the resource bundle in a dev (swift test) build")
        #expect(bundle.bundleURL.lastPathComponent == CoreResourceBundle.bundleFileName)
        for provider in DeckProvider.allCases {
            let base = ProviderIcons.resourceBaseName(for: provider)
            for pixels in ProviderIcons.pixelSizes {
                #expect(bundle.url(forResource: "\(base)-\(pixels)", withExtension: "png") != nil,
                        "\(base)-\(pixels).png missing from the resolved bundle")
            }
        }
    }

    /// End-to-end through the consumer: every provider image loads via the
    /// resolver (ProviderIcons no longer touches Bundle.module).
    @Test func providerIconsLoadThroughTheResolver() {
        for provider in DeckProvider.allCases {
            #expect(ProviderIcons.image(for: provider) != nil,
                    "\(provider) icon should load through CoreResourceBundle")
        }
    }
}
