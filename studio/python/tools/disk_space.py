#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""disk_space.py - interactive disk space analyzer, explorer and cleaner (Linux and macOS).

    python3 disk_space.py                 # asks for sudo, opens the TUI
    python3 disk_space.py --map           # full-disk map: tree, pie/bar charts, copy/open/delete
    python3 disk_space.py --map ~/        # map any folder
    python3 disk_space.py --tree / --depth 3 --top 8     # text tree of the whole disk
    python3 disk_space.py --levels /      # 'du -x --max-depth=N | sort -rh' for N = 1..10
    python3 disk_space.py --scan          # plain-text ranked report
    python3 disk_space.py --json          # machine-readable report
    python3 disk_space.py --dry-run       # simulate everything, touch nothing
    python3 disk_space.py --apply apt-cache:clean --yes
    python3 disk_space.py --apply swap:set-swappiness --param value=10 --yes
    python3 disk_space.py --list-procedures
    python3 disk_space.py --no-sudo --scan   # degraded scan without root

Standard library only. Ubuntu/Debian first, generic Linux fallbacks, macOS for the disk map.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import curses
import datetime as _dt
import glob
import heapq
import json
import locale
import math
import os
import pwd
import re
import shlex
import shutil
import stat
import subprocess
import sys
import textwrap
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

VERSION = "2.0.0"
IS_MAC = sys.platform == "darwin"
MAC_DATA = "/System/Volumes/Data"
SCRIPT_PATH = os.path.realpath(__file__)

KIB = 1024
MIB = KIB * KIB
GIB = MIB * KIB
TIB = GIB * KIB

# Set in main() when the terminal can show UTF-8 (block characters for charts, accented names).
UNICODE_OK = False

# Findings smaller than this are hidden unless flagged informational.
MIN_REPORT = 20 * MIB

RISK_SAFE = "SAFE"      # regenerable caches, nothing to lose
RISK_LOW = "LOW"        # rebuildable data (images, packages), minor inconvenience
RISK_MEDIUM = "MEDIUM"  # service interruption, reboot, or config change
RISK_HIGH = "HIGH"      # irreversible loss of user data possible
RISK_ORDER = {RISK_SAFE: 0, RISK_LOW: 1, RISK_MEDIUM: 2, RISK_HIGH: 3}

CAT_CONTAINERS = "Containers & VMs"
CAT_PACKAGES = "Packages"
CAT_KERNEL = "Kernel & boot"
CAT_LOGS = "Logs & crash dumps"
CAT_SYSTEM_CACHE = "System caches & temp"
CAT_SNAP = "Snap & Flatpak"
CAT_USER = "User caches & trash"
CAT_DEV = "Developer toolchains"
CAT_AI = "AI/ML models"
CAT_APPS = "Browsers & desktop apps"
CAT_SNAPSHOTS = "Snapshots & backups"
CAT_FS = "Filesystem"
CAT_SWAP = "Swap & memory"
CAT_OTHER = "Other"

PSEUDO_FS = {
    "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "pstore", "bpf",
    "securityfs", "debugfs", "tracefs", "configfs", "fusectl", "mqueue", "hugetlbfs",
    "autofs", "binfmt_misc", "efivarfs", "ramfs", "rpc_pipefs", "nsfs", "squashfs",
    "overlay", "fuse.gvfsd-fuse", "fuse.portal", "fuse.snapfuse", "nfsd", "selinuxfs",
}


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------

def human(n: Optional[float]) -> str:
    """1536 -> '1.5K', 10737418240 -> '10.0G'."""
    if n is None:
        return "?"
    n = float(n)
    neg = n < 0
    n = abs(n)
    for unit in ("B", "K", "M", "G", "T", "P"):
        if n < KIB or unit == "P":
            s = f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
            return ("-" if neg else "") + s
        n /= KIB
    return f"{n:.1f}P"


_SIZE_RE = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*([kKmMgGtTpP]?)(i?)([bB]?)\s*$")


def parse_size(text: str, decimal: bool = False) -> int:
    """'10G' -> bytes. decimal=True treats 1G as 1e9 (Docker style)."""
    m = _SIZE_RE.match(str(text))
    if not m:
        return 0
    value = float(m.group(1))
    unit = m.group(2).upper()
    base = 1000.0 if (decimal and not m.group(3)) else 1024.0
    power = {"": 0, "K": 1, "M": 2, "G": 3, "T": 4, "P": 5}[unit]
    return int(value * (base ** power))


def now_str() -> str:
    return _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def read_text(path: str, default: str = "") -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return default


def read_json(path: str) -> dict:
    try:
        data = json.loads(read_text(path, "{}") or "{}")
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def safe_int(text: Any, default: int = 0) -> int:
    try:
        return int(str(text).strip())
    except (TypeError, ValueError):
        return default


def wrap(text: str, width: int) -> list[str]:
    out: list[str] = []
    for para in str(text).splitlines() or [""]:
        if not para.strip():
            out.append("")
            continue
        out.extend(textwrap.wrap(para, max(10, width), replace_whitespace=False,
                                 drop_whitespace=True) or [""])
    return out


def strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)


# --------------------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------------------

@dataclass
class Input:
    """A parameter the user must supply before an action runs."""
    key: str
    prompt: str
    default: str = ""
    kind: str = "text"          # text | int | path | yesno | choice
    choices: list = field(default_factory=list)
    help: str = ""
    min: Optional[int] = None
    max: Optional[int] = None
    allow_empty: bool = False

    def validate(self, raw: str) -> tuple[bool, str, Any]:
        """Return (ok, error_message, normalized_value)."""
        value = (raw if raw is not None else "").strip()
        if value == "" and self.default != "":
            value = self.default
        if self.kind == "int":
            try:
                iv = int(value)
            except ValueError:
                return False, "enter a whole number", None
            if self.min is not None and iv < self.min:
                return False, f"minimum is {self.min}", None
            if self.max is not None and iv > self.max:
                return False, f"maximum is {self.max}", None
            return True, "", iv
        if self.kind == "yesno":
            low = value.lower()
            if low in ("y", "yes", "true", "1"):
                return True, "", "yes"
            if low in ("n", "no", "false", "0"):
                return True, "", "no"
            return False, "answer yes or no", None
        if self.kind == "choice":
            if value in self.choices:
                return True, "", value
            return False, "choose one of: " + ", ".join(self.choices), None
        if self.kind == "path":
            if not value.startswith("/"):
                return False, "enter an absolute path", None
            return True, "", os.path.normpath(value)
        if value == "" and not self.allow_empty:
            return False, "value required", None
        return True, "", value


@dataclass
class ActionResult:
    ok: bool
    output: str = ""
    freed: int = 0
    message: str = ""
    requires_reboot: bool = False


@dataclass
class Action:
    """One concrete remedy for a Finding.

    Either `commands` (a list of argv lists, run in order, "{key}" placeholders replaced
    by params) or `func(ctx, action) -> ActionResult` for anything that needs logic.
    Funcs MUST use ctx.run(..., mutating=True), ctx.remove_path(), ctx.write_file() so
    that dry-run mode is honoured automatically.
    """
    id: str
    title: str
    description: str
    risk: str = RISK_LOW
    reclaim: int = 0
    commands: list = field(default_factory=list)
    func: Optional[Callable[["Context", "Action"], ActionResult]] = None
    inputs: list = field(default_factory=list)
    needs_root: bool = True
    requires_reboot: bool = False
    recommended: bool = False
    continue_on_error: bool = False
    notes: list = field(default_factory=list)
    params: dict = field(default_factory=dict)

    def rendered_commands(self) -> list[list[str]]:
        out = []
        for argv in self.commands:
            rendered = []
            for part in argv:
                part = str(part)
                if "{" in part and "}" in part:
                    try:
                        part = part.format(**self.params)
                    except (KeyError, IndexError, ValueError):
                        pass
                rendered.append(part)
            out.append(rendered)
        return out

    def preview_lines(self) -> list[str]:
        lines = []
        if self.commands:
            for argv in self.rendered_commands():
                lines.append("$ " + shlex.join(argv))
        elif self.func is not None:
            lines.append("(python routine: %s)" % (getattr(self.func, "__name__", "action")))
            paths = list(self.params.get("_paths") or [])
            verb = str(self.params.get("_verb") or ("delete contents of" if self.params.get("_keep_dir") else "delete"))
            for p in paths[:8]:
                lines.append(f"{verb} {p}")
            if len(paths) > 8:
                lines.append(f"... and {len(paths) - 8} more")
        return lines


@dataclass
class Finding:
    """A measured source of waste plus the actions that address it."""
    id: str
    title: str
    category: str
    size: int
    reclaimable: int
    mountpoint: str
    summary: str
    details: list = field(default_factory=list)
    actions: list = field(default_factory=list)
    procedure: str = ""
    informational: bool = False
    risk: str = ""
    on_os_disk: bool = False

    def __post_init__(self):
        self.size = max(0, int(self.size or 0))
        self.reclaimable = max(0, int(self.reclaimable or 0))
        if not self.risk:
            self.risk = self.compute_risk()

    def compute_risk(self) -> str:
        rec = [a for a in self.actions if a.recommended]
        if rec:
            return max((a.risk for a in rec), key=lambda r: RISK_ORDER.get(r, 1))
        if self.actions:
            return min((a.risk for a in self.actions), key=lambda r: RISK_ORDER.get(r, 1))
        return RISK_SAFE

    def action(self, action_id: str) -> Optional[Action]:
        for a in self.actions:
            if a.id == action_id:
                return a
        return None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "title": self.title, "category": self.category,
            "size": self.size, "size_h": human(self.size),
            "reclaimable": self.reclaimable, "reclaimable_h": human(self.reclaimable),
            "mountpoint": self.mountpoint, "on_os_disk": self.on_os_disk,
            "risk": self.risk, "procedure": self.procedure,
            "informational": self.informational, "summary": self.summary,
            "details": list(self.details),
            "actions": [
                {
                    "id": a.id, "title": a.title, "risk": a.risk, "reclaim": a.reclaim,
                    "recommended": a.recommended, "requires_reboot": a.requires_reboot,
                    "description": a.description, "commands": a.preview_lines(),
                    "inputs": [{"key": i.key, "prompt": i.prompt, "default": i.default,
                                "kind": i.kind} for i in a.inputs],
                } for a in self.actions
            ],
        }


@dataclass
class Mount:
    source: str
    target: str
    fstype: str
    total: int = 0
    used: int = 0
    free: int = 0
    disk: str = ""
    on_os_disk: bool = False

    @property
    def use_pct(self) -> float:
        return (100.0 * self.used / self.total) if self.total else 0.0


# --------------------------------------------------------------------------------------
# Context: everything a procedure needs to look at and change the system
# --------------------------------------------------------------------------------------

PROTECTED_PATHS = {
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libx32",
    "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp",
    "/usr", "/var", "/var/lib", "/var/log", "/var/cache", "/usr/lib", "/usr/share",
    "/usr/bin", "/usr/local", "/etc/default", "/snap",
}


class Context:
    def __init__(self, dry_run: bool = False, verbose: bool = False,
                 log_path: Optional[str] = None):
        self.dry_run = dry_run
        self.verbose = verbose
        self.is_root = os.geteuid() == 0
        self.hostname = os.uname().nodename
        self.os_release = self._parse_os_release()
        self.real_user, self.real_uid, self.real_home = self._detect_real_user()
        self._lock = threading.RLock()
        self._du_cache: dict[tuple, int] = {}
        self._sink: Optional[Callable[[str], None]] = None
        self.warnings: list[str] = []
        self.log_path = log_path or self._default_log_path()
        # GUI/session variables of the invoking user (restored after the sudo re-exec), used to
        # run clipboard, file-manager and shell commands as that user.
        self.user_env: dict[str, str] = {}
        self.all_mounts: list[tuple[str, str]] = []   # (target, fstype) of every mount, pseudo too
        self.mounts: list[Mount] = self._read_mounts()
        self.root_mount = self.mount_for("/")
        self.os_disk = self._parent_disk(self.root_mount.source) if self.root_mount else ""
        for m in self.mounts:
            m.disk = self._parent_disk(m.source)
            m.on_os_disk = bool(self.os_disk) and m.disk == self.os_disk
        self.log(f"=== disk_space {VERSION} start (root={self.is_root}, dry_run={dry_run}, "
                 f"user={self.real_user}, os_disk={self.os_disk}) ===")

    # -- identity ----------------------------------------------------------------------
    @staticmethod
    def _parse_os_release() -> dict:
        out = {}
        if IS_MAC:
            try:
                ver = subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True,
                                     timeout=10).stdout.strip()
            except Exception:
                ver = ""
            return {"ID": "macos", "PRETTY_NAME": f"macOS {ver}".strip()}
        for line in read_text("/etc/os-release").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
        return out

    @property
    def distro_id(self) -> str:
        return (self.os_release.get("ID") or "linux").lower()

    @property
    def distro_like(self) -> str:
        return ((self.os_release.get("ID_LIKE") or "") + " " + self.distro_id).lower()

    @property
    def is_debian_like(self) -> bool:
        return any(x in self.distro_like for x in ("debian", "ubuntu")) or \
            os.path.exists("/etc/debian_version")

    @property
    def distro_pretty(self) -> str:
        return self.os_release.get("PRETTY_NAME") or ("macOS" if IS_MAC else "Linux")

    @staticmethod
    def _detect_real_user() -> tuple[str, int, Path]:
        name = os.environ.get("SUDO_USER") or os.environ.get("PKEXEC_UID") or ""
        try:
            if name and not name.isdigit():
                pw = pwd.getpwnam(name)
            elif name.isdigit():
                pw = pwd.getpwuid(int(name))
            else:
                pw = pwd.getpwuid(os.getuid())
        except KeyError:
            pw = pwd.getpwuid(os.getuid())
        return pw.pw_name, pw.pw_uid, Path(pw.pw_dir)

    def user_homes(self) -> list[tuple[str, Path]]:
        """Real users with an existing home (uid >= 1000, >= 501 on macOS), invoking user first, root last."""
        seen: dict[str, Path] = {}
        if self.real_home.is_dir():
            seen[self.real_user] = self.real_home
        try:
            for pw in pwd.getpwall():
                if (501 if IS_MAC else 1000) <= pw.pw_uid < 60000 and pw.pw_dir and pw.pw_dir.startswith("/"):
                    home = Path(pw.pw_dir)
                    if home.is_dir() and pw.pw_name not in seen and \
                            not pw.pw_shell.endswith(("nologin", "false")):
                        seen[pw.pw_name] = home
        except Exception:  # pragma: no cover - defensive
            pass
        root_home = "/var/root" if IS_MAC else "/root"
        if self.is_root and Path(root_home).is_dir() and "root" not in seen:
            seen["root"] = Path(root_home)
        return list(seen.items())

    # -- logging -----------------------------------------------------------------------
    def _default_log_path(self) -> str:
        if self.is_root:
            return "/var/log/disk_space.log"
        base = Path(os.environ.get("XDG_CACHE_HOME") or (self.real_home / ".cache")) / "disk_space"
        try:
            base.mkdir(parents=True, exist_ok=True)
        except OSError:
            base = Path("/tmp")
        return str(base / "disk_space.log")

    def log(self, msg: str) -> None:
        line = f"{now_str()} {msg}"
        with self._lock:
            try:
                with open(self.log_path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                pass
        if self.verbose and self._sink is None:
            print(line, file=sys.stderr)

    def emit(self, msg: str) -> None:
        """Progress text for the user during an action (goes to the TUI log + file)."""
        self.log("  | " + msg)
        sink = self._sink
        if sink is not None:
            try:
                sink(msg)
            except Exception:
                pass

    def warn(self, msg: str) -> None:
        with self._lock:
            self.warnings.append(msg)
        self.log("WARN " + msg)

    # -- processes ---------------------------------------------------------------------
    def which(self, name: str) -> Optional[str]:
        path = os.environ.get("PATH", "") + ":/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/snap/bin"
        return shutil.which(name, path=path)

    def run(self, argv, timeout: int = 300, input_text: Optional[str] = None,
            mutating: bool = False, env: Optional[dict] = None,
            cwd: Optional[str] = None) -> subprocess.CompletedProcess:
        """Run a command, never raise. mutating=True is skipped in dry-run mode."""
        cmd = [str(a) for a in argv]
        if mutating and self.dry_run:
            text = "[dry-run] would run: " + shlex.join(cmd)
            self.log(text)
            return subprocess.CompletedProcess(cmd, 0, text + "\n", "")
        self.log(("RUN  " if mutating else "run  ") + shlex.join(cmd))
        kwargs: dict = dict(capture_output=True, text=True, errors="replace",
                            timeout=timeout, cwd=cwd)
        if env is not None:
            merged = dict(os.environ)
            merged.update(env)
            kwargs["env"] = merged
        if input_text is None:
            kwargs["stdin"] = subprocess.DEVNULL
        else:
            kwargs["input"] = input_text
        try:
            cp = subprocess.run(cmd, **kwargs)
        except FileNotFoundError:
            return subprocess.CompletedProcess(cmd, 127, "", f"{cmd[0]}: command not found\n")
        except subprocess.TimeoutExpired as exc:
            return subprocess.CompletedProcess(cmd, 124, exc.stdout or "",
                                               f"timed out after {timeout}s\n")
        except Exception as exc:  # pragma: no cover
            return subprocess.CompletedProcess(cmd, 1, "", f"{exc}\n")
        if mutating or cp.returncode not in (0,) and self.verbose:
            self.log(f"     -> rc={cp.returncode}")
        return cp

    def run_stream(self, argv, on_line: Optional[Callable[[str], None]] = None,
                   mutating: bool = True, timeout: int = 7200,
                   env: Optional[dict] = None) -> int:
        """Run a long command, streaming stdout+stderr lines. Returns the exit code."""
        cmd = [str(a) for a in argv]
        emit = on_line or self.emit
        if mutating and self.dry_run:
            emit("[dry-run] would run: " + shlex.join(cmd))
            self.log("[dry-run] would run: " + shlex.join(cmd))
            return 0
        self.log("RUN  " + shlex.join(cmd))
        emit("$ " + shlex.join(cmd))
        kwargs: dict = dict(stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, text=True, errors="replace", bufsize=1)
        if env is not None:
            merged = dict(os.environ)
            merged.update(env)
            kwargs["env"] = merged
        try:
            proc = subprocess.Popen(cmd, **kwargs)
        except FileNotFoundError:
            emit(f"{cmd[0]}: command not found")
            return 127
        except Exception as exc:
            emit(str(exc))
            return 1
        deadline = time.time() + timeout
        try:
            assert proc.stdout is not None
            for raw in proc.stdout:
                for piece in raw.replace("\r", "\n").split("\n"):
                    piece = strip_ansi(piece).rstrip()
                    if piece:
                        emit(piece)
                if time.time() > deadline:
                    proc.kill()
                    emit(f"timed out after {timeout}s")
                    break
            proc.wait(timeout=60)
        except Exception as exc:
            emit(str(exc))
            try:
                proc.kill()
            except Exception:
                pass
            return 1
        self.log(f"     -> rc={proc.returncode}")
        return proc.returncode

    # -- filesystems -------------------------------------------------------------------
    def _read_mounts(self) -> list[Mount]:
        if IS_MAC:
            return self._read_mounts_darwin()
        mounts: dict[str, Mount] = {}
        self.all_mounts = []
        for line in read_text("/proc/self/mounts").splitlines():
            parts = line.split()
            if len(parts) >= 3:
                self.all_mounts.append((parts[1].replace("\\040", " ").replace("\\011", "\t"), parts[2]))
        for line in read_text("/proc/self/mounts").splitlines():
            parts = line.split()
            if len(parts) < 3:
                continue
            source, target, fstype = parts[0], parts[1], parts[2]
            target = target.replace("\\040", " ").replace("\\011", "\t")
            if fstype in PSEUDO_FS:
                continue
            if not (source.startswith("/dev/") or fstype in ("zfs", "btrfs", "nfs", "nfs4",
                                                                "cifs", "fuse.sshfs")):
                continue
            if target.startswith(("/snap/", "/var/lib/snapd/snap/", "/proc/", "/sys/", "/dev/")):
                continue
            if target.startswith("/run/") and not target.startswith(("/run/media/", "/run/mount/",
                                                                      "/run/user/")):
                continue
            if target.startswith("/run/user/") and fstype not in ("fuse.sshfs", "cifs", "nfs", "nfs4"):
                continue
            src = source
            if source.startswith("/dev/"):
                try:
                    src = os.path.realpath(source)
                except OSError:
                    pass
            m = Mount(source=src, target=target, fstype=fstype)
            try:
                du = shutil.disk_usage(target)
                m.total, m.free = du.total, du.free
                m.used = du.used
            except OSError:
                continue
            mounts[target] = m
        return sorted(mounts.values(), key=lambda m: m.target)

    def _read_mounts_darwin(self) -> list[Mount]:
        """Parse `mount` output: '/dev/disk3s5 on /System/Volumes/Data (apfs, local, ...)'."""
        mounts: dict[str, Mount] = {}
        self.all_mounts = []
        try:
            out = subprocess.run(["/sbin/mount"], capture_output=True, text=True, timeout=20).stdout
        except Exception:
            out = ""
        for line in out.splitlines():
            m = re.match(r"^(.*?) on (.*) \(([^,)]+)(.*)\)$", line)
            if not m:
                continue
            source, target, fstype, opts = m.group(1), m.group(2), m.group(3).strip(), m.group(4)
            self.all_mounts.append((target, fstype))
            if fstype in ("devfs", "autofs", "nullfs", "fdesc") or "nobrowse" in opts and \
                    target not in ("/", MAC_DATA):
                continue
            mo = Mount(source=source, target=target, fstype=fstype)
            try:
                du = shutil.disk_usage(target)
            except OSError:
                continue
            mo.total, mo.free, mo.used = du.total, du.free, du.used
            mounts[target] = mo
        return sorted(mounts.values(), key=lambda m: m.target)

    def _parent_disk(self, source: str) -> str:
        """'/dev/nvme1n1p3' -> 'nvme1n1', follows LVM/LUKS chains via lsblk; '/dev/disk3s1s1' -> 'disk3'."""
        if not source.startswith("/dev/"):
            return source.split("/")[0] if source else ""
        name = os.path.basename(source)
        if IS_MAC:
            m = re.match(r"^(disk\d+)", name)
            return m.group(1) if m else name
        lsblk = self.which("lsblk")
        if lsblk:
            seen = set()
            cur = source
            for _ in range(8):
                cp = self.run([lsblk, "-no", "PKNAME", cur], timeout=10)
                parents = [p for p in cp.stdout.split() if p]
                if cp.returncode != 0 or not parents or parents[0] in seen:
                    break
                seen.add(parents[0])
                name = parents[0]
                cur = "/dev/" + name
            return name
        m = re.match(r"^(nvme\d+n\d+|mmcblk\d+)p\d+$", name) or re.match(r"^([a-z]+)\d+$", name)
        return m.group(1) if m else name

    def mount_for(self, path: str) -> Mount:
        path = os.path.abspath(path or "/")
        best = None
        for m in self.mounts:
            t = m.target
            if path == t or path.startswith(t.rstrip("/") + "/") or t == "/":
                if best is None or len(t) > len(best.target):
                    best = m
        if best is None:
            best = Mount("?", "/", "?")
        return best

    def fs_free(self, path: str) -> int:
        try:
            return shutil.disk_usage(path).free
        except OSError:
            return 0

    def refresh_mounts(self) -> None:
        for m in self.mounts:
            try:
                du = shutil.disk_usage(m.target)
                m.total, m.free, m.used = du.total, du.free, du.used
            except OSError:
                pass

    def biggest_non_os_mount(self, min_free: int = 0) -> Optional[Mount]:
        """The mount with most free space that is NOT on the OS disk (POSIX fs only)."""
        cands = [m for m in self.mounts if not m.on_os_disk and m.free > min_free and
                 m.fstype in ("ext4", "ext3", "ext2", "xfs", "btrfs", "zfs", "f2fs", "jfs",
                              "reiserfs", "bcachefs")]
        return max(cands, key=lambda m: m.free) if cands else None

    # -- sizes -------------------------------------------------------------------------
    def gnu_du(self) -> Optional[str]:
        """Path of GNU du (understands -B1 and --max-depth) or None. BSD and BusyBox du print
        block counts for -B1 or reject it, so those systems use the python walker instead."""
        with self._lock:
            cached = self.__dict__.get("_gnu_du")
        if cached is None:
            du = self.which("du")
            ok = False
            if du:
                cp = self.run([du, "--version"], timeout=10)
                ok = cp.returncode == 0 and "GNU" in cp.stdout
            cached = du if ok else ""
            with self._lock:
                self._gnu_du = cached
        return cached or None

    def du(self, path: str, one_fs: bool = True, apparent: bool = False) -> int:
        """Allocated bytes under path (GNU du, python fallback). Cached per scan."""
        path = str(path)
        key = (path, one_fs, apparent)
        with self._lock:
            if key in self._du_cache:
                return self._du_cache[key]
        size = 0
        if os.path.lexists(path):
            if os.path.islink(path) or not os.path.isdir(path):
                size = self.path_size(path)
            else:
                du = self.gnu_du()
                if du:
                    argv = [du, "-s", "-B1"]
                    if one_fs:
                        argv.append("-x")
                    if apparent:
                        argv.append("--apparent-size")
                    argv += ["--", path]
                    cp = self.run(argv, timeout=1800)
                    line = ""
                    for candidate in cp.stdout.strip().splitlines()[::-1]:
                        if candidate.strip():
                            line = candidate
                            break
                    size = safe_int(line.split("\t")[0] if "\t" in line else line.split(" ")[0], -1)
                    if size < 0:
                        size = self._walk_size(path, one_fs)
                else:
                    size = self._walk_size(path, one_fs)
        with self._lock:
            self._du_cache[key] = size
        return size

    def du_children(self, path: str, one_fs: bool = True) -> list[tuple[int, str]]:
        """[(bytes, child_path)] for the direct children of path, biggest first."""
        out: list[tuple[int, str]] = []
        if not os.path.isdir(path):
            return out
        du = self.gnu_du()
        if du:
            argv = [du, "-B1", "--max-depth=1"] + (["-x"] if one_fs else []) + ["--", path]
            cp = self.run(argv, timeout=1800)
            for line in cp.stdout.splitlines():
                if "\t" not in line:
                    continue
                sz, p = line.split("\t", 1)
                if os.path.abspath(p) == os.path.abspath(path):
                    continue
                out.append((safe_int(sz), p))
        else:
            try:
                for entry in os.scandir(path):
                    out.append((self.du(entry.path, one_fs), entry.path))
            except OSError:
                pass
        out.sort(reverse=True)
        return out

    def _walk_size(self, path: str, one_fs: bool) -> int:
        total = 0
        seen: set[tuple[int, int]] = set()
        try:
            root_dev = os.lstat(path).st_dev
        except OSError:
            return 0
        for dirpath, dirnames, filenames in os.walk(path, onerror=lambda e: None):
            if one_fs:
                try:
                    if os.lstat(dirpath).st_dev != root_dev:
                        dirnames[:] = []
                        continue
                except OSError:
                    continue
            for name in filenames + dirnames:
                try:
                    st = os.lstat(os.path.join(dirpath, name))
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    total += st.st_blocks * 512
                    continue
                key = (st.st_dev, st.st_ino)
                if st.st_nlink > 1:
                    if key in seen:
                        continue
                    seen.add(key)
                total += st.st_blocks * 512
        return total

    @staticmethod
    def path_size(path: str) -> int:
        try:
            st = os.lstat(path)
        except OSError:
            return 0
        return st.st_blocks * 512

    @staticmethod
    def file_age_days(path: str) -> float:
        try:
            return (time.time() - os.lstat(path).st_mtime) / 86400.0
        except OSError:
            return 0.0

    def list_files(self, root: str, pattern: str = "*", min_size: int = 0,
                   max_depth: int = 1, one_fs: bool = True) -> list[tuple[int, str]]:
        """[(bytes, path)] of regular files matching a glob under root."""
        results: list[tuple[int, str]] = []
        root = str(root)
        if not os.path.isdir(root):
            return results
        try:
            root_dev = os.lstat(root).st_dev
        except OSError:
            return results
        base_depth = root.rstrip("/").count("/")
        import fnmatch
        for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: None):
            depth = dirpath.rstrip("/").count("/") - base_depth
            if depth >= max_depth:
                dirnames[:] = []
            if one_fs:
                try:
                    if os.lstat(dirpath).st_dev != root_dev:
                        dirnames[:] = []
                        continue
                except OSError:
                    continue
            for fn in filenames:
                if not fnmatch.fnmatch(fn, pattern):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    st = os.lstat(p)
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                sz = st.st_blocks * 512
                if sz >= min_size:
                    results.append((sz, p))
        results.sort(reverse=True)
        return results

    def find_dirs(self, roots, names, max_depth: int = 6, exclude=None, one_fs: bool = True,
                  skip_hidden: bool = True) -> list[tuple[int, str, float]]:
        """[(bytes, path, age_days)] of directories whose basename is in `names`, searched under
        each root at most `max_depth` levels deep. Never descends into a match, into hidden
        directories (unless the hidden name itself is wanted), into `exclude` names, symlinks or
        other filesystems. Biggest first."""
        wanted = set(names)
        excluded = set(exclude or ())
        out: list[tuple[int, str, float]] = []
        seen: set[str] = set()
        for root in roots:
            root = str(root)
            if not os.path.isdir(root):
                continue
            try:
                root_dev = os.lstat(root).st_dev
            except OSError:
                continue
            base_depth = root.rstrip("/").count("/")
            for dirpath, dirnames, _ in os.walk(root, onerror=lambda e: None):
                depth = dirpath.rstrip("/").count("/") - base_depth
                keep = []
                for d in sorted(dirnames):
                    full = os.path.join(dirpath, d)
                    if os.path.islink(full):
                        continue
                    if d in wanted:
                        real = os.path.realpath(full)
                        if real not in seen:
                            seen.add(real)
                            out.append((self.du(full, one_fs), full, self.file_age_days(full)))
                        continue
                    if (skip_hidden and d.startswith(".")) or d in excluded or depth + 1 >= max_depth:
                        continue
                    if one_fs:
                        try:
                            if os.lstat(full).st_dev != root_dev:
                                continue
                        except OSError:
                            continue
                    keep.append(d)
                dirnames[:] = keep
        out.sort(reverse=True)
        return out

    # -- mutations (dry-run aware) -----------------------------------------------------
    def is_protected(self, path: str) -> bool:
        p = os.path.abspath(path)
        if p in PROTECTED_PATHS or p == str(self.real_home):
            return True
        if any(p == m.target for m in self.mounts):
            return True
        for name, home in self.user_homes():
            if p == str(home):
                return True
        return False

    def remove_path(self, path: str, keep_dir: bool = False) -> tuple[bool, str, int]:
        """Delete a file or directory tree. Returns (ok, message, bytes_removed)."""
        path = str(path)
        if not os.path.lexists(path):
            return True, f"{path}: already gone", 0
        if self.is_protected(path) and not keep_dir:
            return False, f"refusing to delete protected path {path}", 0
        size = self.du(path) if os.path.isdir(path) and not os.path.islink(path) else self.path_size(path)
        if self.dry_run:
            what = "contents of " if keep_dir else ""
            self.emit(f"[dry-run] would delete {what}{path} ({human(size)})")
            return True, f"[dry-run] would delete {what}{path} ({human(size)})", 0
        try:
            if os.path.isdir(path) and not os.path.islink(path):
                if keep_dir:
                    for entry in os.scandir(path):
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(entry.path, ignore_errors=True)
                        else:
                            try:
                                os.unlink(entry.path)
                            except OSError:
                                pass
                else:
                    shutil.rmtree(path, ignore_errors=True)
                    if os.path.exists(path):
                        shutil.rmtree(path)
            else:
                os.unlink(path)
        except OSError as exc:
            self.log(f"DEL  {path} FAILED: {exc}")
            return False, f"{path}: {exc}", 0
        self.log(f"DEL  {path} ({human(size)})")
        self.emit(f"deleted {path} ({human(size)})")
        with self._lock:
            self._du_cache = {k: v for k, v in self._du_cache.items()
                              if not k[0].startswith(path)}
        return True, f"deleted {path} ({human(size)})", size

    def remove_paths(self, paths, keep_dir: bool = False) -> ActionResult:
        ok_all, out, freed = True, [], 0
        for p in paths:
            ok, msg, sz = self.remove_path(p, keep_dir=keep_dir)
            ok_all = ok_all and ok
            out.append(msg)
            freed += sz
        return ActionResult(ok_all, "\n".join(out), freed)

    def truncate_file(self, path: str) -> tuple[bool, str, int]:
        size = self.path_size(path)
        if self.dry_run:
            self.emit(f"[dry-run] would truncate {path} ({human(size)})")
            return True, f"[dry-run] would truncate {path}", 0
        try:
            with open(path, "r+b") as fh:
                fh.truncate(0)
        except OSError as exc:
            return False, f"{path}: {exc}", 0
        self.log(f"TRUNC {path} ({human(size)})")
        self.emit(f"truncated {path} ({human(size)})")
        return True, f"truncated {path} ({human(size)})", size

    def write_file(self, path: str, content: str, mode: int = 0o644,
                   backup: bool = True) -> tuple[bool, str]:
        if self.dry_run:
            msg = f"[dry-run] would write {path} ({len(content)} bytes)"
            self.emit(msg)
            return True, msg
        try:
            if backup and os.path.exists(path):
                shutil.copy2(path, path + ".disk_space.bak")
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            tmp = path + ".disk_space.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        except OSError as exc:
            return False, f"{path}: {exc}"
        self.log(f"WRITE {path}")
        self.emit(f"wrote {path}")
        return True, f"wrote {path}"

    # -- services & packages -----------------------------------------------------------
    def has_systemd(self) -> bool:
        return os.path.isdir("/run/systemd/system") and self.which("systemctl") is not None

    def service_active(self, unit: str) -> bool:
        if not self.has_systemd():
            return False
        cp = self.run(["systemctl", "is-active", unit], timeout=15)
        return cp.stdout.strip() == "active"

    def service_enabled(self, unit: str) -> bool:
        if not self.has_systemd():
            return False
        cp = self.run(["systemctl", "is-enabled", unit], timeout=15)
        return cp.stdout.strip() in ("enabled", "enabled-runtime", "static", "alias")

    def unit_exists(self, unit: str) -> bool:
        if not self.has_systemd():
            return False
        cp = self.run(["systemctl", "cat", "--no-pager", unit], timeout=15)
        return cp.returncode == 0

    def pkg_installed(self, name: str) -> bool:
        if self.which("dpkg-query"):
            cp = self.run(["dpkg-query", "-W", "-f=${Status}", name], timeout=20)
            return cp.returncode == 0 and "installed" in cp.stdout and "not-installed" not in cp.stdout
        if self.which("rpm"):
            return self.run(["rpm", "-q", name], timeout=20).returncode == 0
        if self.which("pacman"):
            return self.run(["pacman", "-Qi", name], timeout=20).returncode == 0
        return False

    def meminfo(self) -> dict[str, int]:
        """/proc/meminfo in bytes."""
        out: dict[str, int] = {}
        for line in read_text("/proc/meminfo").splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                parts = v.split()
                if parts:
                    out[k.strip()] = safe_int(parts[0]) * (KIB if len(parts) > 1 and parts[1] == "kB" else 1)
        return out


