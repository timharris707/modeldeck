import Foundation

// Issue #235 — Availability Health: one glanceable per-provider verdict
// answering "keep pace, push harder, or slow down?". A static % undersells
// near-reset accounts, so this simulates the next 7 days forward: the pool
// drains at the measured pace and every account snaps back to full at its
// known reset.
//
// The algorithm is the Swift port of Tim's validated `subscore` prototype
// with the issue's v1 delta: the pool is TIER-AWARE — each account's
// capacity scales by its subscription tier weight, so a Max 20x contributes
// proportionally more absolute capacity than a Pro. All quantities are
// "points": tier-weighted percent-points where one 1x-plan week is 100
// points (a Max 20x week is 2 000).
//
// Refinement (Tim's #235 follow-up comment): the RED/YELLOW/GREEN verdict is
// generated from a CONTINUOUS score — the sustainable pace multiple M, the
// largest multiple of the measured pace that survives the 7-day simulation
// with no drought (binary search). M < 1 → RED, 1 ≤ M < 2 → YELLOW,
// M ≥ 2 → GREEN, so the verdict and the score can never disagree; the
// detail popover maps M onto a 0–100 three-segment bar. This band
// derivation SUPERSEDES the prototype's floor+margin grazing rule.
//
// Everything here is pure derivation over `DeckState` plus an injected
// `now` — no clocks, no I/O — so the whole engine is directly unit
// testable. All inputs come from `GET /api/state`; no daemon change.

/// The verdict bands, generated from the sustainable pace multiple.
public enum AvailabilityVerdict: String, Equatable, Sendable, CaseIterable {
    case red
    case yellow
    case green

    /// The band a sustainable pace multiple falls in. Boundary semantics
    /// are pinned by tests: exactly 1.0 is YELLOW, exactly 2.0 is GREEN.
    public static func band(forMultiple multiple: Double) -> AvailabilityVerdict {
        if multiple < 1 { return .red }
        if multiple < 2 { return .yellow }
        return .green
    }

    /// "Red" / "Yellow" / "Green" — the chip and menu bar word.
    public var displayWord: String {
        rawValue.prefix(1).uppercased() + rawValue.dropFirst()
    }

    /// Severity rank for capping (issue #257): red worst, green best.
    var severityRank: Int {
        switch self {
        case .red: return 0
        case .yellow: return 1
        case .green: return 2
        }
    }

    /// The worse of two verdicts — how a cap is applied without ever
    /// IMPROVING a verdict the runway already lowered.
    func worse(than other: AvailabilityVerdict) -> AvailabilityVerdict {
        severityRank <= other.severityRank ? self : other
    }
}

/// One account admitted to the provider pool, in tier-weighted points.
public struct AvailabilityPoolAccount: Equatable, Sendable {
    public var label: String
    /// Points left now: remaining% × tier weight.
    public var remainingPoints: Double
    /// Full-week points: 100 × tier weight.
    public var capacityPoints: Double
    /// Hours until this account's known weekly reset (clamped ≥ 0).
    public var hoursToReset: Double
    /// False when the tier wasn't recognized and the documented weight-1
    /// fallback applied — surfaced in the detail popover, never silent.
    public var tierKnown: Bool

    public init(
        label: String,
        remainingPoints: Double,
        capacityPoints: Double,
        hoursToReset: Double,
        tierKnown: Bool = true
    ) {
        self.label = label
        self.remainingPoints = remainingPoints
        self.capacityPoints = capacityPoints
        self.hoursToReset = hoursToReset
        self.tierKnown = tierKnown
    }
}

/// An account left OUT of the pool, with the human reason the popover names
/// — stale/broken accounts are excluded and named, never silently dropped.
public struct AvailabilityExclusion: Equatable, Sendable {
    public var label: String
    public var reason: String

    public init(label: String, reason: String) {
        self.label = label
        self.reason = reason
    }
}

/// The soonest upcoming reset that materially relieves the pool (issue
/// #310) — the "Next relief" Tim's YELLOW advice schedules heavy runs
/// after. Restored points are measured from the account's CURRENT level
/// (a from-now approximation; further drain before the reset only makes
/// the real infusion bigger).
public struct AvailabilityNextReset: Equatable, Sendable {
    public var accountLabel: String
    public var date: Date
    public var restoredPoints: Double

    public init(accountLabel: String, date: Date, restoredPoints: Double) {
        self.accountLabel = accountLabel
        self.date = date
        self.restoredPoints = restoredPoints
    }
}

/// One provider's full Availability Health evaluation. `verdict == nil`
/// means no usable accounts (the exclusions say why) — the chip then
/// renders an honest "No data", never a guessed color.
public struct AvailabilityHealthReport: Equatable, Sendable {
    public var provider: DeckProvider
    public var verdict: AvailabilityVerdict?
    /// The sustainable pace multiple M (Tim's refinement): the largest
    /// multiple of the measured pace the pool survives for 7 days with no
    /// drought. Capped at `AvailabilityHealthEngine.maxMultiple`.
    public var sustainableMultiple: Double?
    /// M mapped onto the 0–100 three-segment display bar.
    public var displayScore: Double?
    public var poolPoints: Double
    public var capacityPoints: Double
    public var pacePointsPerDay: Double
    /// Lowest pool level over the 7-day sim at the measured pace.
    public var minPoolPoints: Double?
    /// First hour the pool hits the safety floor at the measured pace, when
    /// it does (the RED story's "dry in ~2.1 days").
    public var firstDroughtHours: Int?
    /// Largest one-time spend (points) addable TODAY at the measured pace
    /// with no drought.
    public var burstHeadroomPoints: Double?
    // Issue #244 — the burst-aware pace scenario. All nil/false while the
    // burn-rate window is inactive (cold start, under 30 min of samples):
    // the report is then byte-for-byte the pre-#244 evaluation.
    /// The short-window burn rate ("today's rate", pts/day) the scenario
    /// was evaluated with; nil while the window is inactive.
    public var burstPointsPerDay: Double?
    /// First drought hour of the burst-scenario sim, set only when the
    /// burst scenario is RELEVANT: burst > 2× the trailing pace AND the
    /// burst sim droughts where the measured-pace sim does not.
    public var burstFirstDroughtHours: Int?
    /// Straight-line hours until the pool hits the safety floor at
    /// today's rate, ignoring resets (Tim's "bottoms out in ~Xh" number —
    /// the adjacent soonest-reset line supplies the rescue context).
    public var burstBottomsOutHours: Double?
    /// Hours until the SOONEST pool reset (not the biggest) — the other
    /// number Tim needed live: "next reset lands in Yh".
    public var soonestResetHours: Double?
    /// True when the burst scenario lowered a steady-state GREEN to
    /// YELLOW. The verdict, displayScore, and readout all already reflect
    /// the degradation — this flag only drives the "why" copy.
    public var burstDegraded: Bool
    // Issue #257 — present availability, alongside the forward runway.
    /// Points held in accounts with enough left to host work. Always ≤
    /// `poolPoints`; the difference is stranded in near-empty accounts.
    public var usablePoints: Double
    /// How many admitted accounts can host work right now.
    public var usableAccountCount: Int
    /// True when present scarcity lowered the runway verdict. Drives the
    /// "why" copy, exactly like `burstDegraded`.
    public var scarcityCapped: Bool
    public var nextBigReset: AvailabilityNextReset?
    public var pool: [AvailabilityPoolAccount]
    public var excluded: [AvailabilityExclusion]
    /// Accounts counted at the weight-1 fallback because their tier wasn't
    /// recognized.
    public var unknownTierLabels: [String]

