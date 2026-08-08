import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #321: no-op eye clicks explain themselves. An eye click that
// changes nothing visible (toggling the master switch renders the identical
// row set, no dim-peek difference, glyph unchanged) presents an anchored
// transient callout with mode-honest copy — every time, no seen-it state.
// A click that DOES change rows never shows it. Plus the none→some eye
// pulse trigger (decision 5). Copy is the grilling record's, verbatim.
// Placeholder names/emails only.

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func iso(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
}

private func account(
    _ id: String,
    provider: String = "claude",
    label: String,
    proxyWeight: Int? = nil,
    proxyFableExcluded: Bool? = nil
) -> DeckAccount {
    DeckAccount(
        id: id,
        provider: provider,
        label: label,
        identity: "\(id)@example.com",
        enabled: true,
        isDefault: false,
        proxyWeight: proxyWeight,
        proxyFableExcluded: proxyFableExcluded
    )
}

private func snapshot(
    _ accountId: String,
    scope: String = "weekly",
    remaining: Double? = 50,
    resetsAt: String?
) -> UsageSnapshot {
    UsageSnapshot(
        accountId: accountId,
        scope: scope,
        remainingPercent: remaining,
        resetsAt: resetsAt,
        stale: false
    )
}

/// The #319 resets-fixture shape: r1 resets in 18 h, r2 in 3 d, r3 in
/// 6.5 d, r4 reports no reset (always visible), r5 in 6.9 d.
private func resetsFixture() -> DeckState {
    DeckState(
        accounts: [
            account("r1", label: "Studio"),
            account("r2", label: "Client"),
            account("r3", label: "Workshop"),
            account("r4", label: "Personal"),
            account("r5", label: "Atelier"),
        ],
        usage: [
            snapshot("r1", resetsAt: iso(18 * 3_600)),
            snapshot("r2", resetsAt: iso(3 * 86_400)),
            snapshot("r3", resetsAt: iso(6.5 * 86_400)),
            snapshot("r4", resetsAt: nil),
            snapshot("r5", remaining: 4, resetsAt: iso(6.9 * 86_400)),
        ]
    )
}

/// Pool with one parked row (z2, live weight 0): By zero weightings hides it.
private func poolWithParkedRow() -> DeckState {
    DeckState(
        accounts: [
            account("z1", label: "Studio", proxyWeight: 5),
            account("z2", label: "Client", proxyWeight: 0),
        ],
        usage: [
            snapshot("z1", scope: "5h", remaining: 40, resetsAt: iso(3_600)),
            snapshot("z2", scope: "5h", remaining: 5, resetsAt: iso(3_600)),
        ]
    )
}

/// Pool where every routed row carries a positive weight: By zero
/// weightings has nothing to hide.
private func poolAllRouted() -> DeckState {
    DeckState(
        accounts: [
            account("z1", label: "Studio", proxyWeight: 5),
            account("z3", label: "Personal", proxyWeight: 3),
        ],
        usage: [
            snapshot("z1", scope: "5h", remaining: 40, resetsAt: iso(3_600)),
            snapshot("z3", scope: "5h", remaining: 80, resetsAt: iso(3_600)),
        ]
    )
}

