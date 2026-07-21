import SwiftUI
import ModelDeckMacCore

// Issue #96 — UI for the bundled background service lifecycle.
//
// Popover: a single calm card for the first-run states (consent, declined,
// installing, awaiting Login Items approval, starting up, failed, legacy
// stopped). One primary action, one quiet dismissal — no dark patterns:
// declining leaves an honest "service not installed" state with a Retry.
//
// Settings → General: a "Background service" section mirroring the status,
// plus the ONLY place the legacy-LaunchAgent takeover can be triggered.

extension DaemonSetupModel.Phase {
    /// Phases the popover card presents. `.quiet`/`.idle`/`.checking` stay
    /// invisible; the existing deck UI owns those moments.
    var needsPopoverCard: Bool {
        switch self {
        case .idle, .checking, .quiet: return false
        case .consentNeeded, .declined, .installing, .awaitingApproval,
             .startingUp, .legacyNotRunning, .failed: return true
        }
    }
}

struct DaemonSetupCard: View {
    @ObservedObject var model: DaemonSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch model.phase {
            case .consentNeeded:
                consent
            case .declined:
                declined
            case .installing:
                progressRow("Installing background service…")
                keychainCoachingIfActive
            case .awaitingApproval:
                awaitingApproval
                keychainCoachingIfActive
            case .startingUp:
                startingUp
                keychainCoachingIfActive
            case .legacyNotRunning:
                legacyNotRunning
            case .failed(let message):
                failed(message)
            case .idle, .checking, .quiet:
                EmptyView()
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: States

    private var consent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("ModelDeck needs its local background service", systemImage: "gearshape.2")
                .font(.system(size: 13, weight: .semibold))
            Text("A small helper keeps your usage numbers fresh. It runs only on this Mac, listens only on 127.0.0.1, and sends nothing anywhere else. It's added as a standard Login Item you can remove any time in System Settings.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // Issue #98: frame the Login Items approval BEFORE macOS throws
            // its unexplained system prompt (the hand-test's roughest edge).
            Text(SystemPromptCoaching.loginItemsConsentNote)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Install Background Service") {
                    Task { await model.consentToInstall() }
                }
                .keyboardShortcut(.defaultAction)
                Button("Not Now") { model.decline() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var declined: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Background service not installed", systemImage: "moon.zzz")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Text("Usage can't refresh without it.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Install Background Service") {
                Task { await model.consentToInstall() }
            }
        }
    }

    private var awaitingApproval: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Waiting for your approval", systemImage: "hand.raised")
                .font(.system(size: 12, weight: .medium))
            Text("macOS wants you to allow ModelDeck's background service in System Settings → General → Login Items.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Open Login Items") {
                    SMAppServiceAgentRegistrar.openLoginItemsSettings()
                }
                Button("Check Again") { Task { await model.retry() } }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var startingUp: some View {
        VStack(alignment: .leading, spacing: 6) {
            progressRow("Background service starting…")
            Button("Check Again") { Task { await model.retry() } }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
        }
    }

    private var legacyNotRunning: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("ModelDeck service not responding", systemImage: "exclamationmark.triangle")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.orange)
            Text("A previously installed ModelDeck service (developer install) exists but isn't answering. You can retry, or switch to the app's bundled service in Settings → General.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Retry") { Task { await model.retry() } }
        }
    }

    private func failed(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Background service setup failed", systemImage: "exclamationmark.triangle")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try Again") { Task { await model.retry() } }
        }
    }

    /// Issue #98: the calm Keychain heads-up shown while a fresh install is
    /// in flight — BEFORE the daemon's first refresh triggers the per-
    /// account macOS Keychain prompts. Only rendered on the install path
    /// this session (never on plain launch evaluation or drift updates).
    @ViewBuilder
    private var keychainCoachingIfActive: some View {
        if model.keychainPromptCoachingActive {
            VStack(alignment: .leading, spacing: 3) {
                Label(SystemPromptCoaching.keychainHeadline, systemImage: "key")
                    .font(.system(size: 11, weight: .medium))
                Text(SystemPromptCoaching.keychainBody)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 2)
        }
    }

    private func progressRow(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// Settings → General section: current service state, install affordance
/// when relevant, the subtle drift-update note, and the legacy takeover.
struct BackgroundServiceSection: View {
    @ObservedObject var model: DaemonSetupModel
    @State private var confirmingTakeover = false

    @ViewBuilder
    var body: some View {
        // Hidden entirely in dev builds without a bundled daemon.
        if model.bundledServiceAvailable {
            Section("Background service") {
                statusRow
                if model.didReregisterForUpdate {
                    Text("Service updated to match this app version.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if model.legacyAgentPresent {
                    takeover
                }
            }
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch model.phase {
        case .quiet:
            LabeledContent("Status") { Text("Running").foregroundStyle(.secondary) }
        case .idle, .checking:
            LabeledContent("Status") { Text("Checking…").foregroundStyle(.secondary) }
        case .installing:
            LabeledContent("Status") { Text("Installing…").foregroundStyle(.secondary) }
        case .startingUp:
            LabeledContent("Status") { Text("Starting…").foregroundStyle(.secondary) }
        case .awaitingApproval:
            LabeledContent("Status") { Text("Waiting for Login Items approval").foregroundStyle(.orange) }
            Button("Open Login Items") {
                SMAppServiceAgentRegistrar.openLoginItemsSettings()
            }
        case .consentNeeded, .declined:
            LabeledContent("Status") { Text("Not installed").foregroundStyle(.secondary) }
            Button("Install Background Service") {
                Task { await model.consentToInstall() }
            }
        case .legacyNotRunning:
            LabeledContent("Status") { Text("Developer install not responding").foregroundStyle(.orange) }
        case .failed(let message):
            LabeledContent("Status") { Text("Setup failed").foregroundStyle(.orange) }
            Text(message).font(.caption).foregroundStyle(.secondary)
            Button("Try Again") { Task { await model.retry() } }
        }
    }

    private var takeover: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("A developer install of the ModelDeck service (from scripts/install-launch-agent.sh) is present. The app never runs two services; switching removes the developer install and uses the service bundled with this app.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Use Bundled Service…") { confirmingTakeover = true }
                .confirmationDialog(
                    "Switch to the bundled background service?",
                    isPresented: $confirmingTakeover
                ) {
                    Button("Switch") { Task { await model.adoptBundledService() } }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The developer LaunchAgent will be unloaded and its plist removed, then the app's bundled service is registered. Your data and settings are untouched.")
                }
        }
    }
}
