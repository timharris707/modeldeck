import AppKit

/// The deck glyph's bar geometry — single source of truth shared by the
/// menu bar renderer (template/tinted colorway) and the in-app
/// `ModelDeckBrandMark` (three-color colorway). One shape, two colorways
/// (issue #53; width ratio decided in issue #25).
public enum DeckGlyphGeometry {
    /// Bar widths TOP-to-bottom in glyph units: medium / short / long
    /// (12 / 8 / 16), flush left — reads as ragged text lines.
    public static let barWidthsTopToBottom: [CGFloat] = [12, 8, 16]
    /// The design width the bar widths are expressed in (the longest bar
    /// spans the full glyph).
    public static let designWidth: CGFloat = 16
}

/// Renders the menu bar label artwork: the template "deck" glyph when
/// healthy, and a single composite image (glyph + colored "N%") at
/// warning/critical.
///
/// Issue #45 reopen root cause: `MenuBarExtra` flattens its label into ONE
/// `NSStatusBarButton.image`. A label built as `HStack { Image; Image }`
/// only ever ships the FIRST image to the status bar — the percent image was
/// silently dropped even when the state was correct, which is why the icon
/// stayed a plain glyph while the model said critical. The label must
/// therefore always be exactly one image; this renderer composites it.
///
/// Lives in Core so the pixel output is unit-testable — the original
/// executable-target home had zero coverage, which let the invisible-percent
/// regression ship.
public enum MenuBarIconRenderer {
    /// Gold used for the warning percent (readable on light and dark bars).
    /// Computed (not stored), same Swift 6 strict-concurrency rule as
    /// `percentFont`: NSColor is not Sendable.
    public static var warningColor: NSColor {
        NSColor(srgbRed: 0.85, green: 0.62, blue: 0.10, alpha: 1)
    }
    public static var criticalColor: NSColor { .systemRed }

    private static let glyphSize = NSSize(width: 16, height: 16)
    private static let glyphPercentSpacing: CGFloat = 3
    /// Computed (not stored): NSFont is not Sendable, so a stored global
    /// would trip Swift 6 strict concurrency.
    private static var percentFont: NSFont {
        .monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
    }

    /// The single image the MenuBarExtra label shows for a given icon state:
    /// the template glyph when plain; a non-template composite of glyph +
    /// colored percent at warning/critical. Non-template because a template
    /// composite would let the menu bar flatten the gold/red tint; the glyph
    /// half keeps adapting to the bar's appearance because it is drawn in
    /// dynamic `NSColor.labelColor`, which resolves against the current
    /// appearance each time the (drawing-handler-backed) image is drawn.
    public static func labelImage(for state: MenuBarIconState) -> NSImage {
        guard let label = state.percentLabel else { return deckGlyph }
        let color: NSColor
        if case .critical = state {
            color = criticalColor
        } else {
            color = warningColor
        }

        let attributed = NSAttributedString(string: label, attributes: [
            .font: percentFont,
            .foregroundColor: color,
        ])
        let textSize = attributed.size()
        let size = NSSize(
            width: glyphSize.width + glyphPercentSpacing + ceil(textSize.width),
            height: glyphSize.height
        )
        let textX = glyphSize.width + glyphPercentSpacing
        let image = NSImage(size: size, flipped: false) { _ in
            drawDeckBars(fill: .labelColor)
            attributed.draw(at: NSPoint(x: textX, y: (size.height - textSize.height) / 2))
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "ModelDeck \(label)"
        return image
    }

    /// Three stacked rounded bars — the "deck". Rows are LEFT-JUSTIFIED
    /// (flush left, ragged right) per the original artwork direction
    /// (issue #25 follow-up) — previously centered, which read as a
    /// pyramid. Drawn as a template image so macOS tints it for the
    /// current menu bar appearance.
    public static let deckGlyph: NSImage = {
        let image = NSImage(size: glyphSize, flipped: false) { _ in
            drawDeckBars(fill: .black)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "ModelDeck"
        return image
    }()

    /// Shared bar artwork for the template glyph and the composite label.
    /// Bottom-to-top (unflipped coords): long, short, medium — reads as
    /// ragged text lines, per Tim's direction.
    private static func drawDeckBars(fill: NSColor) {
        fill.setFill()
        // Bottom-up draw order in unflipped coords, so reverse the
        // top-to-bottom shared geometry.
        let barWidths: [CGFloat] = DeckGlyphGeometry.barWidthsTopToBottom.reversed()
        let barHeight: CGFloat = 3
        let spacing: CGFloat = 2
        var y: CGFloat = 1.5
        for width in barWidths {
            let rect = NSRect(x: 0, y: y, width: width, height: barHeight)
            NSBezierPath(roundedRect: rect, xRadius: barHeight / 2, yRadius: barHeight / 2).fill()
            y += barHeight + spacing
        }
    }
}
