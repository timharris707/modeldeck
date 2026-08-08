import Foundation
import Testing
@testable import ModelDeckMacCore

// Issues #279 + #280 — the UI halves.
//
// #279: two independent per-account dimensions (pool membership, session
// routing) that must never be conflated, a state machine for the three
// daemon ops, and — the discipline that governs the whole feature — a
// machine WITHOUT the proxy renders nothing anywhere (#149/#174).
//
// #280: the seeded pill finally has an exit. The button's state machine
// lives here; the daemon owns the promotion.
//
// Placeholder labels/identities only — this repo mirrors publicly.

private func account(
    id: String = "a1",
    provider: String = "claude",
    label: String = "Studio",
    identity: String? = nil,
    proxyPool: String? = nil,
    proxyRouted: Bool? = nil,
    cliproxyRouted: Bool? = nil,
    helperRouted: Bool? = nil,
    metadata: DeckAccountMetadata? = nil
) -> DeckAccount {
    DeckAccount(
        id: id, provider: provider, label: label,
        identity: identity,
        enabled: true, isDefault: false,
        metadata: metadata,
        authState: "ok",
        proxyPool: proxyPool, proxyRouted: proxyRouted,
        cliproxyRouted: cliproxyRouted, helperRouted: helperRouted
    )
}

// MARK: - #279 derivations

@Suite("Proxy pool + routing derivations (issue #279)")
struct ProxyPoolDerivationTests {
    @Test func aMachineWithoutTheProxyRendersNothing() {
        // THE rule of this feature. No `proxyPool` key means the daemon
        // could not know pool state — not "absent". Nothing may render.
        let plain = account()
        #expect(ProxyPool.statusText(for: plain) == nil)
        #expect(ProxyPool.action(for: plain) == nil)
        #expect(ProxyPool.offersUnroute(for: plain) == false)
        // Even a Claude account whose routing flags ARE reported (they ride
        // every Claude row since #263) stays silent without pool evidence.
        let routedNoPool = account(proxyRouted: true, helperRouted: true)
        #expect(ProxyPool.statusText(for: routedNoPool) == nil)
        #expect(ProxyPool.action(for: routedNoPool) == nil)
        #expect(ProxyPool.offersUnroute(for: routedNoPool) == false)
    }

    @Test func memberAndRoutedIsTheSettledState() {
        let a = account(proxyPool: "member", proxyRouted: true, helperRouted: true)
        #expect(ProxyPool.statusText(for: a) == "In pool · routed")
        #expect(ProxyPool.action(for: a) == nil)
        #expect(ProxyPool.offersUnroute(for: a))
    }

    @Test func memberButUnroutedOffersRouting() {
        // Tim's field state for LoanMeld and ModelDeck AI: in the pool for a
        // week, own sessions never routed, and nothing surfaced it.
        let a = account(proxyPool: "member", proxyRouted: false)
        #expect(ProxyPool.statusText(for: a) == "In pool · not routed")
        #expect(ProxyPool.action(for: a) == .route)
        #expect(ProxyPool.offersUnroute(for: a) == false)
    }

    @Test func absentOffersTheJoin() {
        // Tim's field state for Click AI: healthy in ModelDeck, invisible to
        // the proxy.
        let a = account(proxyPool: "absent", proxyRouted: false)
        #expect(ProxyPool.statusText(for: a) == "Not in pool")
        #expect(ProxyPool.action(for: a) == .join)
        #expect(ProxyPool.offersUnroute(for: a) == false)
        // Routed but NOT a member is a setup-order accident, not an expected
        // half of the same fact — so that one combination IS stated.
        let anomaly = account(proxyPool: "absent", proxyRouted: true)
        #expect(ProxyPool.statusText(for: anomaly) == "Not in pool · routed")
        #expect(ProxyPool.action(for: anomaly) == .join)
        // And it can be unrouted from the ⋯ menu without joining first.
        #expect(ProxyPool.offersUnroute(for: anomaly))
    }

    @Test func codexReportsMembershipOnly() {
        // The daemon reports routing for Claude only, so a Codex row must
        // not imply a routing state it has no evidence for — and routing is
        // refused 400 for Codex, so no route/unroute affordance may appear.
        let member = account(id: "x1", provider: "codex", label: "Codex One", proxyPool: "member")
        #expect(ProxyPool.statusText(for: member) == "In pool")
        #expect(ProxyPool.action(for: member) == nil)
        #expect(ProxyPool.offersUnroute(for: member) == false)
        let absent = account(id: "x2", provider: "codex", label: "Codex Two", proxyPool: "absent")
        #expect(ProxyPool.statusText(for: absent) == "Not in pool")
        #expect(ProxyPool.action(for: absent) == .join)
    }

