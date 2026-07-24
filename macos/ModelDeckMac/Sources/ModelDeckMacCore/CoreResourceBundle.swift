import Foundation
import os

/// Explicit resolver for the ModelDeckMacCore SwiftPM resource bundle
/// (issue #158, escalation of #151 / public report modeldeck#1).
///
/// Why `Bundle.module` cannot be trusted in a shipped app: plain
/// `swift build` generates a two-candidate accessor — the app ROOT
/// (`Bundle.main.bundleURL` + bundle name, where nothing is ever staged;
/// placing resources there would also violate bundle structure for
/// codesign) and a HARDCODED absolute path into the build machine's
/// `.build/<triple>/release/`. release-dmg.sh stages the bundle in
/// `Contents/Resources`, which the accessor never checks — so every
/// install was resolving provider icons through the baked builder path
/// and crashed (SIGTRAP via the accessor's `fatalError`) on any machine
/// where that path did not exist.
///
/// This resolver checks the locations that actually exist in each build
/// flavor, via `FileManager` + `Bundle(url:)` only — it can NEVER trap.
/// When nothing resolves, consumers degrade (ProviderMarkView keeps its
/// neutral fallback glyph) and one log line records the miss.
public enum CoreResourceBundle {
    /// SwiftPM's generated name for the target's resource bundle:
    /// `<package>_<target>.bundle`. release-dmg.sh's release gate pins the
    /// staged location against this exact name; a Swift test pins the
    /// constant so the two cannot drift apart silently.
    public static let bundleFileName = "ModelDeckMac_ModelDeckMacCore.bundle"

    /// The resolved resource bundle, or nil when no candidate exists
    /// (degraded mode — never a trap). Resolved once; bundles are
    /// immutable for the process lifetime.
    public static let bundle: Bundle? = {
        if let found = resolve(searching: defaultCandidateDirectories()) {
            return found
        }
        if let dev = devBuildBundleModule() {
            return dev
        }
        Logger(subsystem: "app.modeldeck.mac", category: "resources")
            .error("\(bundleFileName, privacy: .public) not found in any candidate location; provider icons degrade to fallback glyphs")
        return nil
    }()

    /// Candidate directories that may contain the resource bundle, in
    /// priority order:
    /// 1. `Bundle.main.resourceURL` — the packaged app's
    ///    `Contents/Resources`, where release-dmg.sh and build_app.sh
    ///    stage the bundle. This is the ONLY location a shipped install
    ///    may depend on.
    /// 2. `Bundle.main.bundleURL` — the build products directory when the
    ///    executable runs unbundled (`swift run`), where SwiftPM writes
    ///    the bundle beside the binary.
    /// 3. The directory containing whatever binary this code is linked
    ///    into — under `swift test` that is the `.xctest` bundle's parent,
    ///    i.e. the same build products directory.
    static func defaultCandidateDirectories() -> [URL] {
        var directories: [URL] = []
        if let appResources = Bundle.main.resourceURL {
            directories.append(appResources)
        }
        directories.append(Bundle.main.bundleURL)
        let linkedBundle = Bundle(for: BundleFinder.self)
        if let linkedResources = linkedBundle.resourceURL {
            directories.append(linkedResources)
        }
        directories.append(linkedBundle.bundleURL.deletingLastPathComponent())
        return directories
    }

    /// Non-trapping resolution: probe each directory for the bundle and
    /// return the first one `Bundle(url:)` accepts. Exposed (internal)
    /// with an injectable search list so tests can run it against fixture
    /// app layouts and against empty directories.
    static func resolve(searching directories: [URL]) -> Bundle? {
        let fileManager = FileManager.default
        for directory in directories {
            let candidate = directory.appendingPathComponent(bundleFileName, isDirectory: true)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
                  isDirectory.boolValue,
                  let bundle = Bundle(url: candidate) else {
                continue
            }
            return bundle
        }
        return nil
    }

    /// `Bundle.module`, guarded so its generated accessor cannot reach its
    /// `fatalError`. The accessor traps unless one of its two candidates
    /// loads; the only candidate knowable here is the first
    /// (`Bundle.main.bundleURL` + bundle name), so `Bundle.module` is
    /// touched ONLY when that candidate demonstrably loads via the same
    /// `Bundle` initializer family the accessor uses. The second candidate
    /// (the baked builder path) is deliberately never relied on — trusting
    /// it is the exact defect this file fixes.
    private static func devBuildBundleModule() -> Bundle? {
        let preferred = Bundle.main.bundleURL.appendingPathComponent(bundleFileName, isDirectory: true)
        guard Bundle(url: preferred) != nil else { return nil }
        return Bundle.module
    }

    /// Anchor class for `Bundle(for:)` — locates the binary this code is
    /// statically linked into (the `.xctest` bundle under `swift test`).
    private final class BundleFinder {}
}
