import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #113 — reachable explanations. Tooltips never appear inside the
// MenuBarExtra window, so every warning affordance opens an anchored
// explanation popover on click. These tests cover the presentation state
// (which affordance is presented — one at a time, toggle semantics,
// binding-shaped dismissal) and the content selection per affordance
// (verbatim reuse of the existing explanation strings — no diverging copy).

@Suite("Warning explanation presentation state (issue #113)")
@MainActor
struct WarningPresentationStateTests {
    private func model() -> DeckPopoverModel {
        let defaults = UserDefaults(suiteName: "warning-tests-\(UUID().uuidString)")!
        return DeckPopoverModel(defaults: defaults)
    }

    private let marker = DeckWarningID(topic: .duplicateToken, elementID: "acct-1")
    private let stale = DeckWarningID(topic: .staleData, elementID: "acct-1")
    private let footer = DeckWarningID(topic: .footerFreshness)

    @Test func nothingPresentedInitially() {
        let model = model()
        #expect(model.presentedWarning == nil)
        #expect(!model.isWarningPresented(marker))
    }

    @Test func togglePresentsAndSecondToggleDismisses() {
        let model = model()
        model.toggleWarning(marker)
        #expect(model.isWarningPresented(marker))
        model.toggleWarning(marker)
        #expect(model.presentedWarning == nil)
    }

    @Test func togglingADifferentAffordanceSwitchesTheSingleSlot() {
        let model = model()
        model.toggleWarning(marker)
        model.toggleWarning(stale)
        #expect(model.isWarningPresented(stale))
        #expect(!model.isWarningPresented(marker))
        #expect(model.presentedWarning == stale)
    }

    @Test func sameTopicOnDifferentAccountsAreDistinctAffordances() {
        let model = model()
        let other = DeckWarningID(topic: .staleData, elementID: "acct-2")
        model.toggleWarning(stale)
        #expect(!model.isWarningPresented(other))
        model.toggleWarning(other)
        #expect(model.isWarningPresented(other))
        #expect(!model.isWarningPresented(stale))
    }

    @Test func setterPresentsAndDismisses() {
        let model = model()
        model.setWarningPresented(footer, true)
        #expect(model.isWarningPresented(footer))
        model.setWarningPresented(footer, false)
        #expect(model.presentedWarning == nil)
    }

    @Test func staleFalseFromASupersededPopoverNeverDismissesTheSuccessor() {
        let model = model()
        model.setWarningPresented(marker, true)
        model.setWarningPresented(stale, true)
        // The marker popover's binding writes false as it closes — that
        // must not tear down the stale popover that took the slot.
        model.setWarningPresented(marker, false)
        #expect(model.isWarningPresented(stale))
    }

    @Test func footerAffordancesShareTheFooterElementID() {
        #expect(DeckWarningID(topic: .refreshCadence).elementID == DeckWarningID.footerElementID)
        #expect(DeckWarningID(topic: .refreshCadence) != DeckWarningID(topic: .footerFreshness))
    }

    // MARK: Reconcile — CodeRabbit on #113: SwiftUI never resets an
    // isPresented binding when the anchoring popover leaves the hierarchy,
    // so a fresh deck state must clear a presented warning whose affordance
    // is no longer live.

    private func row(
        id: String,
        authState: String? = nil,
        stale: Bool = false
    ) -> (DeckAccountRow, DeckFreshness.CardStaleness?) {
        let row = DeckAccountRow(
            account: DeckAccount(id: id, provider: "claude", label: "Studio", authState: authState),
            provider: .claude,
            windows: [],
            isActive: false
        )
        let staleness = stale
            ? DeckFreshness.CardStaleness(text: "Data from 2 hr ago", tooltip: "t", accessibilityLabel: "a")
            : nil
        return (row, staleness)
    }

    @Test func reconcileClearsAWarningWhoseAffordanceDisappeared() {
        let model = model()
        // Keychain access was granted between refreshes: the notice is gone.
        model.toggleWarning(DeckWarningID(topic: .keychainAccess, elementID: "acct-1"))
        let (fresh, _) = row(id: "acct-1", authState: "ok")
        model.reconcileWarnings(rows: [fresh], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.presentedWarning == nil)
    }