    public init(
        provider: DeckProvider,
        verdict: AvailabilityVerdict? = nil,
        sustainableMultiple: Double? = nil,
        displayScore: Double? = nil,
        poolPoints: Double = 0,
        capacityPoints: Double = 0,
        pacePointsPerDay: Double = 0,
        minPoolPoints: Double? = nil,
        firstDroughtHours: Int? = nil,
        burstHeadroomPoints: Double? = nil,
        burstPointsPerDay: Double? = nil,
        burstFirstDroughtHours: Int? = nil,
        burstBottomsOutHours: Double? = nil,
        soonestResetHours: Double? = nil,
        burstDegraded: Bool = false,
        usablePoints: Double = 0,
        usableAccountCount: Int = 0,
        scarcityCapped: Bool = false,
        nextBigReset: AvailabilityNextReset? = nil,
        pool: [AvailabilityPoolAccount] = [],
        excluded: [AvailabilityExclusion] = [],
        unknownTierLabels: [String] = []
    ) {
        self.provider = provider
        self.verdict = verdict
        self.sustainableMultiple = sustainableMultiple
        self.displayScore = displayScore
        self.poolPoints = poolPoints
        self.capacityPoints = capacityPoints
        self.pacePointsPerDay = pacePointsPerDay
        self.minPoolPoints = minPoolPoints
        self.firstDroughtHours = firstDroughtHours
        self.burstHeadroomPoints = burstHeadroomPoints
        self.burstPointsPerDay = burstPointsPerDay
        self.burstFirstDroughtHours = burstFirstDroughtHours
        self.burstBottomsOutHours = burstBottomsOutHours
        self.soonestResetHours = soonestResetHours
        self.burstDegraded = burstDegraded
        self.usablePoints = usablePoints
        self.usableAccountCount = usableAccountCount
        self.scarcityCapped = scarcityCapped
        self.nextBigReset = nextBigReset
        self.pool = pool
        self.excluded = excluded
        self.unknownTierLabels = unknownTierLabels
    }
}

/// Tier weight lookup result: the multiplier plus whether it came from a
/// recognized tier (unrecognized tiers use the documented weight-1 fallback
/// and are surfaced, never guessed silently).
public struct AvailabilityTierWeight: Equatable, Sendable {
    public var value: Double
    public var isKnown: Bool

    public init(value: Double, isKnown: Bool) {
        self.value = value
        self.isKnown = isKnown
    }
}

public enum AvailabilityHealthEngine {
    /// Safety floor fraction: the floor is 5% of the LARGEST admitted
    /// account's weekly capacity (review, PR #236) — the exact
    /// generalization of the prototype's fixed 5 %-points, where every
    /// account's capacity was 100. A fixed 5 points under tier weighting
    /// would shrink "drought" to literal zero on a Max-20x pool
    /// (5 pts ≈ 0.25% of one 20x week). Design default, flagged in the PR
    /// for Tim to veto.
    public static let floorFraction = 0.05

    /// The drought floor for a given pool, in points.
    public static func floorPoints(for accounts: [AvailabilityPoolAccount]) -> Double {
        floorFraction * (accounts.map(\.capacityPoints).max() ?? 100)
    }
    // MARK: - Present availability (issue #257)
    //
    // Tim's field report 2026-08-05: the chip read GREEN 96 on a Claude pool
    // holding 1,600 of 12,000 points with FOUR of six accounts at 1–3%. The
    // verdict was defensible as pure 7-day sustainability — every account
    // resets inside the horizon, so the sim never approached the floor — but
    // it answered the wrong question. Availability Health exists to answer
    // "can I start the heavy work NOW?", and nothing in the score reacted to
    // how little was reachable at that moment: a pool at 13% scored the same
    // as a pool at 90%. Worse, the ONE mechanism that watched recent rate
    // (#244's burst scenario) is asymmetric and transient, so the verdict
    // IMPROVED when he stopped working while capacity was still falling.
    //
    // So the runway verdict is now CAPPED by what is presently usable.

    /// An account below this fraction of its own capacity cannot host real
    /// work, so its remaining points are not counted as usable. Same 5%
    /// shape as `floorFraction`, applied per account rather than pool-wide.
    public static let usableAccountFraction = 0.05
    /// Usable fraction at or below which the verdict cannot be GREEN.
    public static let scarceUsableFraction = 0.15
    /// Usable fraction at or below which the verdict goes RED — unless
    /// relief is imminent (see `imminentReliefHours`). Design defaults,
    /// flagged in the PR for Tim to veto like `floorFraction` was.
    public static let criticalUsableFraction = 0.07
    /// A reset landing within this many hours downgrades the RED cap to
    /// YELLOW: being nearly dry matters less when a refill is minutes out.
    /// Deliberately does NOT lift the YELLOW cap — "almost empty, but more
    /// is coming" is exactly the caution state, not an all-clear.
    public static let imminentReliefHours = 6.0

    /// Points sitting in accounts too empty to host work — counted in the
    /// pool total, but not reachable for a session.
    public static func usablePoints(_ accounts: [AvailabilityPoolAccount]) -> Double {
        accounts
            .filter { $0.remainingPoints >= usableAccountFraction * $0.capacityPoints }
            .reduce(0) { $0 + $1.remainingPoints }
    }

    /// How many admitted accounts can actually host work right now.
    public static func usableAccountCount(_ accounts: [AvailabilityPoolAccount]) -> Int {
        accounts.filter { $0.remainingPoints >= usableAccountFraction * $0.capacityPoints }.count
    }

    /// The ceiling present scarcity puts on the runway verdict; nil when
    /// there is enough usable capacity to impose none.
    ///
    /// TWO conditions, both required — calibrated against the #244 field
    /// deck Tim confirmed as GREEN (five Max 20x accounts: one at 4%, four
    /// at 14.5%; pool 11.6% of capacity). A low pool ALONE must not cap, or
    /// that deck would have been wrongly downgraded: four live accounts at
    /// 14.5% is a working deck. What made 2026-08-05 different is that most
    /// of the deck was SPENT — 2 of 6 accounts usable. So the cap needs
    /// both a scarce pool and a majority of accounts unusable:
    ///
    ///   #244 deck  → 11.6% pool, 4 of 5 usable → no cap (GREEN preserved)
    ///   2026-08-05 → 12.0% pool, 2 of 6 usable → YELLOW
    static func scarcityCap(_ accounts: [AvailabilityPoolAccount]) -> AvailabilityVerdict? {
        let capacity = accounts.reduce(0) { $0 + $1.capacityPoints }
        guard capacity > 0 else { return nil }
        let fraction = usablePoints(accounts) / capacity
        guard fraction <= scarceUsableFraction else { return nil }
        // Half or fewer of the admitted accounts can host work.
        guard usableAccountCount(accounts) * 2 <= accounts.count else { return nil }
        guard fraction <= criticalUsableFraction else { return .yellow }
        // Imminent relief softens RED to YELLOW, never to GREEN. A clamped-0
        // reset already snapped, so its next lands a full cycle out — the
        // same reading measuredPace and resetLands use.
        let soonest = accounts
            .map { $0.hoursToReset > 0 ? $0.hoursToReset : cycleHours }
            .min() ?? cycleHours
        return soonest <= imminentReliefHours ? .yellow : .red
    }

