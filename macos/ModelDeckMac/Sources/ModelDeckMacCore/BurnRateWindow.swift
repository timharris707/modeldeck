import Foundation

// Issue #244 — burst-aware pace: the Availability Health engine's measured
// pace is a 7-day trailing average, which structurally cannot see an ultra
// run burning ~7× that rate (Tim, live, 2026-08-04: pool visibly draining
// while the verdict sat far-right GREEN). This window derives "today's
// rate" — a short-window burn rate — entirely in the app, from the same
// fresh /api/state snapshots the deck already fetches. NO daemon changes;
// no new polling.
//
// Design:
// - Samples are (provider, accountId) → (tier-weighted remaining points,
//   observedAt), appended only when the snapshot's observedAt is strictly
//   newer than the last sample for that account — a refresh that returns
//   the same provider observation twice records nothing.
// - The window holds the last `windowSpan` (~3 h) of samples, pruned by
//   age on every record.
//
//   Issue #260 REVERSES the original "persistence across relaunches is
//   deliberately NOT provided" decision. Tim, 2026-08-05: the chip sat
//   YELLOW all day on a measured ~13,500 pts/day Fable burn (≈7× this
//   deck's degrade threshold), he installed v0.3.20, and the verdict
//   snapped to GREEN the moment the app relaunched — not because anything
//   improved, but because the window was destroyed and `burstRate` went
//   nil. "Refills within a few refreshes" is not honest degradation when
//   the gap displays an ALL-CLEAR, and #241's self-announcing updates
//   made the app relaunch itself on every release, so the blind window
//   now lands on every upgrade. Samples are therefore persisted and
//   restored, pruned by the same age rule so a long-closed app resumes
//   cold rather than resurrecting stale evidence.
// - Reset handling: an interval where an account's remaining INCREASED
//   means a weekly reset crossed it. That interval is dropped entirely —
//   neither its points nor its time count — so a reset can never read as
//   negative burn and can never dilute the measured rate.
// - The pool rate is the SUM of per-account rates (each account's burned
//   points over its own usable elapsed time), matching the engine's
//   pool-wide points/day unit. Summing per-account rates keeps one
//   account's sparse sampling from diluting another's dense burn.
//
// Everything is a pure value type over injected `now` — no clocks, no I/O
// — so the whole window is directly unit testable.

/// Rolling short-window store of per-account remaining-points samples,
/// yielding the current burn rate ("today's rate") per provider.
public struct BurnRateWindow: Equatable, Sendable {
    /// One observation of one account's tier-weighted remaining points.
    public struct Sample: Equatable, Sendable {
        public var remainingPoints: Double
        public var observedAt: Date
        /// The account's next known reset AT OBSERVATION TIME (adversarial
        /// review, finding 3): if this timestamp falls inside the gap to
        /// the NEXT sample, a reset crossed the gap even when the net
        /// remaining still dropped — the naive delta would then hide a
        /// full pool's worth of burn. Such intervals are dropped.
        public var resetsAt: Date?

        public init(remainingPoints: Double, observedAt: Date, resetsAt: Date? = nil) {
            self.remainingPoints = remainingPoints
            self.observedAt = observedAt
            self.resetsAt = resetsAt
        }
    }

    private struct Key: Hashable, Sendable {
        var provider: DeckProvider
        var accountId: String

        /// Flat string form for the persisted dictionary (issue #260).
        /// Account ids are store-generated UUIDs, so "<provider>|<id>"
        /// round-trips unambiguously; anything unparseable is dropped on
        /// restore rather than guessed.
        var storageKey: String { "\(provider.rawValue)|\(accountId)" }

        init(provider: DeckProvider, accountId: String) {
            self.provider = provider
            self.accountId = accountId
        }

        init?(storageKey: String) {
            guard let separator = storageKey.firstIndex(of: "|") else { return nil }
            guard let provider = DeckProvider(rawValue: String(storageKey[..<separator])) else {
                return nil
            }
            let id = String(storageKey[storageKey.index(after: separator)...])
            guard !id.isEmpty else { return nil }
            self.init(provider: provider, accountId: id)
        }
    }

