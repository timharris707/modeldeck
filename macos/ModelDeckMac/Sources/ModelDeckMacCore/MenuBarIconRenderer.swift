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
        // Issue #235: health mode composites a shape-coded status dot (not
        // a percent) beside the glyph — its own path so the percent
        // grammar stays untouched.
        if case .health(let provider, let verdict) = state {
            return healthLabelImage(provider: provider, verdict: verdict)
        }
        guard let label = state.percentLabel else { return deckGlyph }
        let color: NSColor
        switch state {
        case .critical:
            color = criticalColor
        case .loading:
            // Issue #58: the cold-start "–%" placeholder is deliberately
            // muted — dynamic secondaryLabelColor, resolved at draw time
            // like the glyph, so it never reads as a severity signal.
            color = .secondaryLabelColor
        case .pinned:
            // A healthy pinned account renders in the same dynamic label
            // color as the glyph: informational, not a severity signal.
            color = .labelColor
        case .plain, .warning:
            color = warningColor
        case .health:
            // Unreachable — health mode returned above with its dot
            // composite. Listed only for exhaustiveness, and returning the
            // bare glyph (not a color assignment) so this switch can never
            // imply health text renders gold.
            return deckGlyph
        }
        return composite(text: label, color: color, accessibility: "ModelDeck \(label)")
    }

    /// Issue #235: the health-mode label — the template-drawn deck glyph
    /// plus a small FULL-COLOR status dot (Tim's design call: color is
    /// permitted and desired in the menu bar; the glyph half keeps
    /// adapting to light/dark because it draws in dynamic labelColor).
    /// Color is never the only signal: the shapes differ per verdict —
    /// green filled circle, yellow triangle, red octagon (traffic-sign
    /// shape language, distinguishable for colorblind users) — and the
    /// verdict is available as text via the accessibility description and
    /// the deck chip's detail popover. A nil verdict renders a muted
    /// hollow ring: data hasn't arrived or no account qualified, and the
    /// mode must never claim a health it can't compute. Non-template by
    /// necessity (a template composite would flatten the tint), so the dot
    /// does not invert on highlight — the saturated system colors stay
    /// readable on the highlight tint as on both bar appearances.
    public static func healthLabelImage(
        provider: DeckProvider,
        verdict: AvailabilityVerdict?
    ) -> NSImage {
        let dotSize: CGFloat = 8
        let size = NSSize(
            width: glyphSize.width + glyphPercentSpacing + dotSize,
            height: glyphSize.height
        )
        let dotRect = NSRect(
            x: glyphSize.width + glyphPercentSpacing,
            y: (glyphSize.height - dotSize) / 2,
            width: dotSize,
            height: dotSize
        )
        let image = NSImage(size: size, flipped: false) { _ in
            drawDeckBars(fill: .labelColor)
            drawVerdictDot(verdict, in: dotRect)
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "ModelDeck \(provider.displayName) availability "
            + (verdict?.displayWord.lowercased() ?? "unknown")
        return image
    }

    /// The shape-coded status dot: circle / triangle / octagon so the
    /// verdict never relies on color alone. The mapping and geometry live in
    /// `AvailabilityVerdictShape` (#242) — shared with the deck chip's dot,
    /// so the two surfaces can never drift apart.
    private static func drawVerdictDot(_ verdict: AvailabilityVerdict?, in rect: NSRect) {
        let shape = AvailabilityVerdictShape.shape(for: verdict)
        let path = NSBezierPath(cgPath: shape.path(in: rect))
        switch verdict {
        case .green: NSColor.systemGreen.setFill()
        case .yellow: warningColor.setFill()
        case .red: criticalColor.setFill()
        case nil: NSColor.secondaryLabelColor.setStroke()
        }
        if shape.isStroked {
            path.lineWidth = AvailabilityVerdictShape.ringLineWidth
            path.stroke()
        } else {
            path.fill()
        }
    }

    /// The single composite the status bar shows: glyph + colored text.
    /// Non-template because a template composite would let the menu bar
    /// flatten the tint; the glyph half keeps adapting because it draws in
    /// dynamic `NSColor.labelColor`, resolved per draw of the
    /// drawing-handler-backed image.
    private static func composite(text: String, color: NSColor, accessibility: String) -> NSImage {
        let attributed = NSAttributedString(string: text, attributes: [
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
        image.accessibilityDescription = accessibility
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
