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
    /// percentage to that single account, shown continuously;
    /// "active:<provider>" follows that provider's active account; "none"
    /// (issue #229) hides the percentage entirely — glyph only. The daemon
    /// validates only string/length, so every sentinel round-trips through
    /// old and new daemons alike.
    public var menuBarAccountId: String
    /// Issue #238 quiet mode: WHEN the menu bar shows the indicator that
    /// `menuBarAccountId` selects. Grammar (see `MenuBarShowWhen`):
    /// "" = always (default — existing users see zero change);
    /// "below:<1-99>" = percentage modes show the number only while the
    /// displayed percent is below the threshold; "yellow" = health modes
    /// show the status dot only for YELLOW/RED verdicts; "red" = RED only.
    /// Same free-string discipline as the #229/#235 sentinels riding
    /// `menuBarAccountId`: the daemon validates only string/length, unknown
    /// values parse as always (never a crash, never data hidden by
    /// surprise), a value that doesn't apply to the selected display mode
    /// gates nothing, and a pre-#238 build simply ignores the key.
    /// Display-only: notifications keep watching every account.
    public var menuBarShowWhen: String
    /// Issue #242 deck chip labels: whether the deck's Availability Health
    /// chips render the verdict word beside the shape-coded dot. Grammar
    /// (see `DeckHealthLabels`): "" = dot only (default — the dot's shape
    /// already codes the verdict: green circle / yellow triangle / red
    /// octagon / hollow no-data ring, the #235 menu-bar coding shared via
    /// `AvailabilityVerdictShape`); "show" = dot + verdict word (the
    /// Settings → General → Accessibility toggle). Same free-string
    /// discipline as `menuBarShowWhen` above: the daemon validates only
    /// string/length, unknown values parse as dot-only (never a crash), a
    /// pre-#242 build simply ignores the key. Display-only: the tooltip,
    /// detail popover, and VoiceOver summary are unaffected in both modes.
    public var deckHealthLabels: String
    /// Issue #176 (Tim decision 2026-07-31): the daemon's scheduled renewal
    /// of expired-idle Claude accounts. Default ON — the whole point is zero
    /// user effort; the honest cost disclosure lives on the toggle.
    public var autoRenewEnabled: Bool
    /// Issue #204: shared user scope (MCP registrations + user memory across
    /// Claude accounts). Default OFF — opt-in by direction. READ-ONLY here:
    /// the UI never PUTs this key; enabling/disabling runs through the
    /// mutation-guarded /api/shared-scope endpoints because enabling is a
    /// disclosed one-time merge, not a plain settings write.
    public var sharedUserScopeEnabled: Bool

    /// Mirrors src/db.mjs DEFAULT_SETTINGS exactly.
    /// Issue #187 (Tim directive 2026-07-29): pauseWhileActive defaults OFF
    /// — an active session is when users most want the deck live.
    public static let defaults = DaemonSettings(
        autoRefreshEnabled: true,
        autoRefreshIntervalSeconds: 300,
        autoRefreshIntervalCustomized: false,
        pauseWhileActive: false,
        layout: DeckLayout.twoColumn.rawValue,
        defaultSort: DeckSortOrder.nextReset.rawValue,
        notificationThresholdPercent: 25,
        menuBarStyle: "icon-only",
        menuBarAccountId: "",
        menuBarShowWhen: "",
        deckHealthLabels: "",
        autoRenewEnabled: true,
        sharedUserScopeEnabled: false
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
        menuBarAccountId: String = "",
        menuBarShowWhen: String = "",
        deckHealthLabels: String = "",
        autoRenewEnabled: Bool = true,
        sharedUserScopeEnabled: Bool = false
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
        self.menuBarShowWhen = menuBarShowWhen
        self.deckHealthLabels = deckHealthLabels
        self.autoRenewEnabled = autoRenewEnabled
        self.sharedUserScopeEnabled = sharedUserScopeEnabled
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
        // Issue #238: absent on pre-#238 daemons → always shown (default).
        menuBarShowWhen = try container.decodeIfPresent(String.self, forKey: .menuBarShowWhen)
            ?? defaults.menuBarShowWhen
        // Issue #242: absent on pre-#242 daemons → dot only (default).
        deckHealthLabels = try container.decodeIfPresent(String.self, forKey: .deckHealthLabels)
            ?? defaults.deckHealthLabels
        autoRenewEnabled = try container.decodeIfPresent(Bool.self, forKey: .autoRenewEnabled)
            ?? defaults.autoRenewEnabled
        // Issue #204: absent on pre-#204 daemons → the opt-in default (off).
        sharedUserScopeEnabled = try container.decodeIfPresent(Bool.self, forKey: .sharedUserScopeEnabled)
            ?? defaults.sharedUserScopeEnabled
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

    /// Issue #238: typed view of `menuBarShowWhen`; every unrecognized
    /// stored value falls back to always shown.
    public var menuBarShowWhenMode: MenuBarShowWhen {
        MenuBarShowWhen.parse(menuBarShowWhen)
    }

    /// Issue #242: typed view of `deckHealthLabels`; every unrecognized
    /// stored value falls back to dot-only (the default).
    public var deckHealthLabelsMode: DeckHealthLabels {
        DeckHealthLabels.parse(deckHealthLabels)
    }
}

