import Foundation
import Testing
@testable import ModelDeckMacCore

// Placeholder names/emails only — never real identities (spec privacy rule).

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
}

private func account(
    _ id: String,
    provider: String,
    label: String,
    enabled: Bool = true,
    isDefault: Bool = false
) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: provider,
        label: label,
        identity: "\(id)@example.com",
        enabled: enabled,
        isDefault: isDefault
    )
}

private func snapshot(
    _ accountId: String,
    scope: String,
    remaining: Double?,
    resetsIn: TimeInterval? = nil,
    stale: Bool = false
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: resetsIn.map { iso($0) },
        stale: stale
    )
}

/// Fixture mirroring the mockups' account roster shape (placeholder data).
private func fixtureState() -> DeckState {
    DeckState(
        accounts: [
            account("c1", provider: "claude", label: "Studio", isDefault: true),
            account("c2", provider: "claude", label: "Client"),
            account("c3", provider: "claude", label: "Personal"),
            account("x1", provider: "codex", label: "Studio", isDefault: true),
            account("x2", provider: "codex", label: "Personal"),
        ],
        usage: [
            snapshot("c1", scope: "5h", remaining: 72, resetsIn: 57 * 60),
            snapshot("c1", scope: "week", remaining: 63, resetsIn: 2 * 86_400),
            snapshot("c1", scope: "week:fable", remaining: 32, resetsIn: 2 * 86_400),
            snapshot("c2", scope: "week:fable", remaining: 8, resetsIn: 3 * 86_400),
            snapshot("c3", scope: "week", remaining: 88, resetsIn: 4 * 86_400),
            snapshot("x1", scope: "week", remaining: 99, resetsIn: 6 * 86_400),
            snapshot("x2", scope: "week", remaining: 22, resetsIn: 5 * 86_400),
        ]
    )
}

@Suite("DeckBuilder")
struct DeckBuilderTests {
    @Test func worstWindowIsLowestRemaining() {
        let rows = DeckBuilder.rows(state: fixtureState(), now: now)
        let studio = rows.first { $0.id == "c1" }
        #expect(studio?.worstWindow?.scope == "week:fable")
        #expect(studio?.worstWindow?.remainingPercent == 32)
        #expect(studio?.lowestRemaining == 32)
    }

    @Test func windowsOrderFiveHourThenWeeklyThenModelScoped() {
        let rows = DeckBuilder.rows(state: fixtureState(), now: now)
        let studio = rows.first { $0.id == "c1" }
        #expect(studio?.windows.map(\.scope) == ["5h", "week", "week:fable"])
        #expect(studio?.windows.map(\.title) == ["5-hour limit", "Weekly · all models", "Weekly · Fable"])
    }

    @Test func disabledAccountsAreExcluded() {
        var state = fixtureState()
        state.accounts.append(account("c9", provider: "claude", label: "Disabled", enabled: false))
        let rows = DeckBuilder.rows(state: state, now: now)
        #expect(!rows.contains { $0.id == "c9" })
    }

    @Test func activeFlagFollowsIsDefault() {
        let columns = DeckBuilder.columns(state: fixtureState(), sortOrder: .nextReset, now: now)
        for column in columns {
            #expect(column.rows.filter(\.isActive).count == 1, "one ACTIVE badge per column")
        }
        #expect(columns[0].rows.first { $0.isActive }?.id == "c1")
        #expect(columns[1].rows.first { $0.isActive }?.id == "x1")
    }

    @Test func twoColumnSplitsClaudeLeftCodexRight() {
        let columns = DeckBuilder.columns(state: fixtureState(), sortOrder: .nextReset, now: now)
        #expect(columns.count == 2)
        #expect(columns[0].provider == .claude)
        #expect(columns[1].provider == .codex)
        #expect(columns[0].rows.map(\.id) == ["c1", "c2", "c3"])
        #expect(columns[1].rows.map(\.id) == ["x2", "x1"])
        #expect(columns[0].accountCountText == "3 accounts")
    }

    // Issue #43: the Reset sort keys on the DISPLAYED binding (worst)
    // window's reset — the time the collapsed card shows — never a hidden
    // window's sooner reset.
    @Test func resetSortUsesTheDisplayedBindingWindow() {
        // c1's binding window is week:fable (32%, resets in 2 days) even
        // though its hidden 5-hour window resets in 57 min; c2 3 d, c3 4 d.
        let columns = DeckBuilder.columns(state: fixtureState(), sortOrder: .nextReset, now: now)
        #expect(columns[0].rows.map(\.id) == ["c1", "c2", "c3"])
    }

    @Test func resetSortNeverKeysOnAHiddenWindow() {
        // Tim's live repro shape: "early"'s binding weekly resets Tue-ish
        // (3 days) while its idle 5-hour window resets in 16 min; "soon"'s
        // binding window resets in 2h55m. The displayed times demand soon
        // first — the old soonest-across-all key put early first.
        let state = DeckState(
            accounts: [
                account("early", provider: "claude", label: "Studio"),
                account("soon", provider: "claude", label: "Client"),
            ],
            usage: [
                snapshot("early", scope: "5h", remaining: 96, resetsIn: 16 * 60),
                snapshot("early", scope: "week", remaining: 12, resetsIn: 3 * 86_400),
                snapshot("soon", scope: "5h", remaining: 25, resetsIn: 2 * 3_600 + 55 * 60),
            ]
        )
        let columns = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
        #expect(columns[0].rows.map(\.id) == ["soon", "early"])
        // And the key each row sorted by is exactly the displayed reset.
        #expect(columns[0].rows.map { $0.displayedReset == $0.worstWindow?.resetsAt } == [true, true])
    }

    @Test func bindingWindowWithoutResetDataSortsLast() {
        let state = DeckState(
            accounts: [
                account("nodata", provider: "claude", label: "Aardvark"),
                account("dated", provider: "claude", label: "Zebra"),
            ],
            usage: [
                // Binding window (8%) has no reset data; a healthier window
                // does — the row still sorts by its DISPLAYED (binding)
                // window, i.e. last.
                snapshot("nodata", scope: "week", remaining: 8, resetsIn: nil),
                snapshot("nodata", scope: "5h", remaining: 90, resetsIn: 600),
                snapshot("dated", scope: "week", remaining: 50, resetsIn: 5 * 86_400),
            ]
        )
        let columns = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
        #expect(columns[0].rows.map(\.id) == ["dated", "nodata"])
    }

