import Foundation

// Issue #194 — statusline capture (#174) gets a VISIBLE per-row control.
// Field report (Tim, 2026-07-31): the opt-in lived only inside the
// hover-revealed ⋯ menu, so it sat uninstalled on all 5 profiles for a week
// and the resulting staleness read as "the tracker is broken". The selection
// logic and the pinned #174 copy live here (pure, testable); the Settings
// row renders whatever `display` says and nothing else.

/// Which statusline-capture affordance a Settings roster row shows, if any.
public enum StatuslineCaptureControl {
    public enum Display: Equatable, Sendable {
        /// Capture is off: the discoverable "Capture usage" action.
        case enable
        /// Capture is on: the quiet confirmation pill (click turns it off).
        case installed
        /// An install/uninstall request is in flight: spinner on the control.
        case busy
    }

    /// The row's control state. Strictly limited to Claude accounts whose
    /// daemon reported the `claudeStatusline` opt-in state — a nil object
    /// (old daemon, Codex account) renders NO control at all, busy included:
    /// the #174 daemon-version-skew precedent, so an old daemon can never
    /// grow a control whose endpoint it doesn't serve.
    public static func display(for account: DeckAccount, isBusy: Bool = false) -> Display? {
        guard account.provider == "claude",
              let statusline = account.claudeStatusline
        else { return nil }
        if isBusy { return .busy }
        return statusline.installed ? .installed : .enable
    }

    // MARK: - Pinned #174 copy (single source)
    //
    // These are the EXACT help strings the ⋯ menu toggle has carried since
    // #174; the visible control reuses them verbatim so the two paths can
    // never drift apart.

    /// Tooltip while capture is OFF (what enabling does).
    public static let enableHelp = "Adds a small statusline step to this profile that records Claude's own rate-limit numbers whenever the account is in use — no credentials, no extra API calls. Any statusline you already use keeps working unchanged."

    /// Tooltip while capture is ON (what's happening, how to undo).
    public static let installedHelp = "ModelDeck updates this account's usage from Claude Code's statusline data whenever the profile is in use. Turning this off restores the profile's previous statusline configuration."

    /// The ⋯ menu toggle's label (unchanged #174 wording; the menu entry
    /// stays as the second path, consistent with Edit/Remove).
    public static let menuToggleLabel = "Capture usage from Claude Code statusline"

    /// The visible control's short labels — small-row real estate, calm.
    public static let enableLabel = "Capture usage"
    public static let installedLabel = "Capturing"
}