    @Test func reconcileClearsAStaleWarningOnceTheAccountRefreshes() {
        let model = model()
        let id = DeckWarningID(topic: .staleData, elementID: "acct-1")
        let (r, staleness) = row(id: "acct-1", stale: true)
        model.toggleWarning(id)
        // Still stale: the explanation stays up.
        model.reconcileWarnings(rows: [r], staleness: { _ in staleness }, cadenceNoticeVisible: false)
        #expect(model.isWarningPresented(id))
        // Refresh landed fresh data: the line is gone, the popover follows.
        model.reconcileWarnings(rows: [r], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.presentedWarning == nil)
    }

    @Test func reconcileKeepsALiveDuplicateTokenWarning() {
        let model = model()
        let id = DeckWarningID(topic: .duplicateToken, elementID: "acct-1")
        let (flagged, _) = row(id: "acct-1", authState: "duplicate-token")
        model.toggleWarning(id)
        model.reconcileWarnings(rows: [flagged], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.isWarningPresented(id))
        // The flag cleared after a fresh /login: the marker and its
        // explanation both go.
        let (cleared, _) = row(id: "acct-1", authState: "ok")
        model.reconcileWarnings(rows: [cleared], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.presentedWarning == nil)
    }

    @Test func reconcileClearsWarningsForRemovedRows() {
        let model = model()
        model.toggleWarning(DeckWarningID(topic: .duplicateToken, elementID: "acct-gone"))
        model.reconcileWarnings(rows: [], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.presentedWarning == nil)
    }

    @Test func reconcileClearsTheCadenceWarningWhenTheCapLifts() {
        let model = model()
        let id = DeckWarningID(topic: .refreshCadence)
        model.toggleWarning(id)
        model.reconcileWarnings(rows: [], staleness: { _ in nil }, cadenceNoticeVisible: true)
        #expect(model.isWarningPresented(id))
        model.reconcileWarnings(rows: [], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.presentedWarning == nil)
    }

    @Test func reconcileKeepsALiveSignInWarningAndClearsItOnceSignedIn() {
        // Issue #118: the sign-in-needed notice is a warning affordance like
        // any other — its explanation survives while the notice renders and
        // is dismissed at the model once a verified sign-in clears it.
        let model = model()
        let id = DeckWarningID(topic: .signInRequired, elementID: "acct-1")
        let (needsSignIn, _) = row(id: "acct-1", authState: "signin-required")
        model.toggleWarning(id)
        model.reconcileWarnings(rows: [needsSignIn], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.isWarningPresented(id))
        let (signedIn, _) = row(id: "acct-1", authState: "ok")
        model.reconcileWarnings(rows: [signedIn], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.presentedWarning == nil)
    }

    @Test func footerFreshnessIsAlwaysLive() {
        let model = model()
        // The footer line always renders, so its explanation survives any
        // reconcile — including an empty deck.
        model.toggleWarning(footer)
        model.reconcileWarnings(rows: [], staleness: { _ in nil }, cadenceNoticeVisible: false)
        #expect(model.isWarningPresented(footer))
    }
}

@Suite("Warning explanation content (issue #113)")
struct WarningExplanationContentTests {
    @Test func duplicateTokenReusesMarkerCaptionAndBannerDetail() {
        let explanation = DeckWarningExplanation.duplicateToken()
        #expect(explanation.title == "Duplicate login")
        #expect(explanation.body == "\(DuplicateTokenMarker.caption).\n\n\(AccountsRoster.duplicateTokenDetail)")
    }

