import Foundation

/// Issue #45 (bug 2): pure identification of the SwiftUI `Settings` scene
/// window among `NSApp.windows`, kept in Core so it is unit-testable.
///
/// SwiftUI stamps the Settings window with the identifier
/// `com_apple_SwiftUI_Settings_window` (observed on macOS 14/15); the title
/// carries the localized "… Settings" as a fallback for future identifier
/// churn. Matching is deliberately loose — this only ever picks a window to
/// bring to the FRONT, so a false positive is harmless while a false
/// negative leaves the window buried behind other apps.
public enum SettingsWindowMatcher {
    public static func matches(identifier: String?, title: String) -> Bool {
        if let identifier, identifier.range(of: "settings", options: .caseInsensitive) != nil {
            return true
        }
        return localizedSettingsTitles.contains { title.range(of: $0, options: .caseInsensitive) != nil }
    }

    /// Localized "Settings" window-title markers for the fallback path. The
    /// identifier match above is the primary, nonlocalized signal; this list
    /// covers the common localizations if the identifier ever churns.
    /// Loose matching stays harmless (front-only, see doc comment above).
    static let localizedSettingsTitles: [String] = [
        "settings", "einstellungen", "réglages", "reglages", "ajustes",
        "impostazioni", "instellingen", "inställningar", "indstillinger",
        "innstillinger", "definições", "configurações", "ustawienia",
        "設定", "설정", "设置", "налаштування", "настройки",
    ]
}
