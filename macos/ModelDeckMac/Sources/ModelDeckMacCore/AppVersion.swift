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
        // Issue #705: Apple's short version stays numeric, while beta
        // comparisons need the prerelease suffix recorded by the release.
        display(of: bundle.object(forInfoDictionaryKey: "ModelDeckDisplayVersion"))
            ?? display(of: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString"))
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

    /// Issue #705: finals follow their prereleases; numeric identifiers
    /// compare numerically. Build metadata never changes version ordering.
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ version: String) -> [Substring] {
            normalized(tag: version).split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0]
                .split(separator: "-", maxSplits: 1)
        }
        func compare(_ l: String, _ r: String, prerelease: Bool = false) -> ComparisonResult {
            let ln = !l.isEmpty && l.allSatisfy { $0.isASCII && $0.isNumber }
            let rn = !r.isEmpty && r.allSatisfy { $0.isASCII && $0.isNumber }
            if ln && rn {
                let left = String(l.drop(while: { $0 == "0" }))
                let right = String(r.drop(while: { $0 == "0" }))
                if left.count != right.count { return left.count > right.count ? .orderedDescending : .orderedAscending }
                return left.compare(right)
            }
            if prerelease && ln != rn { return ln ? .orderedAscending : .orderedDescending }
            return prerelease ? l.compare(r) : l.caseInsensitiveCompare(r)
        }
        let lhs = parts(candidate), rhs = parts(current)
        let lc = lhs.first?.split(separator: ".") ?? [], rc = rhs.first?.split(separator: ".") ?? []
        for index in 0..<max(lc.count, rc.count) {
            let order = compare(index < lc.count ? String(lc[index]) : "0", index < rc.count ? String(rc[index]) : "0")
            if order != .orderedSame { return order == .orderedDescending }
        }
        if lhs.count != rhs.count { return lhs.count == 1 }
        guard lhs.count > 1 else { return false }
        let lp = lhs[1].split(separator: "."), rp = rhs[1].split(separator: ".")
        for index in 0..<min(lp.count, rp.count) {
            let order = compare(String(lp[index]), String(rp[index]), prerelease: true)
            if order != .orderedSame { return order == .orderedDescending }
        }
        return lp.count > rp.count
    }
}
