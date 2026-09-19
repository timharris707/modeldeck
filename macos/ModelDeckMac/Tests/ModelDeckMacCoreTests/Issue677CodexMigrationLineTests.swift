import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #677 — the deck's side of the deferred Codex profile move.
//
// The daemon moves ~/.codex-profiles under ModelDeck's data directory. On
// Tim's machine it never has: ChatGPT, a Codex CLI session and stale helpers
// hold the old folder open. Until #676 the only trace was a sentence in
// /api/health.warning telling him to close Codex sessions and retry at the
// next start, which is not something he can do with ChatGPT open.
//
// These pin the replacement: one quiet line that names what is holding it,
// a Move now that actually runs the move, silence in every state where there
// is nothing to say, and the rule that keeps this fact from being shown in
// two places at once.

/// One-shot latch. `wait()` returns once `open()` has been called, so a test
/// can look at the model while a call is parked inside the fake client.
private actor Latch {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        guard !opened else { return }
        opened = true
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume() }
    }

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

/// Fake `POST /api/codex-profiles/migrate`. Counts calls; `gated` parks
/// inside the call until the test releases it.
private final class StubMigrator: CodexProfilesMigrating, @unchecked Sendable {
    let started = Latch()
    let release = Latch()

    private let lock = NSLock()
    private var recorded = 0
    private let result: Result<CodexProfilesMigrationOutcome, Error>
    private let gated: Bool

    init(_ result: Result<CodexProfilesMigrationOutcome, Error>, gated: Bool = false) {
        self.result = result
        self.gated = gated
    }

    var calls: Int { lock.withLock { recorded } }

    func migrateCodexProfiles() async throws -> CodexProfilesMigrationOutcome {
        lock.withLock { recorded += 1 }
        if gated {
            await started.open()
            await release.wait()
        }
        return try result.get()
    }
}

@MainActor
private func makeModel(_ migrator: StubMigrator? = nil) -> DeckPopoverModel {
    DeckPopoverModel(
        defaults: ScratchDefaults.make("issue-677"),
        codexMigrator: migrator
    )
}

@Suite("Issue #677: the deferred Codex profile move on the deck")
struct Issue677CodexMigrationLineTests {

    // MARK: The line

