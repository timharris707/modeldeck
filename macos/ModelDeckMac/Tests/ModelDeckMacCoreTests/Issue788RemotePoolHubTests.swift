import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #788 (slice 4 of #783) — remote Macs link to the pool host's usage
// page and say when it last answered.
//
// In remote role with a page set, the daemon reads the page about every 5
// minutes and reports `proxy.hub = { url, lastAttemptAt, lastAnsweredAt,
// lastFailedAt, lastReadOk }` in /api/state (test/pool-hub.test.mjs is the
// contract). The deck's "Remote pool" label becomes a link to that page,
// with the page's freshness after it. These pin the app's side: the block
// decodes tolerantly, each freshness case says what it should (and an old
// answer alone never blames the page), only http and https pages ever open,
// a host deck and a remote deck without a page show what #784 showed, and
// the link speaks its visible words in order.

private let now = ISO8601DateFormatter().date(from: "2026-10-30T12:00:00Z")!

/// The daemon's timestamp shape (`Date.toISOString()`), `secondsAgo` before now.
private func iso(_ secondsAgo: TimeInterval) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: now.addingTimeInterval(-secondsAgo))
}

/// A hub report with events `…` seconds ago. The latest attempt defaults to
/// the latest of the answer and the failure, as the daemon stamps it.
private func hub(
    url: String = "http://studio:3871",
    attempted: TimeInterval? = nil,
    answered: TimeInterval? = nil,
    failed: TimeInterval? = nil,
    readOk: Bool? = nil
) -> DeckProxyHub {
    DeckProxyHub(
        url: url,
        lastAttemptAt: (attempted ?? [answered, failed].compactMap { $0 }.min()).map(iso),
        lastAnsweredAt: answered.map(iso),
        lastFailedAt: failed.map(iso),
        lastReadOk: answered == nil ? readOk : (readOk ?? true)
    )
}

private func freshness(_ hub: DeckProxyHub) -> String? {
    ProxyRoleCopy.hubFreshness(hub, now: now)
}

private final class BrowserSpy: BrowserOpening, @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [URL] = []
    var opened: [URL] { lock.withLock { urls } }

    func open(_ url: URL) {
        lock.withLock { urls.append(url) }
    }
}

// MARK: - Decoding

@Suite("Issue #788 — proxy.hub decodes tolerantly")
struct Issue788HubDecodingTests {
    private func state(_ proxy: String) throws -> DeckState {
        let json = #"{"accounts": [{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": true}], "usage": [], "proxy": \#(proxy)}"#
        return try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
    }

