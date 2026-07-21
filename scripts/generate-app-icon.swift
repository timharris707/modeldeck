#!/usr/bin/env swift
// generate-app-icon.swift — Issue #82: the ModelDeck app icon.
//
// Deterministically renders design/icon/ModelDeck.iconset (every macOS size,
// 16..512 with @2x), a 1024px master PNG, and packages the iconset into
// design/icon/ModelDeck.icns via iconutil. Run from the repo root whenever
// the mark changes:
//
//   swift scripts/generate-app-icon.swift
//
// The .icns is committed; this script exists so the asset is reproducible
// and reviewable as code instead of an opaque binary (same pattern as
// scripts/generate-dmg-background.swift, issue #69/#80). Nothing is
// fetched — everything is drawn locally with CoreGraphics/AppKit.
//
// Design notes:
// - Same visual language as the installer art and the in-app brand mark:
//   the deck glyph (12/8/16 staggered bars, flush left — DeckGlyphGeometry
//   in the Swift package) in the established three-color colorway
//   (#4C8DFF / #E0A94A / #EA5C50, ModelDeckBrandMark). Do not invent a
//   new mark here.
// - Backdrop is the modern macOS rounded square on Apple's icon grid: the
//   shape spans 824/1024 of the canvas, corner radius 185.4/1024, with
//   transparent margin around it. The fill is the same slate family as the
//   DMG background, darkened a step so the brand bars carry the contrast.
// - Every size is drawn vectorially at its own pixel size (no downscaling),
//   so the 16px menu-tile stays crisp instead of blurring a resized master.
// - No text, no identities — the glyph alone is the mark at icon scale.

import AppKit

// Shared deck glyph geometry (mirrors DeckGlyphGeometry in
// macos/ModelDeckMac — top-to-bottom medium/short/long, flush left).
let barWidthsTopToBottom: [CGFloat] = [12, 8, 16]
let glyphDesignWidth: CGFloat = 16
let barHeightUnits: CGFloat = 3
let barGapUnits: CGFloat = 2
// 3 bars + 2 gaps: total glyph height in units.
let glyphDesignHeight: CGFloat = barHeightUnits * 3 + barGapUnits * 2 // 13

// Brand bar colors, top-to-bottom (mirrors ModelDeckBrandMark).
let barColors: [NSColor] = [
    NSColor(srgbRed: 0x4C / 255, green: 0x8D / 255, blue: 0xFF / 255, alpha: 1), // #4C8DFF
    NSColor(srgbRed: 0xE0 / 255, green: 0xA9 / 255, blue: 0x4A / 255, alpha: 1), // #E0A94A
    NSColor(srgbRed: 0xEA / 255, green: 0x5C / 255, blue: 0x50 / 255, alpha: 1), // #EA5C50
]

/// Renders the icon at `pixels` x `pixels` and returns PNG data.
func renderIcon(pixels: Int) -> Data {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .calibratedRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fputs("generate-app-icon: could not create bitmap rep (\(pixels)px)\n", stderr)
        exit(1)
    }

    NSGraphicsContext.saveGraphicsState()
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
        fputs("generate-app-icon: could not create graphics context (\(pixels)px)\n", stderr)
        exit(1)
    }
    NSGraphicsContext.current = context

    let size = CGFloat(pixels)
    // Apple icon grid: shape is 824/1024 of the canvas, radius 185.4/1024.
    let shapeSide = size * 824 / 1024
    let cornerRadius = size * 185.4 / 1024
    let shapeOrigin = (size - shapeSide) / 2
    let shapeRect = NSRect(x: shapeOrigin, y: shapeOrigin, width: shapeSide, height: shapeSide)
    let shapePath = NSBezierPath(roundedRect: shapeRect, xRadius: cornerRadius, yRadius: cornerRadius)

    // ------------------------------------------------------------ backdrop
    // Slate vertical gradient, one step darker than the DMG background so
    // the brand bars pop; same hue family for a coherent installer story.
    shapePath.addClip()
    let gradient = NSGradient(
        starting: NSColor(srgbRed: 0.318, green: 0.345, blue: 0.400, alpha: 1), // top  #515866
        ending: NSColor(srgbRed: 0.224, green: 0.247, blue: 0.298, alpha: 1)    // base #393F4C
    )!
    gradient.draw(in: shapeRect, angle: -90)

    // --------------------------------------------------------------- glyph
    // Deck glyph centered in the shape; the long bar spans ~56% of the
    // shape width — big enough to read at 16px, calm enough at 512px.
    let unit = shapeSide * 0.56 / glyphDesignWidth
    let glyphWidth = glyphDesignWidth * unit
    let glyphHeight = glyphDesignHeight * unit
    let glyphLeft = shapeRect.midX - glyphWidth / 2
    var barTop = shapeRect.midY + glyphHeight / 2
    let barHeight = barHeightUnits * unit
    let barGap = barGapUnits * unit
    for (index, barWidth) in barWidthsTopToBottom.enumerated() {
        let rect = NSRect(x: glyphLeft, y: barTop - barHeight, width: barWidth * unit, height: barHeight)
        barColors[index].setFill()
        NSBezierPath(roundedRect: rect, xRadius: barHeight / 2, yRadius: barHeight / 2).fill()
        barTop -= barHeight + barGap
    }

    NSGraphicsContext.current?.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else {
        fputs("generate-app-icon: PNG encode failed (\(pixels)px)\n", stderr)
        exit(1)
    }
    return png
}

// ------------------------------------------------------------------ output
let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let repoRoot = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let iconDir = repoRoot.appendingPathComponent("design/icon")
let iconsetDir = iconDir.appendingPathComponent("ModelDeck.iconset")
let masterURL = iconDir.appendingPathComponent("modeldeck-icon-1024.png")
let icnsURL = iconDir.appendingPathComponent("ModelDeck.icns")

do {
    try? FileManager.default.removeItem(at: iconsetDir)
    try FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)
} catch {
    fputs("generate-app-icon: could not create \(iconsetDir.path): \(error)\n", stderr)
    exit(1)
}

// (iconset filename, pixel size) — the full set iconutil requires.
let iconsetEntries: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

// Render each distinct pixel size once, write every entry.
var pngBySize: [Int: Data] = [:]
for entry in iconsetEntries {
    let png = pngBySize[entry.pixels] ?? renderIcon(pixels: entry.pixels)
    pngBySize[entry.pixels] = png
    do {
        try png.write(to: iconsetDir.appendingPathComponent(entry.name))
    } catch {
        fputs("generate-app-icon: write failed for \(entry.name): \(error)\n", stderr)
        exit(1)
    }
}

// 1024px master alongside the iconset for design review.
do {
    try pngBySize[1024]!.write(to: masterURL)
} catch {
    fputs("generate-app-icon: master write failed: \(error)\n", stderr)
    exit(1)
}

// ------------------------------------------------------- iconutil package
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconsetDir.path, "-o", icnsURL.path]
do {
    try iconutil.run()
    iconutil.waitUntilExit()
} catch {
    fputs("generate-app-icon: iconutil launch failed: \(error)\n", stderr)
    exit(1)
}
guard iconutil.terminationStatus == 0 else {
    fputs("generate-app-icon: iconutil exited \(iconutil.terminationStatus)\n", stderr)
    exit(1)
}

let icnsBytes = (try? Data(contentsOf: icnsURL))?.count ?? 0
print("wrote \(iconsetDir.path) (\(iconsetEntries.count) sizes)")
print("wrote \(masterURL.path) (1024px master)")
print("wrote \(icnsURL.path) (\(icnsBytes) bytes)")