/// Issue #242: the stored `deckHealthLabels` setting's grammar — whether the
/// deck's Availability Health chips show the verdict word beside the
/// shape-coded dot. Two values today; a free string (not a Bool) so the key
/// keeps the same forward-compatible discipline as `menuBarShowWhen`:
/// unknown future values parse as the dot-only default, never a crash, and
/// a newer build's value round-trips through this build unclobbered.
public enum DeckHealthLabels: Equatable, Sendable {
    /// "" — dot only (the default, and what every unrecognized value
    /// degrades to). Accessible without the word: the dot's shape codes the
    /// verdict (`AvailabilityVerdictShape`), and the word stays one click
    /// away in the chip's detail popover.
    case dotOnly
    /// "show" — dot + verdict word, today's pre-#242 chip. The Settings →
    /// General → Accessibility "Show health verdict labels" toggle.
    case show

    public static let dotOnlyStored = ""
    public static let showStored = "show"

    /// The stored string for this case (round-trips through `parse`).
    public var stored: String {
        self == .show ? Self.showStored : Self.dotOnlyStored
    }

    /// Lenient parse: "" and every unrecognized value mean dot-only.
    public static func parse(_ stored: String) -> DeckHealthLabels {
        stored == showStored ? .show : .dotOnly
    }

    /// Whether the deck chip renders the verdict word beside the dot.
    public var showsVerdictWord: Bool { self == .show }
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
    /// Issue #238: the quiet-mode "when" value (`MenuBarShowWhen` grammar).
    /// Pre-#238 daemons reject unknown keys — SettingsSyncModel strips this
    /// field and retries when that happens (the #90/#123/#176 tolerance
    /// path).
    public var menuBarShowWhen: String?
    /// Issue #242: the deck chip labels value (`DeckHealthLabels` grammar).
    /// Pre-#242 daemons reject unknown keys — SettingsSyncModel strips this
    /// field and retries when that happens (the #90/#123/#176/#238
    /// tolerance path).
    public var deckHealthLabels: String?
    /// Issue #176: the auto-renew toggle. Pre-#176 daemons reject unknown
    /// keys — SettingsSyncModel strips this field and retries when that
    /// happens (the #90/#123 tolerance path).
    public var autoRenewEnabled: Bool?

    public init(
        autoRefreshEnabled: Bool? = nil,
        autoRefreshIntervalSeconds: Int? = nil,
        autoRefreshIntervalCustomized: Bool? = nil,
        pauseWhileActive: Bool? = nil,
        layout: String? = nil,
        defaultSort: String? = nil,
        notificationThresholdPercent: Int? = nil,
        menuBarStyle: String? = nil,
        menuBarAccountId: String? = nil,
        menuBarShowWhen: String? = nil,
        deckHealthLabels: String? = nil,
        autoRenewEnabled: Bool? = nil
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
        self.menuBarShowWhen = menuBarShowWhen
        self.deckHealthLabels = deckHealthLabels
        self.autoRenewEnabled = autoRenewEnabled
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
            menuBarAccountId: other.menuBarAccountId ?? menuBarAccountId,
            menuBarShowWhen: other.menuBarShowWhen ?? menuBarShowWhen,
            deckHealthLabels: other.deckHealthLabels ?? deckHealthLabels,
            autoRenewEnabled: other.autoRenewEnabled ?? autoRenewEnabled
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
        try container.encodeIfPresent(menuBarShowWhen, forKey: .menuBarShowWhen)
        try container.encodeIfPresent(deckHealthLabels, forKey: .deckHealthLabels)
        try container.encodeIfPresent(autoRenewEnabled, forKey: .autoRenewEnabled)
    }

    enum CodingKeys: String, CodingKey {
        case autoRefreshEnabled, autoRefreshIntervalSeconds, autoRefreshIntervalCustomized, pauseWhileActive
        case layout, defaultSort, notificationThresholdPercent, menuBarStyle, menuBarAccountId
        case menuBarShowWhen, deckHealthLabels, autoRenewEnabled
    }

    public var isEmpty: Bool {
        autoRefreshEnabled == nil && autoRefreshIntervalSeconds == nil
            && autoRefreshIntervalCustomized == nil && pauseWhileActive == nil
            && layout == nil && defaultSort == nil && notificationThresholdPercent == nil
            && menuBarStyle == nil && menuBarAccountId == nil
            && menuBarShowWhen == nil && deckHealthLabels == nil && autoRenewEnabled == nil
    }
}
