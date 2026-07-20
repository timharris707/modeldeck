import AppKit
import Testing
@testable import ModelDeckMacCore

/// Issue #45 reopen: the data path was proven green, so the percent could
/// only be vanishing in the render layer — and it was: MenuBarExtra flattens
/// its label to ONE NSStatusBarButton image, so the old two-image HStack
/// label silently dropped the percent image. These tests rasterize the
/// single composite image the label now shows and assert the percent's
/// pixels actually exist, at the right place, in the right color.
@Suite("MenuBarIconRenderer pixels")
struct MenuBarIconRendererTests {
    /// Rasterizes an NSImage exactly the way a view would draw it (under an
    /// explicit appearance, since the composite uses dynamic labelColor).
    private func rasterize(
        _ image: NSImage,
        appearance: NSAppearance.Name = .aqua
    ) throws -> NSBitmapImageRep {
        let width = Int(image.size.width.rounded(.up))
        let height = Int(image.size.height.rounded(.up))
        let rep = try #require(NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .calibratedRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ))
        let context = try #require(NSGraphicsContext(bitmapImageRep: rep))
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = context
        let previous = NSAppearance.current
        defer { NSAppearance.current = previous }
        NSAppearance.current = try #require(NSAppearance(named: appearance))
        image.draw(
            in: NSRect(x: 0, y: 0, width: width, height: height),
            from: .zero,
            operation: .sourceOver,
            fraction: 1
        )
        context.flushGraphics()
        return rep
    }

    /// Visible (alpha >= 0.5) pixel count within an x-range of the bitmap.
    private func opaquePixelCount(_ rep: NSBitmapImageRep, xRange: Range<Int>? = nil) -> Int {
        var count = 0
        for x in (xRange ?? 0..<rep.pixelsWide) {
            for y in 0..<rep.pixelsHigh {
                if let color = rep.colorAt(x: x, y: y), color.alphaComponent >= 0.5 {
                    count += 1
                }
            }
        }
        return count
    }

    // MARK: - The issue #45 reopen regression

    /// The exact live repro: critical 3%. The label image must be WIDER than
    /// the bare glyph and must carry visible pixels in the percent region
    /// (right of the 16pt glyph). Before the fix the menu bar only ever
    /// received the 16pt glyph — this asserts the composite exists at all.
    @Test func criticalLabelImageContainsVisiblePercentPixels() throws {
        let image = MenuBarIconRenderer.labelImage(for: .critical(percentRemaining: 3))
        #expect(image.size.width > MenuBarIconRenderer.deckGlyph.size.width + 4)
        let rep = try rasterize(image)
        let glyphRegion = opaquePixelCount(rep, xRange: 0..<16)
        let percentRegion = opaquePixelCount(rep, xRange: 19..<rep.pixelsWide)
        #expect(glyphRegion > 30, "glyph half missing from the composite")
        #expect(percentRegion > 20, "percent pixels missing — the exact issue #45 reopen bug")
    }

    @Test func criticalPercentIsRed_warningIsGold() throws {
        func dominantWarmth(of state: MenuBarIconState) throws -> (red: Bool, gold: Bool) {
            let rep = try rasterize(MenuBarIconRenderer.labelImage(for: state))
            var sawRed = false
            var sawGold = false
            for x in 19..<rep.pixelsWide {
                for y in 0..<rep.pixelsHigh {
                    guard let color = rep.colorAt(x: x, y: y), color.alphaComponent > 0.8 else { continue }
                    let rgb = color.usingColorSpace(.deviceRGB) ?? color
                    if rgb.redComponent > 0.6, rgb.greenComponent < 0.4, rgb.blueComponent < 0.4 {
                        sawRed = true
                    }
                    if rgb.redComponent > 0.6, rgb.greenComponent > 0.4, rgb.blueComponent < 0.35 {
                        sawGold = true
                    }
                }
            }
            return (sawRed, sawGold)
        }
        #expect(try dominantWarmth(of: .critical(percentRemaining: 3)).red)
        #expect(try dominantWarmth(of: .warning(percentRemaining: 22)).gold)
    }

    /// The composite must NOT be a template image: the menu bar would
    /// flatten the gold/red tint to monochrome.
    @Test func compositeIsNotTemplate_plainGlyphIs() {
        #expect(!MenuBarIconRenderer.labelImage(for: .critical(percentRemaining: 3)).isTemplate)
        #expect(!MenuBarIconRenderer.labelImage(for: .warning(percentRemaining: 22)).isTemplate)
        #expect(MenuBarIconRenderer.labelImage(for: .plain).isTemplate)
    }

    /// Plain state keeps the original template glyph untouched.
    @Test func plainStateIsTheDeckGlyph() throws {
        let image = MenuBarIconRenderer.labelImage(for: .plain)
        #expect(image === MenuBarIconRenderer.deckGlyph)
        let rep = try rasterize(image)
        #expect(opaquePixelCount(rep) > 30)
    }

    /// The glyph half of the (non-template) composite is drawn in dynamic
    /// labelColor, so it must resolve light on dark menu bars and dark on
    /// light ones — otherwise the deck would vanish in one appearance.
    @Test func compositeGlyphAdaptsToAppearance() throws {
        let image = MenuBarIconRenderer.labelImage(for: .critical(percentRemaining: 3))

        func glyphBrightness(_ appearance: NSAppearance.Name) throws -> CGFloat {
            let rep = try rasterize(image, appearance: appearance)
            var total: CGFloat = 0
            var count: CGFloat = 0
            for x in 0..<16 {
                for y in 0..<rep.pixelsHigh {
                    guard let color = rep.colorAt(x: x, y: y), color.alphaComponent > 0.8 else { continue }
                    let rgb = color.usingColorSpace(.deviceRGB) ?? color
                    total += (rgb.redComponent + rgb.greenComponent + rgb.blueComponent) / 3
                    count += 1
                }
            }
            #expect(count > 30, "glyph pixels missing under \(appearance.rawValue)")
            return count > 0 ? total / count : 0
        }

        let light = try glyphBrightness(.aqua)
        let dark = try glyphBrightness(.darkAqua)
        #expect(light < 0.5, "glyph should be dark on the light menu bar")
        #expect(dark > 0.5, "glyph should be light on the dark menu bar")
    }

    @Test func accessibilityDescriptionsCarryTheState() {
        #expect(MenuBarIconRenderer.labelImage(for: .plain).accessibilityDescription == "ModelDeck")
        #expect(
            MenuBarIconRenderer.labelImage(for: .critical(percentRemaining: 3)).accessibilityDescription
                == "ModelDeck 3%"
        )
    }

    // Issue #53: the deck glyph geometry is the single source of truth for
    // both colorways — the menu bar glyph and the in-app brand mark. The
    // 12/8/16 top/middle/bottom ratio is the issue #25 decision; the longest
    // (bottom) bar spans the full design width.
    @Test func deckGlyphGeometryIsStaggeredMediumShortLong() {
        #expect(DeckGlyphGeometry.barWidthsTopToBottom == [12, 8, 16])
        #expect(DeckGlyphGeometry.barWidthsTopToBottom.max() == DeckGlyphGeometry.designWidth)
    }
}
