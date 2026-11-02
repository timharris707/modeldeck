#!/bin/bash
# Sets up modeldeck-private's review-gate runners on the Linux box (tim-linux-agent), so the
# pr-review-settled gate waits for CodeRabbit on the box instead of on GitHub's paid runners.
# Copies insight-chat's box runner pattern: one Linux user per runner, an nftables guard that keeps
# job code off the LAN, tailnet and other users' local services, a memory-capped slice, and a
# between-jobs sweep of leftover processes. The gate only runs bash, gh and jq against GitHub's API,
# so the runners get no Docker, no extra tools and a small slice.
#
# Run on the box as root, with a fresh repo registration token on stdin:
#   scp scripts/box-gate-runners.sh linux:/tmp/
#   gh api -X POST repos/timharris707/modeldeck-private/actions/runners/registration-token --jq .token \
#     | ssh linux 'sudo bash /tmp/box-gate-runners.sh'
# Re-running is safe: existing users and registrations are kept; the guard, slice, sweep and
# drop-ins are rewritten and each runner restarts (wait until no job is running).
# Switch the gate back to GitHub's runners without undoing this: set the repo variable
# MODELDECK_GATE_RUNNER to '"ubuntu-latest"' (pr-review-settled.yml reads it).
# Undo: for n in 1..6: systemctl disable --now actions.runner.timharris707-modeldeck-private.tim-linux-agent-modeldeck-gate-$n;
#   (cd /home/modeldeck-ci-g$n/runner && sudo -u modeldeck-ci-g$n ./config.sh remove --token <removal token>);
#   userdel -r modeldeck-ci-g$n; then remove modeldeck-ci-guard.service, modeldeck-ci.slice,
#   /etc/modeldeck-ci and /usr/local/libexec/modeldeck-ci.
set -euo pipefail
RUNNERS=${RUNNERS:-6}
DIST=/opt/actions-runner-dist/actions-runner-linux-x64-2.338.1.tar.gz
REPO_URL=https://github.com/timharris707/modeldeck-private
read -r TOKEN

install -d -m 755 /etc/modeldeck-ci /usr/local/libexec/modeldeck-ci

cat > /etc/modeldeck-ci/guard.nft <<'EOF'
#!/usr/sbin/nft -f
# Network guard for modeldeck-private gate jobs (per-runner users modeldeck-ci-g<n>, uids 1401-1499);
# loaded by modeldeck-ci-guard.service. Connection mark bits on this box: 0x01000000 Chili CI,
# 0x02000000 chili-dev, 0x04000000 LoanMeld CI, 0x08000000 insight-chat CI, 0x10000000 modeldeck CI.
# Each guard needs its own bit, or its reply rule drops the other guards' traffic. Same rules as
# insight-chat's guard without its WebRTC exception: no LAN, tailnet, Docker bridges or other users'
# local services, and no UDP to this box's fixed ports below 32768 except DNS; DNS and the internet work.
table inet modeldeck_ci_guard
delete table inet modeldeck_ci_guard
table inet modeldeck_ci_guard {
  set ci_uids {
    type uid
    flags interval
    elements = { 1401-1499 }
  }
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid @ci_uids ct state new ct mark set ct mark or 0x10000000
    meta skuid @ci_uids fib daddr type local udp dport != 53 udp dport < 32768 reject with icmpx admin-prohibited
    meta skuid @ci_uids ip daddr { 10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } reject with icmpx admin-prohibited
    meta skuid @ci_uids ip6 daddr { fc00::/7, fe80::/10 } reject with icmpx admin-prohibited
    ct mark and 0x10000000 == 0x10000000 ct direction reply meta skuid != @ci_uids meta l4proto { tcp, udp } th sport != 53 drop
  }
}
EOF