    // Issue #53: among windows tied at the worst % left, the headline pick
    // prefers one with a real upcoming reset — "no reset data" only when no
    // eligible window carries one. Tim's repro: everything at 100%, the
    // 5-hour window has no resetsAt (no active session) but the weekly
    // resets Sunday; the collapsed card must show the weekly's reset.
    @Test func worstWindowTieBreakPrefersResetBearingWindow() {
        let state = DeckState(
            accounts: [account("m1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("m1", scope: "5h", remaining: 100, resetsIn: nil),
                snapshot("m1", scope: "week", remaining: 100, resetsIn: 5 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now).first
        #expect(row?.worstWindow?.scope == "week")
        #expect(row?.worstWindow?.resetsAt != nil)
        #expect(row?.worstSummary?.contains("no reset data") == false)
        // #43's Reset sort key follows the displayed window automatically.
        #expect(row?.displayedReset == now.addingTimeInterval(5 * 86_400))
    }

    @Test func worstWindowTieBreakPicksSoonestResetAmongTies() {
        let state = DeckState(
            accounts: [account("m1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("m1", scope: "5h", remaining: 100, resetsIn: nil),
                snapshot("m1", scope: "week", remaining: 100, resetsIn: 5 * 86_400),
                snapshot("m1", scope: "week:fable", remaining: 100, resetsIn: 2 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now).first
        #expect(row?.worstWindow?.scope == "week:fable") // soonest reset wins the tie
    }

    @Test func worstWindowTieBreakOnlyAppliesAmongTiedWindows() {
        // A strictly-worse window without a reset still wins — the tie-break
        // never lets a healthier window steal the headline.
        let state = DeckState(
            accounts: [account("m1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("m1", scope: "5h", remaining: 40, resetsIn: nil),
                snapshot("m1", scope: "week", remaining: 90, resetsIn: 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now).first
        #expect(row?.worstWindow?.scope == "5h")
        #expect(row?.worstWindow?.resetText == "no reset data")
    }

    @Test func noResetAnywhereStillSaysNoResetData() {
        let state = DeckState(
            accounts: [account("m1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("m1", scope: "5h", remaining: 100, resetsIn: nil),
                snapshot("m1", scope: "week", remaining: 100, resetsIn: nil),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now).first
        #expect(row?.worstWindow?.scope == "5h") // display-order fallback
        #expect(row?.worstWindow?.resetText == "no reset data")
    }

    @Test func spendStaysExcludedFromTieBreak() {
        // Issue #28 exclusion unchanged: a reset-bearing spend row tied at
        // the worst percent never becomes the headline.
        let state = DeckState(
            accounts: [account("m1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("m1", scope: "5h", remaining: 100, resetsIn: nil),
                snapshot("m1", scope: "spend", remaining: 100, resetsIn: 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now).first
        #expect(row?.worstWindow?.scope == "5h")
    }

    // Issue #53 knock-on for #43: a repro-shaped card previously sorted
    // "no data last"; with the tie-break it sorts by its real weekly reset.
    @Test func resetSortUsesTieBrokenResetInsteadOfSinkingToLast() {
        let state = DeckState(
            accounts: [
                account("repro", provider: "claude", label: "Studio"),
                account("later", provider: "claude", label: "Client"),
            ],
            usage: [
                snapshot("repro", scope: "5h", remaining: 100, resetsIn: nil),
                snapshot("repro", scope: "week", remaining: 100, resetsIn: 2 * 86_400),
                snapshot("later", scope: "week", remaining: 100, resetsIn: 6 * 86_400),
            ]
        )
        let columns = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
        #expect(columns[0].rows.map(\.id) == ["repro", "later"])
    }

    @Test func resetSortTieBreaksByLabelStable() {
        let state = DeckState(
            accounts: [
                account("b", provider: "claude", label: "Studio"),
                account("a", provider: "claude", label: "Client"),
            ],
            usage: [
                snapshot("b", scope: "week", remaining: 40, resetsIn: 86_400),
                snapshot("a", scope: "week", remaining: 60, resetsIn: 86_400),
            ]
        )
        let columns = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
        #expect(columns[0].rows.map(\.id) == ["a", "b"]) // Client before Studio
    }

    @Test func sortByLowestRemaining() {
        let columns = DeckBuilder.columns(state: fixtureState(), sortOrder: .lowestRemaining, now: now)
        #expect(columns[0].rows.map(\.id) == ["c2", "c1", "c3"]) // 8, 32, 88
        #expect(columns[1].rows.map(\.id) == ["x2", "x1"]) // 22, 99
    }

    @Test func accountsWithoutUsageSortLast() {
        var state = fixtureState()
        state.accounts.append(account("c4", provider: "claude", label: "Aardvark"))
        let byReset = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
        #expect(byReset[0].rows.last?.id == "c4")
        let byRemaining = DeckBuilder.columns(state: state, sortOrder: .lowestRemaining, now: now)
        #expect(byRemaining[0].rows.last?.id == "c4")
    }

    @Test func singleColumnInterleavesProvidersBySort() {
        let rows = DeckBuilder.interleavedRows(state: fixtureState(), sortOrder: .lowestRemaining, now: now)
        #expect(rows.map(\.id) == ["c2", "x2", "c1", "c3", "x1"]) // 8, 22, 32, 88, 99
    }

    // Issue #30: Provider sort groups accounts by provider even in
    // single-column mode — Claude block first, Codex second, unknown
    // providers last; within a group rows keep the next-reset order.
    @Test func providerSortGroupsSingleColumnByProvider() {
        var state = fixtureState()
        state.accounts.append(account("g1", provider: "gemini", label: "Other"))
        let rows = DeckBuilder.interleavedRows(state: state, sortOrder: .provider, now: now)
        // Claude by next reset (c1 57 min, c2 3 d, c3 4 d), then Codex by
        // next reset (x2 5 d, x1 6 d), then the unknown provider.
        #expect(rows.map(\.id) == ["c1", "c2", "c3", "x2", "x1", "g1"])
    }

    @Test func providerSortDegradesToNextResetWithinColumns() {
        let byProvider = DeckBuilder.columns(state: fixtureState(), sortOrder: .provider, now: now)
        let byReset = DeckBuilder.columns(state: fixtureState(), sortOrder: .nextReset, now: now)
        #expect(byProvider.map { $0.rows.map(\.id) } == byReset.map { $0.rows.map(\.id) })
    }

    @Test func providerSortDisplayName() {
        #expect(DeckSortOrder.provider.displayName == "Provider")
        #expect(DeckSortOrder.allCases.contains(.provider))
    }

    // Issue #30 item 10: the popover's compact sort control renders icon
    // segments; every order carries a distinct symbol and keeps its
    // display name for tooltips/accessibility.
    @Test func sortOrderIconsAreDistinct() {
        let icons = DeckSortOrder.allCases.map(\.iconName)
        #expect(Set(icons).count == icons.count)
        #expect(DeckSortOrder.nextReset.iconName == "clock")
        #expect(DeckSortOrder.lowestRemaining.iconName == "percent")
        #expect(DeckSortOrder.provider.iconName == "square.grid.2x2")
    }

    @Test func unknownProviderStaysOutOfColumnsButInSingleColumn() {
        var state = fixtureState()
        state.accounts.append(account("g1", provider: "gemini", label: "Other"))
        let columns = DeckBuilder.columns(state: state, sortOrder: .nextReset, now: now)
        #expect(columns.allSatisfy { column in !column.rows.contains { $0.id == "g1" } })
        let rows = DeckBuilder.interleavedRows(state: state, sortOrder: .nextReset, now: now)
        #expect(rows.contains { $0.id == "g1" })
    }

    @Test func severityFollowsThresholds() {
        #expect(UsageSeverity.severity(remainingPercent: 72, thresholds: .default) == .healthy)
        #expect(UsageSeverity.severity(remainingPercent: 25, thresholds: .default) == .warning)
        #expect(UsageSeverity.severity(remainingPercent: 10, thresholds: .default) == .critical)
        #expect(UsageSeverity.severity(remainingPercent: nil, thresholds: .default) == .unknown)
    }

    @Test func barsFillWithUsageNumberReadsPercentLeft() {
        let rows = DeckBuilder.rows(state: fixtureState(), now: now)
        let worst = rows.first { $0.id == "c2" }?.worstWindow
        #expect(worst?.usedFraction == 0.92)
        #expect(worst?.remainingText == "8% left")
    }

    @Test func remainingDerivedFromUsedPercentWhenMissing() {
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [UsageSnapshot(accountId: "c1", scope: "5h", usedPercent: 30)]
        )
        let rows = DeckBuilder.rows(state: state, now: now)
        #expect(rows.first?.worstWindow?.remainingPercent == 70)
    }

    @Test func windowTitles() {
        #expect(DeckBuilder.windowTitle(for: "5h") == "5-hour limit")
        #expect(DeckBuilder.windowTitle(for: "week") == "Weekly · all models")
        #expect(DeckBuilder.windowTitle(for: "week:fable") == "Weekly · Fable")
        #expect(DeckBuilder.windowTitle(for: "week_opus") == "Weekly · Opus")
        // Daemon-labelled model-scoped weeklies (issue #28's limits parsing).
        #expect(DeckBuilder.windowTitle(for: "Fable weekly") == "Weekly · Fable")
        #expect(DeckBuilder.windowTitle(for: "spend") == "Spend")
        #expect(DeckBuilder.windowTitle(for: "custom-scope") == "custom-scope")
    }

    // MARK: - Issue #28: spend deprioritization

    /// State mirroring the live-use bug report: spend 0% left with no reset
    /// data beside healthy 5-hour (71%) and weekly (50%) windows.
    private func spendState(
        spendRemaining: Double? = 0,
        spendResetsIn: TimeInterval? = nil
    ) -> DeckState {
        DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio", isDefault: true)],
            usage: [
                snapshot("c1", scope: "5h", remaining: 71, resetsIn: 57 * 60),
                snapshot("c1", scope: "week", remaining: 50, resetsIn: 2 * 86_400),
                snapshot("c1", scope: "spend", remaining: spendRemaining, resetsIn: spendResetsIn),
            ]
        )
    }

    @Test func spendNeverHeadlinesWhileRateLimitWindowsExist() {
        let row = DeckBuilder.rows(state: spendState(), now: now)[0]
        // A spend row at 0% left must not headline red over a healthy weekly.
        #expect(row.worstWindow?.scope == "week")
        #expect(row.worstWindow?.remainingPercent == 50)
        #expect(row.lowestRemaining == 50, "Lowest sort key ignores spend")
        #expect(row.worstSummary?.contains("Weekly") == true)
    }

    @Test func spendRendersLastAsTertiaryRow() {
        // With a reset date, spend stays visible — but always last.
        let row = DeckBuilder.rows(state: spendState(spendResetsIn: 5 * 86_400), now: now)[0]
        #expect(row.windows.map(\.scope) == ["5h", "week", "spend"])
        #expect(row.windows.last?.isSpend == true)
        #expect(row.windows.dropLast().allSatisfy { !$0.isSpend })
    }

    @Test func meaninglessSpendIsHiddenEntirely() {
        // No reset data + zero usage (100% left): hidden.
        let zeroUsage = DeckBuilder.rows(state: spendState(spendRemaining: 100), now: now)[0]
        #expect(zeroUsage.windows.map(\.scope) == ["5h", "week"])
        // No reset data + unknown usage: hidden.
        let unknown = DeckBuilder.rows(state: spendState(spendRemaining: nil), now: now)[0]
        #expect(unknown.windows.map(\.scope) == ["5h", "week"])
        // No reset data but real usage: visible (still tertiary).
        let used = DeckBuilder.rows(state: spendState(spendRemaining: 40), now: now)[0]
        #expect(used.windows.map(\.scope) == ["5h", "week", "spend"])
        // Reset data present: visible even at zero usage.
        let withReset = DeckBuilder.rows(state: spendState(spendRemaining: 100, spendResetsIn: 86_400), now: now)[0]
        #expect(withReset.windows.map(\.scope) == ["5h", "week", "spend"])
    }

    // MARK: - Issue #139: payload-stated spend dollar amounts

    private let enUS = Locale(identifier: "en_US")

    private func spendAmountsState(
        remaining: Double? = 51,
        amounts: SpendAmounts?
    ) -> DeckState {
        DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio", isDefault: true)],
            usage: [
                snapshot("c1", scope: "5h", remaining: 71, resetsIn: 57 * 60),
                UsageSnapshot(
                    accountId: "c1",
                    scope: "spend",
                    remainingPercent: remaining,
                    stale: false,
                    detail: UsageSnapshotDetail(spend: amounts)
                ),
            ]
        )
    }

    @Test func spendAmountTextMatchesClaudeCodePresentation() {
        // Pinned locale (repo convention, PR #137) so the assertion is
        // machine-independent. Placeholder amounts only.
        let text = DeckBuilder.spendAmountText(
            SpendAmounts(usedMinor: 24563, limitMinor: 50000, currency: "USD", exponent: 2),
            locale: enUS
        )
        #expect(text == "$245.63 of $500.00")
    }

    @Test func spendAmountTextUsesThePayloadCurrencyNeverAssumes() {
        // A non-USD budget renders with ITS currency symbol.
        let eur = DeckBuilder.spendAmountText(
            SpendAmounts(usedMinor: 1005, limitMinor: 20000, currency: "EUR", exponent: 2),
            locale: enUS
        )
        #expect(eur == "€10.05 of €200.00")
        // No stated currency → no dollar copy at all.
        #expect(DeckBuilder.spendAmountText(
            SpendAmounts(usedMinor: 24563, limitMinor: 50000, currency: nil, exponent: 2),
            locale: enUS
        ) == nil)
        // Missing amounts or non-positive limit → nil.
        #expect(DeckBuilder.spendAmountText(
            SpendAmounts(usedMinor: nil, limitMinor: 50000, currency: "USD", exponent: 2),
            locale: enUS
        ) == nil)
        #expect(DeckBuilder.spendAmountText(
            SpendAmounts(usedMinor: 0, limitMinor: 0, currency: "USD", exponent: 2),
            locale: enUS
        ) == nil)
        #expect(DeckBuilder.spendAmountText(nil, locale: enUS) == nil)
    }

    @Test func spendRowValueShowsDollarsWhenAmountsExist() {
        let amounts = SpendAmounts(usedMinor: 24500, limitMinor: 50000, currency: "USD", exponent: 2)
        let row = DeckBuilder.rows(state: spendAmountsState(amounts: amounts), now: now)[0]
        let spend = row.windows.first { $0.isSpend }
        // The value slot replaces the bare percent with the dollar copy…
        #expect(spend?.spendText != nil)
        #expect(spend?.valueText == spend?.spendText)
        // …while the meter keeps the utilization fraction and non-spend rows
        // keep the locked "% left" convention.
        #expect(spend?.remainingPercent == 51)
        let fiveHour = row.windows.first { !$0.isSpend }
        #expect(fiveHour?.spendText == nil)
        #expect(fiveHour?.valueText == "71% left")
    }

    @Test func spendRowWithoutAmountsKeepsPercentOnlyCopy() {
        let row = DeckBuilder.rows(state: spendAmountsState(amounts: nil), now: now)[0]
        let spend = row.windows.first { $0.isSpend }
        #expect(spend?.spendText == nil)
        #expect(spend?.valueText == "51% left")
        #expect(spend?.resetText == "no reset data")
    }

    @Test func spendRowWithBudgetOmitsNoResetPlaceholder() {
        // Issue #143 (live v0.3.3): the row rendered "$353.51 of $500.00"
        // AND "no reset data" side by side. When the dollar budget renders,
        // the placeholder is vestigial — the budget IS the row's data.
        let amounts = SpendAmounts(usedMinor: 35351, limitMinor: 50000, currency: "USD", exponent: 2)
        let row = DeckBuilder.rows(state: spendAmountsState(amounts: amounts), now: now)[0]
        let spend = row.windows.first { $0.isSpend }
        #expect(spend?.spendText != nil)
        // The stored resetText is untouched; the DISPLAYED slot is empty.
        #expect(spend?.resetText == "no reset data")
        #expect(spend?.displayedResetText == nil)
        // A spend-only account's collapsed summary drops the placeholder
        // tail too — bare title, no "Spend · no reset data".
        let spendOnly = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio", isDefault: true)],
            usage: [
                UsageSnapshot(
                    accountId: "c1",
                    scope: "spend",
                    remainingPercent: 29,
                    stale: false,
                    detail: UsageSnapshotDetail(spend: amounts)
                ),
            ]
        )
        let summary = DeckBuilder.rows(state: spendOnly, now: now)[0].worstSummary
        #expect(summary == "Spend")
        // A real reset timestamp, should the payload ever carry one,
        // renders normally — suppression is placeholder-only.
        let withReset = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio", isDefault: true)],
            usage: [
                UsageSnapshot(
                    accountId: "c1",
                    scope: "spend",
                    remainingPercent: 29,
                    resetsAt: iso(30 * 60),
                    stale: false,
                    detail: UsageSnapshotDetail(spend: amounts)
                ),
            ]
        )
        let anchored = DeckBuilder.rows(state: withReset, now: now)[0].windows.first { $0.isSpend }
        #expect(anchored?.displayedResetText == "Resets in 30 min")
    }

    @Test func percentOnlySpendRowAlsoDropsPlaceholder() {
        // Issue #145 (supersedes #143's percent-only carve-out): the
        // placeholder is gone from EVERY row kind — a percent-only spend
        // row without a reset renders an empty slot too. The stored
        // resetText string is untouched; only the displayed slot empties.
        let row = DeckBuilder.rows(state: spendAmountsState(amounts: nil), now: now)[0]
        let spend = row.windows.first { $0.isSpend }
        #expect(spend?.spendText == nil)
        #expect(spend?.resetText == "no reset data")
        #expect(spend?.displayedResetText == nil)
    }

    @Test func amountBearingSpendRowIsNeverMeaningless() {
        let amounts = SpendAmounts(usedMinor: 0, limitMinor: 50000, currency: "USD", exponent: 2)
        // Zero usage + no reset would hide an amount-free spend row (#28);
        // "$0.00 of $500.00" is a live budget and must stay visible.
        let zero = DeckBuilder.rows(state: spendAmountsState(remaining: 100, amounts: amounts), now: now)[0]
        #expect(zero.windows.contains { $0.isSpend })
        // Percent-less amounts-only row (daemon-created, #139) is visible too.
        let unknown = DeckBuilder.rows(state: spendAmountsState(remaining: nil, amounts: amounts), now: now)[0]
        #expect(unknown.windows.contains { $0.isSpend })
        // CodeRabbit (PR #142): filter survival is not enough — the
        // collapsed card must actually HEADLINE the dollars. But only as a
        // last resort: here a percent-bearing 5-hour window exists, so it
        // keeps the headline and the amount-only spend row stays tertiary.
        #expect(unknown.headlineWindow(isExpanded: false)?.scope == "5h")
        // Without amounts the #28 hiding rules stand.
        let hidden = DeckBuilder.rows(state: spendAmountsState(remaining: nil, amounts: nil), now: now)[0]
        #expect(!hidden.windows.contains { $0.isSpend })
    }

    @Test func amountOnlySpendRowHeadlinesItsDollarsWhenNothingElseIsMeasurable() {
        // CodeRabbit (PR #142, Major): the daemon's amount-only spend row
        // (dollars stated, no percent) left worstWindow nil, so the
        // collapsed card rendered NO headline and the budget was invisible
        // until expand. The fallback must surface the actual dollar copy.
        let amounts = SpendAmounts(usedMinor: 0, limitMinor: 50000, currency: "USD", exponent: 2)
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio", isDefault: true)],
            usage: [
                UsageSnapshot(
                    accountId: "c1",
                    scope: "spend",
                    remainingPercent: nil,
                    stale: false,
                    detail: UsageSnapshotDetail(spend: amounts)
                ),
            ]
        )
        // Deterministic dollars for the assertion: build the row's windows
        // via DeckBuilder, then check the headline against the en_US-pinned
        // formatter output (DeckBuilder.window formats via .current, so the
        // headline expectation compares to the same formatter's result).
        let row = DeckBuilder.rows(state: state, now: now)[0]
        let expected = DeckBuilder.spendAmountText(amounts)
        #expect(expected != nil)
        let headline = row.headlineWindow(isExpanded: false)
        #expect(headline?.isSpend == true)
        #expect(headline?.remainingPercent == nil)
        #expect(headline?.valueText == expected)
        #expect(DeckBuilder.spendAmountText(amounts, locale: enUS) == "$0.00 of $500.00")
        // The truly empty card (no windows at all) still shows no headline.
        let empty = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [snapshot("c1", scope: "5h", remaining: nil)]
        )
        #expect(DeckBuilder.rows(state: empty, now: now)[0].headlineWindow(isExpanded: false) == nil)
    }

    @Test func allUnknownUsageYieldsNoHeadlineWindow() {
        // Post-#53 tie-break: when every window's remaining is unknown there
        // is no honest worst pick — the headline shows nothing rather than an
        // arbitrary window (intended change from the pre-#53 first-window
        // fallback).
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("c1", scope: "5h", remaining: nil),
                snapshot("c1", scope: "week", remaining: nil, resetsIn: 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.worstWindow == nil)
        #expect(row.lowestRemaining == nil)
    }

    @Test func headlineFallsBackToSpendWhenNothingElseExists() {
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [snapshot("c1", scope: "spend", remaining: 8, resetsIn: 86_400)]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.worstWindow?.scope == "spend")
        #expect(row.lowestRemaining == 8)
    }

