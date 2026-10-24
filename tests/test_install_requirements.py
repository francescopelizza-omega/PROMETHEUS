# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""install.sh's requirements scan, on blank machines it can only pretend to be.

The scan runs first, prints one table, and names ONE package-manager command for this OS. These
tests run the real script (`install.sh --check`, which changes nothing) under dash and sh, with
a PATH that holds only a few basic utilities plus stubs: `uname`, `id`, `sw_vers` and friends say
which machine this is, and a stub's mere presence says which tools are installed. The distro comes
from PROMETHEUS_OS_RELEASE, a copy of /etc/os-release written per scenario. Nothing installs:
--check never asks, never runs a package manager, and never writes under HOME.

The second half lifts the consent functions out of install.sh, the way test_install_consent.py
does, and checks that the su route (a Debian with a root password and no sudo) shows exactly the
line it runs.

Run: python3 -m pytest tests/test_install_requirements.py
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
INSTALL = ROOT / "install.sh"
SHELLS = [s for s in ("/bin/dash", "/bin/sh") if Path(s).exists()]
# The only real programs on PATH. Everything else a scenario has is a stub.
BASIC = ("sed", "tr", "head", "cut", "cat", "ls", "grep", "awk", "env", "dirname", "basename")

OS_RELEASE = {
    "ubuntu": 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
    "debian": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
    "fedora": 'NAME="Fedora Linux"\nVERSION_ID=41\nID=fedora\nPRETTY_NAME="Fedora Linux 41 (Workstation Edition)"\n',
    "nobara": 'NAME="Nobara Linux"\nVERSION_ID="41"\nID=nobara\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Nobara Linux 41 (KDE Plasma)"\n',
    "rhel": 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="9.4"\nID="rhel"\nID_LIKE="fedora"\nPRETTY_NAME="Red Hat Enterprise Linux 9.4 (Plow)"\n',
    "rocky": 'NAME="Rocky Linux"\nVERSION_ID="9.4"\nID="rocky"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"\n',
    "centos7": 'NAME="CentOS Linux"\nVERSION_ID="7"\nID="centos"\nID_LIKE="rhel fedora"\nPRETTY_NAME="CentOS Linux 7 (Core)"\n',
    # no trailing newline on the last line: read must still see it
    "mint": "NAME=\"Linux Mint\"\nID=linuxmint\nID_LIKE=\"ubuntu debian\"\nPRETTY_NAME='Linux Mint 22'",
}


def stub(path: Path, body: str) -> None:
    path.write_text("#!/bin/sh\n" + body + "\n")
    path.chmod(0o755)


def machine(tmp: Path, *, linux: bool, have: tuple[str, ...], uid: int = 1000,
            clt: bool = False) -> dict[str, str]:
    """A PATH and an environment for one pretend machine."""
    bin_ = tmp / "bin"
    bin_.mkdir()
    for tool in BASIC:
        real = shutil.which(tool, path="/usr/bin:/bin")
        if real:
            (bin_ / tool).symlink_to(real)
    if linux:
        stub(bin_ / "uname", 'case $1 in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac')
        stub(bin_ / "getconf", 'case $1 in GNU_LIBC_VERSION) echo "glibc 2.39" ;; *) echo 64 ;; esac')
    else:
        stub(bin_ / "uname", 'case $1 in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac')
        stub(bin_ / "sysctl", "echo 1")
        stub(bin_ / "sw_vers", "echo 15.6")
        stub(bin_ / "xcode-select", "exit 0" if clt else "exit 2")
    stub(bin_ / "id", f"echo {uid}")
    versions = {
        "git": "echo 'git version 2.43.0'",
        "tmux": "echo 'tmux 3.4'",
        "node": "echo v22.12.0",
        "rg": "echo 'ripgrep 14.1.0'",
        "python3": 'case "$*" in *platform*) echo 3.12.3 ;; esac; exit 0',
        "bwrap": "exit 0",
    }
    for tool in have:
        stub(bin_ / tool, versions.get(tool, "exit 0"))
    home = tmp / "home"
    home.mkdir()
    # PROMETHEUS_BREW_PREFIXES="": the real Homebrew of the machine running the tests stays invisible
    return {"PATH": str(bin_), "HOME": str(home), "NO_COLOR": "1", "SHELL": "/bin/sh",
            "PROMETHEUS_BREW_PREFIXES": ""}


