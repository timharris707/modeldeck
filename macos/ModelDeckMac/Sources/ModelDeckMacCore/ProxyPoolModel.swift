import Foundation
import Observation

// Issue #279 — the UI half of proxy pool management. Two independent
// per-account dimensions (Tim's model, never conflated): POOL MEMBERSHIP
// (the credential serves pooled traffic) and SESSION ROUTING (the profile's
// own sessions go through the proxy). The daemon owns every mutation; this
// model asks, renders progress, and relays decided outcomes calmly — the
// AccountRenewModel / AccountSignInModel presentation pattern, one shared
// instance so Settings and any future surface can never diverge.
//
// The #149/#174 discipline end to end: on a machine without the proxy the
// daemon omits `proxyPool` entirely and `presentation(for:)` returns nil —
// the UI renders NOTHING anywhere.

/// Daemon seam for the proxy-pool ops; `DaemonClient` conforms, tests stub.
public protocol ProxyPoolManaging: Sendable {
    /// `POST /api/accounts/:id/proxy-pool/join`.
    func joinProxyPool(accountID: String) async throws -> ProxyPoolJoin
    /// `POST /api/accounts/:id/proxy-routing/{wire|unwire}`.
    func setProxyRouting(accountID: String, enabled: Bool) async throws -> ProxyRoutingState
}

extension DaemonClient: ProxyPoolManaging {}

/// Pure derivations + single-source strings for the proxy pool surfaces.
/// Every sentence a confirmation dialog speaks lives here, tested — Tim's
/// "ask each time" rule means these are product copy, not view scratch.
public enum ProxyPool {
    /// The row's quiet status text, or nil when the daemon reported no pool
    /// on this machine (render nothing — the #149/#174 discipline).
    /// Membership leads; the routing dimension follows for Claude accounts
    /// (the daemon reports routing for Claude only).
    public static func statusText(for account: DeckAccount) -> String? {
        guard let pool = account.proxyPool?.lowercased(),
              pool == "member" || pool == "absent" else { return nil }
        guard pool == "member" else {
            // "Not in pool" plain, per the issue's enumerated strings: for an
            // account the proxy doesn't have, "not routed" is the expected
            // half of the same fact and adding it is noise. Routed-but-absent
            // is NOT expected, though — that combination is exactly the kind
            // of setup-order accident #279 exists to surface, so it is said.
            return account.proxyRouted == true ? "Not in pool · routed" : "Not in pool"
        }
        guard let routed = account.proxyRouted else { return "In pool" }
        return "In pool · \(routed ? "routed" : "not routed")"
    }

    /// The row's single quiet action, if any: join when absent from the
    /// pool; route when a member Claude account's own sessions don't go
    /// through the proxy yet. Never both at once — join is the prerequisite
    /// story, and a row with two buttons stops being quiet.
    public enum Action: Equatable, Sendable {
        case join
        case route
    }

    public static func action(for account: DeckAccount) -> Action? {
        guard let pool = account.proxyPool?.lowercased() else { return nil }
        if pool == "absent" { return .join }
        guard pool == "member" else { return nil }
        if account.provider == "claude", account.proxyRouted == false { return .route }
        return nil
    }

    /// Whether the row's ⋯ menu offers the quiet unroute item — routed
    /// Claude accounts only (routing is the reversible dimension the user
    /// may want back off; leaving the pool is not ModelDeck's operation).
    public static func offersUnroute(for account: DeckAccount) -> Bool {
        // CodeRabbit (PR #285): the SAME recognized-pool gate `statusText`
        // and `action` use. A non-nil check alone let an unknown future
        // value ("quarantined") offer the item while the line itself
        // rendered nothing.
        // Lowercased like statusText/action (CodeRabbit, PR #285): a
        // "Member" from a future daemon must gate identically everywhere.
        guard let pool = account.proxyPool?.lowercased(), pool == "member" || pool == "absent" else { return false }
        guard account.provider == "claude" else { return false }
        // Adversarial review M4: `proxyRouted` is presence-only daemon-side
        // (ANY `ANTHROPIC_BASE_URL`), so keying the offer off it invited a
        // corporate-gateway profile to "Stop routing sessions…" — and taking
        // that offer deletes the user's own config. When the daemon reports
        // the loopback-verified `cliproxyRouted`, that fact decides; the
        // presence-only fallback applies ONLY when the field is absent (an
        // older daemon that cannot tell the two apart).
        if let cliproxyRouted = account.cliproxyRouted { return cliproxyRouted }
        return account.proxyRouted == true
    }