    @Test func duplicateTokenWithReloginLabelAppendsThePinnedHint() {
        // Issue #152: when the explanation carries the "Re-log in" action,
        // one more line names the profile the button re-logs — verbatim from
        // DuplicateTokenMarker.reloginHint, never popover-local copy.
        // Placeholder labels only.
        let explanation = DeckWarningExplanation.duplicateToken(
            reloginLabel: "Work", provider: .codex
        )
        #expect(explanation.title == "Duplicate login")
        #expect(explanation.body ==
            "\(DuplicateTokenMarker.caption).\n\n\(AccountsRoster.duplicateTokenDetail)"
            + "\n\n\(DuplicateTokenMarker.reloginHint(label: "Work", providerName: "Codex"))")
    }

    @Test func duplicateTokenReloginHintWithoutAProviderStaysGeneric() {
        // An unknown provider string must never invent a provider name.
        let explanation = DeckWarningExplanation.duplicateToken(
            reloginLabel: "Work", provider: nil
        )
        #expect(explanation.body.contains(
            DuplicateTokenMarker.reloginHint(label: "Work", providerName: "the provider")))
    }

    @Test func staleReusesTheTooltipVerbatim() {
        let staleness = DeckFreshness.CardStaleness(
            text: "Data from 16 hr ago",
            tooltip: "Data from 16 hr ago — Last refresh failed: token expired",
            accessibilityLabel: "unused here"
        )
        let explanation = DeckWarningExplanation.stale(staleness)
        #expect(explanation.title == "Stale data")
        #expect(explanation.body == staleness.tooltip)
    }

    @Test func keychainReusesNoticeTextAndTooltip() {
        let account = DeckAccount(id: "a", provider: "claude", label: "Studio", authState: "keychain-denied")
        let recovery = DeckFreshness.keychainRecovery(for: account)!
        let explanation = DeckWarningExplanation.keychain(recovery)
        #expect(explanation.title == recovery.text)
        #expect(explanation.body == recovery.tooltip)
    }

    @Test func signInReusesNoticeTextAndTooltip() {
        // Issues #114/#118: the explanation body is the existing recovery
        // tooltip verbatim — the popover adds the action, never new copy.
        let account = DeckAccount(id: "a", provider: "claude", label: "Studio", authState: "signin-required")
        let recovery = DeckFreshness.signInRecovery(for: account)!
        let explanation = DeckWarningExplanation.signIn(recovery)
        #expect(explanation.title == recovery.text)
        #expect(explanation.title == "Sign in needed")
        #expect(explanation.body == recovery.tooltip)
    }

    @Test func signInReusesTheIdleToneVerbatimToo() {
        // Issue #149: the calm idle tone flows through the SAME builder —
        // same affordance, same popover anatomy, tone-honest strings only.
        let account = DeckAccount(
            id: "a", provider: "claude", label: "Studio",
            authState: "signin-required", signinReason: "expired"
        )
        let recovery = DeckFreshness.signInRecovery(for: account)!
        let explanation = DeckWarningExplanation.signIn(recovery)
        #expect(explanation.title == "Idle — renews on next use")
        #expect(explanation.body == recovery.tooltip)
    }

    @Test func cadenceReusesNoticeTextAndTooltip() {
        let notice = MenuBarStatusModel.RefreshCadenceNotice(
            text: "Auto-refresh slowed",
            tooltip: "A CLI session is running…"
        )
        let explanation = DeckWarningExplanation.cadence(notice)
        #expect(explanation.title == notice.text)
        #expect(explanation.body == notice.tooltip)
    }
}