    /// Weekly cycle length; the simulation horizon.
    public static let cycleHours = 168.0
    /// Observations older than this exclude the account (prototype value).
    public static let defaultStaleAfter: TimeInterval = 30 * 60
    /// Cap on the sustainable-multiple search. A pool that survives even
    /// this reports "over 8×" — searching higher adds nothing decidable.
    public static let maxMultiple = 8.0

    // MARK: - Tier weights (documented table; issue #235 requirement)
    //
    // Claude (`claudePlan.rateLimitTier` / subscription word):
    //   "…_20x" → 20, "…_5x" → 5 (any Nx token in the tier string → N);
    //   "max" with no stated multiplier → 5 (the base Max tier);
    //   "pro" → 1; "team" → 1 (seat-scoped, Pro-class limits).
    // Codex (`codexPlan.planType`):
    //   "pro" → 10 (ChatGPT Pro carries roughly an order of magnitude more
    //   Codex quota than Plus, mirroring its price ratio);
    //   "plus" → 1; "business" / "team" → 1 (seat-scoped, Plus-class).
    // Anything else → 1 AND the account is flagged "tier unknown" in the
    // detail popover rather than silently guessed.

    /// The tier weight for one account of the given provider.
    public static func tierWeight(
        provider: DeckProvider,
        account: DeckAccount
    ) -> AvailabilityTierWeight {
        switch provider {
        case .claude:
            return claudeTierWeight(account.metadata?.claudePlan ?? account.metadata?.plan)
        case .codex:
            return codexTierWeight(account.metadata?.codexPlan ?? account.metadata?.plan)
        }
    }

    static func claudeTierWeight(_ plan: ProviderPlanInfo?) -> AvailabilityTierWeight {
        if let multiplier = PlanTierFormatter.multiplierValue(in: plan?.rateLimitTier) {
            return AvailabilityTierWeight(value: multiplier, isKnown: true)
        }
        let words = planWords(plan)
        if words.contains("max") { return AvailabilityTierWeight(value: 5, isKnown: true) }
        if words.contains("pro") || words.contains("team") {
            return AvailabilityTierWeight(value: 1, isKnown: true)
        }
        return AvailabilityTierWeight(value: 1, isKnown: false)
    }

    static func codexTierWeight(_ plan: ProviderPlanInfo?) -> AvailabilityTierWeight {
        let words = planWords(plan)
        if words.contains("pro") { return AvailabilityTierWeight(value: 10, isKnown: true) }
        if words.contains("plus") || words.contains("business") || words.contains("team") {
            return AvailabilityTierWeight(value: 1, isKnown: true)
        }
        return AvailabilityTierWeight(value: 1, isKnown: false)
    }

