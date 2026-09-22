import Foundation

// Issue #396 — the UI half of the in-app credential repair.
//
// The field incident: a pool credential expired and the only recovery was
// Tim hand-running `cliproxyapi -claude-login` in a terminal. This model is
// the reason that never has to happen again. It does NOT perform a login:
// it asks the daemon to have CLIProxyAPI start the PROXY'S OWN OAuth (#398 —
// the proxy remains the sole writer of auth files), opens the authorize page
// the proxy hands back, and then reports the proxy's own verdict until the
// flow settles.
//
// The #149/#174 discipline holds throughout: a machine with no pool, or a
// daemon that does not report the #396 fields, renders NOTHING.

/// Daemon seam for the repair; `DaemonClient` conforms, tests stub.
public protocol ProxyReloginManaging: Sendable {
    func startProxyRelogin(accountID: String) async throws -> ProxyReloginState
    func proxyReloginState(accountID: String) async throws -> ProxyReloginState
    func cancelProxyRelogin(accountID: String) async throws -> ProxyReloginState
}

extension DaemonClient: ProxyReloginManaging {}

/// Opening the provider's page is the one step that leaves the app. Behind a
/// seam so tests drive the whole flow without a browser ever appearing.
public protocol BrowserOpening: Sendable {
    func open(_ url: URL)
}

/// Pure derivations + every sentence this surface speaks, in one tested
/// place — the `ProxyPool` precedent.
public enum ProxyRelogin {
    /// The phases the daemon reports, mirrored so the UI never matches on
    /// raw strings. An unrecognized phase is treated as `idle`: a newer
    /// daemon must not strand a row in a state this build cannot leave.
    public enum Phase: String, Equatable, Sendable {
        case idle
        case starting
        case awaitingBrowser = "awaiting-browser"
        case succeeded
        case failed
        case cancelled

        public init(daemon value: String?) {
            self = Phase(rawValue: value?.lowercased() ?? "") ?? .idle
        }

        public var isSettled: Bool {
            self == .succeeded || self == .failed || self == .cancelled
        }

        public var isRunning: Bool {
            self == .starting || self == .awaitingBrowser
        }
    }

    /// Whether the proxy says this member's credential is broken. The FIX is
    /// promoted to a visible button only here; everywhere else it stays a
    /// quiet menu item, because a working account does not need a button
    /// telling it to sign in again.
    public static func credentialIsBroken(_ account: DeckAccount) -> Bool {
        account.proxyCredential?.lowercased() == "error" && !credentialIsOverloaded(account)
    }

    // MARK: - Provider overload (issue #714)
    //
    // 2026-09-20: the proxy marked codex/LoanMeld unavailable because the
    // provider answered `server_is_overloaded` — a provider-side outage, not a
    // dead refresh token — and the card said "Proxy sign-in expired". Signing
    // in again fixes nothing here, so the sentence and the promoted repair
    // are reserved for a login the proxy actually lost.

    /// Whether the proxy's `error` verdict is a provider overload or temporary
    /// unavailability rather than a lost login. Matched on the proxy's own
    /// status message; an empty detail stays a dead login (the #542 shape).
    public static func credentialIsOverloaded(_ account: DeckAccount) -> Bool {
        guard account.proxyCredential?.lowercased() == "error" else { return false }
        return detailIsProviderOverload(account.proxyCredentialDetail)
    }

    public static func detailIsProviderOverload(_ detail: String?) -> Bool {
        guard let detail = detail?.lowercased(), !detail.isEmpty else { return false }
        if detail.contains("invalid_grant") || detail.contains("refresh token") { return false }
        return detail.contains("overloaded")
            || detail.contains("service_unavailable")
            || detail.contains("try again later")
    }

    public static let overloadedText = "Provider overloaded · proxy retrying"

    /// The popover's second line for an overloaded member: what is happening
    /// and why no browser sign-in is offered.
    public static let overloadedExplanation =
        "The provider turned the proxy's requests away as overloaded. The proxy keeps retrying "
            + "on its own; signing in again would not help."

