# 0046 — On Linux, ModelDeck's secrets are owner-only files

- Date: 2026-10-31
- Links: issue #806 (design comment), #807, decisions 0014, 0016, 0045
- Status: recorded by the implementing session; Tim may overrule

On macOS the mutation token and the proxy client keys live in the login
Keychain. A headless Linux box has no Keychain, so each secret becomes one file:

- **Where.** `~/.config/modeldeck/`, mode 0700, each secret a 0600 file with
  one line. `MODELDECK_SECRETS_DIR` overrides the directory for tests and
  scratch instances. `XDG_CONFIG_HOME` is deliberately not read: set in an SSH
  shell but not in the systemd unit, it would put the CLI and the daemon in
  different folders (Codex review of #813).
- **Refused, never read, when unsafe.** The daemon opens the file without
  following links and checks the open descriptor: a regular file, owned by the
  user, no group or world bits, in a directory with the same properties. A
  refused token file leaves the daemon on an ephemeral token, so mutations
  fail closed, and the one log line names the path and the problem, never the
  value.
- **Written only by the user's own tools.** `scripts/set-mutation-token.sh`
  writes the token file atomically under umask 077; it never prints a
  generated token. The no-print rule is unchanged: no secret in argv, env
  files, unit files, logs or URLs.

Rejected:

1. **libsecret (GNOME Keyring).** On a headless box nothing unlocks the keyring
   at login, `secret-tool` is not installed on L.Box, and an unlocked keyring
   protects nothing more than a 0600 file from a process running as the same
   user.
2. **systemd credentials as the main store.** They encrypt at rest and hand a
   secret to one unit only, but the client-key helper, the shell env block and
   the operator scripts also need the values, so a second plain copy would
   exist anyway.

The threat model is the same user: on Linux the Claude CLI, Codex and
CLIProxyAPI already keep their sign-ins as 0600 files in the same home, so a
0600 file matches the strongest protection already present. Nothing here goes
into a container (conduct rule 22), and ModelDeck still never writes, renews or
copies a sign-in (0014, 0016).
