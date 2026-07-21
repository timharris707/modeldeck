# Claude identity switching

ModelDeck switches two separate pieces of Claude state. The `~/.claude`
symlink selects the profile home. `CLAUDE_SECURESTORAGE_CONFIG_DIR` tells
Claude Code to select the Keychain entry scoped to that profile's real path.
Claude Code itself creates and manages those entries; ModelDeck never reads,
copies, or writes credential values.

Run `scripts/install-shell-env.sh` once. It idempotently adds a marked block
to `~/.zshenv` so new terminal sessions derive the secure-storage scope from
the active symlink. Run `scripts/install-shell-env.sh --remove` to undo it.
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
     http://127.0.0.1:4317/api/accounts/ACCOUNT_ID/reset-identity
   ```

6. Refresh ModelDeck. A solid check appears only after the active identity
   matches the recorded profile identity.

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

`CLAUDE_SECURESTORAGE_CONFIG_DIR` is an undocumented Claude Code interface.
ModelDeck currently treats 2.1.215 as the known-good minimum and deliberately
degrades verification for older versions. Revalidate this behavior when
upgrading Claude Code.
