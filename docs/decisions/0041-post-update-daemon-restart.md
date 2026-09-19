# 0041 — After an app update, restart the background service; re-register only when the restart does not take

- Date: 2026-09-19
- Links: issue #678, issue #514 (stale launch constraint), issue #486 (host signature), decision 0026, PR for #678
- Status: recorded by the implementing lane; Tim may overrule. Adversarial review (gpt-6-astra, PR #687 comment) found two MAJOR issues, both fixed on the branch and folded into this note (§3 and the follow-up read in decision 3); the original §3 claim is kept below, struck, so the record shows what was wrong.

## The problem, in Tim's words

"Updating could be a bit more sophisticated, it seems smoother in other apps."
After every release the app sees that the bundled daemon's commit differs from
the one it recorded and runs, before its first data read: unregister →
register → poll up to 10 × 0.5 s with 5 s health probes (worst case ≈ 55 s) →
verify the running commit → possibly bootout + unregister + register → poll
again. The deck shows a setup card meanwhile, the "Background service updated
to match this app version" banner fires on every release, and the
unregister/register round-trip can revoke Login Items approval.

## Decision

1. **Ordinary drift (registration `.enabled`, launchd job present, only the
   commit differs, the agent plist's fingerprint unchanged) restarts the
   process in place with `launchctl kickstart -k gui/<uid>/ai.hermes.modeldeck`.**
   No `unregister()`, no `register()`, so the registration record and its
   Login Items approval are never touched on the happy path. **A changed
   agent plist (fingerprint differs from the one recorded at the last
   registration) is `.driftReregister`: the full unregister → register, with
   the banner and today's approval handling** — see §3 for why a restart can
   never apply a changed definition.
2. **The full re-register stays, one rung down.** If the restarted daemon
   does not self-report the bundled commit within the wait budget, the
   existing unregister → register path runs exactly once; if THAT leaves a
   stale process, the existing bootout escalation runs exactly once. The
   ladder is: kickstart → re-register → bootout+re-register → actionable
   failure. Nothing below the top rung changed.
3. **Reconciliation runs alongside the first data read, not before it, and
   one more read follows a verified reconciliation.** The old daemon answers
   `/api/state` while it is being replaced; the deck shows its data. The
   review of PR #687 reproduced the gap: the first read can land on
   connection-refused between SIGTERM and respawn, and with automatic
   refresh off nothing would read again — the deck sat on "unreachable"
   beside a healthy new daemon. So `LaunchReconciliation.runAlongsideFirstRead`
   runs the read once more after the reconciliation reports the daemon
   verified up (any outcome ending `.quiet`), never for consent / approval /
   failed states where the card owns the story. The setup card appears only
   for genuine setup states.
4. **The restart wait uses 1 s health probes** (10 × (1 s probe + 0.5 s
   delay) ≈ 15 s worst case, down from ≈ 55 s). The 5 s default used by every
   other caller is untouched. Ahead of the wait, the kickstart call itself
   can take up to 15 s in the pathological case (question 2); typical is
   2–5 s. The wait shows no setup card: the phase stays `.checking` until
   the daemon answers or the fallback takes over.
5. **A clean restart shows nothing.** `didReregisterForUpdate` (the banner)
   is set only when a fallback re-register actually ran. Decision 0026 (the
   notice is launch-scoped, never persisted) stands.
6. **Sparkle pre-warns the next launch.** An `SPUUpdaterDelegate` on the
   updater records a launch-scoped UserDefaults marker in
   `updaterWillRelaunchApplication`; the next launch's evaluation consumes it
   and skips the `launchctl print` probe on the restart path. The #163
   force-quit mechanism is kept as is.

## The five questions the brief asked, with sources

### 1. Does SMAppService re-resolve `BundleProgram` on the next spawn, or is the path captured at register time?

**Captured at register time, and the header says so.** `SMAppService.h`
(MacOSX.sdk, ServiceManagement.framework):

> "If an app updates either the plist or the executable for a LaunchAgent or
> LaunchDaemon, the SMAppService must be re-registered or it may not launch.
> It is recommended to also call unregister before re-registering if the
> executable has been changed."

The `BundleProgram` key exists so "a user relocating the app bundle after
installation" keeps working (same header), i.e. the path is bundle-relative
and re-resolved against the bundle's *location*; but the registration also
carries a launch constraint derived from the executable's signature at
register time, and that is what does NOT re-resolve. Issue #514 (2026-08-18,
1.0.2 → 1.0.3) is the warning coming true on Tim's machine: the update
replaced `Contents/Resources/daemon/modeldeckd`, launchd kept enforcing the
constraint from the old binary, and every spawn failed before exec (`state =
spawn failed`, `last exit code = 78`, `needs LWCR update`).

Experiment (throwaway label `ai.hermes.modeldeck-issue678-timing`, macOS
26.5.2, gui domain, my own uid): I bootstrapped a plist with
`EnvironmentVariables.FOO=one`, rewrote the plist on disk to `FOO=two`, then
ran `kickstart -k`. The relaunched process started with `FOO=one`. launchd
re-reads nothing from disk on a kickstart; it respawns from the job record it
already holds.

**Consequence for the design:** a restart alone is enough when the job record
launchd holds is still valid for the new binary, and is NOT enough when it is
not. We cannot tell which from up here before trying. So the restart is the
first rung and the re-register is the fallback, verified the same way the
current code verifies every rung: by asking the running daemon what commit it
is (`verifyDaemonAfterReregister`, one health snapshot).

### 2. What does `launchctl kickstart -k gui/<uid>/<label>` do to a registered SMAppService agent, and does it preserve Login Items approval?

`man launchctl`: "Instructs launchd to run the specified service immediately,
regardless of its configured launch conditions. `-k`: If the service is
already running, kill the running instance before restarting the service."

Measured on throwaway labels (three runs, all booted out and confirmed gone
with `launchctl print` exiting 113 afterwards):

- `-k` delivers **SIGTERM** (the process's TERM trap logged it), then respawns
  once the process has exited. A process that does not exit gets **SIGKILL
  about 5 s later** (a trap that slept 15 s never reached its exit line; the
  replacement started 4.8 s after the signal). Our daemon's shutdown
  (`app.close()` → `server.close()` → `process.exit(0)`) is well inside that,
  and Node 24's `server.close()` closes idle keep-alive connections, so an
  in-flight state read finishes and an idle one does not hold the exit.
- **It honors `ThrottleInterval`.** A `kickstart -k` issued 1.5 s after the
  first spawn blocked for 9.05 s before the new process started; our plist
  sets `ThrottleInterval` to 10. Issued 11 s after spawn it completed in
  ≈ 5 s, all of it the old process's own exit time. The wait budget must
  therefore cover ~10 s plus the daemon's shutdown time, which is why the
  budget stays at 10 attempts.
- **The launchctl client blocks** until the new process has been spawned
  (client returned at +5.03 s, new process logged its start at +5.05 s), and
  the restart proceeds even if the client is killed after 2 s (the request
  has already reached launchd). The live controller therefore awaits the
  client with a 15 s deadline (5 s kill grace + 10 s throttle) and only
  then starts polling, so the old process can never answer a restart probe
  and read as "stale" prematurely; the exit code is not consulted. Like
  every other rung, the model trusts only the running daemon's self-report.
- Nonexistent label → exit **113** ("Could not find service"), the same code
  `print` uses; the classifier already maps it.
- `launchctl kill SIGTERM` on our plist (`KeepAlive.SuccessfulExit=false`)
  leaves the job in `state = not running, last exit code = 0` and launchd
  does NOT relaunch it, because a clean exit is the "do not keep alive"
  condition. That rules out "ask the daemon to exit and let launchd restart
  it" as a one-call mechanism; see question 4.

**Login Items approval:** kickstart is a launchd operation on the job record.
It does not touch the BackgroundTaskManagement (BTM) record that
`SMAppService.status` reads. The header ties `.requiresApproval` to two events
only: registration ("successfully registered, but the user needs to take
action in System Settings") and the user revoking consent in System
Settings. Neither happens on a kickstart. The `.awaitingApproval` handling
therefore stays on the re-register rungs, where the current code already
routes it, and cannot be entered from the restart rung; the tripwire test
`testDriftRestartNeverEntersAwaitingApproval` pins that at the model boundary.

Privilege: `gui/<uid>` is the calling user's own domain; no admin rights, no
prompt. It is the same call shape the existing bootout already uses.

### 3. When does the plist itself change between releases, and when is a full re-register genuinely required?

The plist is `macos/ModelDeckMac/Support/ai.hermes.modeldeck.plist`, a static
file with no template variables (its own header comment says so).
`scripts/release-dmg.sh` copies it byte-for-byte into
`Contents/Library/LaunchAgents/` and runs `plutil -lint` on it; nothing stamps
it. `git log` on the file since #96 (2026-07-20) shows three commits; the two
after the original (#535 on 2026-08-18, #553 on 2026-08-20) changed comments
only, no keys. The 1.0.2 → 1.0.3 update that produced #514 shipped an
identical plist and a changed binary.

Release-time stamping that could alter what launchd sees, from
`release-dmg.sh`: the `Info.plist` stamps (`CFBundleShortVersionString`,
`CFBundleVersion`, `MDGitCommit`, `SUPublicEDKey`) touch the app's Info.plist,
not the agent plist; the daemon `codesign --force --options runtime
--entitlements scripts/daemon-entitlements.plist --sign "$IDENTITY"` re-signs
the binary every release. So per release: plist unchanged, binary changed
(new content, same signing identity and team). Nothing in the repo alters the
plist at build time.

**When a full re-register is genuinely required: whenever the agent plist
changed.** launchd respawns from the job record it already holds (question
1's experiment: a plist edited on disk was NOT picked up by `kickstart -k`),
so after a release that changes a key — a `PATH` entry, `ThrottleInterval`,
an environment variable — a kickstart runs the NEW binary under the OLD
settings. That binary starts fine and self-reports its new commit, the
commit verification passes, and the changed setting is never applied. The
reviewer of PR #687 demonstrated this at the model level (`plist-change`
probe: `runningCommit=new, registeredEnvironment=old, registrationCalls=0`).

The first draft of this note claimed the opposite — that any plist change
"surfaces as a restart that does not take" and so the fallback rung would
catch it — and rejected a plist fingerprint as "new persistent state for a
case with zero occurrences". That claim was wrong: commit verification
measures the binary, not the job record, and cannot see a retained setting.
Struck, and replaced by:

**Mechanism.** The app records, next to the registered commit in the
existing UserDefaults marker, a SHA-256 fingerprint of the bundled agent
plist (`DaemonAgentPlistFingerprint`: the PARSED property list re-serialized
canonically, so comment and whitespace edits — every plist commit since #96
— do not count; key and value changes do). At evaluation:

- recorded fingerprint present and ≠ bundled → `.driftReregister` (full
  unregister → register, banner, today's approval handling), regardless of
  whether the commit moved;
- fingerprints equal (or either side missing) and commit differs →
  `.driftRestart`;
- recorded fingerprint missing (an install from before this change) and the
  registration is `.enabled` → record the bundled fingerprint on this
  launch without re-registering. The registered definition IS this plist:
  it has not changed in any release since #96, and every re-register from
  now on records the fingerprint it registered.

The fingerprint is compared only when both sides exist, so a dev build
without an agent plist and a pre-#678 install both stand down to the
commit-only rule; the comparison can never invent a re-register.

### 4. Can the daemon be asked to exit cleanly so launchd relaunches it?

The daemon handles SIGTERM (`src/server.mjs` ~816: `process.on('SIGTERM',
shutdown)` → `app.close()`, `store.close()`, `process.exit(0)`). But the
plist's `KeepAlive` is `{SuccessfulExit: false}`, which `man launchd.plist`
defines as "restarted in the inverse condition", i.e. only after a NON-zero
exit. Measured: `launchctl kill SIGTERM` on such a job leaves it `not
running` with `last exit code = 0` and launchd does not respawn it. A clean
exit is therefore a stop, not a restart. Flipping `KeepAlive` to `true`
would make every clean exit a relaunch, including the ones the user or a
future uninstall path intends, and would change the plist (question 3).

`kickstart -k` is the mechanism that needs no privileged call, no plist
change, and no daemon change: it sends the same SIGTERM (so the daemon's
clean shutdown runs) and respawns regardless of the exit code. Chosen.

Rejected: an HTTP "please exit" endpoint on the daemon (would need the
mutation token plumbing for a call launchd already offers, and would still
need `kickstart` to restart afterwards); `launchctl kill SIGTERM` + `kickstart`
as two calls (two process spawns for what `-k` does in one).

### 5. Which call revokes Login Items approval, and does the chosen path avoid it?

The header attributes `.requiresApproval` to registration and to the user
revoking consent. `unregister()` "kills the service" and removes the BTM
record; the following `register()` creates a new record, and macOS may put a
NEW record behind the approval gate (the current code's comment at
`reregister()` records that this was observed: "The unregister/register
round-trip can revoke Login Items approval"). The revocation is a property of
re-registering, not of restarting.

The chosen path (kickstart) never calls `unregister()` or `register()`, so a
plain update cannot land in `.awaitingApproval`. The fallback rungs can, as
they can today; the existing handling (route to the approval card with "Open
Login Items" and "Check Again") is kept unchanged there. This is the honest
residual: an update whose kickstart does not yield the new commit within the
budget still takes the re-register path and can still hit the approval gate.
The PR says so.

## Alternatives rejected

- **Keep the re-register but run it concurrently and drop the banner.**
  Still revokes approval on some updates; still ~55 s worst case; the
  header's own advice makes it the fallback, not the first move.
- **Do nothing on drift; let the old daemon keep running until its next
  crash.** Hides a wrong-version daemon behind a new app indefinitely; the
  0.3.13 → 0.3.15 incident (a daemon surviving two upgrades) is why the
  running commit is verified at all.
- ~~**Store a plist hash and re-register only on plist change.** New
  persistent state, a new way to be wrong, for a case with zero occurrences;
  the fallback rung already covers it.~~ Struck after the PR #687 review:
  the fallback rung cannot see a retained setting (§3). This IS the chosen
  mechanism now.
- **Detect a plist change by comparing against the record launchd holds
  (`launchctl print`).** Rejected: `launchctl print` output "is NOT API in
  any sense" (`man launchctl`) and does not print the environment in full;
  the fingerprint of the file this app itself registered is the honest
  comparison.
- **Initiate the daemon restart in `updaterWillRelaunchApplication` itself.**
  Sparkle calls it immediately before the app terminates; the daemon at that
  moment would respawn from the OLD bundle (the swap happens after the host
  terminates: `Autoupdate/AppInstaller.m`, `finishInstallationAfterHostTermination`),
  so the restart would be wasted and the next launch would drift anyway. The
  delegate records intent only; the restart runs on the next launch.

## Fallback ladder (what the code implements)

| Rung | Trigger | Action | Touches registration? | Banner? |
| --- | --- | --- | --- | --- |
| 0 | `.driftReregister` (enabled, agent plist fingerprint differs from the recorded one) | unregister → register (once), wait, verify — a restart cannot apply a changed definition (§3) | Yes | Yes |
| 1 | `.driftRestart` (enabled, launchd job present or relaunch marker set, commit differs, plist fingerprint unchanged or unrecorded) | `kickstart -k` (await the client ≤ 15 s), wait ≤ ~15 s with 1 s probes, verify running commit | No | No |
| 2 | Rung 1 verified stale, or nothing answered and launchd reports the job present | unregister → register (once), wait, verify | Yes | Yes |
| 3 | Rung 2 verified stale, or spawn-rejected (#514) | bootout → unregister → register (once), wait, verify | Yes | Yes |
| 4 | Rung 3 still stale | `.failed(staleDaemonAfterRestartMessage)` | — | — |

`.staleLaunchConstraintRepair` (#514), `.wedgedServiceRepair`, and
`.staleDaemonRestart` keep their current routing straight to rung 3; their
tripwires are unchanged in intent. One precedence change: the wedge rule
(enabled, launchd reports no such job, nothing answering) now sits ABOVE
drift, because kickstarting a job launchd cannot find is a guaranteed 15 s
wait for nothing; before, drift outranked it and ran the plain re-register,
which is what the wedge repair does anyway plus a no-op bootout.

The relaunch marker skips the `launchctl print` probe only when drift is
actually present (recorded commit ≠ bundled). A marker with no drift takes
today's path, so a wedged or spawn-rejected job on a same-commit relaunch
is still seen by the probe.

Known and tracked separately: `evaluateOnLaunch()` / `retry()` have no
single-flight guard, so a Check Again during an in-flight evaluation can
run a second ladder (review of PR #687, pre-existing on main) — issue #688.

## Open items

- macOS 14 and 15 were not measured; the experiments ran on macOS 26.5.2, the
  only OS on this machine. `kickstart -k`, `ThrottleInterval`, and
  `KeepAlive.SuccessfulExit` semantics are documented in `man launchctl` /
  `man launchd.plist` unchanged since launchd 2, and the SMAppService header
  text quoted above carries `API_AVAILABLE(macos(13.0))`. Live verification
  on Tim's next real update is the confirming evidence, as it was for #514.
