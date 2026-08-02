import XCTest
@testable import ModelDeckMacCore

// CLIProxyAPI weight display: the additive per-account `proxyWeight` from
// /api/state decodes tolerantly (absent on machines without the proxy, on
// unrouted accounts, and on pre-feature daemons — nothing renders), and
// weight 0 is a real value ("the proxy has parked this account"), never
// collapsed into absence. All account names are synthetic fixtures.

final class ProxyWeightTests: XCTestCase {
    private func account(_ extra: String) throws -> DeckAccount {
        let json = """
        {
          "id": "a1", "provider": "claude", "label": "Studio",
          "enabled": true, "isDefault": false\(extra)
        }
        """
        return try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
    }

    func testAbsentWeightDecodesNil() throws {
        // Pre-feature daemon / no proxy installed: the key is simply absent.
        XCTAssertNil(try account("").proxyWeight)
    }

    func testPresentWeightDecodes() throws {
        XCTAssertEqual(try account(#", "proxyWeight": 8"#).proxyWeight, 8)
    }

    func testZeroWeightIsAValueNotAbsence() throws {
        XCTAssertEqual(try account(#", "proxyWeight": 0"#).proxyWeight, 0)
    }

    func testStateLevelDecodeCarriesWeightsThrough() throws {
        let json = """
        {
          "accounts": [
            { "id": "a1", "provider": "claude", "label": "Studio",
              "enabled": true, "isDefault": true, "proxyWeight": 10 },
            { "id": "a2", "provider": "codex", "label": "Workshop",
              "enabled": true, "isDefault": false }
          ],
          "usage": []
        }
        """
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        XCTAssertEqual(state.accounts.first?.proxyWeight, 10)
        XCTAssertNil(state.accounts.last?.proxyWeight, "an unrouted sibling stays weightless")
    }
}
