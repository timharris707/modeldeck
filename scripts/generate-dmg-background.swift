#!/usr/bin/env swift
// generate-dmg-background.swift — Issues #69/#130: DMG installer background art.
//
// Deterministically renders design/dmg/modeldeck-installer-bg.png, the
// drag-to-Applications background for the release DMG (scripts/release-dmg.sh).
// Run from the repo root whenever the art needs to change:
//
//   swift scripts/generate-dmg-background.swift
//
// The PNG is committed; this script exists so the art is reproducible and
// reviewable as code instead of an opaque binary. Nothing is fetched — the
// entire image is drawn locally with CoreGraphics/AppKit.
//
// Design notes (issue #130 premium pass — supersedes the #69 flat art):
// - 640x420pt canvas rendered at 2x (1280x840px, 144dpi) so Finder shows it
//   crisp on Retina. The window bounds in design/dmg/DS_Store match.
// - TWO variants (orchestrator revision on PR #132: "decisively blue, never
//   default gray"), selected with `--variant bold|steel`:
//     bold  (DEFAULT, the shipped art): deep-navy → brand-blue vertical
//            gradient, full-width tri-color deck-bar band along the top
//            edge (segment widths in the mark's 12:8:16 ratio), stronger
//            header glow + center light, 9%-alpha watermark.
//     steel (restrained alternative, evidence only): steel-blue gradient —
//            desaturated but still unmistakably blue — tri-color underline
//            beneath the header lockup, softer lighting.
//   The default writes design/dmg/modeldeck-installer-bg.png (the committed
//   release artifact); any other variant writes
//   design/dmg/verification/modeldeck-installer-bg-<variant>.png so the
//   release input can never be swapped by accident.
// - Layered background: blue gradient, brand-blue radial glow behind the
//   header, a white center-light so the canvas reads lit rather than flat,
//   a giant low-alpha deck-glyph watermark bleeding off the left edge, and
//   a corner vignette for depth.
// - The label band (~62% down, where Finder draws icon titles) is kept at
//   ~0.15–0.18 relative luminance: ≥~4:1 against black labels (light
//   Finder) and ≥~4:1 against white labels (dark Finder). Hue may move;
//   that luminance discipline must not. Do not push it near-white or
//   near-black without rechecking both appearances.
// - Header is the deck glyph + wordmark, centered — the established
//   three-color colorway (#4C8DFF / #E0A94A / #EA5C50, ModelDeckBrandMark)
//   over the 12/8/16 staggered-bar geometry (DeckGlyphGeometry).
// - Drop target: a dashed rounded-rect zone that fully ENCLOSES the
//   /Applications icon AND its label (the #69 dashed circle cut through the
//   label — the exact complaint in #130). Zone bottom sits ~20pt below the
//   label baseline; keep that clearance if the geometry moves.
// - Icon anchor points (Finder icon centers, top-left origin, points):
//   ModelDeck.app at (170, 210), Applications at (470, 210), icon size 100.
//   Keep in sync with scripts/generate-dmg-ds-store.sh.

import AppKit

let pointSize = NSSize(width: 640, height: 420)
let scale: CGFloat = 2
let pixelWide = Int(pointSize.width * scale)
let pixelHigh = Int(pointSize.height * scale)

// Shared deck glyph geometry (mirrors DeckGlyphGeometry in
// macos/ModelDeckMac — top-to-bottom medium/short/long, flush left).
let barWidthsTopToBottom: [CGFloat] = [12, 8, 16]
let glyphDesignWidth: CGFloat = 16
let barHeightUnits: CGFloat = 3
let barGapUnits: CGFloat = 2
let glyphDesignHeight: CGFloat = barHeightUnits * 3 + barGapUnits * 2 // 13

// Brand bar colors, top-to-bottom (mirrors ModelDeckBrandMark).
let barColors: [NSColor] = [
    NSColor(srgbRed: 0x4C / 255, green: 0x8D / 255, blue: 0xFF / 255, alpha: 1), // #4C8DFF
    NSColor(srgbRed: 0xE0 / 255, green: 0xA9 / 255, blue: 0x4A / 255, alpha: 1), // #E0A94A
    NSColor(srgbRed: 0xEA / 255, green: 0x5C / 255, blue: 0x50 / 255, alpha: 1), // #EA5C50
]

func rgb(_ r: Int, _ g: Int, _ b: Int, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: alpha)
}