    // MARK: - Wire evidence (issue #515)
    //
    // Tim, 2026-08-18: the deck said "Insight: 7 routed requests failed in a
    // row (HTTP 401). Sign in again to restore proxy routing." while Settings
    // showed the same account green with the repair hidden in the hover-only
    // ⋯ menu. The banner reads MEASURED request outcomes (#395's blackout
    // alert); the promotion read the RECORDED credential the proxy had not
    // yet marked broken. Doctrine 0034 settles the tie: the measured
    // request-path signal is the truth, so it promotes the repair too. Both
    // surfaces now derive from these functions, which is why they cannot
    // disagree again.

    /// This account's live routed-failure streak, if the daemon reports one.
    /// A daemon that omits `memberBlackout` (skew) returns nil and nothing
    /// changes — the #149/#174 discipline.
    public static func routedFailures(
        for account: DeckAccount,
        in state: DeckState?
    ) -> MemberBlackoutAlert? {
        state?.memberBlackout?.alerts.first { $0.accountId == account.id }
    }

    /// The streak in the row's own voice — the reason the repair is promoted,
    /// stated where the repair is offered.
    public static func routedFailureText(_ alert: MemberBlackoutAlert) -> String {
        let request = alert.consecutiveFailures == 1 ? "request" : "requests"
        let status = alert.statusCode.map { " (HTTP \($0))" } ?? ""
        // Issue #537: same plain wording as the banner's statusLine.
        return "last \(alert.consecutiveFailures) \(request) failed\(status)"
    }

    /// A benched or resting member needs no sign-in repair, even if a routed
    /// failure streak remains. Signing in cannot lift either restriction.
    public static func credentialIsBroken(
        _ account: DeckAccount,
        routedFailures alert: MemberBlackoutAlert?
    ) -> Bool {
        if credentialIsBroken(account) { return true }
        // Issue #714 (CodeRabbit, PR #715): the proxy's own verdict is an
        // overload, so a routed-failure streak is the same incident and
        // must not promote a sign-in repair either.
        if credentialIsOverloaded(account) { return false }
        // Issue #539: the daemon says this member was signed in again after
        // the last failure in the streak. The streak still stands as measured
        // evidence — the banner stays up, softened — but there is nothing to
        // fix, so it promotes no repair on either surface.
        // Issue #572: an overload-class streak gets the same demotion — the
        // provider was overloaded, the credential is fine, and signing in
        // again would fix nothing.
        guard let alert, !alert.isRepairedPending, !alert.isTransient else { return false }
        let credential = account.proxyCredential?.lowercased()
        return credential != "disabled" && credential != "resting"
    }

    /// Issue #539: a settled sign-in outcome recorded BEFORE the credential
    /// was repaired is stale news. It must not tell the user to act — the
    /// live incident was an expired session's "Start it again…" sitting on a
    /// banner whose credential was already good. A newer outcome (a fresh
    /// attempt, after the repair) still speaks.
    public static func settledOutcomeIsStale(
        recordedAt: Date?,
        routedFailures alert: MemberBlackoutAlert?
    ) -> Bool {
        guard let alert, alert.isRepairedPending else { return false }
        // Fail towards SHOWING it (PR #543 review). Suppression needs positive
        // evidence that the outcome predates the repair; a daemon that sent no
        // `repairedAt`, or one this build cannot parse, is not that evidence,
        // and silently eating a sentence the user may need is the worse error.
        guard let recordedAt, let repairedAt = alert.repairedAt, let repaired = instant(repairedAt) else {
            return false
        }
        return recordedAt < repaired
    }

