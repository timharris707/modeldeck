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
        (385.0, 384.49, true)
    ])
    func shrinkPolicyAndRegisteredWindow(old: Double, new: Double, shrinks: Bool) {
        let old = CGFloat(old)
        let new = CGFloat(new)
        #expect(DeckWindowSizing.shouldShrink(from: old, to: new) == shrinks)
        let registry = DeckWindowRegistry()
        let window = RecordingWindow()
        registry.register(window)
        registry.fitContentHeight(new, previousHeight: old)
        #expect(window.heights == (shrinks ? [new] : []))
    }

    // CodeRabbit (PR #720): two decreases each under the threshold must add up
    // to one fit, so the baseline is carried until a fit or a growth.
    @Test func subThresholdDecreasesAccumulateIntoOneFit() {
        let registry = DeckWindowRegistry()
        let window = RecordingWindow()
        registry.register(window)
        var baseline: CGFloat = 385
        baseline = registry.fitContentHeight(384.5, previousHeight: baseline)
        #expect(baseline == 385)
        #expect(window.heights.isEmpty)
        baseline = registry.fitContentHeight(384.0, previousHeight: baseline)
        #expect(baseline == 384.0)
        #expect(window.heights == [384.0])
        baseline = registry.fitContentHeight(483, previousHeight: baseline)
        #expect(baseline == 483)
        #expect(window.heights == [384.0])
    }

    final class RecordingWindow: DeckPopoverWindow {
        var heights: [CGFloat] = []
        func close() {}
        func fitContentHeight(_ height: CGFloat) { heights.append(height) }
    }

    // Issue #719: Core tests alone cannot catch a missing SwiftUI hook or
    // a floating deck accidentally resizing the registered menu-bar window.
    @Test func menuBarMeasuresPaddedContentAndFloatingDeckSkipsSizing() throws {
        let package = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: package.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"), encoding: .utf8)
        let padding = try #require(source.range(of: ".padding(14)"))
        let width = try #require(source.range(of: ".frame(width: deckWidth)", range: padding.upperBound..<source.endIndex))
        let measurement = try #require(source.range(of: "if !isFloating {\n                GeometryReader", range: width.upperBound..<source.endIndex))
        let preference = try #require(source.range(of: "key: DeckContentHeightPreferenceKey.self", range: measurement.upperBound..<source.endIndex))
        let measurementSnippetEnd = source.index(preference.upperBound, offsetBy: 160, limitedBy: source.endIndex) ?? source.endIndex
        let measurementSnippet = source[measurement.upperBound..<measurementSnippetEnd]
        #expect(measurementSnippet.contains("Color.clear.preference"))
        #expect(measurementSnippet.contains("geometry.size.height"))
        let handler = try #require(source.range(of: ".onPreferenceChange(DeckContentHeightPreferenceKey.self)", range: preference.upperBound..<source.endIndex))
        let remainder = source[handler.upperBound...]
        #expect(remainder.hasPrefix(" { height in\n            guard !isFloating, height > 0 else { return }\n            contentHeight = DeckWindowRegistry.shared.fitContentHeight(height, previousHeight: contentHeight)\n        }"))
        #expect(source.contains("@State private var contentHeight: CGFloat = 0"))
        #expect(source.contains("private struct DeckContentHeightPreferenceKey: PreferenceKey"))

        let app = try String(contentsOf: package.appendingPathComponent("Sources/ModelDeckMac/ModelDeckMacApp.swift"), encoding: .utf8)
        let menu = try #require(app.range(of: "MenuBarExtra {"))
        let style = try #require(app.range(of: ".menuBarExtraStyle(.window)", range: menu.upperBound..<app.endIndex))
        #expect(app[menu.upperBound..<style.lowerBound].contains("DeckPopoverView("))
        let floating = try #require(app.range(of: "let floatingDeckController = FloatingDeckWindowController"))
        #expect(app[floating.upperBound..<menu.lowerBound].contains("isFloating: true"))
    }
}
