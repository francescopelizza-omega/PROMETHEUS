#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
# scripts/verify-no-orphans.sh — prove that starting and stopping Prometheus leaves nothing behind.
#
#   ./scripts/verify-no-orphans.sh            # every scenario, 1 cycle each
#   ./scripts/verify-no-orphans.sh -n 5       # 5 cycles each (the "several start/stops" case)
#   ./scripts/verify-no-orphans.sh -s hangup  # one scenario by name
#
# WHY THIS EXISTS. Orphan bugs are invisible to unit tests: every seam looks correct in
# isolation and processes still survive. The only honest check is to run the real binary,
# stop it the way a human would, and then look at the real process table. This script does
# that for each distinct exit path, because they are genuinely different code paths:
# a graceful /quit, Ctrl-C, EOF, SIGTERM, SIGHUP, and the terminal dying under the process
# each reach shutdown differently — and the last one was leaking a 100%-CPU process.
#
# WHAT IT PROVES: for the paths listed, on this machine, with this build, nothing survives.
# WHAT IT CANNOT PROVE: that no orphan is possible. SIGKILL runs no userspace code, and
# scenarios not enumerated here are not covered. Absence of evidence, stated as such.
set -uo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"

CYCLES=1
ONLY=""
while [ $# -gt 0 ]; do
  case $1 in
  -n) CYCLES=${2:?-n needs a count}; shift ;;
  -s) ONLY=${2:?-s needs a scenario name}; shift ;;
  -h | --help) sed -n '2,${/^[^#]/q; s/^# \{0,1\}//p;}' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

CLI=$ROOT/bin/prometheus
[ -x "$CLI" ] || { echo "missing $CLI" >&2; exit 1; }
[ -f "$ROOT/studio/apps/cli/dist/bin.js" ] || {
  echo "CLI bundle not built — run: pnpm --filter @prometheus/cli run bundle" >&2
  exit 1
}

if [ -t 1 ]; then G=$(printf '\033[32m') R=$(printf '\033[31m') D=$(printf '\033[2m') Z=$(printf '\033[0m'); else G="" R="" D="" Z=""; fi

# Everything Prometheus can put on the process table: the CLI itself, the Python engine,
# the nemesis scanner, the desktop toolchain, and the agent CLIs the swarm spawns.
PATTERN='dist/bin\.js|prometheus\.py|/nemesis( |$)|electron-vite|turbo run dev|pnpm dev|Electron\.app/Contents/MacOS|python/sidecar'


snapshot() { ps -eo pid= -o command= | grep -E "$PATTERN" | grep -v grep | awk '{print $1}' | sort -u; }
describe() { ps -p "$1" -o pid=,ppid=,stat=,%cpu=,rss=,command= 2>/dev/null | cut -c1-120; }

fails=0
run_scenario() {
  name=$1
  before=$(snapshot)
  "scenario_$name"
  sleep 3
  after=$(snapshot)
  new=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tr -d ' ')
  if [ -n "$new" ]; then
    printf '  %sFAIL%s %-22s survivors:\n' "$R" "$Z" "$name"
    for p in $new; do printf '        %s\n' "$(describe "$p")"; done
    for p in $new; do kill -9 "$p" 2>/dev/null; done # never leave the machine worse off
    fails=$((fails + 1))
  else
    printf '  %s ok %s %-22s nothing left behind\n' "$G" "$Z" "$name"
  fi
}

# Each scenario starts the REAL binary and stops it the way a human (or the OS) would.
# `script -q /dev/null` allocates a pty — the TUI refuses to start without one, and a pty
# is also what makes the "terminal died" case reproducible.
pty_run() { ( printf '%b' "$1"; sleep "${3:-6}" ) | timeout "${2:-25}" script -q /dev/null "$CLI" >/dev/null 2>&1; }

scenario_quit()    { pty_run '/quit\r' 25 6; }
scenario_ctrl_c()  { pty_run '\003\003' 25 6; }   # two presses = the TUI's exit gesture
scenario_ctrl_d()  { pty_run '\004' 25 6; }       # EOF on an empty line
scenario_hangup()  { ( sleep 30 ) | timeout 10 script -q /dev/null "$CLI" >/dev/null 2>&1; } # terminal killed under it
scenario_sigterm() { "$CLI" >/dev/null 2>&1 & p=$!; sleep 4; kill -TERM "$p" 2>/dev/null; wait "$p" 2>/dev/null; }
scenario_sighup()  { "$CLI" >/dev/null 2>&1 & p=$!; sleep 4; kill -HUP  "$p" 2>/dev/null; wait "$p" 2>/dev/null; }
scenario_oneshot() { "$CLI" scan >/dev/null 2>&1; }
scenario_oneshot_interrupted() {
  "$CLI" superscan >/dev/null 2>&1 & p=$!; sleep 2; kill -TERM "$p" 2>/dev/null; wait "$p" 2>/dev/null
}
# The case no in-process handler can cover. Nothing of ours runs, so passing here is the
# orphan-guard's sentinel doing the work, not the reaper. Given ~2 s poll + 5 s escalation,
# allow time before judging.
scenario_sigkill() {
  "$CLI" superscan >/dev/null 2>&1 & p=$!; sleep 3; kill -9 "$p" 2>/dev/null; wait "$p" 2>/dev/null
  sleep 10
}

SCENARIOS="quit ctrl_c ctrl_d hangup sigterm sighup oneshot oneshot_interrupted sigkill"
[ -n "$ONLY" ] && SCENARIOS=$ONLY

echo "Prometheus orphan check — $CYCLES cycle(s) per scenario"
echo "${D}binary: $CLI${Z}"
start_total=$(snapshot | wc -l | tr -d ' ')
echo "${D}prometheus-related processes before: $start_total${Z}"
echo

c=1
while [ "$c" -le "$CYCLES" ]; do
  [ "$CYCLES" -gt 1 ] && echo "cycle $c/$CYCLES"
  for s in $SCENARIOS; do run_scenario "$s"; done
  c=$((c + 1))
done

echo
end_total=$(snapshot | wc -l | tr -d ' ')
echo "${D}prometheus-related processes after:  $end_total${Z}"
if [ "$fails" -eq 0 ] && [ "$end_total" -le "$start_total" ]; then
  echo "${G}PASS${Z} — no scenario left a process behind."
  echo "${D}Scope: the paths above, on this OS, with this build. A power cut mid-run still${Z}"
  echo "${D}leaves children until the NEXT launch sweeps them (by design — see orphan-guard.ts).${Z}"
  exit 0
fi
echo "${R}FAIL${Z} — $fails scenario(s) leaked; process count $start_total → $end_total."
exit 1