// ------------------------------------------------------------------ variants
/// How the tri-color deck-bar accent is placed in the composition.
enum AccentStyle {
    /// Full-width crisp band along the top edge, segment widths 12:8:16.
    case topEdgeBand(height: CGFloat)
    /// Lockup-width underline beneath the header glyph+wordmark, split 12:8:16.
    case lockupUnderline(height: CGFloat)
}

struct Variant {
    let name: String
    /// Vertical base gradient, top → bottom.
    let gradientTop: NSColor
    let gradientBottom: NSColor
    /// Brand-blue glow behind the header lockup.
    let headerGlowAlpha: CGFloat
    /// White radial light on the canvas center ("lit, not flat").
    let centerLightAlpha: CGFloat
    let watermarkAlpha: CGFloat
    let vignetteAlpha: CGFloat
    let accent: AccentStyle
    /// True for the default variant that overwrites the committed release
    /// artifact; alternates land in design/dmg/verification/.
    let isDefault: Bool
}

// bold (DEFAULT): unmistakably blue — lit brand blue up top grounding into
// deep navy. Label band (~62% down) sits toward the navy at L≈0.11 base,
// lifted to ~0.16 by the center light: ~4:1 vs black labels, ~5:1 vs white.
let boldVariant = Variant(
    name: "bold",
    gradientTop: rgb(0x4A, 0x7C, 0xD0),
    gradientBottom: rgb(0x22, 0x3F, 0x6E),
    headerGlowAlpha: 0.34,
    centerLightAlpha: 0.10,
    watermarkAlpha: 0.09,
    vignetteAlpha: 0.18,
    accent: .topEdgeBand(height: 3.5),
    isDefault: true
)

// steel (alternative): desaturated but still clearly blue — no gray reading.
// Same luminance discipline at the label band (~L 0.12 base, ~0.15 lit).
let steelVariant = Variant(
    name: "steel",
    gradientTop: rgb(0x5D, 0x78, 0xA6),
    gradientBottom: rgb(0x38, 0x4C, 0x70),
    headerGlowAlpha: 0.22,
    centerLightAlpha: 0.07,
    watermarkAlpha: 0.07,
    vignetteAlpha: 0.14,
    accent: .lockupUnderline(height: 3),
    isDefault: false
)

let variantsByName = ["bold": boldVariant, "steel": steelVariant]
var requestedName = "bold"
if let flagIndex = CommandLine.arguments.firstIndex(of: "--variant") {
    guard flagIndex + 1 < CommandLine.arguments.count else {
        fputs("generate-dmg-background: --variant needs a value (bold|steel)\n", stderr)
        exit(2)
    }
    requestedName = CommandLine.arguments[flagIndex + 1]
}
guard let variant = variantsByName[requestedName] else {
    fputs("generate-dmg-background: unknown variant \"\(requestedName)\" (bold|steel)\n", stderr)
    exit(2)
}

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixelWide,
    pixelsHigh: pixelHigh,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .calibratedRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("generate-dmg-background: could not create bitmap rep\n", stderr)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
    fputs("generate-dmg-background: could not create graphics context\n", stderr)
    exit(1)
}
NSGraphicsContext.current = context
// Draw in point coordinates; the rep is 2x pixels.
context.cgContext.scaleBy(x: scale, y: scale)

let width = pointSize.width
let height = pointSize.height

/// Converts a top-left-origin y (Finder/layout coords) to this canvas's
/// bottom-left-origin y.
func fromTop(_ yTop: CGFloat) -> CGFloat { height - yTop }

// Icon centers in top-left-origin Finder coords (keep in sync with
// generate-dmg-ds-store.sh): app (170,210), /Applications (470,210).
let appIconCenter = NSPoint(x: 170, y: fromTop(210))
let dropIconCenter = NSPoint(x: 470, y: fromTop(210))

// ---------------------------------------------------------------- background
// Decisively BLUE vertical gradient (the app icon's #4C8DFF family, taken
// darker) — the #130 revision brief: reads "designed, branded" at first
// glance, never "default gray". The label band stays in the legibility
// luminance window; see the variant definitions.
let baseGradient = NSGradient(starting: variant.gradientTop, ending: variant.gradientBottom)!
// angle -90 puts `starting` (gradientTop, the lit blue) at the TOP; the
// deep navy grounds the bottom, under the caption.
baseGradient.draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: -90)

// Brand-blue radial glow behind the header lockup — strong enough to read
// as a light source, not a tint.
let glowCenter = NSPoint(x: width / 2, y: height + 30)
let blueGlow = NSGradient(colors: [
    rgb(0x6F, 0xA6, 0xFF, variant.headerGlowAlpha),
    rgb(0x6F, 0xA6, 0xFF, 0.0),
])!
blueGlow.draw(
    fromCenter: glowCenter, radius: 0,
    toCenter: glowCenter, radius: 400,
    options: []
)

