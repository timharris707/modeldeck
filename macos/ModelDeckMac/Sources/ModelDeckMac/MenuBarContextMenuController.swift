import AppKit
import ModelDeckMacCore

/// Issue #59 — right-click (or ctrl-click) on the menu bar icon presents a
/// small context menu: Check for App Updates… and Quit ModelDeck. As a
/// menu-bar agent app the icon is ModelDeck's only persistent surface, so
/// it must carry the standard quit affordance.
///
/// `MenuBarExtra` offers no native hook for a secondary click, so a local
/// event monitor watches for right/ctrl-clicks landing in the status item's
/// window (the same StatusBar-window identification the issue #45
/// diagnostics use — those windows live in this process, so the monitor
/// sees the events) and swallows them in favor of an NSMenu. Plain left
/// clicks pass through untouched: the popover toggle is unaffected.
@MainActor
final class MenuBarContextMenuController: NSObject {
    private let appUpdateModel: AppUpdateModel
    /// Issue #121: "Update Now" from the context-menu result alert drives
    /// the same shared install model as the deck dialog and Settings.
    private let installModel: AppUpdateInstallModel
    private var monitor: Any?

    init(appUpdateModel: AppUpdateModel, installModel: AppUpdateInstallModel) {
        self.appUpdateModel = appUpdateModel
        self.installModel = installModel
    }

    /// Installs the event monitor once; safe to call repeatedly. The
    /// controller lives for the app's lifetime, so the monitor is never
    /// removed.
    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.rightMouseDown, .leftMouseDown]
        ) { [weak self] event in
            // Local event monitors always fire on the main thread; Swift 6
            // treats the closure as nonisolated, so assert the hop. The
            // closure returns Bool because NSEvent is not Sendable.
            let handled = MainActor.assumeIsolated {
                guard let self,
                      Self.isStatusItemEvent(event),
                      MenuBarContextMenu.isContextMenuTrigger(
                          isRightClick: event.type == .rightMouseDown,
                          isControlDown: event.modifierFlags.contains(.control)
                      )
                else { return false }
                self.present(with: event)
                return true
            }
            return handled ? nil : event
        }
    }

    /// Whether the event landed in a status bar item's window.
    private static func isStatusItemEvent(_ event: NSEvent) -> Bool {
        guard let window = event.window else { return false }
        return String(describing: type(of: window)).contains("StatusBar")
    }

    private func present(with event: NSEvent) {
        guard let view = event.window?.contentView else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in MenuBarContextMenu.items(isCheckingForUpdates: appUpdateModel.isChecking) {
            if item.action == .quit, !menu.items.isEmpty {
                menu.addItem(.separator())
            }
            let menuItem = NSMenuItem(title: item.title, action: nil, keyEquivalent: "")
            menuItem.target = self
            menuItem.isEnabled = item.isEnabled
            switch item.action {
            case .checkForAppUpdates:
                menuItem.action = #selector(checkForAppUpdates)
            case .quit:
                menuItem.action = #selector(quit)
            }
            menu.addItem(menuItem)
        }
        NSMenu.popUpContextMenu(menu, with: event, for: view)
    }

    /// Same flow as the gear menu's item: run the shared AppUpdateModel and
    /// present the standard result dialog (as an NSAlert here — no SwiftUI
    /// presentation context exists for a status-item context menu).
    @objc private func checkForAppUpdates() {
        Task { @MainActor [appUpdateModel, installModel] in
            await appUpdateModel.check()
            SettingsWindowFronting.activateForDialog()
            Self.presentResultAlert(appUpdateModel.resultDialog, installModel: installModel)
        }
    }

    private static func presentResultAlert(
        _ dialog: AppUpdateModel.ResultDialog?,
        installModel: AppUpdateInstallModel
    ) {
        guard let dialog else { return }
        let alert = NSAlert()
        alert.messageText = dialog.title
        alert.informativeText = dialog.message
        if dialog.offersInstall, let releaseURL = dialog.releaseURL {
            // Issue #121: Update Now primary, release page secondary.
            alert.addButton(withTitle: "Update Now")
            alert.addButton(withTitle: "Release Notes")
            alert.addButton(withTitle: "Cancel")
            switch alert.runModal() {
            case .alertFirstButtonReturn:
                installModel.updateNow()
            case .alertSecondButtonReturn:
                NSWorkspace.shared.open(releaseURL)
            default:
                break
            }
        } else if let releaseURL = dialog.releaseURL {
            alert.addButton(withTitle: "View Release")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(releaseURL)
            }
        } else {
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
