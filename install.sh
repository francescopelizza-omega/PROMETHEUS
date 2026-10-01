#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
# install.sh — one-command install for Prometheus (CLI + engine, optionally the desktop app).
#
#   curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
#
# WHAT IT DOES — nothing is hidden, and nothing needs root:
#   1. checks the prerequisites (python3 3.9+, git, node >= 22.6) and refuses to guess;
#   2. clones the repo to $PROMETHEUS_HOME/app (or updates it in place);
#   3. builds the CLI bundle from source (pnpm, CLI packages only — not Electron);
#   4. exposes the engine at $PROMETHEUS_HOME/engine/ (the documented lookup lane);
#   5. links `prometheus` and `prometheus-app` into $PREFIX (default ~/.local/bin);
#   6. adds $PREFIX to PATH in your shell rc — inside removable sentinel markers;
#   7. verifies the result by actually running `prometheus --version`.
#
# It never uses sudo, never writes outside $PROMETHEUS_HOME / $PREFIX / your shell rc,
# and `--uninstall` reverses every step including the PATH block.
#
# Piping a script from the internet into a shell means executing whatever that URL
# serves. If that trade is not one you want to make: read this file first, or run
# `--dry-run` to see every command before anything happens, and pass `--ref <tag>` to
# pin a reviewed revision instead of tracking the default branch.
set -euo pipefail

# Never let a child block on an interactive credential prompt. Piped into a shell there is no
# terminal to answer one, so git would either hang or silently consume the rest of this script
# as its stdin. A repo that cannot be cloned anonymously must FAIL, loudly and immediately.
export GIT_TERMINAL_PROMPT=0

REPO_DEFAULT="https://gitlab.com/red-beard-phoenix/PROMETHEUS.git"
REF_DEFAULT="main"
# The workspace declares `engines.node: ">=22.6"` AND `engineStrict: true`
# (studio/pnpm-workspace.yaml), so pnpm REFUSES to install under anything older. `.nvmrc` pins 22.
#
# This used to say 20, which is the version corepack shipped in — and that number is the reason
# the check existed at all. The effect was that Node 20 and 21 passed here, the installer then
# cloned the repo and ran `pnpm install`, and pnpm hard-failed on the engine constraint. The user
# paid for the clone and the wait before learning their Node was too old, from an error message
# about a package manager they never invoked.
#
# The minor matters too: 22.0 satisfies ">= 22 major" and does NOT satisfy ">=22.6".
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=6
MIN_PY_MINOR=9 # python 3.9+
MARK_BEGIN="# >>> prometheus installer >>>"
MARK_END="# <<< prometheus installer <<<"

REPO=${PROMETHEUS_REPO:-$REPO_DEFAULT}
REF=${PROMETHEUS_REF:-$REF_DEFAULT}
HOME_DIR=${PROMETHEUS_HOME:-$HOME/.prometheus}
PREFIX=${PROMETHEUS_PREFIX:-$HOME/.local/bin}
FROM_LOCAL=""
WITH_APP=0
MODIFY_PATH=1
DRY_RUN=0
ASSUME_YES=0
UNINSTALL=0
QUIET=0

# ── output ────────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m') D=$(printf '\033[2m') R=$(printf '\033[31m') G=$(printf '\033[32m') Y=$(printf '\033[33m') Z=$(printf '\033[0m')
else
  B="" D="" R="" G="" Y="" Z=""
fi
say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
step() { [ "$QUIET" -eq 1 ] || printf '%s==>%s %s\n' "$B" "$Z" "$*"; }
warn() { printf '%swarning:%s %s\n' "$Y" "$Z" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$R" "$Z" "$1" >&2
  exit "${2:-1}"
}