def check(env: dict[str, str], shell: str, distro: str | None, tmp: Path) -> str:
    if distro is not None:
        osr = tmp / "os-release"
        osr.write_text(OS_RELEASE[distro])
        env = {**env, "PROMETHEUS_OS_RELEASE": str(osr)}
    r = subprocess.run([shell, str(INSTALL), "--check"], env=env, capture_output=True,
                       text=True, timeout=60, stdin=subprocess.DEVNULL)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout


def command_line(out: str) -> str:
    """The line under "To add … on <distro>:" — the command the scan offers."""
    lines = out.splitlines()
    for i, line in enumerate(lines):
        if line.strip().startswith("To add "):
            return lines[i + 1].strip()
    raise AssertionError("no command offered:\n" + out)


@pytest.mark.parametrize("shell", SHELLS)
def test_blank_ubuntu_offers_one_apt_command_through_sudo(tmp_path, shell):
    env = machine(tmp_path, linux=True, have=("apt-get", "sudo", "curl"))
    out = check(env, shell, "ubuntu", tmp_path)
    assert "Requirements — Ubuntu 24.04.1 LTS · x64 · apt-get" in out
    sudo = f"{env['PATH']}/sudo"
    assert command_line(out) == (
        f"{sudo} env DEBIAN_FRONTEND=noninteractive apt-get update && "
        f"{sudo} env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "
        "git ca-certificates tmux bubblewrap")
    # Node, Python and ripgrep are fetched privately: they are never part of the root command.
    assert re.search(r"private\s+python", out) and re.search(r"private\s+node", out)
    assert re.search(r"private\s+ripgrep", out)
    assert re.search(r"optional\s+tmux .*compatibility mode", out)


@pytest.mark.parametrize("shell", SHELLS)
def test_debian_with_a_root_password_and_no_sudo_goes_through_su(tmp_path, shell):
    env = machine(tmp_path, linux=True, have=("apt-get", "su", "curl"))
    out = check(env, shell, "debian", tmp_path)
    su = f"{env['PATH']}/su"
    assert command_line(out) == (
        f"{su} root -c 'env DEBIAN_FRONTEND=noninteractive apt-get update && "
        "env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "
        "git ca-certificates tmux bubblewrap'")


@pytest.mark.parametrize("distro", ["fedora", "nobara", "rhel", "rocky"])
def test_fedora_family_and_rhel_family_use_dnf(tmp_path, distro):
    env = machine(tmp_path, linux=True, have=("dnf", "yum", "sudo", "curl"))
    out = check(env, SHELLS[0], distro, tmp_path)
    assert command_line(out) == f"{env['PATH']}/sudo dnf install -y git tmux bubblewrap"


def test_centos7_has_only_yum(tmp_path):
    env = machine(tmp_path, linux=True, have=("yum", "sudo", "curl"))
    out = check(env, SHELLS[0], "centos7", tmp_path)
    assert "CentOS Linux 7 (Core)" in out
    assert command_line(out) == f"{env['PATH']}/sudo yum install -y git tmux bubblewrap"


def test_linuxbrew_never_outranks_the_distro_manager(tmp_path):
    env = machine(tmp_path, linux=True, have=("brew", "apt-get", "sudo", "curl"))
    out = check(env, SHELLS[0], "mint", tmp_path)
    assert "Linux Mint 22" in out, "the unterminated last os-release line was lost"
    assert "apt-get install" in command_line(out)


def test_only_what_is_missing_is_asked_for(tmp_path):
    env = machine(tmp_path, linux=True, have=("apt-get", "sudo", "curl", "git", "bwrap"))
    out = check(env, SHELLS[0], "ubuntu", tmp_path)
    assert command_line(out).endswith("apt-get install -y --no-install-recommends tmux")


