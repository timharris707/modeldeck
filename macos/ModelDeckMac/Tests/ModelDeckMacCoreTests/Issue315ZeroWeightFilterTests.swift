import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #315: the deck footer's hide/show toggle for zero-weight accounts.
// Tim: "It wouldn't change how anything functions. It would simply just
// hide or show." These tests pin BOTH halves: the visual filter (rows
// DISPLAYING weight 0 disappear; the column count keeps describing the
// whole roster) and the everything-still-counts contract (menu-bar source,
// worst-remaining, Availability Health, row derivation, and change tracking
// all include hidden accounts). Placeholder names/emails only.
//
// Issue #317 repredication: the filter reads the same
// `proxyWeightPresentation` the badge renders, so a Fable-benched row
// showing an effective ⑂ 0 now hides too — the toggle may never disagree
// with the glyph. (#316's live-weight-only judgment failed in the field.)

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
}

private func account(
    _ id: String,
    provider: String = "claude",
    label: String,
    enabled: Bool = true,
    proxyWeight: Int? = nil,
    proxyFableExcluded: Bool? = nil,
    proxyPool: String? = nil
) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: provider,
        label: label,
        identity: "\(id)@example.com",
        enabled: enabled,
        isDefault: false,
        proxyWeight: proxyWeight,
        proxyFableExcluded: proxyFableExcluded,
        proxyPool: proxyPool
    )
}

private func snapshot(
    _ accountId: String,
    scope: String = "5h",
    remaining: Double?,
    resetsIn: TimeInterval = 3_600
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: iso(resetsIn),
        stale: false
    )
}

/// A pool machine's roster (placeholder identities):
/// - c1: routed, weight 5 — visible either way
/// - c2: PARKED, live weight 0, and the deck's lowest % — the account the
///   filter hides and every functional path must still count
/// - c3: unrouted (nil weight) — never hidden; nil is not zero
/// - c4: Fable-benched, live weight 3, displaying its 5-hour window — the
///   badge renders the EFFECTIVE 0, so since #317 the filter hides it too
/// - c5: Fable-benched, live weight 2, displaying its GENERAL WEEKLY
///   window — the badge shows the live 2 (#287), so it stays visible
/// - x1: Codex, weight 0 — hidden in its own column
private func fixtureState() -> DeckState {
    DeckState(
        accounts: [
            account("c1", label: "Studio", proxyWeight: 5),
            account("c2", label: "Client", proxyWeight: 0),
            account("c3", label: "Personal"),
            account("c4", label: "Workshop", proxyWeight: 3, proxyFableExcluded: true),
            account("c5", label: "Atelier", proxyWeight: 2, proxyFableExcluded: true),
            account("x1", provider: "codex", label: "Studio", proxyWeight: 0),
        ],
        usage: [
            snapshot("c1", remaining: 40),
            snapshot("c2", remaining: 5),
            snapshot("c3", remaining: 80),
            snapshot("c4", remaining: 60),
            snapshot("c5", scope: "weekly", remaining: 70),
            snapshot("x1", remaining: 50),
        ]
    )
}

