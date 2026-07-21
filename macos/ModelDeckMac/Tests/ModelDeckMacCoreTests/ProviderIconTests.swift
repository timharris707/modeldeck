import AppKit
import CryptoKit
import Testing
@testable import ModelDeckMacCore

// Issue #103: official provider desktop-app icons bundled as SwiftPM
// resources. These tests guard the provider -> resource-name mapping and
// that every declared pixel size actually ships in the bundle.
@Suite("ProviderIcons")
struct ProviderIconTests {
    @Test func resourceBaseNamesAreStable() {
        // Build scripts and the bundled PNG filenames depend on these.
        #expect(ProviderIcons.resourceBaseName(for: .claude) == "provider-claude")
        #expect(ProviderIcons.resourceBaseName(for: .codex) == "provider-codex")
    }

    @Test func iconsLoadWithEveryDeclaredPixelSize() {
        for provider in DeckProvider.allCases {
            let image = ProviderIcons.image(for: provider)
            #expect(image != nil, "\(provider) icon should load from the resource bundle")
            guard let image else { continue }
            let widths = image.representations.map(\.pixelsWide).sorted()
            #expect(widths == ProviderIcons.pixelSizes, "\(provider) should carry one rep per declared size")
            for rep in image.representations {
                #expect(rep.pixelsWide == rep.pixelsHigh, "\(provider) reps should be square")
                // The squircle artwork carries its own transparent margin;
                // losing alpha would regress to an opaque tile.
                #expect(rep.hasAlpha, "\(provider) icon must keep its alpha channel")
            }
        }
    }

    // hasAlpha alone would pass on an opaque tile that merely declares an
    // alpha channel; the app-icon squircle guarantees genuinely transparent
    // margin pixels (the corners), so require at least one.
    @Test func iconsContainFullyTransparentPixels() throws {
        for provider in DeckProvider.allCases {
            let image = try #require(ProviderIcons.image(for: provider))
            for rep in image.representations {
                let bitmap = try #require(rep as? NSBitmapImageRep)
                var foundTransparent = false
                scan: for y in 0..<bitmap.pixelsHigh {
                    for x in 0..<bitmap.pixelsWide {
                        if let color = bitmap.colorAt(x: x, y: y), color.alphaComponent == 0 {
                            foundTransparent = true
                            break scan
                        }
                    }
                }
                #expect(foundTransparent,
                        "\(provider) \(bitmap.pixelsWide)px rep should have a fully transparent margin pixel")
            }
        }
    }

    // Pin the artwork identity byte-for-byte (CodeRabbit on PR #107: the
    // structural assertions above would pass with duplicated or wrong RGBA
    // artwork). These digests are the shipped PNGs extracted from
    // Claude.app 1.24012.0 / ChatGPT.app 26.715.70719 (see issue #103);
    // regenerating the assets is expected to update them deliberately.
    private static let expectedDigests: [String: String] = [
        "provider-claude-32": "c3465ac9002332e5987b9e22b2b1a56a0984570692c72ea433b85a90feb81662",
        "provider-claude-64": "2a6272970391363092c12c23cf16bd7510dde7fd18c3603f0a5f1a5d888869dd",
        "provider-claude-128": "1f249bbb778ae928247321ef0f4b40cb4edeb8fd896e344f4c978df48f724be6",
        "provider-codex-32": "c6ca70e636afdf954a9d2ab2c8c7212f390f0d4b9fa9f98e9d654b1119bad1f3",
        "provider-codex-64": "78da8368337ce1f49cbcde8b8112864e3644ef563f777ed7677bdfee7f8725f5",
        "provider-codex-128": "fee4f7a7a68187fa61d00789751ad9f160a40ca2b0a194492cff88353a9d9c5a",
    ]

    private static func digest(ofResource name: String) throws -> String {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "png"),
                               "\(name).png missing from the resource bundle")
        let data = try Data(contentsOf: url)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    @Test func bundledArtworkMatchesRecordedDigests() throws {
        for provider in DeckProvider.allCases {
            let base = ProviderIcons.resourceBaseName(for: provider)
            for pixels in ProviderIcons.pixelSizes {
                let name = "\(base)-\(pixels)"
                let expected = try #require(Self.expectedDigests[name])
                #expect(try Self.digest(ofResource: name) == expected,
                        "\(name).png bytes drifted from the recorded artwork")
            }
        }
    }

    @Test func claudeAndCodexArtworkDiffer() throws {
        for pixels in ProviderIcons.pixelSizes {
            let claude = try Self.digest(ofResource: "provider-claude-\(pixels)")
            let codex = try Self.digest(ofResource: "provider-codex-\(pixels)")
            #expect(claude != codex, "providers must not share artwork at \(pixels)px")
        }
    }
}
