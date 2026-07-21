# Claude identity switching

ModelDeck switches two separate pieces of Claude state. The `~/.claude`
symlink selects the profile home. `CLAUDE_SECURESTORAGE_CONFIG_DIR` tells
Claude Code to select the Keychain entry scoped to that profile's real path
— **on CLI versions before 2.1.216 only; see the next section**. Claude Code
itself creates and manages those entries; ModelDeck never reads, copies, or
writes credential values.

## Claude Code ≥ 2.1.216: credentials follow the resolved active home (issue #99)

Claude Code 2.1.216 changed credential scoping: `claude /login` writes the
credential to the Keychain service derived from the **resolved (realpath)
`~/.claude`** — `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`
no longer steer where the credential lands. Config writes (`.claude.json`)
still respect `CLAUDE_CONFIG_DIR`, so an env-scoped login on such a version
splits its own brain: the target profile's `.claude.json` claims the new
identity while the token actually overwrote the ACTIVE profile's credential
slot (the issue #65 blind spot, now a guaranteed outcome).

Consequences, verified live on 2026-07-21:

- The old per-profile sign-in guidance (`CLAUDE_CONFIG_DIR=<profile> claude
  auth login`) is **broken** on ≥ 2.1.216 — it silently cross-wires
  accounts. Do not use it there.
- The only known-good steering mechanism is the real `~/.claude` flip:
  **activate the target account in ModelDeck first** (the symlink then
  resolves to its profile), run a plain `claude /login`, and verify the
  identity **while the target is still active**. Only then optionally
  re-activate the previous account.
- A fake-HOME variant (`HOME=<scratch>` with `.claude` symlinked at the
  profile) does **not** work: claude treats it as a fresh unauthenticated
  install and resets the profile's `.claude.json`.

ModelDeck automates this: the daemon detects the installed CLI version and,
from 2.1.216 on, issues activation-driven login specs
(`GET /api/accounts/:id/login` returns `flow: "activation"` and
`requiresActivation: true` with a plain `claude /login` command). Both app
sign-in flows (add-account and the roster's "Sign in again") activate the
target, run the login, verify, and restore the previously active account
after verification passes. When the version cannot be detected, ModelDeck
assumes the new behavior — the activation-driven flow steers correctly on
every known version, while the env-scoped flow cross-wires on current ones.

Enforcement (the teeth for the #65 blind spot): after any sign-in ModelDeck
drives or instructs, `POST /api/accounts/:id/verify` compares the read-back
identity against the account's recorded identity. On disagreement it
**refuses** — nothing is recorded, the response carries
`identityMismatch: { expected, actual }`, and the app surfaces it as a
failure with the target left active so a corrective `/login` lands in the
right slot. `GET /api/tools` reports which regime the installed CLI is in
(`credentialScoping: "config-dir" | "resolved-home"`).

## Session pinning (issue #66)

Claude Code resolves its config dir once at startup (`CLAUDE_CONFIG_DIR`,
else `~/.claude`) without `realpath()`, then re-resolves the transcript path
— through any symlink — on every append. A session launched through the
managed symlink therefore splits its transcript across profiles when the
symlink flips, and a later resume through the flipped symlink succeeds
silently with only the post-flip half (silent amnesia; verified on CLI
2.1.216).

The fix pins new sessions at the shell layer. At every account activation
the daemon atomically rewrites
`~/Library/Application Support/ModelDeck/claude-env.sh` exporting **both**
`CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the **same
string**: the active profile's resolved real path taken from ModelDeck's
records at activation time (never a launch-time readlink, which would race a
flip). It also runs `launchctl setenv` for the same pair so GUI-launched
apps inherit the pin. The two variables must never diverge — a
secure-storage scope pointing at a different profile would make a session
store transcripts under one profile while authenticating as another.

What is protected:

- Sessions launched after the env is in place (terminal via the `~/.zshenv`
  block, GUI apps via launchd) keep their config dir, transcript storage,
  and Keychain scope on the profile that was active at launch, across any
  number of later switches. Resume (`claude -r`) under the same pin finds
  the full transcript. Daemon-issued login/launch specs re-apply the pair.
- Subagents and background tasks: the CLI forwards `CLAUDE_CONFIG_DIR` into
  every spawned subprocess.
- Identity (**< 2.1.216 only**): with the pair set, the Keychain entry scope
  is the pinned path, so a pinned session cannot silently adopt another
  profile's credential. On ≥ 2.1.216 credential lookups follow the resolved
  `~/.claude` instead (issue #99), so a pinned session's TRANSCRIPTS stay
  insulated from a later flip but its credential scope does not — a
  limitation of the new CLI behavior, listed under "What is NOT protected".

What is NOT protected:

- Sessions that were already running before the pinned env existed (or
  launched from surfaces that bypass `~/.zshenv` and launchd) still resolve
  through the symlink and can split their transcript on a flip. The
  activation response carries a `warnings` entry when running `claude`
  processes are detected at flip time.
- On CLI ≥ 2.1.216, credential lookups follow the resolved `~/.claude` at
  use time (issue #99), so no environment pinning can keep a running
  session's credential scope on its launch profile across a flip. Native
  multi-account rearchitecture is tracked separately.
- Pinned sessions read `<configDir>/.claude.json` instead of the shared
  `~/.claude.json`, so project trust, MCP approvals, and history no longer
  cross profiles — intended isolation, but expect one-time re-prompts.
- GUI-launch pinning is best-effort: `launchctl setenv` cannot set the two
  variables atomically, so a GUI app spawned in the instant between the two
  adjacent calls could observe a mixed pair. Accepted deliberately — a real
  fix needs a different launch mechanism; terminal sessions source the
  atomically written (temp + rename) env file and are unaffected.
- `claude service install` refuses a non-default config dir.

Run `scripts/install-shell-env.sh` once. It idempotently adds a marked block
to `~/.zshenv` that sources the daemon-written snippet (falling back to
deriving the secure-storage scope from the active symlink until the first
activation writes the snippet), and it upgrades any older readlink-only
block in place. Run `scripts/install-shell-env.sh --remove` to undo it.
The daemon also calls `launchctl setenv` during activation for apps launched
from the macOS GUI environment. A failure does not prevent the home switch,
but the deck reports identity as unverified.

Each profile needs a one-time migration ceremony:

1. Activate the profile in ModelDeck.
2. In a new terminal, run `claude` and then `/logout`. Observed on CLI
   2.1.215: the first run under a scoped-but-empty profile whose scope matches
   the active home silently adopts the legacy unscoped Keychain login into the
   scoped entry — you appear logged in as whoever the shared login was. The
   `/logout` flushes that adopted credential. (Side effect: the legacy shared
   entry may also be cleared; other not-yet-migrated surfaces such as the
   desktop app may ask to sign in again. Harmless.)
3. Run `claude` again and `/login` as the account named by the profile label.
4. Run one Claude session so Claude writes `oauthAccount` identity facts to
   the profile's credential-free `.claude.json`.
5. Reset the stored identity for that account. This clears any bad seed left
   over from the shared-Keychain era so ModelDeck can capture the identity
   written by the session you just ran. Obtain the standard mutation token
   from the Keychain entry named `modeldeck` / `mutation-token`; do not put its
   value in documentation or logs. Using the same token in the standard header
   and session cookie:

   ```sh
   curl -X POST \
     -H "X-ModelDeck-Token: $MODELDECK_TOKEN" \
     -H "Cookie: modeldeck_session=$MODELDECK_TOKEN" \
     http://127.0.0.1:3867/api/accounts/ACCOUNT_ID/reset-identity
   ```

6. Refresh ModelDeck. A solid check appears only after the active identity
   matches the recorded profile identity.

Usage-fingerprint verification is the strongest check because it exercises
each profile's actual scoped credential. After every approved Claude usage
refresh, the daemon compares the overall weekly reset instants (rounded to the
nearest second) across profiles. Profiles sharing an instant are marked
`duplicate-token`; the warning clears on a later refresh when the fingerprints
no longer match. Missing or stale weekly data is never treated as a match.
In the app, each flagged account shows a hollow warning marker (deck popover
and Settings → Accounts alike) with the tooltip "Two profiles appear to hold
the same login — redo /login for one", and the Accounts section carries one
consolidated banner naming the flagged accounts.

Automatic identity capture is deliberately conservative. An inactive profile
is recorded with `metadata.identitySource` set to `seed`. An active profile is
captured as `verified` only while secure-storage scoping is active for that
profile's real path. Otherwise ModelDeck leaves the identity empty and reports
`identity-unverified`, avoiding false confidence from a shared login.

Activation states are intentionally honest: `effective` means the home and
identity both match; `identity-mismatch` means the active runtime identity is
different; `identity-unverified` means either identity is unknown, the CLI is
older than the verified scoping floor, or environment setup degraded.
`mismatched`, `unlinked`, and `blocked` retain their physical-link meanings.

`CLAUDE_SECURESTORAGE_CONFIG_DIR` is an undocumented Claude Code interface,
and the pinning behaviors above (no-realpath config resolution, per-append
symlink re-resolution, subprocess env forwarding) are undocumented internals
still observed on 2.1.216. The Keychain-scope derivation changed underneath
them: env-derived on 2.1.215 (the known-good minimum for scoped
verification, older versions degrade), resolved-`~/.claude`-derived from
2.1.216 on (issue #99 — sign-ins become activation-driven there). Every one
of these behaviors is version-fragile: revalidate all of this on every
Claude Code upgrade.