// White center-light so the middle of the canvas — where the drag happens —
// feels lit rather than flat.
let centerLightCenter = NSPoint(x: width / 2, y: fromTop(225))
let centerLight = NSGradient(colors: [
    NSColor(calibratedWhite: 1.0, alpha: variant.centerLightAlpha),
    NSColor(calibratedWhite: 1.0, alpha: 0.0),
])!
centerLight.draw(
    fromCenter: centerLightCenter, radius: 0,
    toCenter: centerLightCenter, radius: 330,
    options: []
)

// Giant deck-glyph watermark bleeding off the left edge — brand texture,
// low-alpha so it structures the field without fighting the icons.
do {
    let unit: CGFloat = 22
    let glyphLeft: CGFloat = -56
    let glyphHeight = glyphDesignHeight * unit
    var barTop = appIconCenter.y + glyphHeight / 2
    let barHeight = barHeightUnits * unit
    let barGap = barGapUnits * unit
    NSColor(calibratedWhite: 1.0, alpha: variant.watermarkAlpha).setFill()
    for barWidth in barWidthsTopToBottom {
        let rect = NSRect(x: glyphLeft, y: barTop - barHeight, width: barWidth * unit, height: barHeight)
        NSBezierPath(roundedRect: rect, xRadius: barHeight / 2, yRadius: barHeight / 2).fill()
        barTop -= barHeight + barGap
    }
}

// Corner vignette for depth: clear center, gently darkened edges.
let vignetteCenter = NSPoint(x: width / 2, y: height / 2)
let vignette = NSGradient(colors: [
    NSColor(calibratedWhite: 0, alpha: 0.0),
    NSColor(calibratedWhite: 0, alpha: variant.vignetteAlpha),
])!
vignette.draw(
    fromCenter: vignetteCenter, radius: 220,
    toCenter: vignetteCenter, radius: 480,
    options: [.drawsAfterEndingLocation]
)

// ------------------------------------------------------------ brand accent
// The three bar colors as a crisp, deliberate element (revision brief: the
// watermark alone was too quiet). Segment widths echo the mark's 12:8:16.
let accentRatios: [CGFloat] = barWidthsTopToBottom.map { $0 / 36 } // 12+8+16
func drawAccentBand(in rect: NSRect, rounded: Bool) {
    var x = rect.minX
    for (index, ratio) in accentRatios.enumerated() {
        let segment = NSRect(x: x, y: rect.minY, width: rect.width * ratio, height: rect.height)
        barColors[index].setFill()
        if rounded {
            NSBezierPath(
                roundedRect: segment, xRadius: rect.height / 2, yRadius: rect.height / 2
            ).fill()
        } else {
            segment.fill()
        }
        x += segment.width
    }
}
if case let .topEdgeBand(bandHeight) = variant.accent {
    drawAccentBand(
        in: NSRect(x: 0, y: height - bandHeight, width: width, height: bandHeight),
        rounded: false
    )
}

// -------------------------------------------------------------- brand header
// Deck glyph + wordmark, centered as a title lockup.
let headerUnit: CGFloat = 3
let headerGlyphWidth = glyphDesignWidth * headerUnit          // 48
let headerGlyphHeight = glyphDesignHeight * headerUnit        // 39
let wordmarkFont = NSFont.systemFont(ofSize: 22, weight: .semibold)
let wordmarkAttributes: [NSAttributedString.Key: Any] = [
    .font: wordmarkFont,
    .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.94),
    .kern: 0.6,
]
let wordmark = NSAttributedString(string: "ModelDeck", attributes: wordmarkAttributes)
let wordmarkSize = wordmark.size()
let lockupGap: CGFloat = 15
let lockupWidth = headerGlyphWidth + lockupGap + wordmarkSize.width
let lockupLeft = (width - lockupWidth) / 2
let headerGlyphTop = fromTop(32) // top edge of the glyph block

var headerBarTop = headerGlyphTop
let headerBarHeight = barHeightUnits * headerUnit
let headerBarGap = barGapUnits * headerUnit
for (index, barWidth) in barWidthsTopToBottom.enumerated() {
    let rect = NSRect(
        x: lockupLeft, y: headerBarTop - headerBarHeight,
        width: barWidth * headerUnit, height: headerBarHeight
    )
    barColors[index].setFill()
    NSBezierPath(roundedRect: rect, xRadius: headerBarHeight / 2, yRadius: headerBarHeight / 2).fill()
    headerBarTop -= headerBarHeight + headerBarGap
}

