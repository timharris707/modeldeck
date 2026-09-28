import Foundation
import Testing
@testable import ModelDeckMacCore

@Suite("Routed-member blackout alert (issue #395)")
struct MemberBlackoutTests {
    @Test("the daemon state decodes the account, streak, status, and remedy")
    func decodesAlert() throws {
        let payload = #"""
        {
          "accounts": [],
          "usage": [],
          "memberBlackout": {
            "threshold": 3,
            "alerts": [{
              "accountId": "placeholder-account",
              "provider": "claude",
              "label": "Blackout Placeholder",
              "consecutiveFailures": 3,
              "firstFailureAt": "2026-08-14T12:00:00.000Z",
              "lastFailureAt": "2026-08-14T12:02:00.000Z",
              "statusCode": 401,
              "remedy": "Sign in again to restore proxy routing."
            }]
          }
        }
        """#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(payload.utf8))
        #expect(state.memberBlackout?.threshold == 3)
        let alert = try #require(state.memberBlackout?.alerts.first)
        #expect(alert.id == "placeholder-account")
        #expect(alert.statusCode == 401)
        #expect(alert.statusLine == "Blackout Placeholder: last 3 requests failed")
        #expect(alert.remedy == "Sign in again to restore proxy routing.")
    }

    @Test("older or malformed alert blocks never break the account deck")
    func toleratesVersionSkew() throws {
        for payload in [
            #"{"accounts":[],"usage":[]}"#,
            #"{"accounts":[],"usage":[],"memberBlackout":"future-shape"}"#,
        ] {
            let state = try JSONDecoder().decode(DeckState.self, from: Data(payload.utf8))
            #expect(state.memberBlackout == nil)
        }
    }

    @Test("the live alert is wired into the deck header, not a detail surface")
    func deckHeaderCarriesAlert() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
        // Ordered, not adjacent: #422's onboarding card sits between the
        // connection and proxy banners (a same-night merge broke the old
        // adjacency string on main — two green PRs, one red composition).
        // The tripwire's claim is placement in the HEADER stack, above the
        // account content, so assert order against `content` instead.
        let anchors = ["connectionBanner", "proxyBanner", "memberBlackoutBanner", "installProgressLine\n            DeckCardScroller { content }"]
        let positions = anchors.map { source.range(of: $0)?.lowerBound }
        #expect(positions.allSatisfy { $0 != nil })
        #expect(positions.compactMap { $0 } == positions.compactMap { $0 }.sorted())
        // #537: the visible line is the evidence alone; the remedy sentence
        // lives only in the tooltip/VoiceOver message. (#539 made the line and
        // the glyph state-dependent; the red state's own text is unchanged.)
        #expect(source.contains("Label(visible, systemImage: icon)"))
        #expect(source.contains("\"exclamationmark.octagon.fill\""))
        #expect(source.contains(#"alert.repairedStatusLine : "\(alert.statusLine)\(httpStatus)""#))
        #expect(source.contains("Pool alert. \\(message)"))
    }
}