    @Test func spendLosesLowestSortToRealRateLimits() {
        // Account whose ONLY low number is spend must not sort above an
        // account with a genuinely low weekly.
        let state = DeckState(
            accounts: [
                account("c1", provider: "claude", label: "SpendZero"),
                account("c2", provider: "claude", label: "WeeklyLow"),
            ],
            usage: [
                snapshot("c1", scope: "spend", remaining: 0, resetsIn: 86_400),
                snapshot("c1", scope: "week", remaining: 90, resetsIn: 2 * 86_400),
                snapshot("c2", scope: "week", remaining: 30, resetsIn: 2 * 86_400),
            ]
        )
        let columns = DeckBuilder.columns(state: state, sortOrder: .lowestRemaining, now: now)
        #expect(columns[0].rows.map(\.id) == ["c2", "c1"]) // 30 beats 90; spend's 0 ignored
    }

    /// Issue #28 (scoped weekly): a critical model-scoped weekly from the
    /// limits payload IS headline-eligible, unlike spend.
    @Test func modelScopedWeeklyIsHeadlineEligible() {
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("c1", scope: "weekly", remaining: 49, resetsIn: 6 * 86_400),
                snapshot("c1", scope: "Fable weekly", remaining: 4, resetsIn: 4 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.worstWindow?.scope == "Fable weekly")
        #expect(row.worstWindow?.severity == .critical)
        #expect(row.windows.map(\.title) == ["Weekly · all models", "Weekly · Fable"])
    }

