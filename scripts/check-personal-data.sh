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
HISTORY=0
# Which commits `--history` walks. Empty means "every ref in this repo" (--all), which is the
# right default for a standalone run. The pre-push hook passes the exact tips it is about to
# publish instead — see below for why that distinction is load-bearing.
HISTORY_REVS=""
for a in "$@"; do
  case "$a" in
    --artifacts) ARTIFACTS=1 ;;
    --history)   HISTORY=1 ;;
    --*)         ;;
    *)           HISTORY_REVS="$HISTORY_REVS $a" ;;
  esac
done
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

# ── 3b. THE SAME THREE CHECKS, OVER EVERY REACHABLE COMMIT ───────────────────
# Everything above uses `git grep` with no tree argument, which searches the
# WORKING TREE. That is the right default — it is what you can still fix — but on
# its own it is a scanner that cannot see the thing it exists to prevent.
#
# Deleting a leaking file does not unpublish it. On 2026-09-30 this repo's tree
# was clean by every check above while ten commits still carried
# `/Users/<name>/ALPHA/PROMETHEUS` across eight files, and thirty blobs carried a
# personal gmail address — including inside `studio/apps/cli/dist/bin.js`, a
# BUNDLED ARTIFACT. The header of this very script describes that leak in the past
# tense ("that is exactly what happened here — six source files, both artifacts"),
# because the fix landed in the tree and nobody looked behind it. `gitleaks` does
# read history, but it matches credential SHAPES; a home path is not one, so the
# two scanners together still had a blind spot exactly the size of this problem.
#
# Off by default because it costs a grep per commit, and a local commit is
# revocable. The pre-push hook turns it ON, because a push is not.
#
# SCAN WHAT IS BEING PUBLISHED, not every object that happens to be lying around.
#
# `--all` includes remote-tracking refs, and that is wrong at exactly the moment it matters
# most. Rewriting history to REMOVE a leak produces clean local commits — and then `git fetch`
# brings the old, dirty ones back under `refs/remotes/origin/main`, where `--all` finds them
# and refuses the very push that would delete them from the server. Measured 2026-09-30: the
# purge was blocked by the objects it was purging.
#
# So the hook passes the tips it is about to send and only those are walked. A standalone run
# with no revs still gets `--all`, which is the conservative answer when nobody said otherwise.
if [ "$HISTORY" -eq 1 ]; then
  # shellcheck disable=SC2086
  commits=$(git rev-list ${HISTORY_REVS:---all} 2>/dev/null || true)
  ncommits=$(printf '%s\n' "$commits" | grep -c . || true)
  if [ -z "$commits" ]; then
    report "history: nothing to scan (no commits)" ""
  else
    # One `git grep` over many trees, not one per commit: git walks them together
    # and it is the difference between seconds and minutes on a real history.
    # shellcheck disable=SC2086
    hits=$(
      {
        for who in $IDENTITIES; do
          git grep -nIiE "(/Users/|/home/|\\\\Users\\\\|-Users-)$who" $commits -- \
            ':(exclude)studio/pnpm-lock.yaml' 2>/dev/null || true
        done
        [ -n "$host" ] && [ "$host" != "localhost" ] && \
          git grep -nIF "$host" $commits -- 2>/dev/null || true
        git grep -nIE '[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[a-z]+' \
          $commits -- ':(exclude)studio/pnpm-lock.yaml' 2>/dev/null || true
      } | cut -d: -f1,2 | sort -u | head -40
    )
    # Manifest author fields are deliberate in the TREE, but a published history is
    # forever, so history reports them too — as `<commit>:<path>` pairs, which is
    # what `git filter-repo --replace-text` needs to remove them.
    report "history: no personal data in any of $ncommits reachable commit(s)" "$hits"
    [ -n "$hits" ] && printf '      %s\n' \
      "to purge: git filter-repo --replace-text <rules>  (back up with 'git bundle create' first)"
  fi
fi

# ── 4. built artifacts (the ones users actually download) ────────────────────
#
# MATCHED AGAINST KNOWN IDENTITIES, exactly like sections 1 and 3b — and it used to be the one
# section that was not.
#
# It grepped for the SHAPE `/Users/<anything>` or `/home/<anything>`, which is the heuristic the
# header of section 1 already rejects at length: "this does NOT try to guess whether a path
# segment 'looks like a real person' — that heuristic is unreliable in both directions."
# Measured 2026-09-30: on a clean tree with zero real leaks, `--artifacts` failed with exit 1 on
# `/home/tables`, `/home/work` and `/Users/operator` — three strings from inside bundled
# dependencies, belonging to nobody. A release gate that fails when nothing is wrong is a gate
# that gets skipped, and the next run is the one with the real finding in it.
#
# Why this section matters even though these files are gitignored: a DMG or a tarball built on a
# developer's machine carries whatever the bundler inlined, and it is shipped to users without
# ever passing through git. This is the only check that looks there — so it has to be believed.
if [ "$ARTIFACTS" -eq 1 ]; then
  # One alternation over the same identity list the rest of the script uses.
  who_re=$(printf '%s\n' $IDENTITIES | paste -sd'|' -)
  found=""
  scan_artifact() { # <label> <extractor-output>
    [ -n "$who_re" ] || return 0
    m=$(printf '%s\n' "$2" | grep -aoiE "(/Users/|/home/|\\\\Users\\\\)($who_re)" | sort -u || true)
    [ -n "$m" ] && found="$found$1: $m"$'\n'
    return 0
  }
  for a in studio/apps/cli/dist/bin.js studio/apps/cli/release/prometheus*; do
    [ -f "$a" ] || continue
    scan_artifact "$a" "$(grep -aoE '(/Users/[a-zA-Z0-9_.-]+|/home/[a-zA-Z0-9_.-]+)' "$a" 2>/dev/null || true)"
  done
  for asar in studio/apps/desktop/release/*/*.app/Contents/Resources/app.asar; do
    [ -f "$asar" ] || continue
    scan_artifact "$asar" "$(strings "$asar" 2>/dev/null | grep -oE '(/Users/[a-zA-Z0-9_.-]+|/home/[a-zA-Z0-9_.-]+)' || true)"
  done
  report "no home path of a known identity inside built artifacts" "$found"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "Personal data found. Resolve before pushing — a public repo is not revocable."
  exit 1
fi
echo "No personal-data leaks detected in the scanned surfaces."