    /// Word tokens from whichever plan strings exist ("default_claude_max_20x"
    /// → ["default", "claude", "max", "20x"]), so recognition never depends
    /// on one exact payload spelling.
    private static func planWords(_ plan: ProviderPlanInfo?) -> Set<String> {
        var words: Set<String> = []
        for raw in [plan?.subscriptionType, plan?.rateLimitTier].compactMap({ $0 }) {
            for token in raw.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
                words.insert(String(token))
            }
        }
        return words
    }

    // MARK: - Pool building (driver scopes + exclusions)

    /// Driver scopes match the proxy-rebalance policy: claude → "Fable
    /// weekly" (fallback "weekly"), codex → "weekly" only. Matching is
    /// case-insensitive with the daemon's generic-weekly synonyms
    /// ("week"/"7d"); model-scoped weeklies like "GPT-5-Codex weekly" never
    /// match the generic scope.
    static func driverScopes(for provider: DeckProvider) -> (primary: String, fallback: String?) {
        driverScopes(for: provider, generalWeekly: false)
    }

    /// Issue #258 (Tim, 2026-08-05): the chip answers the question the deck
    /// is currently SHOWING. With the #254 header toggle on, Claude cards
    /// headline "Weekly · all models", so the chip evaluates the general
    /// weekly pool rather than Fable's — otherwise the cards and the dot
    /// answer two different questions side by side with nothing saying so.
    /// Claude only: Codex's driver scope is already the general weekly, and
    /// the toggle never touches Codex cards.
    static func driverScopes(
        for provider: DeckProvider,
        generalWeekly: Bool
    ) -> (primary: String, fallback: String?) {
        switch provider {
        case .claude: return generalWeekly ? ("weekly", nil) : ("fable weekly", "weekly")
        case .codex: return ("weekly", nil)
        }
    }

    private static func normalizedScope(_ scope: String) -> String {
        let lower = scope.lowercased().trimmingCharacters(in: .whitespaces)
        return ["week", "7d", "weekly"].contains(lower) ? "weekly" : lower
    }

    /// The driver-scope snapshot for one account's usage rows — primary
    /// scope first, generic fallback second. Shared by the pool builder
    /// and the #244 burn-rate window so both always read the SAME scope.
    static func driverSnapshot(
        for provider: DeckProvider,
        in rows: [UsageSnapshot],
        generalWeekly: Bool = false
    ) -> UsageSnapshot? {
        let scopes = driverScopes(for: provider, generalWeekly: generalWeekly)
        return rows.first { normalizedScope($0.scope) == scopes.primary }
            ?? scopes.fallback.flatMap { fallback in
                rows.first { normalizedScope($0.scope) == fallback }
            }
    }

    /// Builds the provider's pool from a deck state: enabled accounts with a
    /// fresh driver-scope snapshot, tier-weighted; everything else is
    /// excluded WITH its reason. Disabled accounts are omitted silently
    /// (they are out of the deck by choice); an absent `authState` (older
    /// daemon) is tolerated — the freshness gate still protects the sim.
    public static func pool(
        for provider: DeckProvider,
        state: DeckState,
        now: Date,
        staleAfter: TimeInterval = defaultStaleAfter,
        generalWeekly: Bool = false
    ) -> (accounts: [AvailabilityPoolAccount], excluded: [AvailabilityExclusion], unknownTierLabels: [String]) {
        let snapshotsByAccount = Dictionary(grouping: state.usage, by: \.accountId)
        var accounts: [AvailabilityPoolAccount] = []
        var excluded: [AvailabilityExclusion] = []
        var unknownTiers: [String] = []
        for account in state.accounts where DeckProvider.from(account.provider) == provider {
            guard account.enabled else { continue }
            // Issue #264: inclusion keys on DATA AGE, not authState. A
            // flagged account whose live session is producing fresh
            // server-truth (statusline captures, #174) is real capacity and
            // must count; the auth flag stays untouched on the account so
            // renewal candidacy and the card notice keep their own stories.
            // `duplicate-token` is the one hard authState exclusion left:
            // two profiles holding the SAME login would double-count one
            // subscription's capacity no matter how fresh the data is.
            // When a flagged account's data is missing or stale, the
            // exclusion reports the AUTH reason ("sign in needed"), not the
            // generic staleness line — the flag is why the data froze, and
            // the health detail should keep saying so.
            var flaggedAuthReason: String?
            if let auth = account.authState?.lowercased(), auth != "ok" {
                if auth == "duplicate-token" {
                    excluded.append(AvailabilityExclusion(
                        label: account.label, reason: authReason(auth)
                    ))
                    continue
                }
                flaggedAuthReason = authReason(auth)
            }
            let rows = snapshotsByAccount[account.id] ?? []
            let snapshot = driverSnapshot(for: provider, in: rows, generalWeekly: generalWeekly)
            guard let snapshot else {
                excluded.append(AvailabilityExclusion(
                    label: account.label, reason: flaggedAuthReason ?? "no weekly usage data"
                ))
                continue
            }
            let observed = DeckDateParsing.date(from: snapshot.observedAt)
            guard !snapshot.stale,
                  let observed,
                  now.timeIntervalSince(observed) <= staleAfter
            else {
                excluded.append(AvailabilityExclusion(
                    label: account.label, reason: flaggedAuthReason ?? "usage data is stale"
                ))
                continue
            }
            let remaining = snapshot.remainingPercent
                ?? snapshot.usedPercent.map { 100 - $0 }
            guard let remaining,
                  let reset = DeckDateParsing.date(from: snapshot.resetsAt)
            else {
                excluded.append(AvailabilityExclusion(
                    label: account.label, reason: "missing remaining % or reset time"
                ))
                continue
            }
            let weight = tierWeight(provider: provider, account: account)
            if !weight.isKnown { unknownTiers.append(account.label) }
            accounts.append(AvailabilityPoolAccount(
                label: account.label,
                remainingPoints: remaining * weight.value,
                capacityPoints: 100 * weight.value,
                hoursToReset: max(reset.timeIntervalSince(now) / 3600, 0),
                tierKnown: weight.isKnown
            ))
        }
        return (accounts, excluded, unknownTiers)
    }

    private static func authReason(_ authState: String) -> String {
        switch authState {
        case "signin-required": return "sign in needed"
        case "keychain-denied": return "needs Keychain access"
        case "duplicate-token": return "duplicate login"
        default: return "auth state \(authState)"
        }
    }

    // MARK: - Measured pace

    /// Pool points/day: sum of tier-weighted used points over the sum of
    /// elapsed cycle-days across the pool (the prototype's formula, exactly
    /// as the issue states it — only the used side is tier-weighted; elapsed
    /// time is time).
    ///
    /// Clamp semantics (review, PR #236): an account whose stored resetsAt
    /// has already passed — `hoursToReset` clamped to 0 — is FRESHLY RESET,
    /// elapsed ≈ 0, consistent with `resetLands`, which schedules its next
    /// snap a full cycle out. The old end-of-cycle reading (elapsed 7 days)
    /// diluted the pool's pace toward GREEN whenever a just-reset account
    /// sat beside a heavily used one. An `hoursToReset` beyond the cycle
    /// length (clock skew / provider oddity) likewise contributes elapsed 0
    /// here and never resets inside the sim — conservative in both places.
    public static func measuredPace(_ accounts: [AvailabilityPoolAccount]) -> Double {
        let usedPoints = accounts.reduce(0) { $0 + ($1.capacityPoints - $1.remainingPoints) }
        let elapsedDays = accounts.reduce(into: 0.0) { total, account in
            guard account.hoursToReset > 0 else { return } // freshly reset
            total += (cycleHours - min(account.hoursToReset, cycleHours)) / 24
        }
        return elapsedDays > 0 ? usedPoints / elapsedDays : 0
    }

    // MARK: - Simulation

    public struct SimulationResult: Equatable, Sendable {
        public var minPoolPoints: Double
        public var firstDroughtHour: Int?
        public var droughtHours: Int

        public init(minPoolPoints: Double, firstDroughtHour: Int? = nil, droughtHours: Int = 0) {
            self.minPoolPoints = minPoolPoints
            self.firstDroughtHour = firstDroughtHour
            self.droughtHours = droughtHours
        }
    }

    /// Hourly 7-day simulation: the pool drains at `pacePerDay`, each
    /// account snaps to FULL capacity in the hour its known reset lands
    /// (this cycle and again one cycle later within the horizon), and the
    /// hourly drain distributes across accounts proportional to what each
    /// has left. `extraSpendNow` models a one-time spend at hour zero (the
    /// burst-headroom probe). Drought = pool at or below the safety floor.
    public static func simulate(
        _ accounts: [AvailabilityPoolAccount],
        pacePerDay: Double,
        extraSpendNow: Double = 0
    ) -> SimulationResult {
        var remaining = accounts.map(\.remainingPoints)
        // Review (PR #236): the one-time spend comes OUT of the accounts,
        // proportionally to what each has left — never off a detached pool
        // total — so a reset inside the window naturally forgives it (the
        // infusion is capacity − remaining). The detached deduction never
        // restored the spend and understated burst headroom whenever a
        // reset fell inside the 7 days.
        if extraSpendNow > 0 {
            let total = remaining.reduce(0, +)
            if total > 0 {
                let spend = min(extraSpendNow, total)
                for index in remaining.indices {
                    remaining[index] = max(remaining[index] - spend * remaining[index] / total, 0)
                }
            }
        }
        var poolTotal = remaining.reduce(0, +)
        let floor = floorPoints(for: accounts)
        var minPool = poolTotal
        var firstDry: Int?
        var dryHours = 0
        let perHour = pacePerDay / 24
        for hour in 1...Int(cycleHours) {
            for index in accounts.indices where resetLands(at: accounts[index].hoursToReset, inHour: hour) {
                poolTotal += accounts[index].capacityPoints - remaining[index]
                remaining[index] = accounts[index].capacityPoints
            }
            let burn = min(perHour, max(poolTotal, 0))
            poolTotal -= burn
            let named = remaining.reduce(0, +)
            if named > 0 {
                for index in remaining.indices {
                    remaining[index] = max(remaining[index] - burn * remaining[index] / named, 0)
                }
            }
            minPool = min(minPool, poolTotal)
            if poolTotal <= floor {
                dryHours += 1
                if firstDry == nil { firstDry = hour }
            }
        }
        return SimulationResult(
            minPoolPoints: minPool, firstDroughtHour: firstDry, droughtHours: dryHours
        )
    }

    /// A reset `hoursToReset` away lands in sim hour `hour` when it falls in
    /// the bucket (hour-1, hour] — this cycle or one full cycle later.
    /// (Bucketed rather than the prototype's integer truncation so a reset
    /// under an hour away still snaps in hour 1 instead of a week later.)
    /// A clamped 0 (stored resetsAt already passed) reads as freshly reset:
    /// its next snap lands one full cycle out, matching `measuredPace`'s
    /// elapsed-0 reading. A value beyond the cycle length (clock skew)
    /// never lands inside the horizon at all — no infusion, conservative.
    static func resetLands(at hoursToReset: Double, inHour hour: Int) -> Bool {
        let lower = Double(hour - 1)
        let upper = Double(hour)
        if hoursToReset > lower && hoursToReset <= upper { return true }
        let nextCycle = hoursToReset + cycleHours
        return nextCycle > lower && nextCycle <= upper
    }

    // MARK: - Sustainable pace multiple (Tim's #235 refinement)

    /// The largest multiple of the measured pace that survives the 7-day
    /// simulation with no drought — continuous, monotone (faster drain can
    /// only lower the pool), binary-searched to well below display
    /// precision. 0 when even a frozen pace droughts (the pool is already
    /// at the floor); `maxMultiple` when even that pace survives (including
    /// the zero-measured-pace case, where any multiple of zero is zero).
    public static func sustainableMultiple(
        _ accounts: [AvailabilityPoolAccount],
        pacePerDay: Double
    ) -> Double {
        func survives(_ multiple: Double) -> Bool {
            simulate(accounts, pacePerDay: pacePerDay * multiple).firstDroughtHour == nil
        }
        guard survives(0) else { return 0 }
        guard !survives(maxMultiple) else { return maxMultiple }
        var lower = 0.0
        var upper = maxMultiple
        for _ in 0..<32 {
            let mid = (lower + upper) / 2
            if survives(mid) { lower = mid } else { upper = mid }
        }
        return lower
    }

    /// Maps the sustainable multiple onto the 0–100 display bar: M 0→1
    /// spans 0–33 (red segment), 1→2 spans 33–66 (yellow), 2→3+ spans
    /// 66–100 (green, capped). Pinned by tests at the band edges.
    public static func displayScore(forMultiple multiple: Double) -> Double {
        if multiple <= 0 { return 0 }
        if multiple < 1 { return multiple * 33 }
        if multiple < 2 { return 33 + (multiple - 1) * 33 }
        return min(66 + (multiple - 2) * 34, 100)
    }

    // MARK: - Burst headroom

    /// Largest one-time spend (points) addable TODAY at the measured pace
    /// without a drought — binary search over the headroom probe.
    public static func burstHeadroom(
        _ accounts: [AvailabilityPoolAccount],
        pacePerDay: Double
    ) -> Double {
        var lower = 0.0
        var upper = accounts.reduce(0) { $0 + $1.remainingPoints }
        guard upper > 0 else { return 0 }
        let floor = floorPoints(for: accounts)
        for _ in 0..<24 {
            let mid = (lower + upper) / 2
            let result = simulate(accounts, pacePerDay: pacePerDay, extraSpendNow: mid)
            if result.minPoolPoints > floor {
                lower = mid
            } else {
                upper = mid
            }
        }
        return lower
    }

    // MARK: - Next relief

    /// A reset is MATERIAL relief when it restores at least this fraction
    /// of the largest restoration any upcoming reset offers. Issue #310:
    /// the row's job is "when does real capacity come back?", so a
    /// near-full account's token refill must not hijack it — but among
    /// comparably sized reliefs, the SOONEST one is the answer.
    public static let materialReliefFraction = 0.5

    /// The soonest upcoming reset that materially relieves the pool; nil
    /// when the pool is empty.
    ///
    /// Issue #310 (supersedes the #235 "biggest reset" selection this row
    /// carried under its old name): magnitude-first ordering told Tim to
    /// wait until Sunday for +1,980 pts while a +1,960-pt reset landed a
    /// full day earlier. Relief comes from drained accounts, so the
    /// candidates are ALL pool accounts — no usable/eligibility filter —
    /// ranked soonest-first among those clearing the materiality bar
    /// (ties break toward the larger restoration).
    public static func nextBigReset(
        _ accounts: [AvailabilityPoolAccount],
        now: Date
    ) -> AvailabilityNextReset? {
        let candidates = accounts.map { account in
            AvailabilityNextReset(
                accountLabel: account.label,
                date: now.addingTimeInterval(max(account.hoursToReset, 0) * 3600),
                restoredPoints: account.capacityPoints - account.remainingPoints
            )
        }
        let threshold = materialReliefFraction * (candidates.map(\.restoredPoints).max() ?? 0)
        return candidates
            .filter { $0.restoredPoints >= threshold }
            .sorted { lhs, rhs in
                if lhs.date != rhs.date { return lhs.date < rhs.date }
                return lhs.restoredPoints > rhs.restoredPoints
            }
            .first
    }

    // MARK: - Full report

    /// One provider's complete evaluation over a deck state at `now` — the
    /// single entry point the chip, popover, and menu bar all read.
    ///
    /// Issue #244: `burstPointsPerDay` is the short-window burn rate from
    /// `BurnRateWindow` ("today's rate"); nil (inactive window) reproduces
    /// the pre-#244 evaluation exactly. When today's rate exceeds the 2×
    /// stress test the GREEN band already implies (M ≥ 2 means the pool
    /// survives 2× the trailing average), the burst becomes a first-class
    /// scenario: the pool is simulated at max(2× average, 1× burst) —
    /// which is then simply the burst rate — and if THAT droughts where
    /// the measured pace does not, a steady-state GREEN degrades to
    /// YELLOW. This is an ADDITIONAL scenario on top of Tim's signed-off
    /// M-band semantics, never a redefinition: `sustainableMultiple`, the
    /// bands, and every steady-state number are untouched.
    ///
    /// Degrade rules (adversarial notes, optimistic direction):
    /// - Burst ≤ 2× average never touches the VERDICT: GREEN already
    ///   proved 2× survives, and re-testing a weaker rate could only ever
    ///   flatter it. Pinned as a verdict no-op. (The burst FACT fields
    ///   populate on the looser burst > pace gate — display only.)
    /// - Burst can only ever LOWER a verdict (green → yellow), never
    ///   raise one, and never below yellow: RED is unreachable from here
    ///   because red means the measured pace itself droughts — and then
    ///   `base.firstDroughtHour != nil` skips the degrade branch (the
    ///   verdict is already worse than anything burst could say).
    /// - When the verdict degrades, `displayScore` is re-clamped into the
    ///   yellow segment (positioned by how deep into the week the burst
    ///   drought lands), so the bar, the color, and the readout can never
    ///   contradict each other.
    public static func report(
        for provider: DeckProvider,
        state: DeckState,
        now: Date,
        staleAfter: TimeInterval = defaultStaleAfter,
        burstPointsPerDay: Double? = nil,
        generalWeekly: Bool = false
    ) -> AvailabilityHealthReport {
        let (accounts, excluded, unknownTiers) = pool(
            for: provider, state: state, now: now, staleAfter: staleAfter,
            generalWeekly: generalWeekly
        )
        guard !accounts.isEmpty else {
            return AvailabilityHealthReport(
                provider: provider,
                excluded: excluded,
                unknownTierLabels: unknownTiers
            )
        }
        let pace = measuredPace(accounts)
        let multiple = sustainableMultiple(accounts, pacePerDay: pace)
        let base = simulate(accounts, pacePerDay: pace)
        var verdict = AvailabilityVerdict.band(forMultiple: multiple)
        var score = displayScore(forMultiple: multiple)
        var burstDrought: Int?
        var bottomsOut: Double?
        var soonestReset: Double?
        var degraded = false
        // Information display runs whenever today's rate outpaces the
        // average at all (orchestrator decision on #244's closing
        // requirement: the bench-out vs next-reset numbers show on GREEN,
        // YELLOW, or RED decks alike whenever the burst sim touches the
        // floor inside the horizon). The VERDICT gate below is stricter
        // and unchanged.
        if let burst = burstPointsPerDay, burst > pace {
            let burstSim = simulate(accounts, pacePerDay: burst)
            if let dry = burstSim.firstDroughtHour {
                burstDrought = dry
                let poolNow = accounts.reduce(0) { $0 + $1.remainingPoints }
                bottomsOut = max(poolNow - floorPoints(for: accounts), 0) / (burst / 24)
                // A clamped-0 reset already snapped: its next lands a full
                // cycle out, matching measuredPace/resetLands exactly.
                soonestReset = accounts
                    .map { $0.hoursToReset > 0 ? $0.hoursToReset : cycleHours }
                    .min()
                // The degrade gate, exactly as reviewed: burst above the
                // 2× stress test GREEN already implies, droughting where
                // the measured pace does not, lowers GREEN → YELLOW.
                // Never anything else.
                if burst > 2 * pace, base.firstDroughtHour == nil, verdict == .green {
                    degraded = true
                    verdict = .yellow
                    // Needle inside the yellow segment, later drought →
                    // closer to green: hour 1 → 33, hour 168 → ~65.8
                    // (never 66 — that pixel is green's).
                    score = min(score, 33 + 33 * Double(max(dry - 1, 0)) / cycleHours)
                }
            }
        }
        // Issue #257: present scarcity caps the runway verdict. Applied
        // LAST so it composes with #244's burst degrade and can only ever
        // lower — `worse(than:)` never improves a verdict the runway or the
        // burst scenario already brought down. The score follows the cap so
        // the bar and the dot can never disagree (the #235 invariant).
        var scarcityCapped = false
        if let cap = scarcityCap(accounts) {
            let capped = verdict.worse(than: cap)
            // CodeRabbit (PR #259): clamp the bar ONLY when the cap actually
            // lowered the verdict. A runway that was already YELLOW/RED owns
            // its own needle — moving it here would change the bar with no
            // scarcity readout to explain it, breaking the lower-only
            // contract and the #235 "bar and dot never disagree" invariant.
            if capped != verdict {
                scarcityCapped = true
                verdict = capped
                switch verdict {
                case .yellow: score = min(score, 50)
                case .red: score = min(score, 20)
                case .green: break
                }
            }
        }
        return AvailabilityHealthReport(
            provider: provider,
            verdict: verdict,
            sustainableMultiple: multiple,
            displayScore: score,
            poolPoints: accounts.reduce(0) { $0 + $1.remainingPoints },
            capacityPoints: accounts.reduce(0) { $0 + $1.capacityPoints },
            pacePointsPerDay: pace,
            minPoolPoints: base.minPoolPoints,
            firstDroughtHours: base.firstDroughtHour,
            burstHeadroomPoints: burstHeadroom(accounts, pacePerDay: pace),
            burstPointsPerDay: burstPointsPerDay,
            burstFirstDroughtHours: burstDrought,
            burstBottomsOutHours: bottomsOut,
            soonestResetHours: soonestReset,
            burstDegraded: degraded,
            usablePoints: usablePoints(accounts),
            usableAccountCount: usableAccountCount(accounts),
            scarcityCapped: scarcityCapped,
            nextBigReset: nextBigReset(accounts, now: now),
            pool: accounts,
            excluded: excluded,
            unknownTierLabels: unknownTiers
        )
    }
}