// Issue #113 addendum: clicking the footer's oldest-data line names the
// account(s) dragging the number — Tim read an unchanged "Oldest data 14 hr
// ago" after a partially-successful Refresh as a refresh bug because
// nothing said WHICH account was stale.
@Suite("Footer freshness explanation (issue #113 addendum)")
struct FooterFreshnessExplanationTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let interval: TimeInterval = 300 // stale threshold = 600 s

    private func iso(secondsAgo: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
    }

    private func snapshot(_ accountId: String, secondsAgo: TimeInterval, scope: String = "5h") -> UsageSnapshot {
        UsageSnapshot(
            accountId: accountId, scope: scope, remainingPercent: 50,
            observedAt: iso(secondsAgo: secondsAgo)
        )
    }

    private func explanation(for state: DeckState?) -> DeckWarningExplanation {
        DeckFreshness.footerFreshnessExplanation(state: state, now: now, autoRefreshInterval: interval)
    }

    @Test func staleAccountsAreNamedWithTheirAgesOldestFirst() {
        let state = DeckState(
            accounts: [
                DeckAccount(id: "a", provider: "claude", label: "Studio"),
                DeckAccount(id: "b", provider: "claude", label: "Client"),
                DeckAccount(id: "c", provider: "codex", label: "Personal"),
            ],
            usage: [
                snapshot("a", secondsAgo: 120), // fresh
                snapshot("b", secondsAgo: 57_600), // 16 hr — stale
                snapshot("c", secondsAgo: 7_200), // 2 hr — stale
            ]
        )
        let explanation = explanation(for: state)
        #expect(explanation.title == "Data freshness")
        #expect(explanation.body.contains("OLDEST"))
        #expect(explanation.body.contains("• Client — data from 16 hr ago"))
        #expect(explanation.body.contains("• Personal — data from 2 hr ago"))
        // Fresh account never listed; oldest listed first.
        #expect(!explanation.body.contains("Studio"))
        let clientIndex = explanation.body.range(of: "Client")!.lowerBound
        let personalIndex = explanation.body.range(of: "Personal")!.lowerBound
        #expect(clientIndex < personalIndex)
    }

    @Test func freshDeckSaysAllAccountsAreFresh() {
        let state = DeckState(
            accounts: [
                DeckAccount(id: "a", provider: "claude", label: "Studio"),
                DeckAccount(id: "b", provider: "codex", label: "Client"),
            ],
            usage: [
                snapshot("a", secondsAgo: 60),
                snapshot("b", secondsAgo: 120),
            ]
        )
        let explanation = explanation(for: state)
        #expect(explanation.body.contains("All accounts are currently fresh."))
        #expect(!explanation.body.contains("Waiting on"))
    }

    @Test func staleLineCarriesTheLastRefreshErrorViaTheSharedDerivation() {
        // Single source of truth: the per-account listing uses the SAME
        // cardStaleness derivation the cards use, so the footer explanation
        // and a card's own line can never disagree about an account's age.
        let account = DeckAccount(
            id: "b", provider: "claude", label: "Client",
            lastRefreshError: AccountRefreshError(message: "token expired", at: nil)
        )
        let state = DeckState(accounts: [account], usage: [snapshot("b", secondsAgo: 57_600)])
        let expected = DeckFreshness.cardStaleness(
            newestObservedAt: now.addingTimeInterval(-57_600),
            lastRefreshError: account.lastRefreshError,
            now: now,
            autoRefreshInterval: interval
        )!
        #expect(explanation(for: state).body.contains("• Client — data from 16 hr ago"))
        #expect(expected.text == "Data from 16 hr ago")
    }

    @Test func disabledAccountsAreExcluded() {
        let state = DeckState(
            accounts: [
                DeckAccount(id: "a", provider: "claude", label: "Studio"),
                DeckAccount(id: "b", provider: "claude", label: "Retired", enabled: false),
            ],
            usage: [
                snapshot("a", secondsAgo: 60),
                snapshot("b", secondsAgo: 90_000),
            ]
        )
        let explanation = explanation(for: state)
        #expect(!explanation.body.contains("Retired"))
        #expect(explanation.body.contains("All accounts are currently fresh."))
    }

    @Test func accountsWithoutObservationsAreNotListed() {
        // No observation at all = nothing to present as stale (the card
        // shows no meters, and the footer basis ignores it too).
        let state = DeckState(
            accounts: [DeckAccount(id: "a", provider: "claude", label: "Studio")],
            usage: []
        )
        #expect(explanation(for: state).body.contains("All accounts are currently fresh."))
    }

    @Test func nilOrEmptyStateExplainsWithoutClaimingFreshness() {
        #expect(explanation(for: nil).body.contains("No account data has arrived yet."))
        #expect(explanation(for: DeckState()).body.contains("No account data has arrived yet."))
    }
}

// Issue #118 — the deck's "Sign in needed" notice offers a one-click path
// into the roster's EXISTING re-login flow. The model's plumbing: which
// account gets targeted, the explanation popover dismisses when the button
// fires, Settings routes to the Accounts pane, and the whole thing no-ops
// safely when the notice cleared or the account vanished mid-flight.
@Suite("Sign in again from the deck (issue #118)")
@MainActor
struct SignInAgainActionTests {
    private func model() -> DeckPopoverModel {
        let defaults = UserDefaults(suiteName: "signin-again-tests-\(UUID().uuidString)")!
        return DeckPopoverModel(defaults: defaults)
    }

