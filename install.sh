#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
# install.sh — one-command install for Prometheus (CLI + engine, optionally the desktop app).
#
#   curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | sh
#   wget -qO-  https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | sh
#
# WHAT IT DOES — nothing is hidden, and nothing needs root:
#   1. finds what it needs on this machine: Node.js >= 22.6 with npm, Python >= 3.9 (with ssl,
#      zlib, bz2, lzma), ripgrep, git, pnpm;
#   2. INSTALLS WHAT IS MISSING, privately, into $PROMETHEUS_HOME/toolchain — official release
#      tarballs whose SHA-256 is pinned in this file, refused on any mismatch. Nothing is installed
#      system-wide. Only where no such build exists (git anywhere; Node or Python on the BSDs) does
#      it offer your package manager, and only after you say yes (or pass --system-deps);
#   3. fetches the source to $PROMETHEUS_HOME/app — git clone, or a source archive without git;
#   4. builds the CLI bundle from source (pnpm, CLI packages only — not Electron);
#   5. exposes the engine at $PROMETHEUS_HOME/engine/ (the documented lookup lane);
#   6. links `prometheus`, `prometheus-app` and `nemesis` into $PREFIX (default ~/.local/bin);
#   7. adds $PREFIX to PATH in your shell rc — inside removable sentinel markers;
#   8. verifies the result the way a new terminal will see it.
#
# It never uses sudo unless you allow it for a package manager (and then shows you the exact
# command first), never writes outside
# $PROMETHEUS_HOME / $PREFIX / your shell rc (download caches aside), and `--uninstall` reverses
# every step including the PATH block.
#
# PLAIN POSIX sh, on purpose. Alpine and FreeBSD have no bash, so `curl … | bash` died there
# before a line of this ran, and dash — /bin/sh on Debian and Ubuntu — treats `set -o pipefail`
# as a FATAL error (dash 0.5.12, measured 2026-10-03). Everything is inside main(), called on the
# last line, so a download cut off half-way runs nothing at all.
#
# Piping a script from the internet into a shell means executing whatever that URL serves. If
# that is not a trade you want: read this file first, run `--dry-run` to see every command, and
# pass `--ref <tag>` to pin a reviewed revision.

set -eu
# pipefail where the shell has it (bash, zsh, busybox ash, FreeBSD sh). dash does not, and in dash
# even trying is fatal — hence the probe in a subshell.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

# Never let a child block on a credential prompt: piped into a shell there is no terminal to
# answer it, and git would hang or swallow the rest of this script as its stdin.
GIT_TERMINAL_PROMPT=0
COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export GIT_TERMINAL_PROMPT COREPACK_ENABLE_DOWNLOAD_PROMPT

REPO_DEFAULT="https://gitlab.com/red-beard-phoenix/PROMETHEUS.git"
REF_DEFAULT="main"
# engines.node is ">=22.6" with engineStrict (studio/pnpm-workspace.yaml): pnpm refuses older.
# The minor matters: 22.0 satisfies "major 22" and not ">=22.6".
MIN_NODE=22.6
# The desktop app: electron 44 declares node >= 22.12, and its install script extracts an
# incomplete app under Node 26 (studio/pnpm-workspace.yaml) — so the app build wants [22.12, 26).
MIN_NODE_APP=22.12
MAX_NODE_APP_MAJOR=25
MIN_PY=3.9 # the real floor: prometheus.py and nemesis parse and run on 3.9 (audited 2026-10-03)
MARK_BEGIN="# >>> prometheus installer >>>"
MARK_END="# <<< prometheus installer <<<"
# Written into every file this script generates, so --uninstall can tell ours from yours.
OWN_MARK="# prometheus-installer: generated file"

# ── pinned toolchain ──────────────────────────────────────────────────────────
# Each entry is a release asset and its SHA-256, copied from the publisher's own checksum list
# (2026-10-03). A download that does not match is deleted and the install stops: the pin lives
# here, in the file you can read, not on the server it is checked against.
#   Node:   https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt (signed: SHASUMS256.txt.asc —
#           verify it with the Node release keys when bumping). arm64-musl and glibc-2.17 exist
#           only as unofficial builds (unofficial-builds.nodejs.org), pinned by hash like the rest.
#   Python: python-build-standalone $PBS_RELEASE, SHA256SUMS asset of that release.
#   rg:     the .sha256 file published next to each ripgrep $RG_VERSION asset.
NODE_VERSION=22.23.3
PBS_RELEASE=20261001
PBS_PYTHON=3.12.15
RG_VERSION=15.2.0

node_asset() { # <platform key> → "<url> <sha256>", or nothing
  _n=https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION
  _u=https://unofficial-builds.nodejs.org/download/release/v$NODE_VERSION/node-v$NODE_VERSION
  case $1 in
  darwin-arm64) echo "$_n-darwin-arm64.tar.gz 23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53" ;;
  darwin-x64) echo "$_n-darwin-x64.tar.gz 8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8" ;;
  linux-x64) echo "$_n-linux-x64.tar.gz 1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af" ;;
  linux-x64-glibc217) echo "$_u-linux-x64-glibc-217.tar.gz d40d23977d2c39df68b09e71a9376e88bec6b805df02af35c08a332674a6c42e" ;;
  linux-arm64) echo "$_n-linux-arm64.tar.gz 5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2" ;;
  linux-armv7l) echo "$_n-linux-armv7l.tar.gz 8b99058ec6f4e372b9887f8ecb577a292adb132d59e5104356428a758fdb126c" ;;
  linux-ppc64le) echo "$_n-linux-ppc64le.tar.gz 236712ddef73f56c0e0590a2c49f69c8393a2c2d82c3d62c7c165605b472b38d" ;;
  linux-s390x) echo "$_n-linux-s390x.tar.gz 51f64794f5f61bdfc80aa186c8273021473997605cf90ed31ed148bee650a554" ;;
  linux-x64-musl) echo "$_n-linux-x64-musl.tar.gz 633f49a4f388c5f9564d56d9c0f5ffa394346d92ca0076fe21cf776ece1988bc" ;;
  linux-arm64-musl) echo "$_u-linux-arm64-musl.tar.gz 8cec03a498d883739d1dc9b924fda2f86944705b54ac707bf48a637483774c70" ;;
  esac
}

