#!/usr/bin/env swift
// generate-dmg-background.swift — Issue #69: DMG installer background art.
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
// Design notes:
// - 600x400pt canvas rendered at 2x (1200x800px, 144dpi) so Finder shows it
//   crisp on Retina. The window bounds in design/dmg/DS_Store match.
// - Brand mark reuses the deck glyph geometry (12/8/16 staggered bars, flush
//   left — DeckGlyphGeometry in the Swift package) in the established
//   three-color colorway (#4C8DFF / #E0A94A / #EA5C50, ModelDeckBrandMark).
// - The background is a mid-tone slate gradient chosen so Finder's icon
//   label text stays legible in BOTH appearances (black labels in light
//   Finder, white labels in dark Finder). Do not push it near-white or
//   near-black without rechecking both.
// - Icon anchor points (Finder icon centers, top-left origin, points):
//   ModelDeck.app at (150, 195), Applications at (450, 195), icon size 100.
//   Keep in sync with scripts/generate-dmg-ds-store.sh.

import AppKit

let pointSize = NSSize(width: 600, height: 400)
let scale: CGFloat = 2
let pixelWide = Int(pointSize.width * scale)
let pixelHigh = Int(pointSize.height * scale)

// Shared deck glyph geometry (mirrors DeckGlyphGeometry in
// macos/ModelDeckMac — top-to-bottom medium/short/long, flush left).
let barWidthsTopToBottom: [CGFloat] = [12, 8, 16]
let glyphDesignWidth: CGFloat = 16

// Brand bar colors, top-to-bottom (mirrors ModelDeckBrandMark).
let barColors: [NSColor] = [
    NSColor(srgbRed: 0x4C / 255, green: 0x8D / 255, blue: 0xFF / 255, alpha: 1), // #4C8DFF
    NSColor(srgbRed: 0xE0 / 255, green: 0xA9 / 255, blue: 0x4A / 255, alpha: 1), // #E0A94A
    NSColor(srgbRed: 0xEA / 255, green: 0x5C / 255, blue: 0x50 / 255, alpha: 1), // #EA5C50
]

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

// ---------------------------------------------------------------- background
// Mid-tone slate vertical gradient: legible under both black (light Finder)
// and white (dark Finder) icon labels.
// At the icon-label band (~60% down) this measures ~0.17 relative
// luminance: ~4.4:1 against black labels, ~4.8:1 against white labels.
let gradient = NSGradient(
    starting: NSColor(srgbRed: 0.475, green: 0.502, blue: 0.549, alpha: 1), // top  #79808C
    ending: NSColor(srgbRed: 0.392, green: 0.420, blue: 0.467, alpha: 1)    // base #646B77
)!
gradient.draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: -90)

// -------------------------------------------------------------- brand header
// Deck glyph, top-left, at 3x the 16-unit design (48pt wide).
let unit: CGFloat = 3
let glyphOrigin = NSPoint(x: 32, y: height - 34) // top-left of the glyph block
let barHeight = unit * 3
let barGap = unit * 2
var barTop = glyphOrigin.y
for (index, barWidth) in barWidthsTopToBottom.enumerated() {
    let rect = NSRect(x: glyphOrigin.x, y: barTop - barHeight, width: unit * barWidth, height: barHeight)
    barColors[index].setFill()
    NSBezierPath(roundedRect: rect, xRadius: barHeight / 2, yRadius: barHeight / 2).fill()
    barTop -= barHeight + barGap
}

func draw(text: String, at point: NSPoint, font: NSFont, color: NSColor, tracking: CGFloat = 0, centered: Bool = false) {
    var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    if tracking != 0 { attributes[.kern] = tracking }
    let attributed = NSAttributedString(string: text, attributes: attributes)
    let size = attributed.size()
    let origin = centered ? NSPoint(x: point.x - size.width / 2, y: point.y) : point
    attributed.draw(at: origin)
}

// Wordmark beside the glyph (quiet, per the popover-header treatment:
// system semibold, slight tracking, no extra color).
draw(
    text: "ModelDeck",
    at: NSPoint(x: glyphOrigin.x + glyphDesignWidth * unit + 14, y: height - 60),
    font: NSFont.systemFont(ofSize: 21, weight: .semibold),
    color: NSColor(calibratedWhite: 1.0, alpha: 0.92),
    tracking: 0.6
)

// ------------------------------------------------------------------- arrow
// Icon centers in top-left-origin Finder coords: app (150,195), /Applications
// (450,195). In this bottom-left-origin canvas the shared center line is:
let iconCenterY = height - 195

// Thick rounded arrow shaft + head between the two icons.
let arrowColor = NSColor(calibratedWhite: 1.0, alpha: 0.82)
arrowColor.setStroke()
arrowColor.setFill()

let shaft = NSBezierPath()
shaft.lineWidth = 9
shaft.lineCapStyle = .round
shaft.move(to: NSPoint(x: 240, y: iconCenterY))
shaft.line(to: NSPoint(x: 338, y: iconCenterY))
shaft.stroke()

let head = NSBezierPath()
head.move(to: NSPoint(x: 336, y: iconCenterY + 17))
head.line(to: NSPoint(x: 362, y: iconCenterY))
head.line(to: NSPoint(x: 336, y: iconCenterY - 17))
head.lineWidth = 9
head.lineCapStyle = .round
head.lineJoinStyle = .round
head.stroke()

// -------------------------------------------------------------- drop zone
// Dashed ring hinting the /Applications drop target.
let ringCenter = NSPoint(x: 450, y: iconCenterY)
let ringRadius: CGFloat = 66
let ring = NSBezierPath(
    ovalIn: NSRect(
        x: ringCenter.x - ringRadius, y: ringCenter.y - ringRadius,
        width: ringRadius * 2, height: ringRadius * 2
    )
)
ring.lineWidth = 2.5
ring.setLineDash([7, 6], count: 2, phase: 0)
NSColor(calibratedWhite: 1.0, alpha: 0.55).setStroke()
ring.stroke()

// ----------------------------------------------------------------- caption
// Below the icon row (labels end around y=255 top-coord / 145 bottom-coord).
draw(
    text: "Drag ModelDeck to Applications to install",
    at: NSPoint(x: width / 2, y: 78),
    font: NSFont.systemFont(ofSize: 13, weight: .medium),
    color: NSColor(calibratedWhite: 1.0, alpha: 0.85),
    tracking: 0.2,
    centered: true
)

NSGraphicsContext.current?.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

// Stamp the point size so the PNG carries 144dpi and Finder maps the 2x
// pixels onto a 600x400pt view.
rep.size = pointSize
guard let png = rep.representation(using: .png, properties: [:]) else {
    fputs("generate-dmg-background: PNG encode failed\n", stderr)
    exit(1)
}

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let repoRoot = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let outputURL = repoRoot.appendingPathComponent("design/dmg/modeldeck-installer-bg.png")
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
