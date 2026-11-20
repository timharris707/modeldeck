# Direct usage readings (#834)

Decided by Tim, 2026-11-19: ModelDeck shows Claude usage only from what Claude Code itself
hands over during real work, read where each account is signed in; the Studio shows all
accounts on the hub page's design. Chili runs its own copy and its numbers stay on the Chili
side.

## Rule

ModelDeck never reads, copies or moves a sign-in token and never calls Anthropic for usage.
It reads only what Claude Code reports through documented interfaces:

- **T3 conversations (Agent SDK):** the `rate_limit_event` message. T3 saves it in
  `~/.t3/userdata/logs/provider/*.log`; the line names the T3 entry (`claude-<name>`), whose
  `homePath` in T3's `settings.json` is the account folder `~/.claude-accounts/<name>`.
- **Terminal `claude`:** the status line payload's `rate_limits` (follow-up; not built here).

## What a reading is

- Weekly all-models window: percent used, reset time, status (allowed, warning, rejected).
  A five-hour window is read too if Claude Code ever reports one again.
- Sent when a conversation starts and again each time the percent changes (Linux box,
  2026-11-19: 8% at 10:23, 9% at 10:32, 10% at 10:48 PST, matching the hub's 10%).
- No per-model weekly ("Weekly · Fable") and no 5-hour window today: neither source has one.
  An idle account keeps its last reading; its card says how old it is.

## The reader: `tools/direct-usage/reader.mjs`

One self-contained file (Node built-ins only), run on the machine that holds the sign-ins:

1. Lists `~/.claude-accounts/*`; from each `.claude.json` keeps only `oauthAccount.accountUuid`
   and the plan name. The uuid joins the same account across machines.
2. Maps T3 entries to folders from T3's `settings.json`; entries outside the accounts folder
   (the retired pool) are ignored.
3. Reads new bytes of T3's provider logs, keeping only `rate_limit_event` lines on mapped
   entries, and counts conversations that reached Claude (assistant lines) for the health check.
4. Keeps readings for 8 days in `~/.cache/modeldeck/direct-usage/state.json` (mode 600), so
   readings outlive T3's log pruning and each run reads only new lines.

It never opens a credential file or the Keychain and makes no network call; a test fails if
its source ever names either. Measured: 0.16 s on the M1, 0.6 s on the Linux box (75 MB of
logs, no cache).

## The Studio page: `tools/phone-deck` with `MACHINES`

`MACHINES="Studio=local,Linux box=linux,M5=m5,M1=tim-m1-worker"`. For each machine the page
reads its ModelDeck daemon as before and runs the reader there (in-process locally, or piped
over SSH to `node --input-type=module`, so remote machines need no checkout). No new listener
anywhere. Cards merge by account uuid; the newest reading per window wins; a direct folder
counts as signed in; each direct card shows "Read 9 min ago · Linux box · T3". A banner names a
machine whose reader failed, or whose T3 ran Claude conversations in the last day with no
reading in its log (a T3 update changed the log).

Until step 3 the daemons' token readings (every 5 minutes) keep winning on freshness; after
it, only direct readings remain.

## Not in this change (step 3: Tim's go on one list)

Token probe and its schedule, ModelDeck's own renewals, the 18 sign-ins in ModelDeck's profile
folders, Claude account switching, the Mac deck app's card states, installing the page on the
Studio (Tailscale serve on 3871), and the terminal status line reader in the direct folders.
