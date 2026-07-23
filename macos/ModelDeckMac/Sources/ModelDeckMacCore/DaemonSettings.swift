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
    /// Issue #90 change-event provenance: true once the user has ever
    /// explicitly chosen a refresh interval (daemon flips it on a value
    /// CHANGE; the interval picker also asserts it directly on selection).
    /// While false, the daemon's active-session cap may slow the default
    /// cadence. One-way — it never returns to false.
    public var autoRefreshIntervalCustomized: Bool
    public var pauseWhileActive: Bool
    public var layout: String
    public var defaultSort: String
    public var notificationThresholdPercent: Int
    public var menuBarStyle: String
    /// Menu bar percent source: "" = lowest remaining across all enabled
    /// accounts (original behavior); an account id pins the menu bar
    /// percentage to that single account, shown continuously.
    public var menuBarAccountId: String

    /// Mirrors src/db.mjs DEFAULT_SETTINGS exactly.
    public static let defaults = DaemonSettings(
        autoRefreshEnabled: true,
        autoRefreshIntervalSeconds: 300,
        autoRefreshIntervalCustomized: false,
        pauseWhileActive: true,
        layout: DeckLayout.twoColumn.rawValue,
        defaultSort: DeckSortOrder.nextReset.rawValue,
        notificationThresholdPercent: 25,
        menuBarStyle: "icon-only",
        menuBarAccountId: ""
    )

    public init(
        autoRefreshEnabled: Bool,
        autoRefreshIntervalSeconds: Int,
        autoRefreshIntervalCustomized: Bool = false,
        pauseWhileActive: Bool,
        layout: String,
        defaultSort: String,
        notificationThresholdPercent: Int,
        menuBarStyle: String,
        menuBarAccountId: String = ""
    ) {
        self.autoRefreshEnabled = autoRefreshEnabled
        self.autoRefreshIntervalSeconds = autoRefreshIntervalSeconds
        self.autoRefreshIntervalCustomized = autoRefreshIntervalCustomized
        self.pauseWhileActive = pauseWhileActive
        self.layout = layout
        self.defaultSort = defaultSort
        self.notificationThresholdPercent = notificationThresholdPercent
        self.menuBarStyle = menuBarStyle
        self.menuBarAccountId = menuBarAccountId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = Self.defaults
        autoRefreshEnabled = try container.decodeIfPresent(Bool.self, forKey: .autoRefreshEnabled)
            ?? defaults.autoRefreshEnabled
        autoRefreshIntervalSeconds = try container.decodeIfPresent(Int.self, forKey: .autoRefreshIntervalSeconds)
            ?? defaults.autoRefreshIntervalSeconds
        autoRefreshIntervalCustomized = try container.decodeIfPresent(Bool.self, forKey: .autoRefreshIntervalCustomized)
            ?? defaults.autoRefreshIntervalCustomized
        pauseWhileActive = try container.decodeIfPresent(Bool.self, forKey: .pauseWhileActive)
            ?? defaults.pauseWhileActive
        layout = try container.decodeIfPresent(String.self, forKey: .layout) ?? defaults.layout
        defaultSort = try container.decodeIfPresent(String.self, forKey: .defaultSort) ?? defaults.defaultSort
        notificationThresholdPercent = try container.decodeIfPresent(Int.self, forKey: .notificationThresholdPercent)
            ?? defaults.notificationThresholdPercent
        menuBarStyle = try container.decodeIfPresent(String.self, forKey: .menuBarStyle) ?? defaults.menuBarStyle
        menuBarAccountId = try container.decodeIfPresent(String.self, forKey: .menuBarAccountId)
            ?? defaults.menuBarAccountId
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

    /// The pinned menu-bar account id; nil when the menu bar follows the
    /// lowest remaining % across all accounts (the "" sentinel).
    public var menuBarPinnedAccountId: String? {
        menuBarAccountId.isEmpty ? nil : menuBarAccountId
    }
}

