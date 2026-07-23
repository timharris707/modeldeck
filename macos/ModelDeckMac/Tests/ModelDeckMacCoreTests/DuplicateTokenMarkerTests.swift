import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #65 (UI half): the daemon's usage-fingerprint check sets per-account
// authState "duplicate-token" on every Claude account in a group whose weekly
// reset instants match — two profiles holding the same login. The UI renders
// a hollow warning marker per flagged row plus the section's consolidated
// banner. All placeholder identities (user@example.com) — never real data.

@Suite("Duplicate-token flag (issue #65)")
struct DuplicateTokenFlagTests {
    @Test func duplicateTokenAuthStateSetsTheFlag() {
        #expect(DeckAccount(id: "a", provider: "claude", label: "A", authState: "duplicate-token").hasDuplicateToken)
        // Lenient casing, matching ProviderActivationState.from.
        #expect(DeckAccount(id: "a", provider: "claude", label: "A", authState: "Duplicate-Token").hasDuplicateToken)
    }

    @Test func otherAuthStatesDoNotSetTheFlag() {
        for authState: String? in [nil, "ok", "signin-required", "unknown", "some-future-state"] {
            let account = DeckAccount(id: "a", provider: "claude", label: "A", authState: authState)
            #expect(!account.hasDuplicateToken)
        }
    }

    @Test func duplicateTokenKeepsTheHonestUnknownChip() {
        // The account IS signed in — just as the wrong login. Never a false
        // "Sign in again"; the hollow marker carries the warning instead.
        let account = DeckAccount(id: "a", provider: "claude", label: "A", authState: "duplicate-token")
        #expect(account.healthChip == .unknown)
    }

    // MARK: - Tolerant decode (older daemons must produce no false warnings)

    @Test func accountWithoutAuthStateDecodesWithFlagOff() throws {
        let json = #"{"accounts": [{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": true}], "usage": []}"#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        #expect(state.accounts.count == 1)
        #expect(!state.accounts[0].hasDuplicateToken)
        #expect(AccountsRoster.sections(state: state)[0].banner == nil)
    }

    @Test func accountWithDuplicateTokenAuthStateDecodesWithFlagOn() throws {
        let json = #"{"accounts": [{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": false, "authState": "duplicate-token"}], "usage": []}"#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        #expect(state.accounts[0].hasDuplicateToken)
    }

    // MARK: - Marker strings (tooltip + VoiceOver per the issue)