    @Test func resetTextBuckets() {
        // Claude Code usage-panel style (issue #28).
        #expect(DeckBuilder.resetText(for: nil, now: now) == "no reset data")
        #expect(DeckBuilder.resetText(for: now.addingTimeInterval(-5), now: now) == "resetting now")
        #expect(DeckBuilder.resetText(for: now.addingTimeInterval(57 * 60), now: now) == "Resets in 57 min")
        #expect(DeckBuilder.resetText(for: now.addingTimeInterval(3 * 3_600 + 10 * 60), now: now) == "Resets in 3 hr 10 min")
        #expect(DeckBuilder.resetText(for: now.addingTimeInterval(4 * 3_600), now: now) == "Resets in 4 hr")
        #expect(DeckBuilder.resetText(for: now.addingTimeInterval(3 * 86_400), now: now).hasPrefix("Resets "))
    }

    // Issue #137 (supersedes #30's zone suffix): reset times are always the
    // viewer's local clock, so row copy carries NO time-zone abbreviation —
    // "Resets Mon 12:00 AM", not "Resets Mon 12:00 AM PST".
    @Test func resetTextRowCopyCarriesNoTimeZoneAbbreviation() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        // Pin the locale so the exact weekday/month assertions below are
        // deterministic on any host (CodeRabbit, PR #138).
        calendar.locale = Locale(identifier: "en_US")
        // `now` is 1_800_000_000 = 2027-01-15T08:00:00Z = Fri midnight PST.
        let withinWeek = DeckBuilder.resetText(
            for: now.addingTimeInterval(3 * 86_400), now: now, calendar: calendar
        )
        #expect(withinWeek == "Resets Mon 12:00 AM", "got \(withinWeek)")
        #expect(!withinWeek.contains("PST") && !withinWeek.contains("PT"),
                "row copy must be zone-free: \(withinWeek)")
        let beyondWeek = DeckBuilder.resetText(
            for: now.addingTimeInterval(10 * 86_400), now: now, calendar: calendar
        )
        #expect(beyondWeek == "Resets Jan 25", "got \(beyondWeek)")
        #expect(!beyondWeek.contains("PST"), "date-only form stays zone-free: \(beyondWeek)")
    }

    // Issue #67 + #137: the hover-tooltip backstop — the FULL absolute
    // timestamp (weekday, date, clock time, zone). With row copy now
    // zone-free (#137), the tooltip is the ONLY place the zone renders and
    // MUST retain the abbreviation.
    @Test func absoluteResetTooltipRetainsTimeZoneAbbreviation() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        // Pinned locale for deterministic symbols (CodeRabbit, PR #138).
        calendar.locale = Locale(identifier: "en_US")
        // 1_800_000_000 = 2027-01-15T08:00:00Z = Fri Jan 15, midnight PST.
        let text = DeckBuilder.absoluteResetText(for: now, calendar: calendar)
        #expect(text == "Fri Jan 15, 12:00 AM PST", "got \(String(describing: text))")
        #expect(DeckBuilder.absoluteResetText(for: nil) == nil)
    }

    @Test func lenientDateParsing() {
        #expect(DeckDateParsing.date(from: "2027-01-15T06:00:00Z") != nil)
        #expect(DeckDateParsing.date(from: "2027-01-15T06:00:00.123Z") != nil)
        #expect(DeckDateParsing.date(from: "1800000000000") == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(DeckDateParsing.date(from: nil) == nil)
        #expect(DeckDateParsing.date(from: "not a date") == nil)
    }
}