    @Test("a present hub decodes with its URL, timestamps and read flag")
    func presentHub() throws {
        let decoded = try state(#"{"role": "remote", "hub": {"url": "http://studio:3871/usage", "lastAttemptAt": "2026-10-30T11:58:00.000Z", "lastAnsweredAt": "2026-10-30T11:57:00.000Z", "lastFailedAt": "2026-10-30T11:58:10.000Z", "lastReadOk": false}}"#)
        #expect(decoded.proxyRole == .remote)
        #expect(decoded.proxy?.hub == DeckProxyHub(
            url: "http://studio:3871/usage",
            lastAttemptAt: "2026-10-30T11:58:00.000Z",
            lastAnsweredAt: "2026-10-30T11:57:00.000Z",
            lastFailedAt: "2026-10-30T11:58:10.000Z",
            lastReadOk: false
        ))
    }

    @Test("before the first read the timestamps and read flag are null, and the hub still decodes")
    func hubBeforeTheFirstRead() throws {
        let decoded = try state(#"{"role": "remote", "hub": {"url": "http://studio:3871", "lastAttemptAt": null, "lastAnsweredAt": null, "lastFailedAt": null, "lastReadOk": null}}"#)
        #expect(decoded.proxy?.hub == DeckProxyHub(url: "http://studio:3871"))
    }

    @Test("a daemon from before lastFailedAt omits it, which reads as no failure")
    func hubWithoutLastFailedAt() throws {
        let decoded = try state(#"{"role": "remote", "hub": {"url": "http://studio:3871", "lastAttemptAt": "2026-10-30T11:58:00.000Z", "lastAnsweredAt": "2026-10-30T11:57:00.000Z", "lastReadOk": true}}"#)
        #expect(decoded.proxy?.hub == DeckProxyHub(
            url: "http://studio:3871",
            lastAttemptAt: "2026-10-30T11:58:00.000Z",
            lastAnsweredAt: "2026-10-30T11:57:00.000Z",
            lastReadOk: true
        ))
        #expect(decoded.proxy?.hub?.lastFailedAt == nil)
    }

    @Test("a remote daemon with no page set sends no hub, which reads as none")
    func missingHub() throws {
        for proxy in [#"{"role": "remote"}"#, #"{"role": "remote", "hub": null}"#] {
            let decoded = try state(proxy)
            #expect(decoded.proxyRole == .remote, "\(proxy)")
            #expect(decoded.proxy?.hub == nil, "\(proxy)")
        }
    }

    @Test("a malformed hub reads as none and costs neither the role nor the rest of the state")
    func malformedHub() throws {
        for malformed in [
            #""http://studio:3871""#,
            #"7"#,
            #"[]"#,
            #"{}"#,
            #"{"url": 7}"#,
            #"{"lastAttemptAt": "2026-10-30T11:58:00.000Z"}"#,
            #"{"url": "http://studio:3871", "lastAttemptAt": 1793000000}"#,
            #"{"url": "http://studio:3871", "lastAnsweredAt": true}"#,
            #"{"url": "http://studio:3871", "lastFailedAt": 1793000000}"#,
            #"{"url": "http://studio:3871", "lastReadOk": "yes"}"#,
        ] {
            let decoded = try state(#"{"role": "remote", "hub": \#(malformed)}"#)
            #expect(decoded.proxy?.hub == nil, "\(malformed) must read as no hub")
            #expect(decoded.proxyRole == .remote, "\(malformed) must not cost the role")
            #expect(decoded.accounts.map(\.id) == ["a1"], "\(malformed) must not cost the rest of the state")
        }
    }

    @Test("host role carries no hub")
    func hostRole() throws {
        let decoded = try state(#"{"role": "host"}"#)
        #expect(decoded.proxyRole == .host)
        #expect(decoded.proxy == DeckProxyStatus(role: .host))
        #expect(decoded.proxy?.hub == nil)
    }
}

// MARK: - Freshness

@Suite("Issue #788 — what the header says about the page")
struct Issue788FreshnessTests {
    @Test("before any answer and with no failure there is no text, even with a read in flight")
    func beforeAnyAnswerOrFailure() {
        #expect(freshness(hub()) == nil)
        // A daemon just started, or a page just set: the first read is out.
        #expect(freshness(hub(attempted: 2)) == nil)
    }

    @Test("a failed read with no answer yet is page not answering")
    func failedBeforeAnyAnswer() {
        #expect(freshness(hub(failed: 10)) == "page not answering")
    }

    @Test("under a minute is just now, then whole minutes")
    func justNowThenMinutes() {
        #expect(freshness(hub(answered: 0)) == "answered just now")
        #expect(freshness(hub(answered: 59)) == "answered just now")
        #expect(freshness(hub(answered: 60)) == "answered 1 min ago")
        #expect(freshness(hub(answered: 3 * 60)) == "answered 3 min ago")
    }

    /// The two finders' case: after sleep or a daemon restart the last
    /// answer is old, nothing has failed since, and a catch-up read is out.
    /// Blaming the page then is wrong; the age is the honest thing to say.
    @Test("an old answer with no failure since shows its age all the way up, never page not answering")
    func oldAnswerShowsItsAge() {
        #expect(freshness(hub(answered: 16 * 60)) == "answered 16 min ago")
        #expect(freshness(hub(attempted: 1, answered: 2 * 3600)) == "answered 2 hr ago")
        #expect(freshness(hub(attempted: 1, answered: 3 * 86_400)) == "answered 3 days ago")
        // The deck's own age words, verbatim.
        #expect(freshness(hub(answered: 5 * 3600))
            == "answered \(DeckFreshness.ageText(observedAt: now.addingTimeInterval(-5 * 3600), now: now))")
    }

    @Test("a failure newer than the last answer is page not answering; a later answer clears it")
    func failureNewerThanAnswer() {
        #expect(freshness(hub(answered: 3 * 60, failed: 30)) == "page not answering")
        #expect(freshness(hub(answered: 30, failed: 3 * 60)) == "answered just now")
        #expect(freshness(hub(answered: 2 * 3600, failed: 3 * 3600)) == "answered 2 hr ago")
    }

    @Test("a page that answered without fresh data says so, until a newer failure")
    func pageHasNoFreshData() {
        #expect(freshness(hub(answered: 3 * 60, readOk: false)) == "page has no fresh data")
        #expect(freshness(hub(answered: 2 * 3600, readOk: false)) == "page has no fresh data")
        #expect(freshness(hub(answered: 3 * 60, failed: 30, readOk: false)) == "page not answering")
    }

    @Test("an answer with no read flag reads as answered; a timestamp the deck cannot read counts as missing")
    func unknownsStayQuiet() {
        let noFlag = DeckProxyHub(url: "http://studio:3871", lastAttemptAt: iso(60), lastAnsweredAt: iso(60), lastReadOk: nil)
        #expect(freshness(noFlag) == "answered 1 min ago")
        let unreadableFailure = DeckProxyHub(url: "http://studio:3871", lastAnsweredAt: iso(60), lastFailedAt: "lately", lastReadOk: true)
        #expect(freshness(unreadableFailure) == "answered 1 min ago")
        let unreadableAnswer = DeckProxyHub(url: "http://studio:3871", lastAttemptAt: iso(60), lastAnsweredAt: "yesterday", lastReadOk: true)
        #expect(freshness(unreadableAnswer) == nil)
    }
}