cat > /etc/systemd/system/modeldeck-ci-guard.service <<'EOF'
[Unit]
Description=Network guard for modeldeck-private gate jobs (nftables table inet modeldeck_ci_guard)
Before=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/modeldeck-ci/guard.nft
ExecStop=/usr/sbin/nft delete table inet modeldeck_ci_guard

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/modeldeck-ci.slice <<'EOF'
[Unit]
Description=modeldeck-private gate runners (memory and task caps; Tim's own work wins CPU and disk)

[Slice]
MemoryMax=3G
TasksMax=2048
CPUWeight=20
IOWeight=20
EOF

# Same sweep as the other box runners, scoped to modeldeck-private's runner cgroups only.
cat > /usr/local/libexec/modeldeck-ci/sweep-runner-cgroup.sh <<'EOF'
#!/bin/bash
# modeldeck CI between-jobs sweep (job-started and job-completed hook). Kills every process in
# this runner's own systemd cgroup that is not this hook or one of its ancestors (the runner
# itself), so a job's detached children never outlive it. Other runners are never touched.
cg=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
procs="/sys/fs/cgroup${cg}/cgroup.procs"
case "$cg" in */actions.runner.timharris707-modeldeck-private.*.service) ;; *) echo "modeldeck-ci sweep: not in a runner cgroup ($cg), skipped"; exit 0 ;; esac
keep=" "
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  keep+="$pid "
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
killed=0
for round in 1 2 3; do
  mapfile -t listed < "$procs"
  victims=()
  for p in "${listed[@]}"; do
    case "$keep" in *" $p "*) ;; *) victims+=("$p") ;; esac
  done
  [ "${#victims[@]}" -eq 0 ] && break
  for p in "${victims[@]}"; do
    echo "modeldeck-ci sweep: killing leftover $p ($(cat /proc/"$p"/comm 2>/dev/null))"
    kill -KILL "$p" 2>/dev/null && killed=$((killed + 1))
  done
  sleep 0.5
done
echo "modeldeck-ci sweep: $killed leftover process(es) killed in ${cg##*/}"
exit 0
EOF
chmod 755 /usr/local/libexec/modeldeck-ci/sweep-runner-cgroup.sh

systemctl daemon-reload
systemctl enable --now modeldeck-ci-guard.service
# enable --now leaves an already-active guard on its old rules; the file replaces the table in one step.
nft -f /etc/modeldeck-ci/guard.nft

for n in $(seq 1 "$RUNNERS"); do
  user=modeldeck-ci-g$n
  name=tim-linux-agent-modeldeck-gate-$n
  unit=actions.runner.timharris707-modeldeck-private.$name.service
  if ! id "$user" >/dev/null 2>&1; then
    useradd --uid $((1400 + n)) --user-group --create-home --shell /bin/bash --comment "modeldeck gate runner $n" "$user"
    chmod 700 "/home/$user"
  fi
  uid=$(id -u "$user")
  if [ "$uid" -lt 1401 ] || [ "$uid" -gt 1499 ]; then echo "$user has uid $uid, outside the guarded 1401-1499" >&2; exit 1; fi
  if [ ! -f "/home/$user/runner/.runner" ]; then
    install -d -o "$user" -g "$user" "/home/$user/runner"
    sudo -u "$user" tar -xzf "$DIST" -C "/home/$user/runner"
    (cd "/home/$user/runner" && sudo -u "$user" ./config.sh --unattended --replace --url "$REPO_URL" --token "$TOKEN" \
      --name "$name" --labels modeldeck-gate --work _work)
  fi
  if [ ! -f "/etc/systemd/system/$unit" ]; then
    (cd "/home/$user/runner" && ./svc.sh install "$user")
  fi
  install -d "/etc/systemd/system/$unit.d"
  cat > "/etc/systemd/system/$unit.d/modeldeck-ci.conf" <<'EOF'
# modeldeck gate runner isolation (record: scripts/box-gate-runners.sh in modeldeck-private).
# No runner starts without the network guard.
[Unit]
Requires=modeldeck-ci-guard.service
After=modeldeck-ci-guard.service

[Service]
Slice=modeldeck-ci.slice
NoNewPrivileges=yes
PrivateTmp=yes
ProtectProc=invisible
InaccessiblePaths=/run/tailscale /run/user /run/dbus -/var/snap/hwctl/common/hwctl.varlink
IPAddressDeny=10.0.0.0/8 100.64.0.0/10 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fc00::/7 fe80::/10
KillMode=control-group
Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/modeldeck-ci/sweep-runner-cgroup.sh
Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/libexec/modeldeck-ci/sweep-runner-cgroup.sh
Restart=on-failure
RestartSec=10s
EOF
  systemctl daemon-reload
  systemctl restart "$unit"
done
systemctl --no-pager --plain list-units 'actions.runner.timharris707-modeldeck-private*'