    /// The daemon's instants, with and without fractional seconds — the same
    /// two-formatter shape `ModelDropAlert.parseTimestamp` uses.
    static func instant(_ iso: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// The row's honest one-liner about a non-ok credential, or nil.
    public static func credentialText(for account: DeckAccount) -> String? {
        switch account.proxyCredential?.lowercased() {
        case "error":
            if credentialIsOverloaded(account) { return overloadedText }
            guard let detail = account.proxyCredentialDetail, !detail.isEmpty else {
                return "Proxy sign-in expired"
            }
            return "Proxy sign-in expired (\(detail))"
        case "disabled":
            // Benched is not broken, and signing in again would not un-bench
            // it — say what it is instead of offering the wrong remedy.
            return "Benched in the proxy pool"
        case "resting":
            guard let detail = account.proxyCredentialDetail, let retryAt = instant(detail) else {
                return "Rate limited · resting"
            }
            return "Rate limited · back at \(DateFormatter.localizedString(from: retryAt, dateStyle: .none, timeStyle: .short))"
        default:
            return nil
        }
    }

    /// What the row says about the credential once wire evidence is allowed
    /// to speak: the proxy's own sentence when it has one, otherwise the
    /// streak that the deck is already shouting about.
    public static func credentialText(
        for account: DeckAccount,
        routedFailures alert: MemberBlackoutAlert?
    ) -> String? {
        if account.proxyCredential?.lowercased() == "resting" {
            return credentialText(for: account)
        }
        // Issue #539: the Settings row speaks the same soft sentence the deck
        // banner does rather than going quiet — one daemon answer, two
        // surfaces. Text only; the repair is not promoted here either.
        if let alert, alert.isRepairedPending, !credentialIsBroken(account) {
            return alert.repairedRowLine
        }
        if let recorded = credentialText(for: account) { return recorded }
        guard let alert, credentialIsBroken(account, routedFailures: alert) else { return nil }
        return routedFailureText(alert)
    }

    /// Whether the repair is reachable at all for this account. Reachable
    /// does NOT mean the credential is broken: a user may want to re-sign a
    /// member the proxy still believes in.
    public static func isOffered(for account: DeckAccount) -> Bool {
        guard account.proxyPool?.lowercased() == "member" else { return false }
        return account.proxyRelogin != nil
    }

    public static func isAvailable(for account: DeckAccount) -> Bool {
        isOffered(for: account) && account.proxyRelogin?.available == true
    }

    /// Why the repair cannot run, in the daemon's words. Never nil when the
    /// action is offered but unavailable — an unexplained dead control is
    /// the thing this issue exists to remove.
    public static func unavailableReason(for account: DeckAccount) -> String? {
        guard isOffered(for: account), account.proxyRelogin?.available != true else { return nil }
        return account.proxyRelogin?.reason ?? unavailableFallbackText
    }

    // MARK: - Copy

    public static let actionTitle = "Fix sign-in…"
    public static let menuTitle = "Fix proxy sign-in…"

    public static let unavailableFallbackText =
        "The local proxy cannot start a sign-in right now."

    /// The disclosure before the browser opens: the surprising step is named
    /// up front, and so is the fact that ModelDeck never sees the credential.
    public static func confirmation(label: String) -> String {
        "A browser sign-in for \(label) will open. The local proxy runs the sign-in "
            + "and stores the result itself — ModelDeck never handles the credential. "
            + "Nothing changes until you finish it in the browser."
    }

    // Issue #542 — the repair names its target. On 2026-08-19 the deck said
    // "Finish the sign-in in your browser…" with a Stop beside it, and with 7
    // Claude and 4 Codex subscriptions on the deck Tim could not tell WHICH
    // browser sign-in he was finishing. These are built once, in
    // `presentation(for:routedFailures:)` and `settle`, so the banner, the
    // Settings row, and the card's popover all say the same sentence.

    /// This account's provider in display form ("Claude"), or nil when the
    /// daemon named a provider this build does not know — the sentences then
    /// drop the provider rather than guess it.
    public static func providerName(for account: DeckAccount) -> String? {
        DeckProvider.from(account.provider)?.displayName
    }

    public static func startingText(label: String, providerName: String?) -> String {
        guard let providerName else { return "Asking the proxy to start a sign-in for \(label)…" }
        return "Asking the proxy to start the \(providerName) sign-in for \(label)…"
    }

    public static func awaitingBrowserText(label: String, providerName: String?) -> String {
        guard let providerName else { return "Finish the sign-in for \(label) in your browser…" }
        return "Finish the \(providerName) sign-in for \(label) in your browser…"
    }

    public static func succeededText(label: String, providerName: String?) -> String {
        guard let providerName else {
            return "Signed in \(label) again. The proxy is using this subscription once more."
        }
        return "Signed in \(label) again. The proxy is using this \(providerName) subscription once more."
    }

    public static func cancelledText(label: String, providerName: String?) -> String {
        "Sign-in for \(target(label: label, providerName: providerName)) stopped. Nothing changed."
    }

    public static let cancelTooltip =
        "Stop the sign-in. The proxy drops it too, so nothing keeps waiting."
    public static let browserOpenFailedText =
        "The sign-in page could not be opened. Nothing is waiting — try again."

    /// The daemon always sends a sentence with a failure; this is only the
    /// floor for a daemon that somehow did not.
    public static let failedFallbackText =
        "The sign-in did not complete. Try again."

    /// The failure sentence names the subscription and then gets out of the
    /// way: the daemon's own detail is the only thing that says WHAT failed,
    /// so it rides verbatim after the target, never paraphrased.
    public static func failedText(
        detail: String?,
        label: String,
        providerName: String?
    ) -> String {
        let target = target(label: label, providerName: providerName)
        guard let detail, !detail.isEmpty else { return "\(target): \(failedFallbackText)" }
        return "\(target): \(detail)"
    }

    public static func settledText(
        phase: Phase,
        detail: String?,
        label: String,
        providerName: String?
    ) -> String? {
        switch phase {
        case .succeeded: return succeededText(label: label, providerName: providerName)
        case .cancelled: return cancelledText(label: label, providerName: providerName)
        case .failed: return failedText(detail: detail, label: label, providerName: providerName)
        default: return nil
        }
    }

    // MARK: - The card indicator (issue #542)
    //
    // Tim, 2026-09-17: a Claude account's refresh token expired, the proxy
    // marked the credential dead and stopped routing to it BEFORE any request
    // failed — so no routed-failure streak, no banner — and the card just
    // showed "100% left · ⑂ 0". Only Settings → Subscriptions said anything.
    // The card now carries the same verdict, derived from the same
    // presentation, so it cannot reach a calmer conclusion than Settings.

    /// What the deck card renders, or nil for a card that shows nothing new.
    /// The verdict is the presentation's own — the SAME one the pool banner
    /// and the Settings row read — so the card can never be calmer than
    /// they are. Benched, resting (#634), repaired-pending (#539) and
    /// transient-overload (#572) members all land on nil here, because
    /// `credentialIsBroken` already ruled them out.
    public static func cardIndicator(
        _ presentation: ProxyReloginRowPresentation?
    ) -> ProxyReloginRowPresentation? {
        guard let presentation,
              presentation.credentialIsBroken || presentation.credentialIsOverloaded
        else { return nil }
        return presentation
    }

    /// "Click AI (Claude)" — the account with its provider, which is the
    /// whole point: a roster of 11 subscriptions needs both to be findable.
    public static func target(label: String, providerName: String?) -> String {
        guard let providerName else { return label }
        return "\(label) (\(providerName))"
    }

    /// The indicator's lead phrase. A recorded `error` is the PROXY's own
    /// verdict that the sign-in expired; a routed-failure streak (#515) on a
    /// still-"ok" credential only proves it is not working, so it does not
    /// borrow the stronger claim.
    public static func indicatorLead(for account: DeckAccount) -> String {
        if credentialIsOverloaded(account) { return "Provider overloaded" }
        return credentialIsBroken(account) ? "Proxy sign-in expired" : "Proxy sign-in not working"
    }

    /// What VoiceOver hears on the card's glyph — the account, its provider,
    /// and the state, since a `key.slash` says none of the three.
    public static func indicatorAccessibilityLabel(
        for account: DeckAccount,
        presentation: ProxyReloginRowPresentation
    ) -> String {
        if case .running(let text, _) = presentation.display { return text }
        let state = presentation.credentialText ?? indicatorLead(for: account)
        return "\(target(label: account.label, providerName: providerName(for: account))): \(state)"
    }
}

/// What the row's trailing slot shows for the repair, in strict precedence
/// (the #199 rule the pool line already follows): progress → an unread
/// outcome → the armed action.
public struct ProxyReloginRowPresentation: Equatable, Sendable {
    public enum Display: Equatable, Sendable {
        /// The flow is running; `canCancel` while the proxy holds a session.
        case running(text: String, canCancel: Bool)
        case note(String)
        case error(String)
        /// The armed FIX. `prominent` when the proxy says the credential is
        /// actually broken; otherwise it stays a quiet menu-only offer.
        case action(prominent: Bool)
        /// Offered but not runnable, with the reason as help text.
        case unavailable(reason: String)
        /// Nothing actionable — the credential line, if any, stands alone.
        case quiet

