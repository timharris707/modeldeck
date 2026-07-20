import Foundation

// Issue #33 — the app's own version, rendered in the popover footer and the
// Settings → General "ModelDeck" section.
//
// VERSION AUTHORITY (the issue asked for one documented decision): the Git
// release tag is the single source of truth. The release pipeline stamps it
// into BOTH Support/Info.plist (`CFBundleShortVersionString`, via
// Scripts/build_app.sh) and package.json (which /api/health reports as the
// daemon's `version`). At runtime the app displays only its own bundle
// version; the daemon's health `version` describes the daemon process and is
// never rendered as the app version — after an app update the two can
// legitimately differ until the daemon restarts, and pretending otherwise
// would lie about which binary is running.
public enum AppVersion {
    /// The running app's marketing version from the bundle, or nil when
    /// there is no bundle version (bare `swift run` development builds).
    /// Callers degrade honestly on nil rather than inventing a number.
    public static func current(bundle: Bundle = .main) -> String? {
        display(of: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString"))
    }

    /// Pure derivation seam for `current(bundle:)` — normalizes whatever the
    /// info dictionary carried into a non-empty version string, or nil.
    public static func display(of infoValue: Any?) -> String? {
        guard let raw = infoValue as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Muted footer text: "v0.2.0". Nil in, nil out.
    public static func footerText(for version: String?) -> String? {
        version.map { "v\($0)" }
    }

    /// "v0.2.0" / "V0.2.0" release tags → "0.2.0"; already-bare stays as-is.
    public static func normalized(tag: String) -> String {
        let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("v"), trimmed.count > 1,
           trimmed[trimmed.index(after: trimmed.startIndex)].isNumber {
            return String(trimmed.dropFirst())
        }
        return trimmed
    }

    /// Dotted-numeric comparison: true when `candidate` is a strictly newer
    /// version than `current`. Missing segments read as 0 ("1.2" == "1.2.0");
    /// non-numeric segments fall back to case-insensitive string comparison
    /// so unexpected tags still order deterministically.
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        let lhs = normalized(tag: candidate).split(separator: ".")
        let rhs = normalized(tag: current).split(separator: ".")
        for index in 0..<max(lhs.count, rhs.count) {
            let l = index < lhs.count ? String(lhs[index]) : "0"
            let r = index < rhs.count ? String(rhs[index]) : "0"
            if let ln = Int(l), let rn = Int(r) {
                if ln != rn { return ln > rn }
            } else if l.caseInsensitiveCompare(r) != .orderedSame {
                return l.caseInsensitiveCompare(r) == .orderedDescending
            }
        }
        return false
    }
}
