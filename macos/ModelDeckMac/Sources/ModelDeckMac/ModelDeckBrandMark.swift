import SwiftUI
import ModelDeckMacCore

/// The ModelDeck brand mark — the deck glyph's three stacked rounded bars in
/// the brand colors. Issue #53 unified the shape with the menu bar glyph:
/// staggered medium/short/long widths (the 12/8/16 top-to-bottom ratio from
/// issue #25, flush left) instead of the old equal-width favicon bars — one
/// shape, two colorways (template in the menu bar, colored here; the site
/// favicon is being updated to match). Drawn natively — no asset file.
/// Colors are fixed (top-to-bottom blue / amber / red) and identical in
/// light and dark mode; they carry both appearances on their own.
struct ModelDeckBrandMark: View {
    /// Overall mark width in points (~14–16pt per the #33 amendment) — the
    /// longest (bottom) bar spans it. Bar height, gap, and corner radius
    /// scale from the glyph's 16-unit design.
    var width: CGFloat = 15

    private static let barColors: [Color] = [
        Color(red: 0x4C / 255, green: 0x8D / 255, blue: 0xFF / 255), // #4C8DFF
        Color(red: 0xE0 / 255, green: 0xA9 / 255, blue: 0x4A / 255), // #E0A94A
        Color(red: 0xEA / 255, green: 0x5C / 255, blue: 0x50 / 255), // #EA5C50
    ]

    var body: some View {
        let unit = width / DeckGlyphGeometry.designWidth
        VStack(alignment: .leading, spacing: unit * 2) {
            ForEach(Array(DeckGlyphGeometry.barWidthsTopToBottom.enumerated()), id: \.offset) { index, barWidth in
                RoundedRectangle(cornerRadius: unit * 1.5, style: .continuous)
                    .fill(Self.barColors[index])
                    .frame(width: unit * barWidth, height: unit * 3)
            }
        }
        .frame(width: width, alignment: .leading)
        .accessibilityHidden(true) // decorative — the wordmark carries the name
    }
}
