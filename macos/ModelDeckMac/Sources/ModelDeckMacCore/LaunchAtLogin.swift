import Foundation
import ServiceManagement

/// Launch-at-login via SMAppService. Only meaningful when running from an
/// assembled .app bundle (Scripts/build_app.sh); from a bare `swift run`
/// binary registration fails and the error is surfaced, not swallowed.
public enum LaunchAtLogin {
    public static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    public static func setEnabled(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}