@Suite("DeckPopoverModel")
@MainActor
struct DeckPopoverModelTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "deck-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test func defaultsToTwoColumnAndNextReset() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(model.layout == .twoColumn)
        #expect(model.sortOrder == .nextReset)
    }

    // Issue #73: deck email visibility is opt-in — the toggle MUST default
    // off (restores the pre-#62 look) and persist app-locally.
    @Test func showAccountEmailsDefaultsOff() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(model.showAccountEmails == false)
    }

    @Test func showAccountEmailsPersistsAcrossInstances() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.showAccountEmails = true
        #expect(DeckPopoverModel(defaults: defaults).showAccountEmails == true)
        model.showAccountEmails = false
        #expect(DeckPopoverModel(defaults: defaults).showAccountEmails == false)
    }

    @Test func layoutAndSortPersistAcrossInstances() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.layout = .singleColumn
        model.sortOrder = .lowestRemaining
        let second = DeckPopoverModel(defaults: defaults)
        #expect(second.layout == .singleColumn)
        #expect(second.sortOrder == .lowestRemaining)
    }

    // Issue #30: Provider grouping is popover-local — it persists via
    // UserDefaults like the other orders (the daemon never stores it).
    @Test func providerSortPersistsAcrossInstances() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.sortOrder = .provider
        #expect(DeckPopoverModel(defaults: defaults).sortOrder == .provider)
    }

    @Test func expansionToggles() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(!model.isExpanded("c1"))
        model.toggleExpansion(of: "c1")
        #expect(model.isExpanded("c1"))
        model.toggleExpansion(of: "c2")
        #expect(model.isExpanded("c1") && model.isExpanded("c2"), "rows expand independently")
        model.toggleExpansion(of: "c1")
        #expect(!model.isExpanded("c1"))
        #expect(model.isExpanded("c2"))
    }

    @Test func layoutSwitchingDrivesSameData() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = fixtureState()
        let columnIDs = model.columns(for: state, now: now).flatMap { $0.rows.map(\.id) }
        model.layout = .singleColumn
        let listIDs = model.interleavedRows(for: state, now: now).map(\.id)
        #expect(Set(columnIDs) == Set(listIDs), "both layouts render the same accounts")
    }

    @Test func sortOrderAppliesToBothLayouts() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.sortOrder = .lowestRemaining
        let state = fixtureState()
        #expect(model.columns(for: state, now: now)[0].rows.first?.id == "c2")
        #expect(model.interleavedRows(for: state, now: now).first?.id == "c2")
    }
}

@Suite("MenuBarStatusModel + deck state")
@MainActor
struct MenuBarStatusModelDeckStateTests {
    private struct StubStateProvider: DeckStateProviding {
        var result: Result<DeckState, DaemonClientError>
        func deckState() async throws -> DeckState { try result.get() }
    }

    /// Issue #45: refresh with a state provider consults the evaluator
    /// FIRST (in the app: the daemon's /api/capacity/worst); this stub
    /// throws so these tests exercise the client-calc fallback.
    private struct FailingEvaluator: UsageEvaluating {
        func evaluateWorstRemaining() async throws -> WorstRemaining? {
            throw URLError(.cannotConnectToHost)
        }
    }

    @Test func refreshPopulatesDeckStateAndIconViaFallbackCalc() async {
        let model = MenuBarStatusModel(
            evaluator: FailingEvaluator(),
            stateProvider: StubStateProvider(result: .success(fixtureState()))
        )
        await model.refresh()
        #expect(model.deckState?.accounts.count == 5)
        #expect(model.worstRemaining?.percent == 8)
        #expect(model.iconState == .critical(percentRemaining: 8))
        #expect(model.connection == .connected)
    }

    @Test func daemonEvaluatorIsPrimaryOverClientCalc() async {
        // The evaluator (daemon endpoint) reports 3% while the client calc
        // over the fixture state would say 8% — the evaluator must win.
        let model = MenuBarStatusModel(
            evaluator: StubEvaluator(results: [.success(
                WorstRemaining(percent: 3, accountId: "acct-endpoint", scope: "Fable weekly")
            )]),
            stateProvider: StubStateProvider(result: .success(fixtureState()))
        )
        await model.refresh()
        #expect(model.deckState?.accounts.count == 5)
        #expect(model.worstRemaining?.percent == 3)
        #expect(model.worstRemaining?.accountId == "acct-endpoint")
        #expect(model.iconState == .critical(percentRemaining: 3))
    }

