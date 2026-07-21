import SwiftUI
import ModelDeckMacCore

/// Provider identification on deck cards, column headers, and the Settings
/// accounts roster: the official desktop-app icons — Claude.app's icon for
/// Claude, ChatGPT.app's icon for Codex (issue #103, Tim directive
/// 2026-07-21; spec "Provider marks" row, amended same day).
///
/// The bundled artwork is the apps' own `.icns` renders, which already carry
/// the macOS squircle-on-transparent-margin shape — rendered as-is, no chip
/// backing or extra masking, in the same layout slots the previous vector
/// marks used.
struct ProviderMarkView: View {
    let provider: DeckProvider
    var size: CGFloat = 20

    var body: some View {
        Group {
            if let icon = ProviderIcons.image(for: provider) {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                // Bundle missing the resource (should not happen in a built
                // app): keep the layout slot stable instead of collapsing.
                RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                    .fill(Color(nsColor: .quaternarySystemFill))
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(provider.displayName)
    }
}