    @Test func anUnknownPoolWordRendersNothing() {
        // Forward skew: a value this build doesn't know is not a state it
        // may guess at (the #229/#235 downgrade contract in its own
        // direction).
        let a = account(proxyPool: "quarantined", proxyRouted: false)
        #expect(ProxyPool.statusText(for: a) == nil)
        #expect(ProxyPool.action(for: a) == nil)
        // CodeRabbit (PR #285): the ⋯ item must be gated the same way, or an
        // unknown pool word offers an unroute the line itself won't render.
        #expect(ProxyPool.offersUnroute(for: account(proxyPool: "quarantined", proxyRouted: true)) == false)
    }

    @Test func unrouteRequiresTheLoopbackVerifiedFactWhenReported() {
        // Adversarial review M4: `proxyRouted` is presence-only daemon-side
        // (ANY ANTHROPIC_BASE_URL), so a corporate-gateway profile read as
        // routed — and taking the offered "Stop routing sessions…" deletes
        // the user's own config. `cliproxyRouted` is loopback-verified and
        // decides when present.
        let gateway = account(proxyPool: "member", proxyRouted: true, cliproxyRouted: false)
        #expect(ProxyPool.offersUnroute(for: gateway) == false)
        let loopback = account(proxyPool: "member", proxyRouted: true, cliproxyRouted: true)
        #expect(ProxyPool.offersUnroute(for: loopback))
        // An older daemon omits the field: the presence-only behavior is
        // the only fact available and stays in force.
        let oldDaemon = account(proxyPool: "member", proxyRouted: true, cliproxyRouted: nil)
        #expect(ProxyPool.offersUnroute(for: oldDaemon))
    }

    @Test func aJoinThatConfirmsNoMembershipIsNotReportedAsSuccess() {
        // CodeRabbit (PR #285): decoding is shape-tolerant by policy, so an
        // older or changed daemon can answer 200 with no membership fields.
        // Claiming "Added to the proxy pool" there would be a lie the user
        // acts on.
        #expect(ProxyPool.joinOutcomeText(ProxyPoolJoin(proxyPool: "member"))
            .hasPrefix("Added to the proxy pool"))
        #expect(ProxyPool.joinOutcomeText(ProxyPoolJoin(alreadyMember: true))
            == "Already in the proxy pool.")
        let undecided = ProxyPool.joinOutcomeText(ProxyPoolJoin())
        #expect(!undecided.hasPrefix("Added to the proxy pool"))
        #expect(undecided.contains("not confirmed membership"))
    }

    @Test func everyConfirmationSentenceStatesWhatHappens() {
        // Tim: "ask each time rather than make it automatic". The join's
        // sentence must name the browser sign-in for THAT account — the
        // browser opening is the surprising part.
        let join = ProxyPool.joinConfirmation(label: "Click AI")
        #expect(join.contains("browser sign-in for Click AI"))
        #expect(join.contains("Nothing changes until"))
        let route = ProxyPool.routeConfirmation(label: "LoanMeld")
        #expect(route.contains("New LoanMeld sessions"))
        #expect(route.contains("Running sessions are never touched"))
        #expect(route.contains("reversible"))
        let unroute = ProxyPool.unrouteConfirmation(label: "LoanMeld")
        #expect(unroute.contains("stop going through the local proxy"))
        #expect(unroute.contains("Running sessions are never touched"))
        // The cancel copy never claims to abort an OAuth the daemon is
        // still watching for.
        #expect(ProxyPool.joinWaitStoppedText.contains("joins the pool on its own"))
        #expect(ProxyPool.joinWaitingText == "Waiting for browser sign-in…")
    }
}

// MARK: - #279 decoding

@Suite("Proxy pool fields decode tolerantly (issue #279)")
struct ProxyPoolDecodingTests {
    private func decode(_ extra: String) throws -> DeckAccount {
        let json = """
        {"id":"a1","provider":"claude","label":"Studio","enabled":true,"isDefault":false\(extra)}
        """
        return try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
    }