    @Test func markerCaptionMatchesTheIssueWording() {
        #expect(DuplicateTokenMarker.caption
            == "Two profiles appear to hold the same login — redo /login for one")
    }

    @Test func accessibilityLabelNamesTheStateAndCarriesTheCaption() {
        // The #55/#62 marker pattern: "state — caption", so VoiceOver users
        // get both the warning and the remedy.
        #expect(DuplicateTokenMarker.accessibilityLabel.contains("Duplicate login"))
        #expect(DuplicateTokenMarker.accessibilityLabel.contains("redo /login for one"))
    }

    @Test func reloginHintNamesTheProfileAndTheEitherMemberResolution() {
        // Issue #152: the pinned hint behind the "Re-log in" action — it
        // must name WHICH profile the button re-logs and that re-logging
        // either member of the duplicate pair under its correct account
        // resolves both. Placeholder labels only.
        #expect(DuplicateTokenMarker.reloginHint(label: "Work", providerName: "Codex")
            == "Re-log in opens Codex's own login for Work. "
            + "Re-logging either duplicate under its correct account clears both.")
    }

    // MARK: - Deck card VoiceOver label (CodeRabbit on PR #79): the card
    // Button's EXPLICIT accessibility label suppresses the child marker's
    // own label, so the row label must speak the duplicate-token state.

    private func row(
        authState: String?,
        isActive: Bool = false,
        activationState: ProviderActivationState = .unknown,
        identity: String? = nil
    ) -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(
                id: "a1",
                provider: "claude",
                label: "Work",
                identity: identity,
                isDefault: isActive,
                authState: authState
            ),
            provider: .claude,
            windows: [],
            isActive: isActive,
            activationState: activationState
        )
    }

    @Test func cardLabelSpeaksTheDuplicateTokenWarning() {
        let label = row(authState: "duplicate-token").accessibilityLabel(showsIdentity: false)
        #expect(label == "Work, \(DuplicateTokenMarker.accessibilityLabel)")
    }

    @Test func cardLabelAppendsTheWarningAfterTheMenuBarSourceState() {
        // Issue #131: cards no longer speak activation state (the deck
        // renders no activation marker); the single checkmark's "shown in
        // menu bar" meaning is spoken instead, and the duplicate warning
        // still lands last.
        let source = row(authState: "duplicate-token", isActive: true, activationState: .effective)
        #expect(source.accessibilityLabel(showsIdentity: false, isMenuBarSource: true)
            == "Work, shown in menu bar, \(DuplicateTokenMarker.accessibilityLabel)")
    }

    @Test func cardLabelNeverSpeaksActivationState() {
        // Issue #131: an active-but-pending account shows NO marker on its
        // deck card, so VoiceOver must not announce a state the eyes can't
        // see. The pending caption lives in Settings → Accounts.
        let pending = row(authState: nil, isActive: true, activationState: .identityMismatch)
        let label = pending.accessibilityLabel(showsIdentity: false)
        #expect(label == "Work")
        #expect(!label.contains("active"))
    }

    @Test func unflaggedCardLabelsAreUntouched() {
        // Placeholder identity only — never real account data.
        #expect(row(authState: "ok").accessibilityLabel(showsIdentity: false) == "Work")
        // Issue #131: isActive no longer surfaces in the card label.
        #expect(row(authState: nil, isActive: true, activationState: .effective)
            .accessibilityLabel(showsIdentity: false) == "Work")
        #expect(row(authState: "ok", identity: "user@example.com")
            .accessibilityLabel(showsIdentity: true) == "Work, user@example.com")
        #expect(row(authState: "ok", identity: "user@example.com")
            .accessibilityLabel(showsIdentity: true, isMenuBarSource: true)
            == "Work, user@example.com, shown in menu bar")
    }
}

@Suite("Duplicate-token section banner (issue #65)")
struct DuplicateTokenBannerTests {
    private func account(
        id: String,
        provider: String = "claude",
        label: String,
        enabled: Bool = true,
        isDefault: Bool = false,
        authState: String? = nil
    ) -> DeckAccount {
        DeckAccount(
            id: id,
            provider: provider,
            label: label,
            enabled: enabled,
            isDefault: isDefault,
            authState: authState
        )
    }

    private func state(
        claudeState: String? = nil,
        accounts: [DeckAccount]
    ) -> DeckState {
        DeckState(
            accounts: accounts,
            activation: DeckActivation(claude: claudeState.map { ProviderActivation(state: $0) })
        )
    }

