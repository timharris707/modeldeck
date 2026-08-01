import Foundation
import Observation

// Issue #204 — the UI half of the shared-across-accounts user scope (Tim
// approved direction, 2026-08-01): an opt-in Settings toggle that makes
// user-scope MCP server registrations and user memory one shared set across
// every managed Claude account. The daemon owns the entire mechanism
// (backups, section-level merge, symlinks, reversibility, crash safety);
// this model only asks for the guarded enable/disable op, renders progress,
// and relays the daemon's disclosed merge outcome calmly. Credentials,
// keychain items, and per-account settings are never shared — and never
// touched by anything here.

// MARK: - Daemon shapes

/// Merge counts from the enable op's outcome (`merged: {mcpServers,
/// memoryItems}`). Tolerant by the house policy: an unexpected shape reads
/// as zero counts rather than failing the outcome decode.
public struct SharedScopeMergedCounts: Codable, Equatable, Sendable {
    public var mcpServers: Int
    public var memoryItems: Int

    public init(mcpServers: Int = 0, memoryItems: Int = 0) {
        self.mcpServers = mcpServers
        self.memoryItems = memoryItems
    }

    private enum CodingKeys: String, CodingKey {
        case mcpServers, memoryItems
    }

    public init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init()
            return
        }
        self.init(
            mcpServers: (try? container.decodeIfPresent(Int.self, forKey: .mcpServers)) ?? 0,
            memoryItems: (try? container.decodeIfPresent(Int.self, forKey: .memoryItems)) ?? 0
        )
    }
}

/// One identical-name merge conflict the daemon resolved (newest mtime wins,
/// per the #204 direction): `name` is the conflicted registration, `winner`
/// names which account's version is now the shared one.
public struct SharedScopeConflict: Codable, Equatable, Sendable {
    public var name: String
    public var winner: String

    public init(name: String, winner: String) {
        self.name = name
        self.winner = winner
    }

    private enum CodingKeys: String, CodingKey {
        case name, winner
    }

    public init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(name: "", winner: "")
            return
        }
        self.init(
            name: (try? container.decodeIfPresent(String.self, forKey: .name)) ?? "",
            winner: (try? container.decodeIfPresent(String.self, forKey: .winner)) ?? ""
        )
    }
}

/// One item the daemon skipped during the op, with its own reason verbatim.
public struct SharedScopeSkippedItem: Codable, Equatable, Sendable {
    public var what: String
    public var reason: String

    public init(what: String, reason: String) {
        self.what = what
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case what, reason
    }

    public init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(what: "", reason: "")
            return
        }
        self.init(
            what: (try? container.decodeIfPresent(String.self, forKey: .what)) ?? "",
            reason: (try? container.decodeIfPresent(String.self, forKey: .reason)) ?? ""
        )
    }
}

/// The decided body of `POST /api/shared-scope/{enable|disable}`
/// (`{"sharedScope": {enabled, merged, conflicts, skipped}}`) and of
/// `/api/state`'s `sharedScope.lastOutcome`. Decoding is deliberately
/// shape-tolerant (the `renew`/`activation` policy): unknown outcome fields
/// are ignored, absent arrays read as empty, and an unexpected shape reads
/// as the inert disabled outcome rather than failing the caller's decode.
public struct SharedScopeOutcome: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var merged: SharedScopeMergedCounts?
    public var conflicts: [SharedScopeConflict]
    public var skipped: [SharedScopeSkippedItem]

    public init(
        enabled: Bool = false,
        merged: SharedScopeMergedCounts? = nil,
        conflicts: [SharedScopeConflict] = [],
        skipped: [SharedScopeSkippedItem] = []
    ) {
        self.enabled = enabled
        self.merged = merged
        self.conflicts = conflicts
        self.skipped = skipped
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, merged, conflicts, skipped
    }

    public init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init()
            return
        }
        self.init(
            enabled: (try? container.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false,
            merged: (try? container.decodeIfPresent(SharedScopeMergedCounts.self, forKey: .merged)) ?? nil,
            conflicts: (try? container.decodeIfPresent([SharedScopeConflict].self, forKey: .conflicts)) ?? [],
            skipped: (try? container.decodeIfPresent([SharedScopeSkippedItem].self, forKey: .skipped)) ?? []
        )
    }
}

/// `/api/state` top-level `sharedScope: {enabled, lastOutcome|null}`. The
/// WHOLE object is optional on `DeckState` for daemon-version skew (the #174
/// claudeStatusline / #196 renew decoding precedents): a pre-#204 daemon
/// omits it entirely and the Settings section renders nothing at all.
public struct SharedScopeStatus: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var lastOutcome: SharedScopeOutcome?

    public init(enabled: Bool = false, lastOutcome: SharedScopeOutcome? = nil) {
        self.enabled = enabled
        self.lastOutcome = lastOutcome
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, lastOutcome
    }

    public init(from decoder: Decoder) throws {
        // A non-object shape THROWS so `DeckState`'s lenient `try?` reads it
        // as absent — the contract: malformed reads exactly like a pre-#204
        // daemon (nil → the Settings section renders nothing), never as an
        // inert "disabled" report. Field-level tolerance stays lenient.
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            enabled: (try? container.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false,
            lastOutcome: (try? container.decodeIfPresent(SharedScopeOutcome.self, forKey: .lastOutcome)) ?? nil
        )
    }
}

