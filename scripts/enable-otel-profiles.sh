#!/bin/sh
# Before changing anything, every profile's settings.json is preflighted as JSON;
# any invalid profile aborts the entire run without writes. After preflight, write
# failures are reported per profile, processing continues best-effort, and the
# script exits non-zero if any profile failed. Enabling saves the prior presence
# and value of each managed key in a mode-600 settings.json.otel-backup sidecar.
# --revert restores that snapshot (or warns and deletes the keys if none exists),
# then removes the sidecar after a successful revert.
# The 0.4.6 release action requires exactly seven profile directories so one
# command cannot silently enable only a subset.
set -u

profiles_root="${MODELDECK_CLAUDE_PROFILES_DIR:-${HOME}/Library/Application Support/ModelDeck/claude-profiles}"
expected_profiles=7
mode=enable

case "${1:-}" in
  '') ;;
  --revert) mode=revert ;;
  --rollback) mode=rollback ;;
  --preflight) mode=preflight ;;
  --check) mode=check ;;
  *)
    echo 'usage: scripts/enable-otel-profiles.sh [--preflight|--check|--revert|--rollback]' >&2
    exit 2
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo 'enable-otel-profiles.sh: jq is required' >&2
  exit 1
fi
if [ ! -d "$profiles_root" ]; then
  echo 'enable-otel-profiles.sh: configured profiles directory does not exist' >&2
  exit 1
fi

desired='{
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_LOGS_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:3867/otlp"
}'