    @Test func anOldDaemonRendersExactlyTodaysUI() throws {
        let a = try decode("")
        #expect(a.proxyPool == nil)
        #expect(a.proxyRouted == nil)
        #expect(a.helperRouted == nil)
        #expect(ProxyPool.statusText(for: a) == nil)
    }

    @Test func theNewFieldsDecode() throws {
        let a = try decode(#","proxyPool":"member","proxyRouted":true,"cliproxyRouted":false,"helperRouted":true"#)
        #expect(a.proxyPool == "member")
        #expect(a.proxyRouted == true)
        #expect(a.cliproxyRouted == false)
        #expect(a.helperRouted == true)
    }

    @Test func anUnexpectedShapeNeverFailsTheAccount() throws {
        // The AccountRenewAttempt policy: a field this build can't read is
        // an absent field, never a dead roster row.
        let a = try decode(#","proxyPool":7,"proxyRouted":"yes","cliproxyRouted":"loopback","helperRouted":[1]"#)
        #expect(a.label == "Studio")
        #expect(a.proxyPool == nil)
        #expect(a.proxyRouted == nil)
        #expect(a.cliproxyRouted == nil)
        #expect(a.helperRouted == nil)
    }

    @Test func everyPreExistingFieldStillDecodes() throws {
        // The custom decoder replaced a synthesized one — the pre-#279
        // fields must be byte-compatible, so pin a fully populated account.
        let json = """
        {"id":"a1","provider":"claude","label":"Studio","identity":"placeholder@example.test",
         "purpose":"work","color":"blue","profileRef":"/tmp/p","enabled":true,"isDefault":true,
         "authState":"signin-required","signinReason":"expired",
         "lastRefreshError":{"message":"boom"},
         "claudeStatusline":{"installed":true},
         "renew":{"available":true,"authOverride":false},
         "proxyWeight":8,"proxyFableExcluded":true}
        """
        let a = try JSONDecoder().decode(DeckAccount.self, from: Data(json.utf8))
        #expect(a.identity == "placeholder@example.test")
        #expect(a.purpose == "work")
        #expect(a.color == "blue")
        #expect(a.profileRef == "/tmp/p")
        #expect(a.isDefault)
        #expect(a.authState == "signin-required")
        #expect(a.signinReason == "expired")
        #expect(a.lastRefreshError?.message == "boom")
        #expect(a.claudeStatusline?.installed == true)
        #expect(a.renew?.available == true)
        #expect(a.proxyWeight == 8)
        #expect(a.proxyFableExcluded == true)
    }
}

// MARK: - #279 state machine

@Suite("Proxy pool model relays decided outcomes (issue #279)")
@MainActor
struct ProxyPoolModelTests {
    @Test func aSettledJoinShowsTheOutcomeAndRefreshesState() async {
        let manager = ProxyManagerStub(join: .success(ProxyPoolJoin(proxyPool: "member")))
        let states = StateStub()
        let model = ProxyPoolModel(manager: manager, stateProvider: states)
        var applied = 0
        model.onStateChanged = { _ in applied += 1 }
        let a = account(proxyPool: "absent")

        model.beginJoin(account: a)
        #expect(model.phase(for: a.id) == .joining)
        #expect(model.presentation(for: a)?.display == .joinWaiting)
        await model.joinTasks[a.id]?.value

        #expect(model.phase(for: a.id) == nil)
        #expect(model.presentation(for: a)?.display
            == .note("Added to the proxy pool — a routing weight arrives with the next rebalance."))
        #expect(applied == 1)
        #expect(manager.joinedIDs == ["a1"])
    }

    @Test func anAlreadyMemberJoinSaysSo() async {
        let manager = ProxyManagerStub(
            join: .success(ProxyPoolJoin(proxyPool: "member", alreadyMember: true))
        )
        let model = ProxyPoolModel(manager: manager, stateProvider: StateStub())
        let a = account(proxyPool: "absent")
        model.beginJoin(account: a)
        await model.joinTasks[a.id]?.value
        #expect(model.presentation(for: a)?.display == .note("Already in the proxy pool."))
    }

    @Test func aRefusedJoinShowsTheDaemonsSanitizedSentence() async {
        // 409 concurrent / 502 early exit / 504 timeout all arrive as the
        // standard daemon error; the detail is sanitized daemon-side (the
        // child's output may carry tokened OAuth URLs) and renders verbatim.
        let manager = ProxyManagerStub(join: .failure(DaemonClientError.daemonError(
            message: "CLIProxyAPI claude login timed out before a matching auth file appeared",
            status: 504
        )))
        let model = ProxyPoolModel(manager: manager, stateProvider: StateStub())
        let a = account(proxyPool: "absent")
        model.beginJoin(account: a)
        await model.joinTasks[a.id]?.value
        #expect(model.presentation(for: a)?.display
            == .error("CLIProxyAPI claude login timed out before a matching auth file appeared"))
    }