    // MARK: - Confirmation sentences (Tim: "ask each time")

    /// One plain sentence of what will happen, per action. Join names the
    /// browser sign-in explicitly — the surprising step is the disclosure.
    public static func joinConfirmation(label: String) -> String {
        "A browser sign-in for \(label) will open so the proxy can add this "
            + "account to its pool. Nothing changes until that sign-in completes."
    }

    public static func routeConfirmation(label: String) -> String {
        "New \(label) sessions will go through the local proxy. "
            + "Running sessions are never touched, and this is reversible here."
    }

    public static func unrouteConfirmation(label: String) -> String {
        "New \(label) sessions will stop going through the local proxy and use "
            + "the account directly again. Running sessions are never touched."
    }

    // MARK: - Progress + outcome copy

    public static let joinWaitingText = "Waiting for browser sign-in…"
    public static let routingProgressText = "Updating session routing…"
    /// Honest cancel-wait outcome: the daemon keeps watching server-side, so
    /// a finished sign-in still lands on its own — say exactly that.
    /// The cancel control's forward-looking tooltip. Distinct from
    /// `joinWaitStoppedText`, which reports what ALREADY happened
    /// (CodeRabbit, PR #285) — a button's help text must describe the
    /// action it is about to take.
    public static let joinWaitStopTooltip =
        "Stop waiting here. A sign-in you finish in the browser still lands on its own."

    public static let joinWaitStoppedText =
        "Stopped waiting. If you finished the sign-in, the account joins the pool on its own."

    /// Adversarial review M7: the mandatory post-mutation re-read failed, so
    /// the row may keep rendering pre-mutation state. Said out loud on the
    /// existing note/error line — never dropped silently.
    public static let stateRefreshFailedText =
        "State refresh failed — the deck may lag until the next auto-refresh."

    public static func joinOutcomeText(_ join: ProxyPoolJoin) -> String {
        if join.alreadyMember == true { return "Already in the proxy pool." }
        if join.proxyPool == "member" {
            return "Added to the proxy pool — a routing weight arrives with the next rebalance."
        }
        // CodeRabbit (PR #285): a 200 that names NO membership must not be
        // reported as success. Decoding is shape-tolerant by policy, so an
        // older or changed daemon lands here — say what is actually known
        // rather than claiming a pool join that may not have happened.
        return "Sign-in finished, but the pool has not confirmed membership yet."
    }

    // MARK: - Tooltips

    /// Issue #279: the deck ⑂ badge's absent state.
    public static let notInPoolTooltip = "Not in the proxy pool"
}

/// Everything a Settings row needs to render its proxy line: derived by
/// `ProxyPoolModel.presentation(for:)`, plain values so the view stays dumb.
public struct ProxyPoolRowPresentation: Equatable, Sendable {
    /// The ONE thing the line's trailing slot shows right now, in strict
    /// precedence — the #199 rule: progress, then an unread outcome/error,
    /// and only then the armed action.
    public enum Display: Equatable, Sendable {
        /// The join is in flight; the browser holds the next step.
        case joinWaiting
        /// A routing write is in flight.
        case routing
        /// A finished outcome (join success, cancelled wait) until dismissed.
        case note(String)
        /// A daemon refusal/failure (its sanitized message verbatim).
        case error(String)
        /// The armed quiet action, if the account earns one.
        case action(ProxyPool.Action)
        /// Status line only — nothing actionable in the trailing slot.
        case quiet
    }

