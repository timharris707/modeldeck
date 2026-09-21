# 0042 — Move the Codex profile root while ChatGPT holds it: rename in place, leave an alias behind

- Date: 2026-09-19
- Links: issue #693, issue #676 (retry-until-quiet), issue #677 (deck line), issue #647 (the original move, FINISH-647.md), issue #651 (uninstall)
- Status: **Tim ruled for Candidate A on 2026-09-19** (build lane gpt-6-astra effort medium, adversarial review gpt-6-astra effort high). Two candidates below kept for the record.

## The problem, in Tim's words

"I clicked the Move Now button. It showed that it was moving, and then after
about 10 seconds or so, it just switched back to showing Move again, so it
doesn't seem like it actually worked."

The click worked. The daemon ran the check, found the old folder held, and
reported the same holders as before, so the line redrew byte-identical.

## What holds the old folder, measured on Tim's Mac (2026-09-19 evening)

`lsof +D ~/.codex-profiles` took 2.3 s and named 16 processes:

| Who | What it holds under `~/.codex-profiles/insight` |
| --- | --- |
| ChatGPT itself (pid 1999, no `CODEX_HOME` in its environment) | `sqlite/codex-dev.db` plus its `-wal` and `-shm`, six connections on `ipc/ipc.sock` |
| three `codex` app-server helpers ChatGPT spawned, each launched with `CODEX_HOME=~/.codex-profiles/insight` | `state_5.sqlite`, `logs_2.sqlite`, `queue_1.sqlite`, `thread_history_1.sqlite` and their WAL/shm files, four session `rollout-*.jsonl` files, thread-writer locks, `tmp/arg0/*/.lock` |
| twelve `node` children of those helpers | working directory inside `plugins/cache/...` |

ChatGPT gets the path by resolving `~/.codex` (a symlink to
`~/.codex-profiles/insight`) and passing the real path to its helpers. The
folder is held for as long as ChatGPT is open, which on Tim's Mac is all day.
The retry-until-quiet design from #676 assumed a quiet window. There is none.

Other facts that matter:

- `~/.codex-profiles` and ModelDeck's data directory are on the same volume
  (device 16777229 for both). A rename is atomic and moves no bytes.
- Four profiles live there. Between them: one unix socket (`insight/ipc/ipc.sock`),
  no hard links, 2,109 symlinks. 2,091 are relative links between profiles
  (`loanmeld/sessions/... -> ../../../../../insight/sessions/...`, the shared
  transcript layer). 24 are absolute links outside the root (`AGENTS.md ->
  ~/.codex-shared/AGENTS.md`, `applypatch -> /opt/homebrew/...`). One is an
  absolute link back into the root
  (`insight/plugins/cache/openai-bundled/chrome/latest -> ~/.codex-profiles/insight/plugins/.../26.915.31945`).
  Today's mover refuses the socket ("unsupported file type") and that last
  link ("symlink would change meaning"), so even a quiet window would not
  have moved Tim's tree.
- The destination socket path would be 90 characters, under the 103-byte
  unix socket limit.

## What a rename does to a process that holds the folder (probed on dummy files)

Throwaway Node script, temp directory, dummy bytes: open a file for append,
bind a unix socket, start a child with its working directory inside the tree,
then `rename` the tree and put a symlink (the alias) at the old path.

| After the rename + alias | Result |
| --- | --- |
| write through the already-open file descriptor | lands in the moved tree; readable at both the new path and the old path |
| connect to the socket by its OLD path | works (resolves through the alias) |
| connect to the socket by its NEW path | works (same inode) |
| a process creating a NEW file by the old path (the `CODEX_HOME=<old>` helpers) | the file appears in the moved tree |
| child whose working directory was inside the tree | unaffected (a working directory is an inode reference) |
| something recreates a real directory at the old path before the alias goes in | `symlink` fails EEXIST, `rename` of a symlink over it fails EISDIR: detectable, rollback is a rename back |