python_asset() {
  _p=https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/cpython-$PBS_PYTHON+$PBS_RELEASE
  case $1 in
  darwin-arm64) echo "$_p-aarch64-apple-darwin-install_only.tar.gz f1ee170bd7bb45bea526c4f9489b41f9c5d978c4cd7a08fd11809de56c39b736" ;;
  darwin-x64) echo "$_p-x86_64-apple-darwin-install_only.tar.gz f350524f5b80b9e1aeb25e39570e59f75edb6926582dc8f6edf2d0c744a7997c" ;;
  linux-x64 | linux-x64-glibc217) echo "$_p-x86_64-unknown-linux-gnu-install_only.tar.gz 0e56475e23f61a9c7d254fe16bc4931544026d591fc1cb8b770712ee94fa6260" ;;
  linux-arm64) echo "$_p-aarch64-unknown-linux-gnu-install_only.tar.gz 6a1b2e68c6fe749b78bbacb8fa42ff9bc844a72de7ed3ee52428f09a42f2ffc1" ;;
  linux-armv7l) echo "$_p-armv7-unknown-linux-gnueabihf-install_only.tar.gz 007bf2ec9db901de9226f392c2333bb535e2a9b117fc57c72a95f828f0c1c4d4" ;;
  linux-ppc64le) echo "$_p-ppc64le-unknown-linux-gnu-install_only.tar.gz 7af496643f34962c84ecde5e8937b299266d57327420d90734136820ba2de25d" ;;
  linux-s390x) echo "$_p-s390x-unknown-linux-gnu-install_only.tar.gz 2c9d55de1985883a543f1cf7cea011d22939f1138b1b7db7c11e217458c28dc5" ;;
  linux-x64-musl) echo "$_p-x86_64-unknown-linux-musl-install_only.tar.gz ef4af874495aedbeccfdaad04e2c788dd650f10bf2738e58cbbf4505f61b2e26" ;;
  linux-arm64-musl) echo "$_p-aarch64-unknown-linux-musl-install_only.tar.gz 92521ab99500e33763903ce2c95c9e22ee92bc3ac0f1b103519e5aba49fba5fd" ;;
  esac
}

rg_asset() { # the musl builds are static: they run on glibc hosts too
  _r=https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION/ripgrep-$RG_VERSION
  case $1 in
  darwin-arm64) echo "$_r-aarch64-apple-darwin.tar.gz 3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4" ;;
  darwin-x64) echo "$_r-x86_64-apple-darwin.tar.gz af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1" ;;
  linux-x64 | linux-x64-glibc217 | linux-x64-musl) echo "$_r-x86_64-unknown-linux-musl.tar.gz 33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c" ;;
  linux-arm64 | linux-arm64-musl) echo "$_r-aarch64-unknown-linux-musl.tar.gz 800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915" ;;
  linux-armv7l) echo "$_r-armv7-unknown-linux-musleabihf.tar.gz 0332b481aa007969a54d5c19e793208e73405c48d38f226bdee56b9ed085cdde" ;;
  linux-s390x) echo "$_r-s390x-unknown-linux-gnu.tar.gz b61a442344f0591321960def6adb8c828b68a448301d1ed93959656fcd3b79c2" ;;
  esac
}

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
SYSTEM_DEPS=ask # ask | yes | no
ORIG_PATH=$PATH

# ── output ────────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m') D=$(printf '\033[2m') R=$(printf '\033[31m') G=$(printf '\033[32m') Y=$(printf '\033[33m') Z=$(printf '\033[0m')
else
  B="" D="" R="" G="" Y="" Z=""
fi
say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
step() {
  STAGE=$*
  [ "$QUIET" -eq 1 ] || printf '%s==>%s %s\n' "$B" "$Z" "$*"
}
warn() { printf '%swarning:%s %s\n' "$Y" "$Z" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$R" "$Z" "$1" >&2
  DIED=1
  exit "${2:-1}"
}
STAGE=""
DIED=0
# A failure inside a tool (npm, pnpm, tar…) ends on that tool's last line. Say which step it was,
# that nothing outside $PROMETHEUS_HOME/$PREFIX was touched, and that a re-run picks up from there.
on_exit() {
  _rc=$?
  if [ "$_rc" -ne 0 ] && [ "$DIED" -eq 0 ] && [ -n "$STAGE" ]; then
    printf '%serror:%s the install stopped during: %s (exit %s)\n' "$R" "$Z" "$STAGE" "$_rc" >&2
    printf '       Everything it wrote is under %s and %s; re-running is safe.\n' "$HOME_DIR" "$PREFIX" >&2
  fi
}
trap on_exit EXIT

usage() {
  # A heredoc, never re-read from "$0": piped, "$0" is the shell, not this file.
  cat <<EOF
install.sh — one-command install for Prometheus (CLI + engine, optionally the desktop app).

  curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | sh
  wget -qO-  https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | sh

Missing dependencies (Node.js >= $MIN_NODE, Python >= $MIN_PY, ripgrep, pnpm) are installed
privately under \$PROMETHEUS_HOME/toolchain from checksum-pinned official releases. Your package
manager is used only where no such build exists, and only after you agree (or --system-deps).

Options:
  --prefix DIR         where to link the commands        (default: \$HOME/.local/bin)
  --home DIR           Prometheus home / install root    (default: \$HOME/.prometheus)
  --ref REF            git tag/branch/sha to install     (default: $REF_DEFAULT)
  --repo URL           source repository                 (default: $REPO_DEFAULT)
  --from-local DIR     install from an existing checkout instead of fetching
  --with-app           also build + install Prometheus Studio (Electron; slow)
  --system-deps        your consent in advance: run the package-manager commands shown (sudo/doas) without asking
  --no-system-deps     never use the system package manager
  --no-modify-path     do not touch any shell rc file
  --uninstall          remove everything this script installed
  --dry-run            print every command, change nothing
  -y, --yes            assume yes to the install plan (implied when stdin is not a terminal)
  -q, --quiet          only print warnings and errors
  -h, --help           this text

Environment: PROMETHEUS_HOME, PROMETHEUS_PREFIX, PROMETHEUS_REPO, PROMETHEUS_REF,
PROMETHEUS_ALLOW_ROOT=1 (run as root, e.g. in a container).
EOF
}

# `run` is the ONLY thing that mutates the system, so --dry-run is honest by construction.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s+ %s%s\n' "$D" "$*" "$Z"
    return 0
  fi
  "$@"
}

# Single-quote for sh (and fish): every ' becomes '\''.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# ── platform ──────────────────────────────────────────────────────────────────
ver_ge() { # <a.b[.c]> <x.y> — true when a.b >= x.y
  _a1=${1%%.*} _ar=${1#*.} _b1=${2%%.*} _b2=${2#*.}
  _a2=${_ar%%.*}
  case $_a1$_a2$_b1$_b2 in *[!0-9]*) return 1 ;; esac
  [ "$_a1" -gt "$_b1" ] || { [ "$_a1" -eq "$_b1" ] && [ "$_a2" -ge "$_b2" ]; }
}

