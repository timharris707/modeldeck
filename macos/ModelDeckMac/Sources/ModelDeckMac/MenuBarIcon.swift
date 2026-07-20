import AppKit
import SwiftUI
import ModelDeckMacCore

/// Menu bar label per the locked spec decision: a white template "deck"
/// glyph (three stacked bars), with "N%" beside it only when the lowest
/// remaining % is at or below the warning threshold — gold at warning, red
/// at critical, hidden when recovered.
struct MenuBarIconView: View {
    /// Issue #45 (bug 1 root cause): this view must OBSERVE the status
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
        HStack(spacing: 3) {
            // Template image: adapts to menu bar appearance automatically.
            Image(nsImage: MenuBarIconRenderer.deckGlyph)
            if let label = state.percentLabel {
                // Colored percent rendered as a non-template image so the
                // menu bar cannot flatten the gold/red tint.
                Image(nsImage: MenuBarIconRenderer.percentImage(text: label, color: color(for: state)))
            }
        }
        .accessibilityLabel(accessibilityText)
    }

    private func color(for state: MenuBarIconState) -> NSColor {
        switch state {
        case .critical: return MenuBarIconRenderer.criticalColor
        default: return MenuBarIconRenderer.warningColor
        }
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

enum MenuBarIconRenderer {
    /// Gold used for the warning percent (readable on light and dark bars).
    static let warningColor = NSColor(srgbRed: 0.85, green: 0.62, blue: 0.10, alpha: 1)
    static let criticalColor = NSColor.systemRed

    /// Three stacked rounded bars — the "deck". Rows are LEFT-JUSTIFIED
    /// (flush left, ragged right) per the original artwork direction
    /// (issue #25 follow-up) — previously centered, which read as a
    /// pyramid. Drawn as a template image so macOS tints it for the
    /// current menu bar appearance.
    static let deckGlyph: NSImage = {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size, flipped: false) { _ in
            NSColor.black.setFill()
            // Bottom-to-top (unflipped coords): long, short, medium — reads
            // as ragged text lines, per Tim's direction.
            let barWidths: [CGFloat] = [16, 8, 12]
            let barHeight: CGFloat = 3
            let spacing: CGFloat = 2
            var y: CGFloat = 1.5
            for width in barWidths {
                let rect = NSRect(x: 0, y: y, width: width, height: barHeight)
                NSBezierPath(roundedRect: rect, xRadius: barHeight / 2, yRadius: barHeight / 2).fill()
                y += barHeight + spacing
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "ModelDeck"
        return image
    }()

    /// "N%" rendered into a fixed-height image at menu bar text size.
    static func percentImage(text: String, color: NSColor) -> NSImage {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: color,
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        let textSize = attributed.size()
        let size = NSSize(width: ceil(textSize.width), height: 16)
        let image = NSImage(size: size, flipped: false) { _ in
            attributed.draw(at: NSPoint(x: 0, y: (size.height - textSize.height) / 2))
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = text
        return image
    }
}
