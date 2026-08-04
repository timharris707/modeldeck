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

    // MARK: - Fresh install: no default account (issue #228)

    @Test func unlinkedWithNoDefaultGuidesSelectionInsteadOfDeadRetry() {
        // Tim's fresh-install field state (v0.3.16, 2026-08-04): provider
        // `unlinked`, NO account ever set default. The old banner promised
        // "Complete Activation on the selected account" (a button that
        // exists nowhere) and offered a Retry whose handler could only
        // re-read state — a dead end on its only button.
        let s = state(claudeState: "unlinked", accounts: [
            account(id: "a1", label: "Work"),
            account(id: "a2", label: "Other"),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner != nil)
        #expect(banner?.message.contains("Pick an account below") == true)
        #expect(banner?.message.contains("Complete Activation") != true)
        #expect(banner?.retryRunsActivation == false)
        #expect(banner?.affectedAccountID == nil)
        #expect(banner?.offersRetry == false, "no dead Retry on the fresh-install banner")
    }

    @Test func blockedWithNoDefaultOffersNoRetryEither() {
        // Same principle for every link-level state without a selected row:
        // retry has no account to re-activate, so it must not be promised.
        for raw in ["blocked", "mismatched"] {
            let s = state(claudeState: raw, accounts: [
                account(id: "a1", label: "Work"),
            ])
            let banner = AccountsRoster.sections(state: s)[0].banner
            #expect(banner != nil, "state \(raw)")
            #expect(banner?.retryRunsActivation == false, "state \(raw)")
            #expect(banner?.offersRetry == false, "state \(raw)")
        }
    }

    @Test func unlinkedWithSelectedAccountKeepsRetryAndCompleteActivationCopy() {
        // The pre-#228 behavior is untouched once a default exists.
        let s = state(claudeState: "unlinked", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner?.message.contains("Complete Activation on Work") == true)
        #expect(banner?.retryRunsActivation == true)
        #expect(banner?.affectedAccountID == "a1")
        #expect(banner?.offersRetry == true)
    }

    @Test func offersRetryTracksTargetOrReRunnableActivation() {
        // Identity states: Retry can't re-run activation but re-checks a
        // specific selected row's state — still offered. Orphaned trouble:
        // no account and nothing to re-run — not offered.
        let identity = state(claudeState: "identity-mismatch", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        #expect(AccountsRoster.sections(state: identity)[0].banner?.offersRetry == true)

        let orphaned = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        let sections = AccountsRoster.sections(
            state: orphaned,
            troubleForProvider: { provider in
                provider == .claude
                    ? ActivationTrouble(
                        accountID: "ghost", kind: .error,
                        message: "Couldn't activate: account not found"
                    )
                    : nil
            }
        )
        #expect(sections[0].banner?.offersRetry == false)
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
        // Issue #227: the daemon's guidance still leads VERBATIM (the #55
        // requirement); the appended sentence adds the radio step only.
        #expect(banner?.message.hasPrefix("Move ~/.claude aside, then retry.") == true)
        #expect(banner?.affectedAccountID == "a2")
        #expect(banner?.retryRunsActivation == true)
    }

    // MARK: - Blocked banner names the path + click-level action (issue #227)

    @Test func guidanceBannerAppendsRadioStepAndCarriesParsedPath() {
        // The daemon's real guidance format ends with the blocking path;
        // the banner parses it for Reveal in Finder and names the working
        // retry path (the account's radio, post-#234) after the daemon's
        // own move instruction. Placeholder path only — safety contract.
        let guidance = "claude activation requires a one-time migration: "
            + "move the existing directory aside at a quiet moment before "
            + "activating: /placeholder/home/.claude"
        let s = state(claudeState: "blocked", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        let sections = AccountsRoster.sections(
            state: s,
            guidanceForAccount: { $0 == "a1" ? guidance : nil }
        )
        let banner = sections[0].banner
        #expect(banner?.message.hasPrefix(guidance) == true)
        #expect(banner?.message.contains("click Work's radio to activate") == true)
        #expect(banner?.blockedPath == "/placeholder/home/.claude")
    }

    @Test func blockedPathParsingOnlyAcceptsTrailingPaths() {
        #expect(AccountsRoster.blockedPath(
            inGuidance: "codex activation requires a one-time migration: "
                + "move the existing directory aside at a quiet moment "
                + "before activating: /placeholder/home/.codex"
        ) == "/placeholder/home/.codex")
        #expect(AccountsRoster.blockedPath(
            inGuidance: "move it aside before activating: ~/.codex"
        ) == "~/.codex")
        // No trailing path → no reveal affordance, never a guess.
        #expect(AccountsRoster.blockedPath(inGuidance: "Move it aside, then retry.") == nil)
        #expect(AccountsRoster.blockedPath(inGuidance: "something went wrong: not a path") == nil)
    }

    @Test func stateDerivedBlockedNamesConventionalPathAndRadioStep() {
        // Tim's fresh-install field data (#227): the old copy ("a one-time
        // migration must run") named neither the blocker nor an action, so
        // repeated Retry read as a bug. The state payload carries no path,
        // so the copy names the conventional active-link location and the
        // radio as the retry path once the directory is moved.
        let s = state(claudeState: "blocked", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner?.message.contains("existing Claude directory") == true)
        #expect(banner?.message.contains("~/.claude") == true)
        #expect(banner?.message.contains("Move or rename") == true)
        #expect(banner?.message.contains("click Work's radio to activate") == true)
        #expect(banner?.blockedPath == "~/.claude")
    }

    @Test func stateDerivedBlockedWithNoDefaultPointsAtPickingAnAccount() {
        // Post-#234 fresh-install pattern: no selected row, no dead Retry —
        // the message carries the whole path out (move the directory, then
        // pick an account; its radio runs activation).
        let s = state(claudeState: "blocked", accounts: [
            account(id: "a1", label: "Work"),
        ])
        let banner = AccountsRoster.sections(state: s)[0].banner
        #expect(banner?.message.contains("pick an account below") == true)
        #expect(banner?.offersRetry == false)
        #expect(banner?.blockedPath == "~/.claude")
    }

    @Test func onlyBlockedStateCarriesABlockedPath() {
        for raw in ["mismatched", "unlinked", "identity-mismatch", "identity-unverified"] {
            let s = state(claudeState: raw, accounts: [
                account(id: "a1", label: "Work", isDefault: true),
            ])
            #expect(AccountsRoster.sections(state: s)[0].banner?.blockedPath == nil, "state \(raw)")
        }
    }

    @Test func orphanedGuidanceTroubleKeepsTheRevealPath() {
        // Issue #100's orphan fallback still names a real on-disk blocker
        // when the record is clobber-guard guidance; a generic error
        // record carries no path.
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        let guidance = "codex activation requires a one-time migration: "
            + "move the existing directory aside at a quiet moment before "
            + "activating: /placeholder/home/.codex"
        let sections = AccountsRoster.sections(
            state: s,
            troubleForProvider: { provider in
                provider == .claude
                    ? ActivationTrouble(accountID: "ghost", kind: .guidance, message: guidance)
                    : nil
            }
        )
        #expect(sections[0].banner?.blockedPath == "/placeholder/home/.codex")
    }

    @Test func revealURLExpandsTildeAndRequiresExistence() {
        let home = NSHomeDirectory()
        let url = AccountsRoster.revealURL(
            forBlockedPath: "~/.codex",
            fileExists: { $0 == home + "/.codex" }
        )
        #expect(url?.path == home + "/.codex")
        // The path is gone (already moved, or a custom active-link
        // override) — no reveal Finder can't honor.
        #expect(AccountsRoster.revealURL(
            forBlockedPath: "/placeholder/home/.codex",
            fileExists: { _ in false }
        ) == nil)
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

    @Test func orphanedTroubleSurfacesAtTheProviderLevel() {
        // Issue #100: a failure recorded for an account that has since left
        // the roster (removed/re-added mid-recovery) can never be found by
        // the per-account lookups — the banner surfaces the record at the
        // provider level instead of letting the outcome vanish.
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
        ])
        let sections = AccountsRoster.sections(
            state: s,
            troubleForProvider: { provider in
                provider == .claude
                    ? ActivationTrouble(
                        accountID: "ghost",
                        kind: .error,
                        message: "Couldn't activate: account not found"
                    )
                    : nil
            }
        )
        let banner = sections[0].banner
        #expect(banner?.message.contains("Couldn't activate: account not found") == true)
        #expect(banner?.message.contains("no longer in the roster") == true)
        #expect(banner?.retryRunsActivation == false, "cannot re-activate a vanished account")
        #expect(banner?.affectedAccountID == nil)
    }

    @Test func emptyProviderYieldsNoSectionEvenWithOrphanedTrouble() {
        // Deliberate (CodeRabbit on #126): removing a provider's LAST
        // account is a confirmation-gated action whose visible outcome is
        // the whole section disappearing. A trouble banner in an otherwise
        // empty section would be a permanent dead end — no account left to
        // activate means nothing could ever supersede it. The record stays
        // in the model, so re-adding an account surfaces it again (the
        // remove/re-add recovery case the orphan fallback exists for).
        let s = state(claudeState: nil, accounts: [
            account(id: "x1", provider: "codex", label: "Only", isDefault: true),
        ])
        let sections = AccountsRoster.sections(
            state: s,
            troubleForProvider: { provider in
                provider == .claude
                    ? ActivationTrouble(
                        accountID: "ghost", kind: .error,
                        message: "Couldn't activate: account not found"
                    )
                    : nil
            }
        )
        #expect(sections.map(\.provider) == [.codex])
        #expect(sections[0].banner == nil)
    }

    @Test func liveAccountTroubleNeverTakesTheOrphanPath() {
        // When the trouble's account is still in the roster, the per-account
        // lookups own the banner — no orphan suffix, row attribution kept.
        let s = state(claudeState: "effective", accounts: [
            account(id: "a1", label: "Work", isDefault: true),
            account(id: "a2", label: "Other"),
        ])
        let trouble = ActivationTrouble(
            accountID: "a2", kind: .error, message: "Couldn't activate: daemon said no."
        )
        let sections = AccountsRoster.sections(
            state: s,
            errorForAccount: { $0 == trouble.accountID ? trouble.message : nil },
            troubleForProvider: { $0 == .claude ? trouble : nil }
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