@Suite("Issue #315 zero-weight filter")
@MainActor
struct Issue315ZeroWeightFilterTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "issue315-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    // MARK: The predicate — a row hides exactly when it DISPLAYS ⑂ 0 (#317)

    @Test func rowsDisplayingZeroAreHidden() {
        func row(_ acct: DeckAccount, windows: [DeckWindow] = []) -> DeckAccountRow {
            DeckAccountRow(account: acct, provider: .claude, windows: windows, isActive: false)
        }
        #expect(DeckPopoverModel.isHiddenByZeroWeightFilter(
            row(account("a", label: "Parked", proxyWeight: 0))))
        #expect(!DeckPopoverModel.isHiddenByZeroWeightFilter(
            row(account("b", label: "Routed", proxyWeight: 5))))
        #expect(!DeckPopoverModel.isHiddenByZeroWeightFilter(
            row(account("c", label: "Unrouted"))),
            "nil weight is absence, not zero — an unrouted account stays visible")
        let benched = account("d", label: "Benched", proxyWeight: 3, proxyFableExcluded: true)
        let benchedRow = row(benched)
        #expect(benchedRow.proxyWeightPresentation?.weight == 0,
                "precondition: this row's badge renders the effective 0")
        #expect(DeckPopoverModel.isHiddenByZeroWeightFilter(benchedRow),
            "#317: the row shows ⑂ 0, so the filter must hide it — the toggle may never disagree with the glyph")
        #expect(!DeckPopoverModel.isHiddenByZeroWeightFilter(
            row(account("e", label: "Outside", proxyPool: "absent"))),
            "absent-from-pool renders a glyph-only badge (no number) and stays visible")
    }

    @Test func benchedRowDisplayingGeneralWeeklyShowsLiveWeightAndStaysVisible() {
        // The #287 flip side: on its general-weekly window the badge shows
        // the LIVE weight, so the filter leaves the row alone.
        let state = fixtureState()
        let rows = DeckBuilder.rows(state: state, now: now)
        let c5 = rows.first { $0.id == "c5" }!
        #expect(c5.proxyWeightPresentation?.weight == 2)
        #expect(!DeckPopoverModel.isHiddenByZeroWeightFilter(c5))
    }

    // MARK: Default + persistence (reshaped by #319: the zero-weight filter
    // is now the By-zero-weightings MODE of the Hide/Show system)

    @Test func zeroWeightModeIsNotTheDefault() {
        // #319's armed-but-empty default: master ON, mode By account,
        // nothing manually hidden — so zero-weight rows do NOT hide until
        // this mode is chosen (the #315-era default-off promise, kept).
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(model.hideMode == .byAccount)
        #expect(!model.isRowHidden(
            DeckBuilder.rows(state: fixtureState(), now: now).first { $0.id == "c2" }!,
            now: now))
    }

    @Test func modePersistsAcrossInstances() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.hideMode = .byZeroWeightings
        #expect(DeckPopoverModel(defaults: defaults).hideMode == .byZeroWeightings,
                "a relaunch (fresh model, same defaults) keeps the mode")
        model.hideMode = .byAccount
        #expect(DeckPopoverModel(defaults: defaults).hideMode == .byAccount)
    }

    // MARK: Visual filtering

    @Test func columnsHideOnlyZeroWeightRowsWhenOn() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byZeroWeightings
        let columns = model.columns(for: fixtureState(), now: now)
        let claude = columns.first { $0.provider == .claude }!
        let codex = columns.first { $0.provider == .codex }!
        #expect(Set(claude.rows.map(\.id)) == ["c1", "c3", "c5"])
        #expect(claude.hiddenAccountCount == 2)
        #expect(codex.rows.isEmpty)
        #expect(codex.hiddenAccountCount == 1)
    }

    @Test func columnCountStillDescribesTheWholeRoster() {
        // Tim's minimal hint: the count NOT shrinking is how the deck says
        // rows are filtered, not gone.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byZeroWeightings
        let claude = model.columns(for: fixtureState(), now: now)
            .first { $0.provider == .claude }!
        #expect(claude.rows.count == 3)
        #expect(claude.accountCountText == "5 accounts")
        // Singular form survives the arithmetic.
        #expect(DeckColumn(provider: .codex, rows: [], hiddenAccountCount: 1)
            .accountCountText == "1 account")
    }

    @Test func filterOffIsByteIdenticalToPreFilterDerivation() {
        // #319's default (By account, empty manual list) must render the
        // pre-#315 deck byte-identically — the armed-but-empty contract.
        let model = DeckPopoverModel(defaults: freshDefaults())
        let columns = model.columns(for: fixtureState(), now: now)
        #expect(columns.allSatisfy { $0.hiddenAccountCount == 0 })
        let claude = columns.first { $0.provider == .claude }!
        #expect(Set(claude.rows.map(\.id)) == ["c1", "c2", "c3", "c4", "c5"])
        #expect(claude.accountCountText == "5 accounts")
    }

    @Test func interleavedRowsRespectTheFilter() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.layout = .singleColumn
        model.hideMode = .byZeroWeightings
        let ids = Set(model.interleavedRows(for: fixtureState(), now: now).map(\.id))
        #expect(ids == ["c1", "c3", "c5"])
    }

    // MARK: Hidden accounts still count everywhere non-visual

    @Test func hiddenAccountStillDrivesWorstRemainingAndMenuBarSource() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byZeroWeightings
        let state = fixtureState()
        // c2 (hidden, weight 0) holds the deck's lowest %: the menu-bar
        // number and its source checkmark derivation must still pick it —
        // neither consults the view filter.
        let worst = WorstRemainingCalculator.worstRemaining(in: state, now: now)
        #expect(worst?.accountId == "c2")
        #expect(MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: nil, state: state, worstRemaining: worst) == "c2")
        // And the visible rows genuinely exclude it — same state, same time.
        let visible = model.columns(for: state, now: now).flatMap(\.rows).map(\.id)
        #expect(!visible.contains("c2"))
    }

    @Test func availabilityHealthIsIndifferentToTheFilter() {
        // The engine reads DeckState directly; the filter flag isn't even a
        // parameter. Pinned so a future refactor can't thread the view
        // filter into the health pool without failing here.
        let state = fixtureState()
        let report = AvailabilityHealthEngine.report(for: .claude, state: state, now: now)
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byZeroWeightings
        _ = model.columns(for: state, now: now)
        #expect(AvailabilityHealthEngine.report(for: .claude, state: state, now: now) == report)
    }

    @Test func deckBuilderStillDerivesHiddenRows() {
        // The pure builders stay unfiltered: every non-visual consumer that
        // derives rows (change tracking, capacity mirrors) sees the full
        // roster regardless of the view preference.
        let ids = Set(DeckBuilder.rows(state: fixtureState(), now: now).map(\.id))
        #expect(ids.contains("c2"))
        #expect(ids.contains("x1"))
    }

    @Test func changeTrackingStillCoversHiddenAccounts() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byZeroWeightings
        var state = fixtureState()
        model.captureUsageChanges(state: state, now: now)
        // c2's headline moves between opens; the tracker must report it
        // even though the row is hidden — the filter is presentation-only.
        state.usage = state.usage.map {
            $0.accountId == "c2" ? snapshot("c2", remaining: 3) : $0
        }
        model.captureUsageChanges(state: state, now: now)
        #expect(model.usageChange(for: "c2") != nil)
    }

    // MARK: Footer glyph derivation (the #319 master eye replaces the
    // #315 weights-only gating — By account works on every machine, so the
    // eye now renders on any populated deck; `isHidingAnyRow` drives its
    // glyph instead)

    @Test func isHidingAnyRowTracksActualHiding() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(!model.isHidingAnyRow(state: fixtureState(), now: now),
                "armed-but-empty default hides nothing, so the glyph stays the plain eye")
        model.hideMode = .byZeroWeightings
        #expect(model.isHidingAnyRow(state: fixtureState(), now: now))
        model.hideShowEnabled = false
        #expect(!model.isHidingAnyRow(state: fixtureState(), now: now),
                "master OFF shows everything regardless of mode")
    }
}
