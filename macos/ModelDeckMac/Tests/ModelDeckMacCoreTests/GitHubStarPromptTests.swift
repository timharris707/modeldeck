import Foundation
import Testing
@testable import ModelDeckMacCore

// Tim, 2026-11-01: the once-ever GitHub star line. Never before 10 usage
// days, then 1-in-10 per deck open; star or dismiss ends it for good.

@Suite("GitHub star prompt")
@MainActor
struct GitHubStarPromptTests {
    private let day: TimeInterval = 86_400
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func prompt(_ store: UserDefaults) -> GitHubStarPrompt {
        GitHubStarPrompt(defaults: store, calendar: utc)
    }

    @Test func neverShowsBeforeTenUsageDaysEvenOnAWinningRoll() {
        let store = ScratchDefaults.make("starPrompt-early")
        let prompt = prompt(store)
        for index in 0..<9 {
            prompt.deckOpened(now: start + Double(index) * day, roll: { 0 })
        }
        #expect(!prompt.isShowing)
    }

    @Test func manyOpensOnOneDayCountAsOneDay() {
        let store = ScratchDefaults.make("starPrompt-sameday")
        let prompt = prompt(store)
        for minute in 0..<50 {
            prompt.deckOpened(now: start + Double(minute) * 60, roll: { 0 })
        }
        #expect(!prompt.isShowing)
        #expect(store.stringArray(forKey: GitHubStarPrompt.usageDaysKey)?.count == 1)
    }

    @Test func showsOnTheTenthDayOnlyWhenTheRollHits() {
        let store = ScratchDefaults.make("starPrompt-roll")
        let prompt = prompt(store)
        for index in 0..<10 {
            prompt.deckOpened(now: start + Double(index) * day, roll: { 1 })
        }
        #expect(!prompt.isShowing)
        prompt.deckOpened(now: start + 10 * day, roll: { 0 })
        #expect(prompt.isShowing)
    }

    @Test func staysUpUntilFinishedAndNeverReturns() {
        let store = ScratchDefaults.make("starPrompt-finish")
        let prompt = prompt(store)
        for index in 0..<10 {
            prompt.deckOpened(now: start + Double(index) * day, roll: { 0 })
        }
        #expect(prompt.isShowing)
        // Later opens with losing rolls leave it up.
        prompt.deckOpened(now: start + 11 * day, roll: { 5 })
        #expect(prompt.isShowing)
        prompt.finish()
        #expect(!prompt.isShowing)
        for index in 12..<40 {
            prompt.deckOpened(now: start + Double(index) * day, roll: { 0 })
        }
        #expect(!prompt.isShowing)
    }

    @Test func deckModelStarOrDismissIsPermanentAcrossRelaunch() {
        let store = ScratchDefaults.make("starPrompt-model")
        let seeded = prompt(store)
        for index in 0..<10 {
            seeded.recordUsageDay(now: start + Double(index) * day)
        }
        let model = DeckPopoverModel(defaults: store)
        model.noteDeckOpenedForStarPrompt(roll: { 0 })
        #expect(model.showsGitHubStarPrompt)
        // Relaunch while showing: still showing.
        #expect(DeckPopoverModel(defaults: store).showsGitHubStarPrompt)
        model.finishGitHubStarPrompt()
        #expect(!model.showsGitHubStarPrompt)
        let relaunched = DeckPopoverModel(defaults: store)
        relaunched.noteDeckOpenedForStarPrompt(roll: { 0 })
        #expect(!relaunched.showsGitHubStarPrompt)
    }
}