/// A partial update for `PUT /api/settings`. Only non-nil fields are encoded,
/// matching the daemon's merge semantics — untouched keys (including ones this
/// app doesn't surface) are never clobbered.
public struct DaemonSettingsPatch: Encodable, Equatable, Sendable {
    public var autoRefreshEnabled: Bool?
    public var autoRefreshIntervalSeconds: Int?
    /// Issue #90: sent as `true` alongside an explicit interval-picker
    /// selection so the daemon records provenance even when the picked value
    /// equals what's stored. Never sent as `false` (the flag is one-way).
    /// Pre-#90 daemons reject unknown keys — SettingsSyncModel strips this
    /// field and retries when that happens.
    public var autoRefreshIntervalCustomized: Bool?
    public var pauseWhileActive: Bool?
    public var layout: String?
    public var defaultSort: String?
    public var notificationThresholdPercent: Int?
    public var menuBarStyle: String?
    public var menuBarAccountId: String?

    public init(
        autoRefreshEnabled: Bool? = nil,
        autoRefreshIntervalSeconds: Int? = nil,
        autoRefreshIntervalCustomized: Bool? = nil,
        pauseWhileActive: Bool? = nil,
        layout: String? = nil,
        defaultSort: String? = nil,
        notificationThresholdPercent: Int? = nil,
        menuBarStyle: String? = nil,
        menuBarAccountId: String? = nil
    ) {
        self.autoRefreshEnabled = autoRefreshEnabled
        self.autoRefreshIntervalSeconds = autoRefreshIntervalSeconds
        self.autoRefreshIntervalCustomized = autoRefreshIntervalCustomized
        self.pauseWhileActive = pauseWhileActive
        self.layout = layout
        self.defaultSort = defaultSort
        self.notificationThresholdPercent = notificationThresholdPercent
        self.menuBarStyle = menuBarStyle
        self.menuBarAccountId = menuBarAccountId
    }

    /// Later fields win; used to coalesce patches queued behind an
    /// in-flight save.
    public func merging(_ other: DaemonSettingsPatch) -> DaemonSettingsPatch {
        DaemonSettingsPatch(
            autoRefreshEnabled: other.autoRefreshEnabled ?? autoRefreshEnabled,
            autoRefreshIntervalSeconds: other.autoRefreshIntervalSeconds ?? autoRefreshIntervalSeconds,
            autoRefreshIntervalCustomized: other.autoRefreshIntervalCustomized ?? autoRefreshIntervalCustomized,
            pauseWhileActive: other.pauseWhileActive ?? pauseWhileActive,
            layout: other.layout ?? layout,
            defaultSort: other.defaultSort ?? defaultSort,
            notificationThresholdPercent: other.notificationThresholdPercent ?? notificationThresholdPercent,
            menuBarStyle: other.menuBarStyle ?? menuBarStyle,
            menuBarAccountId: other.menuBarAccountId ?? menuBarAccountId
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(autoRefreshEnabled, forKey: .autoRefreshEnabled)
        try container.encodeIfPresent(autoRefreshIntervalSeconds, forKey: .autoRefreshIntervalSeconds)
        try container.encodeIfPresent(autoRefreshIntervalCustomized, forKey: .autoRefreshIntervalCustomized)
        try container.encodeIfPresent(pauseWhileActive, forKey: .pauseWhileActive)
        try container.encodeIfPresent(layout, forKey: .layout)
        try container.encodeIfPresent(defaultSort, forKey: .defaultSort)
        try container.encodeIfPresent(notificationThresholdPercent, forKey: .notificationThresholdPercent)
        try container.encodeIfPresent(menuBarStyle, forKey: .menuBarStyle)
        try container.encodeIfPresent(menuBarAccountId, forKey: .menuBarAccountId)
    }

    enum CodingKeys: String, CodingKey {
        case autoRefreshEnabled, autoRefreshIntervalSeconds, autoRefreshIntervalCustomized, pauseWhileActive
        case layout, defaultSort, notificationThresholdPercent, menuBarStyle, menuBarAccountId
    }

    public var isEmpty: Bool {
        autoRefreshEnabled == nil && autoRefreshIntervalSeconds == nil
            && autoRefreshIntervalCustomized == nil && pauseWhileActive == nil
            && layout == nil && defaultSort == nil && notificationThresholdPercent == nil
            && menuBarStyle == nil && menuBarAccountId == nil
    }
}
