import Foundation

// Issue #705: old installs ignore channel tags, so preview builds live in
// a separate file. Discovery and Sparkle must resolve the same URL each time.
public enum AppUpdateFeedPolicy {
    public static let betaReleasesKey = "modeldeck.appupdate.betaReleases"

    public static func feedURL(betaEnabled: Bool, bundle: Bundle = .main) -> URL {
        let raw = (bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let configured = raw.flatMap(URL.init(string:)).flatMap { $0.scheme == nil ? nil : $0 }
        let stable = configured ?? AppcastReleaseChecker.defaultFeedURL
        guard betaEnabled, var components = URLComponents(url: stable, resolvingAgainstBaseURL: false) else { return stable }
        components.path = components.path.replacingOccurrences(of: "appcast.xml", with: "appcast-beta.xml")
        return components.url ?? stable
    }
}