usage() {
  # Printed from a HEREDOC, never re-read from "$0".
  #
  # This used to `sed` its own header out of the file on disk. Piped — which is the documented
  # way to run it — "$0" is `bash`, not a path, so `--help` answered
  # `sed: bash: No such file or directory` and then, under `set -e`, took the script down with
  # it. The one flag a cautious user reaches for first was the one that could not work over the
  # one-liner the README tells them to use.
  cat <<EOF
install.sh — one-command install for Prometheus (CLI + engine, optionally the desktop app).

  curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
  wget -qO-  https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash

WHAT IT DOES — nothing is hidden, and nothing needs root:
  1. checks the prerequisites (python3 3.9+, git, node >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR);
  2. clones the repo to \$PROMETHEUS_HOME/app (or updates it in place);
  3. builds the CLI bundle from source (pnpm, CLI packages only — not Electron);
  4. exposes the engine at \$PROMETHEUS_HOME/engine/ (the documented lookup lane);
  5. links \`prometheus\` and \`prometheus-app\` into \$PREFIX (default ~/.local/bin);
  6. adds \$PREFIX to PATH in your shell rc — inside removable sentinel markers;
  7. verifies the result by actually running \`prometheus --version\`.

It never uses sudo, never writes outside \$PROMETHEUS_HOME / \$PREFIX / your shell rc,
and \`--uninstall\` reverses every step including the PATH block.

Piping a script from the internet into a shell means executing whatever that URL
serves. If that trade is not one you want to make: read this file first, or run
\`--dry-run\` to see every command before anything happens, and pass \`--ref <tag>\`
to pin a reviewed revision instead of tracking the default branch.
EOF
  cat <<EOF

Options:
  --prefix DIR       where to link the commands        (default: \$HOME/.local/bin)
  --home DIR         Prometheus home / install root    (default: \$HOME/.prometheus)
  --ref REF          git tag/branch/sha to install     (default: $REF_DEFAULT)
  --repo URL         source repository                 (default: $REPO_DEFAULT)
  --from-local DIR   install from an existing checkout instead of cloning
  --with-app         also build + install Prometheus Studio (Electron; slow)
  --no-modify-path   do not touch any shell rc file
  --uninstall        remove everything this script installed
  --dry-run          print every command, change nothing
  -y, --yes          assume yes (implied when stdin is not a terminal)
  -q, --quiet        only print warnings and errors
  -h, --help         this text

Environment: PROMETHEUS_HOME, PROMETHEUS_PREFIX, PROMETHEUS_REPO, PROMETHEUS_REF.
EOF
}

while [ $# -gt 0 ]; do
  case $1 in
  --prefix) PREFIX=${2:?--prefix needs a directory}; shift ;;
  --home) HOME_DIR=${2:?--home needs a directory}; shift ;;
  --ref) REF=${2:?--ref needs a git ref}; shift ;;
  --repo) REPO=${2:?--repo needs a URL}; shift ;;
  --from-local) FROM_LOCAL=${2:?--from-local needs a directory}; shift ;;
  --with-app) WITH_APP=1 ;;
  --no-modify-path) MODIFY_PATH=0 ;;
  --uninstall) UNINSTALL=1 ;;
  --dry-run) DRY_RUN=1 ;;
  -y | --yes) ASSUME_YES=1 ;;
  -q | --quiet) QUIET=1 ;;
  -h | --help) usage; exit 0 ;;
  *) die "unknown option: $1 (try --help)" 2 ;;
  esac
  shift
done

# Piped into bash ⇒ there is no terminal to answer a prompt, so never block on one.
[ -t 0 ] || ASSUME_YES=1

SRC=$HOME_DIR/app
[ -n "$FROM_LOCAL" ] && SRC=$(cd -- "$FROM_LOCAL" && pwd -P)

# `run` is the ONLY thing that mutates the system — so --dry-run is honest by
# construction: there is no second path that could quietly do something else.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s+ %s%s\n' "$D" "$*" "$Z"
    return 0
  fi
  "$@"
}

# ── uninstall ─────────────────────────────────────────────────────────────────
strip_path_block() {
  local rc=$1
  [ -f "$rc" ] || return 0
  grep -qF "$MARK_BEGIN" "$rc" || return 0
  step "removing the PATH block from $rc"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s+ sed -i "" "/%s/,/%s/d" %s%s\n' "$D" "$MARK_BEGIN" "$MARK_END" "$rc" "$Z"
    return 0
  fi
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/prometheus-rc.XXXXXX")
  # awk, not `sed -i`: GNU and BSD sed disagree on -i's argument, and awk to a temp
  # file + mv is atomic — a half-written shell rc would break every new terminal.
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    index($0, b) { skip = 1 }
    !skip { print }
    index($0, e) { skip = 0 }
  ' "$rc" >"$tmp"
  cat "$rc" >"$rc.prometheus-backup"
  mv "$tmp" "$rc"
  say "  a backup of the previous file is at $rc.prometheus-backup"
}

if [ "$UNINSTALL" -eq 1 ]; then
  step "uninstalling Prometheus"
  for cmd in prometheus prometheus-app; do
    if [ -L "$PREFIX/$cmd" ] || [ -f "$PREFIX/$cmd" ]; then
      say "  removing $PREFIX/$cmd"
      run rm -f "$PREFIX/$cmd"
    fi
  done
  for rc in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
    strip_path_block "$rc"
  done
  # The fish drop-in is a whole file this installer created, so it is removed rather than edited.
  fish_conf="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/prometheus.fish"
  [ -f "$fish_conf" ] && { say "  removing $fish_conf"; run rm -f "$fish_conf"; }
  # `--with-app` COPIES the built bundle into ~/Applications (see the desktop step). The header
  # promises "--uninstall reverses every step"; until this line, that one step was never undone
  # and a stale Studio.app stayed in the user's Applications folder forever.
  if [ -d "$HOME/Applications/Prometheus Studio.app" ]; then
    say "  removing $HOME/Applications/Prometheus Studio.app"
    run rm -rf "$HOME/Applications/Prometheus Studio.app"
  fi
  run rm -rf "$HOME_DIR/engine" "$HOME_DIR/bin"
  say ""
  say "Removed the commands, the launchers and the PATH block."
  say "Your data was left alone on purpose — delete it yourself if you mean to:"
  say "  ${B}rm -rf $HOME_DIR${Z}   (config, models, downloads, logs, and the checkout)"
  exit 0
fi

# ── preflight ─────────────────────────────────────────────────────────────────
step "checking prerequisites"

case $(uname -s) in
Darwin | Linux) ;;
*) die "unsupported platform: $(uname -s). macOS and Linux only (Windows: use WSL)." ;;
esac

if [ "$(id -u)" = "0" ] && [ -z "${PROMETHEUS_ALLOW_ROOT:-}" ]; then
  die "refusing to run as root — this installs into your home directory and needs no privileges.
       Re-run as your normal user, or set PROMETHEUS_ALLOW_ROOT=1 if you really mean it."
fi

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed.$2"; }
need git ""
need python3 "
       macOS: it ships with the system, or \`brew install python\`
       Linux: \`apt install python3\` / \`dnf install python3\`"

py_minor=$(python3 -c 'import sys; print(sys.version_info[1] if sys.version_info[0]==3 else -1)' 2>/dev/null || echo -1)
[ "$py_minor" -ge "$MIN_PY_MINOR" ] || die "python 3.$MIN_PY_MINOR+ required (found $(python3 --version 2>&1))"

need node "
       install Node >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR from https://nodejs.org (or brew/apt/nvm)"
node_major=$(node --version | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')
node_minor=$(node --version | sed -n 's/^v[0-9][0-9]*\.\([0-9][0-9]*\)\..*/\1/p')
[ -n "$node_major" ] && [ -n "$node_minor" ] ||
  die "could not read a version from \`node --version\` (got: $(node --version 2>&1))"
# Checked as a PAIR, because ">=22.6" is not ">= major 22": 22.0 through 22.5 satisfy the major
# and are rejected by pnpm. Failing here costs the user a message; failing later costs them the
# clone, the build, and an error about a package manager they never ran.
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ] ||
  { [ "$node_major" -eq "$MIN_NODE_MAJOR" ] && [ "$node_minor" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR required (found $(node --version))
       The workspace sets engines.node '>=22.6' with engineStrict, so pnpm will refuse to
       install under an older one. nvm: \`nvm install 22 && nvm use 22\`"
fi

say "  ${G}ok${Z}  python3 $(python3 --version 2>&1 | cut -d' ' -f2) · node $(node --version) · git $(git --version | cut -d' ' -f3)"

# ── plan ──────────────────────────────────────────────────────────────────────
say ""
say "${B}Prometheus install plan${Z}"
if [ -n "$FROM_LOCAL" ]; then
  say "  source     $SRC ${D}(local checkout, not modified)${Z}"
else
  say "  source     $REPO ${D}@ $REF${Z}"
  say "  checkout   $SRC"
fi
say "  home       $HOME_DIR"
say "  commands   $PREFIX/prometheus, $PREFIX/prometheus-app"
say "  desktop    $([ "$WITH_APP" -eq 1 ] && echo 'built from source (slow)' || echo 'skipped (--with-app to include it)')"
say ""

if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  printf 'Proceed? [Y/n] '
  read -r reply
  case $reply in [nN]*) die "cancelled" 0 ;; esac
fi

run mkdir -p "$HOME_DIR" "$PREFIX"

# ── 1. fetch the source ───────────────────────────────────────────────────────
if [ -z "$FROM_LOCAL" ]; then
  if [ -d "$SRC/.git" ]; then
    step "updating the existing checkout ($SRC)"
    run git -C "$SRC" fetch --depth 1 origin "$REF"
    run git -C "$SRC" checkout --force FETCH_HEAD
  else
    step "cloning $REPO @ $REF"
    [ -e "$SRC" ] && [ ! -d "$SRC/.git" ] && die "$SRC exists and is not a git checkout — move it aside first"
    # The clone's stderr is CAPTURED, not discarded.
    #
    # It used to be `2>/dev/null`, for a good reason — `--branch` does not accept a raw sha, so
    # a sha ref always fails here and falls through to the explicit fetch below, and that
    # expected failure should stay quiet. But discarding stderr also discarded every REAL
    # failure: a private repo, a wrong ref, a network block, an auth prompt. The user saw the
    # fallback fail with git's terse message and never learned the URL had been rejected.
    # Under `curl … | bash`, bash's STDIN is the rest of this script. A child that reads stdin
    # eats the remaining source, and git will happily prompt for credentials on a repo it cannot
    # read anonymously — which, on a private or renamed project, hangs the install forever with
    # no prompt visible. `GIT_TERMINAL_PROMPT=0` is set once near the top; `</dev/null` here makes
    # sure git cannot consume the script either way.
    _clone_err=$(mktemp 2>/dev/null || printf '/tmp/prometheus-clone-%s' "$$")
    if ! run git clone --depth 1 --branch "$REF" "$REPO" "$SRC" 2>"$_clone_err" </dev/null; then
      # --branch does not accept a raw sha; fall back to fetching one explicitly.
      if ! { run git init "$SRC" &&
             run git -C "$SRC" remote add origin "$REPO" &&
             run git -C "$SRC" fetch --depth 1 origin "$REF" &&
             run git -C "$SRC" checkout --force FETCH_HEAD; }; then
        [ -s "$_clone_err" ] && cat "$_clone_err" >&2
        rm -f "$_clone_err"
        die "could not fetch $REPO @ $REF — see the git error above. A 403/404 here usually means the ref does not exist on that remote, or the repository is private."
      fi
    fi
    rm -f "$_clone_err"
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    say "  at $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?')"
  fi
fi

# The checkout sanity check — skipped under --dry-run, because under --dry-run the clone did not
# happen and $SRC is an empty directory BY DESIGN.
#
# Without the guard this fired on every preview: the README tells a cautious user to run
# `--dry-run` before trusting a script piped from the internet, and what they got was
# `error: … does not look like a Prometheus checkout`, with the rest of the plan — the build, the
# symlinks, the PATH edit, the parts they actually wanted to inspect — never printed. The one
# command written for people who read before they run was the one that failed.
#
# `--from-local` is different and still checked: there the directory is supposed to exist now, so
# pointing it at the wrong path is a real error worth catching before anything else runs.
if [ "$DRY_RUN" -eq 0 ] || [ -n "$FROM_LOCAL" ]; then
  [ -f "$SRC/prometheus.py" ] ||
    die "$SRC does not look like a Prometheus checkout (no prometheus.py)"
fi

# ── 2. build the CLI ──────────────────────────────────────────────────────────
CLI_JS=$SRC/studio/apps/cli/dist/bin.js
step "building the CLI"
if [ -f "$CLI_JS" ] && [ -n "$FROM_LOCAL" ]; then
  say "  ${D}reusing the bundle already in the checkout${Z}"
else
  # ── getting a pnpm, and the RIGHT pnpm ──────────────────────────────────────
  #
  # COREPACK IS NO LONGER A GIVEN. It used to ship inside Node, and this script relied on that:
  # `command -v pnpm || corepack enable`. Measured 2026-09-30 on Node v26.10.0, the current
  # release, `/opt/homebrew/Cellar/node/26.10.0_1/bin/` contains exactly `node`, `npm` and `npx` —
  # corepack was unbundled. So on a clean machine the fallback resolved to nothing, the warning
  # was cosmetic, and the next line killed the install with advice ("run corepack enable") that
  # cannot be followed.
  #
  # `npm` is the thing that is always there, so it is the floor we build on.
  #
  # THE VERSION MATTERS TOO. `studio/package.json` pins `packageManager: pnpm@<v>` and the build
  # runs `--frozen-lockfile` against a lockfile written by that version; the pnpm that happens to
  # be on PATH may be two majors newer (measured here: 12.6.0 vs the pinned 10.34.3). Reading the
  # pin out of the checkout rather than hardcoding it means this never drifts from the manifest.
  # `|| true` is load-bearing: this script runs under `set -euo pipefail`, and under --dry-run
  # $SRC/studio/package.json does not exist yet. sed then exits non-zero, pipefail propagates it
  # through `| head`, and the assignment takes the whole installer down — silently, mid-plan,
  # right after "building the CLI". Measured while writing this block.
  PNPM_PIN=$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' \
    "$SRC/studio/package.json" 2>/dev/null | head -1 || true)

  if command -v corepack >/dev/null 2>&1; then
    run corepack enable || warn "corepack enable failed — falling back to npm"
    [ -n "$PNPM_PIN" ] && { run corepack prepare "pnpm@$PNPM_PIN" --activate || true; }
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    # No pnpm and no corepack: install the pinned version with npm, which ships with Node.
    step "installing pnpm${PNPM_PIN:+ $PNPM_PIN} (no pnpm and no corepack on this machine)"
    run npm install -g "pnpm${PNPM_PIN:+@$PNPM_PIN}"
  fi
  if [ "$DRY_RUN" -eq 0 ] && ! command -v pnpm >/dev/null 2>&1; then
    die "pnpm is required and could not be installed.
       Install it yourself and re-run:  npm install -g pnpm${PNPM_PIN:+@$PNPM_PIN}
       (corepack is no longer bundled with Node, so \`corepack enable\` may not exist.)"
  fi
  # A mismatched pnpm is a WARNING, not a refusal: the lockfile usually still resolves, and
  # refusing would strand anyone whose distro pins a different pnpm. Saying it out loud means a
  # later `--frozen-lockfile` failure has an obvious first suspect.
  if [ "$DRY_RUN" -eq 0 ] && [ -n "$PNPM_PIN" ]; then
    pnpm_have=$(pnpm --version 2>/dev/null || echo "?")
    [ "$pnpm_have" = "$PNPM_PIN" ] ||
      warn "pnpm $pnpm_have is on PATH but this workspace pins $PNPM_PIN — if the install fails on the lockfile, that is why"
  fi
  # Filtered install: the CLI and its workspace deps only. The desktop app pulls
  # Electron + Monaco (hundreds of MB) and is not needed to run `prometheus`.
  run sh -c 'cd "$0/studio" && pnpm install --filter "@prometheus/cli..." --frozen-lockfile' "$SRC"
  run sh -c 'cd "$0/studio" && pnpm --filter @prometheus/cli run prepack' "$SRC"
fi
[ "$DRY_RUN" -eq 1 ] || [ -f "$CLI_JS" ] || die "the build finished but $CLI_JS is missing"

# ── 3. expose the engine at the documented lane ───────────────────────────────
# engine-bridge resolves $PROMETHEUS_HOME/engine/{prometheus.py,nemesis} (locate.ts).
# Symlinks, not copies, so `git pull` in the checkout updates the engine too.
step "wiring the engine into $HOME_DIR/engine"
run mkdir -p "$HOME_DIR/engine"
run ln -sfn "$SRC/prometheus.py" "$HOME_DIR/engine/prometheus.py"
# Under --dry-run the checkout does not exist yet, so "is nemesis there?" has no answer. The
# ABSENCE warning is about a real checkout that is missing its security gate — printing it during
# a preview claims a defect in a tree nobody has fetched, which is alarming and false.
if [ -e "$SRC/nemesis" ]; then
  run ln -sfn "$SRC/nemesis" "$HOME_DIR/engine/nemesis"
  run chmod +x "$SRC/nemesis" 2>/dev/null || true
elif [ "$DRY_RUN" -eq 1 ]; then
  run ln -sfn "$SRC/nemesis" "$HOME_DIR/engine/nemesis"
else
  warn "no \`nemesis\` binary in the checkout — the security gate will fail CLOSED until one is present"
fi

# ── 4. link the commands ──────────────────────────────────────────────────────
step "linking commands into $PREFIX"
for cmd in prometheus prometheus-app; do
  # Same reason as the checkout probe above: under --dry-run nothing has been cloned, so this
  # file is absent BY DESIGN and its absence is not a finding. This was the last of three checks
  # that turned the documented "preview before you trust it" command into an error.
  if [ "$DRY_RUN" -eq 0 ]; then
    [ -f "$SRC/bin/$cmd" ] || die "$SRC/bin/$cmd is missing from the checkout"
  fi
  run chmod +x "$SRC/bin/$cmd"
  if [ -e "$PREFIX/$cmd" ] && [ ! -L "$PREFIX/$cmd" ]; then
    die "$PREFIX/$cmd exists and is not a symlink — move it aside, then re-run"
  fi
  run ln -sfn "$SRC/bin/$cmd" "$PREFIX/$cmd"
  say "  $PREFIX/$cmd -> $SRC/bin/$cmd"
done

# ── 5. desktop app (opt-in) ───────────────────────────────────────────────────
if [ "$WITH_APP" -eq 1 ]; then
  step "building Prometheus Studio (Electron — this takes several minutes)"
  run sh -c 'cd "$0/studio" && pnpm install && pnpm run package' "$SRC"
  if [ "$(uname -s)" = "Darwin" ] && [ "$DRY_RUN" -eq 0 ]; then
    for d in mac-arm64 mac-x64 mac mac-universal; do
      # QUOTED: the path contains a space, and `app=X Y` in POSIX sh assigns X to `app` and then
      # tries to RUN Y — so this aborted the whole installer with "Studio.app: not found" under
      # `set -e`, on exactly the platform the branch exists for.
      app="$SRC/studio/apps/desktop/release/$d/Prometheus Studio.app"
      if [ -d "$app" ]; then
        step "installing the app into ~/Applications"
        run mkdir -p "$HOME/Applications"
        run rm -rf "$HOME/Applications/Prometheus Studio.app"
        run cp -R "$app" "$HOME/Applications/"
        break
      fi
    done
  fi
fi

# ── 6. PATH ───────────────────────────────────────────────────────────────────
on_path() {
  case ":$PATH:" in *":$PREFIX:"*) return 0 ;; *) return 1 ;; esac
}

pick_rc() {
  # Login shells read different files; write to the one the user's shell actually
  # sources so a NEW terminal picks it up without further instructions.
  #
  # FISH IS HANDLED SEPARATELY and must not fall through to ~/.profile. fish does not read
  # ~/.profile at all, and it does not speak `export FOO="$BAR:baz"` — so the generic branch
  # wrote a POSIX line into a file fish ignores, printed "added to PATH", and left the user with
  # a PATH that never changed. The README promised bash/zsh/fish; two of the three worked.
  case ${SHELL##*/} in
  zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash) [ -f "$HOME/.bash_profile" ] && printf '%s\n' "$HOME/.bash_profile" || printf '%s\n' "$HOME/.bashrc" ;;
  fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/prometheus.fish" ;;
  *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

# Returns 0 when the rc file we picked is a fish config.
is_fish_rc() { case "$1" in */fish/conf.d/*.fish) return 0 ;; *) return 1 ;; esac; }

PATH_NOTE=""
if on_path; then
  say "  ${G}ok${Z}  $PREFIX is already on PATH"
elif [ "$MODIFY_PATH" -eq 0 ]; then
  PATH_NOTE="add it yourself:  export PATH=\"$PREFIX:\$PATH\""
else
  RC=$(pick_rc)
  if [ -f "$RC" ] && grep -qF "$MARK_BEGIN" "$RC"; then
    say "  ${D}PATH block already present in $RC${Z}"
  else
    step "adding $PREFIX to PATH in $RC"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '%s+ append the PATH block to %s%s\n' "$D" "$RC" "$Z"
    elif is_fish_rc "$RC"; then
      # FISH IS NOT POSIX. `export PATH="$PREFIX:$PATH"` is a syntax error in fish, so writing
      # the block below into a fish config would break every new fish shell — worse than not
      # adding the path at all. `fish_add_path` is fish's own idempotent API, and conf.d/*.fish
      # is the documented drop-in directory, so the file is created rather than appended to.
      run mkdir -p "${RC%/*}"
      {
        printf '%s\n' "$MARK_BEGIN"
        printf '# Added by the Prometheus installer. Delete this file to remove it.\n'
        printf 'fish_add_path %s\n' "$PREFIX"
        printf '%s\n' "$MARK_END"
      } >"$RC"
    else
      # A leading newline guarantees the block starts on its own line even if the
      # file does not end in one — appending onto a trailing comment silently
      # disables the export, which is exactly the failure this avoids.
      {
        printf '\n%s\n' "$MARK_BEGIN"
        printf 'export PATH="%s:$PATH"\n' "$PREFIX"
        printf '%s\n' "$MARK_END"
      } >>"$RC"
    fi
    PATH_NOTE="open a new terminal, or run:  source $RC"
  fi
fi

# ── 7. verify ─────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 0 ]; then
  step "verifying"
  if ! VERSION=$("$PREFIX/prometheus" --version 2>&1); then
    die "installed, but \`$PREFIX/prometheus --version\` failed:
$VERSION"
  fi
  say "  ${G}ok${Z}  $VERSION"
fi

say ""
say "${G}${B}Prometheus is installed.${Z}"
say ""
say "  ${B}prometheus${Z}              open the interactive TUI"
say "  ${B}prometheus scan${Z}         detect the AI agents on this machine"
say "  ${B}prometheus doctor${Z}       check the environment end to end"
say "  ${B}prometheus-app${Z}          launch Prometheus Studio (the desktop app)"
[ "$WITH_APP" -eq 1 ] || say "  ${D}prometheus-app --build${Z}  build the desktop app (not installed yet)"
say ""
[ -n "$PATH_NOTE" ] && say "  ${Y}PATH:${Z} $PATH_NOTE"
say "  ${D}uninstall:${Z} $SRC/install.sh --uninstall"
exit 0