    @Test func failureKeepsLastDeckState() async {
        let model = MenuBarStatusModel(
            evaluator: FailingEvaluator(),
            stateProvider: StubStateProvider(result: .success(fixtureState()))
        )
        await model.refresh()
        let failing = MenuBarStatusModel(
            evaluator: FailingEvaluator(),
            stateProvider: StubStateProvider(result: .failure(.httpStatus(500)))
        )
        await failing.refresh()
        #expect(failing.deckState == nil)
        if case .unreachable = failing.connection {} else {
            Issue.record("expected .unreachable")
        }
        // And the first model retains its state.
        #expect(model.deckState != nil)
    }
}

// The vector brand-mark paths this suite used to cover were replaced by the
// official desktop-app icons (issue #103) — see ProviderIconTests. The SVG
// parser itself stays as a utility.
@Suite("ProviderMarks")
struct ProviderMarkTests {
    @Test func svgParserHandlesBasicCommands() {
        let path = SVGPath.cgPath("M0 0 L10 0 10 10 H0 V0 Z")
        #expect(path != nil)
        #expect(path?.boundingBox == CGRect(x: 0, y: 0, width: 10, height: 10))
    }

    @Test func providerMapping() {
        #expect(DeckProvider.from("claude") == .claude)
        #expect(DeckProvider.from("Anthropic") == .claude)
        #expect(DeckProvider.from("codex") == .codex)
        #expect(DeckProvider.from("openai") == .codex)
        #expect(DeckProvider.from("gemini") == nil)
    }
}

// MARK: - Activate flow (issue #6; surface moved to Settings → Accounts by
// the 2026-07-19 spec amendment — the model machinery under test is
// unchanged, the popover simply no longer hosts the button)

/// Reopenable gate so a test can hold the activator mid-flight and observe
/// the optimistic UI before letting the call finish.
private actor ActivationGate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}

/// Scripted activator: optional gate, then a queued result per call.
private final class StubActivator: AccountActivating, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<DeckAccount, Error>]
    private(set) var calls: [String] = []
    let gate: ActivationGate?

    init(results: [Result<DeckAccount, Error>], gate: ActivationGate? = nil) {
        self.results = results
        self.gate = gate
    }

    func activateAccount(id: String) async throws -> AccountActivation {
        await gate?.wait()
        let result = nextResult(recording: id)
        guard let result else { throw DaemonClientError.invalidResponse }
        return AccountActivation(account: try result.get())
    }

    private func nextResult(recording id: String) -> Result<DeckAccount, Error>? {
        lock.lock()
        defer { lock.unlock() }
        calls.append(id)
        return results.isEmpty ? nil : results.removeFirst()
    }
}

private struct StubDeckStateProvider: DeckStateProviding {
    var state: DeckState
    func deckState() async throws -> DeckState { state }
}

/// Fixture with the Claude default switched from c1 to the given account.
private func switchedState(claudeDefault id: String) -> DeckState {
    var state = fixtureState()
    state.accounts = state.accounts.map { account in
        var account = account
        if account.provider == "claude" { account.isDefault = account.id == id }
        return account
    }
    return state
}

@Suite("DeckPopoverModel activation")
@MainActor
struct DeckPopoverModelActivationTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "deck-activation-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func nonActiveClaudeRow(_ model: DeckPopoverModel, id: String = "c2") -> DeckAccountRow {
        let row = model.columns(for: fixtureState(), now: now)[0].rows.first { $0.id == id }!
        #expect(!row.isActive)
        return row
    }

    private func activatedAccount(_ id: String) -> DeckAccount {
        account(id, provider: "claude", label: "Switched", isDefault: true)
    }

    @Test func optimisticFlipShowsImmediatelyThenVerifiedStateIsPushed() async {
        let gate = ActivationGate()
        let activator = StubActivator(results: [.success(activatedAccount("c2"))], gate: gate)
        let fresh = switchedState(claudeDefault: "c2")
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: fresh)
        )
        var verified: DeckState?
        model.onVerifiedState = { verified = $0 }

        let row = nonActiveClaudeRow(model)
        let task = Task { await model.activate(row) }
        while model.activatingAccountID == nil { await Task.yield() }

        // Mid-flight: badge already flipped against the stale state, one
        // ACTIVE per column, Codex column untouched.
        let midFlight = model.columns(for: fixtureState(), now: now)
        #expect(midFlight[0].rows.first { $0.id == "c2" }?.isActive == true)
        #expect(midFlight[0].rows.first { $0.id == "c1" }?.isActive == false)
        #expect(midFlight[0].rows.filter(\.isActive).count == 1)
        #expect(midFlight[1].rows.first { $0.id == "x1" }?.isActive == true)

        await gate.open()
        await task.value

        #expect(model.activatingAccountID == nil)
        #expect(model.activationError(for: "c2") == nil)
        #expect(verified?.accounts.first { $0.id == "c2" }?.isDefault == true)
        // Override cleared: rendering the pushed fresh state agrees on c2.
        let after = model.columns(for: fresh, now: now)
        #expect(after[0].rows.first { $0.id == "c2" }?.isActive == true)
        #expect(after[0].rows.filter(\.isActive).count == 1)
    }

    @Test func postFailureRevertsBadgeAndSurfacesInlineError() async {
        let activator = StubActivator(results: [
            .failure(DaemonClientError.daemonError(message: "account is disabled", status: 400)),
        ])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: fixtureState())
        )
        var verified: DeckState?
        model.onVerifiedState = { verified = $0 }

        await model.activate(nonActiveClaudeRow(model))

        let columns = model.columns(for: fixtureState(), now: now)
        #expect(columns[0].rows.first { $0.id == "c1" }?.isActive == true, "revert restores the previous badge")
        #expect(columns[0].rows.first { $0.id == "c2" }?.isActive == false)
        #expect(model.activationError(for: "c2")?.contains("account is disabled") == true)
        #expect(model.activatingAccountID == nil)
        #expect(verified == nil)
    }

    @Test func unconfirmedSwitchRevertsWithVerificationError() async {
        // POST "succeeds" but a fresh /api/state still reports c1 active.
        let activator = StubActivator(results: [.success(activatedAccount("c2"))])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: fixtureState())
        )
        var verified: DeckState?
        model.onVerifiedState = { verified = $0 }

        await model.activate(nonActiveClaudeRow(model))

        let columns = model.columns(for: fixtureState(), now: now)
        #expect(columns[0].rows.first { $0.id == "c1" }?.isActive == true)
        #expect(model.activationError(for: "c2")?.contains("not confirmed") == true)
        #expect(verified == nil)
    }

    @Test func retryAfterFailureClearsTheError() async {
        let activator = StubActivator(results: [
            .failure(DaemonClientError.httpStatus(500)),
            .success(activatedAccount("c2")),
        ])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: switchedState(claudeDefault: "c2"))
        )
        let row = nonActiveClaudeRow(model)
        await model.activate(row)
        #expect(model.activationError(for: "c2") != nil)
        await model.activate(row)
        #expect(model.activationError(for: "c2") == nil)
        #expect(activator.calls == ["c2", "c2"])
    }

    @Test func activatingTheActiveRowIsANoOp() async {
        let activator = StubActivator(results: [.success(activatedAccount("c1"))])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: fixtureState())
        )
        let active = model.columns(for: fixtureState(), now: now)[0].rows.first { $0.isActive }!
        await model.activate(active)
        #expect(activator.calls.isEmpty)
        #expect(model.activatingAccountID == nil)
    }

    @Test func withoutWiringActivateSurfacesAVisibleErrorInsteadOfSilence() async {
        // Issue #100: the unwired guard used to swallow the attempt with no
        // state change at all — a silent terminal state. Now it must record
        // visible trouble on the clicked account.
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(!model.canActivate)
        await model.activate(nonActiveClaudeRow(model))
        #expect(model.activatingAccountID == nil)
        #expect(model.activationError(for: "c2")?.contains("isn't available") == true)
    }
}