file_mode() {
  # GNU stat -c first: GNU's -f reports the file system and still succeeds.
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

atomic_write_json() {
  atomic_target=$1
  atomic_contents=$2
  atomic_permissions=$3
  atomic_temporary=$(mktemp "${atomic_target}.modeldeck.XXXXXX" 2>/dev/null) || return 1

  if ! printf '%s\n' "$atomic_contents" | jq '.' > "$atomic_temporary"; then
    rm -f "$atomic_temporary" 2>/dev/null
    return 1
  fi
  if ! chmod "$atomic_permissions" "$atomic_temporary" 2>/dev/null; then
    rm -f "$atomic_temporary" 2>/dev/null
    return 1
  fi
  if ! mv "$atomic_temporary" "$atomic_target" 2>/dev/null; then
    rm -f "$atomic_temporary" 2>/dev/null
    return 1
  fi
}

# Cross-profile preflight: do not create settings files or backups until every
# existing settings.json has parsed and has the shape this script can update.
found=0
profile_count=0
preflight_failed=0
for profile in "$profiles_root"/*; do
  [ -d "$profile" ] || continue
  found=1
  profile_count=$((profile_count + 1))
  profile_label="profile $profile_count"
  settings="$profile/settings.json"
  [ -f "$settings" ] || continue

  if ! jq empty "$settings" >/dev/null 2>&1; then
    echo "$profile_label: ERROR (settings.json is not valid JSON)" >&2
    preflight_failed=1
    continue
  fi
  if ! jq -e 'type == "object" and ((.env == null) or (.env | type == "object"))' "$settings" >/dev/null 2>&1; then
    echo "$profile_label: ERROR (settings.json and its env field must be objects)" >&2
    preflight_failed=1
  fi
done

if [ "$found" -eq 0 ]; then
  echo 'enable-otel-profiles.sh: no profile directories found' >&2
  exit 1
fi
# The exact-count guard protects the ENABLE direction only (enabling against a
# wrong HOME must refuse). Revert/rollback/check must work on however many
# profiles exist — adding an eighth profile later must never strand OTEL on
# (adversarial-review blocker on PR #417).
if { [ "$mode" = enable ] || [ "$mode" = preflight ]; } && [ "$profile_count" -ne "$expected_profiles" ]; then
  echo "enable-otel-profiles.sh: expected $expected_profiles profile directories, found $profile_count; no profiles were changed" >&2
  exit 1
fi
if [ "$preflight_failed" -ne 0 ]; then
  echo 'enable-otel-profiles.sh: preflight failed; no profiles were changed' >&2
  exit 1
fi
if [ "$mode" = preflight ]; then
  echo "enable-otel-profiles.sh: preflight OK ($profile_count profiles; no changes)"
  exit 0
fi
if [ "$mode" = check ]; then
  check_failed=0
  profile_index=0
  for profile in "$profiles_root"/*; do
    [ -d "$profile" ] || continue
    profile_index=$((profile_index + 1))
    profile_label="profile $profile_index"
    settings="$profile/settings.json"
    if [ ! -f "$settings" ] || ! jq -e --argjson desired "$desired" '
      . as $settings |
      ($settings.env | type == "object") and
      all($desired | keys[]; . as $key | $settings.env[$key] == $desired[$key])
    ' "$settings" >/dev/null 2>&1; then
      echo "$profile_label: ERROR (OTEL exporter settings are not enabled)" >&2
      check_failed=1
    fi
  done
  if [ "$check_failed" -ne 0 ]; then
    echo 'enable-otel-profiles.sh: OTEL verification failed; no profiles were changed' >&2
    exit 1
  fi
  echo "enable-otel-profiles.sh: OTEL verified ($profile_count profiles; no changes)"
  exit 0
fi

failed=0
profile_index=0
for profile in "$profiles_root"/*; do
  [ -d "$profile" ] || continue
  profile_index=$((profile_index + 1))
  profile_label="profile $profile_index"
  settings="$profile/settings.json"
  backup="$profile/settings.json.otel-backup"
  settings_existed=false
  permissions=600

  if [ -f "$settings" ]; then
    settings_existed=true
    if ! original=$(jq -c '.' "$settings" 2>/dev/null); then
      echo "$profile_label: ERROR (could not read settings.json after preflight)" >&2
      failed=1
      continue
    fi
    if ! permissions=$(file_mode "$settings"); then
      echo "$profile_label: ERROR (could not read settings.json permissions)" >&2
      failed=1
      continue
    fi
  else
    original='{}'
  fi

  if [ "$mode" = enable ]; then
    if [ -f "$backup" ]; then
      if ! backup_json=$(jq -c '.' "$backup" 2>/dev/null) ||
         ! printf '%s\n' "$backup_json" | jq -e --argjson desired "$desired" '
           . as $backup |
           ($backup | type == "object") and
           ($backup.settingsExisted | type == "boolean") and
           ($backup.envState == "absent" or $backup.envState == "null" or $backup.envState == "object") and
           ($backup.values | type == "object") and
           all($desired | keys[];
             . as $key |
             ($backup.values[$key] | type == "object") and
             ($backup.values[$key].present | type == "boolean") and
             (($backup.values[$key].present | not) or ($backup.values[$key] | has("value"))))
         ' >/dev/null 2>&1; then
        echo "$profile_label: ERROR (settings.json.otel-backup is not a valid OTEL backup)" >&2
        failed=1
        continue
      fi
      if ! chmod 600 "$backup" 2>/dev/null; then
        echo "$profile_label: ERROR (could not secure settings.json.otel-backup)" >&2
        failed=1
        continue
      fi
    else
      if ! snapshot=$(printf '%s\n' "$original" | jq -c \
        --argjson desired "$desired" \
        --argjson settings_existed "$settings_existed" '
          . as $original |
          {
            version: 1,
            settingsExisted: $settings_existed,
            envState: (if ($original | has("env") | not) then "absent"
              elif $original.env == null then "null"
              else "object"
              end),
            values: (reduce ($desired | keys[]) as $key ({};
              .[$key] = if (($original.env // {}) | has($key)) then
                {present: true, value: $original.env[$key]}
              else
                {present: false}
              end))
          }
        '); then
        echo "$profile_label: ERROR (could not build settings.json.otel-backup)" >&2
        failed=1
        continue
      fi
      if ! atomic_write_json "$backup" "$snapshot" 600; then
        echo "$profile_label: ERROR (could not write settings.json.otel-backup)" >&2
        failed=1
        continue
      fi
    fi

    if ! updated=$(printf '%s\n' "$original" | jq -c --argjson desired "$desired" '.env = ((.env // {}) + $desired)'); then
      echo "$profile_label: ERROR (could not update settings.json)" >&2
      failed=1
      continue
    fi
    summary=$(printf '%s\n' "$original" | jq -r --argjson desired "$desired" '
      (.env // {}) as $before |
      [ $desired | keys[] as $key | select($before | has($key) | not) | "+" + $key ] as $added |
      [ $desired | keys[] as $key | select(($before | has($key)) and $before[$key] != $desired[$key]) | "~" + $key ] as $changed |
      ($added + $changed) | if length == 0 then "unchanged" else join(", ") end
    ')
    printf '%s\n' "$original" | jq -r --argjson desired "$desired" '
      (.env // {}) as $before |
      $desired | keys[] as $key |
      select(($before | has($key)) and $before[$key] != $desired[$key]) |
      "WARNING: overwriting existing \($key); --revert will restore the value saved in settings.json.otel-backup"
    '

    if [ "$updated" = "$original" ]; then
      echo "$profile_label: unchanged"
      continue
    fi
    if ! atomic_write_json "$settings" "$updated" "$permissions"; then
      echo "$profile_label: ERROR (could not write settings.json)" >&2
      failed=1
      continue
    fi
    echo "$profile_label: $summary"
    continue
  fi

  # Automated rollback is snapshot-only. A profile the failed enable pass
  # never reached has no backup and must retain every pre-existing OTEL key.
  if [ "$mode" = rollback ] && [ ! -f "$backup" ]; then
    echo "$profile_label: unchanged (no rollout snapshot)"
    continue
  fi

  # Revert prefers the saved snapshot. Without one, retain the legacy behavior
  # of deleting managed keys, but make the loss of prior values explicit.
  if [ ! -f "$backup" ] && [ "$settings_existed" = false ]; then
    echo "$profile_label: WARNING (no settings.json.otel-backup; no prior values can be restored)" >&2
    echo "$profile_label: unchanged (settings.json absent)"
    continue
  fi

  if [ -f "$backup" ]; then
    if ! backup_json=$(jq -c '.' "$backup" 2>/dev/null) ||
       ! printf '%s\n' "$backup_json" | jq -e --argjson desired "$desired" '
         . as $backup |
         ($backup | type == "object") and
         ($backup.settingsExisted | type == "boolean") and
         ($backup.envState == "absent" or $backup.envState == "null" or $backup.envState == "object") and
         ($backup.values | type == "object") and
         all($desired | keys[];
           . as $key |
           ($backup.values[$key] | type == "object") and
           ($backup.values[$key].present | type == "boolean") and
           (($backup.values[$key].present | not) or ($backup.values[$key] | has("value"))))
       ' >/dev/null 2>&1; then
      echo "$profile_label: ERROR (settings.json.otel-backup is not a valid OTEL backup)" >&2
      failed=1
      continue
    fi

    if [ "$(printf '%s\n' "$backup_json" | jq -r '.settingsExisted')" = false ] && [ -f "$settings" ] &&
       printf '%s\n' "$original" | jq -e --argjson desired "$desired" '
         ((keys - ["env"]) | length == 0) and
         ((.env == null) or
           ((.env | type == "object") and (((.env | keys) - ($desired | keys)) | length == 0)))
       ' >/dev/null 2>&1; then
      if ! rm -f "$settings" 2>/dev/null; then
        echo "$profile_label: ERROR (could not remove settings.json)" >&2
        failed=1
        continue
      fi
      if ! rm -f "$backup" 2>/dev/null; then
        echo "$profile_label: ERROR (settings.json removed, but could not remove settings.json.otel-backup)" >&2
        failed=1
        continue
      fi
      echo "$profile_label: removed settings.json (restored pre-enable absence)"
      continue
    fi

    if ! updated=$(printf '%s\n' "$original" | jq -c --argjson desired "$desired" --argjson backup "$backup_json" '
      reduce ($desired | keys[]) as $key (.;
        if $backup.values[$key].present then
          .env[$key] = $backup.values[$key].value
        else
          del(.env[$key])
        end) |
      if $backup.envState == "absent" then del(.env)
      elif $backup.envState == "null" then .env = null
      else .
      end
    '); then
      echo "$profile_label: ERROR (could not restore settings.json from backup)" >&2
      failed=1
      continue
    fi
  else
    echo "$profile_label: WARNING (no settings.json.otel-backup; deleting managed keys without restoring prior values)" >&2
    if ! updated=$(printf '%s\n' "$original" | jq -c --argjson desired "$desired" '
      reduce ($desired | keys[]) as $key (.; del(.env[$key]))
    '); then
      echo "$profile_label: ERROR (could not update settings.json)" >&2
      failed=1
      continue
    fi
  fi

  if ! summary=$(jq -nr --argjson before "$original" --argjson after "$updated" --argjson desired "$desired" '
    ($before.env // {}) as $old |
    ($after.env // {}) as $new |
    [ $desired | keys[] as $key |
      if (($old | has($key)) and (($new | has($key)) | not)) then "-" + $key
      elif ((($old | has($key)) | not) and ($new | has($key))) then "+" + $key
      elif (($old | has($key)) and ($new | has($key)) and $old[$key] != $new[$key]) then "~" + $key
      else empty end
    ] | if length == 0 then "unchanged" else join(", ") end
  '); then
    echo "$profile_label: ERROR (could not summarize revert)" >&2
    failed=1
    continue
  fi

  if [ "$updated" != "$original" ]; then
    if ! atomic_write_json "$settings" "$updated" "$permissions"; then
      echo "$profile_label: ERROR (could not write settings.json)" >&2
      failed=1
      continue
    fi
  fi
  if [ -f "$backup" ] && ! rm -f "$backup" 2>/dev/null; then
    echo "$profile_label: ERROR (settings.json restored, but could not remove settings.json.otel-backup)" >&2
    failed=1
    continue
  fi
  echo "$profile_label: $summary"
done

exit "$failed"