    @Test func stoppingTheWaitIsHonestAboutTheDaemonStillWatching() async {
        let manager = ProxyManagerStub(join: .success(ProxyPoolJoin()))
        let model = ProxyPoolModel(manager: manager, stateProvider: StateStub())
        let a = account(proxyPool: "absent")
        model.beginJoin(account: a)
        model.cancelJoinWait(accountID: a.id)
        #expect(model.phase(for: a.id) == nil)
        #expect(model.presentation(for: a)?.display == .note(ProxyPool.joinWaitStoppedText))
    }

    @Test func aRestartedJoinIsNotOverwrittenByTheAbandonedOne() async {
        // CodeRabbit (PR #285): stop waiting, start a SECOND join, and the
        // first task can still resume — its await had already returned — see
        // the new attempt's state, and overwrite it. The two attempts return
        // DIFFERENT outcomes here so the winner is unambiguous: if the
        // abandoned attempt writes, the note reads "Already in the pool".
        var release: (() -> Void)?
        let stream = AsyncStream<Void> { continuation in
            release = { continuation.finish() }
        }
        let manager = ProxyManagerStub()
        manager.queuedJoins = [
            .success(ProxyPoolJoin(proxyPool: "member", alreadyMember: true)),  // abandoned
            .success(ProxyPoolJoin(proxyPool: "member")),                       // live
        ]
        manager.firstJoinGate = (stream, release ?? {})
        let model = ProxyPoolModel(manager: manager, stateProvider: StateStub())
        let a = account(proxyPool: "absent")

        model.beginJoin(account: a)              // attempt 1 — parked in the gate
        model.cancelJoinWait(accountID: a.id)    // user stops waiting
        #expect(model.presentation(for: a)?.display == .note(ProxyPool.joinWaitStoppedText))

        model.beginJoin(account: a)              // attempt 2 — runs to completion
        await model.joinTasks[a.id]?.value
        #expect(model.presentation(for: a)?.display
            == .note("Added to the proxy pool — a routing weight arrives with the next rebalance."))

        release?()                                // attempt 1 finally resumes
        await Task.yield()
        await Task.yield()

