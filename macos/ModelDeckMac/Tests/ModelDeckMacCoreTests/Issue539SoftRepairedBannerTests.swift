import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #539 — the state Tim hit twice, most recently on 2026-08-20.
//
// He repaired a pool credential with the in-app Fix sign-in, the proxy marked
// it active again, and the deck kept a RED banner up saying the last seven
// requests had failed — with an older sign-in session's "The sign-in was not
// finished in time. Start it again…" sitting beside it. He read both as "the
// sign-in didn't take" and went hunting for a different kind of sign-in.
//
// Doctrine 0034 is untouched: only a measured routed success clears the alert.
// What changes is what the surviving alert SAYS while it waits. The daemon
// decides (credential verdict ok, flip newer than the last failure); these
// tests pin the render seam that both the deck and Settings read.
//
// Placeholder identities only — this repo mirrors publicly.

private func member(
    id: String = "placeholder-account",
    proxyCredential: String? = "ok",
    proxyRelogin: ProxyReloginCapability? = ProxyReloginCapability(available: true)
) -> DeckAccount {
    DeckAccount(
        id: id, provider: "claude", label: "Placeholder Sub",
        enabled: true, isDefault: false,
        authState: "ok",
        proxyPool: "member",
        proxyCredential: proxyCredential,
        proxyRelogin: proxyRelogin
    )
}

private let repairInstant = "2026-08-20T21:05:00.000Z"

private func alert(
    failures: Int = 7,
    statusCode: Int? = 401,
    repairedPending: Bool? = nil,
    repairedAt: String? = nil
) -> MemberBlackoutAlert {
    MemberBlackoutAlert(
        accountId: "placeholder-account",
        provider: "claude",
        label: "Placeholder Sub",
        consecutiveFailures: failures,
        firstFailureAt: "2026-08-20T20:58:00.000Z",
        lastFailureAt: "2026-08-20T21:00:00.000Z",
        statusCode: statusCode,
        repairedPending: repairedPending,
        repairedAt: repairedAt
    )
}

@Suite("Post-repair soft banner (issue #539)")
@MainActor
struct Issue539SoftRepairedBannerTests {
    /// THE TRIPWIRE. Repaired-pending is a NEUTRAL one-liner with no action:
    /// nothing is broken, so nothing is offered, and the words say what the
    /// deck is waiting for instead of what the user should do.
    @Test func aRepairedMemberSoftensAndOffersNoFix() {
        let model = makeModel()
        let repaired = alert(repairedPending: true, repairedAt: repairInstant)

        #expect(repaired.isRepairedPending)
        #expect(repaired.repairedStatusLine
            == "Placeholder Sub: signed in again — waiting for the next request to confirm")
        // No instruction, no alarm word, no proxy jargon.
        #expect(!repaired.repairedStatusLine.lowercased().contains("sign in again to"))
        #expect(!repaired.repairedStatusLine.lowercased().contains("failed"))
        // The full story survives for the tooltip and VoiceOver.
        #expect(repaired.repairedDetail.contains("last 7 requests failed (HTTP 401)"))
        #expect(repaired.repairedDetail.contains("Nothing to do"))
        // #459: a deck member is a subscription, never an "account".
        #expect(!repaired.repairedDetail.lowercased().contains("account"))

