import AppKit
import SwiftUI
import ModelDeckMacCore

/// Issue #8 — the three-step add-account sheet (spec "Add account",
/// mockups §05). The view is deliberately thin: all decisions live in
/// `AddAccountModel` (ModelDeckMacCore), which is unit tested.
struct AddAccountSheet: View {
    @ObservedObject var model: AddAccountModel
    @Environment(\.dismiss) private var dismiss

    @State private var provider: DeckProvider = .claude
    @State private var label: String = ""
    @State private var purpose: String = ""
    @State private var color: Color = Color(hexString: "#d97757") ?? .accentColor
    @State private var colorEdited = false
    @State private var confirmingCancel = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            switch model.step {
            case .details: detailsStep
            case .signIn: signInStep
            case .confirm: confirmStep
            }
            if let error = model.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer
        }
        .padding(18)
        .frame(width: 420)
        .onAppear { model.reset() }
        .confirmationDialog(
            "Keep \(model.account?.label ?? "the new account")?",
            isPresented: $confirmingCancel,
            titleVisibility: .visible
        ) {
            Button("Keep — sign in later") {
                Task {
                    if await model.cancel(discardAccount: false) { dismiss() }
                }
            }
            Button("Remove it", role: .destructive) {
                Task {
                    // Only dismiss when the reference removal succeeded; on
                    // failure the sheet stays open showing model.lastError.
                    if await model.cancel(discardAccount: true) { dismiss() }
                }
            }
            Button("Continue setup", role: .cancel) {}
        } message: {
            Text("Removing deletes only ModelDeck's reference. Provider credentials are never touched.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.headline)
            Text("Step \(stepNumber) of 3")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Step 1 — provider + label + purpose + color

    private var detailsStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Form {
                Picker("Provider", selection: $provider) {
                    ForEach(DeckProvider.allCases, id: \.self) { provider in
                        Text(provider.displayName).tag(provider)
                    }
                }
                .onChange(of: provider) { _, newValue in
                    guard !colorEdited else { return }
                    color = Color(hexString: newValue == .claude ? "#d97757" : "#48a868") ?? .accentColor
                }
                TextField("Label", text: $label, prompt: Text("e.g. Side Project"))
                TextField("Purpose", text: $purpose, prompt: Text("e.g. client work"))
                ColorPicker("Color", selection: $color, supportsOpacity: false)
                    .onChange(of: color) { _, _ in colorEdited = true }
            }
            Text("ModelDeck creates an isolated, owner-only profile home for this account. Sign-in happens next, in \(provider.displayName)'s own flow — ModelDeck never sees or stores credentials.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Step 2 — the provider's own sign-in

    private var signInStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Terminal is running \(providerDisplayName)'s login for this profile. Complete the sign-in in your browser exactly as normal, then come back here.")
                .fixedSize(horizontal: false, vertical: true)
            if model.didActivateForLogin {
                // Issue #99: current Claude Code stores the credential in
                // whichever profile is active, so the flow flipped
                // activation to the new profile for this sign-in.
                Text("ModelDeck activated this profile so the sign-in lands in the right account (required by current \(providerDisplayName) versions). If another profile was active, it's restored after verification.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let command = model.loginCommand {
                GroupBox {
                    HStack(alignment: .top) {
                        Text(command)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(command, forType: .string)
                        }
                        .controlSize(.small)
                    }
                }
            }
            HStack {
                Button("Open Terminal Again") { model.launchLogin() }
                    .controlSize(.small)
            }
            Text("The browser OAuth flow belongs to the provider. ModelDeck only checks the sign-in state afterwards — it never runs a logout on any profile.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Step 3 — verify & land

    private var confirmStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text(model.identity.map { "Signed in as \($0)" }
                    ?? "Signed in. (\(providerDisplayName) didn't report an identity.)")
                    .font(.system(size: 13, weight: .semibold))
            }
            Text("\(model.account?.label ?? "The account") is in the deck. Its first usage snapshot has been requested; the popover updates as soon as it lands.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let warning = model.completionWarning {
                Text(warning)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var footer: some View {
        HStack {
            if model.isBusy {
                ProgressView().controlSize(.small)
            }
            Spacer()
            switch model.step {
            case .details:
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create & Sign In") {
                    Task {
                        await model.begin(
                            provider: provider,
                            label: label,
                            purpose: purpose,
                            colorHex: color.hexString
                        )
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isBusy
                    || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            case .signIn:
                Button("Cancel") { confirmingCancel = true }
                    .keyboardShortcut(.cancelAction)
                Button("I've Signed In — Verify") {
                    Task { await model.confirmSignedIn() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isBusy)
            case .confirm:
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private var providerDisplayName: String {
        model.account.flatMap { DeckProvider.from($0.provider)?.displayName } ?? provider.displayName
    }

    private var title: String {
        switch model.step {
        case .details: return "Add Account"
        case .signIn: return "Sign in to \(providerDisplayName)"
        case .confirm: return "Account added"
        }
    }

    private var stepNumber: Int {
        switch model.step {
        case .details: return 1
        case .signIn: return 2
        case .confirm: return 3
        }
    }
}