        // The abandoned attempt must not have overwritten the live result.
        #expect(model.presentation(for: a)?.display
            == .note("Added to the proxy pool — a routing weight arrives with the next rebalance."),
            "the abandoned attempt overwrote the live one's outcome")
    }

    @Test func routingWritesReReadTheDaemonsTruth() async {
        let manager = ProxyManagerStub(routing: .success(ProxyRoutingState(proxyRouted: true)))
        let states = StateStub()
        let model = ProxyPoolModel(manager: manager, stateProvider: states)
        var applied = 0
        model.onStateChanged = { _ in applied += 1 }
        let a = account(proxyPool: "member", proxyRouted: false)

        await model.setRouting(account: a, enabled: true)

        #expect(manager.routingCalls.map(\.1) == [true])
        #expect(model.phase(for: a.id) == nil)
        #expect(applied == 1, "the status line must render re-read state, never an optimistic echo")
    }

    @Test func aRefusedRoutingWriteRendersTheRefusal() async {
        let manager = ProxyManagerStub(routing: .failure(DaemonClientError.daemonError(
            message: "a renewal is in flight for this account", status: 409
        )))
        let model = ProxyPoolModel(manager: manager, stateProvider: StateStub())
        let a = account(proxyPool: "member", proxyRouted: false)

        await model.setRouting(account: a, enabled: true)

        #expect(model.presentation(for: a)?.display
            == .error("a renewal is in flight for this account"))
        // And the armed action is NOT re-offered over an unread refusal.
        #expect(model.presentation(for: a)?.display != .action(.route))
    }

    @Test func anUnreadOutcomeOutranksTheArmedAction() async {
        let manager = ProxyManagerStub(routing: .failure(DaemonClientError.daemonError(
            message: "nope", status: 409
        )))
        let model = ProxyPoolModel(manager: manager, stateProvider: StateStub())
        let a = account(proxyPool: "member", proxyRouted: false)
        await model.setRouting(account: a, enabled: true)
        #expect(model.presentation(for: a)?.display == .error("nope"))
        model.dismissOutcome(accountID: a.id)
        #expect(model.presentation(for: a)?.display == .action(.route))
    }

    @Test func aLateFailureStillAnswersEvenIfThePoolKeyVanishes() async {
        // #199's rule: a click's answer lands at the click site. If the
        // daemon stops reporting pool state mid-attempt, the row must still
        // show what happened rather than silently rendering nothing.
        let manager = ProxyManagerStub(routing: .failure(DaemonClientError.daemonError(
            message: "gone", status: 409
        )))
        let model = ProxyPoolModel(manager: manager, stateProvider: StateStub())
        await model.setRouting(account: account(proxyPool: "member", proxyRouted: false), enabled: true)
        let presentation = model.presentation(for: account())
        #expect(presentation?.display == .error("gone"))
        #expect(presentation?.statusText == "")
    }

    @Test func noAttemptAndNoPoolMeansNoRow() {
        let model = ProxyPoolModel(manager: ProxyManagerStub(), stateProvider: StateStub())
        #expect(model.presentation(for: account()) == nil)
    }

    @Test func aFailedPostMutationRefreshSaysSo() async {
        // Adversarial review M7: the mandatory post-mutation re-read used
        // `try?` — a failure left the row rendering pre-mutation state with
        // no hint until the next auto-refresh. It must land on the row.
        let manager = ProxyManagerStub(routing: .success(ProxyRoutingState(proxyRouted: true)))
        let model = ProxyPoolModel(manager: manager, stateProvider: FailingStateStub())
        let a = account(proxyPool: "member", proxyRouted: false)

        await model.setRouting(account: a, enabled: true)

        #expect(model.presentation(for: a)?.display == .note(ProxyPool.stateRefreshFailedText))
    }

    @Test func aFailedRefreshRidesAnUnreadError() async {
        // An unread error outranks notes in `presentation`, so the refresh
        // failure appends there — a note behind the error would never render.
        let manager = ProxyManagerStub(routing: .failure(DaemonClientError.daemonError(
            message: "nope", status: 409
        )))
        let model = ProxyPoolModel(manager: manager, stateProvider: FailingStateStub())
        let a = account(proxyPool: "member", proxyRouted: false)

        await model.setRouting(account: a, enabled: true)

        #expect(model.presentation(for: a)?.display
            == .error("nope " + ProxyPool.stateRefreshFailedText))
    }

    @Test func aStaleRefreshNeverOverwritesANewerOne() async {
        // Adversarial review M6: two settled mutations close together mean
        // two refreshes in flight; the older response arriving LAST must not
        // roll the deck back to the state the newer one already replaced.
        let older = DeckState(accounts: [account(id: "older")])
        let newer = DeckState(accounts: [account(id: "newer")])
        let states = GatedStateStub(first: older, second: newer)
        let model = ProxyPoolModel(manager: ProxyManagerStub(), stateProvider: states)
        var applied: [String?] = []
        model.onStateChanged = { applied.append($0.accounts.first?.id) }

        let stale = Task { await model.refreshState(accountID: "a1") }
        while states.calls < 1 { await Task.yield() }
        await model.refreshState(accountID: "a1")  // newer attempt settles first
        states.release()
        await stale.value

        #expect(applied == ["newer"], "the stale refresh overwrote the newer applied state")
    }
}

// MARK: - #279 deck badge

@Suite("Deck ⑂ badge gains the absent state (issue #279)")
struct ProxyAbsentBadgeTests {
    private func row(_ a: DeckAccount) -> DeckAccountRow {
        DeckAccountRow(account: a, provider: .claude, windows: [], isActive: false)
    }

    @Test func absentRendersTheGlyphWithNoNumber() {
        let presentation = row(account(proxyPool: "absent")).proxyWeightPresentation
        #expect(presentation?.absentFromPool == true)
        #expect(presentation?.weight == 0)
    }

    @Test func membershipWithoutAWeightYetRendersNothing() {
        // A fresh join has no weight until the external rebalance job's next
        // tick; a badge would claim a routing weight that doesn't exist.
        #expect(row(account(proxyPool: "member")).proxyWeightPresentation == nil)
        // And a machine with no proxy at all is unchanged from pre-#279.
        #expect(row(account()).proxyWeightPresentation == nil)
    }