detect_platform() {
  case $(uname -s) in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  FreeBSD) OS=freebsd ;;
  OpenBSD) OS=openbsd ;;
  NetBSD) OS=netbsd ;;
  DragonFly) OS=dragonfly ;;
  *) OS=other ;;
  esac
  case $(uname -m) in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  armv7* | armv8l) ARCH=armv7l ;;
  ppc64le) ARCH=ppc64le ;;
  s390x) ARCH=s390x ;;
  *) ARCH=$(uname -m) ;;
  esac
  # A shell translated by Rosetta reports x86_64 on Apple silicon; the native builds are right.
  if [ "$OS" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm64; fi
  # A 64-bit kernel under a 32-bit userland (Raspberry Pi OS 32-bit on a Pi 4/5) cannot run arm64.
  if [ "$OS" = linux ] && [ "$ARCH" = arm64 ] && [ "$(getconf LONG_BIT 2>/dev/null || true)" = 32 ]; then ARCH=armv7l; fi
  PLAT=$OS-$ARCH
  if [ "$OS" = linux ]; then
    if ls /lib/ld-musl-* >/dev/null 2>&1; then
      PLAT=$PLAT-musl
    else
      # Official Node builds need glibc >= 2.28; x64 has an unofficial build for 2.17+.
      _glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc \([0-9]*\.[0-9]*\).*/\1/p' || true)
      if [ -n "$_glibc" ] && ! ver_ge "$_glibc" 2.28 && [ "$ARCH" = x64 ]; then PLAT=linux-x64-glibc217; fi
    fi
  fi
}

# macOS without the Command Line Tools: /usr/bin/git and /usr/bin/python3 are xcrun stubs that
# pass `command -v`, fail when run, and pop an install dialog as a side effect. Never run them.
clt_stub() {
  [ "$OS" = darwin ] || return 1
  case $1 in /usr/bin/git | /usr/bin/python3 | /usr/bin/pip3) ! xcode-select -p >/dev/null 2>&1 ;; *) return 1 ;; esac
}

# A command on PATH that is really usable here: not a macOS stub, not a Windows binary that WSL
# exposes through /mnt/c.
find_cmd() {
  _p=$(command -v "$1" 2>/dev/null) || return 1
  case $_p in /*) ;; *) return 1 ;; esac
  if [ "$OS" = linux ]; then case $_p in /mnt/[a-z]/*) return 1 ;; esac; fi
  if clt_stub "$_p"; then return 1; fi
  printf '%s\n' "$_p"
}

# ── download, verify, unpack ──────────────────────────────────────────────────
fetch() { # <url> <dest>
  if _c=$(find_cmd curl); then
    "$_c" -fsSL --retry 3 --proto '=https' -o "$2" "$1" </dev/null
  elif _c=$(find_cmd wget); then
    "$_c" -q -O "$2" "$1" </dev/null
  else
    die "downloading $1 needs curl or wget, and neither is installed"
  fi
}

sha256_of() {
  if _c=$(find_cmd sha256sum); then "$_c" "$1" | cut -d' ' -f1
  elif _c=$(find_cmd shasum); then "$_c" -a 256 "$1" | cut -d' ' -f1
  elif _c=$(find_cmd sha256); then "$_c" -q "$1"
  elif _c=$(find_cmd openssl); then "$_c" dgst -sha256 "$1" | sed 's/^.*= *//'
  else return 1; fi
}

# provision <name> <version> "<url> <sha256>" — unpack into $TC/<name>-<version> and point the
# stable link $TC/<name> at it. The link is what gets persisted (wrappers, MCP registrations), so a
# pin bump changes one link instead of breaking every path that named a version directory.
provision() {
  _name=$1 _ver=$2 _url=${3% *} _sum=${3##* }
  _dir=$TC/$_name-$_ver
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  ${D}+ download $_url, check SHA-256 $_sum, unpack into $_dir${Z}"
    return 0
  fi
  if [ ! -d "$_dir" ]; then
    mkdir -p "$TC"
    _tmp=$(mktemp -d "$TC/.unpack.XXXXXX")
    step "downloading $_name $_ver"
    say "  $_url"
    fetch "$_url" "$_tmp/a.tar.gz" || { rm -rf "$_tmp"; die "could not download $_url"; }
    _got=$(sha256_of "$_tmp/a.tar.gz") ||
      { rm -rf "$_tmp"; die "no SHA-256 tool (sha256sum, shasum, sha256 or openssl) to verify $_url — refusing to use it unverified"; }
    if [ "$_got" != "$_sum" ]; then
      rm -rf "$_tmp"
      die "checksum mismatch for $_url
       expected $_sum
       got      $_got
       The download was deleted. Nothing was installed from it."
    fi
    mkdir "$_tmp/x"
    (cd "$_tmp/x" && gzip -dc ../a.tar.gz | tar -xf -) || { rm -rf "$_tmp"; die "could not unpack $_url"; }
    _top=$(ls -A "$_tmp/x")
    case $_top in
    *"
"* | "")
      rm -rf "$_tmp"
      die "unexpected layout in $_url" ;;
    esac
    mv "$_tmp/x/$_top" "$_dir"
    rm -rf "$_tmp"
  fi
  ln -sfn "$_name-$_ver" "$TC/$_name"
}

# ── consent, root, package managers ───────────────────────────────────────────
# Piped into sh, stdin is this script, so a question goes to the terminal itself (/dev/tty), the
# way sudo asks for its password. The question shows the exact command that will run. No terminal
# and no --system-deps means no. --system-deps is YOUR consent, typed at your own shell before the
# run — the installer is not Prometheus's runtime, where no flag can pre-approve a privileged
# command.
can_prompt() { [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; }
allow_system() { # <what it is for> <the command> → 0 if the user agrees
  case $SYSTEM_DEPS in
  yes) return 0 ;;
  no) return 1 ;;
  esac
  can_prompt || return 1
  printf '\n%s needs your package manager:\n    %s\nRun it now? [y/N] ' "$1" "$2" >/dev/tty
  read -r _ans </dev/tty || return 1
  case $_ans in [yY]*) return 0 ;; *) return 1 ;; esac
}

# The elevator for a system package manager: nothing when already root, else sudo, else doas.
# ONE decision, used both for the line the human is shown and for the command that runs — so
# what they approve is exactly what executes (Prometheus's rule for every privileged command).
root_prefix() {
  if [ "$(id -u)" = 0 ]; then echo ""
  elif _s=$(find_cmd sudo); then echo "$_s"
  elif _s=$(find_cmd doas); then echo "$_s"
  else return 1; fi
}

detect_pm() {
  for _pm in brew apt-get dnf yum zypper pacman apk pkg pkg_add pkgin xbps-install; do
    if find_cmd "$_pm" >/dev/null; then
      printf '%s\n' "$_pm"
      return 0
    fi
  done
  return 1
}

pkg_name() { # <manager> <git|python|node|rg|libstdcxx> → package name(s), or nothing
  case $2 in
  git) echo git ;;
  rg) echo ripgrep ;;
  python) case $1 in pacman | brew) echo python ;; *) echo python3 ;; esac ;;
  node)
    # Distro nodejs on Debian 12/13 and Ubuntu up to 25.10 is older than 22.6, so apt is no help.
    case $1 in
    brew) echo node@22 ;; dnf | yum) echo "nodejs npm" ;; zypper) echo "nodejs22 npm22" ;;
    pacman) echo "nodejs npm" ;; apk) echo "nodejs npm" ;; pkg) echo "node22 npm-node22" ;;
    pkgin | xbps-install | pkg_add) echo node ;;
    esac ;;
  libstdcxx) case $1 in apk) echo libstdc++ ;; esac ;;
  esac
}