// MARK: - The link

@Suite("Issue #788 — the Remote pool label links to the usage page")
struct Issue788RemotePoolLinkTests {
    /// The guard the issue names: only http and https pages ever open.
    @Test("TRIPWIRE hub-page-scheme-guard: javascript:, file: and ftp: pages never open")
    func onlyHTTPAndHTTPSOpen() {
        for raw in [
            "javascript:alert(1)",
            "JavaScript:alert(document.cookie)",
            "file:///etc/passwd",
            "file://studio/Users/Shared",
            "ftp://studio:3871",
            "http:studio",
            "//studio:3871",
            "",
        ] {
            let spy = BrowserSpy()
            #expect(ProxyRoleCopy.hubPage(raw) == nil, "\(raw)")
            let header = ProxyRoleCopy.remotePoolHeader(role: .remote, hub: hub(url: raw, answered: 60))
            #expect(header == .label, "\(raw) must leave the plain label, with no link and no freshness")
            header?.open(with: spy)
            #expect(spy.opened.isEmpty, "\(raw) must never open")
        }
    }

    @Test("http and https pages open exactly the page the daemon reported")
    func httpPagesOpen() throws {
        for raw in ["http://studio:3871", "https://studio.tail1234.ts.net/usage", "HTTP://STUDIO:3871"] {
            let spy = BrowserSpy()
            let report = hub(url: raw, answered: 60)
            let header = try #require(ProxyRoleCopy.remotePoolHeader(role: .remote, hub: report))
            header.open(with: spy)
            #expect(spy.opened == [URL(string: raw)!], "\(raw)")
            #expect(header == .link(page: URL(string: raw)!, hub: report))
        }
    }

    @Test("host role and a remote deck without a hub show nothing new")
    func hostAndRemoteWithoutHubUnchanged() {
        // The pool host shows nothing, even if a hub ever arrived.
        #expect(ProxyRoleCopy.remotePoolHeader(role: .host, hub: nil) == nil)
        #expect(ProxyRoleCopy.remotePoolHeader(role: .host, hub: hub(answered: 60)) == nil)
        // A remote deck without a page keeps #784's plain label: no link, no freshness.
        #expect(ProxyRoleCopy.remotePoolHeader(role: .remote, hub: nil) == .label)
        let spy = BrowserSpy()
        RemotePoolHeader.label.open(with: spy)
        #expect(spy.opened.isEmpty)
    }