# --------------------------------------------------------------------------------------
# Procedure base class and registry
# --------------------------------------------------------------------------------------
#
# PROCEDURE AUTHORING GUIDE
# -------------------------
# A Procedure is one family of waste (e.g. "APT package cache"). It must:
#   * be a class decorated with @register, with unique class-level `id` (kebab-case),
#     `title`, `category` (one of the CAT_* constants) and `description`;
#   * implement `applies(ctx) -> bool` as a cheap gate (tool installed, directory exists);
#   * implement `scan(ctx) -> list[Finding]` that MEASURES and NEVER deletes anything;
#   * put all helper code inside the class (no module-level names besides the class),
#     import only the standard library, and import extra modules inside methods;
#   * build Actions whose `commands` are argv lists (no shell strings), or whose `func`
#     uses only ctx.run(mutating=True) / ctx.run_stream / ctx.remove_path / ctx.truncate_file
#     / ctx.write_file so dry-run mode is respected;
#   * grade every Action with an honest RISK_* level and describe consequences;
#   * set `recommended=True` only on actions that are safe defaults;
#   * set Finding.mountpoint to the path measured (the scanner maps it to a mount);
#   * set Finding.informational=True for findings that should show even if tiny;
#   * tolerate missing tools, permission errors and non-root execution (return [] or a
#     Finding that explains what could not be measured).
# Useful ctx helpers: du, du_children, list_files, find_dirs, path_size, file_age_days, which,
# run, run_stream, remove_path, remove_paths, truncate_file, write_file, user_homes,
# real_home, is_root, dry_run, service_active, service_enabled, unit_exists,
# pkg_installed, mount_for, fs_free, biggest_non_os_mount, meminfo, emit, warn,
# is_debian_like, distro_id.
# Families that only need "measure these directories and offer to delete them" should subclass
# PathFamily (defined just before the generated block) and declare SPECS instead of writing
# scan() by hand. Actions built from python funcs should put the touched paths in
# params["_paths"] (and "_keep_dir" / "_verb") so the confirmation screen can list them.

class Procedure:
    id: str = "base"
    title: str = "Base procedure"
    category: str = CAT_OTHER
    description: str = ""

    def applies(self, ctx: Context) -> bool:
        return True

    def scan(self, ctx: Context) -> list[Finding]:
        return []


REGISTRY: dict[str, type] = {}


def register(cls):
    if cls.id in REGISTRY and REGISTRY[cls.id] is not cls:
        raise RuntimeError(f"duplicate procedure id {cls.id!r}: {cls.__name__} vs "
                           f"{REGISTRY[cls.id].__name__}")
    REGISTRY[cls.id] = cls
    return cls


# --------------------------------------------------------------------------------------
# Scanner and executor
# --------------------------------------------------------------------------------------

@dataclass
class ScanResult:
    findings: list = field(default_factory=list)
    errors: list = field(default_factory=list)      # (procedure_id, message)
    skipped: list = field(default_factory=list)     # procedure ids where applies() == False
    duration: float = 0.0


class Scanner:
    def __init__(self, ctx: Context, only: Optional[list[str]] = None, workers: int = 4):
        self.ctx = ctx
        self.only = set(only) if only else None
        self.workers = max(1, workers)

    def procedures(self) -> list[Procedure]:
        procs = []
        for pid, cls in sorted(REGISTRY.items()):
            if self.only and pid not in self.only:
                continue
            try:
                procs.append(cls())
            except Exception as exc:
                self.ctx.warn(f"cannot instantiate {pid}: {exc}")
        return procs

    def _run_one(self, proc: Procedure) -> tuple[list[Finding], Optional[str], bool]:
        try:
            if not proc.applies(self.ctx):
                return [], None, True
            findings = proc.scan(self.ctx) or []
        except Exception:
            return [], traceback.format_exc(limit=4), False
        cleaned = []
        for f in findings:
            if not isinstance(f, Finding):
                continue
            if not f.procedure:
                f.procedure = proc.id
            cleaned.append(f)
        return cleaned, None, False

    def scan(self, progress: Optional[Callable[[int, int, str], None]] = None,
             stop: Optional[threading.Event] = None) -> ScanResult:
        t0 = time.time()
        procs = self.procedures()
        result = ScanResult()
        total = len(procs)
        done = 0
        if progress:
            progress(0, total, "starting")
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = {pool.submit(self._run_one, p): p for p in procs}
            for fut in concurrent.futures.as_completed(futures):
                proc = futures[fut]
                done += 1
                try:
                    findings, err, skipped = fut.result()
                except Exception as exc:  # pragma: no cover
                    findings, err, skipped = [], str(exc), False
                if err:
                    result.errors.append((proc.id, err))
                    self.ctx.log(f"SCAN ERROR {proc.id}: {err.strip().splitlines()[-1]}")
                if skipped:
                    result.skipped.append(proc.id)
                result.findings.extend(findings)
                if progress:
                    progress(done, total, proc.title)
                if stop is not None and stop.is_set():
                    break
        result.findings = self.postprocess(result.findings)
        result.duration = time.time() - t0
        self.ctx.log(f"scan done: {len(result.findings)} findings, {len(result.errors)} errors, "
                     f"{result.duration:.1f}s")
        return result

    def rescan(self, procedure_id: str) -> list[Finding]:
        cls = REGISTRY.get(procedure_id)
        if cls is None:
            return []
        with self.ctx._lock:
            self.ctx._du_cache.clear()
        self.ctx.refresh_mounts()
        findings, err, _ = self._run_one(cls())
        if err:
            self.ctx.log(f"RESCAN ERROR {procedure_id}: {err}")
        return self.postprocess(findings)

    def postprocess(self, findings: list[Finding]) -> list[Finding]:
        seen_ids: dict[str, int] = {}
        out = []
        for f in findings:
            m = self.ctx.mount_for(f.mountpoint or "/")
            f.mountpoint = m.target
            f.on_os_disk = m.on_os_disk
            if f.reclaimable == 0 and not f.informational:
                f.reclaimable = 0
            if not f.informational and f.size < MIN_REPORT and f.reclaimable < MIN_REPORT:
                continue
            base = f.id
            n = seen_ids.get(base, 0)
            if n:
                f.id = f"{base}-{n + 1}"
            seen_ids[base] = n + 1
            if not f.risk:
                f.risk = f.compute_risk()
            out.append(f)
        return sort_findings(out)


def sort_findings(findings: list[Finding], key: str = "reclaimable") -> list[Finding]:
    if key == "size":
        return sorted(findings, key=lambda f: (-f.size, -f.reclaimable, f.title))
    if key == "risk":
        return sorted(findings, key=lambda f: (RISK_ORDER.get(f.risk, 1), -f.reclaimable, f.title))
    if key == "category":
        return sorted(findings, key=lambda f: (f.category, -f.reclaimable, f.title))
    return sorted(findings, key=lambda f: (f.informational, -f.reclaimable, -f.size, f.title))


class Executor:
    def __init__(self, ctx: Context):
        self.ctx = ctx

    def execute(self, finding: Finding, action: Action,
                on_line: Optional[Callable[[str], None]] = None) -> ActionResult:
        ctx = self.ctx
        emit = on_line or (lambda s: None)
        if action.needs_root and not ctx.is_root and not ctx.dry_run:
            return ActionResult(False, "", 0, "this action needs root; re-run without --no-sudo")
        for inp in action.inputs:
            if inp.key not in action.params:
                ok, err, val = inp.validate("")
                if ok:
                    action.params[inp.key] = val
                else:
                    return ActionResult(False, "", 0, f"missing parameter '{inp.key}': {err}")
        mountpoint = finding.mountpoint or "/"
        before = ctx.fs_free(mountpoint)
        ctx.log(f"ACTION {finding.id}:{action.id} start (params={action.params}, "
                f"dry_run={ctx.dry_run})")
        emit(f"== {finding.title} :: {action.title} ==")
        lines: list[str] = []
        ok = True
        result: Optional[ActionResult] = None

        def collect(s: str) -> None:
            lines.append(s)
            emit(s)

        ctx._sink = collect
        try:
            if action.func is not None:
                result = action.func(ctx, action)
                if result is None:
                    result = ActionResult(True, "")
                if result.output:
                    already = set(lines)
                    for ln in result.output.splitlines():
                        if ln in already:
                            continue
                        collect(ln)
                ok = result.ok
            else:
                for argv in action.rendered_commands():
                    rc = ctx.run_stream(argv, collect, mutating=True)
                    if rc != 0:
                        collect(f"[exit code {rc}]")
                        if not action.continue_on_error:
                            ok = False
                            break
        except Exception:
            tb = traceback.format_exc(limit=6)
            for ln in tb.splitlines():
                collect(ln)
            ok = False
        finally:
            ctx._sink = None
        ctx.refresh_mounts()
        after = ctx.fs_free(mountpoint)
        freed = 0 if ctx.dry_run else max(0, after - before)
        if result is not None and result.freed and freed == 0:
            freed = 0 if ctx.dry_run else result.freed
        with ctx._lock:
            ctx._du_cache.clear()
        msg = (result.message if result is not None and result.message else
               ("completed" if ok else "failed"))
        if ctx.dry_run:
            msg = "dry-run: nothing changed"
        out = ActionResult(ok, "\n".join(lines), freed, msg,
                           action.requires_reboot or bool(result and result.requires_reboot))
        ctx.log(f"ACTION {finding.id}:{action.id} end ok={ok} freed={human(freed)} msg={msg}")
        emit(f"-- {'OK' if ok else 'FAILED'}: {msg}; freed {human(freed)} on {mountpoint}")
        return out


# --------------------------------------------------------------------------------------
# Built-in procedures: Docker / containerd
# --------------------------------------------------------------------------------------

