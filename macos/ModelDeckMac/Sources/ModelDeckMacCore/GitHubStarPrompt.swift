import Foundation

/// Tim, 2026-11-01: a rare, once-ever "star ModelDeck on GitHub" line in the
/// deck header. It becomes possible only after ModelDeck was used on
/// `requiredUsageDays` different days; from then on each deck open has a
/// 1-in-`chancePerOpen` chance to turn it on. Once on, it stays until the
/// user clicks Star or the dismiss button, and after either it never shows
/// again. App-local UserDefaults only, no network.
public struct GitHubStarPrompt {
    public static let repositoryURL = URL(string: "https://github.com/timharris707/modeldeck")!
    public static let requiredUsageDays = 10
    public static let chancePerOpen = 10

    static let usageDaysKey = "modeldeck.starPrompt.usageDays"
    static let phaseKey = "modeldeck.starPrompt.phase"

    enum Phase: String {
        case waiting, showing, finished
    }

    private let defaults: UserDefaults
    private let calendar: Calendar

    public init(defaults: UserDefaults, calendar: Calendar = .current) {
        self.defaults = defaults
        self.calendar = calendar
    }

    var phase: Phase {
        defaults.string(forKey: Self.phaseKey).flatMap(Phase.init(rawValue:)) ?? .waiting
    }

    public var isShowing: Bool { phase == .showing }

    /// Counts `now`'s calendar day as a usage day. Stops storing once the
    /// threshold is met, so the list never grows past it.
    public func recordUsageDay(now: Date = Date()) {
        var days = defaults.stringArray(forKey: Self.usageDaysKey) ?? []
        guard days.count < Self.requiredUsageDays else { return }
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        let key = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        guard !days.contains(key) else { return }
        days.append(key)
        defaults.set(days, forKey: Self.usageDaysKey)
    }

    /// One deck open: records the day, then rolls the chance if eligible.
    /// `roll` returns a number in 0..<chancePerOpen; 0 shows the prompt.
    public func deckOpened(
        now: Date = Date(),
        roll: () -> Int = { Int.random(in: 0..<GitHubStarPrompt.chancePerOpen) }
    ) {
        recordUsageDay(now: now)
        guard phase == .waiting,
              (defaults.stringArray(forKey: Self.usageDaysKey) ?? []).count >= Self.requiredUsageDays,
              roll() == 0
        else { return }
        defaults.set(Phase.showing.rawValue, forKey: Self.phaseKey)
    }

    /// Star clicked or dismissed: gone for good.
    public func finish() {
        defaults.set(Phase.finished.rawValue, forKey: Self.phaseKey)
    }
}
