import AppKit
import ModelDeckMacCore
import SwiftUI

// Issue #163 — clicking Update Now must transition the dialog IN PLACE to a
// progress surface (Tim, from the live 0.3.4→0.3.5 update: "All I see is
// that it still says 'Click to update', so from a user's perspective, it's
// not working"). One dialog view renders every stage of the shared
// AppUpdateInstallModel; the deck gear menu and the status-item context
// menu both present it in the same floating panel, and Settings → General
// embeds the same progress surface inline. Single source of truth
// throughout: AppUpdateInstallModel.phase.

/// The in-flight progress surface: stage copy + progress bar (determinate
/// when Sparkle reports a fraction), plus Cancel exactly while Sparkle
/// permits cancellation (checking/downloading — model.canCancel).
struct AppUpdateInstallProgressView: View {
    @ObservedObject var installModel: AppUpdateInstallModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if let fraction = AppUpdateInstallModel.progressFraction(for: installModel.phase) {
                    ProgressView(value: fraction)
                        .progressViewStyle(.linear)
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                }
                if installModel.canCancel {
                    Button("Cancel") { installModel.cancelUpdate() }
                        .controlSize(.small)
                        .help("Stops the update. Nothing is changed; you can start it again any time.")
                }
            }
            if let status = AppUpdateInstallModel.statusText(for: installModel.phase) {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The update dialog. Renders the found-update offer, then — on Update Now
/// — transitions in place through downloading/verifying/installing/
/// relaunching; failures land back on an actionable state with the error
/// visible and a Try Again.
struct AppUpdateDialogView: View {
    let dialog: AppUpdateModel.ResultDialog
    @ObservedObject var installModel: AppUpdateInstallModel
    let onDismiss: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            content
            buttons
        }
        .padding(16)
        .frame(width: 360, alignment: .leading)
    }

    private var title: String {
        switch installModel.phase {
        case .idle, .installedPendingRelaunch:
            return dialog.title
        case .checking, .downloading, .extracting, .installing, .relaunching:
            return "Updating ModelDeck"
        case .failed:
            return "Update failed"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch installModel.phase {
        case .idle:
            Text(dialog.message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        case .checking, .downloading, .extracting, .installing, .relaunching:
            AppUpdateInstallProgressView(installModel: installModel)
        case .installedPendingRelaunch:
            if let status = AppUpdateInstallModel.statusText(for: installModel.phase) {
                Text(status)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .failed(let message):
            Text(message)
                .font(.callout)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var buttons: some View {
        HStack {
            switch installModel.phase {
            case .idle:
                if dialog.offersInstall, let releaseURL = dialog.releaseURL {
                    // Issue #121 (Tim directive 2026-07-22): Update Now
                    // primary; the release page demotes to "Release Notes".
                    Button("Release Notes") { openURL(releaseURL) }
                    Spacer()
                    Button("Cancel") { onDismiss() }
                        .keyboardShortcut(.cancelAction)
                    // Issue #163: the dialog STAYS OPEN — the click swaps
                    // this button row for the progress surface in place.
                    Button("Update Now") { installModel.updateNow() }
                        .keyboardShortcut(.defaultAction)
                        .help("Downloads, verifies, and installs the update, then relaunches ModelDeck.")
                } else if let releaseURL = dialog.releaseURL {
                    Spacer()
                    Button("Cancel") { onDismiss() }
                        .keyboardShortcut(.cancelAction)
                    Button("View Release") {
                        openURL(releaseURL)
                        onDismiss()
                    }
                    .keyboardShortcut(.defaultAction)
                } else {
                    Spacer()
                    Button("OK") { onDismiss() }
                        .keyboardShortcut(.defaultAction)
                }
            case .checking, .downloading, .extracting, .installing, .relaunching:
                // In-flight: Cancel lives inside the progress surface (only
                // while Sparkle permits). "Hide" merely closes this dialog —
                // the install continues and keeps reporting in the deck
                // header line and Settings → General.
                Spacer()
                Button("Hide") { onDismiss() }
                    .help("Closes this dialog. The update keeps going; progress stays visible in the deck and in Settings → General.")
            case .installedPendingRelaunch:
                Spacer()
                Button("OK") { onDismiss() }
                    .keyboardShortcut(.defaultAction)
            case .failed:
                if let releaseURL = dialog.releaseURL {
                    Button("Release Notes") { openURL(releaseURL) }
                }
                Spacer()
                Button("Close") { onDismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Try Again") { installModel.updateNow() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}

/// Floating-panel presenter for the update dialog — the shared presentation
/// for both surfaces without a stable SwiftUI presentation context (the
/// deck popover, which auto-closes on focus loss, and the status-item
/// context menu). The panel survives the popover closing, so download →
/// verify → install → relaunch stays visibly on screen to completion.
@MainActor
enum AppUpdateDialogPanel {
    private static var panel: NSPanel?

    static func present(dialog: AppUpdateModel.ResultDialog, installModel: AppUpdateInstallModel) {
        dismiss()
        let host = NSHostingController(
            rootView: AppUpdateDialogView(
                dialog: dialog,
                installModel: installModel,
                onDismiss: { AppUpdateDialogPanel.dismiss() }
            )
        )
        host.sizingOptions = [.preferredContentSize]
        let panel = NSPanel(contentViewController: host)
        panel.styleMask = [.titled, .closable]
        panel.title = "ModelDeck Update"
        panel.titlebarAppearsTransparent = true
        panel.isReleasedWhenClosed = false
        // Issue #170 (0.3.6 regression): NSPanel defaults hidesOnDeactivate
        // to YES, and ModelDeck is an accessory app whose activation is
        // transient — the deck popover closing (or any click elsewhere)
        // deactivates the app, which silently hid this panel the instant it
        // appeared. Tim, live: "it's just disappearing without giving me any
        // feedback whatsoever." An explicit check's outcome stays on screen
        // until the user dismisses it, exactly like the pre-#163 NSAlert.
        panel.hidesOnDeactivate = false
        panel.level = .floating
        // Accessory-activation pitfall (#45): activate so the panel comes
        // up in front of whatever app was frontmost.
        SettingsWindowFronting.activateForDialog()
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        Self.panel = panel
    }

    static func dismiss() {
        panel?.close()
        panel = nil
    }
}