@Suite("Issue #321 no-op eye callout")
@MainActor
struct Issue321NoOpCalloutTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "issue321-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    // MARK: Copy — verbatim per the grilling record (approved as drafted)

    @Test func calloutCopyIsTheGrillingRecordVerbatim() {
        #expect(DeckPopoverModel.eyeNoOpCalloutCopy(for: .byAccount)
            == "Right-click any account to hide it.")
        #expect(DeckPopoverModel.eyeNoOpCalloutCopy(for: .byResets)
            == "All accounts renew within your window — tighten it in Settings.")
        #expect(DeckPopoverModel.eyeNoOpCalloutCopy(for: .byZeroWeightings)
            == "No accounts are at zero weight right now.")
    }

    // MARK: The no-op predicate, per mode

    @Test func byAccountArmedButEmptyIsANoOp() {
        // Tim's field finding verbatim: fresh defaults, nothing hidden —
        // the click changes nothing visible.
        let model = DeckPopoverModel(defaults: freshDefaults())
        #expect(model.eyeToggleChangesNothingVisible(state: resetsFixture(), now: now))
    }

    @Test func byAccountWithAManualHideIsNotANoOp() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.setManualVisibility(.hidden, for: "r2")
        #expect(!model.eyeToggleChangesNothingVisible(state: resetsFixture(), now: now))
    }

    @Test func byResetsPredicateFollowsTheHorizon() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byResets
        let state = resetsFixture()
        // Default 24 h horizon hides r2/r3/r5 — visibly NOT a no-op.
        #expect(!model.eyeToggleChangesNothingVisible(state: state, now: now))
        // 7 days (All): every dated reset is inside the window and the
        // undated r4 is always visible — nothing to hide, a true no-op.
        model.hideResetsHorizon = .sevenDays
        #expect(model.eyeToggleChangesNothingVisible(state: state, now: now))
        // A manual hide re-enters through the same derivation the rows
        // render from — manual wins both ways, so the no-op is gone.
        model.setManualVisibility(.hidden, for: "r1")
        #expect(!model.eyeToggleChangesNothingVisible(state: state, now: now))
    }

    @Test func byZeroWeightingsPredicateFollowsTheSharedFilter() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byZeroWeightings
        // No routed row at zero — nothing hides, the click is a no-op.
        #expect(model.eyeToggleChangesNothingVisible(state: poolAllRouted(), now: now))
        // A parked ⑂ 0 row hides — not a no-op.
        #expect(!model.eyeToggleChangesNothingVisible(state: poolWithParkedRow(), now: now))
        // No proxy on this machine at all: no row displays ⑂ 0 — no-op.
        #expect(model.eyeToggleChangesNothingVisible(state: resetsFixture(), now: now))
    }

    @Test func predicateIsSymmetricAcrossTheMasterSwitch() {
        // The verdict must read the same before and after the flip — it is
        // the MODE's judgment, not the switch position's.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byResets
        let state = resetsFixture()
        let whileOn = model.eyeToggleChangesNothingVisible(state: state, now: now)
        model.toggleHideShowSystem() // OFF
        #expect(model.eyeToggleChangesNothingVisible(state: state, now: now) == whileOn)
    }

    @Test func hiddenUnknownProviderRowIsNotANoOpEvenInTwoColumnLayout() {
        // Two-column layout never renders an unknown-provider row, but a
        // hidden one still flips the eye glyph (isHidingAnyRow reads the
        // FULL row set — #319 review F3). The glyph flip is visible
        // feedback, so this click gets no callout: the predicate is keyed
        // on the full row set, deliberately layout-independent.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.layout = .twoColumn
        let state = DeckState(
            accounts: [
                account("c1", label: "Studio"),
                account("m1", provider: "mystery", label: "Annex"),
            ],
            usage: [
                snapshot("c1", resetsAt: iso(3_600)),
                snapshot("m1", resetsAt: iso(3_600)),
            ]
        )
        model.setManualVisibility(.hidden, for: "m1")
        #expect(model.columns(for: state, now: now)
            .allSatisfy { column in !column.rows.contains { $0.id == "m1" } },
            "precondition: the columns never carry m1 at all")
        #expect(!model.eyeToggleChangesNothingVisible(state: state, now: now))
    }

    // MARK: The eye click path — callout on no-ops only, toggle regardless

    @Test func noOpClickPresentsTheModeHonestCalloutAndStillToggles() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        #expect(model.eyeCalloutText == nil)
        model.toggleHideShowSystemFromEye(state: state, now: now)
        #expect(model.hideShowEnabled == false,
                "the callout explains the click; it never blocks the toggle")
        #expect(model.eyeCalloutText == "Right-click any account to hide it.")
        // The way back is a no-op too — it fires on EVERY such click, in
        // any mode, forever (no seen-it state).
        model.toggleHideShowSystemFromEye(state: state, now: now)
        #expect(model.hideShowEnabled)
        #expect(model.eyeCalloutText == "Right-click any account to hide it.")
    }

    @Test func calloutCopyFollowsTheCurrentMode() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byResets
        model.hideResetsHorizon = .sevenDays // everything within the window
        model.toggleHideShowSystemFromEye(state: resetsFixture(), now: now)
        #expect(model.eyeCalloutText
            == "All accounts renew within your window — tighten it in Settings.")
        let zeroModel = DeckPopoverModel(defaults: freshDefaults())
        zeroModel.hideMode = .byZeroWeightings
        zeroModel.toggleHideShowSystemFromEye(state: poolAllRouted(), now: now)
        #expect(zeroModel.eyeCalloutText == "No accounts are at zero weight right now.")
    }

    @Test func aClickThatChangesRowsNeverShowsTheCallout() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.setManualVisibility(.hidden, for: "r2")
        let state = resetsFixture()
        // OFF: r2 comes back — visible change, no callout.
        model.toggleHideShowSystemFromEye(state: state, now: now)
        #expect(model.eyeCalloutText == nil)
        // Back ON: r2 hides again — visible change, no callout either way.
        model.toggleHideShowSystemFromEye(state: state, now: now)
        #expect(model.eyeCalloutText == nil)
    }

    @Test func aRowChangingClickClearsAStaleCallout() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        model.toggleHideShowSystemFromEye(state: state, now: now) // no-op → callout
        #expect(model.eyeCalloutText != nil)
        model.setManualVisibility(.hidden, for: "r2")
        model.toggleHideShowSystemFromEye(state: state, now: now) // rows change
        #expect(model.eyeCalloutText == nil,
                "the rows moving IS the feedback — no callout may linger over it")
    }

    @Test func repeatNoOpClicksBumpTheGenerationSoTheTimerRestarts() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        let before = model.eyeCalloutGeneration
        model.toggleHideShowSystemFromEye(state: state, now: now)
        model.toggleHideShowSystemFromEye(state: state, now: now)
        #expect(model.eyeCalloutGeneration == before + 2,
                "each presentation restarts the ~4 s auto-dismiss clock")
    }

    @Test func dismissalPathsClearTheCallout() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.toggleHideShowSystemFromEye(state: resetsFixture(), now: now)
        #expect(model.eyeCalloutText != nil)
        model.dismissEyeCallout() // the auto-fade timeout's path
        #expect(model.eyeCalloutText == nil)
        model.toggleHideShowSystemFromEye(state: resetsFixture(), now: now)
        model.setEyeCalloutPresented(false) // outside interaction / Escape
        #expect(model.eyeCalloutText == nil)
        model.setEyeCalloutPresented(true) // the binding never presents
        #expect(model.eyeCalloutText == nil)
    }

    @Test func expiredTimerFromAnOlderGenerationNeverDismissesANewerCallout() {
        // PR #322 (CodeRabbit): the view's .task(id:) cancels the old
        // timer on a generation bump, but cancellation only propagates on
        // the next view update — a sleep continuation already enqueued on
        // the main actor can resume between the click that presented the
        // newer callout and the render pass that cancels it. The
        // generation-guarded dismiss drops that stale timeout.
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        model.toggleHideShowSystemFromEye(state: state, now: now)
        let staleGeneration = model.eyeCalloutGeneration
        model.toggleHideShowSystemFromEye(state: state, now: now) // newer callout
        model.dismissEyeCallout(ifGeneration: staleGeneration)
        #expect(model.eyeCalloutText != nil,
                "an older presentation's expired timer must not clear the newer callout")
        model.dismissEyeCallout(ifGeneration: model.eyeCalloutGeneration)
        #expect(model.eyeCalloutText == nil,
                "the CURRENT presentation's timeout still dismisses")
    }

    @Test func settingsCaptionRendersExactlyWhileTheGestureIsEnabled() {
        // Issue #321 decision 4, narrowed by the PR #322 adversarial
        // review: the Settings caption teaching the right-click gesture
        // renders on EXACTLY the condition the deck's context-menu Hide
        // line is enabled on — `contextMenuHideShowEnabled`, referenced by
        // the view, never a forked predicate. In By zero weightings the
        // gesture is off (the dynamic caption says so), and an instruction
        // beside its own contradiction must not render.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.hideMode = .byAccount
        #expect(model.contextMenuHideShowEnabled, "caption renders in By account")
        model.hideMode = .byResets
        #expect(model.contextMenuHideShowEnabled, "caption renders in By resets")
        model.hideMode = .byZeroWeightings
        #expect(!model.contextMenuHideShowEnabled,
                "caption hidden in By zero weightings — the gesture is off there")
        // The master switch doesn't gate the caption: right-click Hide
        // still works while peeking with the eye off.
        model.hideMode = .byAccount
        model.hideShowEnabled = false
        #expect(model.contextMenuHideShowEnabled)
    }

    @Test func missingStateShowsNoCallout() {
        // The eye doesn't render without deck state; if a click ever races
        // the state away, the toggle still flips and nothing is claimed.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.toggleHideShowSystemFromEye(state: nil, now: now)
        #expect(model.hideShowEnabled == false)
        #expect(model.eyeCalloutText == nil)
    }

    @Test func calloutStateIsNeverPersisted() {
        let defaults = freshDefaults()
        let model = DeckPopoverModel(defaults: defaults)
        model.toggleHideShowSystemFromEye(state: resetsFixture(), now: now)
        #expect(model.eyeCalloutText != nil)
        let relaunched = DeckPopoverModel(defaults: defaults)
        #expect(relaunched.eyeCalloutText == nil)
        #expect(relaunched.eyeCalloutGeneration == 0)
        #expect(relaunched.eyePulseGeneration == 0)
    }

    // MARK: The eye pulse — none→some transitions only (decision 5)

    @Test func pulseFiresOnEveryNoneToSomeTransition() {
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.noteHidingAnyRow(false) // baseline: nothing hidden
        #expect(model.eyePulseGeneration == 0)
        model.noteHidingAnyRow(true) // none→some
        #expect(model.eyePulseGeneration == 1)
        model.noteHidingAnyRow(true) // still some — no re-pulse
        #expect(model.eyePulseGeneration == 1)
        model.noteHidingAnyRow(false) // some→none — never pulses
        #expect(model.eyePulseGeneration == 1)
        model.noteHidingAnyRow(true) // every occurrence, no one-shot flag
        #expect(model.eyePulseGeneration == 2)
    }

    @Test func firstObservationIsABaselineNeverATransition() {
        // A deck that first renders with rows already hidden must not
        // pulse: nothing transitioned while the user was looking.
        let model = DeckPopoverModel(defaults: freshDefaults())
        model.noteHidingAnyRow(true)
        #expect(model.eyePulseGeneration == 0)
        model.noteHidingAnyRow(false)
        model.noteHidingAnyRow(true)
        #expect(model.eyePulseGeneration == 1,
                "after the baseline, real transitions pulse as usual")
    }

    @Test func pulseTracksTheGlyphDerivation() {
        // Wire the tracker to the same isHidingAnyRow derivation the view
        // feeds it: hiding a row (none→some) pulses; un-hiding doesn't.
        let model = DeckPopoverModel(defaults: freshDefaults())
        let state = resetsFixture()
        model.noteHidingAnyRow(model.isHidingAnyRow(state: state, now: now))
        #expect(model.eyePulseGeneration == 0)
        model.setManualVisibility(.hidden, for: "r2")
        model.noteHidingAnyRow(model.isHidingAnyRow(state: state, now: now))
        #expect(model.eyePulseGeneration == 1, "none→some pulses once")
        model.setManualVisibility(nil, for: "r2")
        model.noteHidingAnyRow(model.isHidingAnyRow(state: state, now: now))
        #expect(model.eyePulseGeneration == 1, "some→none never pulses")
    }
}
