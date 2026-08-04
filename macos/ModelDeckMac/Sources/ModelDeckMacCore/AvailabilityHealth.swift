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

/// The upcoming reset that restores the most points — "the next big reset"
/// Tim's YELLOW advice schedules heavy runs after. Restored points are
/// measured from the account's CURRENT level (a from-now approximation;
/// further drain before the reset only makes the real infusion bigger).
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
        switch provider {
        case .claude: return ("fable weekly", "weekly")
        case .codex: return ("weekly", nil)
        }
    }

    private static func normalizedScope(_ scope: String) -> String {
        let lower = scope.lowercased().trimmingCharacters(in: .whitespaces)
        return ["week", "7d", "weekly"].contains(lower) ? "weekly" : lower
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
        staleAfter: TimeInterval = defaultStaleAfter
    ) -> (accounts: [AvailabilityPoolAccount], excluded: [AvailabilityExclusion], unknownTierLabels: [String]) {
        let snapshotsByAccount = Dictionary(grouping: state.usage, by: \.accountId)
        let scopes = driverScopes(for: provider)
        var accounts: [AvailabilityPoolAccount] = []
        var excluded: [AvailabilityExclusion] = []
        var unknownTiers: [String] = []
        for account in state.accounts where DeckProvider.from(account.provider) == provider {
            guard account.enabled else { continue }
            if let auth = account.authState?.lowercased(), auth != "ok" {
                excluded.append(AvailabilityExclusion(
                    label: account.label, reason: authReason(auth)
                ))
                continue
            }
            let rows = snapshotsByAccount[account.id] ?? []
            let snapshot = rows.first { normalizedScope($0.scope) == scopes.primary }
                ?? scopes.fallback.flatMap { fallback in
                    rows.first { normalizedScope($0.scope) == fallback }
                }
            guard let snapshot else {
                excluded.append(AvailabilityExclusion(
                    label: account.label, reason: "no weekly usage data"
                ))
                continue
            }
            let observed = DeckDateParsing.date(from: snapshot.observedAt)
            guard !snapshot.stale,
                  let observed,
                  now.timeIntervalSince(observed) <= staleAfter
            else {
                excluded.append(AvailabilityExclusion(
                    label: account.label, reason: "usage data is stale"
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

    // MARK: - Next big reset

    /// The upcoming reset restoring the most points (ties break soonest);
    /// nil when the pool is empty.
    public static func nextBigReset(
        _ accounts: [AvailabilityPoolAccount],
        now: Date
    ) -> AvailabilityNextReset? {
        accounts
            .map { account in
                AvailabilityNextReset(
                    accountLabel: account.label,
                    date: now.addingTimeInterval(max(account.hoursToReset, 0) * 3600),
                    restoredPoints: account.capacityPoints - account.remainingPoints
                )
            }
            .sorted { lhs, rhs in
                if lhs.restoredPoints != rhs.restoredPoints {
                    return lhs.restoredPoints > rhs.restoredPoints
                }
                return lhs.date < rhs.date
            }
            .first
    }

    // MARK: - Full report

    /// One provider's complete evaluation over a deck state at `now` — the
    /// single entry point the chip, popover, and menu bar all read.
    public static func report(
        for provider: DeckProvider,
        state: DeckState,
        now: Date,
        staleAfter: TimeInterval = defaultStaleAfter
    ) -> AvailabilityHealthReport {
        let (accounts, excluded, unknownTiers) = pool(
            for: provider, state: state, now: now, staleAfter: staleAfter
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
        return AvailabilityHealthReport(
            provider: provider,
            verdict: AvailabilityVerdict.band(forMultiple: multiple),
            sustainableMultiple: multiple,
            displayScore: displayScore(forMultiple: multiple),
            poolPoints: accounts.reduce(0) { $0 + $1.remainingPoints },
            capacityPoints: accounts.reduce(0) { $0 + $1.capacityPoints },
            pacePointsPerDay: pace,
            minPoolPoints: base.minPoolPoints,
            firstDroughtHours: base.firstDroughtHour,
            burstHeadroomPoints: burstHeadroom(accounts, pacePerDay: pace),
            nextBigReset: nextBigReset(accounts, now: now),
            pool: accounts,
            excluded: excluded,
            unknownTierLabels: unknownTiers
        )
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
    public var factLines: [String]
    public var excludedLine: String?
    public var unknownTierLine: String?
    /// Popover title, e.g. "Claude availability".
    public var title: String
    /// Hover tooltip on the chip (progressive enhancement; the click-open
    /// popover is the reliable surface inside MenuBarExtra windows).
    public var chipTooltip: String
    public var accessibilitySummary: String

    /// One short non-jargon paragraph on what the colors mean as decisions
    /// (Tim's wording requirement), shared by every popover.
    public static let meaningParagraph =
        "Green: safe to launch heavy multi-agent work. "
        + "Yellow: normal work is fine — hold the heavy runs until the next reset. "
        + "Red: slow down and focus on one project. "
        + "The bar shows how close you are to the neighboring band."

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
                factLines: [],
                excludedLine: excludedLine(report.excluded),
                unknownTierLine: unknownTierLine(report.unknownTierLabels),
                title: title,
                chipTooltip: "\(readout) Click for details.",
                accessibilitySummary: "\(providerName) availability: no data. \(readout)"
            )
        }
        let readout = Self.readout(
            multiple: multiple, pacePerDay: report.pacePointsPerDay
        )
        var facts: [String] = [
            "Pool now: \(points(report.poolPoints)) of \(points(report.capacityPoints)) pts",
            "Measured pace: \(points(report.pacePointsPerDay)) pts/day",
        ]
        if let minPool = report.minPoolPoints {
            facts.append("Lowest point over 7 days: \(points(minPool)) pts")
        }
        if let droughtHours = report.firstDroughtHours {
            facts.append("Pool dry in \(hoursText(droughtHours)) at the current pace")
        }
        if let headroom = report.burstHeadroomPoints {
            facts.append("Burst headroom today: ~\(points(headroom)) pts")
        }
        if let reset = report.nextBigReset, reset.restoredPoints >= 1 {
            let when = lowercasedLead(
                DeckBuilder.resetText(for: reset.date, now: now, calendar: calendar)
            )
            facts.append(
                "Next big reset: \(reset.accountLabel), \(when) (+\(points(reset.restoredPoints)) pts)"
            )
        }
        return AvailabilityHealthPresentation(
            chipWord: verdict.displayWord,
            verdict: verdict,
            score: report.displayScore,
            readout: readout,
            factLines: facts,
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
    private static func points(_ value: Double) -> String {
        "\(Int(value.rounded()))"
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
}
