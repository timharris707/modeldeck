import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #151 (public report modeldeck#1): v0.3.3 shipped the SwiftPM
// resource bundle as loose PNGs with NO Info.plist. Newer macOS
// Bundle(url:) rejects a plist-less directory, so the generated
// Bundle.module accessor exhausted its candidate paths and trapped
// (SIGTRAP) on the first popover render (ProviderMarkView ->
// ProviderIcons.loadImage). Package.swift now declares
// defaultLocalization: "en" so SwiftPM generates the bundle's Info.plist;
// these tests pin the on-disk shape the shipped bundle must keep.
@Suite("Resource bundle shape (issue #151)")
struct ResourceBundleShapeTests {
    @Test func bundleModuleResolvesToTheCoreResourceBundle() {
        // Bundle.module itself fatalErrors when unresolvable; reaching this
        // line proves resolution, but pin the identity too so a silent
        // fallback to some other bundle cannot pass.
        let bundle = Bundle.module
        #expect(bundle.bundleURL.lastPathComponent.contains("ModelDeckMacCore"),
                "Bundle.module should be the ModelDeckMacCore resource bundle, got \(bundle.bundleURL.lastPathComponent)")
    }

    @Test func bundleCarriesAValidInfoPlistOnDisk() throws {
        // The regression: pre-fix, SwiftPM emitted loose PNGs and no plist
        // (Package.swift lacked defaultLocalization), so this file did not
        // exist and the shipped app trapped. Accept both layouts Bundle
        // accepts: flat (what SwiftPM emits) and Contents/.
        let root = Bundle.module.bundleURL
        let candidates = [
            root.appendingPathComponent("Info.plist"),
            root.appendingPathComponent("Contents/Info.plist"),
        ]
        let plistURL = candidates.first { FileManager.default.fileExists(atPath: $0.path) }
        let url = try #require(plistURL,
                               "resource bundle has NO Info.plist (flat or Contents/) — Bundle(url:) rejects it on newer macOS and Bundle.module traps (issue #151)")
        let data = try Data(contentsOf: url)
        let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        #expect(plist is [String: Any], "resource bundle Info.plist should decode to a dictionary")
    }

    @Test func bundleReinitializesFromDiskAndServesEveryProviderIcon() throws {
        // Bundle(url:) is the exact call the SwiftPM-generated accessor
        // makes per candidate path; a bundle it rejects is the v0.3.3 trap.
        let bundle = try #require(Bundle(url: Bundle.module.bundleURL),
                                  "Bundle(url:) rejected the resource bundle directory (issue #151)")
        for provider in DeckProvider.allCases {
            let base = ProviderIcons.resourceBaseName(for: provider)
            for pixels in ProviderIcons.pixelSizes {
                #expect(bundle.url(forResource: "\(base)-\(pixels)", withExtension: "png") != nil,
                        "\(base)-\(pixels).png missing from the re-opened resource bundle")
            }
        }
    }
}