@register
class DockerProcedure(Procedure):
    id = "docker"
    title = "Docker engine data"
    category = CAT_CONTAINERS
    description = ("Images, containers, volumes, build cache and container logs under Docker's "
                   "data-root. Prune tiers, log truncation and rotation, moving the data-root "
                   "to another disk, or purging Docker data when the engine is unused.")

    DEFAULT_ROOT = "/var/lib/docker"
    DAEMON_JSON = "/etc/docker/daemon.json"
    LOG_THRESHOLD = 10 * MIB

    def applies(self, ctx: Context) -> bool:
        return (os.path.isdir(self.data_root(ctx)) or os.path.isdir(self.DEFAULT_ROOT)
                or ctx.which("dockerd") is not None or self.docker_bin(ctx) is not None)

    # -- helpers -----------------------------------------------------------------------
    def daemon_json(self, ctx: Context) -> dict:
        return read_json(self.DAEMON_JSON)

    def data_root(self, ctx: Context) -> str:
        return str(self.daemon_json(ctx).get("data-root") or self.DEFAULT_ROOT)

    def docker_bin(self, ctx: Context) -> Optional[str]:
        for cand in ("/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"):
            if os.access(cand, os.X_OK):
                return cand
        path = ctx.which("docker")
        if path and "/.local/bin/" in path:
            return None  # user wrapper scripts are not the engine CLI
        return path

    def daemon_reachable(self, ctx: Context, docker: Optional[str]) -> bool:
        if not docker:
            return False
        cp = ctx.run([docker, "info", "--format", "{{.ServerVersion}}"], timeout=25)
        return cp.returncode == 0 and bool(cp.stdout.strip())

    def container_logs(self, ctx: Context, root: str) -> list[tuple[int, str]]:
        return ctx.list_files(os.path.join(root, "containers"), "*-json.log",
                              min_size=1, max_depth=2)

    # -- scan --------------------------------------------------------------------------
    def scan(self, ctx: Context) -> list[Finding]:
        findings: list[Finding] = []
        root = self.data_root(ctx)
        docker = self.docker_bin(ctx)
        active = ctx.service_active("docker")
        enabled = ctx.service_enabled("docker")
        reachable = self.daemon_reachable(ctx, docker)
        readable = os.access(root, os.R_OK | os.X_OK) if os.path.isdir(root) else False
        size = ctx.du(root) if readable else 0
        details = [
            f"data-root: {root}" + (" (custom, from daemon.json)" if root != self.DEFAULT_ROOT else ""),
            f"docker.service: {'active' if active else 'inactive'}, "
            f"{'enabled' if enabled else 'disabled'} at boot",
            f"engine CLI: {docker or 'not found'}; daemon reachable: {'yes' if reachable else 'no'}",
        ]
        if os.path.isdir(root) and not readable:
            details.append("data-root is not readable without root: size unknown")
        else:
            details.append(f"data-root size on disk: {human(size)}")

        reclaim_known = 0
        df_rows: list[tuple[str, int, int, str]] = []
        if reachable and docker:
            cp = ctx.run([docker, "system", "df", "--format", "{{json .}}"], timeout=90)
            for line in cp.stdout.splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                total = parse_size(str(row.get("Size", "0")).split()[0], decimal=True)
                rec_txt = str(row.get("Reclaimable", "0")).split()[0]
                rec = parse_size(rec_txt, decimal=True)
                df_rows.append((row.get("Type", "?"), total, rec,
                                f"{row.get('TotalCount', '?')} total / {row.get('Active', '?')} active"))
                reclaim_known += rec
            for typ, total, rec, cnt in df_rows:
                details.append(f"{typ:<14} {cnt:<22} size {human(total):>8}  reclaimable {human(rec):>8}")

        logs = self.container_logs(ctx, root) if readable else []
        big_logs = [(s, p) for s, p in logs if s >= self.LOG_THRESHOLD]
        log_total = sum(s for s, _ in logs)
        if logs:
            details.append(f"container json logs: {len(logs)} files, {human(log_total)} "
                           f"({len(big_logs)} over {human(self.LOG_THRESHOLD)})")
        log_opts = self.daemon_json(ctx).get("log-opts") or {}
        if not log_opts.get("max-size"):
            details.append("no log rotation configured (daemon.json log-opts.max-size missing)")

        if size == 0 and not reachable and not os.path.isdir(root):
            return findings

        actions: list[Action] = []
        if docker and not reachable and ctx.unit_exists("docker.service"):
            actions.append(Action(
                "start-daemon", "Start the Docker daemon to measure and prune precisely",
                "Starts docker.service (and its socket) so 'docker system df' and prune commands "
                "become available. Nothing is deleted.", RISK_SAFE, 0,
                commands=[["systemctl", "start", "docker.socket", "docker.service"]],
                notes=["Rescan after starting to get exact reclaimable numbers."]))
        if reachable and docker:
            dangling = sum(r for t, _, r, _ in df_rows if t in ("Images",))
            build = sum(r for t, _, r, _ in df_rows if t.startswith("Build"))
            cont = sum(r for t, _, r, _ in df_rows if t.startswith("Containers"))
            vols = sum(r for t, _, r, _ in df_rows if t.startswith("Local Volumes"))
            actions.append(Action(
                "prune-safe", "docker system prune (stopped containers, dangling images, build cache)",
                "Removes stopped containers, networks not used by any container, dangling images "
                "and the build cache. Running containers and tagged images stay.", RISK_LOW,
                cont + build, commands=[[docker, "system", "prune", "-f"]], recommended=True))
            actions.append(Action(
                "prune-all-images", "docker system prune -a (also unused tagged images)",
                "Same as prune, plus every image not referenced by an existing container. Images "
                "will be re-downloaded or rebuilt on next use.", RISK_MEDIUM, dangling + cont + build,
                commands=[[docker, "system", "prune", "-a", "-f"]]))
            actions.append(Action(
                "prune-builder", "docker builder prune -a (BuildKit cache only)",
                "Drops the whole BuildKit cache; next builds run without layer cache.", RISK_LOW,
                build, commands=[[docker, "builder", "prune", "-a", "-f"]]))
            actions.append(Action(
                "prune-volumes", "docker volume prune -a (unused volumes; DATA LOSS)",
                "Deletes every volume not attached to a container, including named volumes with "
                "database data. Irreversible.", RISK_HIGH, vols,
                commands=[[docker, "volume", "prune", "-a", "-f"]],
                notes=["Check 'docker volume ls' first; back up anything you might need."]))
        if big_logs:
            act = Action(
                "truncate-logs", f"Truncate {len(big_logs)} large container log(s)",
                f"Empties json-file logs bigger than {human(self.LOG_THRESHOLD)} in place. "
                "Containers keep running; past log lines are lost.", RISK_LOW,
                sum(s for s, _ in big_logs), func=self._truncate_logs, recommended=True)
            act.params["_paths"] = [p for _, p in big_logs]
            act.params["_verb"] = "truncate"
            actions.append(act)
        if not log_opts.get("max-size"):
            actions.append(Action(
                "configure-log-rotation", "Configure json-file log rotation (20m x 3) in daemon.json",
                "Writes log-opts max-size=20m, max-file=3 to /etc/docker/daemon.json and restarts "
                "Docker if it is running. Applies to containers created afterwards.", RISK_LOW, 0,
                func=self._configure_log_rotation,
                notes=["Existing containers keep their old logging settings until recreated."]))
        if os.path.isdir(root) and (size > 0 or not readable):
            target_mount = ctx.biggest_non_os_mount(min_free=int(size * 1.2))
            default_target = (os.path.join(target_mount.target, "docker") if target_mount
                              else "/home/docker")
            if ctx.mount_for(root).on_os_disk:
                actions.append(Action(
                    "move-data-root", "Move Docker data-root to another disk",
                    "Stops Docker, copies the whole data-root with rsync to the target directory, "
                    "points daemon.json 'data-root' at it, restarts Docker and verifies. The old "
                    "tree is kept unless you choose to delete it.", RISK_MEDIUM, size,
                    func=self._move_data_root,
                    inputs=[Input("target", "Target directory for the new data-root",
                                  default_target, "path",
                                  help="Must be on a POSIX filesystem (ext4/xfs/btrfs) with enough space"),
                           Input("delete_old", "Delete the old data-root after a verified move?",
                                 "no", "yesno")],
                    notes=["Running containers are stopped during the move.",
                           "Snap-installed Docker cannot access arbitrary paths; use /home/... targets."]))
            if root != self.DEFAULT_ROOT and os.path.isdir(self.DEFAULT_ROOT):
                old_size = ctx.du(self.DEFAULT_ROOT)
                if old_size > MIN_REPORT and (reachable or not active):
                    actions.append(Action(
                        "remove-old-data-root", f"Delete the old {self.DEFAULT_ROOT} left from a move",
                        f"Docker now uses {root}. Removes the previous tree at {self.DEFAULT_ROOT}.",
                        RISK_MEDIUM, old_size, func=self._remove_old_root))
            if not active:
                actions.append(Action(
                    "purge-docker-data", "Purge all Docker data (engine is not running)",
                    "Disables docker.socket/docker.service/containerd and deletes the data-root and "
                    "/var/lib/containerd. All images, containers and volumes are gone. Docker "
                    "packages stay installed.", RISK_HIGH, size,
                    func=self._purge, notes=["Only do this if you do not use Docker on this machine."]))

        reclaimable = reclaim_known + sum(s for s, _ in big_logs)
        if not reachable:
            reclaimable = size  # unmeasured: everything could go via move/purge
        summary = (f"Docker data-root {root} holds {human(size)}" if readable or size
                   else f"Docker data-root {root}: size not readable")
        if reachable:
            summary += f"; {human(reclaim_known)} reclaimable by pruning"
        elif os.path.isdir(root):
            summary += "; daemon not running, exact reclaimable unknown"
        findings.append(Finding(
            "docker", "Docker engine data", CAT_CONTAINERS, size, reclaimable, root, summary,
            details, actions, informational=True))
        findings.extend(self._containerd(ctx, active))
        return findings

    def _containerd(self, ctx: Context, docker_active: bool) -> list[Finding]:
        cfg = read_text("/etc/containerd/config.toml")
        m = re.search(r'^\s*root\s*=\s*"([^"]+)"', cfg, re.M)
        root = m.group(1) if m else "/var/lib/containerd"
        if not os.path.isdir(root):
            return []
        readable = os.access(root, os.R_OK | os.X_OK)
        size = ctx.du(root) if readable else 0
        active = ctx.service_active("containerd")
        enabled = ctx.service_enabled("containerd")
        details = [f"root: {root}",
                   f"containerd.service: {'active' if active else 'inactive'}, "
                   f"{'enabled' if enabled else 'disabled'} at boot"]
        if not readable:
            details.append("not readable without root: size unknown")
        children = ctx.du_children(root)[:8]
        for sz, p in children:
            details.append(f"  {human(sz):>8}  {os.path.relpath(p, root)}")
        actions: list[Action] = []
        crictl = ctx.which("crictl")
        if active and crictl:
            actions.append(Action(
                "crictl-prune", "crictl rmi --prune (unused images in the k8s.io namespace)",
                "Removes container images not used by any running pod.", RISK_LOW, 0,
                commands=[[crictl, "rmi", "--prune"]]))
        if not active and not docker_active:
            actions.append(Action(
                "purge-containerd", "Delete containerd content store (service is not running)",
                f"Removes {root} entirely. Any images stored by containerd/nerdctl/k8s are lost.",
                RISK_HIGH, size, func=self._purge_containerd))
        if size < MIN_REPORT and not actions:
            return []
        return [Finding("containerd", "containerd content store", CAT_CONTAINERS, size, size if not active else 0,
                        root, f"{root} holds {human(size)} ({'active' if active else 'inactive'} service)",
                        details, actions, informational=True)]

    # -- action funcs ------------------------------------------------------------------
    def _truncate_logs(self, ctx: Context, action: Action) -> ActionResult:
        paths = action.params.get("_paths") or [p for _, p in self.container_logs(ctx, self.data_root(ctx))
                                               if _ >= self.LOG_THRESHOLD]
        ok_all, out, freed = True, [], 0
        for p in paths:
            ok, msg, sz = ctx.truncate_file(p)
            ok_all = ok_all and ok
            out.append(msg)
            freed += sz
        return ActionResult(ok_all, "\n".join(out), freed)

    def _write_daemon_json(self, ctx: Context, updates: dict) -> tuple[bool, str]:
        cfg = self.daemon_json(ctx)
        cfg.update(updates)
        return ctx.write_file(self.DAEMON_JSON, json.dumps(cfg, indent=2) + "\n")

    def _configure_log_rotation(self, ctx: Context, action: Action) -> ActionResult:
        cfg = self.daemon_json(ctx)
        opts = dict(cfg.get("log-opts") or {})
        opts.setdefault("max-size", "20m")
        opts.setdefault("max-file", "3")
        updates = {"log-opts": opts}
        if "log-driver" not in cfg:
            updates["log-driver"] = "json-file"
        ok, msg = self._write_daemon_json(ctx, updates)
        out = [msg]
        if ok and ctx.service_active("docker"):
            rc = ctx.run_stream(["systemctl", "restart", "docker.service"], mutating=True)
            out.append("docker restarted" if rc == 0 else f"docker restart failed (rc={rc})")
            ok = ok and rc == 0
        return ActionResult(ok, "\n".join(out))

    def _move_data_root(self, ctx: Context, action: Action) -> ActionResult:
        src = self.data_root(ctx)
        target = os.path.normpath(str(action.params.get("target") or ""))
        delete_old = str(action.params.get("delete_old", "no")) == "yes"
        out: list[str] = []
        if not target.startswith("/") or target in ("/",):
            return ActionResult(False, "", 0, "invalid target path")
        if os.path.realpath(target) == os.path.realpath(src):
            return ActionResult(False, "", 0, "target is the current data-root")
        if os.path.realpath(target).startswith(os.path.realpath(src) + "/"):
            return ActionResult(False, "", 0, "target must not be inside the current data-root")
        probe = target
        while not os.path.exists(probe) and probe != "/":
            probe = os.path.dirname(probe)
        tmount = ctx.mount_for(probe)
        if tmount.fstype in ("vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "msdos"):
            return ActionResult(False, "", 0, f"{tmount.target} is {tmount.fstype}; Docker needs a POSIX filesystem")
        if tmount.on_os_disk:
            out.append(f"note: {tmount.target} is on the OS disk ({ctx.os_disk}); moving there frees nothing")
        size = ctx.du(src)
        free = ctx.fs_free(probe)
        if free < size * 1.1 + GIB:
            return ActionResult(False, "\n".join(out), 0,
                                f"not enough space on {tmount.target}: need ~{human(size * 1.1)}, free {human(free)}")
        if os.path.isdir(target) and os.listdir(target):
            return ActionResult(False, "\n".join(out), 0, f"{target} exists and is not empty")
        out.append(f"moving {human(size)} from {src} to {target} on {tmount.target} ({human(free)} free)")

        rc = ctx.run_stream(["systemctl", "stop", "docker.socket", "docker.service"], mutating=True)
        if rc != 0:
            out.append("warning: stopping docker returned non-zero; continuing")
        if ctx.unit_exists("containerd.service"):
            ctx.run_stream(["systemctl", "stop", "containerd.service"], mutating=True)
        rc = ctx.run_stream(["mkdir", "-p", target], mutating=True)
        if rc != 0:
            self._restart_docker(ctx)
            return ActionResult(False, "\n".join(out), 0, "could not create target directory")
        rsync = ctx.which("rsync")
        if rsync:
            rc = ctx.run_stream([rsync, "-aHAXS", "--numeric-ids", "--info=progress2",
                                 src.rstrip("/") + "/", target.rstrip("/") + "/"], mutating=True)
        else:
            rc = ctx.run_stream(["cp", "-a", src.rstrip("/") + "/.", target.rstrip("/") + "/"], mutating=True)
        if rc != 0:
            out.append(f"copy failed (rc={rc}); restarting docker with the old data-root")
            self._restart_docker(ctx)
            return ActionResult(False, "\n".join(out), 0, "copy failed; nothing changed in daemon.json")
        ok, msg = self._write_daemon_json(ctx, {"data-root": target})
        out.append(msg)
        if not ok:
            self._restart_docker(ctx)
            return ActionResult(False, "\n".join(out), 0, "could not write daemon.json")
        self._restart_docker(ctx)
        docker = self.docker_bin(ctx)
        if ctx.dry_run:
            out.append("[dry-run] would verify 'docker info' reports the new root")
            return ActionResult(True, "\n".join(out), 0, "dry-run complete")
        cp = ctx.run([docker, "info", "--format", "{{.DockerRootDir}}"], timeout=60) if docker else None
        reported = cp.stdout.strip() if cp else ""
        if cp and cp.returncode == 0 and os.path.realpath(reported) == os.path.realpath(target):
            out.append(f"verified: Docker Root Dir = {reported}")
        else:
            out.append(f"WARNING: could not verify new root (docker info said {reported!r}). "
                       f"Old data kept at {src}.")
            return ActionResult(False, "\n".join(out), 0, "moved but verification failed; old data kept")
        freed = 0
        if delete_old:
            ok2, msg2, freed = ctx.remove_path(src)
            out.append(msg2)
        else:
            out.append(f"old data-root kept at {src}; use the 'remove-old-data-root' action to delete it")
        return ActionResult(True, "\n".join(out), freed, "data-root moved")

    def _restart_docker(self, ctx: Context) -> None:
        if ctx.unit_exists("containerd.service"):
            ctx.run_stream(["systemctl", "start", "containerd.service"], mutating=True)
        ctx.run_stream(["systemctl", "start", "docker.socket", "docker.service"], mutating=True)

    def _remove_old_root(self, ctx: Context, action: Action) -> ActionResult:
        root = self.data_root(ctx)
        if os.path.realpath(root) == os.path.realpath(self.DEFAULT_ROOT):
            return ActionResult(False, "", 0, "daemon.json still points at /var/lib/docker; refusing")
        ok, msg, freed = ctx.remove_path(self.DEFAULT_ROOT)
        return ActionResult(ok, msg, freed)

    def _purge(self, ctx: Context, action: Action) -> ActionResult:
        if ctx.service_active("docker"):
            return ActionResult(False, "", 0, "docker is running; stop it first or use prune actions")
        out = []
        units = [u for u in ("docker.socket", "docker.service", "containerd.service") if ctx.unit_exists(u)]
        if units:
            ctx.run_stream(["systemctl", "disable", "--now"] + units, mutating=True)
        freed = 0
        for p in (self.data_root(ctx), "/var/lib/containerd"):
            if os.path.isdir(p):
                ok, msg, sz = ctx.remove_path(p)
                out.append(msg)
                freed += sz
        return ActionResult(True, "\n".join(out), freed, "docker data purged")

    def _purge_containerd(self, ctx: Context, action: Action) -> ActionResult:
        if ctx.service_active("containerd") or ctx.service_active("docker"):
            return ActionResult(False, "", 0, "containerd or docker is running; refusing")
        cfg = read_text("/etc/containerd/config.toml")
        m = re.search(r'^\s*root\s*=\s*"([^"]+)"', cfg, re.M)
        root = m.group(1) if m else "/var/lib/containerd"
        ok, msg, freed = ctx.remove_path(root)
        return ActionResult(ok, msg, freed)


# --------------------------------------------------------------------------------------
# Built-in procedures: swap manager
# --------------------------------------------------------------------------------------

@register
class SwapProcedure(Procedure):
    id = "swap"
    title = "Swap & swappiness"
    category = CAT_SWAP
    description = ("Shows swap devices, swap file size and vm.swappiness; lets you retune "
                   "swappiness, resize or create the swap file, or disable swap.")

    SYSCTL_FILE = "/etc/sysctl.d/99-zz-disk-space-swap.conf"

    def applies(self, ctx: Context) -> bool:
        return os.path.exists("/proc/swaps")

    # -- helpers -----------------------------------------------------------------------
    @staticmethod
    def active_swaps() -> list[dict]:
        rows = []
        for line in read_text("/proc/swaps").splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 5:
                rows.append({"path": parts[0].replace("\\040", " "), "type": parts[1],
                             "size": safe_int(parts[2]) * KIB, "used": safe_int(parts[3]) * KIB,
                             "prio": safe_int(parts[4])})
        return rows

    @staticmethod
    def fstab_swaps() -> list[tuple[str, str]]:
        out = []
        for line in read_text("/etc/fstab").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = s.split()
            if len(parts) >= 3 and parts[2] == "swap":
                out.append((parts[0], line))
        return out

    @staticmethod
    def swappiness() -> int:
        return safe_int(read_text("/proc/sys/vm/swappiness").strip(), 60)

    @staticmethod
    def persistent_swappiness_sources() -> list[str]:
        hits = []
        files = sorted(glob.glob("/etc/sysctl.d/*.conf")) + ["/etc/sysctl.conf"]
        for f in files:
            for line in read_text(f).splitlines():
                if re.match(r"^\s*vm\.swappiness\s*=", line):
                    hits.append(f"{f}: {line.strip()}")
        return hits

    @staticmethod
    def hibernation_configured() -> bool:
        if "resume=" in read_text("/proc/cmdline"):
            return True
        for f in glob.glob("/etc/initramfs-tools/conf.d/*"):
            if "RESUME=" in read_text(f).upper() and "RESUME=NONE" not in read_text(f).upper():
                return True
        return False

    def swap_file_path(self) -> Optional[str]:
        for s in self.active_swaps():
            if s["type"] == "file":
                return s["path"]
        for src, _ in self.fstab_swaps():
            if src.startswith("/") and not src.startswith("/dev/"):
                return src
        return None

    # -- scan --------------------------------------------------------------------------
    def scan(self, ctx: Context) -> list[Finding]:
        mem = ctx.meminfo()
        ram = mem.get("MemTotal", 0)
        avail = mem.get("MemAvailable", 0)
        swaps = self.active_swaps()
        fstab = self.fstab_swaps()
        sw = self.swappiness()
        swap_total = sum(s["size"] for s in swaps)
        swap_used = sum(s["used"] for s in swaps)
        swap_file = self.swap_file_path()
        file_size = ctx.path_size(swap_file) if swap_file and os.path.exists(swap_file) else 0
        zram = sorted(glob.glob("/sys/block/zram*"))
        hib = self.hibernation_configured()

        details = [f"RAM: {human(ram)} total, {human(avail)} available now",
                   f"vm.swappiness = {sw} (kernel default 60; 10 favours keeping apps in RAM)"]
        if swaps:
            for s in swaps:
                details.append(f"swap {s['type']:<9} {s['path']:<28} {human(s['size']):>8} "
                               f"used {human(s['used']):>8} prio {s['prio']}")
        else:
            details.append("no active swap")
        for src, line in fstab:
            details.append(f"fstab: {line.strip()}")
        if swap_file:
            details.append(f"swap file on disk: {swap_file} = {human(file_size)} "
                           f"({ctx.mount_for(swap_file).target})")
        if zram:
            details.append("zram devices: " + ", ".join(os.path.basename(z) for z in zram))
        for src in self.persistent_swappiness_sources():
            details.append("persistent: " + src)
        if hib:
            details.append("hibernation appears configured: swap should stay >= RAM size")

        # recommendation text
        rec = []
        if swap_file and file_size and swap_used == 0 and ram >= 16 * GIB and not hib:
            if file_size >= 8 * GIB:
                rec.append(f"Swap is unused with {human(ram)} RAM: the {human(file_size)} file could shrink "
                           f"to 2-4G, or be disabled, to free space on {ctx.mount_for(swap_file).target}.")
        if sw >= 60 and ram >= 16 * GIB:
            rec.append("swappiness 60 is the server default; 10 is a common desktop value with plenty of RAM.")
        if not swaps and not zram:
            rec.append("No swap at all: a small swap file (2-4G) protects against OOM kills.")
        details.extend(rec)

        default_gib = 4 if ram >= 16 * GIB else max(2, int(round(ram / GIB)))
        actions: list[Action] = [Action(
            "set-swappiness", "Set vm.swappiness (now and persistently)",
            f"Applies sysctl vm.swappiness=<value> immediately and writes {self.SYSCTL_FILE}. "
            "Lower values keep application memory in RAM longer; 0-200 accepted.", RISK_SAFE, 0,
            func=self._set_swappiness,
            inputs=[Input("value", "swappiness value (0-200)", "10", "int", min=0, max=200)],
            recommended=(sw >= 60 and ram >= 16 * GIB))]
        default_path = swap_file or "/swap.img"
        if swap_file:
            actions.append(Action(
                "resize-swapfile", f"Resize swap file {swap_file}",
                "swapoff, recreate the file at the new size (fallocate or dd), mkswap, swapon, "
                "and keep /etc/fstab consistent. Needs enough free RAM to hold currently used swap.",
                RISK_MEDIUM, max(0, file_size - default_gib * GIB), func=self._resize_swapfile,
                inputs=[Input("size_gib", "New swap file size in GiB", str(default_gib), "int", min=1, max=1024),
                        Input("path", "Swap file path", default_path, "path")],
                notes=["Hibernation needs swap >= RAM." if hib else "Hibernation not configured."]))
            actions.append(Action(
                "disable-swap", f"Disable swap and delete {swap_file}",
                "swapoff, remove the fstab entry (backup kept) and delete the swap file. Frees its "
                "full size on disk. Without swap the kernel kills processes sooner under memory "
                "pressure and hibernation is impossible.", RISK_MEDIUM, file_size,
                func=self._disable_swap, inputs=[Input("path", "Swap file path", default_path, "path")]))
        if swaps:
            actions.append(Action(
                "swapoff-until-reboot", "Turn swap off until reboot (keep file and fstab)",
                "Runs swapoff -a. Nothing is deleted; swap returns at next boot.", RISK_LOW, 0,
                commands=[["swapoff", "-a"]]))
        elif fstab:
            actions.append(Action(
                "swapon", "Enable swap entries listed in /etc/fstab", "Runs swapon -a.", RISK_SAFE, 0,
                commands=[["swapon", "-a"]]))
        if not swap_file:
            actions.append(Action(
                "create-swapfile", "Create a swap file",
                "Creates, formats and activates a swap file and adds it to /etc/fstab.", RISK_LOW, 0,
                func=self._resize_swapfile,
                inputs=[Input("size_gib", "Swap file size in GiB", str(default_gib), "int", min=1, max=1024),
                        Input("path", "Swap file path", "/swap.img", "path")]))

        summary = (f"{human(swap_total)} swap ({human(swap_used)} used), swappiness {sw}"
                   if swaps else f"no active swap, swappiness {sw}")
        if swap_file:
            summary += f"; swap file {human(file_size)} on {ctx.mount_for(swap_file).target}"
        return [Finding("swap", "Swap & swappiness", CAT_SWAP, file_size, 0,
                        swap_file or "/", summary, details, actions, informational=True)]

    # -- action funcs ------------------------------------------------------------------
    def _set_swappiness(self, ctx: Context, action: Action) -> ActionResult:
        value = int(action.params.get("value", 10))
        out = []
        rc = ctx.run_stream(["sysctl", "-w", f"vm.swappiness={value}"], mutating=True)
        if rc != 0 and not ctx.dry_run:
            return ActionResult(False, "", 0, "sysctl failed")
        ok, msg = ctx.write_file(self.SYSCTL_FILE,
                                 f"# written by disk_space.py on {now_str()}\nvm.swappiness = {value}\n")
        out.append(msg)
        for src in self.persistent_swappiness_sources():
            if self.SYSCTL_FILE not in src:
                out.append(f"note: also set in {src} (our file sorts last and wins at boot)")
        return ActionResult(ok, "\n".join(out), 0, f"swappiness set to {value}")

    def _ensure_fstab(self, ctx: Context, path: str, present: bool) -> str:
        lines = read_text("/etc/fstab").splitlines()
        kept, found = [], False
        for line in lines:
            parts = line.split()
            if len(parts) >= 3 and parts[2] == "swap" and parts[0] == path:
                found = True
                if present:
                    kept.append(line)
                continue
            kept.append(line)
        if present and not found:
            kept.append(f"{path} none swap sw 0 0")
        if (present and found) or (not present and not found):
            return "fstab already consistent"
        ok, msg = ctx.write_file("/etc/fstab", "\n".join(kept) + "\n", backup=True)
        return msg

    def _resize_swapfile(self, ctx: Context, action: Action) -> ActionResult:
        gib = int(action.params.get("size_gib", 4))
        path = str(action.params.get("path") or self.swap_file_path() or "/swap.img")
        out: list[str] = []
        mount = ctx.mount_for(os.path.dirname(path) or "/")
        if mount.fstype == "zfs":
            return ActionResult(False, "", 0, "swap files are not supported on ZFS; use a zvol instead")
        mem = ctx.meminfo()
        used = sum(s["used"] for s in self.active_swaps() if s["path"] == path)
        if used and used > mem.get("MemAvailable", 0) * 0.8:
            return ActionResult(False, "", 0, f"{human(used)} of swap in use and not enough free RAM to absorb it")
        active = any(s["path"] == path for s in self.active_swaps())
        existing = ctx.path_size(path) if os.path.exists(path) else 0
        need = gib * GIB - existing
        if need > 0 and ctx.fs_free(os.path.dirname(path) or "/") < need + 512 * MIB:
            return ActionResult(False, "", 0, f"not enough free space on {mount.target} for a {gib}G swap file")
        if active:
            rc = ctx.run_stream(["swapoff", path], mutating=True)
            if rc != 0 and not ctx.dry_run:
                return ActionResult(False, "\n".join(out), 0, "swapoff failed")
        if os.path.exists(path):
            ok, msg, _ = ctx.remove_path(path)
            out.append(msg)
            if not ok:
                return ActionResult(False, "\n".join(out), 0, "could not remove old swap file")
        if mount.fstype == "btrfs":
            ctx.run_stream(["truncate", "-s", "0", path], mutating=True)
            ctx.run_stream(["chattr", "+C", path], mutating=True)
        rc = ctx.run_stream(["fallocate", "-l", f"{gib}G", path], mutating=True)
        if rc != 0:
            out.append("fallocate failed, falling back to dd (slower)")
            rc = ctx.run_stream(["dd", "if=/dev/zero", f"of={path}", "bs=1M", f"count={gib * 1024}",
                                 "status=progress"], mutating=True)
            if rc != 0:
                return ActionResult(False, "\n".join(out), 0, "could not allocate swap file")
        ctx.run_stream(["chmod", "600", path], mutating=True)
        rc = ctx.run_stream(["mkswap", path], mutating=True)
        if rc != 0 and not ctx.dry_run:
            return ActionResult(False, "\n".join(out), 0, "mkswap failed")
        rc = ctx.run_stream(["swapon", path], mutating=True)
        if rc != 0 and not ctx.dry_run:
            return ActionResult(False, "\n".join(out), 0, "swapon failed")
        out.append(self._ensure_fstab(ctx, path, present=True))
        freed = max(0, existing - gib * GIB)
        return ActionResult(True, "\n".join(out), freed, f"swap file is now {gib}G")

    def _disable_swap(self, ctx: Context, action: Action) -> ActionResult:
        path = str(action.params.get("path") or self.swap_file_path() or "")
        if not path:
            return ActionResult(False, "", 0, "no swap file found")
        out: list[str] = []
        mem = ctx.meminfo()
        used = sum(s["used"] for s in self.active_swaps())
        if used and used > mem.get("MemAvailable", 0) * 0.8:
            return ActionResult(False, "", 0, f"{human(used)} of swap in use; not enough free RAM to disable safely")
        if any(s["path"] == path for s in self.active_swaps()):
            rc = ctx.run_stream(["swapoff", path], mutating=True)
            if rc != 0 and not ctx.dry_run:
                return ActionResult(False, "", 0, "swapoff failed")
        out.append(self._ensure_fstab(ctx, path, present=False))
        size = ctx.path_size(path)
        if os.path.exists(path):
            ok, msg, freed = ctx.remove_path(path)
            out.append(msg)
            if not ok:
                return ActionResult(False, "\n".join(out), 0, "could not delete swap file")
        else:
            freed = 0
        if self.hibernation_configured():
            out.append("note: hibernation was configured; it will no longer work without swap")
        return ActionResult(True, "\n".join(out), freed, f"swap disabled, {human(size)} freed")


# --------------------------------------------------------------------------------------
# Shared helper base for declarative "measure these directories, offer to delete them" families
# --------------------------------------------------------------------------------------

class PathFamily(Procedure):
    """Declarative helper for cache-directory families.

    Subclasses (still decorated with @register) set SPECS to a list of dicts with keys:
      key          finding id suffix -> "<procedure-id>-<key>"; a lone spec uses the procedure id
      title        finding title
      description  what the data is and what deleting it costs (becomes the action description)
      user         $HOME-relative glob patterns, measured for every user home
      system       absolute glob patterns
      risk         RISK_* of the delete action (default RISK_SAFE)
      recommended  default: risk == RISK_SAFE
      keep_dir     delete the contents but keep the directory itself (default True)
      min_size     hide findings smaller than this (default MIN_REPORT)
      category     per-spec category override (default: the class category)
      tool         binary name; noted in the details as installed / not installed
      env          environment variable that can relocate the cache; noted in the details
      notes        extra warning lines shown on the confirmation screen
      informational  keep the finding even when tiny (default False)
    Symlinked directories are measured (and cleared) at their target. Subclasses may override
    `extra_actions(ctx, spec, paths, total)` to add tool-native actions, and `extra_details`.
    """
    SPECS: list = []

    # -- matching ----------------------------------------------------------------------
    @staticmethod
    def _add(found: list, seen: set, path: str, owner: str) -> None:
        if not os.path.lexists(path):
            return
        real = os.path.realpath(path) if os.path.islink(path) else path
        if not os.path.exists(real):
            return
        key = os.path.realpath(real)
        if key in seen:
            return
        seen.add(key)
        found.append((real, owner))

    def matches(self, ctx: Context, spec: dict) -> list[tuple[str, str]]:
        """[(path, owner)] of existing paths for one spec, deduplicated by real path."""
        found: list[tuple[str, str]] = []
        seen: set[str] = set()
        for user, home in ctx.user_homes():
            for pat in spec.get("user", ()):
                for p in sorted(glob.glob(os.path.join(str(home), pat))):
                    self._add(found, seen, p, user)
        for pat in spec.get("system", ()):
            for p in sorted(glob.glob(pat)):
                self._add(found, seen, p, "system")
        return found

    @staticmethod
    def _writable(path: str, keep_dir: bool) -> bool:
        target = path if keep_dir and os.path.isdir(path) else os.path.dirname(path.rstrip("/")) or "/"
        return os.access(target, os.W_OK)

    # -- hooks for subclasses ----------------------------------------------------------
    def extra_actions(self, ctx: Context, spec: dict, paths: list[str], total: int) -> list[Action]:
        return []

    def extra_details(self, ctx: Context, spec: dict, paths: list[str], total: int) -> list[str]:
        return []

    # -- procedure API -----------------------------------------------------------------
    def applies(self, ctx: Context) -> bool:
        return any(self.matches(ctx, spec) for spec in self.SPECS)

    def scan(self, ctx: Context) -> list[Finding]:
        findings: list[Finding] = []
        single = len(self.SPECS) == 1
        for spec in self.SPECS:
            matched = self.matches(ctx, spec)
            if not matched:
                continue
            sized = sorted(((ctx.du(p), p, owner) for p, owner in matched), reverse=True)
            total = sum(s for s, _, _ in sized)
            informational = bool(spec.get("informational"))
            if total < spec.get("min_size", MIN_REPORT) and not informational:
                continue
            paths = [p for _, p, _ in sized]
            risk = spec.get("risk", RISK_SAFE)
            keep_dir = bool(spec.get("keep_dir", True))
            details = [f"{human(s):>8}  {p}" + (f"  ({o})" if o != "system" else "") for s, p, o in sized]
            tool = spec.get("tool")
            if tool:
                where = ctx.which(tool)
                details.append(f"{tool}: {'installed at ' + where if where else 'not installed'}")
            env = spec.get("env")
            if env:
                details.append(f"{env} relocates this cache when set"
                               + (f" (currently {os.environ[env]})" if os.environ.get(env) else ""))
            details.extend(self.extra_details(ctx, spec, paths, total))
            n = len(paths)
            what = ("contents of " if keep_dir else "") + (f"{n} directories" if n > 1 else paths[0])
            action = Action(
                "clear", f"Delete {what} ({human(total)})", spec.get("description", ""), risk, total,
                func=self._clear, needs_root=not all(self._writable(p, keep_dir) for p in paths),
                recommended=bool(spec.get("recommended", risk == RISK_SAFE)),
                notes=list(spec.get("notes", ())), params={"_paths": paths, "_keep_dir": keep_dir})
            actions = [action] + list(self.extra_actions(ctx, spec, paths, total))
            fid = self.id if single else f"{self.id}-{spec['key']}"
            summary = spec.get("summary") or (f"{human(total)} in {n} location{'s' if n != 1 else ''}"
                                              + (f"; {spec['description']}" if spec.get("description") else ""))
            findings.append(Finding(fid, spec["title"], spec.get("category", self.category), total, total,
                                    sized[0][1], summary, details, actions, informational=informational))
        return findings

    def _clear(self, ctx: Context, action: Action) -> ActionResult:
        return ctx.remove_paths(list(action.params.get("_paths") or []),
                                keep_dir=bool(action.params.get("_keep_dir", True)))


# ==== BEGIN GENERATED PROCEDURES ====
# ==== END GENERATED PROCEDURES ====


# --------------------------------------------------------------------------------------
# Text / JSON reporting
# --------------------------------------------------------------------------------------

def render_report(ctx: Context, result: ScanResult) -> str:
    lines = []
    lines.append(f"disk_space {VERSION} on {ctx.hostname} ({ctx.distro_pretty}) "
                 f"{'[DRY RUN] ' if ctx.dry_run else ''}{'[no root: limited scan]' if not ctx.is_root else ''}")
    lines.append(f"OS disk: {ctx.os_disk or '?'}")
    lines.append("")
    lines.append(f"{'MOUNT':<28} {'DEVICE':<22} {'FS':<7} {'SIZE':>8} {'USED':>8} {'FREE':>8} {'USE%':>5}  OS")
    for m in ctx.mounts:
        lines.append(f"{m.target[:28]:<28} {os.path.basename(m.source)[:22]:<22} {m.fstype[:7]:<7} "
                     f"{human(m.total):>8} {human(m.used):>8} {human(m.free):>8} {m.use_pct:>4.0f}%  "
                     f"{'*' if m.on_os_disk else ''}")
    lines.append("")
    total_rec = sum(f.reclaimable for f in result.findings)
    os_rec = sum(f.reclaimable for f in result.findings if f.on_os_disk)
    lines.append(f"{len(result.findings)} findings; reclaimable {human(total_rec)} "
                 f"({human(os_rec)} on the OS disk)")
    lines.append("")
    lines.append(f"{'#':>3} {'RECLAIM':>8} {'SIZE':>8} {'RISK':<6} {'CATEGORY':<22} TITLE  [mount]")
    for i, f in enumerate(result.findings, 1):
        lines.append(f"{i:>3} {human(f.reclaimable):>8} {human(f.size):>8} {f.risk:<6} "
                     f"{f.category[:22]:<22} {f.title}  [{f.mountpoint}]{' *' if f.on_os_disk else ''}")
    lines.append("")
    for i, f in enumerate(result.findings, 1):
        lines.append(f"--- {i}. {f.title}  (id: {f.id}, {f.category}, {f.mountpoint})")
        lines.extend("    " + l for l in wrap(f.summary, 96))
        for d in f.details[:40]:
            lines.append("      " + d)
        if len(f.details) > 40:
            lines.append(f"      ... {len(f.details) - 40} more lines")
        for a in f.actions:
            flag = " (recommended)" if a.recommended else ""
            lines.append(f"    -> {f.id}:{a.id}  [{a.risk}] {a.title}{flag}"
                         + (f"  frees ~{human(a.reclaim)}" if a.reclaim else ""))
            for pl in a.preview_lines()[:6]:
                lines.append("         " + pl)
            for inp in a.inputs:
                lines.append(f"         needs --param {inp.key}=<{inp.kind}> ({inp.prompt}; default {inp.default!r})")
        lines.append("")
    if result.errors:
        lines.append("Scan errors:")
        for pid, err in result.errors:
            lines.append(f"  {pid}: {err.strip().splitlines()[-1]}")
    if ctx.warnings:
        lines.append("Warnings:")
        lines.extend("  " + w for w in ctx.warnings)
    lines.append(f"Log: {ctx.log_path}")
    return "\n".join(lines)


def render_json(ctx: Context, result: ScanResult) -> str:
    return json.dumps({
        "version": VERSION, "host": ctx.hostname, "distro": ctx.distro_pretty,
        "is_root": ctx.is_root, "dry_run": ctx.dry_run, "os_disk": ctx.os_disk,
        "mounts": [m.__dict__ for m in ctx.mounts],
        "findings": [f.to_dict() for f in result.findings],
        "errors": [{"procedure": p, "error": e} for p, e in result.errors],
        "skipped": result.skipped, "warnings": ctx.warnings, "duration": result.duration,
        "log": ctx.log_path,
    }, indent=2)


# --------------------------------------------------------------------------------------
# Disk map: adaptive surface scan of a whole filesystem into a size tree
# --------------------------------------------------------------------------------------
#
# 1. survey   fast scandir walk (directories only, one filesystem) listing every directory
#             and, for each path down to STAT_DEPTH, how many directories it holds and how
#             deep its subtree goes.
# 2. plan     one `du` job per subtree; big subtrees are split so jobs run in parallel, and
#             every job gets its own `-d N` from the depth its path really reaches (capped).
# 3. measure  `du -x -k -d N PATH` per job (GNU, BSD/macOS and BusyBox all accept it), output
#             streamed into the tree while it runs, so sizes appear surface after surface.
# 4. refine   nodes at the depth frontier (or with small children pruned) are deepened on
#             demand; files of a folder are listed when the folder is opened.
# The pure-python walker is the fallback engine (no du, du failure, or --engine walk).

F_FRONTIER = 1     # subfolders exist below the measured depth
F_FILES = 2        # files of this folder have been listed
F_MOUNT = 4        # another filesystem (or excluded) mounted here, not measured
F_ERROR = 8        # unreadable
F_PENDING = 16     # size not measured yet
F_SPLIT = 32       # size is the sum of its children (job planner node)
F_PRUNED = 64      # small subfolders were dropped to save memory
F_EXPANDED = 128   # deepened on demand already
F_DELETED = 256

STAT_DEPTH = 3     # survey keeps per-path statistics down to this depth


def mac_firmlinks() -> list[str]:
    """Data-volume relative paths that macOS shows at the root (/Users, /Applications, ...)."""
    out = []
    for line in read_text("/usr/share/firmlinks").splitlines():
        parts = line.split("\t")
        if len(parts) == 2:
            out.append(parts[1].strip().strip("/"))
    return sorted(out, key=len, reverse=True)


_FIRMLINKS: Optional[list[str]] = None


def display_path(path: str) -> str:
    """macOS: '/System/Volumes/Data/Users/x' -> '/Users/x' when reachable through a firmlink."""
    global _FIRMLINKS
    if not IS_MAC or not path.startswith(MAC_DATA + "/"):
        return path
    if _FIRMLINKS is None:
        _FIRMLINKS = mac_firmlinks()
    rel = path[len(MAC_DATA) + 1:]
    for fl in _FIRMLINKS:
        if rel == fl or rel.startswith(fl + "/"):
            return "/" + rel
    return path


def expand_user_path(ctx: "Context", path: str) -> str:
    """'~' means the invoking user's home even under sudo (where HOME may be /root)."""
    if path == "~" or path.startswith("~/"):
        return str(ctx.real_home) + path[1:]
    return os.path.expanduser(path)


def default_map_root() -> str:
    """macOS keeps all writable data on the Data volume; '/' is the sealed system snapshot."""
    if IS_MAC and os.path.isdir(MAC_DATA):
        return MAC_DATA
    return "/"


def clean_text(text: str) -> str:
    """Make a file name safe to print: no control characters, no undecodable surrogates."""
    text = str(text)
    if text.isprintable():
        try:
            text.encode("utf-8")
            return text
        except UnicodeEncodeError:
            pass
    out = []
    for ch in text:
        o = ord(ch)
        if o < 32 or o == 127 or 0xD800 <= o <= 0xDFFF:
            out.append("?")
        else:
            out.append(ch)
    return "".join(out)


def age_text(mtime: float) -> str:
    if not mtime:
        return ""
    d = (time.time() - mtime) / 86400.0
    if d < 1:
        return "today"
    if d < 60:
        return f"{d:.0f}d"
    if d < 730:
        return f"{d / 30.4:.0f}mo"
    return f"{d / 365.25:.0f}y"


class DNode:
    """One file or folder of the disk map. Sizes are allocated bytes (what du reports)."""
    __slots__ = ("name", "parent", "size", "is_dir", "children", "flags", "n_dirs", "n_files",
                 "max_depth", "mtime")

    def __init__(self, name: str, parent: Optional["DNode"], is_dir: bool = True, size: int = 0):
        self.name = name
        self.parent = parent
        self.size = size
        self.is_dir = is_dir
        self.children: Optional[dict[str, DNode]] = {} if is_dir else None
        self.flags = 0
        self.n_dirs = -1      # folders below (survey or tree); -1 unknown
        self.n_files = -1     # files below (survey); -1 unknown
        self.max_depth = -1   # levels below this node; -1 unknown
        self.mtime = 0.0

    @property
    def path(self) -> str:
        parts = []
        n: Optional[DNode] = self
        while n is not None and n.parent is not None:
            parts.append(n.name)
            n = n.parent
        base = n.name if n is not None else "/"
        if not parts:
            return base
        return os.path.join(base, *reversed(parts))

    @property
    def depth(self) -> int:
        d, n = 0, self.parent
        while n is not None:
            d += 1
            n = n.parent
        return d

    def child(self, name: str, is_dir: bool = True) -> "DNode":
        assert self.children is not None
        c = self.children.get(name)
        if c is None:
            c = DNode(name, self, is_dir)
            c.flags |= F_PENDING
            self.children[name] = c
        return c

    def kids(self) -> list["DNode"]:
        return list(self.children.values()) if self.children else []

    def needs_refine(self) -> bool:
        return self.is_dir and not (self.flags & (F_MOUNT | F_EXPANDED | F_DELETED)) and \
            bool(self.flags & (F_FRONTIER | F_PRUNED))

    def has(self, flag: int) -> bool:
        return bool(self.flags & flag)


@dataclass
class MapJob:
    path: str
    node: DNode
    depth: int           # depth of node below the map root
    levels: int          # -d N passed to du
    expected: int        # directories expected within N levels (survey), for progress
    max_rel: int = -1    # deepest level below path (survey), -1 unknown
    lines: int = 0
    state: str = "queued"   # queued / running / done / failed
    engine: str = ""


class DiskMap:
    """Adaptive surface scan of `root`. scan() runs in a worker thread; readers take `lock`
    (or tolerate slightly stale numbers) while it runs."""

    def __init__(self, ctx: Context, root: str, engine: str = "auto", depth_cap: int = 12,
                 one_fs: bool = True, workers: int = 0, survey: bool = True,
                 min_node: int = 256 * KIB):
        self.ctx = ctx
        self.root_path = os.path.abspath(expand_user_path(ctx, root)) if root else default_map_root()
        self.root = DNode(self.root_path, None, True)
        self.root.flags |= F_PENDING | F_SPLIT
        self.engine = engine
        self.depth_cap = max(1, depth_cap)
        self.one_fs = one_fs
        self.workers = workers or max(2, min(8, (os.cpu_count() or 4)))
        self.do_survey = survey
        self.min_node = max(0, min_node)
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.phase = "idle"          # idle survey plan measure done cancelled error
        self.message = ""
        self.current = ""
        self.survey_dirs = 0
        self.survey_files = 0
        self.survey_max_depth = 0
        self.expected = 0
        self.lines = 0
        self.errors: list[str] = []
        self.n_errors = 0
        self.jobs: list[MapJob] = []
        self.stats: dict[str, list] = {}   # path -> [dirs, files, max_abs_depth]
        self.started = 0.0
        self.finished = 0.0
        self.gen = 0                 # bumped on every structural change (caches key on it)
        self.du_bin = self._find_du()
        self.skip = self._skip_paths()
        self._skip_sorted = sorted(self.skip)
        self._hard_seen: set[tuple[int, int]] = set()
        try:
            self.root_dev = os.lstat(self.root_path).st_dev
        except OSError:
            self.root_dev = -1

    # -- setup -------------------------------------------------------------------------
    def _find_du(self) -> Optional[str]:
        if self.engine == "walk":
            return None
        du = self.ctx.which("du")
        if not du:
            return None
        try:
            cp = subprocess.run([du, "-x", "-k", "-d", "0", "--", "/dev/null"], capture_output=True,
                                text=True, timeout=10)
            ok = cp.returncode == 0 and cp.stdout.split("\t")[0].strip().isdigit()
        except Exception:
            ok = False
        return du if ok else None

    def _skip_paths(self) -> set[str]:
        """Mount points strictly below the root (same semantics as du -x), pseudo filesystems,
        and on macOS the Data volume when mapping '/' (it is reachable through firmlinks)."""
        root = self.root_path.rstrip("/") or "/"
        out: set[str] = set()
        pseudo = PSEUDO_FS | {"devfs", "autofs", "nullfs", "fdesc"}
        for target, fstype in self.ctx.all_mounts:
            cands = [target]
            if IS_MAC and target != "/" and not target.startswith("/System/"):
                cands.append(MAC_DATA + target)
            for t in cands:
                t = t.rstrip("/") or "/"
                if t == root or not t.startswith(root.rstrip("/") + "/"):
                    continue
                if self.one_fs or fstype in pseudo:
                    out.add(t)
        if IS_MAC and root == "/":
            out.add(MAC_DATA)
        if not IS_MAC and root == "/":
            out.update({"/proc", "/sys", "/dev", "/run"} if self.one_fs else {"/proc", "/sys"})
        return out

    def has_skip_below(self, path: str) -> bool:
        pre = path.rstrip("/") + "/"
        i = 0
        lo, hi = 0, len(self._skip_sorted)
        while lo < hi:
            mid = (lo + hi) // 2
            if self._skip_sorted[mid] < pre:
                lo = mid + 1
            else:
                hi = mid
        i = lo
        return i < len(self._skip_sorted) and self._skip_sorted[i].startswith(pre)

    def error(self, msg: str) -> None:
        with self.lock:
            self.n_errors += 1
            if len(self.errors) < 5000:
                self.errors.append(msg)

    # -- lookup ------------------------------------------------------------------------
    def node_for(self, path: str, create: bool = False) -> Optional[DNode]:
        path = os.path.abspath(path)
        root = self.root_path.rstrip("/")
        if path == self.root_path or path == root:
            return self.root
        if not path.startswith(root + "/"):
            return None
        node = self.root
        for comp in path[len(root) + 1:].split("/"):
            if not comp:
                continue
            nxt = node.children.get(comp) if node.children is not None else None
            if nxt is None:
                if not create or node.children is None:
                    return None
                nxt = node.child(comp, True)
            node = nxt
        return node

    # -- scan --------------------------------------------------------------------------
    def scan(self) -> None:
        self.started = time.time()
        self.ctx.log(f"MAP  scan {self.root_path} engine={'du' if self.du_bin else 'walk'} "
                     f"cap={self.depth_cap} one_fs={self.one_fs} workers={self.workers}")
        try:
            if not os.path.isdir(self.root_path):
                raise OSError(f"{self.root_path} is not a directory")
            if self.do_survey:
                self.phase = "survey"
                self._survey()
            if self.cancel.is_set():
                self.phase = "cancelled"
                return
            self.phase = "plan"
            self._plan()
            self.phase = "measure"
            self._measure()
            self._finalize()
            self.phase = "cancelled" if self.cancel.is_set() else "done"
        except Exception as exc:
            self.phase = "error"
            self.message = f"{exc}"
            self.ctx.log("MAP  error " + traceback.format_exc())
        finally:
            self.finished = time.time()
            with self.lock:
                self.gen += 1
            self.ctx.log(f"MAP  {self.phase} in {self.finished - self.started:.1f}s: "
                         f"{human(self.root.size)}, {self.survey_dirs} dirs surveyed, "
                         f"{self.lines} du lines, {self.n_errors} errors")

    def progress(self) -> float:
        if self.phase in ("done", "cancelled", "error"):
            return 1.0
        if self.phase == "measure":
            if self.expected > 0:
                return min(0.99, self.lines / self.expected)
            done = sum(1 for j in self.jobs if j.state in ("done", "failed"))
            return done / max(1, len(self.jobs))
        return 0.0

    # survey ----------------------------------------------------------------------------
    def _survey(self) -> None:
        tops = []
        try:
            with os.scandir(self.root_path) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False) and e.path not in self.skip:
                            tops.append(e.path)
                    except OSError:
                        pass
        except OSError as exc:
            self.error(f"{self.root_path}: {exc.strerror or exc}")
        with concurrent.futures.ThreadPoolExecutor(self.workers) as ex:
            for local in ex.map(self._survey_subtree, tops):
                with self.lock:
                    self.stats.update(local)
        self.expected = self._expected_within_cap
        self.ctx.log(f"MAP  survey: {self.survey_dirs} dirs, {self.survey_files} files, "
                     f"max depth {self.survey_max_depth}")

    _expected_within_cap = 0

    def _survey_subtree(self, top: str) -> dict[str, list]:
        local: dict[str, list] = {top: [0, 0, 1]}
        stack: list[tuple[str, int, tuple]] = [(top, 1, (top,))]
        skip = self.skip
        cap = self.depth_cap
        n_dirs = n_files = within = 0
        maxd = 1
        while stack:
            if self.cancel.is_set():
                break
            path, d, keys = stack.pop()
            n_dirs += 1
            if d <= cap:
                within += 1
            if d > maxd:
                maxd = d
            nf = 0
            try:
                with os.scandir(path) as it:
                    for e in it:
                        try:
                            isdir = e.is_dir(follow_symlinks=False)
                        except OSError:
                            isdir = False
                        if not isdir:
                            nf += 1
                            continue
                        p = e.path
                        if p in skip:
                            continue
                        if d + 1 <= STAT_DEPTH:
                            local[p] = [0, 0, d + 1]
                            stack.append((p, d + 1, keys + (p,)))
                        else:
                            stack.append((p, d + 1, keys))
            except OSError:
                pass
            n_files += nf
            for k in keys:
                st = local[k]
                st[0] += 1
                st[1] += nf
                if d > st[2]:
                    st[2] = d
            if n_dirs & 255 == 0:
                with self.lock:
                    self.survey_dirs += 256
                    self.current = path
        with self.lock:
            self.survey_dirs += n_dirs & 255
            self.survey_files += n_files
            self._expected_within_cap += within
            self.survey_max_depth = max(self.survey_max_depth, maxd)
        return local

    # plan ------------------------------------------------------------------------------
    def _levels_for(self, path: str, depth: int) -> tuple[int, int, int]:
        """(-d N for du, expected dir lines, max levels below path or -1)."""
        room = max(0, self.depth_cap - depth)
        st = self.stats.get(path)
        if st is None:
            return room, 0, -1
        max_rel = max(0, st[2] - depth)
        return min(room, max_rel), st[0], max_rel

    def _own_files(self, node: DNode, path: str) -> int:
        """Measure files directly inside a split folder (they belong to no job)."""
        total = 0
        try:
            st = os.lstat(path)
            total += st.st_blocks * 512
            node.mtime = st.st_mtime
        except OSError:
            pass
        nf = 0
        try:
            with os.scandir(path) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            continue
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    nf += 1
                    if st.st_nlink > 1 and not stat.S_ISDIR(st.st_mode):
                        key = (st.st_dev, st.st_ino)
                        if key in self._hard_seen:
                            continue
                        self._hard_seen.add(key)
                    total += st.st_blocks * 512
        except OSError as exc:
            node.flags |= F_ERROR
            self.error(f"{path}: {exc.strerror or exc}")
        return total

    def _plan(self) -> None:
        total = max(1, self.survey_dirs)
        jobs: list[MapJob] = []
        own: dict[int, int] = {}

        def plan(node: DNode, path: str, depth: int) -> None:
            node.flags |= F_SPLIT | F_PENDING
            own[id(node)] = self._own_files(node, path)
            try:
                entries = list(os.scandir(path))
            except OSError as exc:
                node.flags |= F_ERROR
                self.error(f"{path}: {exc.strerror or exc}")
                entries = []
            for e in entries:
                try:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                p = e.path
                with self.lock:
                    child = node.child(e.name, True)
                if p in self.skip:
                    child.flags = (child.flags | F_MOUNT) & ~F_PENDING
                    continue
                st = self.stats.get(p)
                big = st is not None and st[0] > max(total / 8, 2000) and depth + 1 < STAT_DEPTH
                if (self.has_skip_below(p) or big) and depth + 1 < self.depth_cap:
                    plan(child, p, depth + 1)
                    continue
                levels, expected, max_rel = self._levels_for(p, depth + 1)
                jobs.append(MapJob(p, child, depth + 1, levels, expected, max_rel))

        plan(self.root, self.root_path, 0)
        self._own = own
        jobs.sort(key=lambda j: -j.expected)
        self.jobs = jobs
        if not self.expected:
            self.expected = sum(j.expected for j in jobs)
        self.ctx.log(f"MAP  plan: {len(jobs)} jobs, depth cap {self.depth_cap}")
        with self.lock:
            self.gen += 1

    # measure ---------------------------------------------------------------------------
    def _measure(self) -> None:
        with concurrent.futures.ThreadPoolExecutor(self.workers) as ex:
            futs = [ex.submit(self._run_job, j) for j in self.jobs]
            for f in concurrent.futures.as_completed(futs):
                try:
                    f.result()
                except Exception:
                    self.ctx.log("MAP  job crashed " + traceback.format_exc())

    def _run_job(self, job: MapJob) -> None:
        if self.cancel.is_set():
            job.state = "failed"
            return
        job.state = "running"
        self.current = job.path
        ok = False
        if self.du_bin:
            ok = self._du_into(job.node, job.path, job.levels, job.max_rel, job)
            job.engine = "du"
        if not ok and not self.cancel.is_set():
            job.engine = "walk"
            self._walk_into(job.node, job.path, job.levels, job)
        job.state = "done"
        with self.lock:
            self._prune(job.node)
            self._rollup(job.node.parent)
            self.gen += 1

    def du_argv(self, path: str, levels: int) -> list[str]:
        return [self.du_bin or "du"] + (["-x"] if self.one_fs else []) + ["-k", "-d", str(levels), "--", path]

    def _du_into(self, node: DNode, path: str, levels: int, max_rel: int,
                 job: Optional[MapJob] = None) -> bool:
        """Run du -d levels on path and merge every line into the tree below node."""
        argv = self.du_argv(path, levels)
        try:
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    stdin=subprocess.DEVNULL)
        except OSError as exc:
            self.error(f"{path}: cannot run du: {exc}")
            return False
        err_lines: list[str] = []

        def read_err():
            assert proc.stderr is not None
            for raw in proc.stderr:
                err_lines.append(os.fsdecode(raw.rstrip(b"\n")))

        t = threading.Thread(target=read_err, daemon=True)
        t.start()
        prefix = path.rstrip("/") + "/"
        got_root = False
        batch: list[tuple[int, str]] = []
        assert proc.stdout is not None

        def flush():
            with self.lock:
                for size, p in batch:
                    if p == path or p.rstrip("/") == path.rstrip("/"):
                        n = node
                        rel = 0
                    elif p.startswith(prefix):
                        rest = p[len(prefix):]
                        comps = [c for c in rest.split("/") if c]
                        n = node
                        for c in comps:
                            n = n.child(c, True)
                        rel = len(comps)
                    else:
                        continue
                    n.size = size
                    n.flags &= ~F_PENDING
                    if rel == levels and (max_rel < 0 or max_rel > levels):
                        n.flags |= F_FRONTIER
                self.lines += len(batch)
                if job is not None:
                    job.lines += len(batch)
            batch.clear()

        for raw in proc.stdout:          # bytes: a '\r' inside a file name must not split lines
            if self.cancel.is_set():
                proc.kill()
                break
            line = os.fsdecode(raw.rstrip(b"\n"))
            tab = line.find("\t")
            if tab <= 0:
                continue
            try:
                size = int(line[:tab]) * 1024
            except ValueError:
                continue
            p = line[tab + 1:]
            if p.startswith("//"):
                p = p[1:]
            if p == path or p.rstrip("/") == path.rstrip("/"):
                got_root = True
            batch.append((size, p))
            if len(batch) >= 400:
                flush()
                self.current = p
        flush()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        t.join(timeout=5)
        for e in err_lines:
            if e.strip():
                self.error(e.strip())
                m = re.search(r"['‘`]?(/[^':‘’]+)['’]?: (Permission denied|Operation not permitted)", e)
                if m:
                    bad = self.node_for(m.group(1))
                    if bad is not None:
                        bad.flags |= F_ERROR
        if not got_root and not self.cancel.is_set():
            self.ctx.log(f"MAP  du gave no total for {path} (rc={proc.returncode}); falling back to walk")
            return False
        return True

    def _walk_into(self, node: DNode, path: str, levels: int, job: Optional[MapJob] = None) -> int:
        """Pure-python bottom-up size walk; keeps nodes down to `levels` below node."""
        try:
            dev = os.lstat(path).st_dev
        except OSError as exc:
            self.error(f"{path}: {exc.strerror or exc}")
            node.flags |= F_ERROR
            node.flags &= ~F_PENDING
            return 0
        seen: set[tuple[int, int]] = set()

        def walk(p: str, n: Optional[DNode], rel: int) -> int:
            if self.cancel.is_set():
                return 0
            try:
                total = os.lstat(p).st_blocks * 512
            except OSError:
                total = 0
            has_sub = False
            try:
                with os.scandir(p) as it:
                    entries = list(it)
            except OSError as exc:
                self.error(f"{p}: {exc.strerror or exc}")
                if n is not None:
                    n.flags |= F_ERROR
                entries = []
            for e in entries:
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    if e.path in self.skip or (self.one_fs and st.st_dev != dev):
                        if n is not None and rel < levels:
                            with self.lock:
                                c = n.child(e.name, True)
                                c.flags = (c.flags | F_MOUNT) & ~F_PENDING
                        continue
                    has_sub = True
                    cn = None
                    if n is not None and rel < levels:
                        with self.lock:
                            cn = n.child(e.name, True)
                    total += walk(e.path, cn, rel + 1)
                else:
                    if st.st_nlink > 1:
                        key = (st.st_dev, st.st_ino)
                        if key in seen:
                            continue
                        seen.add(key)
                    total += st.st_blocks * 512
            if n is not None:
                n.size = total
                n.flags &= ~F_PENDING
                if rel == levels and has_sub:
                    n.flags |= F_FRONTIER
                with self.lock:
                    self.lines += 1
                    if job is not None:
                        job.lines += 1
            return total

        try:
            return walk(path, node, 0)
        except RecursionError:
            self.error(f"{path}: folder tree too deep for the python walker")
            with self.lock:
                node.flags = (node.flags | F_ERROR) & ~F_PENDING
            return node.size

    # tree maintenance ------------------------------------------------------------------
    def _prune(self, node: DNode) -> None:
        """Drop subfolders smaller than min_node (their bytes stay in the parent's size)."""
        if not self.min_node:
            return
        stack = [node]
        while stack:
            n = stack.pop()
            if not n.children:
                continue
            drop = [k for k, c in n.children.items()
                    if c.is_dir and c.size < self.min_node and not (c.flags & (F_MOUNT | F_PENDING))]
            if drop:
                for k in drop:
                    del n.children[k]
                n.flags |= F_PRUNED
            stack.extend(c for c in n.children.values() if c.children)

    def _rollup(self, node: Optional[DNode]) -> None:
        """Recompute split (planner) folders from their children, up to the root."""
        own = getattr(self, "_own", {})
        while node is not None:
            if node.flags & F_SPLIT:
                kids = node.kids()
                node.size = own.get(id(node), 0) + sum(c.size for c in kids if c.is_dir)
                if all(not (c.flags & F_PENDING) for c in kids if c.is_dir):
                    node.flags &= ~F_PENDING
            node = node.parent

    def _finalize(self) -> None:
        with self.lock:
            self._rollup_all()
            self._count(self.root)
            for p, st in self.stats.items():
                n = self.node_for(p)
                if n is not None:
                    n.n_dirs, n.n_files = st[0] - 1, st[1]    # survey counts the folder itself
                    n.max_depth = max(0, st[2] - n.depth)
            if self.root.n_dirs < 0 or self.survey_dirs:
                self.root.n_dirs = self.survey_dirs or self.root.n_dirs
                self.root.n_files = self.survey_files or self.root.n_files
                if self.survey_max_depth:
                    self.root.max_depth = self.survey_max_depth
            self.gen += 1

    def _rollup_all(self) -> None:
        order: list[DNode] = []
        stack = [self.root]
        while stack:
            n = stack.pop()
            if n.flags & F_SPLIT:
                order.append(n)
                stack.extend(c for c in n.kids() if c.flags & F_SPLIT)
        own = getattr(self, "_own", {})
        for n in reversed(order):
            n.size = own.get(id(n), 0) + sum(c.size for c in n.kids() if c.is_dir)
            n.flags &= ~F_PENDING

    def _count(self, top: DNode) -> None:
        """Tree-based folder counts and depths (overridden by survey data where known)."""
        order: list[DNode] = []
        stack = [top]
        while stack:
            n = stack.pop()
            order.append(n)
            if n.children:
                stack.extend(c for c in n.children.values() if c.is_dir)
        for n in reversed(order):
            nd, md = 0, 0
            if n.children:
                for c in n.children.values():
                    if c.is_dir:
                        nd += 1 + max(0, c.n_dirs)
                        md = max(md, 1 + max(0, c.max_depth))
            n.n_dirs, n.max_depth = nd, md

    def adjust_size(self, node: DNode, delta: int) -> None:
        n: Optional[DNode] = node
        while n is not None:
            n.size = max(0, n.size + delta)
            n = n.parent

    # on-demand refinement --------------------------------------------------------------
    def refine(self, node: DNode, levels: int = 2) -> None:
        """Measure one more surface below node (du -d levels), keeping all its subfolders."""
        if not node.is_dir or node.flags & F_MOUNT:
            return
        path = node.path
        fresh = DNode(node.name, None, True)
        ok = False
        if self.du_bin:
            ok = self._du_into(fresh, path, levels, -1)
        if not ok:
            fresh = DNode(node.name, None, True)
            self._walk_into(fresh, path, levels)
        with self.lock:
            old = node.size
            self._graft(node, fresh)
            node.flags |= F_EXPANDED
            node.flags &= ~(F_PRUNED | F_PENDING | F_FRONTIER)
            self._count(node)
            if node.parent is not None and fresh.size != old:
                self.adjust_size(node.parent, fresh.size - old)
            self.gen += 1

    def _graft(self, node: DNode, fresh: DNode) -> None:
        if fresh.flags & F_FRONTIER and not fresh.children and node.children:
            node.size = fresh.size          # keep the deeper levels measured earlier
            return
        node.size = fresh.size
        node.flags = (node.flags & ~(F_ERROR | F_FRONTIER)) | (fresh.flags & (F_ERROR | F_FRONTIER))
        old_kids = node.children or {}
        new_kids: dict[str, DNode] = {}
        for name, fc in (fresh.children or {}).items():
            oc = old_kids.get(name)
            if oc is not None and oc.is_dir and fc.is_dir:
                self._graft(oc, fc)
                new_kids[name] = oc
            else:
                fc.parent = node
                new_kids[name] = fc
        for name, oc in old_kids.items():
            if not oc.is_dir and name not in new_kids:
                new_kids[name] = oc          # keep listed files
            elif oc.flags & F_MOUNT and name not in new_kids:
                new_kids[name] = oc
        node.children = new_kids

    def fill_pruned(self, node: DNode) -> None:
        """Bring back the small subfolders dropped by _prune (each one is < min_node)."""
        if not node.flags & F_PRUNED:
            return
        path = node.path
        try:
            with os.scandir(path) as it:
                dirs = [e for e in it if e.is_dir(follow_symlinks=False)]
        except OSError as exc:
            self.error(f"{path}: {exc.strerror or exc}")
            dirs = []
        fresh: list[DNode] = []
        for e in dirs:
            if (node.children and e.name in node.children) or e.path in self.skip:
                continue
            c = DNode(e.name, None, True)
            self._walk_into(c, e.path, 0)
            fresh.append(c)
        with self.lock:
            for c in fresh:
                if node.children is not None and c.name not in node.children:
                    c.parent = node
                    node.children[c.name] = c
            node.flags &= ~F_PRUNED
            self.gen += 1

    def load_files(self, node: DNode) -> None:
        """List the files directly inside node (and stat mtime of its subfolders)."""
        if not node.is_dir or node.flags & (F_FILES | F_MOUNT):
            return
        path = node.path
        try:
            with os.scandir(path) as it:
                entries = list(it)
        except OSError as exc:
            with self.lock:
                node.flags |= F_ERROR | F_FILES
            self.error(f"{path}: {exc.strerror or exc}")
            return
        with self.lock:
            for e in entries:
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    c = node.children.get(e.name) if node.children is not None else None
                    if c is not None:
                        c.mtime = st.st_mtime
                    continue
                f = node.child(e.name, False)
                f.size = st.st_blocks * 512
                f.mtime = st.st_mtime
                f.n_files = 1
                f.flags &= ~F_PENDING
            node.flags |= F_FILES
            self.gen += 1

    def remeasure(self, node: DNode) -> None:
        """Re-measure a node after a partial delete and push the difference upwards."""
        path = node.path
        if not os.path.lexists(path):
            self.detach(node)
            return
        if os.path.isdir(path) and not os.path.islink(path):
            fresh = DNode(node.name, None, True)
            if not (self.du_bin and self._du_into(fresh, path, 1, -1)):
                fresh = DNode(node.name, None, True)
                self._walk_into(fresh, path, 1)
            with self.lock:
                old = node.size
                self._graft(node, fresh)
                node.flags &= ~F_FILES
                node.children = {k: c for k, c in (node.children or {}).items() if c.is_dir}
                if node.parent is not None:
                    self.adjust_size(node.parent, node.size - old)
                self.gen += 1
        else:
            with self.lock:
                old = node.size
                node.size = Context.path_size(path)
                if node.parent is not None:
                    self.adjust_size(node.parent, node.size - old)
                self.gen += 1

    def detach(self, node: DNode) -> None:
        with self.lock:
            parent = node.parent
            if parent is None or parent.children is None:
                return
            if parent.children.get(node.name) is node:
                del parent.children[node.name]
                self.adjust_size(parent, -node.size)
            node.flags |= F_DELETED
            self.gen += 1

    def materialize(self, path: str) -> Optional[DNode]:
        """Tree node for path, bringing back pruned folders / listing files on the way."""
        path = os.path.abspath(path)
        root = self.root_path.rstrip("/")
        if path == self.root_path or path == root:
            return self.root
        if not path.startswith(root + "/"):
            return None
        node = self.root
        comps = [c for c in path[len(root) + 1:].split("/") if c]
        for i, comp in enumerate(comps):
            nxt = (node.children or {}).get(comp)
            if nxt is None and node.is_dir:
                if node.flags & F_FRONTIER and not node.flags & F_EXPANDED:
                    self.refine(node, 2)
                elif node.flags & F_PRUNED:
                    self.fill_pruned(node)
                nxt = (node.children or {}).get(comp)
                if nxt is None and i == len(comps) - 1:
                    self.load_files(node)
                    nxt = (node.children or {}).get(comp)
            if nxt is None:
                return None
            node = nxt
        return node

    # queries ---------------------------------------------------------------------------
    def at_depth(self, top: DNode, levels: int, exact: bool = False, limit: int = 0) -> list[DNode]:
        """Folders up to `levels` below top (or exactly at that depth), biggest first: the
        content of `du --max-depth=levels top | sort -rh`."""
        out: list[DNode] = []
        stack = [(top, 0)]
        with self.lock:
            while stack:
                n, d = stack.pop()
                if d and (not exact or d == levels):
                    out.append(n)
                if d < levels and n.children:
                    stack.extend((c, d + 1) for c in n.children.values() if c.is_dir)
        if not exact:
            out.append(top)
        if limit:
            return heapq.nlargest(limit, out, key=lambda n: n.size)
        out.sort(key=lambda n: -n.size)
        return out

    def all_dirs(self, top: DNode, limit: int = 2000) -> list[DNode]:
        out: list[DNode] = []
        stack = [top]
        with self.lock:
            while stack:
                n = stack.pop()
                out.append(n)
                if n.children:
                    stack.extend(c for c in n.children.values() if c.is_dir)
        return heapq.nlargest(limit, out, key=lambda n: n.size)

    def largest_files(self, top: DNode, limit: int = 300,
                      progress: Optional[Callable[[str], None]] = None) -> list[tuple[int, str, float]]:
        """Walk the real filesystem under top and keep the biggest files (bytes, path, mtime)."""
        heap: list[tuple[int, str, float]] = []
        root = top.path
        try:
            dev = os.lstat(root).st_dev
        except OSError:
            return []
        stack = [root]
        count = 0
        while stack:
            if self.cancel.is_set():
                break
            p = stack.pop()
            try:
                with os.scandir(p) as it:
                    entries = list(it)
            except OSError:
                continue
            count += 1
            if progress and count % 200 == 0:
                progress(p)
            for e in entries:
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    if e.path in self.skip or (self.one_fs and st.st_dev != dev):
                        continue
                    stack.append(e.path)
                elif stat.S_ISREG(st.st_mode):
                    item = (st.st_blocks * 512, e.path, st.st_mtime)
                    if len(heap) < limit:
                        heapq.heappush(heap, item)
                    elif item[0] > heap[0][0]:
                        heapq.heapreplace(heap, item)
        return sorted(heap, reverse=True)

    def to_dict(self, node: Optional[DNode] = None, max_depth: int = 64,
                min_size: int = 0) -> dict:
        node = node or self.root
        d: dict[str, Any] = {"name": node.name, "path": display_path(node.path), "size": node.size,
                             "dir": node.is_dir}
        if node.flags & F_MOUNT:
            d["mount"] = True
        if node.flags & F_FRONTIER:
            d["truncated"] = True
        if node.is_dir and max_depth > 0 and node.children:
            kids = sorted((c for c in node.children.values() if c.size >= min_size),
                          key=lambda c: -c.size)
            d["children"] = [self.to_dict(c, max_depth - 1, min_size) for c in kids]
        return d

    def summary(self) -> dict:
        return {"root": self.root_path, "display_root": display_path(self.root_path),
                "size": self.root.size, "phase": self.phase,
                "engine": "du" if self.du_bin else "python",
                "du_command": shlex.join(self.du_argv("PATH", 1)) if self.du_bin else "",
                "depth_cap": self.depth_cap, "one_fs": self.one_fs,
                "survey_dirs": self.survey_dirs, "survey_files": self.survey_files,
                "max_depth": self.survey_max_depth, "jobs": len(self.jobs),
                "errors": self.n_errors, "seconds": round((self.finished or time.time()) - self.started, 1),
                "skipped": sorted(self.skip)}