def test_a_complete_machine_needs_nothing_from_the_system(tmp_path):
    env = machine(tmp_path, linux=True,
                  have=("apt-get", "sudo", "curl", "git", "tmux", "bwrap", "node", "npm", "rg", "python3"))
    out = check(env, SHELLS[0], "ubuntu", tmp_path)
    assert "nothing to add from the system" in out
    assert "To add" not in out
    assert re.search(r"ok\s+node\s+22\.12\.0", out)


def test_no_elevator_at_all_says_run_it_as_root(tmp_path):
    env = machine(tmp_path, linux=True, have=("dnf", "curl"))
    out = check(env, SHELLS[0], "fedora", tmp_path)
    assert command_line(out) == "dnf install -y git tmux bubblewrap"
    assert "no sudo, doas or su here: run it as root" in out


@pytest.mark.parametrize("shell", SHELLS)
def test_blank_mac_has_no_package_manager_so_homebrew_is_offered(tmp_path, shell):
    env = machine(tmp_path, linux=False, have=("curl",))
    out = check(env, shell, None, tmp_path)
    assert "Requirements — macOS 15.6 · arm64" in out
    assert re.search(r"missing\s+git", out) and re.search(r"optional\s+tmux", out)
    assert re.search(r"missing\s+Homebrew\s+.*https://brew\.sh", out)
    assert "scanned by nemesis first" in out
    assert "brew install git tmux" in out
    assert "bubblewrap" not in out, "bubblewrap is Linux-only"


def test_mac_with_homebrew_just_brews_tmux(tmp_path):
    env = machine(tmp_path, linux=False, have=("curl", "brew", "git"), clt=True)
    out = check(env, SHELLS[0], None, tmp_path)
    assert command_line(out) == "brew install tmux"
    assert not re.search(r"missing\s+Homebrew", out)


def test_check_changes_nothing(tmp_path):
    env = machine(tmp_path, linux=True, have=("apt-get", "sudo", "curl"))
    check(env, SHELLS[0], "ubuntu", tmp_path)
    assert list(Path(env["HOME"]).iterdir()) == [], "--check wrote under HOME"


# ── the su route shows exactly what it runs ───────────────────────────────────
def lift(src: str, name: str) -> str:
    m = re.search(rf"^{name}\(\) \{{.*?^\}}\n", src, re.S | re.M)
    if not m:
        m = re.search(rf"^{name}\(\) \{{[^\n]*\}}\n", src, re.M)
    assert m, name
    return m.group(0)


def test_su_shows_the_line_it_runs():
    src = INSTALL.read_text()
    funcs = ("shq", "pkg_name", "pkg_names", "pkg_cmd", "root_prefix", "detect_pm", "pkg_install")
    stubs = """
find_cmd() { case $1 in su) echo /bin/su ;; apt-get) echo /usr/bin/apt-get ;; *) return 1 ;; esac; }
id() { echo 1000; }
run() { printf 'RUN:%s' "$#"; for a; do printf '|%s' "$a"; done; printf '\\n'; }
step() { :; }
warn() { :; }
say() { :; }
allow_system() { printf 'SHOWN:%s\\n' "$2"; return 0; }
SYSTEM_DEPS=yes
"""
    script = stubs + "\n".join(lift(src, f) for f in funcs) + '\npkg_install "git and tmux" git tmux </dev/null\n'
    # pkg_install gives su the terminal as stdin; there is none here, so point it at /dev/null
    script = script.replace("</dev/tty", "</dev/null")
    out = subprocess.run(["sh", "-c", script], capture_output=True, text=True, timeout=30).stdout
    shown = [ln[6:] for ln in out.splitlines() if ln.startswith("SHOWN:")]
    ran = [ln[4:] for ln in out.splitlines() if ln.startswith("RUN:")]
    inner = ("env DEBIAN_FRONTEND=noninteractive apt-get update && env DEBIAN_FRONTEND=noninteractive "
             "apt-get install -y --no-install-recommends git ca-certificates tmux")
    assert shown == [f"/bin/su root -c '{inner}'"]
    assert ran == [f"4|/bin/su|root|-c|{inner}"], "su must get the shown line as ONE argument"


@pytest.mark.parametrize("distro,manager,pkg", [("ubuntu", "apt-get", "libsecret-tools"),
                                                 ("fedora", "dnf", "libsecret")])
