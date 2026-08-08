import SwiftUI

/// Issue #302 — THE dismiss affordance for the deck's header info space.
///
/// Tim on the old controls (2026-08-08): a bare thin "xmark" doesn't read
/// as dismiss ("I wouldn't even know that it's a dismiss X"), and anything
/// rendered in that space must be dismissible. One pattern, applied to
/// every dismissible header notice:
///
/// - `xmark.circle.fill` — the platform's clear/dismiss glyph (search
///   fields, tokens, notification close), hierarchical so the filled
///   circle stays quiet against the deck.
/// - Resting at reduced opacity, full secondary strength while the pointer
///   is anywhere over the notice. Faint-but-present rather than
///   hover-only: the control has to be discoverable to be legible, and a
///   fully hidden button is unreachable over VoiceOver, which has no
///   hover. Layout never shifts — only opacity animates.
/// - A "Dismiss…" tooltip and an accessibility label carry the words.
///
/// The wrapper owns hover tracking so call sites stay declarative: they
/// provide the notice's content (including any Spacer/actions — the
/// dismiss control always sits last) and the dismissal action; persistence
/// semantics belong to the caller's model, not to this view.
struct DismissibleHeaderNotice<Content: View>: View {
    let dismissHelp: String
    let dismissAccessibilityLabel: String
    let onDismiss: () -> Void
    @ViewBuilder var content: Content

    @State private var isHovering = false

    init(
        dismissHelp: String,
        dismissAccessibilityLabel: String,
        onDismiss: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.dismissHelp = dismissHelp
        self.dismissAccessibilityLabel = dismissAccessibilityLabel
        self.onDismiss = onDismiss
        self.content = content()
    }

    var body: some View {
        HStack(spacing: 6) {
            content

            Button(action: onDismiss) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 12, weight: .regular))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
                    .opacity(isHovering ? 1.0 : 0.4)
                    // 16pt centred target around the 12pt glyph — `.frame`
                    // then `.contentShape(Rectangle())`, the PR #271-measured
                    // pattern (`Rectangle().size(...)` re-anchors at the
                    // rect's origin and drifts the target off the glyph).
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(dismissHelp)
            .accessibilityLabel(dismissAccessibilityLabel)
        }
        .onHover { isHovering = $0 }
        .animation(.easeInOut(duration: 0.12), value: isHovering)
    }
}