    /// How much history the window keeps (issue's 2–4 h sketch, midpoint).
    public static let windowSpan: TimeInterval = 3 * 3600
    /// Below this much observed span the window is INACTIVE — a cold-start
    /// window must never fabricate a rate from one or two samples. The
    /// span is measured over samples that PARTICIPATE IN USABLE INTERVALS
    /// (adversarial review, finding 1): a lone stale sample with no pair
    /// must never prop the gate open for another account's five-minute
    /// pair — that would extrapolate ~288× from minutes of evidence.
    public static let minimumActiveSpan: TimeInterval = 30 * 60
    /// Observations stamped up to this far ahead of this process's clock
    /// are ordinary jitter and kept as-is; anything further is clamped to
    /// `now` rather than discarded (adversarial review, finding 5): a
    /// clock-skewed daemon must not permanently disable the feature.
    public static let futureTolerance: TimeInterval = 60

    private var series: [Key: [Sample]] = [:]

    public init() {}

    /// Records one fresh deck state: for every enabled account whose
    /// driver-scope snapshot carries a remaining % and a parseable
    /// observedAt, appends a tier-weighted sample (strictly-newer
    /// observations only), then prunes everything older than `windowSpan`.
    ///
    /// No staleness or auth gating here: a stale snapshot repeats its old
    /// observedAt and is deduplicated; a broken account simply stops
    /// producing new observations and its samples age out. The engine's
    /// pool builder stays the sole authority on who is scored.
    public mutating func record(state: DeckState, now: Date) {
        let snapshotsByAccount = Dictionary(grouping: state.usage, by: \.accountId)
        // CodeRabbit (PR #259), a bug PERSISTENCE created: before #260 a
        // relaunch cleared everything, so a removed or disabled account's
        // samples died with the process. Now they are restored, and
        // `burstRate` sums every retained series for the provider — so a
        // deleted high-burn account could keep the verdict degraded for up
        // to the full 3h window. Live keys are collected from the state
        // itself and anything else is dropped.
        var live: Set<Key> = []
        for account in state.accounts where account.enabled {
            guard let provider = DeckProvider.from(account.provider) else { continue }
            live.insert(Key(provider: provider, accountId: account.id))
            let rows = snapshotsByAccount[account.id] ?? []
            guard let snapshot = AvailabilityHealthEngine.driverSnapshot(
                for: provider, in: rows
            ) else { continue }
            let remaining = snapshot.remainingPercent
                ?? snapshot.usedPercent.map { 100 - $0 }
            guard let remaining,
                  let observedRaw = DeckDateParsing.date(from: snapshot.observedAt)
            else { continue }
            // Finding 5: beyond the jitter tolerance, a future-dated
            // observation is daemon clock skew — clamp to now so the
            // window keeps working instead of silently discarding forever.
            let observed = observedRaw > now.addingTimeInterval(Self.futureTolerance)
                ? now
                : observedRaw
            let key = Key(provider: provider, accountId: account.id)
            if let last = series[key]?.last, observed <= last.observedAt { continue }
            let weight = AvailabilityHealthEngine.tierWeight(
                provider: provider, account: account
            )
            series[key, default: []].append(Sample(
                remainingPoints: remaining * weight.value,
                observedAt: observed,
                resetsAt: DeckDateParsing.date(from: snapshot.resetsAt)
            ))
        }
        // Guarded on a non-empty roster: a degenerate state (daemon briefly
        // reporting no accounts) must not wipe a healthy window — that
        // would recreate the very blindness #260 exists to prevent.
        if !live.isEmpty {
            for key in series.keys where !live.contains(key) { series[key] = nil }
        }
        prune(now: now)
    }

    /// Drops samples older than `windowSpan` (and any account series left
    /// empty). Samples beyond the future-jitter tolerance can't exist —
    /// `record` clamps them — but are guarded here too for safety.
    public mutating func prune(now: Date) {
        let cutoff = now.addingTimeInterval(-Self.windowSpan)
        let horizon = now.addingTimeInterval(Self.futureTolerance)
        for key in series.keys {
            series[key]?.removeAll { $0.observedAt < cutoff || $0.observedAt > horizon }
            if series[key]?.isEmpty == true { series[key] = nil }
        }
    }

