import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #396 — the UI half of the in-app credential repair.
//
// The field incident (2026-08-12): a pool credential expired and the ONLY
// recovery was Tim hand-running `cliproxyapi -claude-login` in a terminal.
// Everything here exists so that never happens again: the app drives
// CLIProxyAPI's OWN sign-in, opens the page the PROXY generated, and reports
// the proxy's own verdict — honestly, including when it fails.
//
// The #398 verdict is upheld structurally on the daemon side (TRIPWIRE
// relogin-never-touches-auth-files, test/proxy-relogin.test.mjs). This suite
// owns the phase machine, the copy, and the "unavailable says why" rule.
//
// Placeholder labels/identities only — this repo mirrors publicly.

private func account(
    id: String = "a1",
    provider: String = "claude",
    label: String = "Studio",
    proxyPool: String? = "member",
    proxyCredential: String? = nil,
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

// MARK: - Derivations

@Suite("Credential repair derivations (issue #396)")
struct ProxyReloginDerivationTests {
    @Test func aMachineWithoutTheProxyRendersNothing() {
        // THE discipline of the whole proxy feature (#149/#174). No pool key
        // and no capability means the daemon could not know — not "broken".
        let plain = account(proxyPool: nil, proxyRelogin: nil)
        #expect(ProxyRelogin.isOffered(for: plain) == false)
        #expect(ProxyRelogin.isAvailable(for: plain) == false)
        #expect(ProxyRelogin.unavailableReason(for: plain) == nil)
        #expect(ProxyRelogin.credentialText(for: plain) == nil)
    }

    @Test func anOlderDaemonThatOmitsTheCapabilityRendersNothing() {
        // Skew contract: the pool line still renders from #279 fields, but
        // no repair affordance appears anywhere.
        let old = account(proxyRelogin: nil)
        #expect(ProxyRelogin.isOffered(for: old) == false)
        #expect(ProxyRelogin.isAvailable(for: old) == false)
    }

    @Test func anAccountOutsideThePoolIsNotOfferedARepair() {
        // Joining is #279's operation; repairing is only meaningful for a
        // credential the proxy already holds.
        let absent = account(proxyPool: "absent")
        #expect(ProxyRelogin.isOffered(for: absent) == false)
    }

    @Test func aBrokenCredentialSaysSoAndNamesTheProxysOwnReason() {
        let broken = account(proxyCredential: "error", proxyCredentialDetail: "unauthorized")
        #expect(ProxyRelogin.credentialIsBroken(broken))
        #expect(ProxyRelogin.credentialText(for: broken) == "Proxy sign-in expired (unauthorized)")
        // Without a reason, the fact still lands.
        let bare = account(proxyCredential: "error")
        #expect(ProxyRelogin.credentialText(for: bare) == "Proxy sign-in expired")
    }

    @Test func aBenchedCredentialIsNotABrokenOne() {
        // Signing in again would not un-bench it, so it must not be dressed
        // up as the same problem.
        let benched = account(proxyCredential: "disabled")
        #expect(ProxyRelogin.credentialIsBroken(benched) == false)
        #expect(ProxyRelogin.credentialText(for: benched) == "Benched in the proxy pool")
    }

    @Test func aHealthyMemberSaysNothingButKeepsTheRepairReachable() {
        // Quiet, not absent: a user who knows a sign-in is stale should not
        // have to wait for it to break before they can fix it.
        let healthy = account(proxyCredential: "ok")
        #expect(ProxyRelogin.credentialText(for: healthy) == nil)
        #expect(ProxyRelogin.isOffered(for: healthy))
        #expect(ProxyRelogin.isAvailable(for: healthy))
        #expect(ProxyRelogin.unavailableReason(for: healthy) == nil)
    }

    @Test func unavailableAlwaysCarriesItsReason() {
        // Issue #431: a freshly seeded managed config has no management key.
        // The action must say that, not sit there dead — the exact failure
        // shape this issue exists to remove.
        let reason = "This CLIProxyAPI install has no management key yet."
        let noKey = account(
            proxyCredential: "error",
            proxyRelogin: ProxyReloginCapability(available: false, reason: reason)
        )
        #expect(ProxyRelogin.isOffered(for: noKey))
        #expect(ProxyRelogin.isAvailable(for: noKey) == false)
        #expect(ProxyRelogin.unavailableReason(for: noKey) == reason)

        // And a daemon that reported unavailable without a sentence still
        // gets one — an unexplained dead control is never acceptable.
        let silent = account(proxyRelogin: ProxyReloginCapability(available: false, reason: nil))
        #expect(ProxyRelogin.unavailableReason(for: silent) == ProxyRelogin.unavailableFallbackText)
    }

    @Test func phasesMapFromTheDaemonAndTolerateTheUnknown() {
        #expect(ProxyRelogin.Phase(daemon: "awaiting-browser") == .awaitingBrowser)
        #expect(ProxyRelogin.Phase(daemon: "SUCCEEDED") == .succeeded)
        #expect(ProxyRelogin.Phase(daemon: nil) == .idle)
        // A newer daemon's phase must not strand a row in a state this build
        // has no way to leave.
        #expect(ProxyRelogin.Phase(daemon: "quantum-pending") == .idle)
        #expect(ProxyRelogin.Phase.awaitingBrowser.isRunning)
        #expect(ProxyRelogin.Phase.starting.isRunning)
        #expect(ProxyRelogin.Phase.failed.isSettled)
        #expect(ProxyRelogin.Phase.succeeded.isSettled)
        #expect(ProxyRelogin.Phase.cancelled.isSettled)
        #expect(ProxyRelogin.Phase.idle.isRunning == false)
        #expect(ProxyRelogin.Phase.idle.isSettled == false)
    }

    @Test func settledTextPrefersTheDaemonsOwnFailureSentence() {
        // Issue #542: the settled sentences name the subscription they
        // settled for; the daemon's own failure detail still wins outright.
        #expect(ProxyRelogin.settledText(phase: .succeeded, detail: nil, label: "Studio", providerName: "Claude")
            == ProxyRelogin.succeededText(label: "Studio", providerName: "Claude"))
        #expect(ProxyRelogin.settledText(phase: .cancelled, detail: nil, label: "Studio", providerName: "Claude")
            == "Sign-in for Studio (Claude) stopped. Nothing changed.")
        #expect(ProxyRelogin.settledText(
            phase: .failed,
            detail: "CLIProxyAPI could not finish the sign-in: bad state",
            label: "Studio",
            providerName: "Claude"
        ) == "Studio (Claude): CLIProxyAPI could not finish the sign-in: bad state")
        #expect(ProxyRelogin.settledText(phase: .failed, detail: nil, label: "Studio", providerName: "Claude")
            == "Studio (Claude): \(ProxyRelogin.failedFallbackText)")
        #expect(ProxyRelogin.settledText(phase: .failed, detail: "", label: "Studio", providerName: "Claude")
            == "Studio (Claude): \(ProxyRelogin.failedFallbackText)")
    }

    @Test func theConfirmationDisclosesBothSurprises() {
        let text = ProxyRelogin.confirmation(label: "Studio")
        // What will happen…
        #expect(text.contains("browser"))
        #expect(text.contains("Studio"))
        // …and the safety fact that makes it acceptable.
        #expect(text.contains("ModelDeck never handles the credential"))
    }
}