// MARK: - Structured detail rows (issue #281)

/// One label/value row of the redesigned health detail ("Pool" / "380 of
/// 12000 pts"). Labels render secondary, values primary with monospaced
/// digits — the deck cards' hierarchy. One fact per row (Tim's width
/// addendum): a value never carries another row's fact.
///
/// Values carry the SAME numbers the flat fact wall showed; #281 changes
/// presentation only. Point counts are locale-grouped ("12,000" in en_US)
/// because legibility at this type size is the redesign's whole purpose —
/// see `pointsFormatter`.
public struct HealthFactRow: Equatable, Hashable, Sendable {
    public var label: String
    /// An account name that leads the value and is the ONLY part the view
    /// may ellipsize when the row can't fit (Tim's width addendum: "truncate
    /// the ACCOUNT NAME with an ellipsis, never the numbers"). Nil on every
    /// row whose value is numbers only.
    public var name: String?
    public var value: String

    public init(label: String, name: String? = nil, value: String) {
        self.label = label
        self.name = name
        self.value = value
    }

    /// The value as one string — what VoiceOver hears and what tests pin,
    /// with the truncatable name restored in front of the numbers.
    public var spokenValue: String {
        guard let name, !name.isEmpty else { return value }
        return "\(name) \(value)"
    }
}