    /// The provider's current burn rate in pool points/day, or nil while
    /// the window is inactive (samples span under `minimumActiveSpan`, or
    /// no usable interval survived the reset-crossing drops). Nil means
    /// "no burst opinion" — the engine then scores exactly as pre-#244.
    public func burstRate(for provider: DeckProvider, now: Date) -> Double? {
        let cutoff = now.addingTimeInterval(-Self.windowSpan)
        let horizon = now.addingTimeInterval(Self.futureTolerance)
        // Activation span endpoints — advanced ONLY by samples that
        // participate in a usable interval (finding 1). A sample with no
        // pair, or whose every interval was reset-dropped, is not
        // evidence of a rate and must not open the gate for someone
        // else's minutes-long pair.
        var usableEarliest: Date?
        var usableLatest: Date?
        var pointsPerDay = 0.0
        var hasUsableInterval = false
        for (key, samples) in series where key.provider == provider {
            let live = samples.filter { $0.observedAt >= cutoff && $0.observedAt <= horizon }
            var burned = 0.0
            var elapsed = 0.0
            for (previous, current) in zip(live, live.dropFirst()) {
                let interval = current.observedAt.timeIntervalSince(previous.observedAt)
                guard interval > 0 else { continue }
                let drop = previous.remainingPoints - current.remainingPoints
                // Remaining went UP: a reset crossed this interval. Drop
                // the interval entirely — no points, no time — so it can
                // never read as negative burn.
                guard drop >= 0 else { continue }
                // Finding 3: the reset that was SCHEDULED at the earlier
                // sample landed inside the gap. The net drop then hides a
                // full snap-to-100 worth of burn — drop the interval
                // rather than book the understated delta.
                if let reset = previous.resetsAt,
                   reset > previous.observedAt,
                   reset <= current.observedAt {
                    continue
                }
                burned += drop
                elapsed += interval
                usableEarliest = usableEarliest.map { min($0, previous.observedAt) }
                    ?? previous.observedAt
                usableLatest = usableLatest.map { max($0, current.observedAt) }
                    ?? current.observedAt
            }
            guard elapsed > 0 else { continue }
            hasUsableInterval = true
            pointsPerDay += burned / elapsed * 86_400
        }
        guard hasUsableInterval,
              let usableEarliest,
              let usableLatest,
              usableLatest.timeIntervalSince(usableEarliest) >= Self.minimumActiveSpan
        else { return nil }
        return pointsPerDay
    }

    /// The number of retained samples for a provider (test/debug surface).
    public func sampleCount(for provider: DeckProvider) -> Int {
        series.reduce(0) { $0 + ($1.key.provider == provider ? $1.value.count : 0) }
    }

    // MARK: - Persistence (issue #260)

    /// Wire form: `["claude|acct-1": [sample, …]]`. A dictionary keyed by
    /// the flat storage key so a future provider or a removed account
    /// decodes as "unknown key, drop it" instead of failing the whole
    /// restore — the same tolerate-unknowns contract as the daemon mirrors.
    private struct StoredSample: Codable {
        var remainingPoints: Double
        var observedAt: Date
        var resetsAt: Date?
    }

    /// The window's samples encoded for storage; nil when there is nothing
    /// worth writing.
    public func encoded() -> Data? {
        guard !series.isEmpty else { return nil }
        let wire = series.reduce(into: [String: [StoredSample]]()) { out, entry in
            out[entry.key.storageKey] = entry.value.map {
                StoredSample(
                    remainingPoints: $0.remainingPoints,
                    observedAt: $0.observedAt,
                    resetsAt: $0.resetsAt
                )
            }
        }
        return try? JSONEncoder().encode(wire)
    }

    /// Restores a persisted window, dropping anything older than
    /// `windowSpan` (and any unparseable key). A window restored from a
    /// long-closed app therefore comes back EMPTY — cold, honest, and
    /// identical to a fresh install — rather than resurrecting stale
    /// samples that would fabricate a rate across the downtime gap.
    public init(restoring data: Data?, now: Date) {
        guard let data,
              let wire = try? JSONDecoder().decode([String: [StoredSample]].self, from: data)
        else { return }
        for (rawKey, samples) in wire {
            guard let key = Key(storageKey: rawKey) else { continue }
            let restored = samples
                .map { Sample(remainingPoints: $0.remainingPoints, observedAt: $0.observedAt, resetsAt: $0.resetsAt) }
                .sorted { $0.observedAt < $1.observedAt }
            if !restored.isEmpty { series[key] = restored }
        }
        prune(now: now)
    }
}