// MARK: - The flow

@Suite("Credential repair flow (issue #396)")
@MainActor
struct ProxyReloginFlowTests {
    @Test func aRepairOpensTheProxysPageAndSettlesOnItsVerdict() async {
        let manager = ReloginStub(
            start: .success(ProxyReloginState(
                phase: "awaiting-browser",
                url: "https://provider.invalid/authorize?code_challenge=x"
            )),
            polls: [
                ProxyReloginState(phase: "awaiting-browser"),
                ProxyReloginState(phase: "succeeded"),
            ]
        )
        let browser = BrowserStub()
        let model = makeModel(manager: manager, browser: browser)
        let broken = account(proxyCredential: "error", proxyCredentialDetail: "unauthorized")

        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        // The user's only step was in the browser — the page the PROXY built.
        #expect(browser.opened.map(\.absoluteString) == ["https://provider.invalid/authorize?code_challenge=x"])
        #expect(manager.startedIDs == [broken.id])
        #expect(model.phase(for: broken.id) == nil)
        #expect(model.notes[broken.id] == ProxyRelogin.succeededText(label: broken.label, providerName: "Claude"))
        #expect(model.errors[broken.id] == nil)
    }

    @Test func aRestoredMemberIsTheDaemonsTruth() async {
        // The recovery signal (#395's detector clears on this): a settled
        // repair re-reads state, and the healthy member is what renders.
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(phase: "succeeded")]
        )
        let model = makeModel(manager: manager, stateProvider: HealthyStateStub())
        var applied: DeckState?
        model.onStateChanged = { applied = $0 }
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        #expect(applied?.accounts.first?.proxyCredential == "ok")
        // And the restored row no longer shouts.
        let restored = account(proxyCredential: "ok")
        #expect(ProxyRelogin.credentialText(for: restored) == nil)
    }

    @Test func aFailureSaysTheProxysOwnReason() async {
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(
                phase: "failed",
                detail: "CLIProxyAPI could not finish the sign-in: unknown or expired state"
            )]
        )
        let model = makeModel(manager: manager)
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        #expect(model.phase(for: broken.id) == nil)
        // Issue #542: the sentence names its subscription and then gets out of
        // the way — the daemon's own reason survives verbatim after the target.
        #expect(model.errors[broken.id]
            == "Studio (Claude): CLIProxyAPI could not finish the sign-in: unknown or expired state")
        #expect(model.notes[broken.id] == nil)
    }

    @Test func aDaemonRefusalSurfacesVerbatim() async {
        // 409 from the daemon: no management key (#431), or a repair already
        // running. Either way the sentence is the daemon's.
        let manager = ReloginStub(
            start: .failure(DaemonClientError.daemonError(
                message: "This CLIProxyAPI install has no management key yet.",
                status: 409
            ))
        )
        let model = makeModel(manager: manager)
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        #expect(model.phase(for: broken.id) == nil)
        #expect(model.errors[broken.id]?.contains("no management key yet") == true)
    }

    @Test func aStartWithoutAnOpenablePageIsSaidOutLoud() async {
        // CodeRabbit (PR #435): a sign-in nobody can finish is settled HERE —
        // the error is shown rather than hidden behind the running text, the
        // proxy drops its own pending session, and no poll ever runs (the
        // queued poll answer must go unconsumed).
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: nil)),
            polls: [ProxyReloginState(phase: "failed", detail: "timed out")]
        )
        let browser = BrowserStub()
        let model = makeModel(manager: manager, browser: browser)
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        #expect(browser.opened.isEmpty)
        #expect(model.errors[broken.id] == ProxyRelogin.browserOpenFailedText)
        #expect(model.phase(for: broken.id) == nil)
        #expect(manager.cancelledIDs == [broken.id])
    }

    @Test func aNonHttpsPageIsNeverOpened() async {
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "javascript:alert(1)")),
            polls: [ProxyReloginState(phase: "failed", detail: "timed out")]
        )
        let browser = BrowserStub()
        let model = makeModel(manager: manager, browser: browser)
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        #expect(browser.opened.isEmpty)
        #expect(model.errors[broken.id] == ProxyRelogin.browserOpenFailedText)
        #expect(manager.cancelledIDs == [broken.id])
    }

    @Test func stoppingAsksTheProxyToDropItsOwnSession() async {
        // Unlike the #279 join wait, this genuinely stops the flow — so the
        // copy says "Nothing changed", not "it may still land".
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(phase: "awaiting-browser")],
            parkAfterFirstPoll: true
        )
        let model = makeModel(manager: manager)
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        while model.phase(for: broken.id) != .awaitingBrowser { await Task.yield() }
        model.cancel(account: broken)

        #expect(model.phase(for: broken.id) == nil)
        #expect(model.notes[broken.id]
            == ProxyRelogin.cancelledText(label: broken.label, providerName: "Claude"))
        while manager.cancelledIDs.isEmpty { await Task.yield() }
        #expect(manager.cancelledIDs == [broken.id])
    }

    @Test func aStaleAttemptCanNeverOverwriteANewerOne() async {
        // The ProxyPoolModel lesson (CodeRabbit PR #285): stop, start again,
        // and the abandoned task must not resurrect its own outcome.
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(phase: "awaiting-browser")],
            parkAfterFirstPoll: true
        )
        let model = makeModel(manager: manager)
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        while model.phase(for: broken.id) != .awaitingBrowser { await Task.yield() }
        model.cancel(account: broken)
        #expect(model.notes[broken.id]
            == ProxyRelogin.cancelledText(label: broken.label, providerName: "Claude"))

        // TWO queued answers: cancel() does not synchronize with the
        // abandoned task, so a stale poll already in flight can consume one
        // (it is then discarded by the generation guard — the very property
        // this test pins). With one answer, that steal left the live attempt
        // parking forever: the suite hang of 2026-08-14. Either interleaving
        // now finds a `succeeded` for the live attempt.
        manager.queue(polls: [
            ProxyReloginState(phase: "succeeded"),
            ProxyReloginState(phase: "succeeded"),
        ])
        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        // The second attempt's outcome stands, uncontaminated.
        #expect(model.notes[broken.id] == ProxyRelogin.succeededText(label: broken.label, providerName: "Claude"))
        #expect(model.errors[broken.id] == nil)
    }

    @Test func twoRepairsForOneAccountCannotStartAtOnce() async {
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(phase: "awaiting-browser")],
            parkAfterFirstPoll: true
        )
        let model = makeModel(manager: manager)
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        while model.phase(for: broken.id) != .awaitingBrowser { await Task.yield() }
        model.begin(account: broken)
        #expect(manager.startedIDs.count == 1)
    }

    @Test func aFailedReReadIsSaidRatherThanSwallowed() async {
        // Adversarial review M7's rule, inherited: the row must never
        // silently contradict the daemon.
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(phase: "succeeded")]
        )
        let model = makeModel(manager: manager, stateProvider: FailingReloginStateStub())
        let broken = account(proxyCredential: "error")

        model.begin(account: broken)
        await model.tasks[broken.id]?.value

        #expect(model.notes[broken.id]?.contains(ProxyPool.stateRefreshFailedText) == true)
    }

    @Test func dismissingClearsOnlyASettledOutcome() async {
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(phase: "succeeded")]
        )
        let model = makeModel(manager: manager)
        let broken = account(proxyCredential: "error")
        model.begin(account: broken)
        await model.tasks[broken.id]?.value
        #expect(model.notes[broken.id] != nil)
        model.dismissOutcome(accountID: broken.id)
        #expect(model.notes[broken.id] == nil)
        #expect(model.errors[broken.id] == nil)
    }
}

