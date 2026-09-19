import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #542 — the two states Tim hit must be unrepresentable.
//
// 2026-08-19 (v1.1.1): the pool banner said "last 8 requests failed (HTTP
// 401)" and then "Finish the sign-in in your browser…". Neither sentence
// named an account or a provider, and with 7 Claude plus 4 Codex
// subscriptions on the deck Tim could not tell which browser sign-in he was
// finishing. The card itself showed nothing wrong.
//
// 2026-09-17 (v1.1.10): a Claude refresh token expired. The proxy marked the
// credential dead and stopped routing to it BEFORE any request failed, so
// `memberBlackout.alerts` stayed empty, no banner appeared, and the card read
// "100% left · ⑂ 0" with no reason given. The daemon had the answer the whole
// time (`proxyCredential: "error"`, detail "token expired"); only Settings →
// Subscriptions rendered it.
//
// Placeholder identities only — this repo mirrors publicly.

private func member(
    id: String = "placeholder-account",
    provider: String = "claude",
    label: String = "Placeholder Sub",
    proxyPool: String? = "member",
    proxyCredential: String? = "ok",
    proxyCredentialDetail: String? = nil,
    proxyRelogin: ProxyReloginCapability? = ProxyReloginCapability(available: true)
) -> DeckAccount {
    DeckAccount(
        id: id, provider: provider, label: label,
        enabled: true, isDefault: false,
        authState: "ok",
        proxyPool: proxyPool,
        proxyCredential: proxyCredential,
        proxyCredentialDetail: proxyCredentialDetail,
        proxyRelogin: proxyRelogin
    )
}

private func streak(
    accountID: String = "placeholder-account",
    failures: Int = 8,
    statusCode: Int? = 401,
    repairedPending: Bool? = nil,
    transient: Bool? = nil
) -> MemberBlackoutAlert {
    MemberBlackoutAlert(
        accountId: accountID,
        provider: "claude",
        label: "Placeholder Sub",
        consecutiveFailures: failures,
        statusCode: statusCode,
        repairedPending: repairedPending,
        transient: transient
    )
}

@Suite("The card says when its proxy sign-in is dead (issue #542)")
@MainActor
struct Issue542CardCredentialIndicatorTests {
    /// THE TRIPWIRE for 2026-09-17. A dead credential with an EMPTY
    /// memberBlackout — the exact shape that left the deck silent, because
    /// every credential sentence on the deck lived in the banner and the
    /// banner needs a routed-failure streak.
    @Test func aDeadCredentialWithNoStreakLightsTheCard() {
        let model = makeModel()
        let account = member(proxyCredential: "error", proxyCredentialDetail: "token expired")
        let state = DeckState(
            accounts: [account],
            usage: [],
            memberBlackout: MemberBlackoutStatus(threshold: 3, alerts: [])
        )
        // No banner is reachable from this state — that was the whole bug.
        #expect(ProxyRelogin.routedFailures(for: account, in: state) == nil)

        let indicator = ProxyRelogin.cardIndicator(model.presentation(for: account))
        #expect(indicator != nil)
        #expect(indicator?.credentialIsBroken == true)
        #expect(indicator?.credentialText == "Proxy sign-in expired (token expired)")
    }

    /// The popover answers the question the glyph raises: WHICH subscription,
    /// on WHICH provider, and what happens if the button is pressed.
    @Test func theExplanationNamesTheAccountItsProviderAndTheDisclosure() throws {
        let model = makeModel()
        let account = member(proxyCredential: "error", proxyCredentialDetail: "token expired")
        let presentation = try #require(ProxyRelogin.cardIndicator(model.presentation(for: account)))
        let explanation = DeckWarningExplanation.proxyCredential(
            for: account,
            presentation: presentation
        )

        #expect(explanation.title.contains("Placeholder Sub"))
        #expect(explanation.title.contains("Claude"))
        #expect(explanation.title == "Proxy sign-in expired · Placeholder Sub (Claude)")
        // The daemon's own words for what is wrong…
        #expect(explanation.body.contains("token expired"))
        // …and Settings' disclosure sentence verbatim, never a second copy.
        #expect(explanation.body.contains(ProxyRelogin.confirmation(label: "Placeholder Sub")))
    }