        /// Issue #539: the deck's soft repaired state hides the repair
        /// controls, but never a sign-in that is actually running.
        public var isRunning: Bool {
            if case .running = self { return true }
            return false
        }
    }

    /// The credential one-liner beside the pool's own status text, or nil.
    public var credentialText: String?
    public var display: Display
    /// Issue #515: whether this member's sign-in is broken by EITHER measure —
    /// the recorded credential or the measured routed-failure streak. The row
    /// reads this instead of re-deriving from the account, so the deck banner
    /// and the Settings row can never reach opposite conclusions.
    public var credentialIsBroken: Bool
    /// Issue #714: the proxy's `error` is a provider overload, not a lost
    /// login. The card still shows the glyph; nothing promotes the repair.
    public var credentialIsOverloaded: Bool

    public init(
        credentialText: String?,
        display: Display,
        credentialIsBroken: Bool = false,
        credentialIsOverloaded: Bool = false
    ) {
        self.credentialText = credentialText
        self.display = display
        self.credentialIsOverloaded = credentialIsOverloaded
        self.credentialIsBroken = credentialIsBroken
    }
}

/// The repair's state machine (issue #396), built on the `ProxyPoolModel`
/// shape: per-account phase, decided outcomes held until dismissed, a
/// generation guard so a stale poll can never mutate a newer attempt, and a
/// fresh `GET /api/state` after every settled attempt so the restored member
/// is the daemon's truth rather than an optimistic echo.
@MainActor
public final class ProxyReloginModel: ObservableObject {
    @Published public private(set) var phases: [String: ProxyRelogin.Phase] = [:]
    @Published public private(set) var notes: [String: String] = [:]
    @Published public private(set) var errors: [String: String] = [:]