// MARK: - Presentation

@Suite("Credential repair row presentation (issue #396)")
@MainActor
struct ProxyReloginPresentationTests {
    @Test func nothingRendersWithoutAPool() {
        let model = makeModel(manager: ReloginStub())
        #expect(model.presentation(for: account(proxyPool: nil, proxyRelogin: nil)) == nil)
    }

    @Test func aBrokenCredentialArmsTheProminentFix() {
        let model = makeModel(manager: ReloginStub())
        let broken = account(proxyCredential: "error", proxyCredentialDetail: "unauthorized")
        let presentation = model.presentation(for: broken)
        #expect(presentation?.credentialText == "Proxy sign-in expired (unauthorized)")
        #expect(presentation?.display == .action(prominent: true))
    }

    @Test func aHealthyMemberKeepsTheFixQuiet() {
        // Available, but not promoted to a visible button — the ⋯ menu is
        // where a remedy nobody asked for belongs.
        let model = makeModel(manager: ReloginStub())
        let presentation = model.presentation(for: account(proxyCredential: "ok"))
        #expect(presentation?.credentialText == nil)
        #expect(presentation?.display == .action(prominent: false))
    }

    @Test func aRestingMemberShowsLocalResetTimeWithoutPromotingSignIn() {
        let model = makeModel(manager: ReloginStub())
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let formatter = ISO8601DateFormatter()
        for fractional in [false, true] {
            formatter.formatOptions = fractional
                ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
            let resting = account(proxyCredential: "resting", proxyCredentialDetail: formatter.string(from: reset))
            let expected = "Rate limited · back at \(DateFormatter.localizedString(from: reset, dateStyle: .none, timeStyle: .short))"
            #expect(ProxyRelogin.credentialText(for: resting) == expected)
            #expect(ProxyRelogin.credentialIsBroken(resting) == false)
            let presentation = model.presentation(for: resting)
            #expect(presentation?.credentialText == expected)
            #expect(presentation?.credentialIsBroken == false)
            #expect(presentation?.display == .quiet)
            for repairedPending in [false, true] {
                let alert = MemberBlackoutAlert(
                    accountId: resting.id, provider: "claude", label: "Studio",
                    consecutiveFailures: 3, statusCode: 429, repairedPending: repairedPending
                )
                let withStreak = model.presentation(for: resting, routedFailures: alert)
                #expect(withStreak?.credentialText == expected)
                #expect(withStreak?.credentialIsBroken == false)
                #expect(withStreak?.display == .quiet)
            }
        }
    }