    @Test func theAbsentStateIsSpokenOnTheRowItself() {
        // THE trap this codebase has hit three times (#65, #113, #272): the
        // deck row button carries an EXPLICIT accessibility label, which
        // suppresses every child element's label. Any new spoken state must
        // be folded into the Core derivation or VoiceOver never hears it.
        let label = row(account(proxyPool: "absent"))
            .accessibilityLabel(showsIdentity: false, isMenuBarSource: false)
        #expect(label.contains("not in the proxy pool"))
        // A weighted row keeps its pre-#279 wording exactly.
        let weighted = DeckAccountRow(
            account: DeckAccount(
                id: "a1", provider: "claude", label: "Studio",
                enabled: true, isDefault: false, authState: "ok", proxyWeight: 3
            ),
            provider: .claude, windows: [], isActive: false
        )
        #expect(weighted.accessibilityLabel(showsIdentity: false, isMenuBarSource: false)
            .contains("proxy routing weight 3"))
    }

    @Test func theBadgeTooltipNamesTheAbsentState() {
        #expect(ProxyPool.notInPoolTooltip == "Not in the proxy pool")
    }
}

// MARK: - #280

@Suite("Seeded identity gets a Verify exit (issue #280)")
struct IdentityVerifyCopyTests {
    @Test func thePillTooltipNamesBothExits() {
        // Tim's complaint: the tooltip promised a "yet" that no code path
        // could ever deliver. Both arrival stories are now named.
        #expect(IdentityVerify.pillTooltip.contains("Verify checks now"))
        #expect(IdentityVerify.pillTooltip.contains("next auto-renewal will"))
        #expect(IdentityVerify.pillAccessibilityLabel.contains("Verify checks now"))
        #expect(IdentityVerify.pillAccessibilityLabel.contains("next auto-renewal will"))
        // The button promises a read-only check — no sign-in, no quota.
        #expect(IdentityVerify.buttonTooltip.contains("read-only"))
        #expect(IdentityVerify.buttonTooltip.contains("no usage spent"))
    }