    public var onStateChanged: ((DeckState) -> Void)?

    private let manager: any ProxyReloginManaging
    private let stateProvider: any DeckStateProviding
    private let browser: any BrowserOpening
    private let pollInterval: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    private let now: @Sendable () -> Date
    private var generations: [String: Int] = [:]
    /// Issue #539: when each account's settled outcome was recorded, so an
    /// outcome older than the daemon's observed repair can be recognized as
    /// stale rather than repeated at a user with nothing left to do.
    private var outcomeAt: [String: Date] = [:]
    /// Held so a cancel can stop the local poll immediately, without waiting
    /// for the next tick.
    private(set) var tasks: [String: Task<Void, Never>] = [:]

    public init(
        manager: any ProxyReloginManaging,
        stateProvider: any DeckStateProviding,
        browser: any BrowserOpening,
        pollInterval: Duration = .seconds(2),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.manager = manager
        self.stateProvider = stateProvider
        self.browser = browser
        self.pollInterval = pollInterval
        self.sleep = sleep
        self.now = now
    }

    public func phase(for accountID: String) -> ProxyRelogin.Phase? { phases[accountID] }

    /// The row's complete repair rendering, or nil when nothing about this
    /// account's repair should appear anywhere.
    ///
    /// Issue #515: `routedFailures` is the deck's own #395 alert for this
    /// account (nil when there is none, or on a daemon that omits the block).
    /// It is the ONE input that promotes the repair on measured evidence, and
    /// the deck banner renders from this same value — one derivation, two
    /// surfaces.
    public func presentation(
        for account: DeckAccount,
        routedFailures alert: MemberBlackoutAlert? = nil
    ) -> ProxyReloginRowPresentation? {
        let phase = phases[account.id]
        let note = notes[account.id]
        let error = errors[account.id]
        let credential = ProxyRelogin.credentialText(for: account, routedFailures: alert)
        let isBroken = ProxyRelogin.credentialIsBroken(account, routedFailures: alert)
        guard ProxyRelogin.isOffered(for: account) || phase != nil || note != nil || error != nil else {
            return nil
        }
        // Issue #539: an outcome recorded before the daemon saw this member
        // signed in again is stale — the repaired state outranks it, so it is
        // not repeated at a user whose credential is already good.
        let staleOutcome = ProxyRelogin.settledOutcomeIsStale(
            recordedAt: outcomeAt[account.id],
            routedFailures: alert
        )
        let display: ProxyReloginRowPresentation.Display
        if let phase, phase.isRunning {
            // Issue #542: built HERE, once, so the banner, the Settings row
            // and the card's popover cannot grow three versions of it.
            let provider = ProxyRelogin.providerName(for: account)
            display = .running(
                text: phase == .starting
                    ? ProxyRelogin.startingText(label: account.label, providerName: provider)
                    : ProxyRelogin.awaitingBrowserText(label: account.label, providerName: provider),
                canCancel: phase == .awaitingBrowser
            )
        } else if let error, !staleOutcome {
            display = .error(error)
        } else if let note, !staleOutcome {
            display = .note(note)
        } else if account.proxyCredential?.lowercased() == "resting" {
            display = .quiet
        } else if let reason = ProxyRelogin.unavailableReason(for: account) {
            display = .unavailable(reason: reason)
        } else if ProxyRelogin.isAvailable(for: account) {
            display = .action(prominent: isBroken)
        } else if credential != nil {
            display = .quiet
        } else {
            return nil
        }
        return ProxyReloginRowPresentation(
            credentialText: credential,
            display: display,
            credentialIsBroken: isBroken,
            credentialIsOverloaded: ProxyRelogin.credentialIsOverloaded(account)
        )
    }