So with a rename there is exactly one tree, before and after. The drift the
issue asked me to characterise ("a write to the old tree after the copy that
is not reflected in the new tree") only exists for a COPY. A copy is also the
one thing `docs/ACCOUNT_ONBOARDING.md` forbids for Codex homes: `auth.json`
refresh tokens can be single-use, so two copies can invalidate each other.
The rename never duplicates `auth.json`.

The residual gap is the few microseconds between the `rename` and the alias
`symlink` (two syscalls; macOS has an atomic swap, `renamex_np`, but Node does
not expose it). A path-based open in that window gets ENOENT once. For
SQLite that is one statement returning "cannot open", retried by the next
statement; for a helper it is one logged error. Nothing corrupts, because the
files themselves never moved relative to each other.

## Candidate A (recommended): rename the whole root while held, alias the old path, never copy

1. **Same volume is the precondition, not idleness.** If `~/.codex-profiles`
   and the destination's parent are on one device, move now, holders or not.
   If they are not (EXDEV), fall through to today's idle-only verified-copy
   path unchanged, because copying a live tree is exactly the drift the issue
   fears.
2. **One rename of the root**, `~/.codex-profiles` →
   `<DATA_DIR>/codex-profiles`, not four per-profile renames. All 2,091
   relative cross-profile links keep meaning because they move together. The
   destination must be absent or an empty directory ModelDeck created
   (rmdir it first); a populated destination refuses, as today.
3. **Alias immediately**: symlink `~/.codex-profiles` → the new root, via
   direct no-replace symlink creation, never following anything. The alias stays
   until a later issue removes it (candidate: #651 uninstall, or an
   "idle for 30 days" sweep). Every process that learned the old path keeps
   working through it, including the one absolute link back into the root,
   which is therefore allowed on this path.
4. **Then what today's mover already does**: repoint `~/.codex` if it pointed
   into the old root, rewrite the terminal pin file, write the marker, and
   publish the new `profileRef`s in one transaction. New ChatGPT helpers and
   new terminals resolve `~/.codex` to the new path.
5. **Rollback is rename back.** If anything after the root rename fails
   (alias race, marker, link, database), restore the active link, remove the
   marker, restore the published account references (the store transaction
   is last and is rolled back as one), remove the alias if we made it, and
   rename the root back. No bytes were copied, so there is nothing to verify
   and no backup to restore from. Alias removal is quarantine-then-verify:
   the alias is renamed to a private random name, checked to be our symlink,
   then unlinked; a foreign entry found at either step is left in place and
   the result is `blocked` (a human decides). Accepted residual (review
   round 4, orchestrator ruling): the check-then-unlink of the quarantined
   name is still two syscalls; a same-user process racing that random
   pathname already holds every credential the move protects and gains
   nothing, and Node offers no identity-bound unlink.
6. **Checks that stay**: ownership and mode checks on the root and each
   top-level profile directory (lstat only, no deep walk, no hashing: a
   live tree changes under a walk and a rename keeps every inode as it
   is, hard links included), the overlapping-roots refusals, the root
   identity guard right before the rename and moved-inode check immediately after, the daemon's own in-flight-work
   guard (a refresh or ingest holding an old `profileRef`), the
   incomplete-rollback "blocked" state.
7. **Checks that go, for this path only**: the `lsof`/`pgrep` gate, the
   SHA-256 tree snapshot and re-verification (impossible on a live tree and
   pointless for a rename), the verified backup copy, the socket refusal.
8. **Next daemon start** sees `~/.codex-profiles` as a symlink to the
   destination plus the marker and reports `done` without a warning. Today's
   code would throw "legacy root is not a real directory"; that branch must
   learn the alias shape.

**What this trades away, said plainly.** FINISH-647 recorded "in-use refusal,
verified backup, rollback" as the move's safety properties, and #676 restated
them. On the same-volume path this design drops the first two and keeps the
third in a simpler form. The reason: those two properties defended a COPY
(bytes in flight, source removed afterwards). A same-volume rename has no
bytes in flight and removes nothing. The security review should attack the
symlink handling around the alias (TOCTOU on the root right before the
rename, the alias never being followed, owner-only modes), not the copy
story.

**What Tim sees.** After the release that carries this, the daemon moves the
root at its first start with ChatGPT open. The deck line disappears
(`status: done` is quiet by the #677 rule). Nothing to click. Every Codex
account keeps working; ChatGPT does not notice.

**Side effect worth knowing.** `reconcileAccountTranscripts` only shares
transcripts for accounts whose profile lives under ModelDeck's root, so after
the move the four Codex accounts join transcript sharing. That was the
intended post-#647 state, not a new behaviour.

**Defect (a) from the issue, the "tried just now" feedback and the "ChatGPT
(3 helpers)" holder wording, becomes moot on the same-volume path**: the first
attempt succeeds, so there is no waiting line to age. The EXDEV path keeps
today's line and today's holder names. I recommend not building (a) in this
lane; if Tim wants it for EXDEV users anyway it is a separate, deck-only
item.

## Candidate B: never move while ChatGPT is installed ("managed in place")

Treat a root held by ChatGPT as permanent: drop the line and the button,
keep `~/.codex-profiles` as the Codex root on such Macs, and revisit when
#651 (uninstall) needs the data under ModelDeck's directory.

- Smallest change (delete code, hide a line).
- Leaves two Codex roots in the product forever: new accounts keep landing in
  `~/.codex-profiles` on those Macs because the deferred branch already pins
  `codexProfilesDir` to the legacy root. #651 then has to delete from two
  places, and "ModelDeck's data lives under ModelDeck's directory" (the #647
  goal) is never true on the machines that matter most.
- A variant, "own by reference" (symlink `<DATA_DIR>/codex-profiles` →
  `~/.codex-profiles` and stop), has no process-disruption window at all but
  moves nothing: a data-directory delete removes the link, not the data.

Rejected candidate: "ask the user to quit ChatGPT, then Move now". A manual
multi-step workflow on every Mac with ChatGPT, which is the machine this
issue was filed from.

## Tripwires the build lane must add (names are the contract)

- `codex-migration-held-root-renames-and-aliases`: a fake holder (open fd,
  bound socket, child cwd) keeps working after the move; a write through the
  old path appears in the new tree; `/api/state` reports `done`.
- `codex-migration-held-root-never-copies`: EXDEV plus a holder → today's
  deferred result, zero bytes written under the destination.
- `codex-migration-alias-race-rolls-back`: a real directory appears at the
  old path between rename and alias → root renamed back, store untouched,
  `blocked` false.
- `codex-migration-restart-after-alias-is-done`: startup with the legacy
  path already an alias to the destination → `done`, no warning, no move.
- `codex-migration-alias-is-owner-only-and-never-followed`: the alias is
  created directly without replacing any entry; a pre-existing symlink at the old path pointing
  elsewhere is refused, not followed.
- `codex-migration-absolute-links-into-legacy-survive-via-alias`.

## Routing (Tim, 2026-09-19, mid-session)

Build lane gpt-6-astra effort medium; adversarial review gpt-6-astra effort
high (the auth-adjacent full-review floor), both via `scripts/lane-codex.sh`,
to keep Claude usage minimal. The project goes on hold after this item ships.
