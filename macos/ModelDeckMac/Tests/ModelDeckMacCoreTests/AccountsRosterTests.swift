import Foundation
import Testing
@testable import ModelDeckMacCore

// Direction A accounts-screen redesign: sectioned roster + consolidated
// provider banner. All placeholder identities (user@example.com) — never
// real account data.

@Suite("Accounts roster sections (Direction A)")
struct AccountsRosterSectionTests {
    private func account(
        id: String,
        provider: String = "claude",
        label: String,
        identity: String? = nil,
        purpose: String? = nil,
        enabled: Bool = true,
        isDefault: Bool = false,
        identitySource: String? = nil
    ) -> DeckAccount {
        DeckAccount(
            id: id,
            provider: provider,
            label: label,
            identity: identity,
            purpose: purpose,
            enabled: enabled,
            isDefault: isDefault,
            metadata: identitySource.map { DeckAccountMetadata(identitySource: $0) }
        )
    }

    @Test func groupsByProviderClaudeFirstSortedByLabel() {
        let state = DeckState(accounts: [
            account(id: "c2", provider: "codex", label: "Zeta"),
            account(id: "a2", provider: "claude", label: "beta"),
            account(id: "c1", provider: "codex", label: "Alpha", isDefault: true),
            account(id: "a1", provider: "claude", label: "Alpha", isDefault: true),
        ])
        let sections = AccountsRoster.sections(state: state)
        #expect(sections.map(\.provider) == [.claude, .codex])
        #expect(sections[0].accounts.map(\.id) == ["a1", "a2"])
        #expect(sections[1].accounts.map(\.id) == ["c1", "c2"])
        #expect(sections[0].countText == "2 accounts")
    }

    @Test func providerWithNoAccountsYieldsNoSection() {
        let state = DeckState(accounts: [account(id: "a1", label: "Solo")])
        let sections = AccountsRoster.sections(state: state)
        #expect(sections.count == 1)
        #expect(sections[0].provider == .claude)
        #expect(sections[0].countText == "1 account")
    }

    @Test func unknownProviderAccountsAreDropped() {
        let state = DeckState(accounts: [
            account(id: "x1", provider: "mystery", label: "Ghost"),
        ])
        #expect(AccountsRoster.sections(state: state).isEmpty)
    }

    // MARK: - Banner state mapping

    private func state(
        claudeState: String?,
        accounts: [DeckAccount]
    ) -> DeckState {
        DeckState(
            accounts: accounts,
            activation: DeckActivation(claude: claudeState.map { ProviderActivation(state: $0) })
        )
    }

    @Test func effectiveStateHasNoBanner() {
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        #expect(AccountsRoster.sections(state: s)[0].banner == nil)
    }

    @Test func unreportedActivationHasNoBanner() {
        // Pre-#56 daemon: no activation field — never invent warnings.
        let s = DeckState(accounts: [account(id: "a1", label: "Work", isDefault: true)])
        #expect(AccountsRoster.sections(state: s)[0].banner == nil)
    }

    @Test func mismatchedStateBannersWithRetryAndAffectedRow() {
        let s = state(claudeState: "mismatched", accounts: [
            account(id: "a1", label: "Insight", isDefault: true),
            account(id: "a2", label: "Personal"),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner != nil)
        #expect(banner?.message.contains("Activation pending") == true)
        #expect(banner?.message.contains("Insight") == true)
        #expect(banner?.retryRunsActivation == true)
        #expect(banner?.affectedAccountID == "a1")
        #expect(banner?.detail.contains("Usage tracking works") == true)
        #expect(banner?.detail.contains("Running sessions are never touched") == true)
    }

    @Test func blockedAndUnlinkedAreRetryableLinkStates() {
        for raw in ["blocked", "unlinked"] {
            let s = state(claudeState: raw, accounts: [
                account(id: "a1", label: "Work", isDefault: true),
            ])
            let banner = AccountsRoster.sections(state: s)[0].banner
            #expect(banner?.retryRunsActivation == true, "state \(raw)")
        }
    }

    @Test func identityStatesBannerWithoutActivationRetry() {
        // Identity trouble is never fixed by another symlink flip (issue
        // #61's button semantics) — Retry must not re-run activate.
        for raw in ["identity-mismatch", "identity-unverified"] {
            let s = state(claudeState: raw, accounts: [
                account(id: "a1", label: "Work", isDefault: true),
            ])
            let banner = AccountsRoster.sections(state: s)[0].banner
            #expect(banner != nil, "state \(raw)")
            #expect(banner?.retryRunsActivation == false, "state \(raw)")
        }
    }

    @Test func identityMismatchMessageNamesLoginPath() {
        let s = state(claudeState: "identity-mismatch", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner?.message.contains("/login") == true)
    }

    @Test func blockedGuidanceWinsVerbatimOverStateMessage() {
        let s = state(claudeState: "blocked", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
            account(id: "a2", label: "Other"),
        ])
        let sections = AccountsRoster.sections(
            state: s,
            guidanceForAccount: { $0 == "a2" ? "Move ~/.claude aside, then retry." : nil }
        )
        let banner = sections[0].banner
        #expect(banner?.message == "Move ~/.claude aside, then retry.")
        #expect(banner?.affectedAccountID == "a2")
        #expect(banner?.retryRunsActivation == true)
    }

