import SwiftUI

/// The ModelDeck brand mark — the site/favicon's three stacked rounded bars
/// (issue #33 amendment 2026-07-20; brand consistency app ⇄ site ⇄ favicon,
/// NOT the rocket). Geometry mirrors the site SVG: 24×5 bars, rx ≈ 2.5,
/// 3-unit vertical gaps (total 24×21 units), drawn natively — no asset file.
/// Colors are fixed (top-to-bottom blue / amber / red) and identical in
/// light and dark mode; they carry both appearances on their own.
struct ModelDeckBrandMark: View {
    /// Overall mark width in points (~14–16pt per the amendment). Bar
    /// height, gap, and corner radius all scale from the 24-unit design.
    var width: CGFloat = 15

    private static let barColors: [Color] = [
        Color(red: 0x4C / 255, green: 0x8D / 255, blue: 0xFF / 255), // #4C8DFF
        Color(red: 0xE0 / 255, green: 0xA9 / 255, blue: 0x4A / 255), // #E0A94A
        Color(red: 0xEA / 255, green: 0x5C / 255, blue: 0x50 / 255), // #EA5C50
    ]

    var body: some View {
        let unit = width / 24
        VStack(spacing: unit * 3) {
            ForEach(0..<Self.barColors.count, id: \.self) { index in
                RoundedRectangle(cornerRadius: unit * 2.5, style: .continuous)
                    .fill(Self.barColors[index])
                    .frame(width: width, height: unit * 5)
            }
        }
        .accessibilityHidden(true) // decorative — the wordmark carries the name
    }
}