pkg_cmd() { # <manager> <names> <elevator> → the EXACT command line pkg_install runs
  _r=${3:+$3 }
  case $1 in
  brew) echo "brew install $2" ;;
  apt-get) echo "${_r}env DEBIAN_FRONTEND=noninteractive apt-get update && ${_r}env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $2" ;;
  dnf | yum) echo "${_r}$1 install -y $2" ;;
  zypper) echo "${_r}zypper --non-interactive install $2" ;;
  pacman) echo "${_r}pacman -S --needed --noconfirm $2" ;;
  apk) echo "${_r}apk add --no-cache $2" ;;
  pkg) echo "${_r}pkg install -y $2" ;;
  pkg_add) echo "${_r}pkg_add $2" ;;
  pkgin) echo "${_r}pkgin -y install $2" ;;
  xbps-install) echo "${_r}xbps-install -Sy $2" ;;
  esac
}

# pkg_install <what> <generic> — through the system package manager, with consent. 0 = installed.
pkg_install() {
  _pm=$(detect_pm) || return 1
  _names=$(pkg_name "$_pm" "$2")
  [ -n "$_names" ] || return 1
  _el=""
  if [ "$_pm" != brew ]; then
    _el=$(root_prefix) || {
      warn "$_pm needs root and there is no sudo or doas here"
      return 1
    }
  fi
  allow_system "$1" "$(pkg_cmd "$_pm" "$_names" "$_el")" || return 1
  step "installing $_names with $_pm"
  # word splitting of $_names (a package list) and of an empty $_el (already root) is intended;
  # every line below is the one pkg_cmd showed
  case $_pm in
  brew) run brew install $_names </dev/null ;;
  apt-get) run $_el env DEBIAN_FRONTEND=noninteractive apt-get update </dev/null &&
    run $_el env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $_names </dev/null ;;
  dnf | yum) run $_el "$_pm" install -y $_names </dev/null ;;
  zypper) run $_el zypper --non-interactive install $_names </dev/null ;;
  pacman) run $_el pacman -S --needed --noconfirm $_names </dev/null ;;
  apk) run $_el apk add --no-cache $_names </dev/null ;;
  pkg) run $_el pkg install -y $_names </dev/null ;;
  pkg_add) run $_el pkg_add $_names </dev/null ;;
  pkgin) run $_el pkgin -y install $_names </dev/null ;;
  xbps-install) run $_el xbps-install -Sy $_names </dev/null ;;
  esac || {
    warn "$_pm could not install $_names"
    return 1
  }
  hash -r 2>/dev/null || true
}

# ── Python ────────────────────────────────────────────────────────────────────
# Capabilities, not a version string: nemesis imports zlib, bz2 and lzma at module top and every
# https fetch needs ssl — a pyenv/source build without those libraries still says 3.12.
PY_PROBE='import sys
if sys.version_info < (3, 9): raise SystemExit(3)
import zlib, bz2, lzma, ssl'
python_ok() { "$1" -I -c "$PY_PROBE" </dev/null >/dev/null 2>&1; }

ensure_python() {
  PY=""
  for _c in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python3.9; do
    _p=$(find_cmd "$_c") || continue
    if python_ok "$_p"; then
      PY=$_p
      return 0
    fi
  done
  if [ -x "$TC/python/bin/python3" ] && python_ok "$TC/python/bin/python3"; then
    PY=$TC/python/bin/python3
    return 0
  fi
  _asset=$(python_asset "$PLAT")
  if [ -n "$_asset" ]; then
    provision python "$PBS_PYTHON" "$_asset"
    PY=$TC/python/bin/python3
    [ "$DRY_RUN" -eq 1 ] || python_ok "$PY" || die "the downloaded Python ($PY) does not run on this machine"
    return 0
  fi
  if pkg_install "Python >= $MIN_PY" python; then
    for _c in python3 python3.12 python3.11; do
      _p=$(find_cmd "$_c") || continue
      if python_ok "$_p"; then
        PY=$_p
        return 0
      fi
    done
  fi
  die "no Python >= $MIN_PY with ssl, zlib, bz2 and lzma, and no private build exists for $PLAT.
       Install one with your package manager, or re-run with --system-deps."
}

# ── Node.js ───────────────────────────────────────────────────────────────────
node_version_of() {
  _v=$("$1" --version 2>/dev/null </dev/null) || return 1
  _v=${_v#v}
  case $_v in [0-9]*.[0-9]*) printf '%s\n' "$_v" ;; *) return 1 ;; esac
}
node_ok() { # <node> [app] — meets the floor (and, for the app, the electron window), and has npm
  _v=$(node_version_of "$1") || return 1
  if [ "${2:-}" = app ]; then
    ver_ge "$_v" "$MIN_NODE_APP" || return 1
    [ "${_v%%.*}" -le "$MAX_NODE_APP_MAJOR" ] || return 1
  else
    ver_ge "$_v" "$MIN_NODE" || return 1
  fi
  [ -x "${1%/*}/npm" ] || find_cmd npm >/dev/null
}

use_private_node() {
  NODE=$TC/node/bin/node
  case :$PATH: in *":$TC/node/bin:"*) ;; *) PATH=$TC/node/bin:$PATH ;; esac
  export PATH
  hash -r 2>/dev/null || true
}

ensure_node() { # [app]
  if _p=$(find_cmd node) && node_ok "$_p" "${1:-}"; then
    NODE=$_p
    return 0
  fi
  if [ -x "$TC/node/bin/node" ] && node_ok "$TC/node/bin/node" "${1:-}"; then
    use_private_node
    return 0
  fi
  _asset=$(node_asset "$PLAT")
  if [ -n "$_asset" ]; then
    # Node's musl builds link libstdc++, which Alpine does not install by default.
    case $PLAT in
    *-musl)
      if [ ! -e /usr/lib/libstdc++.so.6 ] && [ ! -e /lib/libstdc++.so.6 ]; then
        pkg_install "Node.js (musl build) needs libstdc++, which" libstdcxx ||
          die "Node.js on musl needs libstdc++: apk add libstdc++ (or re-run with --system-deps)"
      fi ;;
    esac
    provision node "v$NODE_VERSION" "$_asset"
    use_private_node
    [ "$DRY_RUN" -eq 1 ] || node_ok "$NODE" "${1:-}" ||
      die "the downloaded Node.js ($NODE) does not run on this machine (glibc/libstdc++ too old?)"
    return 0
  fi
  if pkg_install "Node.js >= $MIN_NODE" node && _p=$(find_cmd node) && node_ok "$_p" "${1:-}"; then
    NODE=$_p
    return 0
  fi
  die "Node.js >= $MIN_NODE with npm is required, and no private build exists for $PLAT.
       Install it yourself (https://nodejs.org), or re-run with --system-deps."
}

