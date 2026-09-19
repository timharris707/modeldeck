import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #377 — a mid-session model drop must be LOUD on the Mac surfaces.
//
// TRIPWIRE model-drop-notice (Swift half): pins that a drop in `/api/state`
// decodes, says WHY and WHEN, reaches the deck's always-visible HEADER stack
// (not a detail surface), and posts a macOS banner. Deleting the banner, the
// header wiring, or the why/when text fails this suite.
@Suite("Mid-session model drop (issue #377)")
struct ModelDropTests {
    private static let quotaPayload = #"""
    {
      "accounts": [],
      "usage": [],
      "modelDrop": {
        "quotaPercent": 95,
        "drops": [{
          "sessionId": "aaaaaaaa-0000-4000-8000-placeholder1",
          "accountId": "placeholder-account",
          "accountLabel": "Drop Placeholder",
          "fromModel": "claude-fable-5",
          "fromModelDisplay": "Fable 5",
          "toModel": "claude-opus-5",
          "toModelDisplay": "Opus 5",
          "droppedAt": "2026-08-15T10:05:00.000Z",
          "cwd": "/placeholder/workspace",
          "reason": "quota-exhausted",
          "windowScope": "Fable weekly",
          "windowUsedPercent": 100,
          "returnsAt": "2026-08-18T00:00:00.000Z",
          "available": false,
          "remedy": "Run /model claude-fable-5 in that session once the window resets."
        }]
      }
    }
    """#

    private static func decodeDrop(_ payload: String) throws -> ModelDropAlert {
        let state = try JSONDecoder().decode(DeckState.self, from: Data(payload.utf8))
        return try #require(state.modelDrop?.drops.first)
    }

    @Test("the daemon state decodes the drop with what, why, when, and the way back")
    func decodesDrop() throws {
        let drop = try Self.decodeDrop(Self.quotaPayload)
        #expect(drop.id == "placeholder-account:aaaaaaaa-0000-4000-8000-placeholder1")
        #expect(drop.headline == "Drop Placeholder session dropped Fable 5 → Opus 5")
        // WHY and WHEN, both stated.
        #expect(drop.explanation.contains("Fable weekly"))
        #expect(drop.explanation.contains("100% used"))
        #expect(drop.explanation.contains("Fable 5 returns"))
        // The way back names the command the user runs in their OWN session —
        // ModelDeck never acts on a running session (safety contract).
        #expect(drop.remedy.contains("/model claude-fable-5"))
        #expect(drop.available == false)
    }

    @Test("an unproven cause is admitted, never invented")
    func unknownCauseStaysUnknown() throws {
        let payload = Self.quotaPayload
            .replacingOccurrences(of: "\"reason\": \"quota-exhausted\"", with: "\"reason\": \"unknown\"")
            .replacingOccurrences(of: "\"windowScope\": \"Fable weekly\"", with: "\"windowScope\": null")
        let drop = try Self.decodeDrop(payload)
        #expect(drop.explanation.hasPrefix("Reason unknown"))
    }

    @Test("a missing display name falls back to the raw model id")
    func fallsBackToModelId() throws {
        let payload = Self.quotaPayload
            .replacingOccurrences(of: "\"fromModelDisplay\": \"Fable 5\"", with: "\"fromModelDisplay\": null")
            .replacingOccurrences(of: "\"toModelDisplay\": \"Opus 5\"", with: "\"toModelDisplay\": null")
        let drop = try Self.decodeDrop(payload)
        #expect(drop.headline == "Drop Placeholder session dropped claude-fable-5 → claude-opus-5")
    }

    @Test("older or malformed drop blocks never break the account deck")
    func toleratesVersionSkew() throws {
        for payload in [
            #"{"accounts":[],"usage":[]}"#,
            #"{"accounts":[],"usage":[],"modelDrop":"future-shape"}"#,
        ] {
            let state = try JSONDecoder().decode(DeckState.self, from: Data(payload.utf8))
            #expect(state.modelDrop == nil)
        }
    }

    @Test("a banner is posted when the drop lands, and again when the model returns")
    func postsBannerOnDropAndOnReturn() async throws {
        let poster = RecordingPoster()
        let coordinator = await ModelDropNotificationCoordinator(poster: poster)
        let dropped = try JSONDecoder().decode(DeckState.self, from: Data(Self.quotaPayload.utf8))

        await coordinator.evaluate(state: dropped)
        var posted = await poster.posted
        #expect(posted.count == 1)
        #expect(posted[0].title == "Model dropped: Fable 5 → Opus 5")

        // A second identical state must not re-announce — the deck header
        // carries the standing state; the banner marks the EVENT.
        await coordinator.evaluate(state: dropped)
        posted = await poster.posted
        #expect(posted.count == 1)

        let backPayload = Self.quotaPayload
            .replacingOccurrences(of: "\"available\": false", with: "\"available\": true")
        let back = try JSONDecoder().decode(DeckState.self, from: Data(backPayload.utf8))
        await coordinator.evaluate(state: back)
        posted = await poster.posted
        #expect(posted.count == 2)
        #expect(posted[1].title == "Fable 5 is available again")

        // Cleared drop → memory released, so a later recurrence announces.
        let clear = try JSONDecoder().decode(
            DeckState.self,
            from: Data(#"{"accounts":[],"usage":[],"modelDrop":{"quotaPercent":95,"drops":[]}}"#.utf8)
        )
        await coordinator.evaluate(state: clear)
        await coordinator.evaluate(state: dropped)
        posted = await poster.posted
        #expect(posted.count == 3)

        // An older daemon (no modelDrop block) must not wipe live memory.
        let legacy = try JSONDecoder().decode(DeckState.self, from: Data(#"{"accounts":[],"usage":[]}"#.utf8))
        await coordinator.evaluate(state: legacy)
        await coordinator.evaluate(state: dropped)
        posted = await poster.posted
        #expect(posted.count == 3)
    }

    // CodeRabbit (PR #472, major): the poster keys its notification identifier
    // off the alert LEVEL alone — one banner per level, replacement being the
    // wanted behaviour for usage alerts. Model drops riding that namespace lost
    // banners two ways: two sessions dropping in the same pass both post at
    // .critical and the second replaced the first, and a drop banner and a live
    // usage banner clobbered each other.
    @Test("model-drop banners get their own identifier space, per session")
    func dropBannersDoNotCollide() throws {
        func drop(_ session: String) -> ModelDropAlert {
            ModelDropAlert(
                sessionId: session,
                accountId: "placeholder-account",
                accountLabel: "Drop Placeholder",
                fromModel: "claude-fable-5",
                toModel: "claude-opus-5"
            )
        }
        let first = drop("session-placeholder-1")
        let alertOne = try #require(ModelDropAlertPlanner.alert(drop: first, announced: nil))
        let alertTwo = try #require(ModelDropAlertPlanner.alert(drop: drop("session-placeholder-2"), announced: nil))
        // Both are .critical, exactly as usage alerts are — the level can no
        // longer be the whole identity.
        #expect(alertOne.level == .critical)
        #expect(alertTwo.level == .critical)
        #expect(alertOne.identityKey == "modeldrop.placeholder-account:session-placeholder-1")
        #expect(alertTwo.identityKey == "modeldrop.placeholder-account:session-placeholder-2")
        #expect(alertOne.identityKey != alertTwo.identityKey, "two sessions dropping at once both get announced")

        // The available-again banner is a further event for the SAME session,
        // so it replaces that session's own drop banner and nothing else.
        var back = first
        back.available = true
        let recovery = try #require(ModelDropAlertPlanner.alert(drop: back, announced: .dropped))
        #expect(recovery.identityKey == alertOne.identityKey)

        // Usage alerts keep the historical level-keyed identifier: a fresh
        // usage banner must still REPLACE the stale one for its level.
        let usage = try #require(UsageAlertPlanner.alert(
            previous: .none,
            worst: WorstRemaining(percent: 2, accountId: "placeholder-account", scope: "weekly"),
            state: nil,
            thresholds: .default
        ))
        #expect(usage.identityKey == nil)
    }

    @Test("the poster honours the alert's identity and keeps the usage fallback")
    func posterUsesIdentityKey() throws {
        // Issue #685 moved the identifier rule from the app-target poster
        // into Core (UserNotificationRequestSpec.usage) so it is unit-tested
        // directly; the poster now delivers whatever the spec says. Scan the
        // rule where it lives, and pin that the poster still goes through it.
        let spec = try String(
            contentsOf: Self.packageRoot.appendingPathComponent("Sources/ModelDeckMacCore/UserNotificationRouting.swift"),
            encoding: .utf8
        )
        #expect(spec.contains("alert.identityKey"))
        #expect(
            spec.contains("modeldeck.usage.level-\\(alert.level.rawValue)"),
            "usage replacement semantics survive"
        )
        let poster = try String(
            contentsOf: Self.packageRoot.appendingPathComponent("Sources/ModelDeckMac/UserNotificationCenterPoster.swift"),
            encoding: .utf8
        )
        #expect(poster.contains(".usage(alert)"), "the poster derives its request from the Core spec")
        let drop = UserNotificationRequestSpec.usage(
            UsageAlert(level: .critical, title: "T", body: "B", identityKey: "modeldrop.placeholder"))
        #expect(drop.identifier == "modeldeck.modeldrop.placeholder")
        let usage = UserNotificationRequestSpec.usage(UsageAlert(level: .warning, title: "T", body: "B"))
        #expect(usage.identifier == "modeldeck.usage.level-1")
    }

    static var packageRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    @Test("the live drop is wired into the deck header, not a detail surface")
    func deckHeaderCarriesDrop() throws {
        let source = try String(
            contentsOf: Self.packageRoot.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
        // Ordered, not adjacent (#395's lesson: a same-night merge can insert
        // a banner between two that used to be neighbours). The claim is
        // placement in the HEADER stack, above the account content.
        let anchors = [
            "connectionBanner",
            "memberBlackoutBanner",
            "modelDropBanner",
            "installProgressLine\n            content",
        ]
        let positions = anchors.map { source.range(of: $0)?.lowerBound }
        #expect(positions.allSatisfy { $0 != nil })
        #expect(positions.compactMap { $0 } == positions.compactMap { $0 }.sorted())
        // All three lines render: what, why, and the way back.
        #expect(source.contains("Label(drop.headline, systemImage: \"arrow.down.right.circle.fill\")"))
        #expect(source.contains("Text(drop.explanation)"))
        #expect(source.contains("Text(drop.remedy)"))
        #expect(source.contains("Model drop. \\(message)"))
        // CodeRabbit (PR #472): the header stack is not scrollable, so an
        // unbounded ForEach over drops could push the account content off
        // screen. Assert the CALL SITES, not the names in the comment beside
        // them — the first version of this check passed against a mutation
        // that removed the cap, because the comment still mentioned it.
        #expect(source.contains("ForEach(ModelDropAlert.rendered(drops))"))
        #expect(source.contains("ModelDropAlert.overflowLine(drops)"))
    }

    @Test("the deck renders a bounded number of drop banners and counts the rest")
    func rendersBoundedBanners() {
        let drops = (1...(ModelDropAlert.maxRenderedBanners + 4)).map { index in
            ModelDropAlert(
                sessionId: "session-placeholder-\(index)",
                accountId: "placeholder-account",
                accountLabel: "Drop Placeholder",
                fromModel: "claude-fable-5",
                toModel: "claude-opus-5"
            )
        }
        #expect(ModelDropAlert.rendered(drops).count == ModelDropAlert.maxRenderedBanners)
        #expect(ModelDropAlert.overflowLine(drops) == "4 more sessions dropped their model.")
        #expect(ModelDropAlert.overflowLine(Array(drops.prefix(2))) == nil)
    }

    @Test("the return time follows the user's locale and hour preference")
    func returnTimeIsLocalized() throws {
        // CodeRabbit (PR #472): a hardcoded "EEE h:mm a" forces a 12-hour clock
        // and a fixed field order on every user. The formatter must be built
        // from a localized template instead.
        let source = try String(
            contentsOf: Self.packageRoot.appendingPathComponent("Sources/ModelDeckMacCore/DaemonModels.swift"),
            encoding: .utf8
        )
        #expect(source.contains("setLocalizedDateFormatFromTemplate"))
        #expect(source.contains("locale = Locale.current"), "the locale is set BEFORE the template")
        #expect(source.contains("dateFormat = \"EEE h:mm a\"") == false, "no hardcoded 12-hour format")
        // The behaviour, not just the call: a 24-hour locale renders no AM/PM.
        let drop = try Self.decodeDrop(Self.quotaPayload)
        #expect(drop.explanation.contains("Fable 5 returns"))
    }
}

private actor RecordingPoster: UserNotificationPosting {
    private(set) var posted: [UsageAlert] = []

    func post(_ alert: UsageAlert) async {
        posted.append(alert)
    }
}