    @Test func aRestingMemberWithNoUsableResetTimeStaysQuiet() {
        let model = makeModel(manager: ReloginStub())
        for detail: String? in [nil, "", "not-an-instant"] {
            let resting = account(proxyCredential: "resting", proxyCredentialDetail: detail)
            let presentation = model.presentation(for: resting)
            #expect(presentation?.credentialText == "Rate limited · resting")
            #expect(presentation?.credentialIsBroken == false)
            #expect(presentation?.display == .quiet)
        }
    }

    @Test func aRestingDeckBannerUsesQuietCopyForDisplayAndVoiceOver() throws {
        let package = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: package.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
        #expect(source.contains("account.proxyCredential?.lowercased() == \"resting\""))
        #expect(source.contains("? ProxyRelogin.credentialText(for: account) : nil"))
        #expect(source.contains("let quiet = restingText != nil || repaired"))
        #expect(source.contains("let visible = restingText.map { \"\\(alert.label): \\($0)\" }"))
        #expect(source.contains("let message = restingText != nil ? visible : (repaired"))
        #expect(source.contains("foregroundStyle(quiet ? Color.secondary : Color.red)"))
        #expect(source.contains("if !quiet || relogin?.display.isRunning == true {"))
        #expect(source.contains(".accessibilityLabel(\"Pool alert. \\(message)\")"))
    }

