import Foundation

/// `GET /api/usage/exhaustion-forecast` (issue #497) — the daemon's
/// reset-aware time-to-dry estimate, one entry per enabled account plus the
/// pool's worst case.
///
/// Decision 0034: the app reads this from the daemon API only; it never
/// derives a dry time from live harness state. Decision 0019: provider
/// percentages are ground truth, the dry time is an ESTIMATE — the payload
/// carries `estimateLabel` and its fixed `basisWindow`, and every surface
/// that renders a dry time must carry that label through (see
/// `ExhaustionForecastPresentation`).
///
/// Decoding is deliberately tolerant (the house pattern): an older daemon
/// without the endpoint fails the request outright, and a daemon that omits
/// individual blocks decodes them to nil rather than failing the whole read.
public struct ExhaustionForecast: Codable, Equatable, Sendable {
    /// The fixed evidence window the estimate is computed over ("trailing 24
    /// hours"), surfaced in tooltips so the estimate states its own basis.
    public struct BasisWindow: Codable, Equatable, Sendable {
        public var source: String?
        public var label: String?
        public var since: String?
        public var until: String?
        public var hours: Double?
        public var minimumSpanMinutes: Double?

        public init(
            source: String? = nil,
            label: String? = nil,
            since: String? = nil,
            until: String? = nil,
            hours: Double? = nil,
            minimumSpanMinutes: Double? = nil
        ) {
            self.source = source
            self.label = label
            self.since = since
            self.until = until
            self.hours = hours
            self.minimumSpanMinutes = minimumSpanMinutes
        }
    }

    /// Present when the estimate runs past the account's next reset and the
    /// daemon assumed the measured pace continues into the following window.
    /// A strictly weaker claim than a same-window estimate, so the UI says so.
    public struct Carryover: Codable, Equatable, Sendable {
        public var assumed: Bool?
        public var resetAt: String?
        public var note: String?

        public init(assumed: Bool? = nil, resetAt: String? = nil, note: String? = nil) {
            self.assumed = assumed
            self.resetAt = resetAt
            self.note = note
        }
    }

    public struct Account: Codable, Equatable, Sendable, Identifiable {
        public var accountId: String
        public var accountLabel: String?
        public var provider: String?
        public var scope: String?
        /// "forecast" or "no-forecast". Anything else is treated as no
        /// forecast — an unknown status can never be rendered as a time.
        public var status: String?
        public var dryAt: String?
        public var burnRatePercentPerHour: Double?
        public var resetsAt: String?
        public var carryover: Carryover?
        /// Why there is no forecast (too little evidence, refills first, …).
        public var reason: String?

        public var id: String { accountId }

        public init(
            accountId: String,
            accountLabel: String? = nil,
            provider: String? = nil,
            scope: String? = nil,
            status: String? = nil,
            dryAt: String? = nil,
            burnRatePercentPerHour: Double? = nil,
            resetsAt: String? = nil,
            carryover: Carryover? = nil,
            reason: String? = nil
        ) {
            self.accountId = accountId
            self.accountLabel = accountLabel
            self.provider = provider
            self.scope = scope
            self.status = status
            self.dryAt = dryAt
            self.burnRatePercentPerHour = burnRatePercentPerHour
            self.resetsAt = resetsAt
            self.carryover = carryover
            self.reason = reason
        }
    }

    public struct Pool: Codable, Equatable, Sendable {
        public var status: String?
        public var worstCase: Account?

        public init(status: String? = nil, worstCase: Account? = nil) {
            self.status = status
            self.worstCase = worstCase
        }
    }

    public var estimateLabel: String?
    public var basisWindow: BasisWindow?
    public var accounts: [Account]
    public var pool: Pool?

    public init(
        estimateLabel: String? = nil,
        basisWindow: BasisWindow? = nil,
        accounts: [Account] = [],
        pool: Pool? = nil
    ) {
        self.estimateLabel = estimateLabel
        self.basisWindow = basisWindow
        self.accounts = accounts
        self.pool = pool
    }

    private enum CodingKeys: String, CodingKey {
        case estimateLabel, basisWindow, accounts, pool
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        estimateLabel = try? container.decodeIfPresent(String.self, forKey: .estimateLabel)
        basisWindow = try? container.decodeIfPresent(BasisWindow.self, forKey: .basisWindow)
        accounts = (try? container.decodeIfPresent([Account].self, forKey: .accounts)) ?? []
        pool = try? container.decodeIfPresent(Pool.self, forKey: .pool)
    }

    /// The forecast entry for one account, or nil when the payload doesn't
    /// mention it (a just-added account, a provider-filtered read).
    public func account(id: String) -> Account? {
        accounts.first { $0.accountId == id }
    }
}