// MARK: - No silent activation outcomes (issue #100)

private struct FailingStateProvider: DeckStateProviding {
    func deckState() async throws -> DeckState {
        throw DaemonClientError.httpStatus(503)
    }
}

@Suite("No silent activation outcomes (issue #100)")
@MainActor
struct SilentActivationOutcomeTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "silent-activation-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func claudeRow(_ model: DeckPopoverModel, id: String) -> DeckAccountRow {
        model.columns(for: fixtureState(), now: now)[0].rows.first { $0.id == id }!
    }

    /// Derive the roster sections the Settings pane would render, from the
    /// model's own accessors — the full path a failure must travel to become
    /// a visible banner.
    private func claudeBanner(_ model: DeckPopoverModel, state: DeckState) -> ProviderActivationBanner? {
        AccountsRoster.sections(
            state: state,
            guidanceForAccount: { model.blockedActivationGuidance(for: $0) },
            errorForAccount: { model.activationError(for: $0) },
            troubleForProvider: { model.activationTrouble(for: $0) },
            warningsForProvider: { model.postActivationWarnings(for: $0) }
        ).first { $0.provider == .claude }?.banner
    }

    @Test func daemonRefusalSurfacesOnTheRosterBanner() async {
        // The issue's named regression: daemon returns an error/refusal →
        // the roster section banner surfaces it on the clicked account.
        let guidance = "claude activation requires a one-time migration: "
            + "move the existing directory aside before activating."
        let activator = StubActivator(results: [
            .failure(DaemonClientError.daemonCodedError(
                message: guidance, code: "active-link-blocked", status: 409)),
        ])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: fixtureState())
        )

        await model.activate(claudeRow(model, id: "c2"))

        let banner = claudeBanner(model, state: fixtureState())
        #expect(banner?.message == guidance, "daemon guidance renders verbatim")
        #expect(banner?.affectedAccountID == "c2")
        #expect(banner?.retryRunsActivation == true)
    }

    @Test func staleTroubleOnAnotherAccountNeverMasksANewFailure() async {
        // The issue #100 silence: a stale guidance record for one account
        // (label-sorted ahead) used to keep the single section banner's
        // pixels frozen while a NEW failure on another account landed
        // invisibly beside it. One trouble slot per provider fixes it:
        // the latest attempt's outcome always owns the banner.
        let guidance = "Move ~/.claude aside, then retry."
        let activator = StubActivator(results: [
            .failure(DaemonClientError.daemonCodedError(
                message: guidance, code: "active-link-blocked", status: 409)),
            .failure(DaemonClientError.daemonError(message: "account not found", status: 404)),
        ])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: fixtureState())
        )

        await model.activate(claudeRow(model, id: "c2"))
        #expect(model.blockedActivationGuidance(for: "c2") == guidance)

        await model.activate(claudeRow(model, id: "c3"))

        // The new failure owns the provider's single trouble slot…
        #expect(model.blockedActivationGuidance(for: "c2") == nil)
        #expect(model.activationError(for: "c3")?.contains("account not found") == true)
        // …and therefore the banner: the visible outcome is the NEW failure.
        let banner = claudeBanner(model, state: fixtureState())
        #expect(banner?.message.contains("account not found") == true)
        #expect(banner?.affectedAccountID == "c3")
    }

    @Test func clickDuringInFlightActivationRecordsVisibleTrouble() async {
        // The in-flight guard used to swallow the click silently. A stale
        // render racing an in-flight switch now records visible trouble.
        let gate = ActivationGate()
        let activator = StubActivator(
            results: [.success(account("c2", provider: "claude", label: "Client", isDefault: true))],
            gate: gate
        )
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: switchedState(claudeDefault: "c2"))
        )

        let first = claudeRow(model, id: "c2")
        let task = Task { await model.activate(first) }
        while model.activatingAccountID == nil { await Task.yield() }

        await model.activate(claudeRow(model, id: "c3"))
        #expect(model.activationError(for: "c3")?.contains("still running") == true)

        await gate.open()
        await task.value
        #expect(model.activatingAccountID == nil)
        // CodeRabbit on #126: once the in-flight switch completes
        // successfully, the raced click's "still running" record would be a
        // STALE banner beside an already-flipped radio — the verified
        // success supersedes it.
        #expect(model.activationError(for: "c3") == nil)
        #expect(model.activationTrouble(for: .claude) == nil)
    }

    @Test func successfulResyncClearsStaleProviderTrouble() async {
        // CodeRabbit on #126: the stale-already-active resync used to push
        // fresh state while an older failure record kept rendering beside
        // it. The new attempt supersedes the provider's record up front.
        let activator = StubActivator(results: [
            .failure(DaemonClientError.httpStatus(500)),
        ])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: switchedState(claudeDefault: "c2"))
        )
        var verified: DeckState?
        model.onVerifiedState = { verified = $0 }

        await model.activate(claudeRow(model, id: "c2"))
        #expect(model.activationError(for: "c2") != nil)

        let staleActiveRow = DeckAccountRow(
            account: account("c1", provider: "claude", label: "Studio", isDefault: true),
            provider: .claude,
            windows: [],
            isActive: true,
            activationState: .effective
        )
        await model.activate(staleActiveRow)

        #expect(verified != nil, "the resync still pushes the fresh state")
        #expect(model.activationError(for: "c2") == nil)
        #expect(model.activationTrouble(for: .claude) == nil)
    }

    @Test func staleAlreadyActiveClickResyncsToDaemonTruth() async {
        // The already-active guard (reachable only from a stale render) used
        // to return with zero state change. Now it re-reads the daemon state
        // and pushes it, so the radio snaps to the truth.
        let activator = StubActivator(results: [])
        let fresh = switchedState(claudeDefault: "c2")
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: fresh)
        )
        var verified: DeckState?
        model.onVerifiedState = { verified = $0 }

        let staleActiveRow = DeckAccountRow(
            account: account("c1", provider: "claude", label: "Studio", isDefault: true),
            provider: .claude,
            windows: [],
            isActive: true,
            activationState: .effective
        )
        await model.activate(staleActiveRow)

        #expect(activator.calls.isEmpty, "a resync never re-POSTs")
        #expect(verified?.accounts.first { $0.id == "c2" }?.isDefault == true)
        #expect(model.activationError(for: "c1") == nil)
    }

    @Test func staleAlreadyActiveClickWithFailingStateReadSurfacesError() async {
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: StubActivator(results: []),
            stateProvider: FailingStateProvider()
        )
        let staleActiveRow = DeckAccountRow(
            account: account("c1", provider: "claude", label: "Studio", isDefault: true),
            provider: .claude,
            windows: [],
            isActive: true,
            activationState: .effective
        )
        await model.activate(staleActiveRow)
        #expect(model.activationError(for: "c1") != nil)
    }

    @Test func newAttemptOnTheSameProviderSupersedesTheOldTrouble() async {
        // Retry semantics kept from before, now provider-wide: the moment a
        // new attempt starts, the provider's stale record is gone, and a
        // SUCCESS leaves no trouble behind.
        let activator = StubActivator(results: [
            .failure(DaemonClientError.httpStatus(500)),
            .success(account("c3", provider: "claude", label: "Personal", isDefault: true)),
        ])
        let model = DeckPopoverModel(
            defaults: freshDefaults(),
            activator: activator,
            stateProvider: StubDeckStateProvider(state: switchedState(claudeDefault: "c3"))
        )

        await model.activate(claudeRow(model, id: "c2"))
        #expect(model.activationError(for: "c2") != nil)

        await model.activate(claudeRow(model, id: "c3"))
        #expect(model.activationError(for: "c2") == nil)
        #expect(model.activationError(for: "c3") == nil)
        #expect(model.activationTrouble(for: .claude) == nil)
        #expect(claudeBanner(model, state: switchedState(claudeDefault: "c3")) == nil)
    }
}