    /// Start the repair (AFTER the view's confirmation — the "ask each time"
    /// gate lives at the click site). Opens the authorize page the PROXY
    /// generated, then polls the proxy's own verdict until it settles.
    public func begin(account: DeckAccount) {
        guard phases[account.id] == nil else { return }
        let accountID = account.id
        phases[accountID] = .starting
        notes[accountID] = nil
        errors[accountID] = nil
        outcomeAt[accountID] = nil
        generations[accountID, default: 0] += 1
        let generation = generations[accountID]
        tasks[accountID] = Task { [weak self] in
            guard let self else { return }
            do {
                let started = try await self.manager.startProxyRelogin(accountID: accountID)
                guard self.isCurrent(accountID, generation) else { return }
                let phase = ProxyRelogin.Phase(daemon: started.phase)
                self.phases[accountID] = phase
                // The one step that leaves the app. A URL the daemon did not
                // send, or one that is not openable, is said out loud rather
                // than leaving the row spinning at a browser that never came.
                if let raw = started.url, let url = URL(string: raw), url.scheme?.lowercased() == "https" {
                    self.browser.open(url)
                } else if phase.isRunning {
                    // CodeRabbit (PR #435): no browser means nobody can ever
                    // finish this sign-in — settle the attempt terminally and
                    // have the proxy drop its own pending session, instead of
                    // polling a flow whose error the running row would hide.
                    self.phases[accountID] = nil
                    self.errors[accountID] = ProxyRelogin.browserOpenFailedText
                    self.outcomeAt[accountID] = self.now()
                    _ = try? await self.manager.cancelProxyRelogin(accountID: accountID)
                    guard self.generations[accountID] == generation else { return }
                    self.tasks[accountID] = nil
                    await self.refreshState(accountID: accountID)
                    return
                }
                if phase.isSettled {
                    self.settle(account: account, phase: phase, detail: started.detail)
                } else {
                    await self.poll(account: account, generation: generation)
                }
            } catch is CancellationError {
                return // cancel() already wrote the honest note
            } catch {
                guard self.isCurrent(accountID, generation) else { return }
                self.phases[accountID] = nil
                // 409 (no key / already running) and 502 land here with the
                // daemon's sanitized sentence.
                self.errors[accountID] = SettingsSyncModel.message(for: error)
                self.outcomeAt[accountID] = self.now()
            }
            guard self.generations[accountID] == generation else { return }
            self.tasks[accountID] = nil
            await self.refreshState(accountID: accountID)
        }
    }

