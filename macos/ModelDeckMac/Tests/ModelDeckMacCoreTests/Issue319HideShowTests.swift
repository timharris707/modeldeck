import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #319: the Hide/Show Accounts system — master switch (default ON),
// three mutually exclusive modes (By account / By resets / By zero
// weightings), the right-click manual override, and the migration from the
// 0.4.1 eye toggle. Per the grilled design (Tim-confirmed on the issue):
// the By-resets horizon is a fixed DROPDOWN of rolling windows (12 hours …
// "7 days (All)", default 24 hours), and manual wins BOTH ways — Hide
// always hides, Show pins visible even outside the window. Every mode
// keeps the #315/#316/#317 visual-only contract: nothing here may touch
// routing, health, renewal, or the menu-bar number, and counts keep
// stating roster totals. Placeholder names/emails only.

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
    proxyFableExcluded: Bool? = nil
) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: provider,
        label: label,
        identity: "\(id)@example.com",
        enabled: enabled,
        isDefault: false,
        proxyWeight: proxyWeight,
        proxyFableExcluded: proxyFableExcluded
    )
}

private func snapshot(
    _ accountId: String,
    scope: String = "weekly",
    remaining: Double? = 50,
    resetsAt: String?
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: resetsAt,
        stale: false
    )
}

/// A roster whose displayed (single-window) resets span the horizon menu:
/// - r1 resets in 18 hours — inside 24 hours, OUTSIDE 12 hours (the pair
///   that proves the windows roll from now)
/// - r2 resets in 3 days
/// - r3 resets in 6.5 days
/// - r4 reports NO reset timestamp — the filter can't judge it, so it must
///   stay visible under every horizon
/// - r5 is the deck's lowest % AND resets furthest out, so hiding it is the
///   sharpest probe of the visual-only contract
private func resetsFixture() -> DeckState {
    DeckState(
        accounts: [
            account("r1", label: "Studio"),
            account("r2", label: "Client"),
            account("r3", label: "Workshop"),
            account("r4", label: "Personal"),
            account("r5", label: "Atelier"),
        ],
        usage: [
            snapshot("r1", resetsAt: iso(18 * 3_600)),
            snapshot("r2", resetsAt: iso(3 * 86_400)),
            snapshot("r3", resetsAt: iso(6.5 * 86_400)),
            snapshot("r4", resetsAt: nil),
            snapshot("r5", remaining: 4, resetsAt: iso(6.9 * 86_400)),
        ]
    )
}

/// The #315 pool fixture shape, for the By-zero-weightings mode: z2 is
/// parked (live 0), z4 is Fable-benched displaying its effective 0.
private func poolFixture() -> DeckState {
    DeckState(
        accounts: [
            account("z1", label: "Studio", proxyWeight: 5),
            account("z2", label: "Client", proxyWeight: 0),
            account("z3", label: "Personal"),
            account("z4", label: "Workshop", proxyWeight: 3, proxyFableExcluded: true),
        ],
        usage: [
            snapshot("z1", scope: "5h", remaining: 40, resetsAt: iso(3_600)),
            snapshot("z2", scope: "5h", remaining: 5, resetsAt: iso(3_600)),
            snapshot("z3", scope: "5h", remaining: 80, resetsAt: iso(3_600)),
            snapshot("z4", scope: "5h", remaining: 60, resetsAt: iso(3_600)),
        ]
    )
}