@Suite("Menu bar pin from the deck cards (account percentage picker)")
@MainActor
struct DeckMenuBarPinTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "deck-pin-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test func togglePinPinsThenUnpins() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        var pushed: [String] = []
        model.onPinMenuBarAccount = { pushed.append($0) }

        model.toggleMenuBarPin(accountID: "acct-1")
        #expect(pushed == ["acct-1"])

        // The daemon-confirmed document lands via the settings apply…
        model.menuBarPinnedSetting = "acct-1"
        #expect(model.isMenuBarPinned("acct-1"))
        // …after which the same menu item unpins.
        model.toggleMenuBarPin(accountID: "acct-1")
        #expect(pushed == ["acct-1", ""])
    }

    @Test func toggleFollowActiveUsesTheSentinelAndNeverMatchesPlainPins() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        var pushed: [String] = []
        model.onPinMenuBarAccount = { pushed.append($0) }

        model.toggleMenuBarFollowActive(provider: .claude)
        #expect(pushed == ["active:claude"])

        model.menuBarPinnedSetting = "active:claude"
        #expect(model.isMenuBarFollowingActive(provider: .claude))
        #expect(!model.isMenuBarFollowingActive(provider: .codex))
        // A follow-active pin is not any single card's pin.
        #expect(!model.isMenuBarPinned("acct-1"))

        model.toggleMenuBarFollowActive(provider: .claude)
        #expect(pushed == ["active:claude", ""])
    }

    @Test func adoptingAConfirmedSettingNeverFiresTheCallback() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        var pushed: [String] = []
        model.onPinMenuBarAccount = { pushed.append($0) }
        model.menuBarPinnedSetting = "acct-9"
        #expect(pushed.isEmpty)
    }
}

// Issue #145 (Tim directive, live v0.3.3 — generalizes #143/#144): the
// "no reset data" placeholder is removed from ALL deck rows. A window with
// no real reset renders an empty middle slot; the #101 unanchored copy,
// rollover annotations, and provider-stated timestamps are preserved.
@Suite("No reset placeholder on any row (issue #145)")
struct NoResetPlaceholderTests {
    @Test func unusedFiveHourAndModelWeeklyWithoutResetShowEmptySlot() {
        // The live screenshot's shape: 100%-left windows the provider gave
        // no resetsAt for (no active session) — the exact rows that showed
        // "no reset data" and where the absence is self-explanatory.
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("c1", scope: "5h", remaining: 100, resetsIn: nil),
                snapshot("c1", scope: "week:fable", remaining: 100, resetsIn: nil),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        for window in row.windows {
            #expect(window.displayedResetText == nil, "\(window.scope) must render an empty slot")
            // The stored fallback string survives internally; it just never
            // reaches a row anymore.
            #expect(window.resetText == "no reset data")
        }
        // Collapsed summary is the bare title — no "· no reset data" tail.
        #expect(row.worstSummary == row.worstWindow?.title)
        #expect(row.worstSummary?.contains("no reset data") == false)
    }

    @Test func partiallyUsedWindowWithoutResetShowsLabelAndPercentCleanly() {
        // The issue's sanity case: partial usage, no reset data — label +
        // percent render cleanly, no placeholder, tooltip explanation intact.
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [snapshot("c1", scope: "5h", remaining: 40, resetsIn: nil)]
        )
        let window = DeckBuilder.rows(state: state, now: now)[0].windows[0]
        #expect(window.remainingText == "40% left")
        #expect(window.displayedResetText == nil)
        #expect(window.resetTooltip == "The provider didn't report a reset time for this window")
    }

    @Test func unanchoredWeeklyKeepsIssue101Copy() {
        // PRESERVED (#101): an unanchored weekly — zero usage, resetsAt
        // drifting at probe time + window length — keeps its honest copy.
        // That line is information, not placeholder.
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [
                UsageSnapshot(
                    accountId: "c1",
                    scope: "week",
                    remainingPercent: 100,
                    resetsAt: iso(7 * 86_400),
                    observedAt: iso(0)
                ),
            ]
        )
        let window = DeckBuilder.rows(state: state, now: now)[0].windows[0]
        #expect(window.anchor == .unanchored(windowDuration: 7 * 86_400))
        #expect(window.displayedResetText == "Resets 7 days after first use")
        #expect(window.resetTooltip.contains("Fresh window"))
    }

    @Test func unanchoredFiveHourKeepsIssue101Copy() {
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [
                UsageSnapshot(
                    accountId: "c1",
                    scope: "5h",
                    remainingPercent: 100,
                    resetsAt: iso(5 * 3600),
                    observedAt: iso(0)
                ),
            ]
        )
        let window = DeckBuilder.rows(state: state, now: now)[0].windows[0]
        #expect(window.anchor == .unanchored(windowDuration: 5 * 3600))
        #expect(window.displayedResetText == "Resets 5 hours after first use")
    }

    @Test func recentlyRolledWindowKeepsTimestampAndRolloverAnnotation() {
        // PRESERVED (#101): a recently rolled window keeps BOTH its real
        // reset timestamp and the rollover annotation.
        let rolledAgo: TimeInterval = 30 * 60
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [
                UsageSnapshot(
                    accountId: "c1",
                    scope: "week",
                    remainingPercent: 100,
                    resetsAt: iso(7 * 86_400 - rolledAgo),
                    observedAt: iso(-2 * 3600)
                ),
            ]
        )
        let window = DeckBuilder.rows(state: state, now: now)[0].windows[0]
        guard case .recentlyRolled = window.anchor else {
            Issue.record("expected recentlyRolled, got \(window.anchor)")
            return
        }
        #expect(window.displayedResetText?.hasPrefix("Resets ") == true)
        #expect(window.rolloverText?.hasPrefix("Week reset at ") == true)
    }

    @Test func providerStatedTimestampsRenderAsAlways() {
        let state = DeckState(
            accounts: [account("c1", provider: "claude", label: "Studio")],
            usage: [
                snapshot("c1", scope: "5h", remaining: 72, resetsIn: 57 * 60),
                snapshot("c1", scope: "week", remaining: 63, resetsIn: 2 * 86_400),
            ]
        )
        let row = DeckBuilder.rows(state: state, now: now)[0]
        #expect(row.windows[0].displayedResetText == "Resets in 57 min")
        #expect(row.windows[1].displayedResetText == row.windows[1].resetText)
        // And the collapsed summary keeps its "title · reset" grammar.
        #expect(row.worstSummary?.contains(" · ") == true)
    }
}