    private func isCurrent(_ accountID: String, _ generation: Int?) -> Bool {
        generations[accountID] == generation && phases[accountID] != nil
    }

    /// Issue #542: the ACCOUNT rides through the flow, not just its id — the
    /// settled sentence names the subscription it belongs to.
    private func poll(account: DeckAccount, generation: Int?) async {
        let accountID = account.id
        while true {
            do { try await sleep(pollInterval) } catch { return }
            guard isCurrent(accountID, generation) else { return }
            let state: ProxyReloginState
            do {
                state = try await manager.proxyReloginState(accountID: accountID)
            } catch is CancellationError {
                return
            } catch {
                guard isCurrent(accountID, generation) else { return }
                phases[accountID] = nil
                errors[accountID] = SettingsSyncModel.message(for: error)
                outcomeAt[accountID] = now()
                return
            }
            guard isCurrent(accountID, generation) else { return }
            let phase = ProxyRelogin.Phase(daemon: state.phase)
            if phase.isSettled {
                settle(account: account, phase: phase, detail: state.detail)
                return
            }
            phases[accountID] = phase
        }
    }

    private func settle(account: DeckAccount, phase: ProxyRelogin.Phase, detail: String?) {
        let accountID = account.id
        phases[accountID] = nil
        outcomeAt[accountID] = now()
        let text = ProxyRelogin.settledText(
            phase: phase,
            detail: detail,
            label: account.label,
            providerName: ProxyRelogin.providerName(for: account)
        )
        if phase == .failed {
            errors[accountID] = text
        } else {
            notes[accountID] = text
        }
    }

    /// Stop the sign-in. The daemon asks the PROXY to drop its own pending
    /// session, so this genuinely stops the flow rather than only stopping
    /// our watching of it.
    ///
    /// Issue #542: takes the ACCOUNT, like `poll` and `settle` — the stopped
    /// sentence names the subscription it stopped.
    public func cancel(account: DeckAccount) {
        let accountID = account.id
        guard phases[accountID]?.isRunning == true else { return }
        // Invalidate BEFORE cancelling so a task already past its await
        // cannot overwrite the stopped state (the ProxyPoolModel lesson).
        generations[accountID, default: 0] += 1
        let generation = generations[accountID]
        tasks.removeValue(forKey: accountID)?.cancel()
        phases[accountID] = nil
        notes[accountID] = ProxyRelogin.cancelledText(
            label: account.label,
            providerName: ProxyRelogin.providerName(for: account)
        )
        outcomeAt[accountID] = now()
        Task { [weak self] in
            guard let self else { return }
            _ = try? await self.manager.cancelProxyRelogin(accountID: accountID)
            guard self.generations[accountID] == generation else { return }
            await self.refreshState(accountID: accountID)
        }
    }

    public func dismissOutcome(accountID: String) {
        guard phases[accountID] == nil else { return }
        notes[accountID] = nil
        errors[accountID] = nil
        outcomeAt[accountID] = nil
    }

    private var refreshGeneration = 0

    /// Internal (not private) so tests can drive overlapping refreshes — the
    /// `ProxyPoolModel.refreshState` precedent, including its M7 rule that a
    /// failed re-read is SAID rather than swallowed.
    func refreshState(accountID: String) async {
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let fresh = try await stateProvider.deckState()
            guard generation == refreshGeneration else { return }
            onStateChanged?(fresh)
        } catch {
            guard generation == refreshGeneration else { return }
            let line = ProxyPool.stateRefreshFailedText
            // Every branch here writes text the user has not seen yet, so every
            // branch re-dates the outcome (PR #543 review). The M7 rule is that
            // a failed re-read is SAID; the #539 staleness gate must not be the
            // thing that swallows it.
            if let existing = errors[accountID] {
                if !existing.contains(line) {
                    errors[accountID] = existing + " " + line
                    outcomeAt[accountID] = now()
                }
            } else if let existing = notes[accountID] {
                if !existing.contains(line) {
                    notes[accountID] = existing + " " + line
                    outcomeAt[accountID] = now()
                }
            } else {
                notes[accountID] = line
                outcomeAt[accountID] = now()
            }
        }
    }
}