    @Test func unavailableRendersItsReason() {
        let model = makeModel(manager: ReloginStub())
        let reason = "This CLIProxyAPI install has no management key yet."
        let presentation = model.presentation(for: account(
            proxyCredential: "error",
            proxyRelogin: ProxyReloginCapability(available: false, reason: reason)
        ))
        #expect(presentation?.display == .unavailable(reason: reason))
    }

    @Test func progressOutranksEverythingElse() async {
        // The #199 precedence: progress → unread outcome → armed action.
        let manager = ReloginStub(
            start: .success(ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/a")),
            polls: [ProxyReloginState(phase: "awaiting-browser")],
            parkAfterFirstPoll: true
        )
        let model = makeModel(manager: manager)
        let broken = account(proxyCredential: "error")
        model.begin(account: broken)
        while model.phase(for: broken.id) != .awaitingBrowser { await Task.yield() }
        #expect(model.presentation(for: broken)?.display
            == .running(
                text: ProxyRelogin.awaitingBrowserText(label: broken.label, providerName: "Claude"),
                canCancel: true
            ))
        model.cancel(account: broken)
        // …then the unread outcome, ahead of the action that is still armed.
        #expect(model.presentation(for: broken)?.display
            == .note(ProxyRelogin.cancelledText(label: broken.label, providerName: "Claude")))
    }
}