/// One titled group of fact rows ("Now" / "Pace" / "Week ahead"). The view
/// renders the title as an uppercased tertiary header ABOVE the rows —
/// chosen over a left gutter column because the popover is 300 pt wide and
/// a gutter would steal width the relief row needs (the width addendum
/// makes that the deciding measurement; verified by screenshot at 300 pt
/// with six-digit numbers and a 25-character account name).
public struct HealthSection: Equatable, Sendable {
    public var title: String
    public var rows: [HealthFactRow]

    public init(title: String, rows: [HealthFactRow]) {
        self.title = title
        self.rows = rows
    }

    /// The ONE spoken form for the whole group — derived here (the #65/#113
    /// suppression rule) so VoiceOver reads a section coherently instead of
    /// a scatter of bare values.
    public var accessibilityLabel: String {
        "\(title): " + rows.map { "\($0.label) \($0.spokenValue)" }.joined(separator: "; ")
    }

    /// The row carrying `label`, or nil — the lookup every migrated
    /// string-pinning test uses instead of scanning a flat array.
    public func row(_ label: String) -> HealthFactRow? {
        rows.first { $0.label == label }
    }
}

// MARK: - Presentation (pure strings/values for the chip + detail popover)

/// Everything the deck chip, its detail popover, and accessibility read —
/// derived here (not in the views) so every word and number is unit
/// testable. Copy follows Tim's #235 emphasis: clean, non-jargon decision
/// language.
public struct AvailabilityHealthPresentation: Equatable, Sendable {
    /// "Green" / "Yellow" / "Red" / "No data" — the chip word.
    public var chipWord: String
    public var verdict: AvailabilityVerdict?
    /// 0–100 needle position for the segmented bar; nil hides the bar.
    public var score: Double?
    /// The plain-language sustainable-pace readout ("You could sustain
    /// about 1.8× your current pace — yellow, close to green.").
    public var readout: String
    /// Issue #281: the CURRENT band's guidance, one sentence. The other two
    /// bands moved to the verdict bar's hover (`meaningParagraph`) — never
    /// deleted, just no longer three paragraphs deep in a detail popover.
    /// Nil when there is no verdict to guide.
    public var guidance: String?
    /// Issue #281: the fact wall, grouped. Empty sections are dropped, so a
    /// deck with nothing to say renders nothing rather than empty headers.
    public var sections: [HealthSection]
    public var excludedLine: String?
    public var unknownTierLine: String?
    /// Popover title, e.g. "Claude availability".
    public var title: String
    /// Hover tooltip on the chip (progressive enhancement; the click-open
    /// popover is the reliable surface inside MenuBarExtra windows).
    public var chipTooltip: String
    public var accessibilitySummary: String