    @Test func decidedOutcomesReadHonestly() {
        #expect(IdentityVerify.failureText(for: IdentityVerification(outcome: "verified")) == nil)
        let mismatch = IdentityVerify.failureText(for: IdentityVerification(
            outcome: "mismatch", reported: "other@example.test"
        ))
        // Adversarial review MINOR-e: the roster's identity notice exists
        // only for the provider's ACTIVE account, so the line never points
        // at it — it names the identities itself.
        #expect(mismatch == "The provider is signed in as other@example.test, not this account's saved identity.")
        #expect(IdentityVerify.failureText(
            for: IdentityVerification(outcome: "mismatch", reported: "other@example.test"),
            expected: "placeholder@example.test"
        ) == "The provider is signed in as other@example.test, not placeholder@example.test.")
        #expect(IdentityVerify.failureText(for: IdentityVerification(outcome: "mismatch"))?
            .contains("reports a different identity") == true)
        #expect(IdentityVerify.failureText(for: IdentityVerification(
            outcome: "unavailable", detail: "Claude CLI not found."
        )) == "Claude CLI not found.")
        #expect(IdentityVerify.failureText(for: IdentityVerification(outcome: "unavailable"))
            == "Couldn't check with the provider right now.")
        // Tolerate-unknowns: never a fake success.
        #expect(IdentityVerify.failureText(for: IdentityVerification(outcome: "future-state")) != nil)
        #expect(IdentityVerify.failureText(for: IdentityVerification()) != nil)
    }

    @Test func theVerificationEnvelopeDecodesTolerantly() throws {
        let good = try JSONDecoder().decode(
            IdentityVerification.self,
            from: Data(#"{"outcome":"mismatch","reported":"other@example.test"}"#.utf8)
        )
        #expect(good.outcome == "mismatch")
        #expect(good.reported == "other@example.test")
        let odd = try JSONDecoder().decode(
            IdentityVerification.self, from: Data(#"{"outcome":42}"#.utf8)
        )
        #expect(odd.outcome == nil)
        #expect(IdentityVerify.failureText(for: odd) != nil)
    }
}

@Suite("Verify button state machine (issue #280)")
@MainActor
struct IdentityVerifyModelTests {
    private var seeded: DeckAccount {
        account(metadata: DeckAccountMetadata(identitySource: "seed"))
    }

    @Test func theButtonRendersOnlyBesideThePill() {
        let model = IdentityVerifyModel(verifier: VerifyStub(), stateProvider: StateStub())
        #expect(seeded.isIdentitySeeded)
        #expect(model.presentation(for: seeded)?.display == .verify)
        // A verified (or never-seeded) account shows neither pill nor button.
        #expect(model.presentation(for: account()) == nil)
        #expect(model.presentation(
            for: account(metadata: DeckAccountMetadata(identitySource: "verified"))
        ) == nil)
    }

    @Test func aVerifiedIdentityLetsThePillDisappear() async {
        // The daemon promotes seed → verified itself; the fresh state drops
        // the pill, and the disappearance IS the success feedback.
        let states = StateStub()
        let model = IdentityVerifyModel(
            verifier: VerifyStub(result: .success(IdentityVerification(outcome: "verified"))),
            stateProvider: states
        )
        var applied = 0
        model.onStateChanged = { _ in applied += 1 }

        await model.verify(account: seeded)

        #expect(applied == 1)
        // Rendered against the PROMOTED account the refresh brings back.
        #expect(model.presentation(for: account()) == nil)
    }

    @Test func aMismatchNeverPromotesAndNamesBothIdentities() async {
        // Adversarial review MINOR-e: "see the identity notice above" named
        // a banner that exists only for the provider's active account — on
        // any other row it pointed at nothing. The line stands alone now.
        let model = IdentityVerifyModel(
            verifier: VerifyStub(result: .success(IdentityVerification(
                outcome: "mismatch", reported: "other@example.test"
            ))),
            stateProvider: StateStub()
        )
        let seededWithIdentity = account(
            identity: "placeholder@example.test",
            metadata: DeckAccountMetadata(identitySource: "seed")
        )
        await model.verify(account: seededWithIdentity)
        guard case .failure(let text)? = model.presentation(for: seededWithIdentity)?.display else {
            Issue.record("expected a quiet inline failure"); return
        }
        #expect(text == "The provider is signed in as other@example.test, not placeholder@example.test.")
        #expect(!text.contains("identity notice above"))
    }

    @Test func aDaemonWithoutTheEndpointFailsQuietlyAndKeepsTheButton() async {
        // The endpoint ships in a parallel lane: an app running against a
        // daemon that lacks it must degrade to a plain failure, never a
        // crash and never a fake success.
        let model = IdentityVerifyModel(
            verifier: VerifyStub(result: .failure(
                DaemonClientError.daemonError(message: "not found", status: 404)
            )),
            stateProvider: StateStub()
        )
        await model.verify(account: seeded)
        #expect(model.presentation(for: seeded)?.display == .failure("not found"))
        model.dismissOutcome(accountID: seeded.id)
        #expect(model.presentation(for: seeded)?.display == .verify)
    }

    @Test func aFailedRefreshAfterVerifySurfacesOnTheRow() async {
        // Adversarial review M7: the daemon promoted seed → verified, the
        // re-read failed, and `try?` said nothing — the pill kept rendering
        // against the daemon's truth until the next auto-refresh.
        let model = IdentityVerifyModel(
            verifier: VerifyStub(result: .success(IdentityVerification(outcome: "verified"))),
            stateProvider: FailingStateStub()
        )
        await model.verify(account: seeded)
        #expect(model.presentation(for: seeded)?.display
            == .failure(ProxyPool.stateRefreshFailedText))
        // Dismissible like every other decided outcome.
        model.dismissOutcome(accountID: seeded.id)
        #expect(model.presentation(for: seeded)?.display == .verify)
    }

    @Test func aStaleRefreshNeverOverwritesANewerVerify() async {
        // Adversarial review M6: verifies of two accounts overlap; the
        // older refresh answering LAST must not roll back the newer state.
        let older = DeckState(accounts: [account(id: "older")])
        let newer = DeckState(accounts: [account(id: "newer")])
        let states = GatedStateStub(first: older, second: newer)
        let model = IdentityVerifyModel(
            verifier: VerifyStub(result: .success(IdentityVerification(outcome: "verified"))),
            stateProvider: states
        )
        var applied: [String?] = []
        model.onStateChanged = { applied.append($0.accounts.first?.id) }
        let first = account(id: "s1", metadata: DeckAccountMetadata(identitySource: "seed"))
        let second = account(id: "s2", metadata: DeckAccountMetadata(identitySource: "seed"))

        let stale = Task { await model.verify(account: first) }
        while states.calls < 1 { await Task.yield() }
        await model.verify(account: second)  // newer attempt settles first
        states.release()
        await stale.value

        #expect(applied == ["newer"], "the stale refresh overwrote the newer applied state")
    }

    @Test func aBusyAccountIsRefusedVerbatim() async {
        let model = IdentityVerifyModel(
            verifier: VerifyStub(result: .failure(DaemonClientError.daemonError(
                message: "a renewal is in flight for this account", status: 409
            ))),
            stateProvider: StateStub()
        )
        await model.verify(account: seeded)
        #expect(model.presentation(for: seeded)?.display
            == .failure("a renewal is in flight for this account"))
    }
}

