# Phone Deck

A read-only ModelDeck usage page for Tim's iPhone and iPad, available only on
his tailnet. By default it combines the M1 and M5 readings into one card per
account, using the freshest reading for each usage window. Hub mode reads only
the pool host’s daemon. As on the Mac deck, a Claude
card leads with its all-models weekly window; Codex cards, and Claude cards
without a weekly, lead with the lowest remaining window.

## Run on the M1

Requires Node (the repo's supported version), the local ModelDeck daemon,
Tailscale, and an existing SSH host named `m5` with noninteractive access.
No package installation is needed.

From the repo root, for a foreground run:

```sh
node tools/phone-deck/server.mjs
```

It listens on `127.0.0.1:3871` by default. Stop a foreground run with Ctrl-C.
`PORT` and `HOSTS` override the listener; keep the loopback default for tailnet
use. `M5_HOST` overrides the SSH host for a manual run.

To keep it running after login, use a stable checkout on the M1:

```sh
tools/phone-deck/launch-agent.sh install
tools/phone-deck/launch-agent.sh status
```

The installer uses `/opt/homebrew/bin/node` and writes
`~/Library/LaunchAgents/ai.modeldeck.phone-deck.plist`, with this folder as its
working directory, `PORT=3871`, `HOSTS=127.0.0.1`, RunAtLoad, and KeepAlive.
Both output streams go to `~/Library/Logs/modeldeck-phone-deck.log`.
Do not move or delete the checkout while it is installed. Re-run install after
updating the server. It refuses to replace another process on port 3871 and
prints instructions to stop the old `ai.modeldeck.phone-deck-proto` agent.

The installer checks Tailscale's serve status and, if it cannot confirm a
matching entry, prints this command. It does not change Tailscale configuration:

```sh
tailscale serve --bg --tcp=3871 tcp://127.0.0.1:3871
```

Use Tailscale Serve, which is tailnet-only. Do not enable Funnel or bind the
server publicly. The page has no separate sign-in; tailnet access controls
determine who can open it. It answers only when the address in the browser is an
IPv4/IPv6 address, `localhost`, a name ending `.ts.net`, or this machine's short
hostname. Optional `ALLOWED_NAMES` adds comma-separated short names using only
lowercase `a-z`, digits and hyphens (no spaces or empty entries). Set it to an
empty string to clear aliases. Other names are refused to limit DNS rebinding.

## Run on the pool host (hub mode)

Set `SOURCES=local` to read only the pool host's ModelDeck daemon at
`http://127.0.0.1:3867` (GET state, exhaustion forecast, and history). Hub mode
never runs SSH or lists the pool auth directory, and adds no Grok/Antigravity
placeholder cards. `MACHINE_LABEL` names the source, defaults to `Studio`, and
must be 1–24 ASCII letters, digits, spaces, or hyphens. `SOURCES` must be exactly
`local` or unset; other values (including an empty string) refuse startup.
`MACHINE_LABEL` without `SOURCES=local` also refuses startup. `DAEMON_PORT`
(default 3867) points hub mode at a daemon on another loopback port, for a
scratch hub. On Linux, `scripts/install-systemd-unit.sh --role usage-page
--env SOURCES=local --env MACHINE_LABEL=...` installs it as a systemd user unit.

```sh
SOURCES=local MACHINE_LABEL="Studio" node tools/phone-deck/server.mjs
SOURCES=local MACHINE_LABEL="Studio" tools/phone-deck/launch-agent.sh install
```

On reinstall, unset shell variables `SOURCES`, `MACHINE_LABEL`,
`ALLOWED_NAMES` and `DAEMON_PORT` carry over from the installed plist, with a
notice for each.
Explicit shell values override the saved ones. A fresh install with no source
settings uses two-Mac mode. The installer validates the effective settings with
the server's rules before writing the plist or changing the agent.
To deliberately leave hub mode, use `tools/phone-deck/launch-agent.sh install --two-mac`;
this clears `SOURCES`, `MACHINE_LABEL` and a saved `DAEMON_PORT` (back to
3867), keeping any host aliases.

Keep the loopback listener. Publishing needs Tim's OK at cutover and must never use
Funnel. Installing does not publish it. On the Studio, the approved cutover command is:

```sh
tailscale serve --bg --tcp=3871 tcp://127.0.0.1:3871
```

The phone opens `http://<Studio-tailnet-IP>:3871/` using the Studio's tailnet address,
instead of the M1 address below.

`GET /api/status` (also HEAD) returns `generatedAt` and each source's
`name`, `ok`, `reachable`, and `readAt`, using the same cached deck as `/api/deck`.
`ok` says whether the most recent state read attempt succeeded; `reachable` keeps
its five-minute grace period, and `readAt` is the last successful state read.
It permits no CORS access. Remote Macs' daemons read it every minute (#788).

In hub mode it also returns `pool` (#827): `readAt` and, for each enabled pool
member, `provider`, `match`, `weight`, `fableExcluded`, `credential` and
`credentialDetail`. `match` is a one-way tag of the account's identity
(`src/pool-member-tag.mjs`), so a remote Mac can pair its own card with the
member without the page sending a name, email or account id. Accounts outside
the pool are left out. `credentialDetail` is never the proxy's own status
text: it is a retry time for a resting member, `provider overloaded` for an
overload, or null. A remote Mac refuses any other value, and shows the record
only while it is under 10 minutes old, counted from the page's `readAt` or its
arrival, whichever is earlier. Two-Mac mode sends no `pool`.

## Open on iPhone or iPad

1. Connect Tailscale on the phone or tablet to the same tailnet.
2. Open Safari at **http://100.97.205.116:3871/** (the M1's tailnet address).
3. Tap **Share → Add to Home Screen → Add**. If Share is in Safari's menu,
   open that menu first. Launch Phone Deck from the new home-screen icon.

## What it reads

- **Hub mode (`SOURCES=local`):** only the pool host's daemon at
  `127.0.0.1:3867`, using GET requests for `/api/state`,
  `/api/usage/exhaustion-forecast`, and `/api/usage/history`. No SSH or pool
  directory reads.
- **Two-Mac mode (`SOURCES` unset):** the same GET endpoints on the local M1
  daemon and the M5 daemon through `ssh m5 curl …`. File **names only** in the
  M1's `~/.config/cliproxyapi/auth` directory count Grok and Antigravity sign-ins;
  the files are never opened.
- **Both modes:** this folder's page, manifest and icons, and the repo's provider images.

The browser receives display labels, plans, usage percentages, reset times,
reading ages, sign-in status, forecasts/history, and the M5 pool's routing
weights. It omits account email fields, account UUID fields, tokens, profile paths, and
credentials from the projection. Use non-identifying display labels. A whole
display string becomes `[redacted]` if it contains any of these patterns:

- An email-shaped value with `@` or `%40`, or a hyphenated UUID.
- `/Users/`, `/home/`, `~/`, `/private/`, `/Volumes/`, or `/var/` path prefixes.
- `sk-` or `xai-` (any case), or `ghp_`, `gho_`, `github_pat_`, `AIza` or `ya29.`
  (exact case), at the start of a word and followed by six or more non-space
  characters; `Bearer` followed by a token; or an `eyJ`-prefixed base64url run
  (including JWTs).
- A run of 32 or more base64/base64url characters (letters, digits, `_`, `-`,
  `+`, `/`, optional `=` padding) that looks random: it contains a digit and is
  either all hex or mixes upper- and lower-case letters. This catches 32/40-hex
  strings, dashless UUIDs and the 43-character keys ModelDeck mints, and leaves
  long ordinary words such as window scopes alone.

Other text stays unchanged; this is pattern redaction, not a guarantee that
arbitrary identifying prose is detected.
No provider calls, refreshes, sign-ins, routing changes, or credential writes
are made by this tool.

State reads are cached for 60 seconds, forecasts for five minutes, and history
for ten minutes. Local reads have a 25-second timeout; remote curl reads use
`-m 15`. A failed read retains the previous data. A Mac stays reachable for five
minutes after its last successful read, then shows as unavailable; an unavailable
M5 is retried no more often than every two minutes.

## Stop

```sh
tools/phone-deck/launch-agent.sh uninstall
```

This stops and removes only the maintained phone-deck agent. Logs and Tailscale's
serve entry remain; with the server stopped the entry cannot serve the page.
To remove that forwarding entry as well:

```sh
tailscale serve --tcp=3871 off
```

## Offline checks

```sh
node --test tools/phone-deck/phone-deck.test.mjs
node --check tools/phone-deck/server.mjs
bash -n tools/phone-deck/launch-agent.sh
```

The tests import the pure deck builder with placeholder machine states. Live
HTTP calls, SSH, pool/file reads, and starting an HTTP server are blocked by test
stubs. Installer tests use a temporary HOME, fixture plists, and replacements for
all service and Tailscale commands; they never run the live installer. The repo's ordinary `node --test` discovery also finds the test file. Do not start the
server or run the installer to verify changes in a sandbox.