# ── ripgrep, git ──────────────────────────────────────────────────────────────
# rg is a hard prerequisite of the agent's glob/grep tools; without it they fail on every call.
ensure_rg() {
  find_cmd rg >/dev/null && return 0
  [ -x "$TC/rg/rg" ] && return 0
  _asset=$(rg_asset "$PLAT")
  if [ -n "$_asset" ]; then
    provision rg "$RG_VERSION" "$_asset"
    return 0
  fi
  pkg_install "ripgrep (the agent's file search)" rg && return 0
  warn "ripgrep is not installed and has no build for $PLAT: the agent's glob/grep tools will not work until it is"
}

git_ok() { _g=$(find_cmd git) && "$_g" --version >/dev/null 2>&1; }

# ── pnpm ──────────────────────────────────────────────────────────────────────
# The pin is read from the checkout (studio/package.json packageManager) so it never drifts. When
# no installed pnpm runs it, the pinned one is installed PRIVATELY with npm --global --prefix —
# never `corepack enable` or `npm install -g`, which write next to the node binary (/usr/bin,
# /usr/local/lib on a distro node: EACCES for a normal user, external report 2026-10-03) and,
# where they can write, replace the machine's global pnpm and yarn.
PNPM=""
pnpm_runs() { (cd "$SRC/studio" && "$1" --version) </dev/null 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true; }

ensure_pnpm() {
  [ -z "$PNPM" ] || return 0
  PNPM_PIN=$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' \
    "$SRC/studio/package.json" 2>/dev/null | head -n 1 || true)
  PNPM_DIR=$TC/pnpm
  if [ "$DRY_RUN" -eq 1 ]; then
    PNPM=pnpm
    say "  ${D}pnpm: the one on PATH if it runs ${PNPM_PIN:-the pinned version} here, else a private copy in $PNPM_DIR${Z}"
    return 0
  fi
  _want="pnpm${PNPM_PIN:+@$PNPM_PIN}"
  # pnpm >= 9.7 reads packageManager and switches itself to the pin (measured: 12.8.1 on PATH
  # answers 10.34.3 inside studio/), so the version that matters is the one it runs THERE.
  _p=$(find_cmd pnpm || true)
  _pv=""
  [ -z "$_p" ] || _pv=$(pnpm_runs "$_p")
  if [ -n "$_pv" ] && { [ -z "$PNPM_PIN" ] || [ "$_pv" = "$PNPM_PIN" ]; }; then
    PNPM=$_p
  elif [ -x "$PNPM_DIR/bin/pnpm" ] && [ -n "$(pnpm_runs "$PNPM_DIR/bin/pnpm")" ] &&
    { [ -z "$PNPM_PIN" ] || [ "$(pnpm_runs "$PNPM_DIR/bin/pnpm")" = "$PNPM_PIN" ]; }; then
    PNPM=$PNPM_DIR/bin/pnpm
  else
    _npm=${NODE%/*}/npm
    [ -x "$_npm" ] || _npm=$(find_cmd npm) || die "npm is required to install pnpm and was not found next to $NODE"
    step "installing $_want privately into $PNPM_DIR"
    "$_npm" install --global --prefix "$PNPM_DIR" --ignore-scripts --no-audit --no-fund "$_want" </dev/null ||
      die "could not install $_want into $PNPM_DIR — see npm's error above."
    PNPM=$PNPM_DIR/bin/pnpm
  fi
  _have=$(pnpm_runs "$PNPM")
  [ -n "$_have" ] || die "$PNPM does not run (no answer from \`pnpm --version\` in $SRC/studio)"
  [ -z "$PNPM_PIN" ] || [ "$_have" = "$PNPM_PIN" ] ||
    warn "the build will run pnpm $_have, but this workspace pins $PNPM_PIN — if the install fails on the lockfile, that is why"
  # `prepack` runs `pnpm run bundle` itself; that nested call finds pnpm through PATH. Only OUR
  # directory is put in front — prepending a system directory would reorder everything in it.
  case $PNPM in "$PNPM_DIR"/*)
    PATH=$PNPM_DIR/bin:$PATH
    export PATH
    hash -r 2>/dev/null || true ;;
  esac
}

# ── ownership: what --uninstall and the linker may touch ──────────────────────
# OURS = a symlink into a Prometheus checkout (a prometheus.py beside or above its target) or into
# $HOME_DIR, or a file carrying our marker or our copyright header. `prometheus` is also the name
# of the Prometheus monitoring server, so anything else in $PREFIX is somebody else's.
is_ours() {
  if [ -L "$1" ]; then
    _t=$(readlink "$1")
    case $_t in /*) ;; *) _t=${1%/*}/$_t ;; esac
    case $_t in "$HOME_DIR"/*) return 0 ;; esac
    _d=${_t%/*}
    [ -f "$_d/prometheus.py" ] || [ -f "$_d/../prometheus.py" ]
  elif [ -f "$1" ]; then
    grep -q -e "$OWN_MARK" -e 'Copyright 2026 Francesco Pelizza' "$1" 2>/dev/null
  else
    return 1
  fi
}

# ── uninstall ─────────────────────────────────────────────────────────────────
strip_path_block() {
  _rc=$1
  [ -f "$_rc" ] || return 0
  grep -qF "$MARK_BEGIN" "$_rc" || return 0
  step "removing the PATH block from $_rc"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s+ remove the lines between the installer markers in %s%s\n' "$D" "$_rc" "$Z"
    return 0
  fi
  _tmp=$(mktemp "${TMPDIR:-/tmp}/prometheus-rc.XXXXXX")
  # awk to a temp file + mv, not `sed -i` (GNU and BSD disagree): a half-written rc breaks every
  # new terminal.
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    index($0, b) { skip = 1 }
    !skip { print }
    index($0, e) { skip = 0 }
  ' "$_rc" >"$_tmp"
  cat "$_rc" >"$_rc.prometheus-backup"
  mv "$_tmp" "$_rc"
  say "  a backup of the previous file is at $_rc.prometheus-backup"
}

uninstall() {
  step "uninstalling Prometheus"
  for _cmd in prometheus prometheus-app nemesis; do
    if is_ours "$PREFIX/$_cmd"; then
      say "  removing $PREFIX/$_cmd"
      run rm -f "$PREFIX/$_cmd"
    elif [ -e "$PREFIX/$_cmd" ] || [ -L "$PREFIX/$_cmd" ]; then
      say "  ${D}leaving $PREFIX/$_cmd — not installed by Prometheus${Z}"
    fi
  done
  for _f in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.bashrc" "$HOME/.profile"; do
    strip_path_block "$_f"
  done
  _fish="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/prometheus.fish"
  if [ -f "$_fish" ]; then
    say "  removing $_fish"
    run rm -f "$_fish"
  fi
  if [ -d "$HOME/Applications/Prometheus Studio.app" ]; then
    say "  removing $HOME/Applications/Prometheus Studio.app"
    run rm -rf "$HOME/Applications/Prometheus Studio.app"
  fi
  # engine/ holds only links into the checkout; toolchain/ only what this script downloaded.
  # NOT "$HOME_DIR/bin": no version of this script ever created it, and with `--home ~/.local`
  # that line used to delete ~/.local/bin.
  run rm -rf "$HOME_DIR/engine" "$HOME_DIR/toolchain"
  say ""
  say "Removed the commands, the private toolchain and the PATH block."
  say "Your data was left alone on purpose — delete it yourself if you mean to:"
  say "  ${B}rm -rf $HOME_DIR${Z}   (config, models, downloads, logs, and the checkout)"
}

# ── source ────────────────────────────────────────────────────────────────────
archive_url() { # a source archive for $REPO @ $REF, when the forge has one
  _base=${REPO%.git}
  _tag=$(printf '%s' "$REF" | tr '/' '-')
  case $_base in
  https://gitlab.com/*) printf '%s/-/archive/%s/%s-%s.tar.gz\n' "$_base" "$REF" "${_base##*/}" "$_tag" ;;
  https://github.com/*) printf '%s/archive/%s.tar.gz\n' "$_base" "$REF" ;;
  *) return 1 ;;
  esac
}