    private func row(
        id: String,
        authState: String? = "signin-required",
        signinReason: String? = nil
    ) -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(
                id: id, provider: "claude", label: "Client",
                authState: authState, signinReason: signinReason
            ),
            provider: .claude,
            windows: [],
            isActive: false
        )
    }

    @Test func requestTargetsExactlyTheClickedAccount() {
        let model = model()
        var requested: [String] = []
        model.onSignInAgain = { requested.append($0) }
        model.requestSignInAgain(for: row(id: "acct-2"))
        #expect(requested == ["acct-2"])
    }

    @Test func requestDismissesThePresentedExplanation() {
        let model = model()
        let id = DeckWarningID(topic: .signInRequired, elementID: "acct-1")
        model.toggleWarning(id)
        model.onSignInAgain = { _ in }
        model.requestSignInAgain(for: row(id: "acct-1"))
        #expect(model.presentedWarning == nil)
    }

    @Test func requestRoutesSettingsToTheAccountsPane() {
        let model = model()
        model.settingsPane = .general // the user last viewed General
        model.requestSignInAgain(for: row(id: "acct-1"))
        #expect(model.settingsPane == .accounts)
    }

    @Test func requestNoOpsWhenTheNoticeAlreadyCleared() {
        // A verified sign-in landed between render and click: the recovery
        // notice is gone, so re-launching the flow would be noise. The
        // dismissal still happens (the popover the button lived in closes).
        let model = model()
        model.toggleWarning(DeckWarningID(topic: .signInRequired, elementID: "acct-1"))
        var fired = false
        model.onSignInAgain = { _ in fired = true }
        model.requestSignInAgain(for: row(id: "acct-1", authState: "ok"))
        #expect(!fired)
        #expect(model.presentedWarning == nil)
    }

    @Test func requestWithoutAHandlerIsSafe() {
        let model = model()
        model.requestSignInAgain(for: row(id: "acct-1")) // no crash, no handler
        #expect(model.settingsPane == .accounts)
    }

    @Test func signInAgainTargetResolvesAgainstFreshState() {
        let account = DeckAccount(id: "acct-1", provider: "claude", label: "Client", authState: "signin-required")
        let state = DeckState(accounts: [account], usage: [])
        #expect(DeckPopoverModel.signInAgainTarget(accountID: "acct-1", state: state) == account)
    }

    @Test func requestFiresFromTheIdleNoticeToo() {
        // Issue #149 (Tim directive): the calm idle tone must drive the
        // EXACT same one-click flow — the split never weakens the recovery
        // loop. Same handler, same account targeting, same pane routing.
        let model = model()
        var requested: [String] = []
        model.onSignInAgain = { requested.append($0) }
        model.settingsPane = .general
        model.requestSignInAgain(for: row(id: "acct-3", signinReason: "expired"))
        #expect(requested == ["acct-3"])
        #expect(model.settingsPane == .accounts)
    }

    @Test func signInAgainTargetResolvesIdleAccountsToo() {
        // Issue #149: the resolver keys on the same signInRecovery
        // derivation, so an idle-decayed ("expired") account is a valid
        // sign-in target exactly like a signed-out one.
        let idle = DeckAccount(
            id: "acct-1", provider: "claude", label: "Client",
            authState: "signin-required", signinReason: "expired"
        )
        let state = DeckState(accounts: [idle], usage: [])
        #expect(DeckPopoverModel.signInAgainTarget(accountID: "acct-1", state: state) == idle)
    }

    @Test func signInAgainTargetNoOpsWhenTheAccountRecoveredMeanwhile() {
        // CodeRabbit on #119: a render-time click can dispatch after a
        // verified sign-in already landed in fresh state — the resolver must
        // check recovery-required (the SAME signInRecovery derivation the
        // notice renders from), not just the id, or the stale click launches
        // a login for a healthy account.
        let recovered = DeckAccount(id: "acct-1", provider: "claude", label: "Client", authState: "ok")
        let state = DeckState(accounts: [recovered], usage: [])
        #expect(DeckPopoverModel.signInAgainTarget(accountID: "acct-1", state: state) == nil)
    }

    @Test func signInAgainTargetNoOpsWhenTheAccountVanished() {
        // Removed between click and dispatch — nil means the app launches
        // nothing rather than a login flow for a ghost account.
        let state = DeckState(
            accounts: [DeckAccount(id: "other", provider: "claude", label: "Studio")],
            usage: []
        )
        #expect(DeckPopoverModel.signInAgainTarget(accountID: "acct-1", state: state) == nil)
        #expect(DeckPopoverModel.signInAgainTarget(accountID: "acct-1", state: nil) == nil)
    }

    @Test func signInNoticeIsALiveWarningAffordance() {
        // The #115 reconcile knows the notice: present while signin-required.
        let live = DeckPopoverModel.liveWarningIDs(
            rows: [row(id: "acct-1")],
            staleness: { _ in nil },
            cadenceNoticeVisible: false
        )
        #expect(live.contains(DeckWarningID(topic: .signInRequired, elementID: "acct-1")))
    }
}