// MARK: - Daemon seam

/// Seam for the guarded shared-scope op; `DaemonClient` conforms and tests
/// stub it.
public protocol SharedScopeControlling: Sendable {
    /// `POST /api/shared-scope/{enable|disable}` — NEVER the plain settings
    /// PUT: enabling runs the disclosed one-time merge (issue #204).
    func setSharedScope(enabled: Bool) async throws -> SharedScopeOutcome
}

extension DaemonClient: SharedScopeControlling {}

// MARK: - Pinned strings + outcome presentation

/// Single-source calm strings and pure derivations for the shared-scope
/// surfaces (the `AccountRenew` pattern) — the Settings section, the
/// confirmation sheets, and the inline outcome can never drift apart.
public enum SharedScope {
    public static let toggleTitle = "Share tools & memory across Claude accounts"

    /// The enable confirmation's disclosure, in house order: what will be
    /// shared, what never is, and that the one-time merge is reversible.
    public static let enableTitle = "Share tools & memory across Claude accounts?"
    public static let enableShares = "MCP server registrations and user memory become one shared set, used by every Claude account ModelDeck manages."
    public static let enableNeverShares = "Sign-ins, account credentials, and per-account settings are never shared."
    public static let enableMerge = "A one-time merge combines what each account has today. Per-account backups are kept, and turning sharing off restores them."
    public static let enableConfirm = "Share & Merge"

    public static let disableTitle = "Stop sharing tools & memory?"
    public static let disableRestores = "Each Claude account returns to its own MCP servers and memory, restored from the backups made when sharing was enabled."
    public static let disableNeverShared = "Sign-ins and account credentials were never shared and are untouched."
    public static let disableConfirm = "Stop Sharing"

    /// The calm 409 notice — another shared-scope op is already running,
    /// which is a fact to relay, never a failure.
    public static let alreadyInProgress = "A sharing change is already in progress — the result appears when it finishes."

    public static let enableProgress = "Merging shared tools & memory…"
    public static let disableProgress = "Restoring per-account tools & memory…"

    /// State-honest captions under the toggle (the #196 caption precedent:
    /// describe what is actually running, never a hypothetical).
    public static let enabledCaption = "MCP servers and user memory are shared by every Claude account. Sign-ins and credentials stay per-account."
    public static let disabledCaption = "Each Claude account keeps its own MCP servers and user memory."

    public static let toggleHelp = "Shares user-scope MCP server registrations and user memory across every Claude account ModelDeck manages. Sign-ins and credentials are never shared. Enabling runs a one-time, reversible merge."

    /// The inline outcome, rendered calmly under the toggle: a one-line
    /// headline (merged counts), one line per resolved conflict (name +
    /// which account's version won), one line per skipped item with the
    /// daemon's reason verbatim.
    public struct OutcomePresentation: Equatable, Sendable {
        public var headline: String
        public var conflictLines: [String]
        public var skippedLines: [String]

        public init(headline: String, conflictLines: [String] = [], skippedLines: [String] = []) {
            self.headline = headline
            self.conflictLines = conflictLines
            self.skippedLines = skippedLines
        }
    }

    public static func presentation(for outcome: SharedScopeOutcome) -> OutcomePresentation {
        OutcomePresentation(
            headline: headline(for: outcome),
            conflictLines: outcome.conflicts
                .filter { !$0.name.isEmpty }
                .map { conflict in
                    conflict.winner.isEmpty
                        ? "\(conflict.name) — newest version kept"
                        : "\(conflict.name) — kept \(conflict.winner)'s version"
                },
            skippedLines: outcome.skipped
                .filter { !$0.what.isEmpty }
                .map { item in
                    item.reason.isEmpty ? "Skipped \(item.what)" : "Skipped \(item.what) — \(item.reason)"
                }
        )
    }

    static func headline(for outcome: SharedScopeOutcome) -> String {
        guard outcome.enabled else {
            return "Sharing is off — each account's own MCP servers and memory are restored."
        }
        guard let merged = outcome.merged else {
            return "Sharing is on."
        }
        return "Sharing is on — merged \(count(merged.mcpServers, "MCP server")) and \(count(merged.memoryItems, "memory item"))."
    }

    static func count(_ value: Int, _ noun: String) -> String {
        value == 1 ? "1 \(noun)" : "\(value) \(noun)s"
    }
}

