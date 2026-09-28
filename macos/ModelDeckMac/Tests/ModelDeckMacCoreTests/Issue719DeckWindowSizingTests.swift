import Foundation
import Testing
@testable import ModelDeckMacCore

@MainActor
struct Issue719DeckWindowSizingTests {
    @Test(arguments: [
        (483.0, 385.0, true),
        (385.0, 385.0, false),
        (385.0, 483.0, false),
        (385.0, 384.75, false),
        (385.0, 384.5, false),
        (385.0, 384.49, true),
        (385.0, 0.0, false)
    ])
    func shrinkPolicyAndRegisteredWindow(window height: Double, content: Double, shrinks: Bool) {
        if content > 0 {
            #expect(DeckWindowSizing.shouldShrink(from: CGFloat(height), to: CGFloat(content)) == shrinks)
        }
        let registry = DeckWindowRegistry()
        let window = RecordingWindow(height: CGFloat(height))
        registry.register(window)
        registry.fitContentHeight(CGFloat(content))
        #expect(window.fits == (shrinks ? [CGFloat(content)] : []))
    }

    // The comparison is against the window's own height, so sub-threshold
    // steps add up (CodeRabbit, PR #720) without a remembered baseline.
    @Test func comparesAgainstTheWindowNotARememberedHeight() {
        let registry = DeckWindowRegistry()
        let window = RecordingWindow(height: 385)
        registry.register(window)
        registry.fitContentHeight(384.5)
        #expect(window.fits.isEmpty)
        registry.fitContentHeight(384.0)
        #expect(window.fits == [384.0])
        registry.fitContentHeight(483)
        #expect(window.fits == [384.0])
    }

    final class RecordingWindow: DeckPopoverWindow {
        var deckContentHeight: CGFloat
        var fits: [CGFloat] = []
        init(height: CGFloat) { deckContentHeight = height }
        func close() {}
        func fitContentHeight(_ height: CGFloat) {
            fits.append(height)
            deckContentHeight = height
        }
    }
}