    /// One short non-jargon paragraph on what the colors mean as decisions
    /// (Tim's wording requirement). Issue #281 RELOCATED it out of the
    /// detail popover's body and onto the verdict bar's hover — the bar is
    /// what encodes the band, so the legend belongs on it. Never deleted:
    /// the popover body now carries only the current band's sentence
    /// (`guidance`), which is one of this paragraph's own clauses.
    public static let meaningParagraph =
        "Green: safe to launch heavy multi-agent work. "
        + "Yellow: normal work is fine — hold the heavy runs until the next reset. "
        + "Red: slow down and focus on one project. "
        + "The bar shows how close you are to the neighboring band."

    /// Issue #281: the current band's guidance alone, as a sentence. Same
    /// words as this band's clause in `meaningParagraph` (pinned by test),
    /// so the popover body and the bar's hover can never disagree.
    public static func guidance(for verdict: AvailabilityVerdict?) -> String? {
        switch verdict {
        case .green: return "Safe to launch heavy multi-agent work."
        case .yellow: return "Normal work is fine — hold the heavy runs until the next reset."
        case .red: return "Slow down and focus on one project."
        case nil: return nil
        }
    }

    /// Issue #281 section titles — one place, so the popover, the tests and
    /// the VoiceOver grouping all name the same three groups.
    public enum SectionTitle {
        public static let now = "Now"
        public static let pace = "Pace"
        public static let weekAhead = "Week ahead"
    }

    /// The group with this title, or nil when it has no facts to show.
    public func section(_ title: String) -> HealthSection? {
        sections.first { $0.title == title }
    }

    /// The row carrying this label, wherever it groups — the lookup the
    /// migrated string-pinning tests use in place of scanning `factLines`.
    public func row(_ label: String) -> HealthFactRow? {
        sections.compactMap { $0.row(label) }.first
    }

    /// The points unit, explained once in fine print.
    public static let pointsFootnote =
        "Points are tier-weighted capacity: one Pro plan-week is 100 points, a Max 20x week is 2000."

    /// The chip's no-data word.
    public static let noDataWord = "No data"

    public static func make(
        report: AvailabilityHealthReport,
        now: Date,
        calendar: Calendar = .current
    ) -> AvailabilityHealthPresentation {
        let providerName = report.provider.displayName
        let title = "\(providerName) availability"
        guard let verdict = report.verdict, let multiple = report.sustainableMultiple else {
            let readout = "No usable \(providerName) accounts to score."
            return AvailabilityHealthPresentation(
                chipWord: noDataWord,
                verdict: nil,
                score: nil,
                readout: readout,
                guidance: nil,
                sections: [],
                excludedLine: excludedLine(report.excluded),
                unknownTierLine: unknownTierLine(report.unknownTierLabels),
                title: title,
                chipTooltip: "\(readout) Click for details.",
                accessibilitySummary: "\(providerName) availability: no data. \(readout)"
            )
        }
        // Issue #244: a burst-degraded verdict must SAY why — the chip
        // color and the sentence may never contradict each other. The
        // burst readout replaces the steady-state one (which would
        // otherwise claim green words under a yellow chip).
        let readout: String
        if report.scarcityCapped {
            // Issue #257: when present scarcity lowered the verdict, the
            // sentence must say THAT — the runway sentence ("you could
            // sustain 2.9× this pace") is true but reads as an all-clear
            // beside four near-empty cards, which is the whole complaint.
            let usable = report.usableAccountCount
            let total = report.pool.count
            var line = "Only \(points(report.usablePoints)) pts are usable right now, "
                + "across \(usable) of \(total) account\(total == 1 ? "" : "s")."
            if let soonest = report.soonestResetHours ?? report.pool
                .map({ $0.hoursToReset > 0 ? $0.hoursToReset : AvailabilityHealthEngine.cycleHours })
                .min() {
                line += " The next reset lands in \(hoursText(Int(soonest.rounded())))."
            }
            line += " Your weekly pace itself is fine — this is about what you can start today."
            readout = line
        } else if report.burstDegraded, let dry = report.burstFirstDroughtHours {
            readout = Self.burstReadout(
                multiple: multiple,
                burstPointsPerDay: report.burstPointsPerDay,
                pacePerDay: report.pacePointsPerDay,
                droughtHours: dry
            )
        } else if verdict == .yellow, let dry = report.burstFirstDroughtHours {
            // Review finding 4 (partial): a base-YELLOW deck with an
            // active burst drought gets the burst clause too, so the
            // sentence and the fact lines below never disagree.
            readout = Self.readout(
                multiple: multiple, pacePerDay: report.pacePointsPerDay
            ) + " Today's burn runs ahead of that pace and would dry the pool in \(hoursText(dry))."
        } else {
            readout = Self.readout(
                multiple: multiple, pacePerDay: report.pacePointsPerDay
            )
        }
        // Issue #281: the same facts, grouped and split into label/value
        // rows. Nothing is added or dropped here — the flat `factLines`
        // wall became three titled groups, one fact per row, so a value
        // column of numbers can be scanned down. Section membership is the
        // question each fact answers: what is true NOW, how fast it is
        // moving (PACE), and what the 7-day sim says (WEEK AHEAD).
        var nowRows: [HealthFactRow] = [
            HealthFactRow(
                label: "Pool",
                value: "\(points(report.poolPoints)) of \(points(report.capacityPoints)) pts"
            ),
        ]
        var paceRows: [HealthFactRow] = [
            HealthFactRow(
                label: "Weekly pace",
                value: "\(points(report.pacePointsPerDay)) pts/day"
            ),
        ]
        var weekRows: [HealthFactRow] = []
        // Issue #257: what is reachable RIGHT NOW, stated whenever it
        // differs from the raw pool — points stranded in near-empty
        // accounts are counted in the pool but cannot host a session, and
        // that gap is exactly what made a 13%-full deck read GREEN.
        if report.usableAccountCount < report.pool.count
            || report.usablePoints < report.poolPoints {
            nowRows.append(HealthFactRow(
                label: "Usable",
                value: "\(points(report.usablePoints)) pts · "
                    + "\(report.usableAccountCount) of \(report.pool.count) accounts"
            ))
        }
        // Issue #244, Tim's two live numbers. "Current burn" shows
        // whenever the window is active (unless the rate rounds to zero —
        // "~0 pts/day (0.0×)" is noise, review finding 7); the
        // bottoms-out pair shows whenever the burst sim touches the floor
        // inside the horizon, on any verdict (orchestrator decision).
        // Issue #260: a nil burn rate means the window has not gathered
        // enough evidence yet (fresh install, or the app was closed a
        // while) — say so, because the verdict beside it is a steady-state
        // reading with no burst opinion in it, and an unexplained GREEN in
        // that gap is exactly what read as broken after v0.3.20 relaunched.
        if report.burstPointsPerDay == nil {
            paceRows.append(HealthFactRow(label: "Today's burn", value: "still measuring"))
        }
        if let burn = report.burstPointsPerDay, burn.rounded() >= 1 {
            var value = "~\(points(burn)) pts/day"
            if report.pacePointsPerDay > 0 {
                // The weekly pace sits one row above, so "3.0× pace" is
                // unambiguous where the old flat line had to spell out
                // "your weekly pace" — and that spelling no longer fits.
                value += " · \(multiplierText(burn / report.pacePointsPerDay))× pace"
            }
            paceRows.append(HealthFactRow(label: "Today's burn", value: value))
        }
        if let bottomsOut = report.burstBottomsOutHours,
           let soonestReset = report.soonestResetHours {
            paceRows.append(HealthFactRow(
                label: "Runway",
                value: "bottoms out ~\(hoursText(Int(bottomsOut.rounded())))"
                    + " · reset in \(hoursText(Int(soonestReset.rounded())))"
            ))
        }
        if let minPool = report.minPoolPoints {
            weekRows.append(HealthFactRow(label: "Lowest point", value: "\(points(minPool)) pts"))
        }
        if let droughtHours = report.firstDroughtHours {
            weekRows.append(HealthFactRow(
                label: "Pool dry",
                value: "in \(hoursText(droughtHours)) at the current pace"
            ))
        }
        if let headroom = report.burstHeadroomPoints {
            weekRows.append(HealthFactRow(
                label: "Burst room", value: "~\(points(headroom)) pts today"
            ))
        }
        if let reset = report.nextBigReset, reset.restoredPoints >= 1 {
            // The one row whose width is not under our control: an account
            // label of any length leads it. It is therefore the row the
            // width addendum names — the NAME ellipsizes, the numbers never
            // do, which is why it travels as a separate field.
            weekRows.append(HealthFactRow(
                label: "Next relief",
                name: reset.accountLabel,
                value: "+\(points(reset.restoredPoints)) pts · "
                    + reliefWhen(for: reset.date, now: now, calendar: calendar)
            ))
        }
        let sections = [
            HealthSection(title: SectionTitle.now, rows: nowRows),
            HealthSection(title: SectionTitle.pace, rows: paceRows),
            HealthSection(title: SectionTitle.weekAhead, rows: weekRows),
        ].filter { !$0.rows.isEmpty }
        return AvailabilityHealthPresentation(
            chipWord: verdict.displayWord,
            verdict: verdict,
            score: report.displayScore,
            readout: readout,
            guidance: guidance(for: verdict),
            sections: sections,
            excludedLine: excludedLine(report.excluded),
            unknownTierLine: unknownTierLine(report.unknownTierLabels),
            title: title,
            chipTooltip: "\(readout) Click for details.",
            accessibilitySummary: "\(providerName) availability \(verdict.displayWord). \(readout)"
        )
    }