    @Test func flaggedPairYieldsBannerNamingBothAccounts() {
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Insight", isDefault: true, authState: "duplicate-token"),
            account(id: "a2", label: "Studio", authState: "duplicate-token"),
            account(id: "a3", label: "Zeta", authState: "ok"),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner != nil)
        #expect(banner?.message == "Duplicate login — Insight and Studio appear to "
            + "hold the same login. Redo /login for one of them.")
        // Like the identity states: Retry only re-checks, never a symlink flip.
        #expect(banner?.retryRunsActivation == false)
        #expect(banner?.affectedAccountID == "a1")
    }

    @Test func threeFlaggedAccountsListAllThree() {
        let message = AccountsRoster.duplicateTokenMessage(for: [
            account(id: "a1", label: "Alpha", authState: "duplicate-token"),
            account(id: "a2", label: "Beta", authState: "duplicate-token"),
            account(id: "a3", label: "Gamma", authState: "duplicate-token"),
        ])
        #expect(message == "Duplicate login — Alpha, Beta and Gamma appear to "
            + "hold the same login. Redo /login for one of them.")
    }

    @Test func loneFlaggedAccountFallsBackToGenericPhrasing() {
        // Its partner may have been removed between refreshes — never name
        // a single account as its own duplicate.
        let message = AccountsRoster.duplicateTokenMessage(for: [
            account(id: "a1", label: "Solo", authState: "duplicate-token"),
        ])
        #expect(message == "Duplicate login — two profiles appear to hold the "
            + "same login. Redo /login for one of them.")
    }

    @Test func codexAccountsGetTheSameMarkerAndBanner() {
        // Issue #108: the daemon now flags Codex profiles sharing one
        // tokens.account_id with the same 'duplicate-token' authState. The
        // UI path is provider-generic, so codex rows must earn the marker
        // and their section the banner with no UI changes. Placeholder
        // labels only — never real account data.
        let flagged = account(id: "c1", provider: "codex", label: "Insight", authState: "duplicate-token")
        #expect(flagged.hasDuplicateToken)
        let s = DeckState(
            accounts: [
                account(id: "c1", provider: "codex", label: "Insight", isDefault: true, authState: "duplicate-token"),
                account(id: "c2", provider: "codex", label: "Lending", authState: "duplicate-token"),
            ],
            activation: DeckActivation(codex: ProviderActivation(state: "effective"))
        )
        let sections = AccountsRoster.sections(state: s)
        let codexSection = sections.first { $0.provider == .codex }
        #expect(codexSection?.banner?.message == "Duplicate login — Insight and Lending appear to "
            + "hold the same login. Redo /login for one of them.")
        #expect(codexSection?.banner?.retryRunsActivation == false)
    }

    @Test func noFlaggedAccountsMeansNoBanner() {
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Work", isDefault: true, authState: "ok"),
            account(id: "a2", label: "Side", authState: "signin-required"),
        ])
        #expect(AccountsRoster.sections(state: s)[0].banner == nil)
    }

    @Test func bannerShowsEvenWhenActivationIsEffective() {
        // The whole point of the fingerprint check: activation can be fully
        // in effect while two profiles share one login.
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "A", isDefault: true, authState: "duplicate-token"),
            account(id: "a2", label: "B", authState: "duplicate-token"),
        ])
        #expect(AccountsRoster.sections(state: s)[0].banner?.message.contains("Duplicate login") == true)
    }

    @Test func activationTroubleOutranksTheDuplicateBanner() {
        // One banner per section; a broken activation is the more
        // immediately actionable problem.
        let s = state(claudeState: "identity-mismatch", accounts: [
            account(id: "a1", label: "A", isDefault: true, authState: "duplicate-token"),
            account(id: "a2", label: "B", authState: "duplicate-token"),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner?.message.contains("Identity mismatch") == true)
    }

    @Test func clobberGuardGuidanceOutranksTheDuplicateBanner() {
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "A", isDefault: true, authState: "duplicate-token"),
            account(id: "a2", label: "B", authState: "duplicate-token"),
        ])
        let sections = AccountsRoster.sections(
            state: s,
            guidanceForAccount: { $0 == "a1" ? "Verbatim daemon guidance" : nil }
        )
        #expect(sections[0].banner?.message == "Verbatim daemon guidance")
    }

    @Test func duplicateBannerCarriesItsOwnHonestDetail() {
        // Not the activation-centric "until activation completes" line —
        // activation can be in effect while the login is shared.
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "A", isDefault: true, authState: "duplicate-token"),
            account(id: "a2", label: "B", authState: "duplicate-token"),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner?.detail == AccountsRoster.duplicateTokenDetail)
        #expect(banner?.detail.contains("activation completes") == false)
    }

    @Test func otherProvidersSectionStaysClean() {
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "A", isDefault: true, authState: "duplicate-token"),
            account(id: "a2", label: "B", authState: "duplicate-token"),
            account(id: "c1", provider: "codex", label: "Codex", isDefault: true, authState: "ok"),
        ])
        let sections = AccountsRoster.sections(state: s)
        #expect(sections[0].banner != nil)
        #expect(sections[1].banner == nil)
    }

    @Test func duplicateFlagNeverMarksTheRadioPending() {
        // The radio reflects ACTIVATION state only; duplicate-token is a
        // credential problem and renders as marker + banner instead.
        let flagged = account(id: "a1", label: "A", isDefault: true, authState: "duplicate-token")
        let s = state(claudeState: "effective", accounts: [flagged])
        #expect(!AccountsRoster.radioIsPending(account: flagged, state: s))
    }
}