// MARK: - Stubs

@MainActor
private func makeModel(
    manager: ReloginStub,
    stateProvider: any DeckStateProviding = EmptyReloginStateStub(),
    browser: BrowserStub = BrowserStub()
) -> ProxyReloginModel {
    ProxyReloginModel(
        manager: manager,
        stateProvider: stateProvider,
        browser: browser,
        // The cadence and the sleep are both injected, so these tests are
        // instant rather than sleeping through a real two-second interval.
        pollInterval: .zero,
        sleep: { _ in }
    )
}

private final class ReloginStub: ProxyReloginManaging, @unchecked Sendable {
    enum StartResult { case success(ProxyReloginState), failure(Error) }

    private let lock = NSLock()
    private let start: StartResult
    private var polls: [ProxyReloginState]
    private let parkAfterFirstPoll: Bool
    private var _startedIDs: [String] = []
    private var _cancelledIDs: [String] = []

    var startedIDs: [String] { lock.withLock { _startedIDs } }
    var cancelledIDs: [String] { lock.withLock { _cancelledIDs } }

    init(
        start: StartResult = .success(ProxyReloginState(phase: "awaiting-browser")),
        polls: [ProxyReloginState] = [],
        parkAfterFirstPoll: Bool = false
    ) {
        self.start = start
        self.polls = polls
        self.parkAfterFirstPoll = parkAfterFirstPoll
    }

    func queue(polls next: [ProxyReloginState]) {
        lock.withLock { polls = next }
    }

    func startProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        lock.withLock { _startedIDs.append(accountID) }
        switch start {
        case .success(let value): return value
        case .failure(let error): throw error
        }
    }

    func proxyReloginState(accountID: String) async throws -> ProxyReloginState {
        let next: ProxyReloginState? = lock.withLock { polls.isEmpty ? nil : polls.removeFirst() }
        guard let next else {
            // Park: the flow stays genuinely in flight until the test acts.
            if parkAfterFirstPoll {
                try await Task.sleep(for: .seconds(60))
            }
            return ProxyReloginState(phase: "awaiting-browser")
        }
        return next
    }

    func cancelProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        lock.withLock { _cancelledIDs.append(accountID) }
        return ProxyReloginState(phase: "cancelled", cancelledUpstream: true)
    }
}

private final class BrowserStub: BrowserOpening, @unchecked Sendable {
    private let lock = NSLock()
    private var _opened: [URL] = []
    var opened: [URL] { lock.withLock { _opened } }

    func open(_ url: URL) {
        lock.withLock { _opened.append(url) }
    }
}

private struct EmptyReloginStateStub: DeckStateProviding {
    func deckState() async throws -> DeckState { DeckState(accounts: [], usage: []) }
}

/// The daemon's re-read after a successful repair: the member is healthy.
private struct HealthyStateStub: DeckStateProviding {
    func deckState() async throws -> DeckState {
        DeckState(
            accounts: [DeckAccount(
                id: "a1", provider: "claude", label: "Studio",
                enabled: true, isDefault: false,
                authState: "ok",
                proxyPool: "member",
                proxyCredential: "ok",
                proxyRelogin: ProxyReloginCapability(available: true)
            )],
            usage: []
        )
    }
}

private struct FailingReloginStateStub: DeckStateProviding {
    func deckState() async throws -> DeckState {
        throw DaemonClientError.daemonError(message: "state unavailable", status: 500)
    }
}