fetch_archive() {
  _url=$(archive_url) || die "git is not installed, and $REPO has no known source-archive URL — install git, or use --from-local"
  step "downloading the source archive (git is not installed)"
  say "  $_url"
  [ "$DRY_RUN" -eq 0 ] || return 0
  _tmp=$(mktemp -d "$HOME_DIR/.src.XXXXXX")
  fetch "$_url" "$_tmp/src.tar.gz" || { rm -rf "$_tmp"; die "could not download $_url"; }
  mkdir "$_tmp/x"
  (cd "$_tmp/x" && gzip -dc ../src.tar.gz | tar -xf -) || { rm -rf "$_tmp"; die "could not unpack $_url"; }
  _top=$(ls -A "$_tmp/x")
  [ -f "$_tmp/x/$_top/prometheus.py" ] || { rm -rf "$_tmp"; die "$_url does not contain a Prometheus checkout"; }
  printf 'archive %s\n' "$_url" >"$_tmp/x/$_top/.prometheus-source"
  # Replaced whole: an archive tree has no history to update, and its build output is rebuilt.
  [ ! -e "$SRC" ] || mv "$SRC" "$_tmp/old"
  mv "$_tmp/x/$_top" "$SRC"
  rm -rf "$_tmp"
}

fetch_source() {
  if git_ok; then
    if [ -d "$SRC/.git" ]; then
      step "updating the existing checkout ($SRC)"
      # A re-run with another --repo must fetch from IT, not from the old origin.
      run git -C "$SRC" remote set-url origin "$REPO"
      run git -C "$SRC" fetch --depth 1 origin "$REF" </dev/null
      run git -C "$SRC" checkout --force FETCH_HEAD </dev/null
    else
      if [ -e "$SRC" ]; then
        [ -f "$SRC/.prometheus-source" ] || die "$SRC exists and is not a Prometheus checkout — move it aside first"
        say "  ${D}replacing the archive-installed tree with a git checkout${Z}"
        run rm -rf "$SRC"
      fi
      step "cloning $REPO @ $REF"
      # stderr is captured, not discarded: a sha ref always fails `--branch` (expected, quiet),
      # but a private repo, a wrong ref or a network block must be shown.
      _err=$(mktemp 2>/dev/null || printf '%s/prometheus-clone-%s' "${TMPDIR:-/tmp}" "$$")
      if ! run git clone --depth 1 --branch "$REF" "$REPO" "$SRC" 2>"$_err" </dev/null; then
        if ! { run git init "$SRC" >/dev/null &&
          run git -C "$SRC" remote add origin "$REPO" &&
          run git -C "$SRC" fetch --depth 1 origin "$REF" </dev/null &&
          run git -C "$SRC" checkout --force FETCH_HEAD </dev/null; }; then
          [ -s "$_err" ] && cat "$_err" >&2
          rm -f "$_err"
          die "could not fetch $REPO @ $REF — a 403/404 usually means the ref does not exist there, or the repository is private."
        fi
      fi
      rm -f "$_err"
    fi
    [ "$DRY_RUN" -eq 1 ] || say "  at $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?')"
  elif [ -d "$SRC/.git" ]; then
    warn "git is not installed, so the existing checkout in $SRC cannot be updated — installing it as it is"
  else
    if [ -e "$SRC" ] && [ ! -f "$SRC/.prometheus-source" ]; then
      die "$SRC exists and is not a Prometheus checkout — move it aside first"
    fi
    fetch_archive
  fi
}

# true when the bundle is missing or a bundled source tree has something newer (as bin/prometheus)
bundle_is_stale() {
  [ -f "$CLI_JS" ] || return 0
  for _d in apps/cli/src packages/core/src packages/engine-bridge/src packages/ui/src; do
    [ -d "$SRC/studio/$_d" ] || continue
    [ -n "$(find "$SRC/studio/$_d" -type f -newer "$CLI_JS" -print 2>/dev/null | head -n 1)" ] && return 0
  done
  return 1
}

# ── links ─────────────────────────────────────────────────────────────────────
link_cmd() { # <file in the checkout> <name>
  _src=$1 _name=$2
  if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$_src" ]; then die "$_src is missing from the checkout"; fi
  if { [ -e "$PREFIX/$_name" ] || [ -L "$PREFIX/$_name" ]; } && ! is_ours "$PREFIX/$_name"; then
    die "$PREFIX/$_name already exists and is not Prometheus's — move it aside, then re-run"
  fi
  run chmod +x "$_src" || die "could not make $_src executable"
  run rm -f "$PREFIX/$_name"
  run ln -s "$_src" "$PREFIX/$_name" || die "could not link $PREFIX/$_name"
  say "  $PREFIX/$_name -> $_src"
}

# nemesis is a `#!/usr/bin/env python3` script. On a machine whose only Python is the private one
# that shebang finds nothing, so the command is a two-line wrapper naming the interpreter.
write_nemesis_wrapper() {
  _w=$PREFIX/nemesis
  if { [ -e "$_w" ] || [ -L "$_w" ]; } && ! is_ours "$_w"; then
    warn "$_w already exists and is not Prometheus's — left alone; run nemesis as $PY $SRC/nemesis"
    return 1
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s+ write %s (runs %s with %s)%s\n' "$D" "$_w" "$SRC/nemesis" "$PY" "$Z"
    return 0
  fi
  rm -f "$_w"
  {
    printf '#!/bin/sh\n%s — re-run install.sh to regenerate; install.sh --uninstall removes it\n' "$OWN_MARK"
    printf 'exec %s %s "$@"\n' "$(shq "$PY")" "$(shq "$SRC/nemesis")"
  } >"$_w"
  chmod +x "$_w"
  say "  $_w -> $SRC/nemesis (python: $PY)"
}