    /// "In pool · routed" / "In pool · not routed" / "Not in pool" (+ the
    /// membership-only form for Codex).
    public var statusText: String
    public var display: Display
    /// Whether the ⋯ menu offers "Stop routing sessions…".
    public var offersUnroute: Bool

    public init(statusText: String, display: Display, offersUnroute: Bool) {
        self.statusText = statusText
        self.display = display
        self.offersUnroute = offersUnroute
    }
}

/// Proxy pool state machine (issue #279), the `AccountRenewModel` shape:
/// per-account phases, decided outcomes held until dismissed, and a fresh
/// `GET /api/state` after every settled attempt so the status line renders
/// the daemon's truth — a joined account simply reads "In pool", which IS
/// the calm feedback.
@MainActor
public final class ProxyPoolModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case joining
        case routing
    }

    @Published public private(set) var phases: [String: Phase] = [:]
    /// Calm informational outcomes (join success, cancelled wait).
    @Published public private(set) var notes: [String: String] = [:]
    /// Daemon refusals/failures, verbatim.
    @Published public private(set) var errors: [String: String] = [:]

    /// Fresh daemon state after a settled attempt; the app pushes it into
    /// `MenuBarStatusModel.apply(deckState:)` like every other mutation.
    public var onStateChanged: ((DeckState) -> Void)?

    private let manager: any ProxyPoolManaging
    private let stateProvider: any DeckStateProviding
    /// The in-flight join Task per account — held so "Cancel" can stop
    /// WAITING honestly (the daemon's watch continues server-side; the
    /// note text says so).
    /// Internal (not public) so tests can await a join instead of polling —
    /// the wait is the whole point of this state machine.
    private(set) var joinTasks: [String: Task<Void, Never>] = [:]

    public init(manager: any ProxyPoolManaging, stateProvider: any DeckStateProviding) {
        self.manager = manager
        self.stateProvider = stateProvider
    }

    public func phase(for accountID: String) -> Phase? { phases[accountID] }

    /// The row's complete proxy rendering state; nil when the daemon
    /// reported no pool on this machine AND no attempt state is held (a
    /// late failure note must still answer even if the pool key flickers).
    public func presentation(for account: DeckAccount) -> ProxyPoolRowPresentation? {
        let status = ProxyPool.statusText(for: account)
        let phase = phases[account.id]
        let note = notes[account.id]
        let error = errors[account.id]
        guard status != nil || phase != nil || note != nil || error != nil else { return nil }
        let display: ProxyPoolRowPresentation.Display
        switch phase {
        case .joining: display = .joinWaiting
        case .routing: display = .routing
        case nil:
            if let error { display = .error(error) }
            else if let note { display = .note(note) }
            else if let action = ProxyPool.action(for: account) { display = .action(action) }
            else { display = .quiet }
        }
        return ProxyPoolRowPresentation(
            statusText: status ?? "",
            display: display,
            offersUnroute: phase == nil && ProxyPool.offersUnroute(for: account)
        )
    }

    /// Start the join for this account (AFTER the view's confirmation —
    /// Tim's "ask each time" gate lives at the click site). Owns the Task so
    /// `cancelJoinWait` can stop waiting.
    public func beginJoin(account: DeckAccount) {
        guard phases[account.id] == nil else { return }
        phases[account.id] = .joining
        notes[account.id] = nil
        errors[account.id] = nil
        let accountID = account.id
        // CodeRabbit (PR #285): a per-attempt generation. Phase alone was not
        // enough — stop waiting, start a SECOND join, and the first task can
        // still resume (its await had already returned), see the new
        // attempt's `.joining`, and overwrite its note/error and null its
        // task handle. The captured generation makes every mutation belong
        // to the attempt that started it.
        joinGenerations[accountID, default: 0] += 1
        let generation = joinGenerations[accountID]
        joinTasks[accountID] = Task { [weak self] in
            guard let self else { return }
            do {
                let join = try await self.manager.joinProxyPool(accountID: accountID)
                guard self.joinGenerations[accountID] == generation,
                      self.phases[accountID] == .joining else { return }
                self.phases[accountID] = nil
                self.notes[accountID] = ProxyPool.joinOutcomeText(join)
            } catch is CancellationError {
                return // cancelJoinWait already wrote the honest note
            } catch {
                guard self.joinGenerations[accountID] == generation,
                      self.phases[accountID] == .joining else { return }
                self.phases[accountID] = nil
                // 409/502/504 land here with the daemon's sanitized message.
                self.errors[accountID] = SettingsSyncModel.message(for: error)
            }
            guard self.joinGenerations[accountID] == generation else { return }
            self.joinTasks[accountID] = nil
            await self.refreshState(accountID: accountID)
        }
    }

    /// Per-attempt generation, bumped on every begin and every cancel, so a
    /// stale task can never mutate a newer attempt (CodeRabbit, PR #285).
    private var joinGenerations: [String: Int] = [:]

    /// Stop WAITING on an in-flight join. Honest by design: the daemon's
    /// bounded watch continues server-side, so the note says a completed
    /// sign-in still lands on its own — this never claims to abort OAuth.
    public func cancelJoinWait(accountID: String) {
        guard phases[accountID] == .joining else { return }
        // Invalidate BEFORE cancelling so a task already past its await
        // cannot win the race and write over the stopped state.
        joinGenerations[accountID, default: 0] += 1
        joinTasks.removeValue(forKey: accountID)?.cancel()
        phases[accountID] = nil
        notes[accountID] = ProxyPool.joinWaitStoppedText
    }

    /// Wire (or unwire) session routing for this account, after the view's
    /// confirmation. The daemon refuses with 409 while a renewal/activation
    /// is in flight; the message renders verbatim.
    public func setRouting(account: DeckAccount, enabled: Bool) async {
        guard phases[account.id] == nil else { return }
        phases[account.id] = .routing
        notes[account.id] = nil
        errors[account.id] = nil
        do {
            _ = try await manager.setProxyRouting(accountID: account.id, enabled: enabled)
            phases[account.id] = nil
        } catch {
            phases[account.id] = nil
            errors[account.id] = SettingsSyncModel.message(for: error)
        }
        // Either way, re-read state: the status line renders the daemon's
        // re-read truth (routed flags), never an optimistic echo.
        await refreshState(accountID: account.id)
    }

    /// Clear a finished note or error (the line's dismiss affordance).
    public func dismissOutcome(accountID: String) {
        guard phases[accountID] == nil else { return }
        notes[accountID] = nil
        errors[accountID] = nil
    }

    /// Post-mutation refresh generation (adversarial review M6): captured
    /// before the await so an older attempt's late response can never
    /// overwrite state a newer attempt already applied.
    private var refreshGeneration = 0

    /// Internal (not private) so tests can drive overlapping refreshes —
    /// the `joinTasks` precedent.
    func refreshState(accountID: String) async {
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let fresh = try await stateProvider.deckState()
            guard generation == refreshGeneration else { return }
            onStateChanged?(fresh)
        } catch {
            guard generation == refreshGeneration else { return }
            // Adversarial review M7: `try?` dropped this failure and the row
            // contradicted the daemon until the next auto-refresh. Ride the
            // row's existing note/error line — an unread error outranks
            // notes in `presentation`, so append to whichever renders.
            let line = ProxyPool.stateRefreshFailedText
            if let existing = errors[accountID] {
                if !existing.contains(line) { errors[accountID] = existing + " " + line }
            } else if let existing = notes[accountID] {
                if !existing.contains(line) { notes[accountID] = existing + " " + line }
            } else {
                notes[accountID] = line
            }
        }
    }
}