@Suite("Issue #319 Hide/Show Accounts")
@MainActor
struct Issue319HideShowTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "issue319-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func claudeColumn(
        _ model: DeckPopoverModel, _ state: DeckState
    ) -> DeckColumn {
        model.columns(for: state, now: now).first { $0.provider == .claude }!
    }

    private func row(_ id: String, in state: DeckState) -> DeckAccountRow {
        DeckBuilder.rows(state: state, now: now).first { $0.id == id }!
    }

    // MARK: Defaults — armed but empty

    @Test func defaultIsOnByAccountAndHidesNothing() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(model.hideShowEnabled, "the master switch defaults ON")
        #expect(model.hideMode == .byAccount)
        #expect(model.hideResetsHorizon == .oneDay, "dropdown defaults to 24 hours")
        #expect(model.manuallyHiddenAccountIDs.isEmpty)
        #expect(model.manuallyShownAccountIDs.isEmpty)
        let claude = claudeColumn(model, resetsFixture())
        #expect(claude.rows.count == 5, "armed-but-empty: nothing hides until the user acts")
        #expect(claude.hiddenAccountCount == 0)
    }

    // MARK: Migration from the 0.4.1 eye toggle

    @Test func legacyEyeOnMapsToZeroWeightingsMode() {
        let defaults = freshDefaults()
        defaults.set(true, forKey: DeckPopoverModel.hideZeroWeightDefaultsKey)
        let model = DeckPopoverModel(defaults: defaults)
        #expect(model.hideShowEnabled)
        #expect(model.hideMode == .byZeroWeightings,
                "a 0.4.1 user hiding zero-weight rows keeps exactly that behavior")
    }

    @Test func legacyEyeOffLandsOnTheByAccountDefault() {
        let defaults = freshDefaults()
        defaults.set(false, forKey: DeckPopoverModel.hideZeroWeightDefaultsKey)
        #expect(DeckPopoverModel(defaults: defaults).hideMode == .byAccount)
    }

    @Test func explicitStoredModeBeatsTheLegacyKey() {
        // Once the new mode key exists, the legacy key is history — a later
        // switch away from By zero weightings must stick across relaunches.
        let defaults = freshDefaults()
        defaults.set(true, forKey: DeckPopoverModel.hideZeroWeightDefaultsKey)
        let model = DeckPopoverModel(defaults: defaults)
        model.hideMode = .byResets
        #expect(DeckPopoverModel(defaults: defaults).hideMode == .byResets)
    }

    // MARK: Persistence (all five pieces of state)

    @Test func allStatePersistsAcrossInstances() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.toggleHideShowSystem() // OFF
        model.hideMode = .byResets
        model.hideResetsHorizon = .fourDays
        model.setManualVisibility(.hidden, for: "r2")
        model.setManualVisibility(.shown, for: "r5")
        model.setManualVisibility(.hidden, for: "r3")
        model.setManualVisibility(nil, for: "r3") // and cleared again
        let relaunched = DeckPopoverModel(defaults: defaults)
        #expect(relaunched.hideShowEnabled == false)
        #expect(relaunched.hideMode == .byResets)
        #expect(relaunched.hideResetsHorizon == .fourDays)
        #expect(relaunched.manuallyHiddenAccountIDs == ["r2"])
        #expect(relaunched.manuallyShownAccountIDs == ["r5"],
                "a Show pin persists across launches")
    }

    @Test func masterSwitchRoundTripKeepsEverythingElse() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.hideMode = .byResets
        model.hideResetsHorizon = .threeDays
        model.setManualVisibility(.hidden, for: "r1")
        model.toggleHideShowSystem()
        model.toggleHideShowSystem()
        #expect(model.hideShowEnabled)
        #expect(model.hideMode == .byResets)
        #expect(model.hideResetsHorizon == .threeDays)
        #expect(model.manuallyHiddenAccountIDs == ["r1"])
    }

    // MARK: Mutual exclusivity

    @Test func modesAreMutuallyExclusive() {
        // A single enum value IS the exclusivity; switching modes swaps the
        // whole hiding rule rather than stacking. z2 (weight 0) hides only
        // in By zero weightings; a manual hide applies only outside it.
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = poolFixture()
        model.hideMode = .byZeroWeightings
        #expect(!claudeColumn(model, state).rows.map(\.id).contains("z2"))
        model.hideMode = .byAccount
        let byAccount = claudeColumn(model, state)
        #expect(byAccount.rows.map(\.id).contains("z2"),
                "leaving By zero weightings un-hides the automatic set")
        #expect(byAccount.hiddenAccountCount == 0)
    }

    // MARK: The horizon dropdown (grilled design: fixed options, not a stepper)

    @Test func horizonOptionsOrderAndLabels() {
        #expect(DeckPopoverModel.DeckResetsHorizon.allCases == [
            .twelveHours, .oneDay, .twoDays, .threeDays,
            .fourDays, .fiveDays, .sixDays, .sevenDays,
        ], "the dropdown renders allCases in this exact order")
        #expect(DeckPopoverModel.DeckResetsHorizon.allCases.map(\.displayName) == [
            "12 hours", "24 hours", "2 days", "3 days",
            "4 days", "5 days", "6 days", "7 days (All)",
        ])
        #expect(DeckPopoverModel.DeckResetsHorizon.twelveHours.interval == 12 * 3_600)
        #expect(DeckPopoverModel.DeckResetsHorizon.sevenDays.interval == 7 * 86_400)
    }

    @Test func horizonPersistsAcrossInstances() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.hideResetsHorizon = .twelveHours
        #expect(DeckPopoverModel(defaults: defaults).hideResetsHorizon == .twelveHours)
    }

    @Test func legacyStepperDaysMigrateToTheDropdown() {
        // A stored day count from the short-lived stepper maps to its
        // matching case; out-of-range clamps into 1...7 first; the old
        // 1-day default lands on the new 24-hour default.
        for (days, expected) in [
            (1, DeckPopoverModel.DeckResetsHorizon.oneDay),
            (4, .fourDays),
            (7, .sevenDays),
            (99, .sevenDays),
            (-3, .oneDay),
        ] {
            let defaults = freshDefaults()
            defaults.set(days, forKey: DeckPopoverModel.hideShowResetsDaysDefaultsKey)
            #expect(DeckPopoverModel(defaults: defaults).hideResetsHorizon == expected,
                    "\(days) days should migrate to \(expected)")
        }
        // An explicit horizon selection always beats the legacy day count.
        let defaults = freshDefaults()
        defaults.set(3, forKey: DeckPopoverModel.hideShowResetsDaysDefaultsKey)
        defaults.set(DeckPopoverModel.DeckResetsHorizon.twelveHours.rawValue,
                     forKey: DeckPopoverModel.hideShowResetsHorizonDefaultsKey)
        #expect(DeckPopoverModel(defaults: defaults).hideResetsHorizon == .twelveHours)
    }

    // MARK: By account — the manual list

    @Test func byAccountHidesExactlyTheManualList() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.setManualVisibility(.hidden, for: "r2")
        model.setManualVisibility(.hidden, for: "r5")
        let claude = claudeColumn(model, resetsFixture())
        #expect(Set(claude.rows.map(\.id)) == ["r1", "r3", "r4"])
        #expect(claude.hiddenAccountCount == 2)
        #expect(claude.accountCountText == "5 accounts",
                "the count keeps stating the roster total")
    }

    @Test func manualListIsKeyedToAccountIdentityNotPosition() {
        // The same manual hide follows its account through roster churn:
        // remove a sibling, add a new one — r2 stays the hidden row.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.setManualVisibility(.hidden, for: "r2")
        var state = resetsFixture()
        state.accounts.removeAll { $0.id == "r1" }
        state.accounts.append(account("r6", label: "Annex"))
        state.usage.append(snapshot("r6", resetsAt: iso(3_600)))
        let visible = Set(claudeColumn(model, state).rows.map(\.id))
        #expect(!visible.contains("r2"))
        #expect(visible == ["r3", "r4", "r5", "r6"])
    }

    @Test func masterOffShowsManuallyHiddenRowsWithoutForgettingThem() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.setManualVisibility(.hidden, for: "r2")
        model.hideShowEnabled = false
        #expect(claudeColumn(model, resetsFixture()).rows.count == 5)
        #expect(model.isManuallyHidden("r2"),
                "OFF is a view state; the list survives for the next ON")
    }

    // MARK: By resets — rolling horizon windows

    @Test func renewalHorizonPredicate() {
        let state = resetsFixture()
        #expect(!DeckPopoverModel.renewsWithinResetHorizon(
            row("r1", in: state), horizon: .twelveHours, now: now),
            "r1 resets in 18 h — outside a 12-hour window rolling from now")
        #expect(DeckPopoverModel.renewsWithinResetHorizon(
            row("r1", in: state), horizon: .oneDay, now: now))
        #expect(!DeckPopoverModel.renewsWithinResetHorizon(
            row("r2", in: state), horizon: .oneDay, now: now))
        #expect(DeckPopoverModel.renewsWithinResetHorizon(
            row("r2", in: state), horizon: .threeDays, now: now),
            "a reset landing exactly on the horizon counts as within it")
        #expect(!DeckPopoverModel.renewsWithinResetHorizon(
            row("r3", in: state), horizon: .sixDays, now: now))
        #expect(DeckPopoverModel.renewsWithinResetHorizon(
            row("r3", in: state), horizon: .sevenDays, now: now))
        #expect(DeckPopoverModel.renewsWithinResetHorizon(
            row("r4", in: state), horizon: .twelveHours, now: now),
            "no displayed reset — the filter can't judge, so the row stays visible")
    }

    @Test func byResetsHidesBeyondTheHorizon() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byResets
        let state = resetsFixture()
        // Default 24 hours: r1 (18 h) and undated r4 stay.
        var claude = claudeColumn(model, state)
        #expect(Set(claude.rows.map(\.id)) == ["r1", "r4"])
        #expect(claude.hiddenAccountCount == 3)
        #expect(claude.accountCountText == "5 accounts")
        // Tighten to 12 hours: the window rolls from now, so r1 (18 h) hides.
        model.hideResetsHorizon = .twelveHours
        #expect(Set(claudeColumn(model, state).rows.map(\.id)) == ["r4"])
        // Widen to 4 days: r2 (3 d) comes back too.
        model.hideResetsHorizon = .fourDays
        claude = claudeColumn(model, state)
        #expect(Set(claude.rows.map(\.id)) == ["r1", "r2", "r4"])
        // 7 days (All) includes everything.
        model.hideResetsHorizon = .sevenDays
        #expect(claudeColumn(model, state).rows.count == 5)
    }

    // MARK: Manual wins both ways (grilled design)

    @Test func manualHideWinsInsideTheWindow() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byResets // 24 h default: r1 would be visible
        model.setManualVisibility(.hidden, for: "r1")
        let claude = claudeColumn(model, resetsFixture())
        #expect(!claude.rows.map(\.id).contains("r1"),
                "a manual Hide hides an account even when it resets inside the window")
        #expect(Set(claude.rows.map(\.id)) == ["r4"])
        #expect(claude.hiddenAccountCount == 4)
    }

    @Test func manualShowPinsOutsideTheWindow() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byResets // 24 h default: r5 (6.9 d) would hide
        model.setManualVisibility(.shown, for: "r5")
        let claude = claudeColumn(model, resetsFixture())
        #expect(claude.rows.map(\.id).contains("r5"),
                "a manual Show pins an account visible even when it resets outside the window")
        #expect(Set(claude.rows.map(\.id)) == ["r1", "r4", "r5"])
    }

    @Test func peekingWithTheEyeOffOffersShowAndTheShowPersistsAsAPin() {
        // The full flow from the grilled design: window-hidden row → eye
        // off (peek) → right-click reads "Show on Deck" → click → pin
        // persists across relaunch and keeps the row visible once the eye
        // is back on.
        let defaults = freshDefaults()
        let state = resetsFixture()
        let model = DeckPopoverModel(defaults: defaults)
        model.hideMode = .byResets
        #expect(!claudeColumn(model, state).rows.map(\.id).contains("r5"))
        model.toggleHideShowSystem() // eye off — peeking
        #expect(claudeColumn(model, state).rows.map(\.id).contains("r5"))
        #expect(model.manualToggleOffersShow(row("r5", in: state), now: now),
                "the line reads Show on Deck: the mode would hide this row")
        model.toggleManualVisibility(row("r5", in: state), now: now)
        #expect(model.manuallyShownAccountIDs == ["r5"])
        let relaunched = DeckPopoverModel(defaults: defaults)
        relaunched.toggleHideShowSystem() // eye back on
        #expect(relaunched.hideShowEnabled)
        #expect(claudeColumn(relaunched, state).rows.map(\.id).contains("r5"),
                "the persisted pin keeps r5 visible under the 24 h horizon")
    }

    @Test func contextMenuLabelFollowsTheModeVerdict() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        // By account: a visible row offers Hide; once hidden it offers Show.
        #expect(!model.manualToggleOffersShow(row("r2", in: state), now: now))
        model.toggleManualVisibility(row("r2", in: state), now: now)
        #expect(model.manuallyHiddenAccountIDs == ["r2"])
        #expect(model.manualToggleOffersShow(row("r2", in: state), now: now))
        // Show in By account returns the row to NEUTRAL, never a pin
        // (Tim: "Pin only in By resets").
        model.toggleManualVisibility(row("r2", in: state), now: now)
        #expect(model.manuallyHiddenAccountIDs.isEmpty)
        #expect(model.manuallyShownAccountIDs.isEmpty,
                "By-account Show clears, it does not pin")
        #expect(!model.manualToggleOffersShow(row("r2", in: state), now: now))
    }

    @Test func showPinsOnlyInByResets() {
        // The same Show click is mode-shaped: in By resets it creates the
        // .shown pin; in By account it clears to neutral.
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        model.hideMode = .byResets
        #expect(model.manualToggleOffersShow(row("r5", in: state), now: now))
        model.toggleManualVisibility(row("r5", in: state), now: now)
        #expect(model.manuallyShownAccountIDs == ["r5"], "By-resets Show pins")
        model.hideMode = .byAccount
        model.setManualVisibility(.hidden, for: "r2")
        model.toggleManualVisibility(row("r2", in: state), now: now) // Show
        #expect(model.manualVisibility(for: "r2") == nil, "By-account Show neutralizes")
    }

    @Test func byAccountShowIsTheEscapeHatchForAStalePin() {
        // A pin picked up in By resets can be shed in By account: the
        // pinned row reads Hide there (it's visible), Hide replaces the
        // pin with .hidden, and the follow-up Show lands on neutral.
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        model.hideMode = .byResets
        model.toggleManualVisibility(row("r5", in: state), now: now) // pin
        #expect(model.manuallyShownAccountIDs == ["r5"])
        model.hideMode = .byAccount
        #expect(!model.manualToggleOffersShow(row("r5", in: state), now: now),
                "a pinned row is visible in By account, so the line reads Hide")
        model.toggleManualVisibility(row("r5", in: state), now: now) // Hide
        #expect(model.manualVisibility(for: "r5") == .hidden)
        model.toggleManualVisibility(row("r5", in: state), now: now) // Show
        #expect(model.manualVisibility(for: "r5") == nil,
                "the stale pin is gone — r5 is back on automatic rules")
    }

    // MARK: Peek dimming (design record item 7)

    @Test func peekDimsExactlyTheWouldBeHiddenRows() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byResets // 24 h default hides r2, r3, r5
        let rows = DeckBuilder.rows(state: resetsFixture(), now: now)
        // Master ON: hidden rows are absent, visible rows never dim.
        #expect(rows.allSatisfy { !model.isRowDimmedForPeek($0, now: now) })
        model.toggleHideShowSystem() // eye off — peeking
        let dimmed = Set(rows.filter { model.isRowDimmedForPeek($0, now: now) }.map(\.id))
        let wouldHide = Set(rows.filter { model.hiddenUnderCurrentMode($0, now: now) }.map(\.id))
        #expect(dimmed == wouldHide, "the dimmed set IS the would-be-hidden set")
        #expect(dimmed == ["r2", "r3", "r5"])
        // A Show pin (made while peeking) lifts the dim immediately.
        model.toggleManualVisibility(rows.first { $0.id == "r5" }!, now: now)
        #expect(!model.isRowDimmedForPeek(rows.first { $0.id == "r5" }!, now: now))
    }

    // MARK: Footer glyph honesty across layouts (review F3)

    @Test func eyeGlyphSeesHiddenUnknownProviderRows() {
        // columns(for:) drops unknown-provider rows, but single-column
        // renders them via interleavedRows — the glyph derivation must see
        // a hidden unknown-provider row either way.
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = DeckState(
            accounts: [
                account("c1", label: "Studio"),
                account("m1", provider: "mystery", label: "Annex"),
            ],
            usage: [
                snapshot("c1", resetsAt: iso(3_600)),
                snapshot("m1", resetsAt: iso(3_600)),
            ]
        )
        model.setManualVisibility(.hidden, for: "m1")
        #expect(model.columns(for: state, now: now)
            .allSatisfy { column in !column.rows.contains { $0.id == "m1" } },
            "precondition: the provider columns never carry m1 at all")
        #expect(model.isHidingAnyRow(state: state, now: now),
                "the eye must read eye.slash — single-column genuinely hides m1")
        #expect(!model.interleavedRows(for: state, now: now).map(\.id).contains("m1"))
    }

    // MARK: Deleted accounts drop their overrides (review F4)

    @Test func pruneDropsOverridesForAccountsOffTheRoster() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.setManualVisibility(.hidden, for: "r2")
        model.setManualVisibility(.shown, for: "r5")
        model.setManualVisibility(.hidden, for: "ghost") // long deleted
        model.pruneManualOverrides(matching: resetsFixture())
        #expect(model.manuallyHiddenAccountIDs == ["r2"])
        #expect(model.manuallyShownAccountIDs == ["r5"])
        let relaunched = DeckPopoverModel(defaults: defaults)
        #expect(relaunched.manuallyHiddenAccountIDs == ["r2"],
                "the prune persists — a reused id never comes back pre-hidden")
        #expect(relaunched.manuallyShownAccountIDs == ["r5"])
    }

    @Test func pruneKeepsOverridesForDisabledAccounts() {
        // Disabled ≠ deleted: the account is still on the roster, so its
        // override survives for when it's re-enabled.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.setManualVisibility(.hidden, for: "d1")
        let state = DeckState(
            accounts: [account("d1", label: "Bench", enabled: false)],
            usage: []
        )
        model.pruneManualOverrides(matching: state)
        #expect(model.manuallyHiddenAccountIDs == ["d1"])
    }

    // MARK: By zero weightings — exactly the #317 predicate

    @Test func zeroWeightModeMatchesTheSharedPredicateRowForRow() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byZeroWeightings
        for row in DeckBuilder.rows(state: poolFixture(), now: now) {
            #expect(model.isRowHidden(row, now: now)
                == DeckPopoverModel.isHiddenByZeroWeightFilter(row),
                "mode and #317 predicate must agree on \(row.id) — one derivation, no fork")
        }
    }

    @Test func zeroWeightModeIgnoresManualOverridesBothWays() {
        // The context-menu line is disabled in this mode, and stale manual
        // entries must not leak in as invisible extra rules — in EITHER
        // direction: a hide on a routed row, or a pin on a ⑂ 0 row.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.setManualVisibility(.hidden, for: "z1")
        model.setManualVisibility(.shown, for: "z2")
        model.hideMode = .byZeroWeightings
        let visible = Set(claudeColumn(model, poolFixture()).rows.map(\.id))
        #expect(visible.contains("z1"),
                "z1 shows weight 5 — By zero weightings must show it despite the manual hide")
        #expect(!visible.contains("z2"),
                "z2 shows ⑂ 0 — the Show pin must not override the automatic rule")
        #expect(visible == ["z1", "z3"])
    }

    // MARK: Context-menu enablement

    @Test func contextMenuLineEnabledPerMode() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byAccount
        #expect(model.contextMenuHideShowEnabled)
        model.hideMode = .byResets
        #expect(model.contextMenuHideShowEnabled)
        model.hideMode = .byZeroWeightings
        #expect(!model.contextMenuHideShowEnabled,
                "disabled (grayed), never hidden — the view renders the line regardless")
        // Master OFF keeps the line usable: toggling while everything is
        // visible is the peek-and-pin path.
        model.hideMode = .byAccount
        model.hideShowEnabled = false
        #expect(model.contextMenuHideShowEnabled)
    }

    // MARK: Everything hidden — never stranded

    @Test func everythingHiddenKeepsTheRosterCountAndTheEscapeHatch() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        for id in ["r1", "r2", "r3", "r4", "r5"] {
            model.setManualVisibility(.hidden, for: id)
        }
        let state = resetsFixture()
        let claude = claudeColumn(model, state)
        #expect(claude.rows.isEmpty)
        #expect(claude.hiddenAccountCount == 5)
        #expect(claude.accountCountText == "5 accounts")
        #expect(model.isHidingAnyRow(state: state, now: now),
                "the footer eye reads eye.slash — the visible way back")
        model.toggleHideShowSystem()
        #expect(claudeColumn(model, state).rows.count == 5,
                "one click on the footer eye restores the whole deck")
    }

    // MARK: Visual-only contract, every mode

    @Test func everyModeIsPurelyVisual() {
        // Configure each mode so it genuinely hides the deck's LOWEST row,
        // then pin that worst-remaining, menu-bar source, Availability
        // Health, and the pure row builders are all byte-identical to the
        // unfiltered derivation.
        let state = resetsFixture() // r5: 4% remaining, resets 6.9 d out
        let baselineWorst = WorstRemainingCalculator.worstRemaining(in: state, now: now)
        #expect(baselineWorst?.accountId == "r5")
        let baselineHealth = AvailabilityHealthEngine.report(for: .claude, state: state, now: now)
        let baselineRows = Set(DeckBuilder.rows(state: state, now: now).map(\.id))

        for mode in DeckPopoverModel.DeckHideMode.allCases {
            let model = DeckPopoverModel(defaults: freshDefaults())
            model.hideMode = mode
            switch mode {
            case .byAccount:
                model.setManualVisibility(.hidden, for: "r5")
            case .byResets:
                model.hideResetsHorizon = .oneDay // r5 is far outside the window
            case .byZeroWeightings:
                break // exercised on the pool fixture below
            }
            let probeState = mode == .byZeroWeightings ? poolFixture() : state
            let hiddenID = mode == .byZeroWeightings ? "z2" : "r5"
            let visible = model.columns(for: probeState, now: now).flatMap(\.rows).map(\.id)
            #expect(!visible.contains(hiddenID), "precondition: \(mode) really hides \(hiddenID)")

            let worst = WorstRemainingCalculator.worstRemaining(in: probeState, now: now)
            #expect(worst?.accountId == hiddenID,
                    "\(mode): the hidden account still drives the menu-bar number")
            #expect(MenuBarSourceResolver.sourceAccountID(
                pinnedSetting: nil, state: probeState, worstRemaining: worst) == hiddenID)
            #expect(Set(DeckBuilder.rows(state: probeState, now: now).map(\.id))
                .contains(hiddenID),
                "\(mode): pure builders keep deriving hidden rows")
            if mode != .byZeroWeightings {
                #expect(worst == baselineWorst)
                #expect(AvailabilityHealthEngine.report(
                    for: .claude, state: state, now: now) == baselineHealth)
                #expect(Set(DeckBuilder.rows(state: state, now: now).map(\.id)) == baselineRows)
            }
        }
    }

    @Test func interleavedLayoutHonorsEveryMode() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.layout = .singleColumn
        model.hideMode = .byResets
        let ids = Set(model.interleavedRows(for: resetsFixture(), now: now).map(\.id))
        #expect(ids == ["r1", "r4"])
        model.hideMode = .byAccount
        model.setManualVisibility(.hidden, for: "r3")
        #expect(Set(model.interleavedRows(for: resetsFixture(), now: now).map(\.id))
            == ["r1", "r2", "r4", "r5"])
    }
}