// MARK: - Stubs

private final class ProxyManagerStub: ProxyPoolManaging, @unchecked Sendable {
    enum JoinResult { case success(ProxyPoolJoin), failure(Error) }
    enum RoutingResult { case success(ProxyRoutingState), failure(Error) }

    private let join: JoinResult
    private let routing: RoutingResult
    private(set) var joinedIDs: [String] = []
    private(set) var routingCalls: [(String, Bool)] = []
    /// Optional gate: when set, the FIRST join suspends here until released,
    /// so a test can model a task still in flight while a second attempt
    /// starts (CodeRabbit, PR #285).
    var firstJoinGate: (stream: AsyncStream<Void>, release: () -> Void)?
    private var gateConsumed = false

    init(
        join: JoinResult = .success(ProxyPoolJoin()),
        routing: RoutingResult = .success(ProxyRoutingState())
    ) {
        self.join = join
        self.routing = routing
    }

    /// Per-attempt results, consumed in order; falls back to `join` when
    /// exhausted. Lets a test tell an abandoned attempt's write apart from
    /// the live one's (CodeRabbit, PR #285).
    var queuedJoins: [JoinResult] = []

    func joinProxyPool(accountID: String) async throws -> ProxyPoolJoin {
        joinedIDs.append(accountID)
        let outcome = queuedJoins.isEmpty ? join : queuedJoins.removeFirst()
        if let gate = firstJoinGate, !gateConsumed {
            gateConsumed = true
            for await _ in gate.stream { break }
        }
        switch outcome {
        case .success(let value): return value
        case .failure(let error): throw error
        }
    }

    func setProxyRouting(accountID: String, enabled: Bool) async throws -> ProxyRoutingState {
        routingCalls.append((accountID, enabled))
        switch routing {
        case .success(let value): return value
        case .failure(let error): throw error
        }
    }
}

private final class VerifyStub: IdentityVerifying, @unchecked Sendable {
    enum Result { case success(IdentityVerification), failure(Error) }

    private let result: Result

    init(result: Result = .success(IdentityVerification(outcome: "verified"))) {
        self.result = result
    }

    func verifyIdentity(accountID: String) async throws -> IdentityVerification {
        switch result {
        case .success(let value): return value
        case .failure(let error): throw error
        }
    }
}

private struct StateStub: DeckStateProviding {
    func deckState() async throws -> DeckState { DeckState(accounts: [], usage: []) }
}

/// The post-mutation re-read fails (adversarial review M7).
private struct FailingStateStub: DeckStateProviding {
    func deckState() async throws -> DeckState {
        throw DaemonClientError.daemonError(message: "state unavailable", status: 500)
    }
}

/// The FIRST read parks until `release()` and answers `first`; later reads
/// answer `second` immediately — models the older refresh whose response
/// arrives after a newer one already applied (adversarial review M6).
private final class GatedStateStub: DeckStateProviding, @unchecked Sendable {
    private let first: DeckState
    private let second: DeckState
    private(set) var calls = 0
    private let stream: AsyncStream<Void>
    private let releaseGate: () -> Void

    init(first: DeckState, second: DeckState) {
        self.first = first
        self.second = second
        var continuation: AsyncStream<Void>.Continuation?
        self.stream = AsyncStream { continuation = $0 }
        let held = continuation
        self.releaseGate = { held?.finish() }
    }

    func release() { releaseGate() }

    func deckState() async throws -> DeckState {
        calls += 1
        if calls == 1 {
            for await _ in stream { break }
            return first
        }
        return second
    }
}
