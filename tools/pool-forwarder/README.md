# Pool forwarder

Keeps a client's proxy address at `127.0.0.1:8317` while sending inference to
one pool host. The host must expose `/v1` and `/healthz` over Tailscale HTTPS.
`/healthz` must return `{"status":"ok"}`. Management routes are never forwarded.

```sh
POOL_HOST_URL=https://studio.tail0000.ts.net node tools/pool-forwarder/forwarder.mjs
POOL_HOST_URL=https://studio.tail0000.ts.net tools/pool-forwarder/launch-agent.sh install
tools/pool-forwarder/launch-agent.sh status
tools/pool-forwarder/launch-agent.sh uninstall
```

`POOL_HOST_URL` is an HTTPS origin on a `*.ts.net` hostname or a
`100.64.0.0/10` IPv4 address. Plain HTTP, single-label names, localhost aliases,
credentials, paths, queries and fragments are refused. `PORT` defaults to 8317.
The bind address is always `127.0.0.1`; `HOSTS` is unsupported.
The request Host must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`
with the actual listening port; other hosts receive 400.

Only GET/HEAD `/healthz` and any method on `/v1` or `/v1/*` pass the normalized
path check. Encoded separators and nested escapes are refused. Requests and
responses are piped with backpressure; active streams have no inactivity or
whole-request deadline. Header arrival has a two-minute limit. Hop-by-hop and
Connection-nominated headers are removed both ways. Client Authorization is
preserved; no forwarding headers are added. Logs contain only startup and fixed
failure classes with `/v1` or `/healthz`, never query strings or credentials.
Incoming chunked bodies are framed again by Node for every method, including
GET and HEAD. Transfer-Encoding plus Content-Length receives 400. Invalid
upstream statuses, upgrades and informational responses other than 100 receive 502.

The installer uses `ai.modeldeck.pool-forwarder`, refuses a port held by another
process, and writes under `$HOME/Library/LaunchAgents`. Logs go to
`$HOME/Library/Logs/modeldeck-pool-forwarder.log`. Tests override `LAUNCHCTL`,
`LSOF`, `NODE`, and `LAUNCH_AGENTS_DIR` and use a temporary HOME.
Both scripts resolve Node from PATH when `NODE` is unset and require an
absolute executable path, which is stored in the plist for launchd.

For an ordered switch, `scripts/pool-target.sh remote --hub-url
https://studio.tail0000.ts.net --page-url http://100.64.0.10:3871` prints the plan.
`host` prints the reverse plan. Only `--yes` applies it; `status` reads state.
Before changes, the script validates the mutation token and port ownership;
remote mode also requires both local job plists. Remote mode disables the local
jobs before stopping them, so they stay stopped across logins. Host mode enables
them and starts only unloaded jobs. Status includes launchd's disabled state.
On failure, printed `bash -c '...'` undo commands restore previous settings and
the saved forwarder plist. Failed runs retain the backup under
`~/Library/Application Support/ModelDeck/pool-target-backups/` (mode 0700). Token headers
and the session cookie go from Keychain through standard input, never arguments
or environment variables. Service commands and file utilities have environment
path overrides for isolated tests.

After the local proxy is healthy, host mode reads routed Claude profiles from
the daemon and admits their per-profile Keychain keys to the local proxy. It
compares SHA-256 hashes to skip existing keys and appends missing keys through
the local management API. The local management key comes from
`~/.config/cliproxyapi/.mgmt-key` (`MANAGEMENT_KEY_FILE` overrides the path).
Keys travel only through captured output, memory and curl stdin, on this Mac.
If the daemon is down, host mode still restores the local jobs and prints the
exact command to apply settings and restore keys once the daemon returns.

```sh
node --test tools/pool-forwarder/forwarder.test.mjs test/pool-target.test.mjs test/version-skew.test.mjs
```

Socket tests bind only ephemeral loopback ports. A second smuggling regression
uses Node's real HTTP parsers over in-memory streams, without a listening socket.
If a sandbox refuses listen,
they explicitly skip and require an unsandboxed orchestrator run. No test uses
the live proxy, daemon, launchd or Keychain. The timeout assertions cover long
silent streams without waiting several minutes in the suite.

## Linux

`scripts/install-systemd-unit.sh --role forwarder --env POOL_HOST_URL=https://<hub>.ts.net`
installs the forwarder as `modeldeck-pool-forwarder.service` on 127.0.0.1:8317.
On Linux `scripts/pool-target.sh` hands off to `scripts/pool-target-linux.sh`,
which has the same modes, plan, `--yes` and printed undo on systemd user units.
`PROXY_UNIT` (default `cliproxyapi.service`), `REBALANCE_UNIT` (default
`modeldeck-rebalance.timer`), `FORWARDER_UNIT` and `PROXY_PORT` name a scratch
setup's units and port. The mutation token comes from
`~/.config/modeldeck/mutation-token`. Host mode also admits this machine's
`~/.config/modeldeck/pool-client-key` to the local proxy.