    /// A Codex member is named by its own provider — the 2026-08-19 problem
    /// was an 11-subscription roster, not one provider's.
    @Test func aCodexMembersExplanationSaysCodex() throws {
        let model = makeModel()
        let account = member(
            id: "placeholder-codex",
            provider: "codex",
            label: "Placeholder Codex",
            proxyCredential: "error"
        )
        let presentation = try #require(ProxyRelogin.cardIndicator(model.presentation(for: account)))
        let explanation = DeckWarningExplanation.proxyCredential(
            for: account,
            presentation: presentation
        )
        #expect(explanation.title == "Proxy sign-in expired · Placeholder Codex (Codex)")
    }

    /// Parity with #515: the measured request path promotes the indicator
    /// too, so the 2026-08-19 state lights the card as well as the banner.
    @Test func aRoutedFailureStreakOnAHealthyCredentialLightsTheCardToo() throws {
        let model = makeModel()
        let account = member(proxyCredential: "ok")
        let indicator = try #require(
            ProxyRelogin.cardIndicator(model.presentation(for: account, routedFailures: streak()))
        )
        #expect(indicator.credentialText == "last 8 requests failed (HTTP 401)")
        // The proxy never called this one expired, so neither does the card.
        let explanation = DeckWarningExplanation.proxyCredential(
            for: account,
            presentation: indicator
        )
        #expect(explanation.title == "Proxy sign-in not working · Placeholder Sub (Claude)")
        #expect(explanation.body.contains("last 8 requests failed (HTTP 401)"))
    }

    /// #539 and #572: a member the daemon has already seen signed in again,
    /// and one whose streak was the provider being overloaded, have nothing
    /// to fix — the card stays quiet, exactly as the Settings row does.
    @Test func repairedPendingAndTransientStreaksShowNoIndicator() {
        let model = makeModel()
        let account = member(proxyCredential: "ok")
        #expect(ProxyRelogin.cardIndicator(
            model.presentation(for: account, routedFailures: streak(repairedPending: true))
        ) == nil)
        #expect(ProxyRelogin.cardIndicator(
            model.presentation(for: account, routedFailures: streak(transient: true))
        ) == nil)
    }

    /// #634 and the bench: rate-limited and benched members are not broken,
    /// and signing in again would fix neither. No glyph.
    @Test func restingAndBenchedMembersShowNoIndicator() {
        let model = makeModel()
        let resting = member(proxyCredential: "resting")
        let benched = member(proxyCredential: "disabled")
        #expect(ProxyRelogin.cardIndicator(model.presentation(for: resting)) == nil)
        #expect(ProxyRelogin.cardIndicator(model.presentation(for: benched)) == nil)
        // Even under a live streak — the streak promotes nothing here.
        #expect(ProxyRelogin.cardIndicator(
            model.presentation(for: resting, routedFailures: streak())
        ) == nil)
        #expect(ProxyRelogin.cardIndicator(
            model.presentation(for: benched, routedFailures: streak())
        ) == nil)
    }

    /// A healthy deck gains NOTHING. The #149/#174 discipline: a card with a
    /// working credential, and a machine with no proxy at all, render no new
    /// pixel.
    @Test func aHealthyMemberAndAProxylessMachineRenderNothing() {
        let model = makeModel()
        #expect(ProxyRelogin.cardIndicator(model.presentation(for: member())) == nil)
        let plain = member(proxyPool: nil, proxyCredential: nil, proxyRelogin: nil)
        #expect(model.presentation(for: plain) == nil)
        #expect(ProxyRelogin.cardIndicator(model.presentation(for: plain)) == nil)
    }

    /// A repair the proxy cannot start must never promise a browser sign-in:
    /// the popover shows the daemon's reason where the disclosure would be,
    /// and the view renders no button (source anchor below).
    @Test func anUnrunnableRepairExplainsItselfInsteadOfPromisingABrowser() throws {
        let reason = "This CLIProxyAPI install has no management key yet."
        let model = makeModel()
        let account = member(
            proxyCredential: "error",
            proxyRelogin: ProxyReloginCapability(available: false, reason: reason)
        )
        let indicator = try #require(ProxyRelogin.cardIndicator(model.presentation(for: account)))
        #expect(indicator.display == .unavailable(reason: reason))
        let explanation = DeckWarningExplanation.proxyCredential(
            for: account,
            presentation: indicator
        )
        #expect(explanation.body.contains(reason))
        #expect(!explanation.body.contains(ProxyRelogin.confirmation(label: account.label)))
    }

    @Test func voiceOverHearsTheAccountTheProviderAndTheState() {
        let model = makeModel()
        let account = member(proxyCredential: "error", proxyCredentialDetail: "token expired")
        let presentation = model.presentation(for: account)!
        let label = ProxyRelogin.indicatorAccessibilityLabel(
            for: account,
            presentation: presentation
        )
        #expect(label == "Placeholder Sub (Claude): Proxy sign-in expired (token expired)")
    }

    // MARK: - The repair names its target (issue #542, part B)

    /// 2026-08-19: "Finish the sign-in in your browser…" — which one? The
    /// running sentence now says, and it is asserted through the SHARED
    /// presentation, so the banner, the Settings row and the card popover all
    /// get the named version or none of them do.
    @Test func theRunningSentenceNamesTheAccountAndProvider() {
        let claudeModel = makeModel()
        let claude = member(proxyCredential: "error")
        claudeModel.begin(account: claude)
        let claudeText = runningText(claudeModel.presentation(for: claude))
        #expect(claudeText?.contains("Placeholder Sub") == true)
        #expect(claudeText?.contains("Claude") == true)
        claudeModel.tasks[claude.id]?.cancel()

        let codexModel = makeModel()
        let codex = member(
            id: "placeholder-codex",
            provider: "codex",
            label: "Placeholder Codex",
            proxyCredential: "error"
        )
        codexModel.begin(account: codex)
        let codexText = runningText(codexModel.presentation(for: codex))
        #expect(codexText?.contains("Placeholder Codex") == true)
        #expect(codexText?.contains("Codex") == true)
        codexModel.tasks[codex.id]?.cancel()
    }

    @Test func theSettledSuccessSentenceNamesTheAccountAndProvider() async {
        let model = makeModel(startPhase: "succeeded")
        let account = member(proxyCredential: "error")
        model.begin(account: account)
        await model.tasks[account.id]?.value

        guard case .note(let text)? = model.presentation(for: account)?.display else {
            Issue.record("a settled success must read as a note")
            return
        }
        #expect(text.contains("Placeholder Sub"))
        #expect(text.contains("Claude"))
        #expect(text == ProxyRelogin.succeededText(label: "Placeholder Sub", providerName: "Claude"))
    }

    /// CodeRabbit (PR #667): "the running AND settled sentences name their
    /// target" has to mean every settled sentence. A stopped sign-in used to
    /// say "Sign-in stopped. Nothing changed." — which of the eleven?
    @Test func theStoppedSentenceNamesTheAccountAndProvider() async {
        let model = makeModel(startPhase: "awaiting-browser")
        let account = member(proxyCredential: "error")
        model.begin(account: account)
        var spins = 0
        while model.phase(for: account.id) != .awaitingBrowser, spins < 1_000 {
            await Task.yield()
            spins += 1
        }
        model.cancel(account: account)

        guard case .note(let text)? = model.presentation(for: account)?.display else {
            Issue.record("a stopped sign-in must read as a note")
            return
        }
        #expect(text == "Sign-in for Placeholder Sub (Claude) stopped. Nothing changed.")
    }

    /// The failure sentence names the subscription and then gets out of the
    /// way — the daemon's own detail is the only thing that says what failed,
    /// so it survives verbatim after the target.
    @Test func theFailureSentenceNamesTheAccountAndKeepsTheDaemonsDetail() {
        let detail = "CLIProxyAPI could not finish the sign-in: bad state"
        #expect(ProxyRelogin.settledText(
            phase: .failed,
            detail: detail,
            label: "Placeholder Sub",
            providerName: "Claude"
        ) == "Placeholder Sub (Claude): \(detail)")
        // A daemon that sent no detail still names its target.
        #expect(ProxyRelogin.settledText(
            phase: .failed,
            detail: nil,
            label: "Placeholder Codex",
            providerName: "Codex"
        ) == "Placeholder Codex (Codex): \(ProxyRelogin.failedFallbackText)")
    }

    /// A provider this build does not know still gets a readable sentence —
    /// it simply drops the provider rather than inventing one.
    @Test func anUnknownProviderDropsTheProviderRatherThanGuessing() {
        #expect(ProxyRelogin.providerName(for: member(provider: "moonshot")) == nil)
        #expect(ProxyRelogin.awaitingBrowserText(label: "Placeholder Sub", providerName: nil)
            == "Finish the sign-in for Placeholder Sub in your browser…")
        #expect(ProxyRelogin.target(label: "Placeholder Sub", providerName: nil) == "Placeholder Sub")
    }

    // MARK: - The surfaces that render it

    @Test func bothDeckLayoutsPassTheSameDerivationToTheCard() throws {
        let source = flattened(try viewSource("Sources/ModelDeckMac/DeckPopoverView.swift"))
        // ONE derivation, and both layouts feed the card from it — the
        // two-column path…
        #expect(source.contains(
            "proxyRelogin: { proxyReloginModel.presentation( for: $0.account, "
                + "routedFailures: ProxyRelogin.routedFailures(for: $0.account, in: state) ) },"
        ))
        // …and the single-column path.
        #expect(source.contains(
            "proxyRelogin: proxyReloginModel.presentation( for: row.account, "
                + "routedFailures: ProxyRelogin.routedFailures(for: row.account, in: state) ),"
        ))
        // The card gates on the Core derivation, never a local re-reading of
        // the account (which is how the deck and Settings disagreed in #515).
        #expect(source.contains("ProxyRelogin.cardIndicator(proxyRelogin)"))
        #expect(!source.contains("proxyRelogin.credentialIsBroken"))
    }

    @Test func theCardRendersAGlyphAndNeverANewRow() throws {
        let source = flattened(try viewSource("Sources/ModelDeckMac/DeckPopoverView.swift"))
        // The Settings row's own glyph, warning-tinted, inside the collapsed
        // title cluster right beside the ⑂ weight badge it explains — never a
        // row of its own (#537: deck space is sacred).
        #expect(source.contains("ProxyCredentialMarkerView("))
        #expect(source.contains(
            "ProxyWeightBadge(presentation: weight) } if let broken = brokenProxyCredential {"
        ))
        #expect(source.contains(
            "Image(systemName: \"key.slash\") .font(.system(size: 10, weight: .semibold)) "
                + ".foregroundStyle(severityColor(.warning))"
        ))
        // Click-to-explain through the shared one-at-a-time slot (#113).
        #expect(source.contains("DeckWarningID(topic: .proxyCredential, elementID: row.id)"))
        #expect(source.contains("isExplaining: deckModel.warningBinding(proxyCredentialWarningID)"))
        // The popover is the explanation anatomy, with ONE prominent action,
        // and only when the repair is actually armed.
        #expect(source.contains("actionTitle: ProxyRelogin.actionTitle"))
        #expect(source.contains("guard case .action(let prominent) = presentation.display else { return false }"))
        // VoiceOver gets the state and a named action that skips the popover.
        #expect(source.contains("ProxyRelogin.indicatorAccessibilityLabel("))
        #expect(source.contains("Button(\"Fix sign-in\") { fixProxySignIn() }"))
    }

    /// The #113 reconcile releases a presented explanation whose affordance is
    /// gone. A new affordance that is not in that mirror gets its popover
    /// dismissed by the next state the deck reads — so the mirror knows about
    /// this one.
    @Test func anOpenExplanationSurvivesTheNextDaemonState() {
        let deck = DeckPopoverModel(defaults: ScratchDefaults.make("issue-542"))
        let account = member(proxyCredential: "error")
        let row = DeckAccountRow(
            account: account,
            provider: .claude,
            windows: [],
            isActive: false
        )
        let id = DeckWarningID(topic: .proxyCredential, elementID: account.id)
        deck.toggleWarning(id)
        #expect(deck.isWarningPresented(id))

        deck.reconcileWarnings(
            rows: [row],
            staleness: { _ in nil },
            cadenceNoticeVisible: false,
            proxyCredentialBroken: { $0.id == account.id }
        )
        #expect(deck.isWarningPresented(id))

        // …and it IS released once the credential is healthy again.
        deck.reconcileWarnings(
            rows: [row],
            staleness: { _ in nil },
            cadenceNoticeVisible: false,
            proxyCredentialBroken: { _ in false }
        )
        #expect(!deck.isWarningPresented(id))
    }

    @Test func theAppFeedsTheReconcileFromTheSameDerivation() throws {
        let source = try viewSource("Sources/ModelDeckMac/ModelDeckMacApp.swift")
        #expect(source.contains("proxyCredentialBroken: { row in"))
        #expect(source.contains("?.credentialIsBroken == true"))
    }
}

