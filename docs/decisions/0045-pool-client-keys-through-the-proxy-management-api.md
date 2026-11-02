# 0045 — Pool client keys for other machines go in through the proxy's own management API

- Date: 2026-10-30
- Links: issue #786, #783, decision 0036, docs/keys-with-riders-design.md §2.1, §2.6
- Status: recorded by the implementing session; Tim may overrule

Once one Mac hosts the only CLIProxyAPI pool (#783), every other machine's Claude
profiles need a client key that pool accepts. Decision 0036 has the app mint
per-profile keys and append them to `api-keys` with its consented surgical
write, one machine at a time. Keys for OTHER machines are minted by an operator
script on the pool host (`scripts/pool-client-keys.mjs`) and added differently:

- **The proxy writes its own config.** The script appends with
  `PATCH /v0/management/api-keys` on loopback and removes with
  `DELETE ?index=` after matching by SHA-256, so a key never travels in a URL.
  One writer, under the proxy's own lock, and the change is live at once (hot
  reload, measured on a scratch v8.0.38 proxy). The consented write's
  compare-to-rename window does not exist on this path.
- **Cost, accepted:** the proxy re-serialises `config.yaml` when it persists.
  Comments survived on scratch, but it also writes its default sections into the
  file. `api-keys` stays one entry per line, the form the app's consented
  writer edits.
- **Remote keys live in their own daemon table** (`pool_client_keys`), because
  the app's key report is a full replacement (0036 D1) and would delete them.
  Ingest looks up the app's map first, then pool keys; a pool key sets the
  request's `machine` to its label, and local or unknown keys keep `studio`.
- **The key is installed on the client over SSH stdin only** (`security -i`, the
  app's own create path; a 0600 file on Linux). It never appears in argv, env,
  logs, URLs or SQLite (NO-PRINT tripwire).
- **An empty `api-keys` list means accept-all** (recon V2), so the script
  refuses to remove the last key and refuses the first key without an explicit
  flag that names the lockout.

Granularity follows Tim's decision 4 on #783 (2026-10-29): per machine and
profile on the Macs, per machine on L.Box and the Mini.
