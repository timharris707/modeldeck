import Foundation
import Testing
@testable import ModelDeckMacCore

@Suite("Worst-remaining calculator")
struct WorstRemainingCalculatorTests {
    private let accounts = [
        DeckAccount(id: "acct-a", provider: "claude", label: "Deck A"),
        DeckAccount(id: "acct-b", provider: "codex", label: "Deck B"),
        DeckAccount(id: "acct-off", provider: "claude", label: "Disabled", enabled: false),
    ]

    @Test func picksLowestRemainingAcrossAccountsAndWindows() {
        let usage = [
            UsageSnapshot(accountId: "acct-a", scope: "5h", remainingPercent: 62),
            UsageSnapshot(accountId: "acct-a", scope: "week", remainingPercent: 18, resetsAt: "2026-07-20T00:00:00Z"),
            UsageSnapshot(accountId: "acct-b", scope: "5h", remainingPercent: 40),
        ]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst == WorstRemaining(percent: 18, accountId: "acct-a", scope: "week", resetsAt: "2026-07-20T00:00:00Z"))
    }

    @Test func ignoresDisabledAccountsAndUnknownAccountIds() {
        let usage = [
            UsageSnapshot(accountId: "acct-off", scope: "5h", remainingPercent: 1),
            UsageSnapshot(accountId: "acct-ghost", scope: "5h", remainingPercent: 2),
            UsageSnapshot(accountId: "acct-b", scope: "5h", remainingPercent: 55),
        ]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst?.accountId == "acct-b")
        #expect(worst?.percent == 55)
    }

    @Test func skipsSnapshotsWithoutRemainingPercent() {
        let usage = [
            UsageSnapshot(accountId: "acct-a", scope: "5h", remainingPercent: nil),
            UsageSnapshot(accountId: "acct-a", scope: "week", remainingPercent: 77),
        ]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst?.percent == 77)
    }

    @Test func emptyUsageYieldsNil() {
        #expect(WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: []) == nil)
    }

    @Test func carriesStaleness() {
        let usage = [UsageSnapshot(accountId: "acct-a", scope: "5h", remainingPercent: 9, stale: true)]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst?.stale == true)
    }

    // MARK: - Issue #28: spend never drives the menu bar icon severity

    @Test func spendAtZeroNeverBeatsHealthyRateLimitWindows() {
        // The live-use bug: spend 0% left / no reset data must not turn the
        // icon red while 5-hour (71%) and weekly (50%) are healthy.
        let usage = [
            UsageSnapshot(accountId: "acct-a", scope: "spend", remainingPercent: 0),
            UsageSnapshot(accountId: "acct-a", scope: "5h", remainingPercent: 71),
            UsageSnapshot(accountId: "acct-a", scope: "week", remainingPercent: 50),
        ]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst?.scope == "week")
        #expect(worst?.percent == 50)
        #expect(MenuBarIconState.state(for: worst) == .plain)
    }

    @Test func spendIsExcludedAcrossAccountsToo() {
        let usage = [
            UsageSnapshot(accountId: "acct-a", scope: "spend", remainingPercent: 2),
            UsageSnapshot(accountId: "acct-b", scope: "5h", remainingPercent: 64),
        ]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst?.accountId == "acct-b")
        #expect(worst?.percent == 64)
    }

    @Test func fallsBackToSpendWhenNoOtherScopeExists() {
        let usage = [UsageSnapshot(accountId: "acct-a", scope: "spend", remainingPercent: 8)]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst?.scope == "spend")
        #expect(worst?.percent == 8)
    }

    @Test func unknownUsageOnARateLimitScopeStillBlocksSpendFallback() {
        // CodeRabbit (PR #29): a non-spend scope whose usage is unknown must
        // still keep spend from seizing the headline — the result is "no
        // headline" (plain icon), never a spend takeover.
        let usage = [
            UsageSnapshot(accountId: "acct-a", scope: "week", remainingPercent: nil),
            UsageSnapshot(accountId: "acct-a", scope: "spend", remainingPercent: 0),
        ]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst == nil)
        #expect(MenuBarIconState.state(for: worst) == .plain)
    }

    @Test func modelScopedWeeklyRemainsHeadlineEligible() {
        // Contrast with spend: a critical scoped weekly from the limits
        // payload wins over a healthy all-models weekly.
        let usage = [
            UsageSnapshot(accountId: "acct-a", scope: "week", remainingPercent: 49),
            UsageSnapshot(accountId: "acct-a", scope: "Fable weekly", remainingPercent: 4),
        ]
        let worst = WorstRemainingCalculator.worstRemaining(accounts: accounts, usage: usage)
        #expect(worst?.scope == "Fable weekly")
        #expect(MenuBarIconState.state(for: worst) == .critical(percentRemaining: 4))
    }

    @Test func spendScopeClassification() {
        #expect(UsageScope.isSpend("spend"))
        #expect(UsageScope.isSpend("Spend"))
        #expect(UsageScope.isSpend("monthly spend"))
        #expect(!UsageScope.isSpend("week"))
        #expect(!UsageScope.isSpend("Fable weekly"))
        #expect(!UsageScope.isSpend("5h"))
    }
}