def test_a_linux_desktop_also_gets_the_keyring_tool(tmp_path, distro, manager, pkg):
    env = machine(tmp_path, linux=True, have=(manager, "sudo", "curl", "git", "tmux", "bwrap"))
    env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"
    out = check(env, SHELLS[0], distro, tmp_path)
    assert re.search(r"optional\s+secret-tool", out)
    assert command_line(out).endswith(pkg)


def test_a_server_never_gets_the_keyring_tool(tmp_path):
    env = machine(tmp_path, linux=True, have=("apt-get", "sudo", "curl", "git", "tmux", "bwrap"))
    out = check(env, SHELLS[0], "ubuntu", tmp_path)
    assert "secret-tool" not in out


def test_deps_mode_with_no_terminal_prints_and_runs_nothing(tmp_path):
    env = machine(tmp_path, linux=True, have=("apt-get", "curl"))
    log = tmp_path / "sudo.log"
    stub(Path(env["PATH"]) / "sudo", f'printf "%s\\n" "$*" >> {log}; exit 0')
    osr = tmp_path / "os-release"
    osr.write_text(OS_RELEASE["ubuntu"])
    r = subprocess.run([SHELLS[0], str(INSTALL), "--deps"], capture_output=True, text=True,
                       timeout=60, stdin=subprocess.DEVNULL, start_new_session=True,
                       env={**env, "PROMETHEUS_OS_RELEASE": str(osr)})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "no terminal to ask on" in r.stdout
    assert "Not installed" in r.stdout and "add them:" in r.stdout
    assert not log.exists(), "sudo ran without anyone saying yes"
    assert list(Path(env["HOME"]).iterdir()) == [], "--deps installed Prometheus files"


def test_deps_mode_with_consent_runs_exactly_the_shown_command(tmp_path):
    env = machine(tmp_path, linux=True, have=("apt-get", "curl"))
    log = tmp_path / "sudo.log"
    stub(Path(env["PATH"]) / "sudo", f'printf "%s\\n" "$*" >> {log}; exit 0')
    osr = tmp_path / "os-release"
    osr.write_text(OS_RELEASE["ubuntu"])
    r = subprocess.run([SHELLS[0], str(INSTALL), "--deps", "--system-deps"], capture_output=True,
                       text=True, timeout=60, stdin=subprocess.DEVNULL, start_new_session=True,
                       env={**env, "PROMETHEUS_OS_RELEASE": str(osr)})
    assert r.returncode == 0, r.stdout + r.stderr
    shown = command_line(r.stdout)
    sudo = f"{env['PATH']}/sudo "
    ran = [f"{sudo}{line}" for line in log.read_text().splitlines()]
    assert " && ".join(ran) == shown


# ── the engine's copy agrees with install.sh, package for package ───────────────
def _engine():
    import importlib.util
    import sys as _sys
    spec = importlib.util.spec_from_file_location("prom_reqs_parity", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    _sys.modules["prom_reqs_parity"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("distro,have", [
    ("ubuntu", ("apt-get", "sudo", "curl")),
    ("debian", ("apt-get", "sudo", "curl", "git")),
    ("fedora", ("dnf", "yum", "sudo", "curl")),
    ("nobara", ("dnf", "sudo", "curl", "tmux")),
    ("rhel", ("dnf", "sudo", "curl")),
    ("centos7", ("yum", "sudo", "curl")),
])
def test_engine_doctor_offers_the_same_command_as_install_sh(tmp_path, monkeypatch, distro, have):
    env = machine(tmp_path, linux=True, have=have)
    shown = command_line(check(env, SHELLS[0], distro, tmp_path)).replace(f"{env['PATH']}/sudo", "sudo")
    prom = _engine()
    present = set(have) | ({"bwrap"} if "bwrap" in have else set())
    monkeypatch.setattr(prom.shutil, "which", lambda b, *a, **k: f"/usr/bin/{b}" if b in present else None)
    r = prom.system_requirements(system="Linux", os_release=str(tmp_path / "os-release"), desktop=False)
    assert r["command"] == shown