# ── PATH block ────────────────────────────────────────────────────────────────
pick_rc() {
  case ${SHELL##*/} in
  zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash)
    if [ "$OS" = darwin ]; then
      # Terminal.app opens LOGIN shells, which read the first of these and never ~/.bashrc.
      for _f in .bash_profile .bash_login .profile; do
        if [ -f "$HOME/$_f" ]; then
          printf '%s\n' "$HOME/$_f"
          return 0
        fi
      done
      printf '%s\n' "$HOME/.bash_profile"
    else
      printf '%s\n' "$HOME/.bashrc"
    fi ;;
  fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/prometheus.fish" ;;
  csh | tcsh) printf '\n' ;; # csh never reads a POSIX export: left to the user, see PATH_NOTE
  *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

add_path() {
  case :$ORIG_PATH: in *":$PREFIX:"*)
    say "  ${G}ok${Z}  $PREFIX is already on PATH"
    return 0 ;;
  esac
  if [ "$MODIFY_PATH" -eq 0 ]; then
    PATH_NOTE="add it yourself:  export PATH=$(shq "$PREFIX"):\"\$PATH\""
    return 0
  fi
  _rc=$(pick_rc)
  if [ -z "$_rc" ]; then
    PATH_NOTE="csh/tcsh: add  set path = ( $(shq "$PREFIX") \$path )  to ~/.cshrc"
    return 0
  fi
  if [ -f "$_rc" ] && grep -qF "$MARK_BEGIN" "$_rc"; then
    say "  ${D}PATH block already present in $_rc${Z}"
    return 0
  fi
  step "adding $PREFIX to PATH in $_rc"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s+ append the PATH block to %s%s\n' "$D" "$_rc" "$Z"
  else
    case $_rc in
    */fish/conf.d/*.fish)
      mkdir -p "${_rc%/*}"
      printf '%s\n# Added by the Prometheus installer. Delete this file to remove it.\nfish_add_path %s\n%s\n' \
        "$MARK_BEGIN" "$(shq "$PREFIX")" "$MARK_END" >"$_rc" ;;
    *)
      # The leading newline keeps the block on its own line even if the file has no final one.
      printf '\n%s\nexport PATH=%s:"$PATH"\n%s\n' "$MARK_BEGIN" "$(shq "$PREFIX")" "$MARK_END" >>"$_rc" ;;
    esac
  fi
  PATH_NOTE="open a new terminal, or run:  . $_rc"
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  while [ $# -gt 0 ]; do
    case $1 in
    --prefix) PREFIX=${2:?--prefix needs a directory}; shift ;;
    --home) HOME_DIR=${2:?--home needs a directory}; shift ;;
    --ref) REF=${2:?--ref needs a git ref}; shift ;;
    --repo) REPO=${2:?--repo needs a URL}; shift ;;
    --from-local) FROM_LOCAL=${2:?--from-local needs a directory}; shift ;;
    --with-app) WITH_APP=1 ;;
    --system-deps) SYSTEM_DEPS=yes ;;
    --no-system-deps) SYSTEM_DEPS=no ;;
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
  # Piped into sh there is no terminal on stdin to answer the plan prompt.
  [ -t 0 ] || ASSUME_YES=1

  TC=$HOME_DIR/toolchain
  SRC=$HOME_DIR/app
  if [ -n "$FROM_LOCAL" ]; then SRC=$(cd -- "$FROM_LOCAL" && pwd -P) || die "--from-local: no such directory: $FROM_LOCAL"; fi
  CLI_JS=$SRC/studio/apps/cli/dist/bin.js
  PATH_NOTE=""

  detect_platform
  if [ "$UNINSTALL" -eq 1 ]; then
    uninstall
    exit 0
  fi

  step "checking prerequisites"
  case $OS in
  darwin | linux) ;;
  freebsd | openbsd | netbsd | dragonfly)
    warn "$OS is best-effort: Node.js, Python and ripgrep publish no $OS builds, so they come from your package manager" ;;
  *) die "unsupported platform: $(uname -s). macOS, Linux and the BSDs (Windows: use WSL)." ;;
  esac
  if [ "$(id -u)" = 0 ] && [ -z "${PROMETHEUS_ALLOW_ROOT:-}" ]; then
    die "refusing to run as root — this installs into your home directory and needs no privileges.
       Re-run as your normal user, or set PROMETHEUS_ALLOW_ROOT=1 (containers)."
  fi

  if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    say ""
    say "${B}Prometheus install plan${Z}"
    if [ -n "$FROM_LOCAL" ]; then say "  source     $SRC ${D}(local checkout)${Z}"; else say "  source     $REPO ${D}@ $REF${Z}"; fi
    say "  home       $HOME_DIR ${D}(missing tools go to $TC)${Z}"
    say "  commands   $PREFIX/prometheus, $PREFIX/prometheus-app, $PREFIX/nemesis"
    say "  desktop    $([ "$WITH_APP" -eq 1 ] && echo 'built from source (slow)' || echo 'skipped (--with-app to include it)')"
    printf 'Proceed? [Y/n] '
    read -r _reply || _reply=n
    case $_reply in [nN]*) die "cancelled" 0 ;; esac
  fi
  run mkdir -p "$HOME_DIR" "$PREFIX"

  ensure_python
  ensure_node
  ensure_rg
  _pyv=$("$PY" -c 'import platform; print(platform.python_version())' 2>/dev/null || echo "$PBS_PYTHON (to download)")
  _nv=$(node_version_of "$NODE" 2>/dev/null || echo "$NODE_VERSION (to download)")
  say "  ${G}ok${Z}  $PLAT · python $_pyv · node $_nv$(git_ok && echo " · git $(git --version | cut -d' ' -f3)")"

  if [ -z "$FROM_LOCAL" ]; then fetch_source; fi
  if [ "$DRY_RUN" -eq 0 ] || [ -n "$FROM_LOCAL" ]; then
    [ -f "$SRC/prometheus.py" ] || die "$SRC does not look like a Prometheus checkout (no prometheus.py)"
  fi

  step "building the CLI"
  if [ -n "$FROM_LOCAL" ] && [ "$DRY_RUN" -eq 0 ] && ! bundle_is_stale; then
    say "  ${D}the bundle in the checkout is current${Z}"
  else
    ensure_pnpm
    STAGE="building the CLI" # ensure_pnpm's own step must not be blamed for a build failure
    # Filtered: the CLI and its workspace packages only — not Electron. In the tree this script
    # owns, pnpm may purge an incompatible node_modules without asking (stdin is not a terminal);
    # in YOUR checkout (--from-local) it must not.
    _purge=""
    [ -n "$FROM_LOCAL" ] || _purge=--config.confirmModulesPurge=false
    run sh -c 'cd "$0/studio" && "$1" install --filter "@prometheus/cli..." --frozen-lockfile $2' "$SRC" "$PNPM" "$_purge" </dev/null
    run sh -c 'cd "$0/studio" && "$1" --filter @prometheus/cli run prepack' "$SRC" "$PNPM" </dev/null
  fi
  [ "$DRY_RUN" -eq 1 ] || [ -f "$CLI_JS" ] || die "the build finished but $CLI_JS is missing"

  step "wiring the engine into $HOME_DIR/engine"
  run mkdir -p "$HOME_DIR/engine"
  run ln -sfn "$SRC/prometheus.py" "$HOME_DIR/engine/prometheus.py"
  if [ -e "$SRC/nemesis" ] || [ "$DRY_RUN" -eq 1 ]; then
    run ln -sfn "$SRC/nemesis" "$HOME_DIR/engine/nemesis"
  else
    warn "no \`nemesis\` in the checkout — the security gate will fail CLOSED until one is present"
  fi
  # Where the launchers find the private toolchain and the interpreter chosen here. Read line by
  # line by bin/prometheus, never sourced. It replaces guessing "$ROOT/../toolchain", which named a
  # directory outside both the checkout and the Prometheus home.
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s+ write %s/.prometheus-toolchain%s\n' "$D" "$SRC" "$Z"
  else
    printf 'toolchain=%s\npython=%s\nnode=%s\n' "$TC" "$PY" "$NODE" >"$SRC/.prometheus-toolchain"
  fi

  step "linking commands into $PREFIX"
  link_cmd "$SRC/bin/prometheus" prometheus
  link_cmd "$SRC/bin/prometheus-app" prometheus-app
  NEMESIS_CMD="$PY $SRC/nemesis"
  if { [ -e "$SRC/nemesis" ] || [ "$DRY_RUN" -eq 1 ]; } && write_nemesis_wrapper; then NEMESIS_CMD=$PREFIX/nemesis; fi

  if [ "$WITH_APP" -eq 1 ]; then
    step "building Prometheus Studio (Electron — this takes several minutes)"
    ensure_node app
    ensure_pnpm
    run sh -c 'cd "$0/studio" && "$1" install --frozen-lockfile && "$1" run package' "$SRC" "$PNPM" </dev/null
    if [ "$OS" = darwin ] && [ "$DRY_RUN" -eq 0 ]; then
      case $ARCH in arm64) _dirs="mac-arm64 mac-universal mac" ;; *) _dirs="mac mac-x64 mac-universal" ;; esac
      for _d in $_dirs; do
        _app="$SRC/studio/apps/desktop/release/$_d/Prometheus Studio.app"
        if [ -d "$_app" ]; then
          step "installing the app into ~/Applications"
          run mkdir -p "$HOME/Applications"
          run rm -rf "$HOME/Applications/Prometheus Studio.app"
          run cp -R "$_app" "$HOME/Applications/"
          break
        fi
      done
    fi
  fi

  add_path

  if [ "$DRY_RUN" -eq 0 ]; then
    step "verifying"
    # With the PATH this shell STARTED with, not the one extended above: that is what a new
    # terminal has, so a launcher that cannot find the private toolchain fails here, not later.
    if ! _ver=$(PATH=$ORIG_PATH "$PREFIX/prometheus" --version 2>&1 </dev/null); then
      die "installed, but \`$PREFIX/prometheus --version\` failed:
$_ver"
    fi
    case $_ver in
    *"engine unknown"*) die "installed, but the CLI cannot run the engine (\`prometheus --version\` says: $_ver)" ;;
    esac
    say "  ${G}ok${Z}  $_ver"
    if [ "$NEMESIS_CMD" = "$PREFIX/nemesis" ]; then
      PATH=$ORIG_PATH "$PREFIX/nemesis" --version >/dev/null 2>&1 </dev/null ||
        die "installed, but \`$PREFIX/nemesis --version\` failed"
      say "  ${G}ok${Z}  nemesis runs"
    fi
  fi

  # git is not needed to install, but `prometheus install <plugin>` stages through git clone.
  if ! git_ok; then
    if [ "$OS" = darwin ] && ! find_cmd brew >/dev/null; then
      if allow_system "git (used to stage plugin installs)" "xcode-select --install"; then
        run xcode-select --install || true
        say "  finish the Command Line Tools installer that just opened, then git is ready"
      fi
    else
      pkg_install "git (used to stage plugin installs)" git || true
    fi
    git_ok || warn "git is not installed: \`prometheus install <plugin>\` needs it — install git when you can"
  fi
  if [ "$OS" = linux ] && [ ! -x /usr/bin/bwrap ] && [ ! -x /bin/bwrap ] && [ ! -x /usr/local/bin/bwrap ]; then
    say "  ${D}optional: bubblewrap (bwrap) confines the agent's commands on Linux — install it with your package manager${Z}"
  fi

  say ""
  if [ "$DRY_RUN" -eq 1 ]; then
    say "${B}Dry run complete — nothing was changed.${Z}"
    exit 0
  fi
  say "${G}${B}Prometheus is installed.${Z}"
  say ""
  say "  ${B}prometheus${Z}              open the interactive TUI"
  say "  ${B}prometheus scan${Z}         detect the AI agents on this machine"
  say "  ${B}prometheus doctor${Z}       check the environment end to end"
  say "  ${B}prometheus-app${Z}          launch Prometheus Studio (the desktop app)"
  [ "$WITH_APP" -eq 1 ] || say "  ${D}prometheus-app --build${Z}  build the desktop app (not installed yet)"
  say "  ${B}nemesis scan <target>${Z}   check a repo or directory for supply-chain threats"
  say ""
  # The signature DB starts EMPTY and nothing said so until the first scan warned "signature DB
  # empty" (external report, 2026-10-03). Not run for you: it fetches third-party feeds.
  case :$ORIG_PATH: in *":$PREFIX:"*) _nem=nemesis ;; *) _nem=$NEMESIS_CMD ;; esac
  say "  ${Y}first:${Z} seed the security feeds once — ${B}$_nem update${Z}"
  say "  ${D}until then nemesis scans without its hash / IOC / CVE layers. Without an abuse.ch key it${Z}"
  say "  ${D}fetches the open feeds and exits 1 for the two abuse.ch ones it skipped — expected. Add${Z}"
  say "  ${D}them later: $_nem auth --key <key> (free at https://auth.abuse.ch/), then $_nem update.${Z}"
  say ""
  [ -z "$PATH_NOTE" ] || say "  ${Y}PATH:${Z} $PATH_NOTE"
  # The flags that moved things go into the hint: `--uninstall` alone looks in the default places.
  _un="sh $SRC/install.sh --uninstall"
  [ "$HOME_DIR" = "$HOME/.prometheus" ] || _un="$_un --home $(shq "$HOME_DIR")"
  [ "$PREFIX" = "$HOME/.local/bin" ] || _un="$_un --prefix $(shq "$PREFIX")"
  say "  ${D}uninstall:${Z} $_un"
  exit 0
}

main "$@"