@Suite("Plan tier formatter (issue #26 Claude half; issue #30 generic)")
struct PlanTierFormatterTests {
    @Test func combinesSubscriptionAndTierMultiplier() {
        #expect(PlanTierFormatter.label(subscriptionType: "max", rateLimitTier: "default_claude_max_20x") == "Max (20x)")
        #expect(PlanTierFormatter.label(subscriptionType: "max", rateLimitTier: "default_claude_max_5x") == "Max (5x)")
    }

    @Test func fallsBackToSubscriptionAlone() {
        #expect(PlanTierFormatter.label(subscriptionType: "max", rateLimitTier: nil) == "Max")
        #expect(PlanTierFormatter.label(subscriptionType: "pro", rateLimitTier: "unrecognized_tier") == "Pro")
        // Codex tier strings (issue #30): capitalized as-is.
        #expect(PlanTierFormatter.label(subscriptionType: "plus", rateLimitTier: nil) == "Plus")
    }

    @Test func derivesFromTierWhenSubscriptionMissing() {
        #expect(PlanTierFormatter.label(subscriptionType: nil, rateLimitTier: "default_claude_max_20x") == "Max (20x)")
        #expect(PlanTierFormatter.label(subscriptionType: nil, rateLimitTier: "chatgpt_plus") == "Plus")
    }

    @Test func rendersNothingWhenUnknown() {
        #expect(PlanTierFormatter.label(subscriptionType: nil, rateLimitTier: nil) == nil)
        #expect(PlanTierFormatter.label(subscriptionType: "", rateLimitTier: nil) == nil)
        #expect(PlanTierFormatter.label(subscriptionType: nil, rateLimitTier: "totally_unrecognized") == nil)
    }

    @Test func accountPlanLabelReadsDaemonMetadata() throws {
        let json = """
        {"id":"c1","provider":"claude","label":"Studio","enabled":true,"isDefault":true,
         "metadata":{"claudePlan":{"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"},"otherKey":123}}
        """
        let account = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        #expect(account.planLabel == "Max (20x)")
        // Empty/absent metadata renders nothing.
        let bare = DeckAccount(id: "c2", provider: "claude", label: "Bare")
        #expect(bare.planLabel == nil)
    }

    // Issue #30: tier rendering is provider-generic ahead of #26's Codex
    // payload — whichever reasonable shape the daemon ships lights up
    // without further UI work.

    private func decode(_ metadataJSON: String) throws -> DeckAccount {
        let json = """
        {"id":"x1","provider":"codex","label":"Studio","enabled":true,"isDefault":false,
         "metadata":\(metadataJSON)}
        """
        return try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
    }

