#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
# scripts/check-personal-data.sh — fail if the repo (or a BUILT artifact) leaks personal data.
#
#   ./scripts/check-personal-data.sh              # tracked files
#   ./scripts/check-personal-data.sh --artifacts  # also scan built bundles / app.asar
#
# Credentials are what secret scanners look for. This looks for the other half — the things
# that identify a PERSON rather than grant access, and that no scanner flags:
#
#   * absolute home paths  (/Users/<name>, /home/<name>, C:\Users\<name>)
#   * the machine's hostname
#   * personal email addresses in source (manifests are checked separately — see below)
#
# The home-path check is the load-bearing one. A hard-coded developer path is not just a
# broken fallback: bundlers inline it, so it ends up verbatim inside the published CLI
# bundle and inside the Electron app.asar, shipping the author's username and filesystem
# layout to everyone who downloads a release. That is exactly what happened here — six
# source files, both artifacts — and it is invisible to `git grep` on the artifacts unless
# you know to look, which is why this runs in CI.
#
# Package-manifest author fields are DELIBERATE and are not flagged; see --list-manifests.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"

ARTIFACTS=0
[ "${1:-}" = "--artifacts" ] && ARTIFACTS=1
if [ "${1:-}" = "--list-manifests" ]; then
  git grep -lIE "@[A-Za-z0-9.-]+\.(com|org|net|eu|io)" -- '*/package.json' '*.yml' '*.json' 2>/dev/null || true
  exit 0
fi

fail=0
report() { # <label> <matches>
  if [ -n "$2" ]; then
    printf '\n\033[31mFAIL\033[0m  %s\n' "$1"
    printf '%s\n' "$2" | sed 's/^/      /'
    fail=1
  else
    printf '\033[32m ok \033[0m  %s\n' "$1"
  fi
}

# ── 1. absolute home paths belonging to a REAL account ───────────────────────
# Test fixtures legitimately contain path-SHAPED strings (`/home/u/proj`, `/Users/x/.claude`,
# `/home/user-x` in a doc comment), and flagging those buries the one finding that matters
# under seventy that don't.
#
# So this does NOT try to guess whether a path segment "looks like a real person" — that
# heuristic is unreliable in both directions. It checks for IDENTITIES WE KNOW: this
# machine's login account, and the git-configured user name. Add more (an old username, a
# co-maintainer, a company login) via PROMETHEUS_PII_NAMES as a space-separated list.
IDENTITIES=$(
  {
    id -un 2>/dev/null || true
    git config user.name 2>/dev/null | tr -d ' ' || true
    git config user.email 2>/dev/null | cut -d@ -f1 || true
    printf '%s\n' ${PROMETHEUS_PII_NAMES:-}
  } | tr 'A-Z' 'a-z' | sort -u | grep -vE '^$|^(root|admin|user)$' || true
)

hits=""
for who in $IDENTITIES; do
  found=$(git grep -nIiE "(/Users/|/home/|\\\\Users\\\\)$who" -- . ':(exclude)studio/pnpm-lock.yaml' 2>/dev/null || true)
  [ -n "$found" ] && hits="$hits$found"$'\n'
done
report "no home path of a known identity ($(printf '%s' "$IDENTITIES" | tr '\n' ' ')) in tracked files" "$hits"

# ── 2. this machine's hostname ───────────────────────────────────────────────
host=$(hostname -s 2>/dev/null || true)
if [ -n "$host" ] && [ "$host" != "localhost" ]; then
  hits=$(git grep -nIF "$host" -- . 2>/dev/null || true)
  report "hostname '$host' does not appear in tracked files" "$hits"
fi

# ── 3. personal email outside package manifests ──────────────────────────────
# An author/maintainer field is a deliberate choice; the same address buried in a
# source comment or a test fixture is a leak nobody meant to publish.
hits=$(git grep -nIE '[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[a-z]+' \
  -- . ':(exclude)*/package.json' ':(exclude)*/package-lock.json' ':(exclude)studio/pnpm-lock.yaml' \
  ':(exclude)*electron-builder.yml' ':(exclude)*.claude-plugin/*' 2>/dev/null || true)
report "no personal email outside package manifests" "$hits"

# ── 4. built artifacts (the ones users actually download) ────────────────────
if [ "$ARTIFACTS" -eq 1 ]; then
  found=""
  for a in studio/apps/cli/dist/bin.js studio/apps/cli/release/prometheus*; do
    [ -f "$a" ] || continue
    m=$(grep -aoE '(/Users/[a-z0-9_.-]+|/home/[a-z0-9_.-]+)' "$a" 2>/dev/null |
      grep -vE '/home/runner|/Users/runner' | sort -u || true)
    [ -n "$m" ] && found="$found$a: $m"$'\n'
  done
  for asar in studio/apps/desktop/release/*/*.app/Contents/Resources/app.asar; do
    [ -f "$asar" ] || continue
    m=$(strings "$asar" 2>/dev/null | grep -oE '(/Users/[a-z0-9_.-]+|/home/[a-z0-9_.-]+)' |
      grep -vE '/home/runner|/Users/runner' | sort -u || true)
    [ -n "$m" ] && found="$found$asar: $m"$'\n'
  done
  report "no home paths inside built artifacts" "$found"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "Personal data found. Resolve before pushing — a public repo is not revocable."
  exit 1
fi
echo "No personal-data leaks detected in the scanned surfaces."
