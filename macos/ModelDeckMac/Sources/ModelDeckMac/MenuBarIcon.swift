import AppKit
import SwiftUI
import ModelDeckMacCore

/// Menu bar label per the locked spec decision: a white template "deck"
/// glyph (three stacked bars), with "N%" beside it only when the lowest
/// remaining % is at or below the warning threshold — gold at warning, red
/// at critical, hidden when recovered.
struct MenuBarIconView: View {
    /// Issue #45 (bug 1, first fix): this view must OBSERVE the status
    /// model directly. It previously took `MenuBarIconState` by value from
    /// the App scene body; MenuBarExtra's label invalidation does not
    /// reliably re-evaluate the Scene body when an @StateObject held by the
    /// App publishes, so the menu bar item stayed frozen at the launch-time
    /// `.plain` render even after refreshes computed warning/critical.
    /// With @ObservedObject inside the label view, every `iconState`
    /// publish invalidates the label itself.
    @ObservedObject var statusModel: MenuBarStatusModel

    private var state: MenuBarIconState { statusModel.iconState }

    var body: some View {
        let _ = IconDebugLog.log("label body render: state=\(state) percentLabel=\(String(describing: state.percentLabel))")
        // Issue #45 reopen (bug 1, second fix — the render-layer half):
        // MenuBarExtra flattens its label into a single NSStatusBarButton
        // image, keeping only the FIRST Image in the content. The previous
        // `HStack { Image(glyph); Image(percent) }` therefore NEVER showed
        // the percent — verified live: with iconState critical and the body
        // rendering "3%", button.image was still the bare 16pt glyph. The
        // label must be exactly one image; the renderer composites
        // glyph + colored percent.
        Image(nsImage: MenuBarIconRenderer.labelImage(for: state))
            .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        switch state {
        case .plain:
            return "ModelDeck"
        case .warning(let percent):
            return "ModelDeck: \(percent) percent left on the lowest window"
        case .critical(let percent):
            return "ModelDeck: critical, \(percent) percent left on the lowest window"
        }
    }
}