    // Label in name: a voice user says what they see. The link's explicit
    // label replaces its children's, so it carries the freshness; the hint
    // says where the click goes.
    @Test("the link's spoken label is its visible words in order, and the hint says where it goes")
    func labelInName() {
        #expect(ProxyRoleCopy.remotePoolLinkAccessibilityLabel(freshness: "answered 3 min ago")
            == "Remote pool, answered 3 min ago")
        #expect(ProxyRoleCopy.remotePoolLinkAccessibilityLabel(freshness: nil) == "Remote pool")
        #expect(ProxyRoleCopy.opensUsagePageHint == "Opens the pool's usage page")

        let visible = freshness(hub(answered: 3 * 60))
        #expect(visible == "answered 3 min ago")
        #expect(ProxyRoleCopy.remotePoolLinkAccessibilityLabel(freshness: visible)
            == [ProxyRoleCopy.remotePoolLabel, "answered 3 min ago"].joined(separator: ", "))
    }

    @Test("the tooltip says why, where the click goes, and the freshness")
    func tooltip() {
        let page = URL(string: "http://studio:3871")!
        #expect(ProxyRoleCopy.remotePoolLinkTooltip(page: page, freshness: "page has no fresh data") == """
            This Mac uses the proxy pool on another machine; manage it there.
            Click to open its usage page: http://studio:3871
            Page has no fresh data.
            """)
        #expect(ProxyRoleCopy.remotePoolLinkTooltip(page: page, freshness: nil) == """
            This Mac uses the proxy pool on another machine; manage it there.
            Click to open its usage page: http://studio:3871
            """)
    }
}

// MARK: - TRIPWIRES on the app layer

@Suite("Issue #788 — TRIPWIRES on the app layer")
struct Issue788AppSourceTripwireTests {
    private static let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    /// The view's `.link` case, from its pattern to the shared label text.
    private static func linkCase() throws -> Substring {
        let deck = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
        let start = try #require(deck.range(of: "case .link(let page, let hub):"))
        let end = try #require(deck.range(of: "private var label: some View {", range: start.upperBound..<deck.endIndex))
        return deck[start.upperBound..<end.lowerBound]
    }

    /// The link is one element whose explicit label is derived from the
    /// freshness it shows. A child with its own label would be swallowed
    /// by the link's (#65/#113/#272), so there is none.
    @Test("TRIPWIRE remote-pool-link-label: one labelled element that speaks the freshness it shows")
    func linkSpeaksWhatItShows() throws {
        let link = try Self.linkCase()
        #expect(link.contains(".accessibilityLabel(ProxyRoleCopy.remotePoolLinkAccessibilityLabel(freshness: freshness))"))
        #expect(link.contains(".accessibilityHint(ProxyRoleCopy.opensUsagePageHint)"))
        #expect(link.components(separatedBy: ".accessibilityLabel(").count == 2,
                "only the link itself carries a label; a child's would be swallowed")
        #expect(!link.contains(".accessibilityElement("))
        #expect(link.contains("header.open(with: WorkspaceBrowserOpener())"),
                "the click goes through the guarded header, never a URL built here")
    }

    /// Review fix (#788): the freshness was worded once per render, so an
    /// open deck kept "answered just now" until the next state read. Like
    /// the footer's freshness line, the link draws inside a 30-second
    /// timeline and words the freshness from the timeline's date, and the
    /// spoken label and tooltip use that same wording.
    @Test("TRIPWIRE remote-pool-freshness-ticks: the link words its freshness from a 30-second timeline")
    func freshnessMovesWhileTheDeckStaysOpen() throws {
        let link = try Self.linkCase()
        let timeline = try #require(link.range(of: "TimelineView(.periodic(from: .now, by: 30)) { context in"))
        let wording = try #require(link.range(of: "let freshness = ProxyRoleCopy.hubFreshness(hub, now: context.date)"))
        let button = try #require(link.range(of: "Button {"))
        #expect(timeline.upperBound <= wording.lowerBound && wording.upperBound <= button.lowerBound,
                "the freshness is worded inside the timeline, before the link that shows it")
        #expect(link.components(separatedBy: "hubFreshness(").count == 2, "one wording, from the timeline's date")
        #expect(link.contains(".help(ProxyRoleCopy.remotePoolLinkTooltip(page: page, freshness: freshness))"))
    }
}