// Wordmark vertically centered on the glyph block.
let glyphCenterY = headerGlyphTop - headerGlyphHeight / 2
wordmark.draw(at: NSPoint(
    x: lockupLeft + headerGlyphWidth + lockupGap,
    y: glyphCenterY - wordmarkSize.height / 2
))

// steel variant: tri-color underline beneath the lockup (the bold variant
// carries its accent as the top-edge band instead).
if case let .lockupUnderline(underlineHeight) = variant.accent {
    drawAccentBand(
        in: NSRect(
            x: lockupLeft,
            y: headerGlyphTop - headerGlyphHeight - 14 - underlineHeight,
            width: lockupWidth,
            height: underlineHeight
        ),
        rounded: true
    )
}

// ---------------------------------------------------------------- icon glow
// Soft lift behind the app icon so it reads as the object to pick up.
let appGlow = NSGradient(colors: [
    NSColor(calibratedWhite: 1.0, alpha: 0.10),
    NSColor(calibratedWhite: 1.0, alpha: 0.0),
])!
appGlow.draw(
    fromCenter: appIconCenter, radius: 0,
    toCenter: appIconCenter, radius: 88,
    options: []
)

// ------------------------------------------------------------------- arrow
// Rounded shaft + open chevron head between the app icon and the drop zone.
let arrowColor = NSColor(calibratedWhite: 1.0, alpha: 0.85)
arrowColor.setStroke()

let arrowY = appIconCenter.y
let shaft = NSBezierPath()
shaft.lineWidth = 8
shaft.lineCapStyle = .round
shaft.move(to: NSPoint(x: 248, y: arrowY))
shaft.line(to: NSPoint(x: 344, y: arrowY))
shaft.stroke()

let head = NSBezierPath()
head.move(to: NSPoint(x: 342, y: arrowY + 16))
head.line(to: NSPoint(x: 366, y: arrowY))
head.line(to: NSPoint(x: 342, y: arrowY - 16))
head.lineWidth = 8
head.lineCapStyle = .round
head.lineJoinStyle = .round
head.stroke()

// -------------------------------------------------------------- drop zone
// Dashed rounded-rect that encloses the /Applications icon AND its label
// (top-left-origin: icon spans y 160–260, label ~265–280; zone y 126–302).
// The #69 circle clipped the label — never let this rect shrink into it.
let zoneRect = NSRect(
    x: dropIconCenter.x - 86,
    y: fromTop(302),
    width: 172,
    height: 176
)
let zone = NSBezierPath(roundedRect: zoneRect, xRadius: 28, yRadius: 28)
NSColor(calibratedWhite: 1.0, alpha: 0.06).setFill()
zone.fill()
zone.lineWidth = 2
zone.setLineDash([9, 7], count: 2, phase: 0)
NSColor(calibratedWhite: 1.0, alpha: 0.5).setStroke()
zone.stroke()

// ----------------------------------------------------------------- caption
// Single instruction line, centered near the bottom, clear of the zone.
let captionFont = NSFont.systemFont(ofSize: 13, weight: .medium)
let captionAttributes: [NSAttributedString.Key: Any] = [
    .font: captionFont,
    .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.88),
    .kern: 0.2,
]
let caption = NSAttributedString(
    string: "Drag ModelDeck to Applications to install",
    attributes: captionAttributes
)
let captionSize = caption.size()
caption.draw(at: NSPoint(x: (width - captionSize.width) / 2, y: 52))

NSGraphicsContext.current?.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

// Stamp the point size so the PNG carries 144dpi and Finder maps the 2x
// pixels onto a 640x420pt view.
rep.size = pointSize
guard let png = rep.representation(using: .png, properties: [:]) else {
    fputs("generate-dmg-background: PNG encode failed\n", stderr)
    exit(1)
}

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let repoRoot = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
// Only the default variant may overwrite the committed release artifact;
// alternates are evidence and land in design/dmg/verification/.
let outputURL = variant.isDefault
    ? repoRoot.appendingPathComponent("design/dmg/modeldeck-installer-bg.png")
    : repoRoot.appendingPathComponent("design/dmg/verification/modeldeck-installer-bg-\(variant.name).png")
do {
    try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true
    )
    try png.write(to: outputURL)
} catch {
    fputs("generate-dmg-background: write failed: \(error)\n", stderr)
    exit(1)
}
print("wrote \(outputURL.path) (\(pixelWide)x\(pixelHigh)px @144dpi, \(png.count) bytes)")
