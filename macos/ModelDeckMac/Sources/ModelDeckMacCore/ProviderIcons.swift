import AppKit

/// Official provider desktop-app icons (issue #103, Tim directive
/// 2026-07-21): Claude accounts show Claude.app's icon; Codex accounts show
/// ChatGPT.app's icon (Tim's explicit choice for the Codex mark).
///
/// The PNGs under `Resources/` are extracted from the installed apps' own
/// `.icns` (provenance in the issue #103 PR). The artwork already carries
/// the macOS squircle shape with transparent margins, so callers render it
/// as-is — no chip backing, no extra masking.
public enum ProviderIcons {
    /// Pixel sizes bundled per provider (`<baseName>-<px>.png`). 32/64/128
    /// covers the UI's 13-20 pt slots at 1x and 2x with headroom.
    public static let pixelSizes: [Int] = [32, 64, 128]

    /// Bundled resource base name for a provider's icon.
    public static func resourceBaseName(for provider: DeckProvider) -> String {
        switch provider {
        case .claude: return "provider-claude"
        case .codex: return "provider-codex"
        }
    }

    /// Multi-representation image (one rep per bundled pixel size, sharing a
    /// single point size) so AppKit picks the sharpest rep for the drawn
    /// size, retina included. `nil` only if the bundle is missing a PNG.
    public static func image(for provider: DeckProvider) -> NSImage? {
        switch provider {
        case .claude: return claudeImage
        case .codex: return codexImage
        }
    }

    // NSImage is assembled once and only ever drawn afterwards; cache one
    // per provider (same pattern as the shared CGPaths the vector marks used).
    private static let claudeImage = loadImage(for: .claude)
    private static let codexImage = loadImage(for: .codex)

    private static func loadImage(for provider: DeckProvider) -> NSImage? {
        // Issue #158: NEVER Bundle.module here — its plain-`swift build`
        // accessor only checks the app root and a baked builder path, and
        // traps when both miss (the v0.3.3/v0.3.4 field crash). The
        // explicit resolver checks Contents/Resources first and degrades
        // to nil (callers keep their fallback glyphs) instead of trapping.
        guard let bundle = CoreResourceBundle.bundle else { return nil }
        let base = resourceBaseName(for: provider)
        // Shared point size; drawing scales it anyway. 16 keeps 1 pt = 2-8 px.
        let pointSize = NSSize(width: 16, height: 16)
        let image = NSImage(size: pointSize)
        for pixels in pixelSizes {
            guard let url = bundle.url(forResource: "\(base)-\(pixels)", withExtension: "png"),
                  let data = try? Data(contentsOf: url),
                  let rep = NSBitmapImageRep(data: data) else {
                return nil
            }
            rep.size = pointSize
            image.addRepresentation(rep)
        }
        return image
    }
}