// Issue #152 — the duplicate-login warning's "Re-log in" one-click path:
// the exact #118 anatomy with the guard keyed on the duplicate flag. Tim,
// live: "it doesn't help me fix it or resolve it… I need something
// clickable to fix the issue, not just telling me there's an issue."
// Placeholder identities only — never real account data.
@Suite("Duplicate re-login from the deck (issue #152)")
@MainActor
struct DuplicateReloginActionTests {
    private func model() -> DeckPopoverModel {
        let defaults = UserDefaults(suiteName: "dup-relogin-tests-\(UUID().uuidString)")!
        return DeckPopoverModel(defaults: defaults)
    }

    private func row(
        id: String,
        provider: String = "codex",
        authState: String? = "duplicate-token"
    ) -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(
                id: id, provider: provider, label: "Work", authState: authState
            ),
            provider: DeckProvider.from(provider),
            windows: [],
            isActive: false
        )
    }

    @Test func requestTargetsExactlyTheClickedAccount() {
        let model = model()
        var requested: [String] = []
        model.onDuplicateRelogin = { requested.append($0) }
        model.requestDuplicateRelogin(for: row(id: "codex-2"))
        #expect(requested == ["codex-2"])
    }

    @Test func requestDismissesThePresentedExplanation() {
        let model = model()
        model.toggleWarning(DeckWarningID(topic: .duplicateToken, elementID: "codex-1"))
        model.onDuplicateRelogin = { _ in }
        model.requestDuplicateRelogin(for: row(id: "codex-1"))
        #expect(model.presentedWarning == nil)
    }

    @Test func requestRoutesSettingsToTheAccountsPane() {
        let model = model()
        model.settingsPane = .general
        model.requestDuplicateRelogin(for: row(id: "codex-1"))
        #expect(model.settingsPane == .accounts)
    }

    @Test func requestNoOpsWhenTheFlagAlreadyCleared() {
        // A corrective /login landed between render and click: launching
        // another login for a healthy account would be noise. The dismissal
        // still happens (the popover the button lived in closes).
        let model = model()
        model.toggleWarning(DeckWarningID(topic: .duplicateToken, elementID: "codex-1"))
        var fired = false
        model.onDuplicateRelogin = { _ in fired = true }
        model.requestDuplicateRelogin(for: row(id: "codex-1", authState: "ok"))
        #expect(!fired)
        #expect(model.presentedWarning == nil)
    }

    @Test func requestWithoutAHandlerIsSafe() {
        let model = model()
        model.requestDuplicateRelogin(for: row(id: "codex-1")) // no crash
        #expect(model.settingsPane == .accounts)
    }

    @Test func requestWorksForClaudeDuplicatesToo() {
        // The mechanism is provider-generic, exactly like the #65/#108
        // marker itself — one re-login path, both providers.
        let model = model()
        var requested: [String] = []
        model.onDuplicateRelogin = { requested.append($0) }
        model.requestDuplicateRelogin(for: row(id: "claude-1", provider: "claude"))
        #expect(requested == ["claude-1"])
    }

    @Test func reloginTargetResolvesAgainstFreshState() {
        let account = DeckAccount(
            id: "codex-1", provider: "codex", label: "Work", authState: "duplicate-token"
        )
        let state = DeckState(accounts: [account], usage: [])
        #expect(DeckPopoverModel.duplicateReloginTarget(accountID: "codex-1", state: state) == account)
    }

    @Test func reloginTargetNoOpsWhenTheFlagClearedMeanwhile() {
        // Same never-diverge contract as signInAgainTarget: the resolver
        // keys on the SAME hasDuplicateToken derivation the marker renders
        // from, so a stale click never launches a login for a resolved pair.
        let resolved = DeckAccount(id: "codex-1", provider: "codex", label: "Work", authState: "ok")
        let state = DeckState(accounts: [resolved], usage: [])
        #expect(DeckPopoverModel.duplicateReloginTarget(accountID: "codex-1", state: state) == nil)
    }

    @Test func reloginTargetNoOpsWhenTheAccountVanished() {
        let state = DeckState(
            accounts: [DeckAccount(id: "other", provider: "codex", label: "Second")],
            usage: []
        )
        #expect(DeckPopoverModel.duplicateReloginTarget(accountID: "codex-1", state: state) == nil)
        #expect(DeckPopoverModel.duplicateReloginTarget(accountID: "codex-1", state: nil) == nil)
    }
}
