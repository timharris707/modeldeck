import SwiftUI
import ModelDeckMacCore

/// Official provider brand mark rendered from the mockups' SVG path data:
/// Claude starburst in Anthropic clay #D97757, OpenAI knot in white
/// (spec: "Provider marks").
struct ProviderMarkShape: Shape {
    let provider: DeckProvider

    // CGPath is immutable after creation; safe to share across threads.
    nonisolated(unsafe) private static let claudePath = ProviderMarkPaths.path(for: .claude)
    nonisolated(unsafe) private static let codexPath = ProviderMarkPaths.path(for: .codex)

    func path(in rect: CGRect) -> Path {
        let cgPath: CGPath?
        switch provider {
        case .claude: cgPath = Self.claudePath
        case .codex: cgPath = Self.codexPath
        }
        guard let cgPath else { return Path() }
        let scale = min(rect.width, rect.height) / ProviderMarkPaths.viewBoxSize
        var transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: scale, y: scale)
        guard let scaled = cgPath.copy(using: &transform) else { return Path(cgPath) }
        return Path(scaled)
    }
}

/// Rounded provider chip as in the mockups' column headers and
/// single-column rows.
///
/// Codex contrast (issue #25): the knot-on-transparent-chip treatment
/// disappeared against the dark popover. The chip is now a solid
/// primary-colored tile with the knot cut in the inverse color (white
/// tile / dark knot in dark mode, dark tile / white knot in light mode)
/// — OpenAI's standard monochrome mark, matching the visual weight of
/// the clay Claude mark.
struct ProviderMarkView: View {
    let provider: DeckProvider
    var size: CGFloat = 20

    @Environment(\.colorScheme) private var colorScheme

    static let claudeClay = Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255)

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(chipColor)
            .frame(width: size, height: size)
            .overlay {
                ProviderMarkShape(provider: provider)
                    .fill(markColor, style: FillStyle(eoFill: false))
                    .frame(width: size * 0.6, height: size * 0.6)
            }
            .accessibilityLabel(provider.displayName)
    }

    private var chipColor: Color {
        switch provider {
        case .claude: return Color(nsColor: .quaternarySystemFill)
        case .codex: return colorScheme == .dark ? Color.white : Color(white: 0.12)
        }
    }

    private var markColor: Color {
        switch provider {
        case .claude: return Self.claudeClay
        case .codex: return colorScheme == .dark ? Color(white: 0.12) : .white
        }
    }
}