    @Test func activationErrorSurfacesInBannerWhenNoGuidance() {
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
            account(id: "a2", label: "Other"),
        ])
        let sections = AccountsRoster.sections(
            state: s,
            errorForAccount: { $0 == "a2" ? "Couldn't activate: daemon said no." : nil }
        )
        let banner = sections[0].banner
        #expect(banner?.message == "Couldn't activate: daemon said no.")
        #expect(banner?.affectedAccountID == "a2")
    }

    @Test func disabledOnlyProviderGetsNoStateBanner() {
        let s = state(claudeState: "mismatched", accounts: [
            account(id: "a1", label: "Off", enabled: false),
        ])
        #expect(AccountsRoster.sections(state: s)[0].banner == nil)
    }

    // MARK: - Radio pending variant

    @Test func radioPendingOnlyForSelectedRowInNonEffectiveStates() {
        let selected = account(id: "a1", label: "Work", isDefault: true)
        let other = account(id: "a2", label: "Other")
        for raw in ["blocked", "mismatched", "unlinked", "identity-mismatch", "identity-unverified"] {
            let s = state(claudeState: raw, accounts: [selected, other])
            #expect(AccountsRoster.radioIsPending(account: selected, state: s), "state \(raw)")
            #expect(!AccountsRoster.radioIsPending(account: other, state: s), "state \(raw)")
        }
        let effective = state(claudeState: "effective", accounts: [selected, other])
        #expect(!AccountsRoster.radioIsPending(account: selected, state: effective))
        // Pre-#56 daemon: unknown must stay a plain selected radio.
        let unreported = DeckState(accounts: [selected, other])
        #expect(!AccountsRoster.radioIsPending(account: selected, state: unreported))
    }

    // MARK: - Provenance + subtitle

    @Test func seededProvenanceOnlyForSeedSource() {
        #expect(account(id: "a", label: "A", identitySource: "seed").isIdentitySeeded)
        #expect(!account(id: "b", label: "B", identitySource: "verified").isIdentitySeeded)
        #expect(!account(id: "c", label: "C").isIdentitySeeded)
    }

    @Test func rosterSubtitleJoinsIdentityAndPurpose() {
        #expect(account(id: "a", label: "A", identity: "user@example.com", purpose: "agency work")
            .rosterSubtitle == "user@example.com · agency work")
        #expect(account(id: "b", label: "B", identity: "user@example.com").rosterSubtitle == "user@example.com")
        #expect(account(id: "c", label: "C", purpose: "experiments").rosterSubtitle == "experiments")
        #expect(account(id: "d", label: "D").rosterSubtitle == nil)
        #expect(account(id: "e", label: "E", identity: "").rosterSubtitle == nil)
    }

    @Test func identitySourceDecodesFromMetadata() throws {
        let json = """
        {"id":"a1","provider":"claude","label":"Work","enabled":true,"isDefault":false,
         "metadata":{"identitySource":"seed","claudeAccountUuid":"ignored"}}
        """
        let decoded = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        #expect(decoded.metadata?.identitySource == "seed")
        #expect(decoded.isIdentitySeeded)
    }
}
