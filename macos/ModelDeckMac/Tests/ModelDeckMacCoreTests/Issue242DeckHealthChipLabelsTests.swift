import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #242 — deck health chip labels: the `deckHealthLabels` setting (its
// own key, the #238 menuBarShowWhen compat discipline), the `DeckHealthLabels`
// grammar, the shared verdict → shape coding (`AvailabilityVerdictShape`,
// carried from the #235 menu-bar dot onto the deck chip), and the two chip
// rendering states — dot-only by default, dot + verdict word behind the
// Settings → General → Accessibility toggle. Display-only throughout: the
// tooltip, detail popover, and VoiceOver summary are identical in both modes.
// Placeholder labels only — never real account data.

@Suite("deckHealthLabels grammar (issue #242)")
struct DeckHealthLabelsGrammarTests {
    @Test func storedValuesRoundTrip() {
        for mode in [DeckHealthLabels.dotOnly, .show] {
            #expect(DeckHealthLabels.parse(mode.stored) == mode)
        }
        #expect(DeckHealthLabels.dotOnly.stored == "")
        #expect(DeckHealthLabels.show.stored == "show")
    }

    @Test func unknownValuesParseAsDotOnly() {
        // A newer build's future value must degrade to the default, never
        // crash and never invent labels.
        for stored in ["labels", "SHOW", "show:big", "on", "true", " ", "moon-phase:full"] {
            #expect(DeckHealthLabels.parse(stored) == .dotOnly)
        }
    }

    @Test func showsVerdictWordFollowsTheCase() {
        #expect(!DeckHealthLabels.dotOnly.showsVerdictWord)
        #expect(DeckHealthLabels.show.showsVerdictWord)
    }
}

@Suite("deckHealthLabels storage compatibility (issue #242)")
struct DeckHealthLabelsStorageTests {
    @Test func settingsDecodeToleratesTheMissingKey() throws {
        // Pre-#242 daemons omit the key entirely → dot only (default OFF:
        // the labels are opt-in by design).
        let old = try JSONDecoder().decode(DaemonSettings.self, from: Data("{}".utf8))
        #expect(old.deckHealthLabels == "")
        #expect(old.deckHealthLabelsMode == .dotOnly)
    }