    @Test("two holders read as one plain sentence")
    @MainActor
    func twoHoldersJoinNaturally() {
        let model = makeModel()
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["ChatGPT", "codex"])
        )
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on ChatGPT and codex.")
    }

    @Test("one holder, and three take the serial comma")
    @MainActor
    func oneAndThreeHolders() {
        let model = makeModel()
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["ChatGPT"])
        )
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on ChatGPT.")
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["ChatGPT", "codex", "node"])
        )
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on ChatGPT, codex, and node.")
    }

    @Test("no names still names the situation")
    @MainActor
    func emptyHoldersFallBackToAPlainPhrase() {
        let model = makeModel()
        model.applyCodexProfilesMigration(CodexProfilesMigration(status: .deferred, holders: []))
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on running Codex processes.")
    }

    @Test("past three names the line counts instead of listing")
    @MainActor
    func fourHoldersCountTheRest() {
        let model = makeModel()
        model.applyCodexProfilesMigration(CodexProfilesMigration(
            status: .deferred,
            holders: ["ChatGPT", "codex", "node", "Terminal"]
        ))
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on ChatGPT, codex, node, and 1 more.")
        model.applyCodexProfilesMigration(CodexProfilesMigration(
            status: .deferred,
            holders: ["ChatGPT", "codex", "node", "Terminal", "helper"]
        ))
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on ChatGPT, codex, node, and 2 more.")
    }

    // MARK: Silence

    @Test("done, absent and a status this build does not know all render nothing")
    @MainActor
    func quietStates() throws {
        let model = makeModel()
        model.applyCodexProfilesMigration(CodexProfilesMigration(
            status: .done,
            movedAt: "2026-09-19T12:10:00.000Z"
        ))
        #expect(model.codexProfilesMigrationLine == nil)
        #expect(!model.codexProfilesMovedNoticeVisible)

        model.applyCodexProfilesMigration(nil)
        #expect(model.codexProfilesMigrationLine == nil)

        // An unknown status decodes as absent, so it reaches the model as nil
        // and the deck says nothing rather than a line it cannot explain.
        let unknown = #"{"accounts":[],"usage":[],"codexProfilesMigration":{"status":"rolling-back"}}"#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(unknown.utf8))
        #expect(state.codexProfilesMigration == nil)
        model.applyCodexProfilesMigration(state.codexProfilesMigration)
        #expect(model.codexProfilesMigrationLine == nil)
    }

    // MARK: Move now

    @Test("Move now says Moving… while it works, then the line is gone")
    @MainActor
    func movedClearsTheLineAndSaysSoOnce() async {
        let migrator = StubMigrator(.success(.moved), gated: true)
        let model = makeModel(migrator)
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["ChatGPT", "codex"])
        )
        #expect(model.canMoveCodexProfiles)
        #expect(model.codexProfilesMoveTitle == "Move now")

        let move = Task { await model.moveCodexProfilesNow() }
        await migrator.started.wait()
        #expect(model.isMovingCodexProfiles)
        #expect(model.codexProfilesMoveTitle == "Moving…")

        await migrator.release.open()
        await move.value
        #expect(migrator.calls == 1)
        #expect(model.codexProfilesMigrationLine == nil)
        #expect(!model.isMovingCodexProfiles)
        #expect(model.codexProfilesMovedNoticeVisible)

        // Launch-scoped and dismissible: gone means gone, and a later moved
        // answer in the same launch does not bring it back.
        model.dismissCodexProfilesMovedNotice()
        #expect(!model.codexProfilesMovedNoticeVisible)
    }

    @Test("a deferred answer updates the line to the holders it came back with")
    @MainActor
    func deferredAnswerReplacesTheHolders() async {
        let migrator = StubMigrator(.success(.deferred(holders: ["ChatGPT"])))
        let model = makeModel(migrator)
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["ChatGPT", "codex"])
        )
        await model.moveCodexProfilesNow()
        #expect(migrator.calls == 1)
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on ChatGPT.")
        #expect(!model.isMovingCodexProfiles)
        #expect(!model.codexProfilesMovedNoticeVisible)
    }

    @Test("nothing to move takes the line away without announcing anything")
    @MainActor
    func notNeededGoesQuiet() async {
        let migrator = StubMigrator(.success(.notNeeded))
        let model = makeModel(migrator)
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["codex"])
        )
        await model.moveCodexProfilesNow()
        #expect(migrator.calls == 1)
        #expect(model.codexProfilesMigrationLine == nil)
        #expect(!model.codexProfilesMovedNoticeVisible)
    }

    @Test("a refusal keeps the line, says why once, and re-enables the button")
    @MainActor
    func failureKeepsTheLine() async throws {
        let migrator = StubMigrator(.failure(DaemonClientError.daemonError(
            message: "loopback connections only",
            status: 403
        )))
        let model = makeModel(migrator)
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["ChatGPT", "codex"])
        )
        await model.moveCodexProfilesNow()
        #expect(model.codexProfilesMigrationLine
            == "Codex profile move is waiting on ChatGPT and codex."
            + " Couldn't move: loopback connections only")
        #expect(!model.isMovingCodexProfiles)
        #expect(model.canMoveCodexProfiles)

        // A second failure replaces the first; the reason is never stacked.
        await model.moveCodexProfilesNow()
        let line = try #require(model.codexProfilesMigrationLine)
        #expect(line.components(separatedBy: "Couldn't move:").count == 2)
        #expect(migrator.calls == 2)
    }

    @Test("one move at a time")
    @MainActor
    func concurrentClicksCallOnce() async {
        let migrator = StubMigrator(.success(.moved), gated: true)
        let model = makeModel(migrator)
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["codex"])
        )
        let first = Task { await model.moveCodexProfilesNow() }
        await migrator.started.wait()
        await model.moveCodexProfilesNow()
        await migrator.release.open()
        await first.value
        #expect(migrator.calls == 1)
    }

    @Test("no client wired in means no button, and the line still reads")
    @MainActor
    func noMigratorNoAction() async {
        let model = makeModel()
        model.applyCodexProfilesMigration(
            CodexProfilesMigration(status: .deferred, holders: ["codex"])
        )
        #expect(model.codexProfilesMigrationLine != nil)
        #expect(!model.canMoveCodexProfiles)
        await model.moveCodexProfilesNow()
        #expect(!model.isMovingCodexProfiles)
    }

    // MARK: Decoding

    @Test("a state with no migration field decodes to no migration")
    func missingFieldDecodesToNil() throws {
        let json = #"{"accounts":[],"usage":[]}"#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        #expect(state.codexProfilesMigration == nil)
    }

    @Test("deferred without holders, and done, both decode")
    func tolerantFieldDecoding() throws {
        let deferred = #"""
        {"accounts":[],"usage":[],
         "codexProfilesMigration":{"status":"deferred","since":"2026-09-19T12:00:00.000Z"}}
        """#
        let deferredState = try JSONDecoder().decode(DeckState.self, from: Data(deferred.utf8))
        let migration = try #require(deferredState.codexProfilesMigration)
        #expect(migration.status == .deferred)
        #expect(migration.holders.isEmpty)
        #expect(migration.since == "2026-09-19T12:00:00.000Z")

        let done = #"""
        {"accounts":[],"usage":[],
         "codexProfilesMigration":{"status":"done","movedAt":"2026-09-19T12:10:00.000Z"}}
        """#
        let doneState = try JSONDecoder().decode(DeckState.self, from: Data(done.utf8))
        #expect(doneState.codexProfilesMigration?.status == .done)
        #expect(doneState.codexProfilesMigration?.movedAt == "2026-09-19T12:10:00.000Z")
    }

    @Test("a broken migration field never costs the deck its accounts")
    func brokenFieldDoesNotBreakTheState() throws {
        let json = #"""
        {"accounts":[{"id":"acct-1","provider":"codex","label":"Placeholder","enabled":true,"isDefault":true}],
         "usage":[],"codexProfilesMigration":{"status":7}}
        """#
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        #expect(state.codexProfilesMigration == nil)
        #expect(state.accounts.count == 1)
    }

    // MARK: The endpoint

    @Test("Move now posts to the migrate endpoint with the mutation token")
    func clientPostsWithAuth() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: #"{"token":"migrate-token"}"#),
            .init(status: 200, body: #"{"status":"deferred","holders":["ChatGPT"]}"#)
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
        let outcome = try await client.migrateCodexProfiles()
        #expect(outcome == .deferred(holders: ["ChatGPT"]))
        #expect(transport.requests.count == 2)
        let post = transport.requests[1]
        #expect(post.httpMethod == "POST")
        #expect(post.url?.path == "/api/codex-profiles/migrate")
        #expect(post.httpBody == nil)
        #expect(post.value(forHTTPHeaderField: "x-modeldeck-token") == "migrate-token")
        #expect(post.value(forHTTPHeaderField: "Cookie") == "modeldeck_session=migrate-token")
    }

    @Test("the daemon's three answers each decode")
    func clientDecodesEveryStatus() async throws {
        let cases: [(String, CodexProfilesMigrationOutcome)] = [
            (#"{"status":"moved"}"#, .moved),
            (#"{"status":"deferred"}"#, .deferred(holders: [])),
            (#"{"status":"not-needed"}"#, .notNeeded)
        ]
        for (body, expected) in cases {
            let transport = StubTransport(stubs: [
                .init(status: 200, body: #"{"token":"t"}"#),
                .init(status: 200, body: body)
            ])
            let client = DaemonClient(configuration: DaemonConfiguration(), transport: transport)
            let outcome = try await client.migrateCodexProfiles()
            #expect(outcome == expected)
        }
    }

    // MARK: One place, not two (issue #677 item 6)

    // TRIPWIRE codex-move-said-once: the header line is the only place this
    // fact appears. The daemon still puts its own sentence on
    // /api/health.warning; nothing renders that today, and when something
    // does it has to come through this rule.
    @Test("the daemon's own migration sentence is suppressed once the state field is there")
    func healthWarningIsNotAsecondCopy() {
        let migration = CodexProfilesMigration(status: .deferred, holders: ["ChatGPT"])
        #expect(CodexProfilesMigration.healthWarningToShow(
            "Codex profile move is waiting on ChatGPT and codex",
            migration: migration
        ) == nil)
        #expect(CodexProfilesMigration.healthWarningToShow(
            "Codex profiles migration failed or deferred while validating profile trees.",
            migration: migration
        ) == nil)
    }

    @Test("every other daemon warning still shows")
    func otherWarningsSurvive() {
        let migration = CodexProfilesMigration(status: .deferred, holders: ["ChatGPT"])
        #expect(CodexProfilesMigration.healthWarningToShow(
            "The Codex terminal environment could not be updated. Restart ModelDeck to retry.",
            migration: migration
        ) == "The Codex terminal environment could not be updated. Restart ModelDeck to retry.")
        // No state field means no header line, so the sentence is the only
        // trace there is and it keeps rendering.
        #expect(CodexProfilesMigration.healthWarningToShow(
            "Codex profile move is waiting on ChatGPT",
            migration: nil
        ) == "Codex profile move is waiting on ChatGPT")
        #expect(CodexProfilesMigration.healthWarningToShow(nil, migration: migration) == nil)
    }

    @Test("the health response carries the daemon's warning through")
    func healthDecodesTheWarning() throws {
        let json = #"""
        {"ok":true,"name":"ModelDeck","version":"1.1.12",
         "warning":"Codex profile move is waiting on ChatGPT and codex"}
        """#
        let health = try JSONDecoder().decode(DaemonHealth.self, from: Data(json.utf8))
        #expect(health.warning == "Codex profile move is waiting on ChatGPT and codex")
    }

    // TRIPWIRE codex-move-copy: the deck reads this copy from the model.
    // Hardcoding it back in the view is how the sentence drifts from the one
    // the tests above pin.
    @Test("the deck view holds no Codex move copy of its own")
    func deckViewCarriesNoHardcodedCopy() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
        #expect(!source.contains("Codex profile move is waiting"),
                "TRIPWIRE codex-move-copy: DeckPopoverView hardcodes the waiting sentence")
        #expect(!source.contains("\"Move now\""),
                "TRIPWIRE codex-move-copy: DeckPopoverView hardcodes the button title")
        #expect(source.contains("deckModel.codexProfilesMigrationLine"),
                "TRIPWIRE codex-move-copy: the deck no longer asks the model for the line")
        // CodeRabbit, PR #682: retained migration state must not keep "Move
        // now" clickable against a daemon that is not answering, or beside
        // the setup card that already owns the story (#96).
        #expect(source.contains("statusModel.connection.daemonAnswered,\n           !setupModel.phase.needsPopoverCard {"),
                "TRIPWIRE codex-move-gate: the migration line is no longer gated on daemonAnswered and the setup card")
        #expect(source.contains("CodexProfilesMigrationCopy.movedNotice"),
                "TRIPWIRE codex-move-copy: the moved notice copy left the model")
    }
}