# -- path actions shared by the map TUI and the CLI -------------------------------------

MAC_PROTECTED = {
    "/System", "/Library", "/Applications", "/Users", "/private", "/private/var", "/private/etc",
    "/private/tmp", "/Volumes", "/cores", "/usr/local", "/opt", "/opt/homebrew", "/Library/Caches",
    MAC_DATA, MAC_DATA + "/Users", "/Users/Shared", "/var", "/etc", "/tmp",
    "/Library/Application Support", "/Library/Preferences",
}
LOW_RISK_PARTS = (
    "/.cache/", "/Library/Caches/", "/.Trash/", "/.local/share/Trash/", "/node_modules/",
    "/__pycache__/", "/.npm/_cacache/", "/.gradle/caches/", "/DerivedData/", "/.pytest_cache/",
    "/.mypy_cache/", "/.ruff_cache/", "/.tox/", "/Library/Logs/", "/.venv/", "/target/debug/",
)
LOW_RISK_PREFIXES = ("/var/tmp/", "/tmp/", "/private/tmp/", "/private/var/folders/", "/var/cache/",
                     "/var/crash/", "/private/var/tmp/")
SYSTEM_PREFIXES = (
    "/bin/", "/sbin/", "/usr/", "/lib/", "/lib32/", "/lib64/", "/libx32/", "/etc/", "/boot/",
    "/System/", "/Library/", "/Applications/", "/private/etc/", "/private/var/db/", "/var/lib/",
    "/opt/", "/snap/", "/var/db/",
)


def path_protected(ctx: Context, dmap: Optional[DiskMap], path: str) -> Optional[str]:
    """Reason the path must never be deleted from the map, or None."""
    p = os.path.abspath(path)
    shown = display_path(p)
    for cand in {p, shown}:
        if cand in PROTECTED_PATHS or cand in MAC_PROTECTED and IS_MAC:
            return "system folder"
        if cand.startswith(("/proc/", "/sys/", "/dev/")):
            return "kernel pseudo filesystem"
        if IS_MAC and cand.startswith("/System/") and not cand.startswith(MAC_DATA + "/"):
            return "sealed macOS system volume"
    if ctx.is_protected(p) or ctx.is_protected(shown):
        return "mount point, home folder or system folder"
    for _, home in ctx.user_homes():
        h = str(home)
        if shown == h or p == h:
            return "a user's home folder"
    if dmap is not None:
        r = dmap.root_path.rstrip("/") or "/"
        if p == r or r.startswith(p.rstrip("/") + "/"):
            return "the map root or one of its parents"
    if os.path.ismount(p):
        return "a mount point"
    pre = p.rstrip("/") + "/"
    shown_pre = shown.rstrip("/") + "/"
    mounts = [t for t, _ in ctx.all_mounts] + [m.target for m in ctx.mounts]
    if IS_MAC:
        mounts += [MAC_DATA + t for t in mounts if t != "/" and not t.startswith("/System/")]
    if any(t.startswith(pre) or t.startswith(shown_pre) for t in mounts) or \
            (dmap is not None and dmap.has_skip_below(p)):
        return "contains a mounted filesystem (deleting would reach into it)"
    homes = [str(h) for _, h in ctx.user_homes()] + [str(ctx.real_home)]
    if any(h.startswith(pre) or h.startswith(shown_pre) for h in homes):
        return "contains a user's home folder"
    return None


def path_risk(ctx: Context, path: str, size: int) -> tuple[str, str]:
    """(risk, reason) for deleting path."""
    shown = display_path(os.path.abspath(path))
    probe = shown + ("/" if not shown.endswith("/") else "")
    homes = [str(h) for _, h in ctx.user_homes()]
    in_home = any(shown.startswith(h.rstrip("/") + "/") for h in homes)
    if shown.startswith(SYSTEM_PREFIXES):
        return RISK_HIGH, "system location: deleting may break the OS or installed software"
    if probe.startswith(LOW_RISK_PREFIXES) or any(part in probe for part in LOW_RISK_PARTS):
        return RISK_LOW, "cache / temporary / rebuildable data"
    if shown.startswith(("/var/", "/private/var/")) and not in_home:
        return RISK_HIGH, "system location: deleting may break the OS or installed software"
    if in_home:
        if "/Library/" in shown and "/Library/Caches/" not in shown:
            return RISK_HIGH, "application data inside ~/Library"
        if size >= 50 * GIB:
            return RISK_HIGH, "very large user data"
        return RISK_MEDIUM, "user data: cannot be recovered after a permanent delete"
    return RISK_HIGH, "outside any home folder"


def trash_dir_for(ctx: Context, path: str) -> tuple[Optional[str], str]:
    """(trash folder on the same filesystem as path, reason when there is none)."""
    try:
        dev = os.lstat(path).st_dev
    except OSError as exc:
        return None, str(exc)
    home = str(ctx.real_home)
    if IS_MAC:
        cands = [os.path.join(home, ".Trash")]
    else:
        xdg = ctx.user_env.get("XDG_DATA_HOME") or ""
        if not (os.path.isabs(xdg) and os.path.realpath(xdg).startswith(home.rstrip("/") + "/")):
            xdg = os.path.join(home, ".local", "share")
        cands = [os.path.join(xdg, "Trash")]
    for c in cands:
        parent = c if os.path.isdir(c) else os.path.dirname(c)
        try:
            if os.stat(parent).st_dev == dev:
                return c, ""
        except OSError:
            continue
    top = ctx.mount_for(path).target
    if top not in ("/", MAC_DATA):
        try:
            if os.stat(top).st_dev == dev:
                name = os.path.join(".Trashes", str(ctx.real_uid)) if IS_MAC else f".Trash-{ctx.real_uid}"
                return os.path.join(top, name), ""
        except OSError:
            pass
    return None, "no Trash on the same filesystem (moving would copy the data)"


def make_dirs_owned(ctx: Context, path: str, mode: int = 0o700) -> None:
    """mkdir -p that gives every folder it creates to the invoking user when running as root."""
    missing = []
    p = path
    while p and not os.path.isdir(p):
        missing.append(p)
        p = os.path.dirname(p)
    for d in reversed(missing):
        os.mkdir(d, mode)
        if ctx.is_root:
            try:
                os.lchown(d, ctx.real_uid, pwd.getpwuid(ctx.real_uid).pw_gid)
            except (OSError, KeyError):
                pass


def move_to_trash(ctx: Context, path: str) -> tuple[bool, str]:
    trash, why = trash_dir_for(ctx, path)
    if not trash:
        return False, why
    name = os.path.basename(path.rstrip("/")) or "item"
    files_dir = trash if IS_MAC else os.path.join(trash, "files")
    info_dir = None if IS_MAC else os.path.join(trash, "info")
    if ctx.dry_run:
        return True, f"[dry-run] would move {path} to {files_dir}"
    try:
        for d in filter(None, (trash, files_dir, info_dir)):
            make_dirs_owned(ctx, d)
        target = os.path.join(files_dir, name)
        n = 1
        stem = name
        while os.path.lexists(target) or (info_dir and os.path.lexists(os.path.join(info_dir, os.path.basename(target) + ".trashinfo"))):
            n += 1
            stem = f"{name} {_dt.datetime.now().strftime('%H.%M.%S')}" + (f" {n}" if n > 2 else "")
            target = os.path.join(files_dir, stem)
        info_file = None
        if info_dir:
            from urllib.parse import quote
            info_file = os.path.join(info_dir, os.path.basename(target) + ".trashinfo")
            fd = os.open(info_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write("[Trash Info]\nPath=" + quote(os.fsencode(os.path.abspath(path))) + "\nDeletionDate=" +
                         _dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S") + "\n")
        try:
            os.rename(path, target)
        except OSError:
            if info_file:
                try:
                    os.unlink(info_file)
                except OSError:
                    pass
            raise
    except OSError as exc:
        ctx.log(f"TRASH {path} FAILED: {exc}")
        if IS_MAC and shutil.which("osascript"):
            # ~/.Trash is privacy-protected for terminals without Full Disk Access; Finder can
            # still do it (and keeps "Put Back").
            script = ('tell application "Finder" to delete (POSIX file "' +
                      path.replace("\\", "\\\\").replace('"', '\\"') + '")')
            if run_as_user(ctx, ["osascript", "-e", script], timeout=60) == 0 and not os.path.lexists(path):
                ctx.log(f"TRASH {path} via Finder")
                return True, "moved to Trash (Finder)"
        return False, f"{exc.strerror or exc}"
    ctx.log(f"TRASH {path} -> {target}")
    return True, f"moved to {target}"


_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)


def _rm_contents(fd: int, shown: str, dev: int, errors: list[str]) -> None:
    """Delete everything inside the open directory fd. All operations are relative to fd and
    never follow symlinks, so swapping a folder for a symlink mid-delete cannot redirect it."""
    with os.scandir(fd) as it:
        names = [e.name for e in it]
    for name in names:
        where = f"{shown}/{name}"
        try:
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISDIR(st.st_mode):
                os.unlink(name, dir_fd=fd)
                continue
            if st.st_dev != dev:
                errors.append(f"{where}: another filesystem is mounted here, left alone")
                continue
            cfd = os.open(name, _DIR_FLAGS, dir_fd=fd)
            try:
                cst = os.fstat(cfd)
                if (cst.st_dev, cst.st_ino) != (st.st_dev, st.st_ino):
                    errors.append(f"{where}: changed while deleting, left alone")
                    continue
                _rm_contents(cfd, where, dev, errors)
            finally:
                os.close(cfd)
            os.rmdir(name, dir_fd=fd)
        except OSError as exc:
            errors.append(f"{where}: {exc.strerror or exc}")


def rmtree_one_fs(path: str, errors: list[str]) -> None:
    """rm -rf --one-file-system, symlink-race safe (fd-relative, O_NOFOLLOW, identity checks)."""
    path = os.path.abspath(path)
    parent, base = os.path.split(path.rstrip("/"))
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise OSError(f"{path} is not a folder")
    pfd = os.open(parent or "/", _DIR_FLAGS)
    try:
        fd = os.open(base, _DIR_FLAGS, dir_fd=pfd)
        try:
            fst = os.fstat(fd)
            if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
                errors.append(f"{path}: changed while deleting, left alone")
                return
            try:
                _rm_contents(fd, path, st.st_dev, errors)
            except RecursionError:
                errors.append(f"{path}: folder tree too deep")
                return
        finally:
            os.close(fd)
        try:
            os.rmdir(base, dir_fd=pfd)
        except OSError as exc:
            errors.append(f"{path}: {exc.strerror or exc}")
    finally:
        os.close(pfd)


def delete_permanently(ctx: Context, path: str) -> tuple[bool, str]:
    if ctx.dry_run:
        return True, f"[dry-run] would delete {path}"
    errors: list[str] = []
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            rmtree_one_fs(path, errors)
        else:
            os.unlink(path)
    except OSError as exc:
        errors.append(f"{path}: {exc.strerror or exc}")
    if errors:
        ctx.log(f"DEL  {path} PARTIAL: {len(errors)} errors, first: {errors[0]}")
        return False, f"{len(errors)} item(s) could not be deleted, e.g. {errors[0]}"
    ctx.log(f"DEL  {path}")
    return True, "deleted"


def run_as_user(ctx: Context, argv: list[str], wait: bool = True, input_text: Optional[str] = None,
                cwd: Optional[str] = None, timeout: int = 10) -> int:
    """Run a desktop-session command (clipboard, file manager) as the invoking user."""
    env = dict(os.environ)
    env.update(ctx.user_env)
    if ctx.is_root and ctx.real_uid != 0 and shutil.which("sudo"):
        keep = [f"{k}={v}" for k, v in ctx.user_env.items()]
        argv = ["sudo", "-u", ctx.real_user, "-H", "env"] + keep + argv
    try:
        if not wait:
            subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, env=env, cwd=cwd, start_new_session=True)
            return 0
        data = input_text.encode("utf-8", "surrogateescape") if input_text is not None else None
        cp = subprocess.run(argv, input=data, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env=env, cwd=cwd, timeout=timeout)
        return cp.returncode
    except Exception:
        return 127