    @Test func settingsDocumentRoundTripsEveryGrammarValue() throws {
        for stored in ["", "show"] {
            let decoded = try JSONDecoder().decode(
                DaemonSettings.self,
                from: Data(#"{"deckHealthLabels": "\#(stored)"}"#.utf8)
            )
            #expect(decoded.deckHealthLabels == stored)
            #expect(decoded.deckHealthLabelsMode == DeckHealthLabels.parse(stored))
        }
    }

    @Test func unknownStoredValueSurvivesButReadsAsDotOnly() throws {
        // A newer build's future value round-trips verbatim (never
        // clobbered) while THIS build renders the dot-only default.
        let decoded = try JSONDecoder().decode(
            DaemonSettings.self,
            from: Data(#"{"deckHealthLabels": "show:extra-large"}"#.utf8)
        )
        #expect(decoded.deckHealthLabels == "show:extra-large")
        #expect(decoded.deckHealthLabelsMode == .dotOnly)
    }

    @Test func patchEncodesTheKeyForThePut() throws {
        let data = try JSONEncoder().encode(DaemonSettingsPatch(deckHealthLabels: "show"))
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains(#""deckHealthLabels":"show""#))
        // Absent field stays absent — the daemon's merge semantics.
        let empty = try JSONEncoder().encode(DaemonSettingsPatch(menuBarShowWhen: "yellow"))
        let emptyJSON = try #require(String(data: empty, encoding: .utf8))
        #expect(!emptyJSON.contains("deckHealthLabels"))
    }

    @Test func patchMergingAndEmptinessCoverTheKey() {
        let first = DaemonSettingsPatch(deckHealthLabels: "show")
        let second = DaemonSettingsPatch(deckHealthLabels: "")
        #expect(first.merging(second).deckHealthLabels == "")
        #expect(second.merging(first).deckHealthLabels == "show")
        #expect(!first.isEmpty)
        #expect(DaemonSettingsPatch().isEmpty)
    }
}

@Suite("deckHealthLabels sync model (issue #242)")
@MainActor
struct DeckHealthLabelsSyncTests {
    @Test func toggleRoundTripsAndEchoesAreNoOps() async {
        var labelsOn = DaemonSettings.defaults
        labelsOn.deckHealthLabels = "show"
        let sync = StubSettingsSync(results: [
            .success(DaemonSettings.defaults),
            .success(labelsOn),
            .success(DaemonSettings.defaults),
        ])
        let model = SettingsSyncModel(sync: sync)
        await model.load()

        // Echo of the stored default ("" = dot only): no PUT.
        await model.setDeckHealthLabels("")
        #expect(sync.pushedPatches.isEmpty)

        // ON: the toggle PUTs "show" and adopts the confirmed document.
        await model.setDeckHealthLabels("show")
        #expect(sync.pushedPatches.count == 1)
        #expect(sync.pushedPatches.first?.deckHealthLabels == "show")
        #expect(model.settings.deckHealthLabels == "show")
        #expect(model.settings.deckHealthLabelsMode == .show)

        // Confirmed echo: no second PUT.
        await model.setDeckHealthLabels("show")
        #expect(sync.pushedPatches.count == 1)

        // OFF again: back to the dot-only default — a full round trip.
        await model.setDeckHealthLabels("")
        #expect(sync.pushedPatches.count == 2)
        #expect(sync.pushedPatches.last?.deckHealthLabels == "")
        #expect(model.settings.deckHealthLabelsMode == .dotOnly)
    }

    @Test func oldDaemonRejectingTheKeyIsASuccessfulNoOp() async {
        // A pre-#242 daemon answers "unknown setting: deckHealthLabels" —
        // the key was the whole patch, so the stripped patch is empty: no
        // retry PUT, no lastError, dot-only behavior simply stays.
        let sync = StubSettingsSync(results: [
            .failure(DaemonClientError.daemonError(
                message: "unknown setting: deckHealthLabels", status: 400
            )),
        ])
        let model = SettingsSyncModel(sync: sync)

        await model.setDeckHealthLabels("show")

        #expect(sync.pushedPatches.count == 1)
        #expect(model.lastError == nil)
        #expect(model.settings.deckHealthLabels == "")
    }
}

@Suite("Verdict shape parity with the menu bar (issue #242)")
struct VerdictShapeParityTests {
    @Test func codingMatchesTheMenuBarShapeLanguage() {
        // The #235 traffic-sign coding, verbatim: green filled circle,
        // yellow triangle, red octagon, hollow ring for no-data.
        #expect(AvailabilityVerdictShape.shape(for: .green) == .filledCircle)
        #expect(AvailabilityVerdictShape.shape(for: .yellow) == .triangle)
        #expect(AvailabilityVerdictShape.shape(for: .red) == .octagon)
        #expect(AvailabilityVerdictShape.shape(for: nil) == .hollowRing)
    }

    @Test func onlyTheNoDataRingStrokes() {
        #expect(AvailabilityVerdictShape.hollowRing.isStroked)
        for shape in [AvailabilityVerdictShape.filledCircle, .triangle, .octagon] {
            #expect(!shape.isStroked)
        }
    }

    @Test func filledShapesFillTheirRect() {
        // Geometry sanity: every filled shape spans the whole dot rect —
        // the deck chip and the menu bar dot read at the same visual weight.
        let rect = CGRect(x: 0, y: 0, width: 8, height: 8)
        for shape in [AvailabilityVerdictShape.filledCircle, .triangle, .octagon] {
            #expect(shape.path(in: rect).boundingBox == rect)
        }
    }

    @Test func ringPathIsTheInsetCenterlineOval() {
        let rect = CGRect(x: 0, y: 0, width: 8, height: 8)
        let expected = rect.insetBy(
            dx: AvailabilityVerdictShape.ringInset,
            dy: AvailabilityVerdictShape.ringInset
        )
        #expect(AvailabilityVerdictShape.hollowRing.path(in: rect).boundingBox == expected)
    }

    @Test func triangleApexSitsAtTheTopInUnflippedCoordinates() {
        // The path contract callers rely on: AppKit-unflipped (y up), apex
        // at maxY. SwiftUI callers must flip — encoded here so a geometry
        // "cleanup" can't silently invert the triangle on one surface.
        let rect = CGRect(x: 0, y: 0, width: 8, height: 8)
        let path = AvailabilityVerdictShape.triangle.path(in: rect)
        var containsApex = false
        path.applyWithBlock { element in
            let point = element.pointee.points.pointee
            if element.pointee.type == .moveToPoint,
               point == CGPoint(x: rect.midX, y: rect.maxY) {
                containsApex = true
            }
        }
        #expect(containsApex)
    }
}

@Suite("Deck chip rendering states (issue #242)")
struct DeckHealthChipDisplayTests {
    @Test func defaultOffRendersTheShapeCodedDotOnly() {
        // Labels off (the default): no verdict word, and the dot carries
        // the shape coding so color is never the only signal.
        let green = AvailabilityHealthChipDisplay.make(
            verdict: .green, chipWord: "Green", showsVerdictLabels: false
        )
        #expect(green == AvailabilityHealthChipDisplay(shape: .filledCircle, word: nil))
        let yellow = AvailabilityHealthChipDisplay.make(
            verdict: .yellow, chipWord: "Yellow", showsVerdictLabels: false
        )
        #expect(yellow == AvailabilityHealthChipDisplay(shape: .triangle, word: nil))
        let noData = AvailabilityHealthChipDisplay.make(
            verdict: nil, chipWord: "No data", showsVerdictLabels: false
        )
        #expect(noData == AvailabilityHealthChipDisplay(shape: .hollowRing, word: nil))
    }

    @Test func labelsOnRestoresTheDotPlusWordChip() {
        // Toggle on: today's pre-#242 chip — same shape-coded dot, word
        // beside it.
        let red = AvailabilityHealthChipDisplay.make(
            verdict: .red, chipWord: "Red", showsVerdictLabels: true
        )
        #expect(red == AvailabilityHealthChipDisplay(shape: .octagon, word: "Red"))
        let noData = AvailabilityHealthChipDisplay.make(
            verdict: nil, chipWord: "No data", showsVerdictLabels: true
        )
        #expect(noData == AvailabilityHealthChipDisplay(shape: .hollowRing, word: "No data"))
    }

    @Test @MainActor func deckModelDefaultsToLabelsHidden() {
        // The published mirror the chip reads starts false — a deck that
        // renders before the first settings apply shows dot-only, matching
        // the daemon default.
        let defaults = UserDefaults(suiteName: "issue242-\(UUID().uuidString)") ?? .standard
        let model = DeckPopoverModel(defaults: defaults)
        #expect(!model.showsHealthVerdictLabels)
    }
}
