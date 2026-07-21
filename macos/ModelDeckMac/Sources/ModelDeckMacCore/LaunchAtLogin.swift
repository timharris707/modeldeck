import Combine
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

/// Shared observable state for the two "Launch at Login" toggles (popover
/// gear menu + General settings pane). `SMAppService.status` is an XPC
/// round-trip, so it must never run inside a view-struct initializer — the
/// App body reconstructs those structs on every evaluation. This model is
/// created once, reads the status once via `load()` (from a view's .task),
/// and both toggles bind to the same published value.
@MainActor
public final class LaunchAtLoginModel: ObservableObject {
    @Published public private(set) var isEnabled = false
    @Published public private(set) var lastError: String?

    private let readEnabled: () -> Bool
    private let writeEnabled: (Bool) throws -> Void
    private var hasLoaded = false

    public init(
        readEnabled: @escaping () -> Bool = { LaunchAtLogin.isEnabled },
        writeEnabled: @escaping (Bool) throws -> Void = { try LaunchAtLogin.setEnabled($0) }
    ) {
        self.readEnabled = readEnabled
        self.writeEnabled = writeEnabled
    }

    /// One status read per app session, deferred off the render path.
    public func load() {
        guard !hasLoaded else { return }
        hasLoaded = true
        isEnabled = readEnabled()
    }

    public func setEnabled(_ enabled: Bool) {
        guard enabled != isEnabled else { return }
        do {
            try writeEnabled(enabled)
            isEnabled = enabled
            lastError = nil
        } catch {
            // Registration fails from a bare `swift run` binary — surface
            // the error and snap back to the service's actual status.
            lastError = error.localizedDescription
            isEnabled = readEnabled()
        }
    }
}