    /// The sustainable-pace sentence, with the within-band proximity
    /// qualifier ("yellow, close to green") once the needle sits in the
    /// outer quarter of its segment. Pinned by tests.
    public static func readout(multiple: Double, pacePerDay: Double) -> String {
        if pacePerDay <= 0 {
            return multiple >= AvailabilityHealthEngine.maxMultiple
                ? "No measured usage yet this cycle — full runway."
                : "No measured usage yet this cycle, but the pool is nearly empty."
        }
        if multiple >= AvailabilityHealthEngine.maxMultiple {
            return "You could sustain over \(Int(AvailabilityHealthEngine.maxMultiple))× your current pace — green."
        }
        let verdict = AvailabilityVerdict.band(forMultiple: multiple)
        let qualifier: String
        switch verdict {
        case .red:
            qualifier = multiple >= 0.75 ? ", close to yellow" : ""
        case .yellow:
            let position = multiple - 1
            if position >= 0.75 {
                qualifier = ", close to green"
            } else if position < 0.25 {
                qualifier = ", close to red"
            } else {
                qualifier = ""
            }
        case .green:
            qualifier = multiple - 2 < 0.25 ? ", close to yellow" : ""
        }
        let amount = String(format: "%.1f", multiple)
        return "You could sustain about \(amount)× your current pace — \(verdict.rawValue)\(qualifier)."
    }

    /// Issue #244: the burst-degraded readout — same plain-language
    /// register as the steady-state sentence, but it owns the yellow and
    /// names the reason. Pinned by tests.
    public static func burstReadout(
        multiple: Double,
        burstPointsPerDay: Double?,
        pacePerDay: Double,
        droughtHours: Int
    ) -> String {
        guard pacePerDay > 0 else {
            // Fresh cycle, no trailing average yet — but the burn window
            // is live and its rate droughts. Still yellow, still named.
            return "No weekly usage measured yet, but today's burn would run "
                + "the pool dry in \(hoursText(droughtHours)). "
                + "Yellow while this burst lasts."
        }
        let burnPhrase: String
        if let burst = burstPointsPerDay {
            burnPhrase = "today's burn (\(multiplierText(burst / pacePerDay))× that pace)"
        } else {
            burnPhrase = "today's burn"
        }
        let steady = multiple >= AvailabilityHealthEngine.maxMultiple
            ? "over \(Int(AvailabilityHealthEngine.maxMultiple))×"
            : "about \(String(format: "%.1f", multiple))×"
        return "Your weekly average could sustain \(steady) — but \(burnPhrase) "
            + "would run the pool dry in \(hoursText(droughtHours)). "
            + "Yellow while this burst lasts."
    }

    /// "6.9" under 10×, whole numbers above ("28×", not "27.9×") — burn
    /// multiples get less precise as they get less believable.
    static func multiplierText(_ multiple: Double) -> String {
        multiple < 9.95
            ? String(format: "%.1f", multiple)
            : "\(Int(multiple.rounded()))"
    }

    static func excludedLine(_ excluded: [AvailabilityExclusion]) -> String? {
        guard !excluded.isEmpty else { return nil }
        let items = excluded.map { "\($0.label) (\($0.reason))" }.joined(separator: ", ")
        return "Not counted: \(items)"
    }

    static func unknownTierLine(_ labels: [String]) -> String? {
        guard !labels.isEmpty else { return nil }
        return "Tier unknown, counted as 1×: \(labels.joined(separator: ", "))"
    }

    /// Whole points, deterministic formatting (no locale separators).
    /// Grouped thousands (issue #281): the redesign's whole purpose is a
    /// number you can read at a glance, and "12,000" beats "12000" at the
    /// popover's small type. This changes PRESENTATION only — the value is
    /// the same rounded integer the flat layout showed. Locale-aware, so a
    /// non-US install groups the way that install expects.
    private static let pointsFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.maximumFractionDigits = 0
        return formatter
    }()

    private static func points(_ value: Double) -> String {
        let rounded = Int(value.rounded())
        return pointsFormatter.string(from: NSNumber(value: rounded)) ?? "\(rounded)"
    }

    /// "5 hr" under a day, "2.1 days" beyond — the drought-time phrasing.
    static func hoursText(_ hours: Int) -> String {
        guard hours >= 24 else { return "\(hours) hr" }
        return "\(String(format: "%.1f", Double(hours) / 24)) days"
    }

    private static func lowercasedLead(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.lowercased() + text.dropFirst()
    }

    /// Issue #281: the relief row's WHEN, without the deck's "Resets " lead
    /// — the label already says this is the next relief, and the seven
    /// characters it saves are what let the account name and the numbers
    /// share one line at the popover's real width. Same source of truth as
    /// every other reset time (`DeckBuilder.resetText`), so the phrasing
    /// ("in 3 hr 20 min", "Tue 3:00 PM") can never drift from the cards.
    static func reliefWhen(for date: Date?, now: Date, calendar: Calendar = .current) -> String {
        let text = DeckBuilder.resetText(for: date, now: now, calendar: calendar)
        if text == "resetting now" { return "now" }
        guard text.hasPrefix("Resets ") else { return lowercasedLead(text) }
        return String(text.dropFirst("Resets ".count))
    }
}
