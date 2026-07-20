import Foundation

// Typed mirror of the daemon's settings document (src/db.mjs
// DEFAULT_SETTINGS / validateSetting). `GET /api/settings` always returns the
// full document with typed defaults filled in; `PUT /api/settings` accepts a
// partial patch of validated keys and returns the merged document.

/// The full settings document from `GET /api/settings`. Decoding is lenient:
/// missing keys fall back to the same defaults the daemon uses, and unknown
/// keys are ignored, so client and daemon can grow independently.
public struct DaemonSettings: Codable, Equatable, Sendable {
    public var autoRefreshEnabled: Bool
    public var autoRefreshIntervalSeconds: Int
    public var pauseWhileActive: Bool
    public var layout: String
    public var defaultSort: String
    public var notificationThresholdPercent: Int
    public var menuBarStyle: String

    /// Mirrors src/db.mjs DEFAULT_SETTINGS exactly.
    public static let defaults = DaemonSettings(
        autoRefreshEnabled: true,
        autoRefreshIntervalSeconds: 300,
        pauseWhileActive: true,
        layout: DeckLayout.twoColumn.rawValue,
        defaultSort: DeckSortOrder.nextReset.rawValue,
        notificationThresholdPercent: 25,
        menuBarStyle: "icon-only"
    )

    public init(
        autoRefreshEnabled: Bool,
        autoRefreshIntervalSeconds: Int,
        pauseWhileActive: Bool,
        layout: String,
        defaultSort: String,
        notificationThresholdPercent: Int,
        menuBarStyle: String
    ) {
        self.autoRefreshEnabled = autoRefreshEnabled
        self.autoRefreshIntervalSeconds = autoRefreshIntervalSeconds
        self.pauseWhileActive = pauseWhileActive
        self.layout = layout
        self.defaultSort = defaultSort
        self.notificationThresholdPercent = notificationThresholdPercent
        self.menuBarStyle = menuBarStyle
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = Self.defaults
        autoRefreshEnabled = try container.decodeIfPresent(Bool.self, forKey: .autoRefreshEnabled)
            ?? defaults.autoRefreshEnabled
        autoRefreshIntervalSeconds = try container.decodeIfPresent(Int.self, forKey: .autoRefreshIntervalSeconds)
            ?? defaults.autoRefreshIntervalSeconds
        pauseWhileActive = try container.decodeIfPresent(Bool.self, forKey: .pauseWhileActive)
            ?? defaults.pauseWhileActive
        layout = try container.decodeIfPresent(String.self, forKey: .layout) ?? defaults.layout
        defaultSort = try container.decodeIfPresent(String.self, forKey: .defaultSort) ?? defaults.defaultSort
        notificationThresholdPercent = try container.decodeIfPresent(Int.self, forKey: .notificationThresholdPercent)
            ?? defaults.notificationThresholdPercent
        menuBarStyle = try container.decodeIfPresent(String.self, forKey: .menuBarStyle) ?? defaults.menuBarStyle
    }

    /// Typed view of `layout`; falls back to the locked two-column default.
    public var deckLayout: DeckLayout {
        DeckLayout(rawValue: layout) ?? .twoColumn
    }

    /// Typed view of `defaultSort`; falls back to the locked next-reset default.
    public var deckSortOrder: DeckSortOrder {
        DeckSortOrder(rawValue: defaultSort) ?? .nextReset
    }

    /// Thresholds for icon/bar/notification severity: the configurable
    /// warning line is `notificationThresholdPercent`; critical stays the
    /// daemon's fixed 10% (src/service.mjs worstCapacity).
    public var usageThresholds: UsageThresholds {
        UsageThresholds(
            warningPercent: Double(notificationThresholdPercent),
            criticalPercent: UsageThresholds.default.criticalPercent
        )
    }

    /// The effective auto-refresh interval in seconds; 0 when disabled.
    public var effectiveAutoRefreshInterval: TimeInterval {
        autoRefreshEnabled ? TimeInterval(autoRefreshIntervalSeconds) : 0
    }
}

/// A partial update for `PUT /api/settings`. Only non-nil fields are encoded,
/// matching the daemon's merge semantics — untouched keys (including ones this
/// app doesn't surface) are never clobbered.
public struct DaemonSettingsPatch: Encodable, Equatable, Sendable {
    public var autoRefreshEnabled: Bool?
    public var autoRefreshIntervalSeconds: Int?
    public var pauseWhileActive: Bool?
    public var layout: String?
    public var defaultSort: String?
    public var notificationThresholdPercent: Int?
    public var menuBarStyle: String?

    public init(
        autoRefreshEnabled: Bool? = nil,
        autoRefreshIntervalSeconds: Int? = nil,
        pauseWhileActive: Bool? = nil,
        layout: String? = nil,
        defaultSort: String? = nil,
        notificationThresholdPercent: Int? = nil,
        menuBarStyle: String? = nil
    ) {
        self.autoRefreshEnabled = autoRefreshEnabled
        self.autoRefreshIntervalSeconds = autoRefreshIntervalSeconds
        self.pauseWhileActive = pauseWhileActive
        self.layout = layout
        self.defaultSort = defaultSort
        self.notificationThresholdPercent = notificationThresholdPercent
        self.menuBarStyle = menuBarStyle
    }

    /// Later fields win; used to coalesce patches queued behind an
    /// in-flight save.
    public func merging(_ other: DaemonSettingsPatch) -> DaemonSettingsPatch {
        DaemonSettingsPatch(
            autoRefreshEnabled: other.autoRefreshEnabled ?? autoRefreshEnabled,
            autoRefreshIntervalSeconds: other.autoRefreshIntervalSeconds ?? autoRefreshIntervalSeconds,
            pauseWhileActive: other.pauseWhileActive ?? pauseWhileActive,
            layout: other.layout ?? layout,
            defaultSort: other.defaultSort ?? defaultSort,
            notificationThresholdPercent: other.notificationThresholdPercent ?? notificationThresholdPercent,
            menuBarStyle: other.menuBarStyle ?? menuBarStyle
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(autoRefreshEnabled, forKey: .autoRefreshEnabled)
        try container.encodeIfPresent(autoRefreshIntervalSeconds, forKey: .autoRefreshIntervalSeconds)
        try container.encodeIfPresent(pauseWhileActive, forKey: .pauseWhileActive)
        try container.encodeIfPresent(layout, forKey: .layout)
        try container.encodeIfPresent(defaultSort, forKey: .defaultSort)
        try container.encodeIfPresent(notificationThresholdPercent, forKey: .notificationThresholdPercent)
        try container.encodeIfPresent(menuBarStyle, forKey: .menuBarStyle)
    }

    enum CodingKeys: String, CodingKey {
        case autoRefreshEnabled, autoRefreshIntervalSeconds, pauseWhileActive
        case layout, defaultSort, notificationThresholdPercent, menuBarStyle
    }

    public var isEmpty: Bool {
        autoRefreshEnabled == nil && autoRefreshIntervalSeconds == nil && pauseWhileActive == nil
            && layout == nil && defaultSort == nil && notificationThresholdPercent == nil
            && menuBarStyle == nil
    }
}