def copy_to_clipboard(ctx: Context, text: str) -> str:
    """Copy text with the platform tool; always also send OSC 52 (works over ssh too)."""
    used = ""
    tools: list[list[str]] = []
    if IS_MAC:
        tools.append(["pbcopy"])
    else:
        if ctx.user_env.get("WAYLAND_DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
            tools.append(["wl-copy"])
        if ctx.user_env.get("DISPLAY") or os.environ.get("DISPLAY"):
            tools += [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
    for argv in tools:
        if shutil.which(argv[0]) and run_as_user(ctx, argv, input_text=text) == 0:
            used = argv[0]
            break
    if used and not os.environ.get("SSH_TTY"):
        ctx.log(f"COPY {text!r} via {used}")
        return used
    try:
        import base64
        seq = "\033]52;c;" + base64.b64encode(text.encode("utf-8", "surrogateescape")).decode() + "\a"
        if os.environ.get("TMUX"):
            seq = "\033Ptmux;" + seq.replace("\033", "\033\033") + "\033\\"
        with open("/dev/tty", "w") as tty:
            tty.write(seq)
            tty.flush()
        used = used or "terminal (OSC 52)"
    except OSError:
        pass
    ctx.log(f"COPY {text!r} via {used or 'nothing'}")
    return used


def open_in_file_manager(ctx: Context, path: str) -> str:
    if IS_MAC:
        # folders open in Finder; files and bundles (Foo.app, x.pkg, ...) are only revealed
        plain_dir = os.path.isdir(path) and "." not in os.path.basename(path.rstrip("/"))
        argv = ["open", path] if plain_dir else ["open", "-R", path]
    else:
        target = path if os.path.isdir(path) else os.path.dirname(path)
        tool = next((t for t in ("xdg-open", "gio", "nautilus", "dolphin", "thunar", "nemo")
                     if shutil.which(t)), None)
        if not tool:
            return "no file manager found (xdg-open)"
        argv = [tool, "open", target] if tool == "gio" else [tool, target]
        if not (ctx.user_env.get("DISPLAY") or ctx.user_env.get("WAYLAND_DISPLAY") or
                os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            return "no graphical session (DISPLAY/WAYLAND_DISPLAY unset)"
    run_as_user(ctx, argv, wait=False)
    return "opened with " + argv[0]


def export_map(ctx: Context, dmap: DiskMap, node: Optional[DNode] = None) -> list[str]:
    node = node or dmap.root
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = os.path.join(str(ctx.real_home), f"disk_space_map-{stamp}")
    out = []
    with dmap.lock:
        data = {"summary": dmap.summary(), "tree": dmap.to_dict(node, 64, MIB)}
        rows = []
        stack = [node]
        while stack:
            n = stack.pop()
            rows.append((n.path, n.size, n.depth, n.is_dir))
            if n.children:
                stack.extend(n.children.values())
    rows.sort(key=lambda r: -r[1])

    def create(name: str):
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
        if ctx.is_root:
            try:
                os.fchown(fd, ctx.real_uid, pwd.getpwuid(ctx.real_uid).pw_gid)
            except (OSError, KeyError):
                pass
        return fd

    with open(create(base + ".json"), "w", encoding="utf-8", errors="surrogateescape") as fh:
        json.dump(data, fh, indent=1)
    out.append(base + ".json")
    import csv
    with open(create(base + ".csv"), "w", newline="", encoding="utf-8", errors="surrogateescape") as fh:
        w = csv.writer(fh)
        w.writerow(["path", "bytes", "human", "depth", "type"])
        for p, sz, d, isdir in rows:
            w.writerow([display_path(p), sz, human(sz), d, "dir" if isdir else "file"])
    out.append(base + ".csv")
    ctx.log("EXPORT " + ", ".join(out))
    return out


# -- text renderers for the CLI ---------------------------------------------------------

def run_map_cli(ctx: Context, dmap: DiskMap, quiet: bool = False) -> None:
    t = threading.Thread(target=dmap.scan, daemon=True)
    t.start()
    tty = sys.stderr.isatty() and not quiet
    while t.is_alive():
        t.join(0.5)
        if tty:
            if dmap.phase == "survey":
                msg = f"survey: {dmap.survey_dirs:,} folders listed"
            else:
                msg = (f"{dmap.phase}: {dmap.progress() * 100:5.1f}%  {human(dmap.root.size):>8}  "
                       f"jobs {sum(1 for j in dmap.jobs if j.state == 'done')}/{len(dmap.jobs)}")
            sys.stderr.write("\r\033[K" + msg[:120])
            sys.stderr.flush()
    if tty:
        sys.stderr.write("\r\033[K")
    if dmap.phase == "error":
        raise SystemExit(f"map failed: {dmap.message}")


def render_tree(dmap: DiskMap, depth: int = 3, top: int = 10, min_size: int = 0) -> str:
    lines = [f"{display_path(dmap.root_path)}  {human(dmap.root.size)}  "
             f"({dmap.survey_dirs:,} folders, max depth {dmap.survey_max_depth}, "
             f"{dmap.n_errors} unreadable, {dmap.summary()['seconds']}s)"]
    total = max(1, dmap.root.size)

    def rec(n: DNode, prefix: str, d: int) -> None:
        if d >= depth or not n.children:
            return
        kids = sorted((c for c in n.children.values() if c.is_dir and c.size >= min_size),
                      key=lambda c: -c.size)
        shown = kids[:top]
        rest = kids[top:]
        for i, c in enumerate(shown):
            last = i == len(shown) - 1 and not rest
            mark = "@" if c.has(F_MOUNT) else ("+" if c.needs_refine() else "")
            lines.append(f"{prefix}{'`-- ' if last else '|-- '}{human(c.size):>8} "
                         f"{100.0 * c.size / total:5.1f}%  {clean_text(c.name)}{mark}")
            rec(c, prefix + ("    " if last else "|   "), d + 1)
        if rest:
            lines.append(f"{prefix}`-- {human(sum(c.size for c in rest)):>8}        "
                         f"({len(rest)} more folders)")

    rec(dmap.root, "", 0)
    lines.append("")
    lines.append("@ = other filesystem (not measured)   + = more inside not listed here "
                 "(small folders, or deeper than --depth-cap)")
    return "\n".join(lines)


def render_levels(dmap: DiskMap, max_level: int = 10, top: int = 20) -> str:
    root = display_path(dmap.root_path)
    lines = []
    deepest = max(1, min(max_level, dmap.survey_max_depth or max_level, dmap.depth_cap))
    for n in range(1, deepest + 1):
        lines.append(f"== du -xh --max-depth={n} {root} 2>/dev/null | sort -rh | head -{top}")
        for node in dmap.at_depth(dmap.root, n, exact=False, limit=top):
            lines.append(f"{human(node.size):>8}\t{display_path(node.path)}")
        lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# Themes: semantic color roles on xterm-256 indexes, with 8-color and mono fallbacks
# --------------------------------------------------------------------------------------
#
# The categorical slots (chart identities) are the reference data-viz palette snapped to
# the xterm-256 cube and re-validated per surface (lightness band, chroma floor, CVD and
# normal-vision separation of adjacent slots, contrast): dark on #1c1c1c (234), light on
# #eeeeee (255). Order matters - it is what keeps neighbours apart for color-blind eyes.
# Slots are handed out in this fixed order and a 9th identity folds into "other" gray.
# Status colors (good / warning / serious / critical) are reserved for risk and fill
# levels and always come with a text label.

THEMES: dict[str, dict[str, Any]] = {
    "dark": dict(
        surface=234, alt=235, bar=236, raised=238, border=239, track=237,
        ink=255, ink2=250, muted=245, accent=39, sel_bg=24, sel_ink=231, mark=203,
        good=34, warning=214, serious=173, critical=160,
        cat=[32, 166, 29, 136, 168, 28, 104, 167], other=242),
    "light": dict(
        surface=255, alt=254, bar=252, raised=250, border=248, track=252,
        ink=234, ink2=238, muted=243, accent=25, sel_bg=25, sel_ink=231, mark=160,
        good=28, warning=136, serious=166, critical=160,
        cat=[32, 166, 29, 136, 168, 28, 98, 167], other=247),
    # the dark palette on the terminal's own background (transparent)
    "terminal": dict(
        surface=-1, alt=-1, bar=236, raised=238, border=239, track=237,
        ink=-1, ink2=250, muted=245, accent=39, sel_bg=24, sel_ink=231, mark=203,
        good=34, warning=214, serious=173, critical=160,
        cat=[32, 166, 29, 136, 168, 28, 104, 167], other=242),
}
_B, _R, _G, _Y, _U, _M, _C, _W = 0, 1, 2, 3, 4, 5, 6, 7   # curses basic colors
BASIC_THEMES: dict[str, dict[str, Any]] = {
    "dark": dict(
        surface=-1, alt=-1, bar=_U, raised=_B, border=_W, track=_B,
        ink=_W, ink2=_W, muted=_W, accent=_C, sel_bg=_U, sel_ink=_W, mark=_R,
        good=_G, warning=_Y, serious=_M, critical=_R,
        cat=[_U, _Y, _C, _M, _G, _R], other=_W),
    "light": dict(
        surface=_W, alt=_W, bar=_U, raised=_W, border=_B, track=_W,
        ink=_B, ink2=_B, muted=_B, accent=_U, sel_bg=_U, sel_ink=_W, mark=_R,
        good=_G, warning=_Y, serious=_M, critical=_R,
        cat=[_U, _Y, _C, _M, _G, _R], other=_B),
}
THEME_NAMES = ["dark", "light", "terminal", "mono"]


def xterm_rgb(idx: int) -> tuple[int, int, int]:
    if idx < 0:
        return (28, 28, 28)
    if idx < 16:
        base = [(0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205),
                (0, 205, 205), (229, 229, 229), (127, 127, 127), (255, 0, 0), (0, 255, 0),
                (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]
        return base[idx]
    if idx < 232:
        i = idx - 16
        lv = [0, 95, 135, 175, 215, 255]
        return (lv[i // 36], lv[i // 6 % 6], lv[i % 6])
    v = 8 + 10 * (idx - 232)
    return (v, v, v)


def luminance(idx: int) -> float:
    def lin(c: int) -> float:
        c2 = c / 255.0
        return c2 / 12.92 if c2 <= 0.04045 else ((c2 + 0.055) / 1.055) ** 2.4
    r, g, b = xterm_rgb(idx)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


class Theme:
    """Semantic attributes. Roles: surface alt bar raised border track ink ink2 muted accent
    sel_bg sel_ink mark good warning serious critical; categorical slots via cat()."""

    def __init__(self, name: str = "dark"):
        self.name = name if name in THEME_NAMES else "dark"
        self.colored = False
        self.c: dict[str, Any] = {}
        self.pairs: dict[tuple[int, int], int] = {}
        self.next_pair = 1
        self.max_pairs = 0
        self.basic = False

    def setup(self, scr) -> None:
        self.pairs.clear()
        self.next_pair = 1
        self.colored = curses.has_colors() and self.name != "mono"
        default_ok = False
        if curses.has_colors():
            try:
                curses.start_color()
            except curses.error:
                pass
            try:
                curses.use_default_colors()
                default_ok = True
            except curses.error:
                default_ok = False
        if not self.colored:
            self.c = dict(BASIC_THEMES["dark"])
            try:
                scr.bkgd(" ", 0)
            except curses.error:
                pass
            return
        self.max_pairs = min(curses.COLOR_PAIRS, 32767) - 1
        self.basic = curses.COLORS < 256
        table = BASIC_THEMES if self.basic else THEMES
        self.c = dict(table.get(self.name, table["dark"]))
        if not default_ok:
            for k, v in self.c.items():
                if v == -1:
                    self.c[k] = _B if k in ("surface", "alt") else _W
        try:
            scr.bkgd(" ", self.pair(self.c["ink"], self.c["surface"]))
        except curses.error:
            pass

    # -- primitives --------------------------------------------------------------------
    def color(self, role: Any) -> int:
        return self.c.get(role, -1) if isinstance(role, str) else int(role)

    def pair(self, fg: int, bg: int) -> int:
        if not self.colored:
            return 0
        key = (fg, bg)
        attr = self.pairs.get(key)
        if attr is not None:
            return attr
        if self.next_pair >= self.max_pairs:
            return 0
        try:
            curses.init_pair(self.next_pair, fg, bg)
            attr = curses.color_pair(self.next_pair)
        except (curses.error, ValueError, OverflowError):
            attr = 0
        self.next_pair += 1
        self.pairs[key] = attr
        return attr

    def text(self, role: Any = "ink", bg: Any = "surface", bold: bool = False) -> int:
        """Foreground role on a background role."""
        if not self.colored:
            a = curses.A_BOLD if bold else 0
            if role == "muted" or role == "border":
                a |= curses.A_DIM
            if role in ("accent", "critical", "mark") or bg in ("bar", "sel_bg"):
                a |= curses.A_BOLD
            if bg in ("sel_bg",):
                a |= curses.A_REVERSE
            return a
        fg = self.color(role)
        if self.basic and bg in ("bar", "raised", "sel_bg") and role in ("ink", "ink2", "muted"):
            fg = self.ink_on(self.color(bg))     # 8 colors: keep text readable on filled bars
        a = self.pair(fg, self.color(bg))
        if bold:
            a |= curses.A_BOLD
        if self.basic and role in ("muted", "border"):
            a |= curses.A_DIM
        return a

    def ink_on(self, bg_color: int) -> int:
        """Readable ink color for text on a colored fill."""
        if self.basic:
            return _B if bg_color in (_Y, _C, _G, _W) else _W
        return 16 if luminance(bg_color) > 0.22 else 231

    def badge(self, role: Any, bold: bool = True) -> int:
        if not self.colored:
            return curses.A_REVERSE | (curses.A_BOLD if bold else 0)
        bg = self.color(role)
        a = self.pair(self.ink_on(bg), bg)
        return a | (curses.A_BOLD if bold else 0)

    def sel(self) -> int:
        if not self.colored:
            return curses.A_REVERSE | curses.A_BOLD
        return self.pair(self.c["sel_ink"], self.c["sel_bg"]) | curses.A_BOLD

    def cat_color(self, i: int) -> int:
        cats = self.c.get("cat", [])
        return cats[i] if 0 <= i < len(cats) else self.c.get("other", _W)

    @property
    def n_cats(self) -> int:
        return len(self.c.get("cat", [])) if self.colored else 8

    def cat(self, i: int, bg: Any = "surface", bold: bool = False) -> int:
        if not self.colored:
            return curses.A_BOLD if (bold or i >= 0) else curses.A_DIM
        a = self.pair(self.cat_color(i), self.color(bg))
        return a | (curses.A_BOLD if bold else 0)

    def fill(self, color: int) -> int:
        """Solid block of a palette color (space with that background)."""
        if not self.colored:
            return curses.A_REVERSE
        return self.pair(self.ink_on(color), color)

    def level(self, pct: float) -> str:
        """Status role for a fill level (disk usage)."""
        return "critical" if pct >= 90 else ("warning" if pct >= 75 else "good")

    def risk(self, risk: str) -> str:
        return {RISK_SAFE: "good", RISK_LOW: "warning", RISK_MEDIUM: "serious",
                RISK_HIGH: "critical"}.get(risk, "muted")


GLYPHS_U = dict(tl="╭", tr="╮", bl="╰", br="╯", h="─", v="│", vthumb="┃", sep="›", dot="·",
                mark="●", swatch="■", check="☑", uncheck="☐", ok="✓", diamond="◆", home="⌂",
                tri="▸", up="▲", down="▼", ell="…", track="░", lblock="▌", ublock="▀", dblock="▄",
                full="█", rule="─", spin="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
GLYPHS_A = dict(tl="+", tr="+", bl="+", br="+", h="-", v="|", vthumb="#", sep=">", dot=".",
                mark="*", swatch="#", check="[x]", uncheck="[ ]", ok="+", diamond="*", home="~",
                tri=">", up="^", down="v", ell="~", track=".", lblock="#", ublock="#", dblock="#",
                full="#", rule="-", spin="|/-\\")


def glyph(name: str) -> str:
    return (GLYPHS_U if UNICODE_OK else GLYPHS_A)[name]


def load_ui_config(ctx: "Context") -> dict:
    return read_json(os.path.join(str(ctx.real_home), ".config", "disk_space", "config.json")) or {}


_CONFIG_WRITER = r"""
import os, sys, tempfile
d = os.path.join(os.path.expanduser("~"), ".config", "disk_space")
os.makedirs(d, mode=0o755, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=d, prefix=".config.", suffix=".tmp")
with os.fdopen(fd, "w") as fh:
    fh.write(sys.stdin.read())
os.replace(tmp, os.path.join(d, "config.json"))
"""


def save_ui_config(ctx: "Context", data: dict) -> None:
    """Persist UI settings in the invoking user's ~/.config/disk_space/config.json.
    Under sudo the file is written by a helper running as that user, so root never writes
    into a user-controlled folder (no symlink tricks); otherwise an exclusive temp file
    with a random name is renamed into place."""
    text = json.dumps(data, indent=1)
    if ctx.is_root and ctx.real_uid != 0:
        rc = run_as_user(ctx, [sys.executable, "-c", _CONFIG_WRITER], input_text=text, timeout=15)
        if rc != 0:
            ctx.log(f"config save as {ctx.real_user} failed (rc={rc})")
        return
    d = os.path.join(str(ctx.real_home), ".config", "disk_space")
    try:
        os.makedirs(d, mode=0o755, exist_ok=True)
        import tempfile
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".config.", suffix=".tmp")
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, os.path.join(d, "config.json"))
    except OSError as exc:
        ctx.log(f"config save failed: {exc}")


def squarify(sizes: list[float], x: float, y: float, w: float, h: float) -> list[tuple[float, float, float, float]]:
    """Squarified treemap layout (Bruls et al.): sizes sorted big->small, returns one
    (x, y, w, h) per size in the same order, filling the rectangle."""
    total = float(sum(sizes))
    if total <= 0 or w <= 0 or h <= 0:
        return [(x, y, 0.0, 0.0) for _ in sizes]
    scale = (w * h) / total
    areas = [s * scale for s in sizes]
    out: list[tuple[float, float, float, float]] = []

    def worst(row: list[float], side: float) -> float:
        s = sum(row)
        if s <= 0 or side <= 0:
            return float("inf")
        return max(max(side * side * a / (s * s), (s * s) / (side * side * a)) for a in row if a > 0) \
            if any(a > 0 for a in row) else float("inf")

    i = 0
    while i < len(areas):
        side = min(w, h)
        row = [areas[i]]
        j = i + 1
        while j < len(areas) and worst(row + [areas[j]], side) <= worst(row, side):
            row.append(areas[j])
            j += 1
        s = sum(row)
        if w >= h:                      # lay the row out as a column on the left
            cw = s / h if h else 0.0
            yy = y
            for a in row:
                ch = a / cw if cw else 0.0
                out.append((x, yy, cw, ch))
                yy += ch
            x += cw
            w -= cw
        else:                           # lay the row out along the top
            ch = s / w if w else 0.0
            xx = x
            for a in row:
                cw = a / ch if ch else 0.0
                out.append((xx, y, cw, ch))
                xx += cw
            y += ch
            h -= ch
        i = j
    return out


# --------------------------------------------------------------------------------------
# Curses TUI
# --------------------------------------------------------------------------------------

class TUI:
    MIN_H, MIN_W = 12, 60
    SORT_KEYS = ["reclaimable", "size", "risk", "category"]

    def __init__(self, ctx: Context, scanner: Scanner, executor: Executor):
        self.ctx = ctx
        self.scanner = scanner
        self.executor = executor
        self.findings: list[Finding] = []
        self.result: Optional[ScanResult] = None
        self.cursor = 0
        self.top = 0
        self.sort_key = "reclaimable"
        self.os_only = False
        self.status = ""
        self.colors: dict[str, int] = {}
        self.done_actions: set[tuple[str, str]] = set()
        self.session_freed = 0
        self.root_children: Optional[list[tuple[int, str]]] = None
        self.map_ui: Optional[MapUI] = None
        self.map_opts: dict[str, Any] = {}
        self.scr = None
        self.theme = Theme(load_ui_config(ctx).get("theme", "dark"))

    def open_map(self, scr, root: Optional[str] = None) -> None:
        if self.map_ui is None:
            self.map_ui = MapUI(self, root, **self.map_opts)
        elif root:
            self.map_ui.start(root)
        self.map_ui.run(scr)
        self.status = "back from the disk map (m reopens it, the scan is kept)"

    def run_map_only(self, root: Optional[str] = None) -> None:
        def main(scr):
            self.scr = scr
            curses.curs_set(0)
            scr.keypad(True)
            self._init_colors()
            self.map_ui = MapUI(self, root, standalone=True, **self.map_opts)
            self.map_ui.run(scr)
        curses.wrapper(main)

    # -- entry -------------------------------------------------------------------------
    def run(self) -> None:
        curses.wrapper(self._main)

    def _init_colors(self) -> None:
        if self.scr is not None:
            self.theme.setup(self.scr)
        t = self.theme
        self.colors = {
            "header": t.text("ink", "bar", bold=True),
            "safe": t.text("good"), "low": t.text("warning"), "medium": t.text("serious"),
            "high": t.text("critical", bold=True), "dim": t.text("muted"), "sel": t.sel(),
            "bar": t.badge("good"), "title": t.text("accent", bold=True),
            "ink2": t.text("ink2"), "border": t.text("border"), "accent": t.text("accent"),
        }

    def set_theme(self, name: str) -> None:
        self.theme = Theme(name)
        self._init_colors()
        cfg = load_ui_config(self.ctx)
        cfg["theme"] = self.theme.name
        save_ui_config(self.ctx, cfg)
        if self.map_ui is not None:
            self.map_ui.theme_changed()
        self.status = f"theme: {self.theme.name}  (t cycles: {', '.join(THEME_NAMES)})"

    def cycle_theme(self) -> None:
        i = THEME_NAMES.index(self.theme.name) if self.theme.name in THEME_NAMES else 0
        self.set_theme(THEME_NAMES[(i + 1) % len(THEME_NAMES)])

    def risk_attr(self, risk: str) -> int:
        return self.theme.text(self.theme.risk(risk), bold=risk == RISK_HIGH)

    # -- drawing helpers ---------------------------------------------------------------
    @staticmethod
    def put(scr, y: int, x: int, text: str, attr: int = 0) -> None:
        h, w = scr.getmaxyx()
        if y < 0 or y >= h or x >= w:
            return
        text = str(text)
        if x < 0:
            text = text[-x:]
            x = 0
        text = text[: max(0, w - x - (1 if y == h - 1 else 0))]
        if not text:
            return
        if UNICODE_OK:
            text = clean_text(text)
        else:
            text = text.encode("ascii", "replace").decode("ascii")
        try:
            scr.addstr(y, x, text, attr)
        except (curses.error, UnicodeEncodeError, ValueError):
            pass

    def hline(self, scr, y: int, text: str, attr: int) -> None:
        h, w = scr.getmaxyx()
        self.put(scr, y, 0, (text + " " * w)[: w - 1], attr)

    def fillrow(self, scr, y: int, x: int, width: int, attr: int) -> None:
        if width > 0:
            self.put(scr, y, x, " " * width, attr)

    def badge(self, scr, y: int, x: int, text: str, role: Any) -> int:
        """' TEXT ' on a colored pill; returns its width."""
        label = f" {text} "
        self.put(scr, y, x, label, self.theme.badge(role))
        return len(label)

    def gauge(self, scr, y: int, x: int, width: int, frac: float, color: Any,
              bg: Any = "surface") -> None:
        """Horizontal gauge: colored fill on a track, eighth-block resolution."""
        t = self.theme
        if width <= 0:
            return
        frac = max(0.0, min(1.0, frac))
        col = t.color(color)
        if not t.colored:
            n = int(round(frac * width))
            self.put(scr, y, x, glyph("full") * n + glyph("track") * (width - n), curses.A_BOLD)
            return
        track = t.color("track")
        if UNICODE_OK:
            eighths = int(round(frac * width * 8))
            full, part = divmod(eighths, 8)
            full = min(full, width)
            self.put(scr, y, x, "█" * full, t.pair(col, track))
            if part and full < width:
                self.put(scr, y, x + full, BLOCKS[part], t.pair(col, track))
                full += 1
            self.put(scr, y, x + full, " " * (width - full), t.pair(col, track))
        else:
            n = int(round(frac * width))
            self.put(scr, y, x, " " * n, t.pair(t.ink_on(col), col))
            self.put(scr, y, x + n, " " * (width - n), t.pair(col, track))

    def box(self, scr, y: int, x: int, h: int, w: int, title: str = "", right: str = "",
            focus: bool = False) -> tuple[int, int, int, int]:
        """Rounded panel with a title; returns the inner (y, x, h, w)."""
        if h < 2 or w < 4:
            return y, x, max(0, h), max(0, w)
        t = self.theme
        battr = t.text("accent" if focus else "border")
        g = glyph
        self.put(scr, y, x, g("tl") + g("h") * (w - 2) + g("tr"), battr)
        for yy in range(y + 1, y + h - 1):
            self.put(scr, yy, x, g("v"), battr)
            self.put(scr, yy, x + w - 1, g("v"), battr)
        self.put(scr, y + h - 1, x, g("bl") + g("h") * (w - 2) + g("br"), battr)
        if title:
            self.put(scr, y, x + 2, f" {title} "[: max(0, w - 6)], t.text("ink", bold=True))
        if right:
            r = f" {right} "
            if len(r) < w - len(title) - 8:
                self.put(scr, y, x + w - 2 - len(r), r, t.text("muted"))
        return y + 1, x + 1, h - 2, w - 2

    def scrollbar(self, scr, y: int, x: int, h: int, top: int, rows: int, total: int) -> None:
        if total <= rows or h < 2:
            return
        t = self.theme
        thumb = max(1, int(round(h * rows / total)))
        pos = int(round((h - thumb) * top / max(1, total - rows)))
        for i in range(h):
            on = pos <= i < pos + thumb
            self.put(scr, y + i, x, glyph("vthumb") if on else glyph("v"),
                     t.text("accent" if on else "border"))

    def spinner(self, tick: int) -> str:
        s = glyph("spin")
        return s[tick % len(s)]

    def section(self, scr, y: int, x: int, w: int, title: str) -> None:
        t = self.theme
        self.put(scr, y, x, title, t.text("accent", bold=True))
        rest = w - len(title) - 1
        if rest > 0:
            self.put(scr, y, x + len(title) + 1, glyph("rule") * rest, t.text("border"))

    def too_small(self, scr) -> bool:
        h, w = scr.getmaxyx()
        if h < self.MIN_H or w < self.MIN_W:
            scr.erase()
            self.put(scr, 0, 0, f"Terminal too small ({w}x{h}); need at least {self.MIN_W}x{self.MIN_H}. q quits.")
            scr.refresh()
            return True
        return False

    def header(self, scr, title: str) -> int:
        h, w = scr.getmaxyx()
        t = self.theme
        # row 0: app bar
        self.fillrow(scr, 0, 0, w, t.text("ink2", "bar"))
        x = self.badge(scr, 0, 0, f"{glyph('diamond')} disk_space {VERSION}", "accent")
        info = f" {self.ctx.hostname} {glyph('dot')} {self.ctx.distro_pretty} {glyph('dot')} OS disk {self.ctx.os_disk or '?'}"
        self.put(scr, 0, x, info, t.text("ink2", "bar"))
        pills = []
        if self.ctx.dry_run:
            pills.append(("DRY RUN", "warning"))
        pills.append(("ROOT", "good") if self.ctx.is_root else ("NO ROOT", "serious"))
        pills.append((f"theme {t.name}", "raised"))
        rx = w - 1
        for label, role in reversed(pills):
            rx -= len(label) + 3
            if rx <= x + len(info):
                break
            self.badge(scr, 0, rx, label, role)
        # row 1: usage gauge of the root filesystem
        rm = self.ctx.root_mount
        pct = rm.use_pct
        role = t.level(pct)
        self.put(scr, 1, 1, f"{rm.target} ", t.text("ink", bold=True))
        gx = 2 + len(rm.target) + 1
        gw = max(10, min(36, w // 4))
        self.gauge(scr, 1, gx, gw, pct / 100.0 if rm.total else 0, role)
        self.put(scr, 1, gx + gw + 1, f"{pct:3.0f}%", t.text(role, bold=True))
        self.put(scr, 1, gx + gw + 6, f"{human(rm.used)} used {glyph('dot')} {human(rm.free)} free "
                                      f"{glyph('dot')} {human(rm.total)} total", t.text("ink2"))
        # row 2: screen title
        self.put(scr, 2, 0, glyph("lblock"), t.text("accent", bold=True))
        self.put(scr, 2, 2, title[: w - 4], t.text("accent", bold=True))
        rest = w - 4 - len(title)
        if rest > 1:
            self.put(scr, 2, 3 + len(title), glyph("rule") * (rest - 1), t.text("border"))
        return 3

    def footer(self, scr, text: str, plain: bool = False) -> None:
        h, w = scr.getmaxyx()
        t = self.theme
        self.fillrow(scr, h - 2, 0, w, t.text("ink2", "alt"))
        if self.status:
            self.put(scr, h - 2, 1, f"{glyph('tri')} {self.status}"[: w - 2], t.text("ink2", "alt"))
        self.fillrow(scr, h - 1, 0, w - 1, t.text("muted", "bar"))
        if plain:
            self.put(scr, h - 1, 1, text[: w - 2], t.text("ink2", "bar"))
            return
        x = 1
        for item in re.split(r"\s{2,}", text.strip()):
            key, _, label = item.partition(" ")
            need = len(key) + 2 + len(label) + 2
            if x + need >= w - 2:
                self.put(scr, h - 1, max(1, w - 3), glyph("ell"), t.text("muted", "bar"))
                break
            self.put(scr, h - 1, x, f" {key} ", t.text("accent", "raised", bold=True))
            x += len(key) + 2
            if label:
                self.put(scr, h - 1, x, f" {label} ", t.text("ink2", "bar"))
                x += len(label) + 2
            x += 1

    def render_rich(self, scr, y: int, x: int, line: str, width: int, bg: Any = "surface") -> None:
        """Tiny markup for help/info text: '## Title' sections, 'key::text' key rows,
        '!! text' warnings, '-- text' muted notes."""
        t = self.theme
        if line.startswith("## "):
            self.section(scr, y, x, width, line[3:])
        elif line.startswith("!! "):
            self.put(scr, y, x, line[3:][:width], t.text("critical", bg, bold=True))
        elif line.startswith("-- "):
            self.put(scr, y, x, line[3:][:width], t.text("muted", bg))
        elif "::" in line:
            key, _, rest = line.partition("::")
            self.put(scr, y, x, key[:width], t.text("accent", bg, bold=True))
            self.put(scr, y, x + len(key), rest[: max(0, width - len(key))], t.text("ink2", bg))
        else:
            self.put(scr, y, x, line[:width], t.text("ink", bg))

    # -- main loop ---------------------------------------------------------------------
    def _main(self, scr) -> None:
        self.scr = scr
        curses.curs_set(0)
        scr.keypad(True)
        self._init_colors()
        self.scan_screen(scr)
        while True:
            if self.too_small(scr):
                k = scr.getch()
                if k in (ord("q"), 27):
                    return
                continue
            self.draw_list(scr)
            k = scr.getch()
            if k in (ord("q"), 27):
                if self.confirm_quit(scr):
                    return
            elif k in (curses.KEY_DOWN, ord("j")):
                self.cursor = min(self.cursor + 1, max(0, len(self.visible()) - 1))
            elif k in (curses.KEY_UP, ord("k")):
                self.cursor = max(0, self.cursor - 1)
            elif k == curses.KEY_NPAGE:
                self.cursor = min(self.cursor + 10, max(0, len(self.visible()) - 1))
            elif k == curses.KEY_PPAGE:
                self.cursor = max(0, self.cursor - 10)
            elif k in (curses.KEY_HOME, ord("g")):
                self.cursor = 0
            elif k in (curses.KEY_END, ord("G")):
                self.cursor = max(0, len(self.visible()) - 1)
            elif k in (curses.KEY_ENTER, 10, 13, ord("l"), curses.KEY_RIGHT):
                vis = self.visible()
                if vis:
                    self.detail_screen(scr, vis[self.cursor])
            elif k == ord("r"):
                self.scan_screen(scr)
            elif k == ord("s"):
                self.open_swap(scr)
            elif k == ord("f"):
                self.filesystems_screen(scr)
            elif k == ord("m"):
                self.open_map(scr)
            elif k == ord("t"):
                self.cycle_theme()
            elif k == ord("d"):
                self.ctx.dry_run = not self.ctx.dry_run
                self.status = f"dry-run {'ON: nothing will be changed' if self.ctx.dry_run else 'OFF: actions will run for real'}"
            elif k == ord("o"):
                self.os_only = not self.os_only
                self.cursor = 0
            elif k == ord("S"):
                i = self.SORT_KEYS.index(self.sort_key)
                self.sort_key = self.SORT_KEYS[(i + 1) % len(self.SORT_KEYS)]
                self.findings = sort_findings(self.findings, self.sort_key)
                self.cursor = 0
            elif k == ord("a"):
                self.apply_all_safe(scr)
            elif k == ord("L"):
                self.log_screen(scr)
            elif k == ord("e"):
                self.errors_screen(scr)
            elif k in (ord("?"), ord("h"), curses.KEY_F1):
                self.help_screen(scr)
            elif k == curses.KEY_RESIZE:
                pass

    def visible(self) -> list[Finding]:
        if self.os_only:
            return [f for f in self.findings if f.on_os_disk]
        return self.findings

    def confirm_quit(self, scr) -> bool:
        return True

    # -- scan screen -------------------------------------------------------------------
    def scan_screen(self, scr) -> None:
        progress = {"done": 0, "total": 0, "current": "starting", "finished": False}
        lock = threading.Lock()
        holder: dict[str, Any] = {}

        def cb(done, total, current):
            with lock:
                progress.update(done=done, total=total, current=current)

        def work():
            try:
                holder["result"] = self.scanner.scan(cb)
            except Exception:
                holder["error"] = traceback.format_exc()
            finally:
                with lock:
                    progress["finished"] = True

        th = threading.Thread(target=work, daemon=True)
        th.start()
        scr.timeout(100)
        tick = 0
        started = time.time()
        while True:
            with lock:
                p = dict(progress)
            scr.erase()
            if not self.too_small(scr):
                t = self.theme
                y = self.header(scr, "Scanning for reclaimable disk space")
                h, w = scr.getmaxyx()
                bw = min(72, w - 6)
                bx = max(1, (w - bw) // 2)
                by = max(y + 1, (h - 9) // 2)
                iy, ix, ih, iw = self.box(scr, by, bx, 8, bw, "Cleanup scan", f"{time.time() - started:.0f}s",
                                          focus=True)
                total = max(1, p["total"])
                self.put(scr, iy + 1, ix + 2, f"{self.spinner(tick)}  {p['done']}/{p['total']} procedures",
                         t.text("ink", bold=True))
                self.gauge(scr, iy + 2, ix + 2, iw - 4, p["done"] / total, "accent")
                self.put(scr, iy + 3, ix + 2, f"last: {p['current']}"[: iw - 4], t.text("ink2"))
                self.put(scr, iy + 5, ix + 2, "Measuring folders can take a minute on large filesystems."[: iw - 4],
                         t.text("muted"))
                self.footer(scr, "scanning - please wait", plain=True)
                scr.refresh()
            if p["finished"]:
                break
            k = scr.getch()
            tick += 1
            if k == curses.KEY_RESIZE:
                continue
        scr.timeout(-1)
        if "error" in holder:
            self.message_screen(scr, "Scan failed", holder["error"].splitlines())
            self.findings = []
            return
        self.result = holder.get("result")
        self.root_children = None
        self.findings = sort_findings(list(self.result.findings), self.sort_key) if self.result else []
        self.cursor = min(self.cursor, max(0, len(self.findings) - 1))
        n_err = len(self.result.errors) if self.result else 0
        self.status = (f"scan complete: {len(self.findings)} findings in {self.result.duration:.0f}s"
                       f"{'; ' + str(n_err) + ' procedure errors (press e)' if n_err else ''}")

    # -- list screen -------------------------------------------------------------------
    def draw_list(self, scr) -> None:
        scr.erase()
        t = self.theme
        h, w = scr.getmaxyx()
        vis = self.visible()
        total_rec = sum(f.reclaimable for f in vis)
        os_rec = sum(f.reclaimable for f in vis if f.on_os_disk)
        y = self.header(scr, "Cleanup findings")
        # summary pills
        x = 1
        for label, role in ((f"{len(vis)} findings", "raised"), (f"reclaimable {human(total_rec)}", "accent"),
                            (f"on OS disk {human(os_rec)}", "raised"), (f"sort: {self.sort_key}", "raised")) + \
                (((f"filter: OS disk only", "warning"),) if self.os_only else ()):
            if x + len(label) + 3 >= w:
                break
            x += self.badge(scr, y, x, label, role) + 1
        if self.session_freed:
            self.badge(scr, y, x, f"freed this session {human(self.session_freed)}", "good")
        iy, ix, ih, iw = self.box(scr, y + 1, 0, h - y - 3, w, "Findings", "Enter opens a finding", focus=True)
        cat_w = 20
        fs_w = 12
        bar_w = 8
        title_w = max(10, iw - (4 + 9 + bar_w + 2 + 9 + cat_w + 1 + fs_w + 3))
        self.put(scr, iy, ix, f" {'#':>3} {'RECLAIM':>8} {'':<{bar_w}}  {'RISK':<8} {'CATEGORY':<{cat_w}} "
                              f"{'TITLE':<{title_w}} {'MOUNT':<{fs_w}}"[:iw], t.text("muted", bold=True))
        rows = ih - 1
        if rows < 1:
            return
        if self.cursor < self.top:
            self.top = self.cursor
        if self.cursor >= self.top + rows:
            self.top = self.cursor - rows + 1
        biggest = max([f.reclaimable for f in vis] + [1])
        for i in range(self.top, min(len(vis), self.top + rows)):
            f = vis[i]
            yy = iy + 1 + i - self.top
            done = any(k[0] == f.id for k in self.done_actions)
            selected = i == self.cursor
            bg = "sel_bg" if selected else ("alt" if i % 2 else "surface")
            row = t.sel() if selected else t.text("ink", bg)
            self.fillrow(scr, yy, ix, iw, row)
            rec = human(f.reclaimable) if f.reclaimable else ("info" if f.informational else "-")
            self.put(scr, yy, ix, f" {i + 1:>3} ", t.text("muted", bg) if not selected else row)
            self.put(scr, yy, ix + 5, f"{rec:>8}", row | curses.A_BOLD)
            if f.reclaimable:
                self.gauge(scr, yy, ix + 15, bar_w, f.reclaimable / biggest, "accent", bg)
            bx = ix + 15 + bar_w + 2
            self.put(scr, yy, bx, f" {f.risk:<6} ", t.badge(t.risk(f.risk)))
            cx = bx + 9
            self.put(scr, yy, cx, f"{f.category[:cat_w]:<{cat_w}}", row if selected else t.text("ink2", bg))
            mark = f" {glyph('ok')}" if done else ""
            self.put(scr, yy, cx + cat_w + 1, f"{(f.title[:title_w - len(mark)] + mark):<{title_w}}",
                     row if selected else t.text("muted" if done else "ink", bg))
            mx = cx + cat_w + 1 + title_w + 1
            self.put(scr, yy, mx, f"{f.mountpoint[:fs_w - 2]:<{fs_w - 2}}", row if selected else t.text("muted", bg))
            if f.on_os_disk:
                self.put(scr, yy, mx + fs_w - 2, glyph("mark"), row if selected else t.text("accent", bg))
        self.scrollbar(scr, iy + 1, ix + iw, rows, self.top, rows, len(vis))
        if not vis:
            self.put(scr, iy + 2, ix + 3, "Nothing to show. Press m for the disk map, r to rescan, o to change the filter.",
                     t.text("muted"))
        self.footer(scr, "Enter details  m DISK MAP  a apply-all-SAFE  s swap  f filesystems  o OS-only  S sort  "
                         "t theme  d dry-run  r rescan  L log  ? help  q quit")

    # -- detail screen -----------------------------------------------------------------
    def detail_screen(self, scr, finding: Finding) -> None:
        acursor = 0
        checked: set[int] = set()
        text_top = 0
        while True:
            if self.too_small(scr):
                k = scr.getch()
                if k in (ord("q"), 27):
                    return
                continue
            scr.erase()
            h, w = scr.getmaxyx()
            y = self.header(scr, f"{finding.title}   [{finding.category}]   size {human(finding.size)}, "
                                 f"reclaimable {human(finding.reclaimable)}, on {finding.mountpoint}"
                                 f"{' (OS disk)' if finding.on_os_disk else ''}")
            text_lines = wrap(finding.summary, w - 4) + [""] + [d for d in finding.details]
            n_actions = len(finding.actions)
            action_rows = min(max(3, n_actions + 1), max(3, h // 3))
            text_rows = max(3, h - y - action_rows - 6)
            text_top = max(0, min(text_top, max(0, len(text_lines) - text_rows)))
            for i in range(text_rows):
                idx = text_top + i
                if idx < len(text_lines):
                    self.put(scr, y + i, 2, text_lines[idx])
            if len(text_lines) > text_rows:
                self.put(scr, y, w - 22, f"[text {text_top + 1}-{min(len(text_lines), text_top + text_rows)}/{len(text_lines)} PgUp/PgDn]",
                         self.colors["dim"])
            y += text_rows
            self.section(scr, y, 1, w - 2, f"ACTIONS {glyph('dot')} space ticks, Enter runs ticked (or highlighted), x runs highlighted now")
            y += 1
            if not finding.actions:
                self.put(scr, y, 2, "No actions available for this finding (informational).", self.colors["dim"])
            for i, a in enumerate(finding.actions[:action_rows - 1]):
                done = (finding.id, a.id) in self.done_actions
                box = glyph("check") if i in checked else glyph("uncheck")
                extra = f"  ~{human(a.reclaim)}" if a.reclaim else ""
                tag = f"  {glyph('ok')} done" if done else ("  recommended" if a.recommended else "")
                selected = i == acursor
                row = self.theme.sel() if selected else self.theme.text("muted" if done else "ink")
                self.fillrow(scr, y, 0, w, row if selected else 0)
                self.put(scr, y, 1, box, row if selected else self.theme.text("accent", bold=True))
                bx = 1 + len(box) + 1
                self.put(scr, y, bx, f" {a.risk:<6} ", self.theme.badge(self.theme.risk(a.risk)))
                self.put(scr, y, bx + 9, f"{a.title}{extra}", row | (curses.A_BOLD if not done else 0))
                self.put(scr, y, bx + 9 + len(a.title) + len(extra), tag,
                         row if selected else self.theme.text("good" if done else "accent"))
                y += 1
            if finding.actions:
                a = finding.actions[acursor]
                desc = wrap(a.description, w - 4)[:3]
                for i, d in enumerate(desc):
                    self.put(scr, y + i, 2, d, self.colors["dim"])
            self.footer(scr, "space tick  Enter run  x run-one  PgUp/PgDn text  q back  d dry-run")
            scr.refresh()
            k = scr.getch()
            if k in (ord("q"), ord("b"), 27, curses.KEY_LEFT):
                return
            elif k in (curses.KEY_DOWN, ord("j")):
                acursor = min(acursor + 1, max(0, n_actions - 1))
            elif k in (curses.KEY_UP, ord("k")):
                acursor = max(0, acursor - 1)
            elif k == curses.KEY_NPAGE:
                text_top += text_rows
            elif k == curses.KEY_PPAGE:
                text_top = max(0, text_top - text_rows)
            elif k == ord(" ") and finding.actions:
                checked ^= {acursor}
            elif k == ord("d"):
                self.ctx.dry_run = not self.ctx.dry_run
            elif k in (curses.KEY_ENTER, 10, 13, ord("x")) and finding.actions:
                chosen = [finding.actions[i] for i in sorted(checked)] if (checked and k != ord("x")) else [finding.actions[acursor]]
                if self.run_actions(scr, finding, chosen):
                    fresh = self.scanner.rescan(finding.procedure)
                    self.replace_findings(finding.procedure, fresh)
                    match = next((f for f in fresh if f.id == finding.id), None)
                    if match is None:
                        self.status = f"{finding.title}: nothing left to report after cleanup"
                        return
                    finding = match
                    checked.clear()
                    acursor = min(acursor, max(0, len(finding.actions) - 1))

    def replace_findings(self, procedure_id: str, fresh: list[Finding]) -> None:
        self.findings = [f for f in self.findings if f.procedure != procedure_id] + list(fresh)
        self.findings = sort_findings(self.findings, self.sort_key)
        self.cursor = min(self.cursor, max(0, len(self.visible()) - 1))
        self.ctx.refresh_mounts()

    # -- running actions ---------------------------------------------------------------
    def run_actions(self, scr, finding: Finding, actions: list[Action]) -> bool:
        for a in actions:
            for inp in a.inputs:
                val = self.input_dialog(scr, inp, a)
                if val is None:
                    self.status = "cancelled"
                    return False
                a.params[inp.key] = val
        if not self.confirm_screen(scr, finding, actions):
            self.status = "cancelled"
            return False
        self.exec_screen(scr, [(finding, a) for a in actions])
        return True

    def input_dialog(self, scr, inp: Input, action: Action) -> Optional[Any]:
        buf = str(inp.default or "")
        error = ""
        curses.curs_set(1)
        try:
            while True:
                scr.erase()
                h, w = scr.getmaxyx()
                y = self.header(scr, f"Input needed: {action.title}")
                y += 1
                for line in wrap(inp.prompt, w - 4):
                    self.put(scr, y, 2, line)
                    y += 1
                if inp.help:
                    for line in wrap(inp.help, w - 4):
                        self.put(scr, y, 2, line, self.colors["dim"])
                        y += 1
                if inp.kind == "choice":
                    self.put(scr, y, 2, "choices: " + ", ".join(inp.choices), self.colors["dim"])
                    y += 1
                if inp.kind == "int" and (inp.min is not None or inp.max is not None):
                    self.put(scr, y, 2, f"range: {inp.min if inp.min is not None else '-'} .. {inp.max if inp.max is not None else '-'}", self.colors["dim"])
                    y += 1
                y += 1
                self.put(scr, y, 2, "> " + buf + " ", curses.A_BOLD)
                if error:
                    self.put(scr, y + 2, 2, error, self.colors["high"])
                self.footer(scr, "Enter accept  Esc cancel  Backspace edit  (default shown pre-filled)")
                try:
                    scr.move(y, 4 + len(buf))
                except curses.error:
                    pass
                scr.refresh()
                k = scr.getch()
                if k == 27:
                    return None
                if k in (curses.KEY_ENTER, 10, 13):
                    ok, err, val = inp.validate(buf)
                    if ok:
                        return val
                    error = err
                elif k in (curses.KEY_BACKSPACE, 127, 8):
                    buf = buf[:-1]
                elif k in (21,):  # ctrl-u
                    buf = ""
                elif k == curses.KEY_RESIZE:
                    continue
                elif 32 <= k < 127:
                    buf += chr(k)
        finally:
            curses.curs_set(0)

    def confirm_screen(self, scr, finding: Finding, actions: list[Action]) -> bool:
        lines: list[str] = []
        worst = RISK_SAFE
        for a in actions:
            worst = max(worst, a.risk, key=lambda r: RISK_ORDER.get(r, 1))
            lines.append(f"[{a.risk}] {a.title}" + (f"  (frees ~{human(a.reclaim)})" if a.reclaim else ""))
            lines.extend("    " + l for l in wrap(a.description, 100))
            for n in a.notes:
                lines.append("    ! " + n)
            if a.params:
                shown = {k: v for k, v in a.params.items() if not k.startswith("_")}
                if shown:
                    lines.append("    parameters: " + ", ".join(f"{k}={v}" for k, v in shown.items()))
            for pl in a.preview_lines():
                lines.append("    " + pl)
            if a.requires_reboot:
                lines.append("    ! a reboot is needed afterwards")
            lines.append("")
        typed = ""
        need_typed = worst == RISK_HIGH and not self.ctx.dry_run
        top = 0
        while True:
            scr.erase()
            h, w = scr.getmaxyx()
            y = self.header(scr, f"Confirm: {len(actions)} action(s) on '{finding.title}'"
                                 f"{'  [DRY RUN - simulation only]' if self.ctx.dry_run else ''}")
            rows = h - y - 4
            for i in range(rows):
                idx = top + i
                if idx < len(lines):
                    ln = lines[idx]
                    if ln.startswith("[") and "]" in ln:
                        r = ln[1:ln.find("]")]
                        bw_ = self.badge(scr, y + i, 2, f"{r:<6}", self.theme.risk(r))
                        self.put(scr, y + i, 3 + bw_, ln[ln.find("]") + 1:].strip(), self.theme.text("ink", bold=True))
                    elif ln.strip().startswith("!"):
                        self.put(scr, y + i, 2, ln, self.theme.text("serious"))
                    elif ln.strip().startswith(("$", "#", "[dry-run]")):
                        self.put(scr, y + i, 2, ln, self.theme.text("muted"))
                    else:
                        self.put(scr, y + i, 2, ln, self.theme.text("ink2"))
            if need_typed:
                self.put(scr, h - 3, 2, f"HIGH risk: type 'yes' and press Enter to proceed: {typed}", self.colors["high"] | curses.A_BOLD)
                self.footer(scr, "yes+Enter run  n/Esc cancel  PgUp/PgDn scroll")
            else:
                self.footer(scr, "y run   n/Esc cancel   PgUp/PgDn scroll")
            scr.refresh()
            k = scr.getch()
            if k in (ord("n"), 27) and not (need_typed and typed):
                return False
            if k == 27:
                return False
            if k == curses.KEY_NPAGE:
                top = min(top + rows, max(0, len(lines) - rows))
            elif k == curses.KEY_PPAGE:
                top = max(0, top - rows)
            elif need_typed:
                if k in (curses.KEY_ENTER, 10, 13):
                    if typed.strip().lower() == "yes":
                        return True
                    typed = ""
                elif k in (curses.KEY_BACKSPACE, 127, 8):
                    typed = typed[:-1]
                elif 32 <= k < 127:
                    typed += chr(k)
            elif k in (ord("y"), ord("Y"), curses.KEY_ENTER, 10, 13):
                return True

    def exec_screen(self, scr, jobs: list[tuple[Finding, Action]]) -> None:
        lines: list[str] = []
        lock = threading.Lock()
        state = {"finished": False, "results": []}

        def on_line(s: str) -> None:
            with lock:
                lines.append(s)

        def work():
            try:
                for finding, action in jobs:
                    res = self.executor.execute(finding, action, on_line)
                    with lock:
                        state["results"].append((finding, action, res))
                    if res.ok:
                        self.done_actions.add((finding.id, action.id))
                        self.session_freed += res.freed
            except Exception:
                on_line(traceback.format_exc())
            finally:
                with lock:
                    state["finished"] = True

        t = threading.Thread(target=work, daemon=True)
        t.start()
        scr.timeout(100)
        follow = True
        top = 0
        spinner = "|/-\\"
        tick = 0
        while True:
            with lock:
                snapshot = list(lines)
                finished = state["finished"]
                results = list(state["results"])
            scr.erase()
            h, w = scr.getmaxyx()
            y = self.header(scr, ("Running " if not finished else "Finished ") + f"{len(results)}/{len(jobs)} action(s)"
                            + ("  [DRY RUN]" if self.ctx.dry_run else ""))
            rows = max(1, h - y - 3)
            if follow:
                top = max(0, len(snapshot) - rows)
            for i in range(rows):
                idx = top + i
                if idx < len(snapshot):
                    ln = snapshot[idx]
                    attr = 0
                    if ln.startswith("-- OK"):
                        attr = self.colors["safe"]
                    elif ln.startswith("-- FAILED") or "Traceback" in ln:
                        attr = self.colors["high"]
                    elif ln.startswith("== "):
                        attr = self.colors["title"]
                    elif ln.startswith("$ ") or ln.startswith("[dry-run]"):
                        attr = self.colors["dim"]
                    self.put(scr, y + i, 1, ln, attr)
            if finished:
                freed = sum(r.freed for _, _, r in results)
                oks = sum(1 for _, _, r in results if r.ok)
                reboot = any(r.requires_reboot for _, _, r in results)
                self.status = (f"{oks}/{len(jobs)} succeeded, freed {human(freed)} this run, {human(self.session_freed)} this session"
                               + ("; REBOOT REQUIRED" if reboot else ""))
                self.footer(scr, "any-key back (rescans this procedure)  PgUp/PgDn scroll")
            else:
                self.footer(scr, f"{self.spinner(tick)} working...  PgUp/PgDn scroll  Ctrl-C aborts the program", plain=True)
            scr.refresh()
            k = scr.getch()
            tick += 1
            if k == -1:
                if finished:
                    scr.timeout(-1)
                    k = scr.getch()
                    if k == curses.KEY_NPAGE:
                        follow = False
                        top = min(top + rows, max(0, len(snapshot) - rows))
                        scr.timeout(100)
                        continue
                    if k == curses.KEY_PPAGE:
                        follow = False
                        top = max(0, top - rows)
                        scr.timeout(100)
                        continue
                    break
                continue
            if k == curses.KEY_NPAGE:
                follow = False
                top = min(top + rows, max(0, len(snapshot) - rows))
            elif k == curses.KEY_PPAGE:
                follow = False
                top = max(0, top - rows)
            elif k == curses.KEY_END:
                follow = True
            elif finished:
                break
        scr.timeout(-1)

    def apply_all_safe(self, scr) -> None:
        jobs = []
        for f in self.visible():
            for a in f.actions:
                if a.recommended and a.risk == RISK_SAFE and not a.inputs and (f.id, a.id) not in self.done_actions:
                    jobs.append((f, a))
        if not jobs:
            self.status = "no recommended SAFE actions pending"
            return
        pseudo = Finding("all-safe", f"{len(jobs)} recommended SAFE actions", CAT_OTHER, 0,
                         sum(a.reclaim for _, a in jobs), "/", "")
        if not self.confirm_screen(scr, pseudo, [a for _, a in jobs]):
            self.status = "cancelled"
            return
        self.exec_screen(scr, jobs)
        procs = {f.procedure for f, _ in jobs}
        for pid in procs:
            self.replace_findings(pid, self.scanner.rescan(pid))

    def open_swap(self, scr) -> None:
        fresh = self.scanner.rescan("swap")
        self.replace_findings("swap", fresh)
        target = next((f for f in fresh if f.id == "swap"), None)
        if target is None:
            self.status = "swap procedure produced no finding (see log)"
            return
        self.detail_screen(scr, target)

    # -- auxiliary screens -------------------------------------------------------------
    def message_screen(self, scr, title: str, lines: list[str], rich: bool = False) -> None:
        top = 0
        while True:
            scr.erase()
            h, w = scr.getmaxyx()
            y = self.header(scr, title)
            iy, ix, ih, iw = self.box(scr, y, 0, h - y - 2, w, "",
                                      f"lines {min(len(lines), top + 1)}-{min(len(lines), top + h - y - 4)} of {len(lines)}")
            rows = ih
            for i in range(rows):
                idx = top + i
                if idx < len(lines):
                    if rich:
                        self.render_rich(scr, iy + i, ix + 1, lines[idx], iw - 2)
                    else:
                        self.put(scr, iy + i, ix + 1, lines[idx][: iw - 2], self.theme.text("ink"))
            self.scrollbar(scr, iy, ix + iw, rows, top, rows, len(lines))
            self.footer(scr, "q back  PgUp/PgDn scroll  Up/Down line")
            scr.refresh()
            k = scr.getch()
            if k in (ord("q"), 27, ord("b"), curses.KEY_LEFT, 10, 13):
                return
            if k == curses.KEY_NPAGE:
                top = min(top + rows, max(0, len(lines) - rows))
            elif k == curses.KEY_PPAGE:
                top = max(0, top - rows)
            elif k in (curses.KEY_DOWN, ord("j")):
                top = min(top + 1, max(0, len(lines) - rows))
            elif k in (curses.KEY_UP, ord("k")):
                top = max(0, top - 1)
            elif k in (curses.KEY_HOME, ord("g")):
                top = 0
            elif k in (curses.KEY_END, ord("G")):
                top = max(0, len(lines) - rows)

    def filesystems_screen(self, scr) -> None:
        """Mounted filesystems as usage gauges plus the biggest top-level folders (measured in
        the background, cached)."""
        self.ctx.refresh_mounts()
        holder: dict[str, Any] = {}
        if self.root_children is not None:
            holder["children"] = self.root_children
        root = default_map_root()

        def work():
            try:
                holder["children"] = self.root_children = self.ctx.du_children(root)
            except Exception as exc:  # pragma: no cover - defensive
                holder["error"] = str(exc)

        if "children" not in holder:
            threading.Thread(target=work, daemon=True).start()
        scr.timeout(150)
        tick = 0
        try:
            while True:
                t = self.theme
                scr.erase()
                h, w = scr.getmaxyx()
                y = self.header(scr, "Filesystems and where the OS disk space goes")
                mounts = self.ctx.mounts
                mh = min(len(mounts) + 3, max(5, (h - y - 2) // 2))
                iy, ix, ih, iw = self.box(scr, y, 0, mh, w, "Mounted filesystems", f"{len(mounts)} mounts")
                gw = max(10, min(30, iw - 70))
                self.put(scr, iy, ix + 1, f"{'MOUNT':<26} {'FS':<6} {'USE':<{gw}} {'USE%':>5} {'USED':>8} "
                                          f"{'SIZE':>8} {'FREE':>8}  DISK"[: iw - 1], t.text("muted", bold=True))
                for i, m in enumerate(mounts[: ih - 1]):
                    yy = iy + 1 + i
                    role = t.level(m.use_pct)
                    self.put(scr, yy, ix + 1, f"{m.target[:26]:<26} {m.fstype[:6]:<6} ", t.text("ink"))
                    self.gauge(scr, yy, ix + 35, gw, m.use_pct / 100.0, role)
                    self.put(scr, yy, ix + 36 + gw, f"{m.use_pct:4.0f}%", t.text(role, bold=True))
                    self.put(scr, yy, ix + 42 + gw, f"{human(m.used):>8} {human(m.total):>8} {human(m.free):>8}  ",
                             t.text("ink2"))
                    dx = ix + 42 + gw + 29
                    self.put(scr, yy, dx, m.disk or "?", t.text("muted"))
                    if m.on_os_disk:
                        self.badge(scr, yy, dx + len(m.disk or "?") + 1, "OS", "accent")
                ty = y + mh
                iy, ix, ih, iw = self.box(scr, ty, 0, h - ty - 2, w,
                                          f"Biggest folders of {display_path(root)}", "same filesystem only")
                if "children" in holder:
                    kids = holder["children"]
                    big = max([s for s, _ in kids] + [1])
                    tot = max(1, sum(s for s, _ in kids))
                    for i, (sz, p) in enumerate(kids[:ih]):
                        yy = iy + i
                        self.put(scr, yy, ix + 1, f"{human(sz):>8} {100.0 * sz / tot:5.1f}% ", t.text("ink", bold=True))
                        self.gauge(scr, yy, ix + 17, 20, sz / big, t.cat_color(i) if t.colored else "accent")
                        self.put(scr, yy, ix + 39, clean_text(display_path(p))[: iw - 40], t.text("ink2"))
                    if not kids:
                        self.put(scr, iy, ix + 2, "(could not measure)", t.text("muted"))
                elif "error" in holder:
                    self.put(scr, iy, ix + 2, "error: " + holder["error"], t.text("critical"))
                else:
                    self.put(scr, iy, ix + 2, f"{self.spinner(tick)} measuring {display_path(root)} ... "
                                              f"(q leaves; the result is kept for next time)", t.text("muted"))
                self.footer(scr, "q back  m disk map (full tree, charts, delete)")
                scr.refresh()
                k = scr.getch()
                tick += 1
                if k == -1:
                    continue
                if k in (ord("q"), 27, ord("b"), curses.KEY_LEFT, 10, 13):
                    return
                if k == ord("m"):
                    scr.timeout(-1)
                    self.open_map(scr)
                    return
        finally:
            scr.timeout(-1)

    def log_screen(self, scr) -> None:
        text = read_text(self.ctx.log_path)
        lines = text.splitlines()[-500:] or ["(log is empty)"]
        self.message_screen(scr, f"Log: {self.ctx.log_path} (last {len(lines)} lines)", lines)

    def errors_screen(self, scr) -> None:
        lines = []
        if self.result:
            for pid, err in self.result.errors:
                lines.append(f"## {pid}")
                lines.extend("   " + l for l in err.strip().splitlines())
            if self.result.skipped:
                lines.append("")
                lines.append("## Skipped (not applicable on this system)")
                lines.append("   " + ", ".join(sorted(self.result.skipped)))
        lines.extend(["", "## Warnings"] + ["   " + w for w in self.ctx.warnings])
        self.message_screen(scr, "Scan errors and warnings", lines or ["none"], rich=True)

    def help_screen(self, scr) -> None:
        lines = [
            "disk_space.py - find and free disk space, one decision at a time.",
            "-- Findings are ranked by how much space the recommended action would free.",
            "-- Rows with a dot in the MOUNT column free space on the OS disk; 'info' rows carry settings.",
            "",
            "## List keys",
            "  Up/Down j/k  ::  move                     Enter/l  open finding details and actions",
            "  m            ::  DISK MAP: whole-disk tree with pie/bar/treemap charts; copy, open, delete any path",
            "  a            ::  run every recommended SAFE action (after one confirmation)",
            "  s            ::  swap manager (swappiness, swap file size, disable/enable)",
            "  f            ::  filesystems overview with usage gauges and top-level folders",
            "  o            ::  toggle 'OS disk only' filter      S  cycle sort order",
            "  t            ::  cycle color theme (dark, light, terminal, mono) - remembered",
            "  d            ::  toggle dry-run (simulate everything)",
            "  r            ::  rescan everything                 L  view the log file",
            "  e            ::  scan errors / skipped procedures  q  quit",
            "",
            "## Detail keys",
            "  space        ::  tick/untick an action             Enter  run ticked (or highlighted)",
            "  x            ::  run only the highlighted action   PgUp/PgDn  scroll details",
            "",
            "## Risk grades",
            "  SAFE         ::  regenerable caches, nothing to lose",
            "  LOW          ::  rebuildable data (packages, images), minor inconvenience",
            "  MEDIUM       ::  service restart, reboot or configuration change",
            "  HIGH         ::  irreversible loss of user data possible (typing 'yes' is required)",
            "",
            "## Command line",
            "  --scan --json --apply FINDING:ACTION --param k=v --yes --dry-run --only ids --no-sudo",
            "  --map [PATH] --tree [PATH] --levels [PATH] --theme dark|light|terminal|mono",
            f"-- Log file: {self.ctx.log_path}",
        ]
        self.message_screen(scr, "Help", lines, rich=True)


# --------------------------------------------------------------------------------------
# Disk map TUI: tree browser, pie / bar / multi-bar / levels charts, path actions
# --------------------------------------------------------------------------------------

BLOCKS = " ▏▎▍▌▋▊▉█"


class MapUI:
    CHARTS = ["pie", "bars", "multi-bar", "levels", "treemap", "info"]
    SORTS = ["size", "name", "items", "age"]

    def __init__(self, tui: "TUI", root: Optional[str] = None, engine: str = "auto",
                 depth_cap: int = 12, one_fs: bool = True, workers: int = 0, survey: bool = True,
                 min_node: int = 256 * KIB, standalone: bool = False):
        self.tui = tui
        self.ctx = tui.ctx
        self.opts = dict(engine=engine, depth_cap=depth_cap, one_fs=one_fs, workers=workers,
                         survey=survey, min_node=min_node)
        self.root_req = root or default_map_root()
        self.standalone = standalone
        self.dmap: Optional[DiskMap] = None
        self.thread: Optional[threading.Thread] = None
        self.cur: Optional[DNode] = None
        self.cursor = 0
        self.top = 0
        self.pos: dict[int, int] = {}
        self.chart = "pie"
        self.sort = "size"
        self.filter = ""
        self.full_chart = False
        self.marks: dict[str, DNode] = {}
        self.status = ""
        self.bg: Optional[dict] = None
        self.colors_ok = False
        self.slots: dict[int, tuple] = {}
        self._cache: dict[str, tuple[Any, Any]] = {}

    # -- lifecycle ---------------------------------------------------------------------
    def start(self, root: Optional[str] = None) -> None:
        if self.dmap is not None and self.thread is not None and self.thread.is_alive():
            self.dmap.cancel.set()
            self.thread.join(timeout=5)
        self.dmap = DiskMap(self.ctx, root or self.root_req, **self.opts)
        self.root_req = self.dmap.root_path
        self.cur = self.dmap.root
        self.cursor = self.top = 0
        self.pos.clear()
        self.marks.clear()
        self._cache.clear()
        self.slots.clear()
        self.thread = threading.Thread(target=self.dmap.scan, daemon=True)
        self.thread.start()
        self.status = f"scanning {display_path(self.dmap.root_path)} ..."

    def scanning(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    # -- colors ------------------------------------------------------------------------
    @property
    def theme(self) -> Theme:
        return self.tui.theme

    def init_colors(self) -> None:
        self.colors_ok = True

    def theme_changed(self) -> None:
        self._cache.clear()

    def pair(self, fg: int, bg: Optional[int] = None) -> int:
        t = self.theme
        return t.pair(fg, t.color("surface") if bg is None else bg)

    @property
    def pal(self) -> list[int]:
        return list(self.theme.c.get("cat", [])) if self.theme.colored else []

    def color_of(self, idx: int) -> int:
        """Palette color for slot idx (-1 = other)."""
        return self.theme.cat_color(idx) if self.theme.colored else -1

    def fg(self, idx: int, bg: Any = "surface") -> int:
        return self.theme.cat(idx, bg)

    # -- drawing helpers ---------------------------------------------------------------
    def put(self, scr, y: int, x: int, text: str, attr: int = 0) -> None:
        self.tui.put(scr, y, x, text, attr)

    @property
    def uni(self) -> bool:
        return UNICODE_OK

    def bar_text(self, frac: float, width: int) -> str:
        frac = max(0.0, min(1.0, frac))
        if width <= 0:
            return ""
        if not self.uni:
            n = int(round(frac * width))
            return "#" * n + " " * (width - n)
        eighths = int(round(frac * width * 8))
        full, part = divmod(eighths, 8)
        s = "█" * full + (BLOCKS[part] if part and full < width else "")
        return s + " " * (width - len(s))

    def swatch(self) -> str:
        return glyph("swatch")

    def color_bar(self, scr, y: int, x: int, width: int, frac: float, slot: int, bg: Any = "surface") -> None:
        """A list bar in the entity's color over a faint track."""
        t = self.theme
        text = self.bar_text(frac, width)
        filled = text.rstrip(" ")
        if not t.colored:
            self.put(scr, y, x, filled, curses.A_BOLD)
            return
        track = t.color("track") if bg == "surface" else t.color("raised")
        self.put(scr, y, x, filled, t.pair(self.color_of(slot), t.color(bg)))
        if len(filled) < width:
            self.put(scr, y, x + len(filled), (glyph("dot") if self.uni else ".") * (width - len(filled)),
                     t.pair(track, t.color(bg)))

    def segments(self, scr, y: int, x: int, parts: list[tuple[int, int]], bg: Any = "surface") -> None:
        """Stacked bar from (cells, slot) parts; each segment ends with a half-cell gap of the
        surface so neighbours stay distinguishable without relying on hue alone."""
        t = self.theme
        for cells, slot in parts:
            if cells <= 0:
                continue
            col = self.color_of(slot)
            if not t.colored:
                self.put(scr, y, x, ("#" if slot >= 0 else ".") * cells, curses.A_BOLD if slot >= 0 else curses.A_DIM)
            elif self.uni and cells >= 2:
                self.put(scr, y, x, "█" * (cells - 1), t.pair(col, t.color(bg)))
                self.put(scr, y, x + cells - 1, "▌", t.pair(col, t.color(bg)))
            else:
                self.put(scr, y, x, ("█" if self.uni else " ") * cells,
                         t.pair(col, t.color(bg)) if self.uni else t.fill(col))
            x += cells

    # -- data views --------------------------------------------------------------------
    def entries(self, node: DNode) -> list[DNode]:
        assert self.dmap is not None
        with self.dmap.lock:
            kids = node.kids()
        if self.filter:
            f = self.filter.lower()
            kids = [k for k in kids if f in k.name.lower()]
        if self.sort == "name":
            kids.sort(key=lambda k: (not k.is_dir, k.name.lower()))
        elif self.sort == "items":
            kids.sort(key=lambda k: -(max(0, k.n_dirs) + max(0, k.n_files)))
        elif self.sort == "age":
            kids.sort(key=lambda k: k.mtime or 9e18)
        else:
            kids.sort(key=lambda k: -k.size)
        return kids

    def ranked(self, node: DNode) -> list[DNode]:
        """Children by size: their position is their chart color everywhere."""
        assert self.dmap is not None
        with self.dmap.lock:
            kids = node.kids()
        kids.sort(key=lambda k: -k.size)
        return kids

    def cached(self, key: str, fn: Callable[[], Any]) -> Any:
        gen = self.dmap.gen if self.dmap else 0
        hit = self._cache.get(key)
        if hit is None or hit[0] != gen:
            hit = (gen, fn())
            self._cache[key] = hit
        return hit[1]

    # -- background work ---------------------------------------------------------------
    def run_bg(self, label: str, fn: Callable[[], Optional[str]],
               on_done: Optional[Callable[[], None]] = None) -> bool:
        if self.bg is not None and self.bg["thread"].is_alive():
            self.status = f"busy: {self.bg['label']} - wait for it to finish"
            return False
        holder: dict[str, Any] = {"label": label, "started": time.time(), "on_done": on_done}

        def work():
            try:
                holder["result"] = fn() or ""
            except Exception as exc:
                holder["result"] = f"{label} failed: {exc}"
                self.ctx.log("MAP  bg error " + traceback.format_exc())

        holder["thread"] = threading.Thread(target=work, daemon=True)
        holder["thread"].start()
        self.bg = holder
        return True

    def poll_bg(self) -> None:
        if self.bg is not None and not self.bg["thread"].is_alive():
            res = self.bg.get("result", "")
            if res:
                self.status = res
            done = self.bg.get("on_done")
            self.bg = None
            if done is not None:
                done()        # runs in the UI thread: safe to touch marks / navigation

    def busy(self) -> bool:
        return self.bg is not None and self.bg["thread"].is_alive()

    def wait_bg(self, scr, title: str) -> None:
        """Block with a spinner card until the background job ends (Esc leaves it running)."""
        tick = 0
        scr.timeout(100)
        try:
            while self.busy():
                t = self.theme
                scr.erase()
                y = self.tui.header(scr, title)
                h, w = scr.getmaxyx()
                bw = min(76, w - 4)
                bx = max(1, (w - bw) // 2)
                by = max(y + 1, (h - 8) // 2)
                el = time.time() - self.bg["started"] if self.bg else 0
                iy, ix, ih, iw = self.tui.box(scr, by, bx, 7, bw, title, f"{el:.0f}s", focus=True)
                self.put(scr, iy + 1, ix + 2, f"{self.tui.spinner(tick)}  {self.bg['label'] if self.bg else ''}"[: iw - 4],
                         t.text("ink", bold=True))
                # indeterminate progress: a block sweeping across the track
                span = max(4, (iw - 4) // 6)
                pos = (tick * 2) % max(1, (iw - 4 + span)) - span
                self.tui.gauge(scr, iy + 2, ix + 2, iw - 4, 0.0, "accent")
                lo, hi = max(0, pos), min(iw - 4, pos + span)
                if hi > lo:
                    self.put(scr, iy + 2, ix + 2 + lo, glyph("full") * (hi - lo),
                             t.pair(t.color("accent"), t.color("track")) if t.colored else curses.A_BOLD)
                cur = self.dmap.current if self.dmap else ""
                self.put(scr, iy + 4, ix + 2, clean_text(display_path(cur))[: iw - 4], t.text("muted"))
                self.tui.footer(scr, "Esc continue in background")
                scr.refresh()
                k = scr.getch()
                tick += 1
                if k == 27:
                    return
        finally:
            scr.timeout(-1)
        self.poll_bg()

    def prepare(self, node: DNode) -> None:
        """When a folder is opened: list its files, bring back pruned folders, deepen frontier."""
        dmap = self.dmap
        if dmap is None or not node.is_dir or node.has(F_MOUNT | F_DELETED) or self.busy():
            return
        scan_done = not self.scanning()
        if not (not node.has(F_FILES) or (scan_done and node.needs_refine())):
            return

        def work() -> str:
            if scan_done and node.has(F_FRONTIER) and not node.has(F_EXPANDED):
                dmap.refine(node, 3)
            elif scan_done and node.has(F_PRUNED):
                dmap.fill_pruned(node)
            dmap.load_files(node)
            return ""

        self.run_bg(f"reading {clean_text(node.name)}", work)

    # -- navigation --------------------------------------------------------------------
    def go(self, node: DNode, select: Optional[DNode] = None) -> None:
        if self.cur is not None:
            self.pos[id(self.cur)] = self.cursor
        self.cur = node
        self.filter = ""
        self.cursor = self.pos.get(id(node), 0)
        if select is not None:
            ents = self.entries(node)
            for i, e in enumerate(ents):
                if e is select:
                    self.cursor = i
                    break
        self.top = 0
        self.prepare(node)

    def go_path(self, path: str) -> None:
        """Navigate to the folder holding path (creating tree nodes on the way if needed)."""
        assert self.dmap is not None
        target = self.dmap.node_for(path) or self.dmap.materialize(path)
        if target is None:
            parent = self.dmap.materialize(os.path.dirname(path))
            if parent is None:
                self.status = f"{display_path(path)} is outside the map or no longer exists"
                return
            self.go(parent)
            return
        if target.is_dir:
            self.go(target)
        elif target.parent is not None:
            self.go(target.parent, target)

    def up(self) -> None:
        if self.cur is not None and self.cur.parent is not None:
            child = self.cur
            self.pos[id(self.cur)] = self.cursor
            self.cur = self.cur.parent
            self.filter = ""
            ents = self.entries(self.cur)
            self.cursor = next((i for i, e in enumerate(ents) if e is child), self.pos.get(id(self.cur), 0))
            self.top = 0

    def selected(self) -> Optional[DNode]:
        if self.cur is None:
            return None
        ents = self.entries(self.cur)
        if not ents:
            return None
        self.cursor = max(0, min(self.cursor, len(ents) - 1))
        return ents[self.cursor]

    # -- main loop ---------------------------------------------------------------------
    def run(self, scr) -> None:
        self.init_colors()
        if self.dmap is None:
            self.start()
        while True:
            if self.tui.too_small(scr):
                scr.timeout(-1)
                k = scr.getch()
                if k in (ord("q"), 27):
                    return
                continue
            self.poll_bg()
            if not self.scanning() and self.cur is not None:
                self.prepare(self.cur)
            self.draw(scr)
            scr.timeout(250 if (self.scanning() or self.busy()) else -1)
            k = scr.getch()
            if k == -1 or k == curses.KEY_RESIZE:
                continue
            if k == 27 and self.swallow_escape(scr):
                continue
            if self.handle_key(scr, k) == "quit":
                scr.timeout(-1)
                return

    def handle_key(self, scr, k: int) -> Optional[str]:
        assert self.dmap is not None and self.cur is not None
        ents = self.entries(self.cur)
        n = len(ents)
        sel = ents[self.cursor] if 0 <= self.cursor < n else None
        if k in (ord("q"),):
            if self.marks and not self.ask_yes(scr, f"{len(self.marks)} marked items will be unmarked. Leave the map?"):
                return None
            return "quit"
        if k in (curses.KEY_DOWN, ord("j")):
            self.cursor = min(self.cursor + 1, max(0, n - 1))
        elif k in (curses.KEY_UP, ord("k")):
            self.cursor = max(0, self.cursor - 1)
        elif k == curses.KEY_NPAGE:
            self.cursor = min(self.cursor + 15, max(0, n - 1))
        elif k == curses.KEY_PPAGE:
            self.cursor = max(0, self.cursor - 15)
        elif k in (curses.KEY_HOME, ord("g")):
            self.cursor = 0
        elif k in (curses.KEY_END, ord("G")):
            self.cursor = max(0, n - 1)
        elif k in (curses.KEY_ENTER, 10, 13, curses.KEY_RIGHT, ord("l")):
            if sel is None:
                return None
            if sel.has(F_MOUNT):
                if self.ask_yes(scr, f"{display_path(sel.path)} is another filesystem. Map it now?"):
                    self.start(sel.path)
            elif sel.is_dir:
                self.go(sel)
            elif k not in (curses.KEY_RIGHT, ord("l")):
                self.preview(scr, sel)
        elif k in (curses.KEY_LEFT, ord("h"), curses.KEY_BACKSPACE, 127, 8):
            self.up()
        elif k == 27:
            if self.filter:
                self.filter = ""
                self.cursor = 0
            else:
                self.up()
        elif k == ord(" "):
            if sel is not None:
                self.toggle_mark(sel)
                self.cursor = min(self.cursor + 1, max(0, n - 1))
        elif k == ord("u"):
            self.marks.clear()
            self.status = "all marks cleared"
        elif k in (ord("D"), curses.KEY_DC):
            targets = list(self.marks.values()) or ([sel] if sel is not None else [])
            self.delete_flow(scr, targets)
        elif k == ord("c"):
            if sel is not None:
                p = display_path(sel.path)
                how = copy_to_clipboard(self.ctx, p)
                self.status = f"copied {clean_text(p)}" + (f" ({how})" if how else " - no clipboard tool, path shown here")
        elif k == ord("C"):
            items = list(self.marks.values()) or ([sel] if sel is not None else [])
            text = "\n".join(display_path(x.path) for x in items)
            how = copy_to_clipboard(self.ctx, text)
            self.status = f"copied {len(items)} path(s)" + (f" ({how})" if how else "")
        elif k == ord("o"):
            target = sel or self.cur
            self.status = open_in_file_manager(self.ctx, target.path)
        elif k == ord("!"):
            target = self.cur if sel is None or not sel.is_dir else sel
            self.shell(scr, target.path)
        elif k == ord("i"):
            self.info_screen(scr, sel or self.cur)
        elif k == ord("p"):
            if sel is not None:
                self.preview(scr, sel)
        elif k == ord("v"):
            self.chart = self.CHARTS[(self.CHARTS.index(self.chart) + 1) % len(self.CHARTS)]
            self.status = f"chart: {self.chart}"
        elif k == ord("V"):
            self.chart = self.CHARTS[(self.CHARTS.index(self.chart) - 1) % len(self.CHARTS)]
            self.status = f"chart: {self.chart}"
        elif k == 9:  # Tab
            self.full_chart = not self.full_chart
        elif k == ord("s"):
            self.sort = self.SORTS[(self.SORTS.index(self.sort) + 1) % len(self.SORTS)]
            self.status = f"sorted by {self.sort}"
            self.cursor = 0
        elif k == ord("/"):
            text = self.prompt(scr, "Filter names (empty clears): ", self.filter)
            if text is not None:
                self.filter = text
                self.cursor = 0
        elif k == ord("L"):
            self.levels_screen(scr)
        elif k == ord("T"):
            self.top_dirs_screen(scr)
        elif k == ord("F"):
            self.largest_files_screen(scr)
        elif k == ord("x"):
            target = sel if sel is not None and sel.is_dir else self.cur
            self.deepen(target)
        elif k == ord("r"):
            self.deepen(self.cur, levels=max(2, min(self.dmap.depth_cap, 6)), label="re-measuring")
        elif k == ord("R"):
            if self.ask_yes(scr, f"Rescan {display_path(self.dmap.root_path)} from scratch?"):
                self.start(self.dmap.root_path)
        elif k == ord("M"):
            text = self.prompt(scr, "Map folder: ", display_path((sel if sel is not None and sel.is_dir else self.cur).path))
            if text:
                path = os.path.abspath(expand_user_path(self.ctx, text))
                if os.path.isdir(path):
                    self.start(path)
                else:
                    self.status = f"not a folder: {path}"
        elif k == ord("e"):
            try:
                files = export_map(self.ctx, self.dmap, self.cur)
                self.status = "exported " + "  ".join(files)
            except OSError as exc:
                self.status = f"export failed: {exc}"
        elif k == ord("E"):
            errs = self.dmap.errors or ["no errors"]
            extra = []
            if IS_MAC and self.dmap.n_errors:
                extra = ["", "macOS protects some folders (Mail, Messages, Safari, Photos, ...) even from root.",
                         "Grant Full Disk Access to your terminal app (System Settings > Privacy & Security)",
                         "and rescan to measure them."]
            self.tui.message_screen(scr, f"Unreadable paths ({self.dmap.n_errors})", errs[:3000] + extra)
        elif k == ord("d"):
            if self.ctx.dry_run and not self.ask_yes(scr, "Turn dry-run OFF (deletes become real)?"):
                return None
            self.ctx.dry_run = not self.ctx.dry_run
            self.status = f"dry-run {'ON: deletes are simulated' if self.ctx.dry_run else 'OFF: deletes are real'}"
        elif k in (ord("?"), curses.KEY_F1):
            self.help(scr)
        elif k == ord("t"):
            self.tui.cycle_theme()
            self.status = self.tui.status
        elif k == ord("w"):
            self.wait_bg(scr, "Background job")
        return None

    @staticmethod
    def swallow_escape(scr) -> bool:
        """True when Esc was the start of an unknown escape sequence (drained, ignored) -
        so a stray 'ESC [ D' can never reach the D (delete) key."""
        scr.nodelay(True)
        try:
            k = scr.getch()
            if k == -1:
                return False
            if k not in (ord("["), ord("O")):
                curses.ungetch(k)       # plain Esc followed by a normal key: keep that key
                return False
            while k != -1:
                k = scr.getch()
            return True
        finally:
            scr.nodelay(False)

    def toggle_mark(self, node: DNode) -> None:
        p = node.path
        if p in self.marks:
            del self.marks[p]
        else:
            self.marks[p] = node

    def deepen(self, node: DNode, levels: int = 3, label: str = "deepening") -> None:
        if self.scanning():
            self.status = "wait for the scan to finish before deepening"
            return
        if not node.is_dir or node.has(F_MOUNT):
            return
        dmap = self.dmap
        assert dmap is not None

        def work() -> str:
            before = node.size
            dmap.refine(node, levels)
            dmap.load_files(node)
            return (f"{label} {clean_text(display_path(node.path))}: {levels} more levels measured "
                    f"({human(before)} -> {human(node.size)})")

        self.run_bg(f"{label} {clean_text(node.name)} (du -d {levels})", work)

    # -- main screen -------------------------------------------------------------------
    def draw(self, scr) -> None:
        assert self.dmap is not None and self.cur is not None
        dmap = self.dmap
        t = self.theme
        scr.erase()
        h, w = scr.getmaxyx()
        y = self.tui.header(scr, f"Disk map {glyph('dot')} {display_path(dmap.root_path)} {glyph('dot')} "
                                 f"{human(dmap.root.size)}")
        self.draw_breadcrumb(scr, y, w)
        y += 1
        self.draw_scan_line(scr, y, w)
        y += 1
        rows_bottom = h - 2
        show_chart = self.full_chart or w >= 110
        if self.full_chart:
            iy, ix, ih, iw = self.chart_box(scr, y, 0, rows_bottom - y, w)
            self.draw_chart(scr, iy, ix, ih, iw)
            self.footer(scr)
            scr.refresh()
            return
        list_w = w if not show_chart else max(60, min(w - 46, w * 55 // 100))
        self.draw_list(scr, y, 0, rows_bottom - y, list_w)
        if show_chart:
            iy, ix, ih, iw = self.chart_box(scr, y, list_w, rows_bottom - y, w - list_w)
            self.draw_chart(scr, iy, ix, ih, iw)
        self.footer(scr)
        scr.refresh()

    def draw_breadcrumb(self, scr, y: int, w: int) -> None:
        t = self.theme
        cur = self.cur
        assert cur is not None and self.dmap is not None
        chain = []
        n: Optional[DNode] = cur
        while n is not None:
            chain.append(n)
            n = n.parent
        chain.reverse()
        x = 1
        self.put(scr, y, x, glyph("home") + " ", t.text("accent", bold=True))
        x += 2
        parts = [display_path(chain[0].path)] + [c.name for c in chain[1:]]
        # keep the tail visible on narrow terminals
        right = f"{human(cur.size)}  {100.0 * cur.size / max(1, self.dmap.root.size):.1f}% of map"
        room = w - x - len(right) - 6
        text_parts = [clean_text(p) for p in parts]
        while len(text_parts) > 1 and sum(len(p) + 3 for p in text_parts) > room:
            text_parts = [glyph("ell")] + text_parts[2:] if text_parts[0] != glyph("ell") else [glyph("ell")] + text_parts[2:]
        for i, p in enumerate(text_parts):
            last = i == len(text_parts) - 1
            self.put(scr, y, x, p, t.text("ink" if last else "ink2", bold=last))
            x += len(p)
            if not last:
                self.put(scr, y, x, f" {glyph('sep')} ", t.text("muted"))
                x += 3
        self.badge_text(scr, y, w - len(right) - 3, right, "raised")

    def badge_text(self, scr, y: int, x: int, text: str, role: Any) -> int:
        return self.tui.badge(scr, y, x, text, role)

    def chart_box(self, scr, y: int, x: int, h: int, w: int) -> tuple[int, int, int, int]:
        right = "v/V switch  Tab zoom"
        tabs_w = sum(len(n) + 2 for n in self.CHARTS) + 4
        if tabs_w + len(right) + 4 > w:
            right = ""
        iy, ix, ih, iw = self.tui.box(scr, y, x, h, w, "", right)
        # chart tabs in the top border
        t = self.theme
        tx = x + 2
        for name in self.CHARTS:
            label = f" {name} "
            if tx + len(label) >= x + w - (len(right) + 4 if right else 2):
                break
            self.put(scr, y, tx, label, t.badge("accent") if name == self.chart else t.text("ink2"))
            tx += len(label)
        return iy, ix + 1, ih, iw - 2

    def footer(self, scr) -> None:
        if self.status.startswith("scanning ") and not self.scanning() and self.dmap is not None:
            self.status = (f"scan {self.dmap.phase}: {human(self.dmap.root.size)} in "
                           f"{self.dmap.survey_dirs:,} folders - Enter opens, ? help")
        msg = self.status
        if self.busy() and self.bg:
            msg = f"{self.tui.spinner(int(time.time() * 8))} {self.bg['label']} ...   {msg}"
        if self.marks:
            tot = sum(m.size for m in list(self.marks.values()))
            msg = f"{glyph('mark')} {len(self.marks)} marked ({human(tot)})   " + msg
        if self.ctx.dry_run:
            msg = "[DRY RUN] " + msg
        self.tui.status = msg
        self.tui.footer(scr, "Enter open  ← up  space mark  D delete  c copy  o open  ! shell  i info  "
                             "v chart  Tab zoom  L levels  T top  F files  x deepen  / filter  t theme  ? help  q back")

    def draw_scan_line(self, scr, y: int, w: int) -> None:
        dmap = self.dmap
        assert dmap is not None
        t = self.theme
        el = (dmap.finished or time.time()) - (dmap.started or time.time())
        if dmap.phase in ("idle", "survey"):
            x = 1 + self.badge_text(scr, y, 1, f"{self.tui.spinner(int(time.time() * 8))} SURVEY", "warning")
            self.put(scr, y, x + 1, f"listing every folder ... {dmap.survey_dirs:,} folders  "
                                    f"{clean_text(display_path(dmap.current))}"[: w - x - 2], t.text("ink2"))
        elif dmap.phase in ("plan", "measure"):
            pct = dmap.progress()
            done = sum(1 for j in dmap.jobs if j.state == "done")
            x = 1 + self.badge_text(scr, y, 1, f"{self.tui.spinner(int(time.time() * 8))} MEASURE", "accent")
            bw = max(10, min(40, w // 4))
            self.tui.gauge(scr, y, x + 1, bw, pct, "accent")
            self.put(scr, y, x + bw + 2, f"{pct * 100:4.1f}%  jobs {done}/{len(dmap.jobs)}  {el:.0f}s  "
                                         f"{clean_text(display_path(dmap.current))}"[: max(0, w - x - bw - 3)],
                     t.text("ink2"))
        elif dmap.phase == "error":
            x = 1 + self.badge_text(scr, y, 1, "ERROR", "critical")
            self.put(scr, y, x + 1, f"scan failed: {dmap.message}"[: w - x - 2], t.text("critical"))
        else:
            x = 1 + self.badge_text(scr, y, 1, f"{glyph('ok')} {dmap.phase.upper()}", "good")
            cur = self.cur
            items = []
            if cur is not None:
                if cur.n_dirs >= 0:
                    items.append(f"{cur.n_dirs:,} folders")
                if cur.n_files >= 0:
                    items.append(f"{cur.n_files:,} files")
                if cur.max_depth >= 0:
                    items.append(f"depth {cur.max_depth}")
            text = (f"{el:.0f}s {glyph('dot')} {'du -x -k -d N' if dmap.du_bin else 'python walker'} on "
                    f"{len(dmap.jobs)} paths {glyph('dot')} here: {', '.join(items) or '-'}")
            self.put(scr, y, x + 1, text[: w - x - 2], t.text("ink2"))
            xx = x + 1 + len(text) + 2
            try:
                du = shutil.disk_usage(dmap.root_path)
                pct = 100.0 * du.used / max(1, du.total)
                gw = 14
                if xx + gw + 30 < w:
                    self.tui.gauge(scr, y, xx, gw, pct / 100.0, t.level(pct))
                    self.put(scr, y, xx + gw + 1, f"{pct:.0f}% {glyph('dot')} {human(du.free)} free",
                             t.text(t.level(pct), bold=True))
                    xx += gw + 22
            except OSError:
                pass
            if dmap.n_errors and xx + 20 < w:
                self.badge_text(scr, y, xx, f"{dmap.n_errors} unreadable (E)", "serious")

    def draw_list(self, scr, y0: int, x0: int, rows: int, width: int) -> None:
        assert self.cur is not None
        t = self.theme
        cur = self.cur
        ents = self.entries(cur)
        sort_lbl = {"size": "size", "name": "name", "items": "items", "age": "age"}[self.sort]
        title = f"{clean_text(cur.name if cur.parent is not None else display_path(cur.path))} {glyph('dot')} {len(ents)} items"
        right = (f"filter '{self.filter}'  " if self.filter else "") + f"sort {sort_lbl} {glyph('down')}"
        iy, ix, ih, iw = self.tui.box(scr, y0, x0, rows, width, title, right, focus=True)
        bw = 12 if iw >= 90 else 8
        name_w = max(10, iw - (4 + 9 + 6 + 1 + bw + 1 + 8 + 5 + 6 + 1))
        arrow = glyph("down")
        heads = {"size": f"{'SIZE' + (arrow if self.sort == 'size' else ''):>8}",
                 "name": f"{'NAME' + (' ' + arrow if self.sort == 'name' else ''):<{name_w}}",
                 "items": f"{('ITEMS' + arrow) if self.sort == 'items' else 'ITEMS':>7}",
                 "age": f"{('AGE' + arrow) if self.sort == 'age' else 'AGE':>5}"}
        hdr = (f"    {heads['name']} {heads['size']} {'%':>5} {'':<{bw}} {heads['items']} {'DEP':>4} {heads['age']}")
        self.put(scr, iy, ix, hdr[:iw], t.text("muted", bold=True))
        rows_avail = ih - 1
        y0 = iy + 1
        if rows_avail < 1:
            return
        n = len(ents)
        if self.cursor >= n:
            self.cursor = max(0, n - 1)
        if self.cursor < self.top:
            self.top = self.cursor
        if self.cursor >= self.top + rows_avail:
            self.top = self.cursor - rows_avail + 1
        total = max(1, cur.size)
        slots = self.slot_map(cur)
        for i in range(self.top, min(n, self.top + rows_avail)):
            e = ents[i]
            yy = y0 + i - self.top
            if not e.mtime and e.is_dir:
                try:
                    e.mtime = os.lstat(e.path).st_mtime
                except OSError:
                    e.mtime = 0.0
            selected = i == self.cursor
            marked = e.path in self.marks
            bg = "sel_bg" if selected else ("alt" if i % 2 else "surface")
            base = t.sel() if selected else t.text("ink", bg)
            self.tui.fillrow(scr, yy, ix, iw, base)
            slot = slots.get(e.name, -1)
            # mark + swatch
            if marked:
                self.put(scr, yy, ix + 1, glyph("mark"), t.text("mark", bg, bold=True))
            # the swatch keeps the surface behind it so its color survives the selection bar
            self.put(scr, yy, ix + 2, self.swatch(), self.fg(slot, "surface" if selected else bg) if t.colored else base)
            # name
            flag = ""
            if e.has(F_MOUNT):
                flag = " @fs"
            elif e.has(F_ERROR):
                flag = " !"
            elif e.has(F_PENDING):
                flag = " ~"
            elif e.needs_refine():
                flag = " +"
            name = clean_text(e.name) + ("/" if e.is_dir else "")
            if len(name) + len(flag) > name_w:
                name = name[: max(1, name_w - len(flag) - 1)] + glyph("ell")
            if selected:
                nattr = base
            elif marked:
                nattr = t.text("mark", bg, bold=True)
            elif e.has(F_MOUNT) or e.has(F_PENDING):
                nattr = t.text("muted", bg)
            elif e.is_dir:
                nattr = t.text("ink", bg, bold=not e.name.startswith("."))
            else:
                nattr = t.text("muted" if e.name.startswith(".") else "ink2", bg)
            self.put(scr, yy, ix + 4, name, nattr)
            if flag:
                self.put(scr, yy, ix + 4 + len(name), flag, base if selected else t.text("muted", bg))
            # numbers
            share = e.size / total
            size = "?" if e.has(F_PENDING) and not e.size else human(e.size)
            sx = ix + 4 + name_w + 1
            sattr = base if selected else t.text("ink" if share >= 0.001 else "muted", bg, bold=share >= 0.10)
            self.put(scr, yy, sx, f"{size:>8}", sattr)
            self.put(scr, yy, sx + 9, f"{100.0 * share:5.1f}", base if selected else t.text("ink2", bg))
            self.color_bar(scr, yy, sx + 15, bw, share, slot, bg)
            items = ""
            if e.is_dir and (e.n_dirs >= 0 or e.n_files >= 0):
                items = f"{max(0, e.n_dirs) + max(0, e.n_files):,}"
            depth = str(e.max_depth) if e.is_dir and e.max_depth >= 0 else ""
            self.put(scr, yy, sx + 16 + bw, f"{items:>7} {depth:>4} {age_text(e.mtime):>5}",
                     base if selected else t.text("muted", bg))
        self.tui.scrollbar(scr, y0, ix + iw, rows_avail, self.top, rows_avail, n)
        if not ents:
            msg = "(empty)" if not self.busy() else "(reading ...)"
            if self.filter:
                msg = f"(nothing matches '{self.filter}' - Esc clears the filter)"
            if self.scanning() and cur.has(F_PENDING):
                msg = "(being measured ...)"
            self.put(scr, y0 + 1, ix + 4, msg, t.text("muted"))
        listed = sum(e.size for e in cur.kids())
        rest = cur.size - listed
        if rest > max(MIB, cur.size // 100) and not self.scanning() and cur.is_dir and n < rows_avail - 1:
            self.put(scr, y0 + n + 1, ix + 4,
                     f"+ {human(rest)} not listed (files not read yet, folder metadata, hard links)",
                     t.text("muted"))

    # -- charts ------------------------------------------------------------------------
    def slot_map(self, node: DNode) -> dict[str, int]:
        """Entity -> palette slot. Provisional (by size rank) while the scan is still moving
        sizes; frozen afterwards so deleting, filtering or re-sorting never repaints the
        survivors (a freed slot only goes to a newcomer)."""
        n = self.theme.n_cats
        gen = self.dmap.gen if self.dmap else 0
        live = self.scanning() or node.has(F_PENDING)
        entry = self.slots.get(id(node))
        if entry is None or entry[0] is not node or entry[3] or (live and entry[2] != gen):
            if entry is None or entry[0] is not node or live or entry[3]:
                m = {c.name: i for i, c in enumerate(self.ranked(node)[:n])}
                entry = (node, m, gen, live)
                self.slots[id(node)] = entry
            return entry[1]
        m = entry[1]
        if entry[2] != gen:
            names = set(node.children or {})
            if any(k not in names for k in m) or len(m) < min(n, len(names)):
                m = {k: v for k, v in m.items() if k in names}
                free = [i for i in range(n) if i not in m.values()]
                for c in self.ranked(node):
                    if not free:
                        break
                    if c.name not in m:
                        m[c.name] = free.pop(0)
            entry = (node, m, gen, False)
            self.slots[id(node)] = entry
        return m

    def color_index(self, node: DNode, child: Optional[DNode]) -> int:
        if child is None:
            return -2
        return self.slot_map(node).get(child.name, -1)

    def slices(self, node: DNode) -> list[tuple[str, int, int, Optional[DNode]]]:
        """[(label, bytes, slot, node)] - every child that owns a palette slot, then 'other'."""
        kids = self.ranked(node)
        slots = self.slot_map(node)
        out: list[tuple[str, int, int, Optional[DNode]]] = []
        rest, n_rest = 0, 0
        for c in kids:
            s = slots.get(c.name, -1)
            if s >= 0 and c.size > 0:
                out.append((clean_text(c.name) + ("/" if c.is_dir else ""), c.size, s, c))
            else:
                rest += c.size
                n_rest += 1
        unlisted = node.size - sum(c.size for c in kids)
        if unlisted > 0:
            rest += unlisted
        if rest > 0:
            out.append((f"other ({n_rest} items" + (" + unlisted" if unlisted > 0 else "") + ")", rest, -1, None))
        return out

    def draw_chart(self, scr, y0: int, x0: int, h: int, w: int) -> None:
        assert self.cur is not None
        if h < 4 or w < 20:
            return
        sel = self.selected()
        sub = {"pie": "share of this folder (donut; the highlighted item pops out)",
               "bars": "children of this folder, scaled to the biggest",
               "multi-bar": "each subfolder split by its own content",
               "levels": "space found at each depth below this folder",
               "treemap": "area = size; every color is one item of this folder",
               "info": "details of the highlighted item"}[self.chart]
        self.put(scr, y0, x0, sub[:w], self.theme.text("muted"))
        y0 += 1
        h -= 1
        if self.chart == "pie":
            self.draw_pie(scr, y0, x0, h, w, self.cur, sel)
        elif self.chart == "bars":
            self.draw_bars(scr, y0, x0, h, w, self.cur, sel)
        elif self.chart == "multi-bar":
            self.draw_multibar(scr, y0, x0, h, w, self.cur, sel)
        elif self.chart == "levels":
            self.draw_levels(scr, y0, x0, h, w, self.cur)
        elif self.chart == "treemap":
            self.draw_treemap(scr, y0, x0, h, w, self.cur, sel)
        else:
            lines = self.info_lines(sel or self.cur)
            for i, line in enumerate(lines[:h]):
                self.tui.render_rich(scr, y0 + i, x0, line, w)

    def draw_legend(self, scr, y: int, x: int, rows: int, w: int, sl: list, total: int,
                    sel: Optional[DNode]) -> None:
        t = self.theme
        for i, (label, size, slot, node) in enumerate(sl[:rows]):
            is_sel = node is not None and node is sel
            bg = "sel_bg" if is_sel else "surface"
            row = t.sel() if is_sel else t.text("ink2", bg)
            self.tui.fillrow(scr, y + i, x, w, row)
            self.put(scr, y + i, x, self.swatch(), self.fg(slot, bg) if t.colored else row)
            pct = 100.0 * size / max(1, total)
            self.put(scr, y + i, x + 2, f"{human(size):>8}", row if is_sel else t.text("ink", bg, bold=True))
            self.put(scr, y + i, x + 11, f"{pct:5.1f}%  {label}"[: max(0, w - 12)], row)

    def draw_pie(self, scr, y0: int, x0: int, h: int, w: int, node: DNode, sel: Optional[DNode]) -> None:
        t = self.theme
        sl = self.slices(node)
        total = sum(s[1] for s in sl)
        if total <= 0:
            self.put(scr, y0 + 1, x0 + 2, "(nothing measured yet)", t.text("muted"))
            return
        side_legend = w >= 2 * h + 30
        legend_rows = 0 if side_legend else min(len(sl), max(3, h // 3))
        pie_rows = max(3, h - legend_rows - 1)
        half = self.uni and t.colored
        pie_w = (w - 32) if side_legend else w
        D = min(pie_w, pie_rows * 2)
        if D < 6:
            self.draw_bars(scr, y0, x0, h, w, node, sel)
            return
        PW = D
        PH = D if half else max(1, D // 2)
        sy = 1.0 if half else 2.0
        cx, cy = PW / 2.0, PH / 2.0
        r = (D / 2.0) - 0.5
        r_rest = r * 0.90          # every slice but the highlighted one
        r_hole = r * 0.42          # donut hole
        bounds = []
        acc = 0.0
        for label, size, slot, n in sl:
            acc += size / total
            bounds.append((acc, slot, n is not None and n is sel))

        def pix(px: int, py: int) -> Optional[int]:
            dx = px + 0.5 - cx
            dy = (py + 0.5 - cy) * sy
            d2 = dx * dx + dy * dy
            if d2 > r * r or d2 < r_hole * r_hole:
                return None
            a = (math.atan2(dx, -dy) / (2 * math.pi)) % 1.0
            for b, slot, is_sel in bounds:
                if a <= b:
                    if not is_sel and d2 > r_rest * r_rest:
                        return None
                    return slot
            return bounds[-1][1]

        ox = x0 + (pie_w - D) // 2 if not side_legend else x0
        rows = (PH + 1) // 2 if half else PH
        surf = t.color("surface")
        for row in range(min(rows, pie_rows)):
            yy = y0 + row
            for col in range(PW):
                if half:
                    top = pix(col, row * 2)
                    bot = pix(col, row * 2 + 1)
                    if top is None and bot is None:
                        continue
                    if top is not None and bot is not None:
                        self.put(scr, yy, ox + col, "▀", t.pair(self.color_of(top), self.color_of(bot)))
                    elif top is not None:
                        self.put(scr, yy, ox + col, "▀", t.pair(self.color_of(top), surf))
                    else:
                        self.put(scr, yy, ox + col, "▄", t.pair(self.color_of(bot), surf))
                else:
                    slot = pix(col, row)
                    if slot is None:
                        continue
                    if t.colored:
                        self.put(scr, yy, ox + col, " ", t.fill(self.color_of(slot)))
                    else:
                        chars = "#%@*+=o~:x"
                        self.put(scr, yy, ox + col, chars[slot % len(chars)] if slot >= 0 else ".")
        # center label in the hole
        crow = y0 + min(rows, pie_rows) // 2
        focus = sel if sel is not None else None
        lines = [human(node.size), "total"]
        if focus is not None and node.size:
            lines = [f"{100.0 * focus.size / max(1, total):.1f}%", clean_text(focus.name)[: max(4, int(r_hole) - 1)]]
        for i, ln in enumerate(lines):
            self.put(scr, crow - 1 + i, ox + (PW - len(ln)) // 2, ln, t.text("ink" if i == 0 else "muted", bold=i == 0))
        if side_legend:
            self.draw_legend(scr, y0, x0 + D + 2, h, w - D - 2, sl, total, sel)
        else:
            self.draw_legend(scr, y0 + pie_rows + 1, x0, legend_rows, w, sl, total, sel)

    def draw_bars(self, scr, y0: int, x0: int, h: int, w: int, node: DNode, sel: Optional[DNode]) -> None:
        t = self.theme
        kids = self.ranked(node)[: max(1, h)]
        total = max(1, node.size)
        biggest = max([k.size for k in kids] + [1])
        name_w = min(24, max(8, w // 3))
        bw = max(5, w - name_w - 16)
        slots = self.slot_map(node)
        for i, k in enumerate(kids):
            yy = y0 + i
            is_sel = k is sel
            bg = "sel_bg" if is_sel else "surface"
            if is_sel:
                self.tui.fillrow(scr, yy, x0, w, t.sel())
            nm = (clean_text(k.name) + ("/" if k.is_dir else ""))[:name_w]
            self.put(scr, yy, x0, f"{nm:<{name_w}}", t.sel() if is_sel else t.text("ink2"))
            self.color_bar(scr, yy, x0 + name_w + 1, bw, k.size / biggest, slots.get(k.name, -1), bg)
            self.put(scr, yy, x0 + name_w + 2 + bw, f"{human(k.size):>7} {100.0 * k.size / total:4.0f}%",
                     t.sel() if is_sel else t.text("ink"))
        if not kids:
            self.put(scr, y0 + 1, x0 + 2, "(no items)", t.text("muted"))

    def draw_multibar(self, scr, y0: int, x0: int, h: int, w: int, node: DNode, sel: Optional[DNode]) -> None:
        t = self.theme
        dirs = [k for k in self.ranked(node) if k.is_dir]
        if not dirs:
            self.put(scr, y0 + 1, x0 + 2, "(no subfolders)", t.text("muted"))
            return
        legend_rows = 3
        per = 2
        n_bars = max(1, (h - legend_rows) // per)
        biggest = max(1, dirs[0].size)
        bw = max(10, w - 1)
        pslots = self.slot_map(node)
        for i, d in enumerate(dirs[:n_bars]):
            yy = y0 + i * per
            is_sel = d is sel
            self.put(scr, yy, x0, self.swatch(), self.fg(pslots.get(d.name, -1)))
            label = f"{clean_text(d.name)}/  {human(d.size)}  {100.0 * d.size / max(1, node.size):.1f}%"
            self.put(scr, yy, x0 + 2, label[: w - 3], t.sel() if is_sel else t.text("ink", bold=True))
            length = max(1, int(round(bw * d.size / biggest)))
            gslots = self.slot_map(d)
            parts = []
            used = 0
            for g in self.ranked(d):
                s = gslots.get(g.name, -1)
                if s < 0:
                    continue
                cells = min(length - used, int(round(length * g.size / max(1, d.size))))
                if cells > 0:
                    parts.append((cells, s))
                    used += cells
            if used < length:
                parts.append((length - used, -1))
            self.segments(scr, yy + 1, x0, parts)
        focus = sel if sel is not None and sel.is_dir else dirs[0]
        ly = y0 + min(len(dirs), n_bars) * per
        if ly >= y0 + h:
            return
        self.put(scr, ly, x0, f"inside {clean_text(focus.name)}/:"[: w - 1], t.text("accent", bold=True))
        x = x0
        yy = ly + 1
        gslots = self.slot_map(focus)
        for g in self.ranked(focus):
            s = gslots.get(g.name, -1)
            if s < 0:
                continue
            piece = f" {clean_text(g.name)[:18]} {human(g.size)}  "
            if x + len(piece) + 2 > x0 + w:
                yy += 1
                x = x0
                if yy >= y0 + h:
                    break
            self.put(scr, yy, x, self.swatch(), self.fg(s))
            self.put(scr, yy, x + 1, piece, t.text("ink2"))
            x += len(piece) + 1

    def draw_levels(self, scr, y0: int, x0: int, h: int, w: int, node: DNode) -> None:
        assert self.dmap is not None
        dmap = self.dmap
        t = self.theme
        slots = self.slot_map(node)

        def compute():
            rows = []
            branches = self.ranked(node)
            frontier = [(b, b) for b in branches if b.is_dir]
            d = 1
            while frontier and d <= 64:
                per_branch: dict[int, int] = {}
                count = 0
                nxt = []
                total = 0
                for n, br in frontier:
                    per_branch[id(br)] = per_branch.get(id(br), 0) + n.size
                    total += n.size
                    count += 1
                    if n.children:
                        nxt.extend((c, br) for c in n.children.values() if c.is_dir)
                rows.append((d, total, count, per_branch))
                frontier = nxt
                d += 1
            return rows, branches

        with dmap.lock:
            rows, branches = self.cached(f"levels:{id(node)}", compute)
        total = max(1, node.size)
        bw = max(10, w - 24)
        self.put(scr, y0, x0, f"{'LEVEL':<6}{'SIZE':>8} {'DIRS':>7}  share of {human(node.size)}, one color per subfolder"[: w],
                 t.text("muted", bold=True))
        for i, (d, size, count, per_branch) in enumerate(rows[: max(0, h - 2)]):
            yy = y0 + 1 + i
            self.put(scr, yy, x0, f"L{d:<5}", t.text("accent", bold=True))
            self.put(scr, yy, x0 + 6, f"{human(size):>8} {count:>7,} ", t.text("ink"))
            length = int(round(bw * size / total))
            parts = []
            used = 0
            other = 0
            for b in branches:
                part = per_branch.get(id(b), 0)
                if not part:
                    continue
                s = slots.get(b.name, -1)
                if s < 0:
                    other += part
                    continue
                cells = min(length - used, int(round(bw * part / total)))
                if cells > 0:
                    parts.append((cells, s))
                    used += cells
            if other and used < length:
                parts.append((length - used, -1))
            self.segments(scr, yy, x0 + 23, parts)

    def draw_treemap(self, scr, y0: int, x0: int, h: int, w: int, node: DNode, sel: Optional[DNode]) -> None:
        """Squarified treemap of the folder's items (cells are ~1:2, so rows count double)."""
        t = self.theme
        kids = [k for k in self.ranked(node) if k.size > 0][:60]
        total = sum(k.size for k in kids)
        if total <= 0 or h < 3 or w < 8:
            self.put(scr, y0 + 1, x0 + 2, "(nothing to draw)", t.text("muted"))
            return
        slots = self.slot_map(node)
        rects = squarify([k.size for k in kids], 0.0, 0.0, float(w), float(h) * 2.0)
        for k, (rx, ry, rw, rh) in zip(kids, rects):
            cx0, cx1 = int(round(rx)), int(round(rx + rw))
            cy0, cy1 = int(round(ry / 2.0)), int(round((ry + rh) / 2.0))
            cw, ch = cx1 - cx0, cy1 - cy0
            if cw <= 0 or ch <= 0:
                continue
            # surface gap on the right/bottom edge keeps neighbours apart
            fw = cw - 1 if cw >= 3 else cw
            fh = ch - 1 if ch >= 3 else ch
            slot = slots.get(k.name, -1)
            col = self.color_of(slot)
            is_sel = k is sel
            if not t.colored:
                # no colors: outlined boxes with labels
                if fw >= 3 and fh >= 2:
                    self.tui.box(scr, y0 + cy0, x0 + cx0, fh, fw, "", "", focus=is_sel)
                    name = (glyph("tri") + " " if is_sel else "") + clean_text(k.name)
                    self.put(scr, y0 + cy0 + 1 if fh > 2 else y0 + cy0, x0 + cx0 + 1, name[: fw - 2],
                             curses.A_BOLD | (curses.A_REVERSE if is_sel else 0))
                    if fh >= 4:
                        self.put(scr, y0 + cy0 + 2, x0 + cx0 + 1, human(k.size)[: fw - 2])
                else:
                    for yy in range(fh):
                        self.put(scr, y0 + cy0 + yy, x0 + cx0, glyph("track") * fw)
                continue
            attr = t.fill(col)
            fillc = " " if t.colored else ("#" if slot >= 0 else ".")
            for yy in range(fh):
                self.put(scr, y0 + cy0 + yy, x0 + cx0, fillc * fw, attr | (curses.A_BOLD if is_sel else 0))
            if fw >= 4:
                ink = t.pair(t.ink_on(col), col) if t.colored else attr
                name = clean_text(k.name) + ("/" if k.is_dir else "")
                label = (glyph("tri") + " " if is_sel else "") + name
                self.put(scr, y0 + cy0, x0 + cx0, label[:fw], ink | curses.A_BOLD |
                         (curses.A_UNDERLINE if is_sel else 0))
                if fh >= 2:
                    self.put(scr, y0 + cy0 + 1, x0 + cx0, f"{human(k.size)} {100.0 * k.size / max(1, node.size):.0f}%"[:fw], ink)

    # -- info / preview ----------------------------------------------------------------
    def info_lines(self, node: DNode) -> list[str]:
        assert self.dmap is not None
        p = node.path
        shown = display_path(p)
        lines = [f"Path      {clean_text(shown)}"]
        if shown != p:
            lines.append(f"Real path {clean_text(p)}")
        kind = "folder" if node.is_dir else "file"
        try:
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                kind = "symlink -> " + clean_text(os.readlink(p))
            try:
                owner = pwd.getpwuid(st.st_uid).pw_name
            except KeyError:
                owner = str(st.st_uid)
            try:
                import grp
                group = grp.getgrgid(st.st_gid).gr_name
            except (KeyError, ImportError):
                group = str(st.st_gid)
            meta = [f"Owner     {owner}:{group}  mode {stat.filemode(st.st_mode)}",
                    f"Modified  {_dt.datetime.fromtimestamp(st.st_mtime):%Y-%m-%d %H:%M}  "
                    f"({age_text(st.st_mtime)}{'' if age_text(st.st_mtime) == 'today' else ' ago'})",
                    f"Accessed  {_dt.datetime.fromtimestamp(st.st_atime):%Y-%m-%d %H:%M}"]
            if not node.is_dir:
                meta.insert(0, f"Apparent  {human(st.st_size)} ({st.st_size:,} bytes), "
                               f"{st.st_nlink} link(s)")
        except OSError as exc:
            meta = [f"stat failed: {exc}"]
        lines.append(f"Type      {kind}")
        lines.append(f"On disk   {human(node.size)} ({node.size:,} bytes)")
        if node.parent is not None:
            lines.append(f"Share     {100.0 * node.size / max(1, node.parent.size):.1f}% of parent, "
                         f"{100.0 * node.size / max(1, self.dmap.root.size):.2f}% of map")
        m = self.ctx.mount_for(p)
        if m.total:
            lines.append(f"Disk      {100.0 * node.size / m.total:.2f}% of {m.target} ({m.fstype}, {human(m.total)})")
        lines.extend(meta)
        if node.is_dir:
            if node.n_dirs >= 0 or node.n_files >= 0:
                lines.append(f"Contains  {max(0, node.n_dirs):,} folders, "
                             f"{max(0, node.n_files):,} files" if node.n_files >= 0 else
                             f"Contains  {max(0, node.n_dirs):,} folders (listed)")
            if node.max_depth >= 0:
                lines.append(f"Depth     {node.max_depth} levels below"
                             + (" (+ more, press x)" if node.needs_refine() else ""))
        flags = [n for f, n in ((F_MOUNT, "other filesystem"), (F_ERROR, "partly unreadable"),
                                (F_FRONTIER, "deeper levels not measured"), (F_PRUNED, "small subfolders hidden"),
                                (F_PENDING, "being measured")) if node.flags & f]
        if flags:
            lines.append("Flags     " + ", ".join(flags))
        why = path_protected(self.ctx, self.dmap, p)
        risk, reason = path_risk(self.ctx, p, node.size)
        lines.append(f"Delete    {'REFUSED: ' + why if why else risk + ': ' + reason}")
        # rich markup: 'Label     ::value' rows, refusal as a warning, a section for content
        out = []
        for ln in lines:
            if ln.startswith("Delete    REFUSED"):
                out.append("!! Delete: " + ln[10:])
            elif len(ln) > 10 and ln[9] == " " and not ln.startswith(" ") and ln[:10].strip():
                out.append(ln[:10] + "::" + ln[10:])
            else:
                out.append(ln)
        if node.is_dir and node.children:
            out.append("")
            out.append("## Biggest items inside")
            for c in self.ranked(node)[:12]:
                out.append(f"  {human(c.size):>8}  ::{clean_text(c.name)}{'/' if c.is_dir else ''}")
        return out

    def info_screen(self, scr, node: DNode) -> None:
        self.tui.message_screen(scr, f"Info: {clean_text(node.name)}", self.info_lines(node), rich=True)

    def preview(self, scr, node: DNode) -> None:
        p = node.path
        if node.is_dir:
            self.info_screen(scr, node)
            return
        lines: list[str] = []
        if shutil.which("file"):
            cp = self.ctx.run(["file", "-b", "--", p], timeout=10)
            if cp.stdout.strip():
                lines.append("type: " + cp.stdout.strip())
        try:
            with open(p, "rb") as fh:
                data = fh.read(64 * KIB)
        except OSError as exc:
            self.tui.message_screen(scr, f"Preview: {clean_text(node.name)}", lines + [f"cannot read: {exc}"])
            return
        if b"\0" in data[:8192]:
            lines.append("binary file, first 512 bytes:")
            for off in range(0, min(512, len(data)), 16):
                chunk = data[off:off + 16]
                hexs = " ".join(f"{b:02x}" for b in chunk)
                txt = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
                lines.append(f"{off:08x}  {hexs:<48}  {txt}")
        else:
            text = data.decode("utf-8", "replace")
            lines.append(f"first {min(len(data), 64 * KIB):,} bytes:")
            lines.append("")
            lines.extend(clean_text(l.expandtabs(4)) for l in text.splitlines()[:1000])
        self.tui.message_screen(scr, f"Preview: {clean_text(display_path(p))}", lines)

    # -- shell -------------------------------------------------------------------------
    def shell(self, scr, path: str) -> None:
        if not os.path.isdir(path):
            path = os.path.dirname(path)
        as_root = False
        if self.ctx.is_root and self.ctx.real_uid != 0:
            ans = self.ask_key(scr, f"Shell in {display_path(path)}:  u = as {self.ctx.real_user}   "
                                    f"r = as root   Esc = cancel", "ur")
            if ans is None:
                return
            as_root = ans == "r"
        try:
            pw = pwd.getpwuid(self.ctx.real_uid)
            user_shell = pw.pw_shell or "/bin/sh"
        except KeyError:
            user_shell = "/bin/sh"
        shell = os.environ.get("SHELL") if not self.ctx.is_root else user_shell
        shell = shell or user_shell
        if self.ctx.is_root and not as_root and self.ctx.real_uid != 0:
            argv = ["sudo", "-u", self.ctx.real_user, "-H", "env"] + \
                   [f"{k}={v}" for k, v in self.ctx.user_env.items()] + [shell]
        else:
            argv = [shell]
        curses.def_prog_mode()
        curses.endwin()
        print(f"\n--- disk_space: shell in {display_path(path)}"
              f"{' (ROOT)' if self.ctx.is_root and (as_root or self.ctx.real_uid == 0) else ''}. "
              f"Type 'exit' to return to the disk map. ---\n", flush=True)
        try:
            subprocess.call(argv, cwd=path)
        except OSError as exc:
            print(f"cannot start shell: {exc}")
            time.sleep(2)
        curses.reset_prog_mode()
        scr.clear()
        curses.curs_set(0)
        self.status = "back from the shell - press r to re-measure this folder if you changed things"

    # -- dialogs -----------------------------------------------------------------------
    def prompt(self, scr, label: str, default: str = "") -> Optional[str]:
        text = default
        curses.curs_set(1)
        scr.timeout(-1)
        try:
            while True:
                h, w = scr.getmaxyx()
                self.tui.hline(scr, h - 1, " " + label + text, self.theme.text("ink", "raised", bold=True))
                try:
                    scr.move(h - 1, min(w - 2, 1 + len(label) + len(text)))
                except curses.error:
                    pass
                scr.refresh()
                try:
                    ch = scr.get_wch()
                except curses.error:
                    continue
                if isinstance(ch, str):
                    if ch in ("\n", "\r"):
                        return text
                    if ch == "\x1b":
                        return None
                    if ch in ("\x7f", "\b"):
                        text = text[:-1]
                    elif ch == "\x15":
                        text = ""
                    elif ch.isprintable():
                        text += ch
                elif ch in (curses.KEY_BACKSPACE, curses.KEY_DC):
                    text = text[:-1]
                elif ch == curses.KEY_ENTER:
                    return text
        finally:
            curses.curs_set(0)

    def ask_key(self, scr, question: str, keys: str) -> Optional[str]:
        scr.timeout(-1)
        while True:
            h, w = scr.getmaxyx()
            self.tui.hline(scr, h - 1, " " + question, self.theme.badge("accent"))
            scr.refresh()
            k = scr.getch()
            if k in (27, ord("q")) and "q" not in keys:
                return None
            if 0 <= k < 256 and chr(k) in keys:
                return chr(k)

    def ask_yes(self, scr, question: str) -> bool:
        return self.ask_key(scr, question + "  [y/N]", "yYnN\n") in ("y", "Y")

    # -- delete ------------------------------------------------------------------------
    def delete_flow(self, scr, targets: list[DNode]) -> None:
        assert self.dmap is not None
        if not targets:
            return
        if self.busy() or self.scanning():
            self.status = "wait for the scan / background job to finish before deleting"
            return
        # drop items inside other selected items
        paths = sorted({t.path: t for t in targets}.items())
        chosen: list[DNode] = []
        for p, t in paths:
            if any(p.startswith(c.path.rstrip("/") + "/") for c in chosen):
                continue
            chosen.append(t)
        ok_items, refused = [], []
        for t in chosen:
            why = path_protected(self.ctx, self.dmap, t.path)
            if why:
                refused.append((t, why))
            else:
                risk, reason = path_risk(self.ctx, t.path, t.size)
                ok_items.append((t, risk, reason))
        total = sum(t.size for t, _, _ in ok_items)
        worst = max((RISK_ORDER[r] for _, r, _ in ok_items), default=0)
        lines = [f"{len(ok_items)} item(s), {human(total)} on disk"
                 + ("   [DRY RUN: nothing will be changed]" if self.ctx.dry_run else ""), ""]
        for t, risk, reason in ok_items:
            lines.append(f"  {risk:<6} {human(t.size):>8}  {clean_text(display_path(t.path))}"
                         f"{'/' if t.is_dir else ''}")
            lines.append(f"  {'':<6} {'':>8}  {reason}")
        if refused:
            lines.append("")
            lines.append("Refused (never deleted from here):")
            for t, why in refused:
                lines.append(f"  {clean_text(display_path(t.path))}: {why}")
        if not ok_items:
            self.tui.message_screen(scr, "Nothing can be deleted", lines)
            return
        lines += ["", "t  move to Trash (recoverable; space is freed when the Trash is emptied)",
                  "P  delete PERMANENTLY (frees the space now, cannot be undone)",
                  "q  cancel"]
        choice = self.choice_screen(scr, "Delete", lines, "tPq")
        if choice not in ("t", "P"):
            self.status = "delete cancelled"
            return
        if worst >= RISK_ORDER[RISK_HIGH] or (choice == "P" and total >= 10 * GIB):
            ans = self.prompt(scr, f"HIGH RISK ({human(total)}). Type 'yes' to "
                                   f"{'move to Trash' if choice == 't' else 'delete permanently'}: ")
            if (ans or "").strip().lower() != "yes":
                self.status = "delete cancelled"
                return
        mode = "trash" if choice == "t" else "delete"
        dmap = self.dmap
        before = self.ctx.fs_free(dmap.root_path)
        items = [t for t, _, _ in ok_items]

        gone: list[str] = []

        def work() -> str:
            done, failed, msgs = 0, 0, []
            bytes_done = 0
            for t in items:
                dmap.current = t.path
                fn = move_to_trash if mode == "trash" else delete_permanently
                try:
                    ok, msg = fn(self.ctx, t.path)
                except Exception as exc:
                    ok, msg = False, f"{type(exc).__name__}: {exc}"
                self.ctx.log(f"MAP  {mode} {t.path}: {'ok' if ok else 'FAILED'} {msg}")
                if ok:
                    done += 1
                    bytes_done += t.size
                else:
                    failed += 1
                    msgs.append(f"{display_path(t.path)}: {msg}")
                if not self.ctx.dry_run:
                    try:
                        if not os.path.lexists(t.path):
                            dmap.detach(t)
                            gone.append(t.path)
                        elif not ok:
                            dmap.remeasure(t)
                    except Exception as exc:
                        self.ctx.log(f"MAP  tree update after {mode} failed: {exc}")
            self.ctx.refresh_mounts()
            after = self.ctx.fs_free(dmap.root_path)
            verb = "moved to Trash" if mode == "trash" else "deleted"
            if self.ctx.dry_run:
                verb = "would be " + verb
            res = f"{done} item(s) {verb} ({human(bytes_done)})"
            if mode == "delete" and not self.ctx.dry_run:
                res += f"; filesystem free {human(before)} -> {human(after)}"
            if failed:
                res += f"; {failed} failed: {msgs[0]}"
            return res

        def after() -> None:
            for t in items:
                self.marks.pop(t.path, None)
            for g in gone:
                pre = g.rstrip("/") + "/"
                for mp in [m for m in self.marks if m.startswith(pre)]:
                    del self.marks[mp]
            # if the folder being viewed was deleted, climb to the nearest survivor
            n = self.cur
            while n is not None and n.parent is not None and \
                    (n.has(F_DELETED) or any(a.has(F_DELETED) for a in self._ancestors(n))):
                n = n.parent
            if n is not None and n is not self.cur:
                self.cur, self.cursor, self.top = n, 0, 0
            self._cache.clear()

        self.run_bg(f"{'trashing' if mode == 'trash' else 'deleting'} {len(items)} item(s)", work, after)
        self.wait_bg(scr, "Deleting")

    @staticmethod
    def _ancestors(node: DNode) -> list[DNode]:
        out = []
        n = node.parent
        while n is not None:
            out.append(n)
            n = n.parent
        return out

    def choice_screen(self, scr, title: str, lines: list[str], keys: str) -> Optional[str]:
        """Dialog card: risk rows get a colored risk badge, 'k  text' rows a key badge."""
        top = 0
        scr.timeout(-1)
        risks = (RISK_SAFE, RISK_LOW, RISK_MEDIUM, RISK_HIGH)
        while True:
            t = self.theme
            scr.erase()
            h, w = scr.getmaxyx()
            y = self.tui.header(scr, title)
            iy, ix, ih, iw = self.tui.box(scr, y, 0, h - y - 2, w, "", "Esc cancels", focus=True)
            rows = ih
            for i in range(rows):
                if top + i >= len(lines):
                    break
                line = lines[top + i]
                yy = iy + i
                head = line.strip().split(" ")[0] if line.strip() else ""
                if line.startswith("  ") and head in risks:
                    self.tui.badge(scr, yy, ix + 2, f"{head:<6}", t.risk(head))
                    rest = line.strip()[len(head):].strip()
                    self.put(scr, yy, ix + 11, rest[: iw - 12], t.text("ink", bold=True))
                elif len(line) > 3 and line[1:3] == "  " and line[0] in keys:
                    role = "critical" if line[0] == "P" else "accent"
                    self.tui.badge(scr, yy, ix + 2, line[0], role)
                    self.put(scr, yy, ix + 6, line[3:][: iw - 7], t.text("ink"))
                elif line.startswith("Refused"):
                    self.put(scr, yy, ix + 1, line[: iw - 2], t.text("critical", bold=True))
                elif i == 0 and top == 0:
                    self.put(scr, yy, ix + 1, line[: iw - 2], t.text("accent", bold=True))
                else:
                    self.put(scr, yy, ix + 1, line[: iw - 2], t.text("ink2"))
            self.tui.scrollbar(scr, iy, ix + iw, rows, top, rows, len(lines))
            self.tui.footer(scr, "  ".join(f"{k} {'trash' if k == 't' else ('delete' if k == 'P' else 'cancel' if k == 'q' else '')}"
                                           for k in keys) + "  PgUp/PgDn scroll")
            scr.refresh()
            k = scr.getch()
            if k == 27 and self.swallow_escape(scr):
                continue
            if k == 27:
                return None
            if k == curses.KEY_NPAGE:
                top = min(top + rows, max(0, len(lines) - rows))
            elif k == curses.KEY_PPAGE:
                top = max(0, top - rows)
            elif 0 <= k < 256 and chr(k) in keys:
                return chr(k)

    # -- list screens ------------------------------------------------------------------
    def path_list_screen(self, scr, title: str, provider: Callable[[], list[tuple[int, str, Optional[DNode], str]]],
                         header: Callable[[], str], keys_extra: Optional[Callable[[int], bool]] = None,
                         base: Optional[str] = None) -> None:
        """Generic list of (bytes, path, node, note) with the usual path actions. Paths below
        `base` are shown relative to it (./...)."""
        pre = (base.rstrip("/") + "/") if base else None

        def shown(path: str) -> str:
            if pre and path.startswith(pre):
                return "./" + path[len(pre):]
            if base and path == base:
                return "."
            return display_path(path)

        cursor = top = 0
        scr.timeout(-1)
        while True:
            rows_data = provider()
            t = self.theme
            scr.erase()
            h, w = scr.getmaxyx()
            y = self.tui.header(scr, title)
            self.put(scr, y, 1, header()[: w - 2], t.text("ink2"))
            y += 1
            n = len(rows_data)
            iy, ix, ih, iw = self.tui.box(scr, y, 0, h - y - 2, w, f"{n} entries", "colors = subfolders, as in the map",
                                          focus=True)
            rows = ih
            cursor = max(0, min(cursor, n - 1))
            if cursor < top:
                top = cursor
            if cursor >= top + rows:
                top = cursor - rows + 1
            big = max([r[0] for r in rows_data] + [1])
            bw = 12
            base_node = self.dmap.node_for(base) if (self.dmap is not None and base) else None
            bslots = self.slot_map(base_node) if base_node is not None else {}
            for i in range(top, min(n, top + rows)):
                size, path, node, note = rows_data[i]
                yy = iy + i - top
                selected = i == cursor
                marked = path in self.marks
                bg = "sel_bg" if selected else ("alt" if i % 2 else "surface")
                row = t.sel() if selected else t.text("ink", bg)
                self.tui.fillrow(scr, yy, ix, iw, row)
                rel = shown(path)
                first = rel[2:].split("/")[0] if rel.startswith("./") else ""
                slot = bslots.get(first, -1)
                if marked:
                    self.put(scr, yy, ix + 1, glyph("mark"), t.text("mark", bg, bold=True))
                self.put(scr, yy, ix + 2, f"{i + 1:>4} ", row if selected else t.text("muted", bg))
                self.put(scr, yy, ix + 7, f"{human(size):>8} ", row | curses.A_BOLD)
                self.color_bar(scr, yy, ix + 16, bw, size / big, slot, bg)
                self.put(scr, yy, ix + 17 + bw, f"{note:>6} ", row if selected else t.text("muted", bg))
                self.put(scr, yy, ix + 24 + bw, clean_text(rel)[: max(0, iw - 25 - bw)],
                         row if selected else t.text("mark" if marked else "ink", bg, bold=marked))
            self.tui.scrollbar(scr, iy, ix + iw, rows, top, rows, n)
            if not rows_data:
                self.put(scr, iy + 1, ix + 4, "(nothing)", t.text("muted"))
            self.footer_list(scr)
            scr.refresh()
            k = scr.getch()
            if k == 27 and self.swallow_escape(scr):
                continue
            sel = rows_data[cursor] if rows_data else None
            if k in (ord("q"), 27, curses.KEY_LEFT):
                return
            if k in (curses.KEY_DOWN, ord("j")):
                cursor = min(cursor + 1, max(0, n - 1))
            elif k in (curses.KEY_UP, ord("k")):
                cursor = max(0, cursor - 1)
            elif k == curses.KEY_NPAGE:
                cursor = min(cursor + rows, max(0, n - 1))
            elif k == curses.KEY_PPAGE:
                cursor = max(0, cursor - rows)
            elif k in (ord("g"), curses.KEY_HOME):
                cursor = 0
            elif k in (ord("G"), curses.KEY_END):
                cursor = max(0, n - 1)
            elif keys_extra is not None and keys_extra(k):
                cursor = 0
            elif sel is None:
                continue
            elif k in (10, 13, curses.KEY_ENTER, curses.KEY_RIGHT):
                self.go_path(sel[1])
                return
            elif k == ord(" "):
                node = sel[2] or self.node_for_any(sel[1], sel[0])
                if node is not None:
                    self.toggle_mark(node)
                cursor = min(cursor + 1, max(0, n - 1))
            elif k == ord("c"):
                how = copy_to_clipboard(self.ctx, display_path(sel[1]))
                self.status = f"copied {clean_text(display_path(sel[1]))}" + (f" ({how})" if how else "")
            elif k == ord("o"):
                self.status = open_in_file_manager(self.ctx, sel[1])
            elif k == ord("!"):
                self.shell(scr, sel[1])
            elif k in (ord("i"), ord("p")):
                node = sel[2] or self.node_for_any(sel[1], sel[0])
                if node is not None:
                    (self.info_screen if k == ord("i") else self.preview)(scr, node)
            elif k in (ord("D"), curses.KEY_DC):
                if self.marks:
                    targets = list(self.marks.values())
                else:
                    node = sel[2] or self.node_for_any(sel[1], sel[0])
                    targets = [node] if node is not None else []
                self.delete_flow(scr, targets)
            elif k == ord("?"):
                self.help(scr)

    def footer_list(self, scr) -> None:
        msg = self.status
        if self.marks:
            msg = f"[{len(self.marks)} marked, {human(sum(m.size for m in list(self.marks.values())))}]  " + msg
        if self.ctx.dry_run:
            msg = "[DRY RUN] " + msg
        self.tui.status = msg
        self.tui.footer(scr, "Enter show in map  space mark  D delete  c copy  o open  ! shell  i info  p preview  q back")

    def node_for_any(self, path: str, size: int) -> Optional[DNode]:
        """Tree node for path; files not in the tree are attached to their folder."""
        assert self.dmap is not None
        return self.dmap.node_for(path) or self.dmap.materialize(path)

    def levels_screen(self, scr) -> None:
        assert self.dmap is not None and self.cur is not None
        base = self.cur
        state = {"n": 1, "exact": False}
        maxn = max(1, base.max_depth if base.max_depth > 0 else self.dmap.depth_cap)

        def provider():
            def compute():
                nodes = self.dmap.at_depth(base, state["n"], exact=state["exact"], limit=3000)
                return [(x.size, x.path, x, f"L{x.depth - base.depth}") for x in nodes]
            return self.cached(f"lv:{id(base)}:{state['n']}:{state['exact']}", compute)

        def header():
            cmd = f"du -xh --max-depth={state['n']} {display_path(base.path)} | sort -rh"
            return (f"N={state['n']} ({'exactly that depth' if state['exact'] else 'all depths <= N'})   "
                    f"+/- (or Right/H) or 1-9 change N, a toggles exact   equivalent: {cmd}")

        def extra(k: int) -> bool:
            if k in (ord("+"), ord("="), ord("]"), ord(">")):
                state["n"] = min(maxn + 2, state["n"] + 1)
            elif k in (ord("-"), ord("["), ord("<")):
                state["n"] = max(1, state["n"] - 1)
            elif ord("1") <= k <= ord("9"):
                state["n"] = k - ord("0")
            elif k == ord("0"):
                state["n"] = 10
            elif k == ord("a"):
                state["exact"] = not state["exact"]
            else:
                return False
            return True

        # left/right are list navigation elsewhere; here they change N
        def extra_lr(k: int) -> bool:
            if k == curses.KEY_RIGHT:
                return extra(ord("+"))
            if k == curses.KEY_SLEFT or k == ord("H"):
                return extra(ord("-"))
            return extra(k)

        self.path_list_screen(scr, f"Levels below {clean_text(display_path(base.path))}", provider, header, extra_lr,
                              base=base.path)

    def top_dirs_screen(self, scr) -> None:
        assert self.dmap is not None and self.cur is not None
        base = self.cur
        state = {"leaf": True}

        def provider():
            def compute():
                nodes = self.dmap.all_dirs(base, 4000)
                if state["leaf"]:
                    # "where is the space really": folders whose space is not mostly one subfolder
                    keep = []
                    for x in nodes:
                        kids = [c for c in x.kids() if c.is_dir]
                        if not kids or max(c.size for c in kids) < 0.5 * x.size:
                            keep.append(x)
                    nodes = keep
                return [(x.size, x.path, x, f"L{x.depth - base.depth}") for x in nodes[:1500]]
            return self.cached(f"top:{id(base)}:{state['leaf']}", compute)

        def header():
            return ("hot spots: folders whose space is spread over their own content (a toggles all folders)"
                    if state["leaf"] else "all folders at any depth, biggest first (du | sort -rh); a toggles hot spots")

        def extra(k: int) -> bool:
            if k == ord("a"):
                state["leaf"] = not state["leaf"]
                return True
            return False

        self.path_list_screen(scr, f"Top folders under {clean_text(display_path(base.path))}", provider, header, extra,
                              base=base.path)

    def largest_files_screen(self, scr) -> None:
        assert self.dmap is not None and self.cur is not None
        base = self.cur
        holder: dict[str, Any] = {}

        def work() -> str:
            holder["files"] = self.dmap.largest_files(base, 500, lambda p: setattr(self.dmap, "current", p))
            return f"largest files under {clean_text(display_path(base.path))}: {len(holder['files'])} listed"

        if not self.run_bg(f"finding the largest files under {clean_text(base.name)}", work):
            return
        self.wait_bg(scr, "Largest files")
        if "files" not in holder:
            self.status = "still searching in the background; press F again when it is done"
            return
        files = holder["files"]
        self.path_list_screen(
            scr, f"Largest files under {clean_text(display_path(base.path))}",
            lambda: [(s, p, None, age_text(m)) for s, p, m in files if os.path.lexists(p)],
            lambda: f"{len(files)} biggest files (same filesystem); column 4 = age",
            base=base.path)

    # -- help --------------------------------------------------------------------------
    def help(self, scr) -> None:
        d = self.dmap
        lines = [
            "Disk map - where every byte of the disk goes.",
            "",
            "## How the scan works (adaptive surface scan)",
            "  1. survey   ::  a fast walk lists every folder and how deep each path goes",
            "  2. plan     ::  one du job per subtree; big subtrees split so jobs run in parallel",
            f"  3. measure  ::  du -x -k -d N PATH per job, N = depth that path really reaches (cap {d.depth_cap if d else '?'})",
            "  4. refine   ::  opening a folder lists its files; folders marked + are deepened on demand",
            "",
            "## Navigation",
            "  Up/Down j/k  PgUp/PgDn  g/G   ::  move",
            "  Enter / Right / l             ::  open folder, preview file",
            "  Left / h / Backspace / Esc    ::  parent folder",
            "  /                             ::  filter names         s  sort size / name / items / age",
            "",
            "## Views",
            "  v / V      ::  next / previous chart: pie, bars, multi-bar, levels, treemap, info",
            "  Tab        ::  zoom the chart to the full screen",
            "  L          ::  levels: du --max-depth=N | sort -rh for N = 1, 2, 3 ... (+/- or 1-9 change N)",
            "  T          ::  top folders (hot spots) anywhere below      F  largest files below this folder",
            "  i          ::  details of the item    p  preview a file    E  unreadable paths",
            "  t          ::  cycle color theme: dark, light, terminal (transparent), mono - remembered",
            "",
            "## Actions",
            "  c / C      ::  copy the path / all marked paths to the clipboard",
            "  o          ::  open in Finder / file manager      !  shell in that folder (exit returns here)",
            "  space / u  ::  mark or unmark / clear all marks",
            "  D, Delete  ::  delete marked (or highlighted): Trash (recoverable) or permanent",
            "!! System folders, homes and mount points are refused; HIGH risk needs typing 'yes'.",
            "  d          ::  toggle dry-run (simulate deletes; turning it off asks first)",
            "  x / r      ::  deepen the highlighted folder 3 levels / re-measure this folder",
            "  R / M      ::  rescan everything / map another folder or disk",
            "  e          ::  export the tree as JSON + CSV into your home folder",
            "  q          ::  leave the map",
            "",
            "## Reading the screen",
            "  swatch     ::  each item keeps its color in the list, every chart and the list screens",
            "  @fs        ::  another filesystem (Enter maps it)     +  more inside (x deepens)",
            "  !  ~       ::  unreadable / still being measured       ●  marked for deletion",
            "  gauges     ::  green < 75% used, amber 75-90%, red >= 90%",
            "-- Sizes are space used on disk (allocated blocks), like du.",
        ]
        if IS_MAC:
            lines += ["", "## macOS",
                      "-- The map root is the Data volume (/System/Volumes/Data); paths are shown and copied",
                      "-- with their usual names (/Users/..., /Applications/...). Grant Full Disk Access to",
                      "-- the terminal to measure Mail, Messages, Photos libraries and similar."]
        self.tui.message_screen(scr, "Disk map help", lines, rich=True)


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="disk_space.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--scan", action="store_true", help="print a ranked text report and exit")
    p.add_argument("--json", action="store_true", help="print the report as JSON and exit")
    p.add_argument("--list-procedures", action="store_true", help="list procedure ids and exit")
    p.add_argument("--only", default="", help="comma-separated procedure ids to run (default: all)")
    p.add_argument("--apply", action="append", default=[], metavar="FINDING:ACTION",
                   help="run one action non-interactively (repeatable)")
    p.add_argument("--param", action="append", default=[], metavar="KEY=VALUE",
                   help="parameter for --apply actions that need input (repeatable)")
    p.add_argument("--yes", "-y", action="store_true", help="do not ask for confirmation with --apply")
    p.add_argument("--dry-run", "-n", action="store_true", help="simulate: print commands, change nothing")
    p.add_argument("--no-tui", action="store_true", help="never open the curses interface")
    p.add_argument("--no-sudo", action="store_true", help="do not re-run through sudo (limited scan)")
    p.add_argument("--workers", type=int, default=4, help="parallel procedures while scanning (default 4)")
    p.add_argument("--log", default="", help="log file path")
    p.add_argument("--verbose", "-v", action="store_true", help="echo the log to stderr (non-TUI modes)")
    p.add_argument("--version", action="version", version=f"disk_space {VERSION}")
    g = p.add_argument_group("disk map (whole-disk explorer)")
    g.add_argument("--map", nargs="?", const="", default=None, metavar="PATH",
                   help="open the disk map TUI on PATH (default: / on Linux, the Data volume on macOS)")
    g.add_argument("--tree", nargs="?", const="", default=None, metavar="PATH",
                   help="print the size tree of PATH and exit")
    g.add_argument("--levels", nargs="?", const="", default=None, metavar="PATH",
                   help="print 'du -x --max-depth=N PATH | sort -rh' for N = 1..--depth and exit")
    g.add_argument("--map-json", nargs="?", const="", default=None, metavar="PATH",
                   help="print the size tree of PATH as JSON and exit")
    g.add_argument("--engine", choices=["auto", "du", "walk"], default="auto",
                   help="measure with du (default when available) or the python walker")
    g.add_argument("--depth-cap", type=int, default=12,
                   help="deepest level measured in the first pass (default 12; deeper on demand)")
    g.add_argument("--depth", type=int, default=0,
                   help="levels printed by --tree (default 3) / --levels (default 10)")
    g.add_argument("--top", type=int, default=0, help="entries per folder (--tree, default 10) or per level (--levels, default 20)")
    g.add_argument("--min-size", default="0", help="hide folders smaller than this in --tree/--map-json (e.g. 100M)")
    g.add_argument("--min-node", default="256K", help="keep folders >= this size in memory (smaller ones load on demand)")
    g.add_argument("--cross-fs", action="store_true", help="also measure other filesystems mounted below PATH")
    g.add_argument("--no-survey", action="store_true", help="skip the folder survey (faster start, fixed depth)")
    g.add_argument("--map-workers", type=int, default=0, help="parallel du jobs (default: CPUs, max 8)")
    p.add_argument("--theme", choices=THEME_NAMES, default=None,
                   help="color theme for the TUI (default: last used, else dark; t cycles it live)")
    p.add_argument("--_elevated", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--_env", action="append", default=[], help=argparse.SUPPRESS)
    return p.parse_args(argv)


USER_ENV_KEYS = ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
                 "XDG_DATA_HOME", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TMUX", "SSH_TTY")


def map_options(args: argparse.Namespace) -> dict[str, Any]:
    return dict(engine=args.engine, depth_cap=max(1, args.depth_cap), one_fs=not args.cross_fs,
                workers=max(0, args.map_workers), survey=not args.no_survey,
                min_node=parse_size(args.min_node) if args.min_node.strip() not in ("", "0") else 0)


def ensure_root(args: argparse.Namespace) -> None:
    if os.geteuid() == 0 or args.no_sudo or args._elevated:
        return
    sudo = shutil.which("sudo")
    if not sudo:
        print("sudo not found; continuing without root (limited scan, no system actions).", file=sys.stderr)
        return
    python = sys.executable if sys.executable and os.path.exists(sys.executable) else "python3"
    cmd = [sudo, python, SCRIPT_PATH] + sys.argv[1:] + ["--_elevated"]
    # sudo resets the environment; carry the desktop session over for clipboard/open/shell
    for key in USER_ENV_KEYS:
        if os.environ.get(key):
            cmd += ["--_env", f"{key}={os.environ[key]}"]
    print("disk_space needs administrator rights to measure and clean system directories.")
    print("Requesting sudo (use --no-sudo for a limited scan without root)...")
    try:
        rc = subprocess.call(cmd)
    except KeyboardInterrupt:
        rc = 130
    if rc != 0 and rc != 130:
        print(f"\nsudo exited with status {rc}. To continue without root: {os.path.basename(SCRIPT_PATH)} --no-sudo",
              file=sys.stderr)
    sys.exit(rc)


def cli_apply(ctx: Context, scanner: Scanner, executor: Executor, args: argparse.Namespace) -> int:
    params: dict[str, str] = {}
    for kv in args.param:
        if "=" in kv:
            k, v = kv.split("=", 1)
            params[k.strip()] = v.strip()
    wanted = []
    for spec in args.apply:
        if ":" not in spec:
            print(f"--apply expects FINDING:ACTION, got {spec!r}", file=sys.stderr)
            return 2
        wanted.append(tuple(spec.split(":", 1)))
    procs = None
    if args.only:
        procs = [s.strip() for s in args.only.split(",") if s.strip()]
    else:
        # findings usually share the procedure id prefix; scan only those procedures if possible
        guess = {fid.split("-")[0] for fid, _ in wanted} | {fid for fid, _ in wanted}
        hits = [pid for pid in REGISTRY if pid in guess or any(fid.startswith(pid) for fid, _ in wanted)]
        procs = hits or None
    scanner.only = set(procs) if procs else None
    result = scanner.scan(lambda d, t, c: print(f"  scanning {d}/{t}: {c}", file=sys.stderr) if args.verbose else None)
    rc = 0
    for fid, aid in wanted:
        finding = next((f for f in result.findings if f.id == fid), None)
        if finding is None:
            print(f"finding {fid!r} not found (available: {', '.join(f.id for f in result.findings) or 'none'})",
                  file=sys.stderr)
            rc = 1
            continue
        action = finding.action(aid)
        if action is None:
            print(f"action {aid!r} not found on {fid!r} (available: {', '.join(a.id for a in finding.actions)})",
                  file=sys.stderr)
            rc = 1
            continue
        for inp in action.inputs:
            raw = params.get(inp.key, "")
            ok, err, val = inp.validate(raw)
            if not ok:
                print(f"parameter --param {inp.key}=... : {err}", file=sys.stderr)
                rc = 2
                break
            action.params[inp.key] = val
        else:
            print(f"\n{finding.title} :: {action.title}  [{action.risk}]")
            print(textwrap.indent(action.description, "  "))
            for pl in action.preview_lines():
                print("  " + pl)
            for n in action.notes:
                print("  ! " + n)
            if not args.yes and not ctx.dry_run:
                try:
                    ans = input("Proceed? [y/N] " if action.risk != RISK_HIGH else "HIGH RISK. Type 'yes' to proceed: ")
                except (EOFError, KeyboardInterrupt):
                    ans = ""
                if (action.risk == RISK_HIGH and ans.strip().lower() != "yes") or \
                        (action.risk != RISK_HIGH and ans.strip().lower() not in ("y", "yes")):
                    print("cancelled")
                    continue
            res = executor.execute(finding, action, lambda s: print("  " + s))
            print(f"{'OK' if res.ok else 'FAILED'}: {res.message}; freed {human(res.freed)}")
            if res.requires_reboot:
                print("A reboot is required to complete this action.")
            if not res.ok:
                rc = 1
    return rc


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.list_procedures:
        for pid, cls in sorted(REGISTRY.items()):
            print(f"{pid:<24} {cls.category:<24} {cls.title}")
        return 0
    map_text = next((v for v in (args.tree, args.levels, args.map_json) if v is not None), None)
    if map_text is not None and not args._elevated and os.geteuid() != 0 and not args.no_sudo and \
            map_text and os.path.abspath(os.path.expanduser(map_text)).startswith(str(Path.home()) + "/"):
        args.no_sudo = True   # mapping a folder of your own: no need for root
    ensure_root(args)
    ctx = Context(dry_run=args.dry_run, verbose=args.verbose, log_path=args.log or None)
    for kv in args._env:
        if "=" in kv:
            k, v = kv.split("=", 1)
            if k in USER_ENV_KEYS:
                ctx.user_env[k] = v
                if k in ("TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TMUX", "SSH_TTY") and not os.environ.get(k):
                    os.environ[k] = v
    if not args._env:
        ctx.user_env = {k: os.environ[k] for k in USER_ENV_KEYS if os.environ.get(k)}
    if map_text is not None:
        dmap = DiskMap(ctx, map_text or default_map_root(), **map_options(args))
        run_map_cli(ctx, dmap, quiet=not args.verbose and not sys.stderr.isatty())
        if args.map_json is not None:
            print(json.dumps({"summary": dmap.summary(),
                              "tree": dmap.to_dict(dmap.root, args.depth or 64, parse_size(args.min_size))},
                             indent=1, ensure_ascii=False, default=str))
        elif args.levels is not None:
            print(render_levels(dmap, args.depth or 10, args.top or 20))
        else:
            print(render_tree(dmap, args.depth or 3, args.top or 10, parse_size(args.min_size)))
        if dmap.n_errors:
            print(f"\n{dmap.n_errors} paths could not be read"
                  + (" (run with sudo" + (" and give the terminal Full Disk Access" if IS_MAC else "") + ")"
                     if not ctx.is_root or IS_MAC else ""), file=sys.stderr)
        return 0
    if not ctx.is_root:
        ctx.warn("running without root: system directories may be unreadable and most actions are disabled")
    only = [s.strip() for s in args.only.split(",") if s.strip()] or None
    if only:
        unknown = [o for o in only if o not in REGISTRY]
        if unknown:
            print(f"unknown procedure id(s): {', '.join(unknown)}; see --list-procedures", file=sys.stderr)
            return 2
    scanner = Scanner(ctx, only=only, workers=args.workers)
    executor = Executor(ctx)
    if args.apply:
        return cli_apply(ctx, scanner, executor, args)
    text_mode = args.scan or args.json or args.no_tui or not sys.stdout.isatty() or not sys.stdin.isatty()
    if text_mode:
        result = scanner.scan(lambda d, t, c: print(f"  scanning {d}/{t}: {c}", file=sys.stderr) if args.verbose else None)
        print(render_json(ctx, result) if args.json else render_report(ctx, result))
        return 0
    if not os.environ.get("TERM") or os.environ.get("TERM") == "dumb":
        os.environ["TERM"] = "xterm-256color"
    os.environ.setdefault("ESCDELAY", "60")    # Esc reacts at once instead of after 1 s
    global UNICODE_OK
    try:
        locale.setlocale(locale.LC_CTYPE, "")
    except locale.Error:
        pass
    try:
        codeset = locale.nl_langinfo(locale.CODESET)   # what ncurses really uses (not Python's UTF-8 mode)
    except (AttributeError, ValueError):
        codeset = locale.getpreferredencoding(False) or ""
    UNICODE_OK = "utf" in codeset.lower().replace("-", "")
    tui = TUI(ctx, scanner, executor)
    tui.map_opts = map_options(args)
    if args.theme:
        tui.theme = Theme(args.theme)
    # macOS has (almost) nothing for the Linux cleanup procedures: start in the disk map there
    if args.map is not None or (IS_MAC and not args.only):
        try:
            tui.run_map_only(args.map or None)
        except KeyboardInterrupt:
            pass
        print(f"Log written to {ctx.log_path}")
        return 0
    try:
        tui.run()
    except KeyboardInterrupt:
        pass
    except curses.error as exc:
        print(f"curses failed ({exc}); falling back to text report. Try --scan.", file=sys.stderr)
        result = scanner.scan()
        print(render_report(ctx, result))
    if ctx.warnings and args.verbose:
        for w in ctx.warnings:
            print("warning: " + w, file=sys.stderr)
    print(f"Log written to {ctx.log_path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
