// GitHub social preview card for timharris707/modeldeck — 1280x640 @2x.
// v2 per Tim: horizontal lockup — brand glyph LEFT of the wordmark, glyph
// height matches the wordmark height, no right-side meters, generous padding.
import AppKit

let pointSize = NSSize(width: 1280, height: 640)
let scale: CGFloat = 2
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(pointSize.width * scale),
    pixelsHigh: Int(pointSize.height * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
ctx.cgContext.scaleBy(x: scale, y: scale)

let W = pointSize.width, H = pointSize.height
let barColors: [NSColor] = [
    NSColor(srgbRed: 0x4C/255, green: 0x8D/255, blue: 0xFF/255, alpha: 1),
    NSColor(srgbRed: 0xE0/255, green: 0xA9/255, blue: 0x4A/255, alpha: 1),
    NSColor(srgbRed: 0xEA/255, green: 0x5C/255, blue: 0x50/255, alpha: 1),
]

// Deep navy-slate diagonal gradient.
let g = NSGradient(colors: [
    NSColor(srgbRed: 0x10/255, green: 0x1A/255, blue: 0x2E/255, alpha: 1),
    NSColor(srgbRed: 0x1B/255, green: 0x2A/255, blue: 0x45/255, alpha: 1),
    NSColor(srgbRed: 0x12/255, green: 0x1D/255, blue: 0x33/255, alpha: 1),
])!
g.draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -35)

// Soft brand-blue glow behind the lockup center.
let glow = NSGradient(starting: NSColor(srgbRed: 0x4C/255, green: 0x8D/255, blue: 0xFF/255, alpha: 0.20), ending: .clear)!
glow.draw(fromCenter: NSPoint(x: W * 0.50, y: H * 0.58), radius: 0,
          toCenter: NSPoint(x: W * 0.50, y: H * 0.58), radius: 560, options: [])

// ---- Lockup: glyph + wordmark, horizontally centered as one unit ----
let wordFont = NSFont.systemFont(ofSize: 110, weight: .bold)
let wordAttrs: [NSAttributedString.Key: Any] = [.font: wordFont, .foregroundColor: NSColor.white]
let word = NSAttributedString(string: "ModelDeck", attributes: wordAttrs)
let wordSize = word.size()

// Glyph block height matches the wordmark's visual (cap-ish) height.
let glyphH = wordSize.height * 0.72
let barH = glyphH * 0.26                 // three bars + two gaps fill glyphH
let gapY = (glyphH - 3 * barH) / 2
let unit = glyphH / 3.4                  // width unit for 12/8/16 design widths
let widths: [CGFloat] = [12, 8, 16]
let glyphW = widths.max()! / 3.2 * unit  // widest bar defines glyph width
let lockupGap: CGFloat = 44
let lockupW = glyphW + lockupGap + wordSize.width
let lockupX = (W - lockupW) / 2
let baselineY = H * 0.47                 // wordmark draw origin (bottom-left of text box)

// Vertically center glyph against the wordmark's visual body: the text box
// has extra ascender/descender air, so bias the glyph slightly upward.
let glyphY0 = baselineY + (wordSize.height - glyphH) / 2 + wordSize.height * 0.045
for (i, wUnits) in widths.enumerated() {
    let y = glyphY0 + glyphH - CGFloat(i + 1) * barH - CGFloat(i) * gapY
    let w = wUnits / 3.2 * unit
    let r = NSBezierPath(roundedRect: NSRect(x: lockupX, y: y, width: w, height: barH),
                         xRadius: barH / 2, yRadius: barH / 2)
    barColors[i].setFill(); r.fill()
}
word.draw(at: NSPoint(x: lockupX + glyphW + lockupGap, y: baselineY))

// Tagline + chips, centered under the lockup with generous padding.
func drawCentered(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, y: CGFloat) {
    let a: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color,
    ]
    let att = NSAttributedString(string: s, attributes: a)
    att.draw(at: NSPoint(x: (W - att.size().width) / 2, y: y))
}
drawCentered("Every Claude Code & Codex limit, live in your menu bar.",
             size: 36, weight: .medium, color: NSColor.white.withAlphaComponent(0.85), y: H * 0.30)
drawCentered("Free · Local-first · No telemetry · macOS",
             size: 27, weight: .regular, color: NSColor.white.withAlphaComponent(0.55), y: H * 0.19)

NSGraphicsContext.restoreGraphicsState()
let png = rep.representation(using: .png, properties: [:])!
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "social-preview.png"
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out) (\(png.count / 1024) KB)")
