import AppKit
import SwiftUI
import ModelDeckMacCore

// Issue #422 — UI for the first-launch flow. Deliberately thin: every word
// and every branch lives in ModelDeckMacCore's tested decision logic, and
// these views only render it.
//
// Popover: ONE calm card, never a wizard — either the adoption offer or the
// consent screen, one primary action and one honest alternative, and then the
// visible record of what adoption did.
//
// Settings → General: the choice, revisitable — the upgrade path from a
// decline, the "stop managing" rollback, and the restore steps it prints.

extension ManagedProxyOnboardingModel.Phase {
    /// Phases the popover card presents. `.hidden` is the steady state.
    var needsPopoverCard: Bool {
        if case .hidden = self { return false }
        return true
    }
}

struct ManagedProxyOnboardingCard: View {
    @ObservedObject var model: ManagedProxyOnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch model.phase {
            case .adoptionOffer(let detection):
                adoptionOffer(detection)
            case .working(let message):
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            case .record(let record):
                recordView(record)
            case .consent:
                consent
            case .hidden:
                EmptyView()
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: Branch 1 — adoption

    private func adoptionOffer(_ detection: ExternalProxyDetection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(ManagedProxyOnboardingCopy.adoptionTitle, systemImage: "arrow.triangle.swap")
                .font(.system(size: 13, weight: .semibold))
            Text(adoptionBody(detection))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(ManagedProxyOnboardingCopy.adoptButtonTitle) {
                    Task { await model.adopt() }
                }
                .keyboardShortcut(.defaultAction)
                Button(ManagedProxyOnboardingCopy.declineAdoptionButtonTitle) {
                    model.declineAdoption()
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(ManagedProxyOnboardingCopy.coexistUnavailableReason)
                // A tooltip never reaches VoiceOver (PR #433 review): the
                // decline's honest cost must be spoken too.
                .accessibilityHint(ManagedProxyOnboardingCopy.coexistUnavailableReason)
            }
        }
    }

    /// The unconfirmed case says so in its own words — never the confident
    /// copy over an uncertain detection.
    private func adoptionBody(_ detection: ExternalProxyDetection) -> String {
        switch detection {
        case .cliProxyAPI:
            return ManagedProxyOnboardingCopy.adoptionConfirmedBody
        case .unidentifiedListener(let reason):
            return "\(reason)\n\n\(ManagedProxyOnboardingCopy.adoptionUnidentifiedBody)"
        case .absent:
            return ManagedProxyOnboardingCopy.adoptionConfirmedBody
        }
    }

    /// The never-silent record: what was stopped, by what command, and where
    /// the configuration stayed.
    private func recordView(_ record: AdoptionRecord) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(record.headline, systemImage: record.succeeded ? "checkmark.circle" : "exclamationmark.triangle")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(record.succeeded ? Color.primary : Color.orange)
            ForEach(Array(record.lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Done") { model.dismissRecord() }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .font(.caption)
        }
    }

    // MARK: Branch 2 — consent

    private var consent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(ManagedProxyOnboardingCopy.consentTitle, systemImage: "chart.bar.doc.horizontal")
                .font(.system(size: 13, weight: .semibold))
            Text(ManagedProxyOnboardingCopy.consentBody)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                // Pre-selected (tier-3 default, charter d4): one click, or
                // just Return.
                Button(ManagedProxyOnboardingCopy.consentEnableTitle) {
                    Task { await model.enableManagedProxy() }
                }
                .keyboardShortcut(.defaultAction)
                Button(ManagedProxyOnboardingCopy.consentDeclineTitle) {
                    model.declineManagedProxy()
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(ManagedProxyOnboardingCopy.consentDeclinedReason)
                .accessibilityHint(ManagedProxyOnboardingCopy.consentDeclinedReason)
            }
        }
    }
}

/// Settings → General: the recorded choice and the two ways to change it.
/// This is the "revisitable, never re-prompted" half of the flow.
struct ManagedProxySection: View {
    @ObservedObject var model: ManagedProxyOnboardingModel
    /// Hidden entirely in dev builds with no proxy to manage.
    let available: Bool
    @State private var confirmingStop = false

    @ViewBuilder
    var body: some View {
        if available {
            Section(ManagedProxyOnboardingCopy.settingsSectionTitle) {
                // Issue #784: in remote role the line is the daemon's reason
                // and there is nothing here to enable or stop.
                Text(ManagedProxyOnboardingCopy.settingsSummary(for: model.choice, role: model.proxyRole))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if managedProxySettingsOffersActions(role: model.proxyRole) {
                    if model.choice?.wantsManagedProxy == true {
                        stopManaging
                    } else {
                        Button(ManagedProxyOnboardingCopy.enableFromSettingsTitle) {
                            Task { await model.enableFromSettings() }
                        }
                    }
                }
                if let instructions = model.restoreInstructions {
                    restoreSteps(instructions)
                }
            }
        }
    }

    private var stopManaging: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ManagedProxyOnboardingCopy.stopManagingExplanation)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if confirmingStop {
                HStack {
                    Button("Stop Managing the Proxy") {
                        confirmingStop = false
                        Task { await model.stopManagingProxy() }
                    }
                    Button("Cancel") { confirmingStop = false }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                }
            } else {
                Button(ManagedProxyOnboardingCopy.stopManagingTitle) { confirmingStop = true }
            }
        }
    }

    /// Honest-uninstall style: the literal commands, copyable, plus what did
    /// NOT move.
    private func restoreSteps(_ instructions: RestoreInstructions) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(instructions.headline)
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(instructions.steps.enumerated()), id: \.offset) { _, step in
                Text(step)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let note = instructions.note {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if !instructions.steps.isEmpty {
                    Button("Copy Commands") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(instructions.clipboardText, forType: .string)
                    }
                }
                Button("Dismiss") { model.dismissRestoreInstructions() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