// MARK: - State machine

/// Enable/disable state machine (issue #204), the `AccountRenewModel` shape:
/// idle → confirming → running → finished(outcome), plus calm slots for the
/// 409 "already in progress" refusal and transport failures. State honesty
/// (the #68 echo-loop lesson applied to a toggle): the switch always renders
/// the daemon-reported `sharedScope.enabled` — never local optimism — so a
/// failed or refused op simply snaps it back to the truth.
@MainActor
public final class SharedScopeModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case running(target: Bool)
        case finished(SharedScopeOutcome)
    }

    @Published public private(set) var phase: Phase?
    /// Transport failure (daemon unreachable, old daemon without the
    /// endpoints) — the daemon's own message where it sent one.
    @Published public private(set) var errorText: String?
    /// The calm 409 notice; deliberately separate from `errorText` so it
    /// never renders in an error tone.
    @Published public private(set) var infoText: String?
    /// Non-nil while the confirmation sheet is up: the state the user asked
    /// for. Nothing is sent to the daemon until `confirm()`.
    @Published public private(set) var confirmationTarget: Bool?

    /// Fresh daemon state after a finished op; the app pushes it into
    /// `MenuBarStatusModel.apply(deckState:)` like every other mutation.
    public var onStateChanged: ((DeckState) -> Void)?

    private let controller: any SharedScopeControlling
    private let stateProvider: any DeckStateProviding

    public init(controller: any SharedScopeControlling, stateProvider: any DeckStateProviding) {
        self.controller = controller
        self.stateProvider = stateProvider
    }

    /// The toggle's rendered value: the daemon's `/api/state` report wins
    /// (it reflects what is physically reconciled); the settings document is
    /// only the fallback while no state has loaded. Local optimism never —
    /// the existing settings-echo pattern (#68).
    nonisolated public static func isEnabled(state: DeckState?, settings: DaemonSettings) -> Bool {
        state?.sharedScope?.enabled ?? settings.sharedUserScopeEnabled
    }

    public var isBusy: Bool {
        if case .running = phase { return true }
        return false
    }

    /// The running op's direction, for the progress caption; nil when idle.
    public var runningTarget: Bool? {
        if case .running(let target) = phase { return target }
        return nil
    }

    /// The toggle's setter: never mutates anything — it only raises the
    /// confirmation sheet for a genuine change (the toggle itself snaps back
    /// to the daemon value until the op confirms a new one).
    public func requestChange(to target: Bool, currentlyEnabled: Bool) {
        guard !isBusy, target != currentlyEnabled else { return }
        confirmationTarget = target
    }

    public func cancelConfirmation() {
        confirmationTarget = nil
    }

    /// The sheet's confirm action. The pending target is consumed
    /// SYNCHRONOUSLY — before this returns — because sheet dismissal echoes
    /// through the `isPresented` binding as `cancelConfirmation()`; a
    /// deferred read inside the spawned Task would find the target already
    /// cleared and silently no-op (the PR #207 review race). The op itself
    /// runs in the returned Task (tests await it; the view fires and
    /// forgets).
    @discardableResult
    public func confirmPending() -> Task<Void, Never>? {
        guard let target = confirmationTarget else { return nil }
        confirmationTarget = nil
        return Task { await self.apply(target: target) }
    }

    /// Run the enable/disable op. Client-side re-entrancy guard on top of
    /// the daemon's own 409 single-flight; a 409 that still gets through
    /// (another client's op) is relayed as the calm in-progress notice,
    /// never a failure.
    public func apply(target: Bool) async {
        guard !isBusy else { return }
        phase = .running(target: target)
        errorText = nil
        infoText = nil
        do {
            let outcome = try await controller.setSharedScope(enabled: target)
            phase = .finished(outcome)
        } catch {
            phase = nil
            if Self.isAlreadyInProgress(error) {
                infoText = SharedScope.alreadyInProgress
            } else {
                errorText = SettingsSyncModel.message(for: error)
            }
        }
        // Either way, re-read state: the toggle renders the daemon's truth,
        // and after a refusal the other op may since have finished.
        if let fresh = try? await stateProvider.deckState() {
            onStateChanged?(fresh)
        }
    }

    /// Clear a finished outcome or notice (the inline dismiss affordance).
    public func dismissOutcome() {
        guard !isBusy else { return }
        phase = nil
        errorText = nil
        infoText = nil
    }

    /// Issue #204 contract: the endpoints answer 409 while an op is already
    /// in flight — tolerated as "already in progress", never an error tone.
    static func isAlreadyInProgress(_ error: Error) -> Bool {
        switch error {
        case DaemonClientError.httpStatus(409),
             DaemonClientError.daemonError(_, 409),
             DaemonClientError.daemonCodedError(_, _, 409):
            return true
        default:
            return false
        }
    }
}