// MARK: - Helpers

/// Source with every run of whitespace collapsed, so an anchor can pin what
/// the view does and in what ORDER without pinning its indentation.
private func flattened(_ source: String) -> String {
    source.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

private func runningText(_ presentation: ProxyReloginRowPresentation?) -> String? {
    guard case .running(let text, _)? = presentation?.display else { return nil }
    return text
}

@MainActor
private func makeModel(startPhase: String = "idle") -> ProxyReloginModel {
    ProxyReloginModel(
        manager: SilentReloginStub(startPhase: startPhase),
        stateProvider: SilentReloginStub(),
        browser: SilentReloginStub(),
        pollInterval: .zero,
        sleep: { _ in }
    )
}

/// No network, no browser, no daemon — these tests exercise derivations and
/// the phase machine only.
private struct SilentReloginStub: ProxyReloginManaging, DeckStateProviding, BrowserOpening {
    var startPhase: String = "idle"

    func startProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        // A running phase needs the authorize page the PROXY built, or the
        // model settles the attempt as "no browser" instead of running it.
        guard startPhase == "awaiting-browser" else { return ProxyReloginState(phase: startPhase) }
        return ProxyReloginState(phase: startPhase, url: "https://provider.invalid/authorize")
    }

    func proxyReloginState(accountID: String) async throws -> ProxyReloginState {
        // A poll that never answers parks the flow where a real sign-in parks:
        // waiting for a browser nobody has finished. Cancellation ends it,
        // which is what the stopped-sentence test drives.
        if startPhase == "awaiting-browser" { try await Task.sleep(for: .seconds(3_600)) }
        return ProxyReloginState(phase: startPhase)
    }

    func cancelProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        ProxyReloginState(phase: "cancelled")
    }

    func deckState() async throws -> DeckState { DeckState(accounts: [], usage: []) }

    func open(_ url: URL) {}
}

private func viewSource(_ relativePath: String) throws -> String {
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    return try String(
        contentsOf: packageRoot.appendingPathComponent(relativePath),
        encoding: .utf8
    )
}