        // Neither surface promotes a repair for a member with nothing to fix…
        let presentation = model.presentation(for: member(), routedFailures: repaired)
        #expect(presentation?.credentialIsBroken == false)
        #expect(presentation?.display == .action(prominent: false))
        // …and the Settings row speaks the same sentence rather than going
        // quiet: one daemon answer, two surfaces (PR #543 review).
        #expect(presentation?.credentialText == "signed in again — waiting for the next request to confirm")
        #expect(repaired.repairedStatusLine == "Placeholder Sub: \(repaired.repairedRowLine)")
    }

    /// The red state is exactly what it was before this issue.
    @Test func anUnrepairedStreakStaysRedAndPromotesTheFix() {
        let model = makeModel()
        let red = alert()
        #expect(red.isRepairedPending == false)
        #expect(red.statusLine == "Placeholder Sub: last 7 requests failed")
        let presentation = model.presentation(for: member(), routedFailures: red)
        #expect(presentation?.credentialIsBroken == true)
        #expect(presentation?.display == .action(prominent: true))
        #expect(presentation?.credentialText == "last 7 requests failed (HTTP 401)")
    }

    /// Daemon skew: a payload with no `repairedPending` decodes and behaves
    /// exactly as it did before — red, with the fix promoted.
    @Test func anOlderDaemonPayloadKeepsTheRedBehaviour() throws {
        let payload = #"""
        {
          "accounts": [],
          "usage": [],
          "memberBlackout": {
            "threshold": 3,
            "alerts": [{
              "accountId": "placeholder-account",
              "provider": "claude",
              "label": "Placeholder Sub",
              "consecutiveFailures": 7,
              "lastFailureAt": "2026-08-20T21:00:00.000Z",
              "statusCode": 401,
              "remedy": "Sign in again to restore proxy routing."
            }]
          }
        }
        """#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(payload.utf8))
        let decoded = try #require(state.memberBlackout?.alerts.first)
        #expect(decoded.repairedPending == nil)
        #expect(decoded.isRepairedPending == false)
        #expect(makeModel().presentation(for: member(), routedFailures: decoded)?.display
            == .action(prominent: true))
    }

    /// A newer daemon's soft payload decodes both additive fields.
    @Test func theSoftPayloadDecodes() throws {
        let payload = #"""
        {
          "accounts": [],
          "usage": [],
          "memberBlackout": {
            "threshold": 3,
            "alerts": [{
              "accountId": "placeholder-account",
              "provider": "claude",
              "label": "Placeholder Sub",
              "consecutiveFailures": 7,
              "lastFailureAt": "2026-08-20T21:00:00.000Z",
              "statusCode": 401,
              "repairedPending": true,
              "repairedAt": "2026-08-20T21:05:00.000Z",
              "remedy": "Sign in again to restore proxy routing."
            }]
          }
        }
        """#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(payload.utf8))
        let decoded = try #require(state.memberBlackout?.alerts.first)
        #expect(decoded.isRepairedPending)
        #expect(decoded.repairedAt == "2026-08-20T21:05:00.000Z")
    }

    /// THE SECOND TRIPWIRE (Tim's added acceptance criterion): a settled
    /// sign-in outcome from BEFORE the repair must not tell the user to act.
    @Test func aStaleTimeoutOutcomeIsOutrankedByTheRepair() async throws {
        let expired = "The sign-in was not finished in time. Start it again when you are ready to complete it in the browser."
        let beforeRepair = try #require(ProxyRelogin.instant("2026-08-20T21:01:00.000Z"))
        let afterRepair = try #require(ProxyRelogin.instant("2026-08-20T21:09:00.000Z"))
        let repaired = alert(repairedPending: true, repairedAt: repairInstant)

        #expect(ProxyRelogin.settledOutcomeIsStale(recordedAt: beforeRepair, routedFailures: repaired))
        // A NEW attempt's outcome, recorded after the repair, still speaks.
        #expect(!ProxyRelogin.settledOutcomeIsStale(recordedAt: afterRepair, routedFailures: repaired))
        // Nothing is suppressed while the alert is still red.
        #expect(!ProxyRelogin.settledOutcomeIsStale(recordedAt: beforeRepair, routedFailures: alert()))
        #expect(!ProxyRelogin.settledOutcomeIsStale(recordedAt: beforeRepair, routedFailures: nil))

        // End to end through the real flow: an attempt that timed out BEFORE
        // the repair leaves its sentence behind, and the soft state outranks
        // it — this is the sentence Tim was told to act on.
        let stale = makeModel(failingWith: expired, now: { beforeRepair })
        let account = member()
        stale.begin(account: account)
        await stale.tasks[account.id]?.value
        // Issue #542: named target, daemon sentence verbatim after it.
        #expect(stale.errors[account.id] == "Placeholder Sub (Claude): \(expired)")
        #expect(stale.presentation(for: account, routedFailures: repaired)?.display
            == .action(prominent: false))
        // …while an unrepaired streak still shows it.
        #expect(stale.presentation(for: account, routedFailures: alert())?.display
            == .error("Placeholder Sub (Claude): \(expired)"))

        // An outcome from AFTER the repair is real news and is not suppressed.
        let unreachable = "CLIProxyAPI did not answer. Make sure the proxy is running, then try again."
        let fresh = makeModel(failingWith: unreachable, now: { afterRepair })
        fresh.begin(account: account)
        await fresh.tasks[account.id]?.value
        #expect(fresh.presentation(for: account, routedFailures: repaired)?.display
            == .error("Placeholder Sub (Claude): \(unreachable)"))
    }

    /// A sign-in that is actually RUNNING still shows its progress and its
    /// Stop in the soft state — the gate hides the offer to fix, not a flow in
    /// flight. Behavioural, through the same presentation the banner reads, so
    /// deleting the view's gate cannot leave this suite green on greps alone
    /// (PR #543 review).
    @Test func aRunningSignInStillSpeaksWhileRepairedPending() async throws {
        let model = makeModel()
        let account = member()
        let repaired = alert(repairedPending: true, repairedAt: repairInstant)

        // begin() sets the phase synchronously; the task cannot run until this
        // MainActor test awaits, so the row is observed mid-flight.
        model.begin(account: account)
        let starting = model.presentation(for: account, routedFailures: repaired)
        #expect(starting?.display == .running(
            text: ProxyRelogin.startingText(label: account.label, providerName: "Claude"),
            canCancel: false
        ))
        #expect(starting?.display.isRunning == true)
        // And the settled soft state is NOT running, so the gate has two sides.
        model.tasks[account.id]?.cancel()
        #expect(makeModel().presentation(for: account, routedFailures: repaired)?
            .display.isRunning == false)
    }

    /// The same gate at the phase that actually carries a control: awaiting the
    /// browser, where the row offers STOP. A soft banner must still be able to
    /// stop a sign-in it is not offering to start (CodeRabbit, PR #543).
    @Test func aCancellableSignInKeepsItsStopWhileRepairedPending() async throws {
        let clock = TestClock(try #require(ProxyRelogin.instant("2026-08-20T21:30:00.000Z")))
        let model = makeModel(awaitingBrowser: true, now: { clock.now })
        let account = member()
        let repaired = alert(repairedPending: true, repairedAt: repairInstant)

        model.begin(account: account)
        // The stub's poll never answers, so the flow parks in the one running
        // phase that can be stopped instead of spinning through it.
        var spins = 0
        while model.phase(for: account.id) != .awaitingBrowser, spins < 1_000 {
            await Task.yield()
            spins += 1
        }
        #expect(model.phase(for: account.id) == .awaitingBrowser)

        let waiting = model.presentation(for: account, routedFailures: repaired)
        #expect(waiting?.display == .running(
            text: ProxyRelogin.awaitingBrowserText(label: account.label, providerName: "Claude"),
            canCancel: true
        ))
        // Still no offer to FIX — there is nothing to fix; only the running
        // flow speaks.
        #expect(waiting?.credentialIsBroken == false)

        model.cancel(account: account)
        #expect(model.phase(for: account.id) == nil)
        #expect(model.tasks[account.id] == nil)
        #expect(model.notes[account.id]
            == ProxyRelogin.cancelledText(label: account.label, providerName: "Claude"))
        // The cancellation is news from AFTER the repair, so the soft state
        // does not swallow it.
        #expect(model.presentation(for: account, routedFailures: repaired)?.display
            == .note(ProxyRelogin.cancelledText(label: account.label, providerName: "Claude")))
    }

    /// Issue #539 must not swallow news the user has not seen. A failed state
    /// re-read appended to an older outcome re-dates it, so the M7 rule
    /// ("a failed re-read is SAID") survives the staleness gate.
    @Test func anAppendedRefreshFailureIsNotSwallowedByTheRepair() async throws {
        let expired = "The sign-in was not finished in time. Start it again when you are ready to complete it in the browser."
        let beforeRepair = try #require(ProxyRelogin.instant("2026-08-20T21:01:00.000Z"))
        let afterRepair = try #require(ProxyRelogin.instant("2026-08-20T21:09:00.000Z"))
        let repaired = alert(repairedPending: true, repairedAt: repairInstant)
        let account = member()

        // The outcome lands before the repair…
        let clock = TestClock(beforeRepair)
        let refreshFails = StubGate()
        let model = makeModel(failingWith: expired, refreshFails: refreshFails, now: { clock.now })
        model.begin(account: account)
        await model.tasks[account.id]?.value
        #expect(model.errors[account.id] == "Placeholder Sub (Claude): \(expired)")
        // …and a state re-read that fails AFTER it appends its own line.
        clock.set(afterRepair)
        refreshFails.turnOn()
        await model.refreshState(accountID: account.id)

        let text = try #require(model.errors[account.id])
        #expect(text.contains(ProxyPool.stateRefreshFailedText))
        #expect(model.presentation(for: account, routedFailures: repaired)?.display == .error(text))
    }

    /// Suppression needs positive evidence. A repairedPending alert with no
    /// usable `repairedAt` shows the outcome rather than eating it.
    @Test func anUnparseableRepairInstantShowsTheOutcomeAnyway() throws {
        let recordedAt = try #require(ProxyRelogin.instant("2026-08-20T21:01:00.000Z"))
        for broken in [nil, "", "not-a-timestamp"] {
            let odd = alert(repairedPending: true, repairedAt: broken)
            #expect(!ProxyRelogin.settledOutcomeIsStale(recordedAt: recordedAt, routedFailures: odd))
        }
        // No outcome at all is nothing to suppress either.
        #expect(!ProxyRelogin.settledOutcomeIsStale(
            recordedAt: nil,
            routedFailures: alert(repairedPending: true, repairedAt: repairInstant)
        ))
    }

    @Test func theDeckBannerRendersTheSoftStateWithoutAnAction() throws {
        let source = try viewSource("Sources/ModelDeckMac/DeckPopoverView.swift")
        // One line, restyled — not a second row and not a second banner.
        #expect(source.contains("let repaired = alert.isRepairedPending"))
        #expect(source.contains(#"?? (repaired ? alert.repairedStatusLine : "\(alert.statusLine)\(httpStatus)")"#))
        // Issue #572 widened the quiet gate: resting OR repaired OR transient, one line.
        #expect(source.contains("let quiet = restingText != nil || repaired || alert.isTransient"))
        #expect(source.contains("foregroundStyle(quiet ? Color.secondary : Color.red)"))
        #expect(source.contains(".lineLimit(1)"))
        // The action disappears in the quiet states; a running sign-in does not.
        #expect(source.contains("if !quiet || relogin?.display.isRunning == true {"))
        // VoiceOver and the tooltip keep the whole story.
        #expect(source.contains("alert.repairedDetail"))
        #expect(source.contains("Pool alert. \\(message)"))
    }
}

// MARK: - Helpers

@MainActor
private func makeModel(
    failingWith detail: String? = nil,
    refreshFails: StubGate? = nil,
    awaitingBrowser: Bool = false,
    now: @escaping @Sendable () -> Date = { Date() }
) -> ProxyReloginModel {
    ProxyReloginModel(
        manager: SilentStub(failureDetail: detail, awaitingBrowser: awaitingBrowser),
        stateProvider: SilentStub(refreshFails: refreshFails),
        browser: SilentStub(),
        pollInterval: .zero,
        sleep: { _ in },
        now: now
    )
}

private struct StubRefreshFailure: Error {}

/// A switch the test flips mid-flight, across the model's Sendable seam.
private final class StubGate: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isOn: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func turnOn() {
        lock.lock()
        value = true
        lock.unlock()
    }
}

/// A clock the test moves by hand, across the model's Sendable seam.
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ value: Date) { self.value = value }

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ next: Date) {
        lock.lock()
        value = next
        lock.unlock()
    }
}

/// No network, no browser, no daemon — these tests exercise derivations, one
/// settled failure the model records the way a real timeout does, and one
/// failed state re-read.
private struct SilentStub: ProxyReloginManaging, DeckStateProviding, BrowserOpening {
    var failureDetail: String?
    var refreshFails: StubGate?
    var awaitingBrowser = false

    func startProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        if awaitingBrowser {
            // The authorize page the PROXY built — opened by a stub browser
            // that goes nowhere.
            return ProxyReloginState(phase: "awaiting-browser", url: "https://provider.invalid/authorize")
        }
        guard let failureDetail else { return ProxyReloginState(phase: "idle") }
        return ProxyReloginState(phase: "failed", detail: failureDetail)
    }

    func proxyReloginState(accountID: String) async throws -> ProxyReloginState {
        // A poll that never answers parks the flow in `awaiting-browser` — the
        // real state of a sign-in nobody has finished in the browser yet.
        // Cancellation is what ends it, which is exactly what the test drives.
        if awaitingBrowser { try await Task.sleep(for: .seconds(3_600)) }
        return ProxyReloginState(phase: "idle")
    }

    func cancelProxyRelogin(accountID: String) async throws -> ProxyReloginState {
        ProxyReloginState(phase: "cancelled")
    }

    func deckState() async throws -> DeckState {
        if refreshFails?.isOn == true { throw StubRefreshFailure() }
        return DeckState(accounts: [], usage: [])
    }

    func open(_ url: URL) {}
}

/// The view's CODE, with comment lines removed (PR #543 review): a source grep
/// that matches a commented-out line pins nothing, and would have stayed green
/// through a deleted gate.
private func viewSource(_ relativePath: String) throws -> String {
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let text = try String(
        contentsOf: packageRoot.appendingPathComponent(relativePath),
        encoding: .utf8
    )
    return text
        .split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        .joined(separator: "\n")
}
