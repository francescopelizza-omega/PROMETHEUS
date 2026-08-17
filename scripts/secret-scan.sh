#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
# scripts/secret-scan.sh — scan the FULL git history for credentials.
#
#   ./scripts/secret-scan.sh            # scan every ref; exit 1 on any finding
#   ./scripts/secret-scan.sh --worktree # scan the working tree instead (fast, pre-commit)
#   ./scripts/secret-scan.sh --json out.json
#
# Scanning HEAD is not enough: removing a secret in a later commit does not remove it from
# history, and a public repo hands an attacker every blob you ever committed. `--log-opts=--all`
# covers every ref, including branches and tags you forgot about.
#
# Findings are allowlisted BY VALUE in .gitleaks.toml, never by path — see the reasoning there.
# A non-zero exit means: do not push, and do not make the project public.
set -euo pipefail

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
CONFIG=$HERE/.gitleaks.toml
REPORT=""
MODE=git

while [ $# -gt 0 ]; do
  case $1 in
  --worktree) MODE=dir ;;
  --json) REPORT=${2:?--json needs a path}; shift ;;
  -h | --help) sed -n '2,${/^[^#]/q; s/^# \{0,1\}//p;}' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<'EOF'
gitleaks is not installed.

  macOS   brew install gitleaks
  Linux   https://github.com/gitleaks/gitleaks/releases  (single static binary)
  Docker  docker run -v "$PWD:/p" zricethezav/gitleaks:latest git -s /p --log-opts=--all

Refusing to report "clean" without having actually scanned anything.
EOF
  exit 127
fi

set -- --redact -v -c "$CONFIG"
[ -n "$REPORT" ] && set -- "$@" --report-format json --report-path "$REPORT"

echo "==> gitleaks $(gitleaks version) · mode=$MODE · config=.gitleaks.toml"
if [ "$MODE" = git ]; then
  gitleaks git "$HERE" --log-opts="--all" "$@"
else
  gitleaks dir "$HERE" "$@"
fi

echo
echo "No findings. That is not the same as 'no secrets' — gitleaks matches known shapes."
echo "Before going public, also confirm the credential-rotation list is fully closed out."