    @Test func codexPlanObjectMirroringClaudeField() throws {
        let account = try decode(#"{"codexPlan":{"planType":"pro"}}"#)
        #expect(account.planLabel == "Pro")
    }

    @Test func codexPlanAsBareString() throws {
        let account = try decode(#"{"codexPlan":"plus"}"#)
        #expect(account.planLabel == "Plus")
    }

    @Test func genericPlanKeyAndAlternateSpellings() throws {
        #expect(try decode(#"{"plan":"Pro"}"#).planLabel == "Pro")
        #expect(try decode(#"{"plan":{"subscriptionType":"plus"}}"#).planLabel == "Plus")
        #expect(try decode(#"{"codexPlan":{"tier":"chatgpt_plus"}}"#).planLabel == "Plus")
    }

    @Test func claudePlanWinsWhenMultiplePresent() throws {
        let account = try decode(#"{"claudePlan":{"subscriptionType":"max"},"codexPlan":"pro"}"#)
        #expect(account.planLabel == "Max")
    }

    @Test func absentOrUnrecognizedPlanRendersNothing() throws {
        #expect(try decode(#"{}"#).planLabel == nil)
        #expect(try decode(#"{"codexPlan":{"unrelated":true}}"#).planLabel == nil)
    }

    // CodeRabbit finding on PR #35: a malformed plan value (number, bool,
    // array, null) must decode as empty plan info — the tier renders
    // nothing — never fail the whole account decode.
    @Test func malformedPlanShapesDecodeAsEmptyPlanInfo() throws {
        #expect(try decode(#"{"codexPlan":123}"#).planLabel == nil)
        #expect(try decode(#"{"codexPlan":true}"#).planLabel == nil)
        #expect(try decode(#"{"codexPlan":["pro"]}"#).planLabel == nil)
        #expect(try decode(#"{"codexPlan":null}"#).planLabel == nil)
        #expect(try decode(#"{"plan":4.5}"#).planLabel == nil)
        // A malformed sibling never blocks a valid plan elsewhere.
        #expect(try decode(#"{"codexPlan":[1],"plan":"pro"}"#).planLabel == "Pro")
    }
}

@Suite("Menu bar icon state thresholds")
struct MenuBarIconStateTests {
    private func worst(_ percent: Double) -> WorstRemaining {
        WorstRemaining(percent: percent, accountId: "acct-a", scope: "5h")
    }

    @Test func healthyAboveWarningThresholdIsPlain() {
        #expect(MenuBarIconState.state(for: worst(26)) == .plain)
        #expect(MenuBarIconState.state(for: worst(100)) == .plain)
    }

    @Test func warningAtAndBelowTwentyFivePercent() {
        #expect(MenuBarIconState.state(for: worst(25)) == .warning(percentRemaining: 25))
        #expect(MenuBarIconState.state(for: worst(11)) == .warning(percentRemaining: 11))
    }

    @Test func criticalAtAndBelowTenPercent() {
        #expect(MenuBarIconState.state(for: worst(10)) == .critical(percentRemaining: 10))
        #expect(MenuBarIconState.state(for: worst(0)) == .critical(percentRemaining: 0))
    }

    @Test func noDataHidesThePercent() {
        #expect(MenuBarIconState.state(for: nil) == .plain)
    }

    @Test func customThresholdsApply() {
        let thresholds = UsageThresholds(warningPercent: 50, criticalPercent: 20)
        #expect(MenuBarIconState.state(for: worst(45), thresholds: thresholds) == .warning(percentRemaining: 45))
        #expect(MenuBarIconState.state(for: worst(20), thresholds: thresholds) == .critical(percentRemaining: 20))
        #expect(MenuBarIconState.state(for: worst(51), thresholds: thresholds) == .plain)
    }

    @Test func percentLabelFormatting() {
        #expect(MenuBarIconState.plain.percentLabel == nil)
        #expect(MenuBarIconState.warning(percentRemaining: 18).percentLabel == "18%")
        #expect(MenuBarIconState.critical(percentRemaining: 4).percentLabel == "4%")
    }

    @Test func fractionalPercentsRoundForDisplay() {
        #expect(MenuBarIconState.state(for: worst(17.6)) == .warning(percentRemaining: 18))
        #expect(MenuBarIconState.state(for: worst(9.4)) == .critical(percentRemaining: 9))
    }
}
