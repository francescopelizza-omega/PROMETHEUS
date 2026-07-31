#!/usr/bin/env python3
"""kernel.py — the live Jupyter kernel sidecar (APP-044, notebook backend).

Two modes, one program:

  * ``kernel.py probe``  — a ONE-SHOT, stdlib-only capability check (jupyter_client /
    ipykernel importable? which kernelspecs?). Emits EXACTLY one JSON envelope on
    stdout (the classic C7 contract) so it runs on a bare box with no extra deps.

  * ``kernel.py serve``  — a LONG-LIVED supervisor around a real ipykernel. It reads
    ONE JSON request per stdin line and writes an NDJSON *event stream* to stdout
    (one JSON object per line: ``ready``/``status``/``stream``/``display_data``/
    ``execute_result``/``error``/``vars``/``inspect``/``done``). This DELIBERATELY
    deviates from C7's one-object rule — see CONTRACT.md ## kernel.py — so the bridge
    must parse it with ``spawnKernelSidecar`` (a line reader), NEVER ``parseSidecarObject``.

``jupyter_client``/``ipykernel`` are RUNTIME env deps (the user's active Python), NOT
vendored/new pip installs — imported LAZILY inside ``serve``. Absent → a single
fail-closed error event naming ``pip install jupyter_client ipykernel`` + exit 2.

Guards (fail-closed, never weakened): a launch is REFUSED with an error event when
system CPU/RAM ≥ the 90% guard threshold (the same ceiling the JS telemetry guard
enforces for model pull/serve/install); a per-execute wall-clock cap (default 300s →
auto-interrupt + ``done{status:"aborted"}``); per-message and per-cell cumulative
output caps (truncate with a marked ``stream`` notice) so a runaway print never OOMs.

No orphans: a SIGTERM handler + ``atexit`` shut the kernel down, and stdin EOF is
treated as shutdown — a leaked ipykernel is a separate child process that would
otherwise survive the Electron app.
"""
from __future__ import annotations

import atexit
import json
import os
import platform
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from _envelope import emit, fail, log, opt_value, positional

PROG = "kernel"

# The launch-guard ceiling — mirrors main/telemetry-guard.ts GUARD_THRESHOLD_PCT (90):
# Prometheus never launches heavy work that would saturate the machine.
GUARD_THRESHOLD_PCT = float(os.environ.get("PROMETHEUS_KERNEL_GUARD_PCT", "90"))
# Per-execute wall-clock cap; on expiry we interrupt and report done{status:"aborted"}.
DEFAULT_WALL_CAP_S = float(os.environ.get("PROMETHEUS_KERNEL_WALL_CAP_S", "300"))
# How long to wait for a fresh kernel to report ready.
READY_TIMEOUT_S = float(os.environ.get("PROMETHEUS_KERNEL_READY_TIMEOUT_S", "60"))
# Output caps: a single message payload, and the cumulative bytes relayed per cell.
MAX_MSG_BYTES = 1 * 1024 * 1024
MAX_CELL_BYTES = 16 * 1024 * 1024
# An image mime payload (already base64 in the bundle) is passed through up to this.
MAX_IMAGE_B64_BYTES = 8 * 1024 * 1024
# repr truncation for the vars/inspect introspection verbs.
REPR_CAP = 200
INSPECT_REPR_CAP = 2000

_PIP_HINT = "pip install jupyter_client ipykernel"


# --------------------------------------------------------------------------- #
# NDJSON event emit (serve mode) — one JSON object per line, flushed IMMEDIATELY.
# Python block-buffers a piped stdout, which would defeat incremental streaming;
# flush after every line so two prints-with-a-sleep arrive as separate events.
# --------------------------------------------------------------------------- #

_emit_lock = threading.Lock()


def _event(event: str, **fields: Any) -> None:
    obj: Dict[str, Any] = {"event": event}
    obj.update(fields)
    line = json.dumps(obj, ensure_ascii=False, default=str)
    with _emit_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# --------------------------------------------------------------------------- #
# Resource guard (stdlib-only; reused before every kernel launch).
# --------------------------------------------------------------------------- #


def _ram_pressure_pct() -> Optional[float]:
    """Best-effort used-RAM percent via stdlib + host tools. None if unknowable."""
    try:
        if sys.platform == "linux":
            total = avail = None
            with open("/proc/meminfo", "r", encoding="ascii", errors="replace") as fh:
                for ln in fh:
                    if ln.startswith("MemTotal:"):
                        total = float(ln.split()[1])
                    elif ln.startswith("MemAvailable:"):
                        avail = float(ln.split()[1])
                    if total is not None and avail is not None:
                        break
            if total and avail is not None and total > 0:
                return max(0.0, min(100.0, (1.0 - avail / total) * 100.0))
        elif sys.platform == "darwin":
            total = subprocess.run(
                ["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=4
            )
            vm = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=4)
            total_bytes = float((total.stdout or "0").strip() or 0)
            page = 4096.0
            free_pages = 0.0
            for ln in (vm.stdout or "").splitlines():
                low = ln.lower()
                if "page size of" in low:
                    digits = "".join(ch for ch in ln if ch.isdigit())
                    if digits:
                        page = float(digits)
                # "free" + "inactive" + "speculative" approximate reclaimable memory.
                for key in ("pages free", "pages inactive", "pages speculative"):
                    if low.startswith(key):
                        free_pages += float(ln.rsplit(":", 1)[1].strip().rstrip("."))
            if total_bytes > 0:
                avail_bytes = free_pages * page
                return max(0.0, min(100.0, (1.0 - avail_bytes / total_bytes) * 100.0))
    except Exception:  # noqa: BLE001 — guard math is best-effort, never fatal
        return None
    return None


def _cpu_pressure_pct() -> Optional[float]:
    """Approximate CPU load percent from the 1-min load average / core count."""
    try:
        load1 = os.getloadavg()[0]
        cores = os.cpu_count() or 1
        return max(0.0, min(100.0, (load1 / cores) * 100.0))
    except (OSError, AttributeError):
        return None


def resource_pressure() -> Tuple[Optional[float], Optional[float]]:
    """(cpu_pct, ram_pct) — either may be None when the host can't be measured.

    Honors two TEST/OVERRIDE hooks:
      * ``PROMETHEUS_KERNEL_FORCE_PRESSURE=<pct>`` forces both readings (simulate load).
      * ``PROMETHEUS_KERNEL_SKIP_GUARD=1`` reports 0/0 (bypass in trusted contexts).
    """
    forced = os.environ.get("PROMETHEUS_KERNEL_FORCE_PRESSURE")
    if forced is not None:
        try:
            v = float(forced)
            return v, v
        except ValueError:
            pass
    if os.environ.get("PROMETHEUS_KERNEL_SKIP_GUARD") == "1":
        return 0.0, 0.0
    return _cpu_pressure_pct(), _ram_pressure_pct()


def guard_verdict(threshold: float = GUARD_THRESHOLD_PCT) -> Dict[str, Any]:
    """Fail-closed launch verdict. A None reading does NOT trip (can't measure ≠ busy)."""
    cpu, ram = resource_pressure()
    tripped: List[str] = []
    if cpu is not None and cpu >= threshold:
        tripped.append("cpu")
    if ram is not None and ram >= threshold:
        tripped.append("ram")
    allow = not tripped
    verdict: Dict[str, Any] = {
        "allow": allow,
        "threshold_pct": threshold,
        "cpu_pct": round(cpu, 1) if cpu is not None else None,
        "ram_pct": round(ram, 1) if ram is not None else None,
        "tripped": tripped,
    }
    if not allow:
        parts = []
        if "cpu" in tripped:
            parts.append(f"CPU {verdict['cpu_pct']}%")
        if "ram" in tripped:
            parts.append(f"RAM {verdict['ram_pct']}%")
        verdict["reason"] = (
            f"System under heavy load ({' · '.join(parts)} ≥ {threshold:g}%). "
            "Free resources, then retry — Prometheus won't launch a kernel that would "
            "saturate the machine."
        )
    return verdict


# --------------------------------------------------------------------------- #
# Pure protocol helpers (testable without jupyter_client).
# --------------------------------------------------------------------------- #


def parse_request(line: str) -> Optional[Dict[str, Any]]:
    """Parse ONE stdin request line → dict, or None for blank/garbage (skip it)."""
    s = (line or "").strip()
    if not s:
        return None
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or "op" not in obj:
        return None
    return obj


def truncate_text(text: str, cap: int) -> Tuple[str, bool]:
    """Byte-cap a string (UTF-8). Returns (possibly-truncated text, was_truncated)."""
    if text is None:
        return "", False
    raw = text.encode("utf-8", "replace")
    if len(raw) <= cap:
        return text, False
    return raw[:cap].decode("utf-8", "ignore"), True


def clamp_repr(value: Any, cap: int = REPR_CAP) -> str:
    """repr(value) truncated to ``cap`` chars with an ellipsis marker."""
    try:
        r = repr(value)
    except Exception as exc:  # noqa: BLE001 — a broken __repr__ must not kill introspection
        r = f"<unreprable {type(value).__name__}: {exc}>"
    return r if len(r) <= cap else r[: cap - 1] + "…"


# The user-namespace snapshot, built INSIDE the kernel as a SILENT statement block (defines
# `__prom_vars`) then read by a user_expression — so no iopub pollution. Excluded: dunder /
# `_`-prefixed names, modules/functions/classes/builtins, and the IPython helpers. Each var's
# repr is bounded by reprlib (recursion-safe) and a hard cap; a __repr__ that RAISES still
# yields a row ("<unrepresentable: …>") — never drops the whole snapshot. size duck-types
# numpy `.nbytes` / pandas `.memory_usage(deep=True)` before shallow `sys.getsizeof`.
_VARS_READ = "__import__('json').dumps(__prom_vars)"
_VARS_CODE = (
    "def __prom_size(__v):\n"
    "    try:\n"
    "        __nb = getattr(__v, 'nbytes', None)\n"
    "        if isinstance(__nb, int): return int(__nb)\n"
    "    except Exception: pass\n"
    "    try:\n"
    "        __mu = getattr(__v, 'memory_usage', None)\n"
    "        if callable(__mu):\n"
    "            __s = __mu(deep=True)\n"
    "            __sm = getattr(__s, 'sum', None)\n"
    "            return int(__sm()) if callable(__sm) else int(__s)\n"
    "    except Exception: pass\n"
    "    try: return int(__import__('sys').getsizeof(__v))\n"
    "    except Exception: return 0\n"
    "def __prom_vrepr(__v):\n"
    "    try:\n"
    "        __rp = __import__('reprlib').Repr()\n"
    "        __rp.maxstring = 200; __rp.maxother = 200; __rp.maxlist = 20\n"
    "        __rp.maxdict = 20; __rp.maxtuple = 20; __rp.maxset = 20\n"
    "        __s = __rp.repr(__v)\n"
    "    except Exception as __e:\n"
    "        return '<unrepresentable: ' + type(__e).__name__ + '>'\n"
    "    return __s if len(__s) <= 200 else __s[:199] + '\\u2026'\n"
    "__prom_vars = []\n"
    "for __k, __v in list(globals().items()):\n"
    "    if __k.startswith('_'): continue\n"
    "    if __k in ('In', 'Out', 'exit', 'quit', 'get_ipython', 'open'): continue\n"
    "    __ins = __import__('inspect')\n"
    "    if __ins.ismodule(__v) or __ins.isfunction(__v) or __ins.isclass(__v) or __ins.isbuiltin(__v):\n"
    "        continue\n"
    "    __prom_vars.append({'name': __k, 'type': type(__v).__name__,"
    " 'repr': __prom_vrepr(__v), 'size': __prom_size(__v)})\n"
)

# Capture open matplotlib figures to base64 PNGs after each execute (SciView, APP-088).
# Runs as a SILENT statement block (defines __prom_plots) then a user_expression reads it.
# Fail-soft: no matplotlib → []. Figures are CLOSED after so they never re-emit next cell.
_PLOT_CAPTURE_CODE = (
    "import io as __io, base64 as __b64\n"
    "__prom_plots = []\n"
    "try:\n"
    "    import matplotlib.pyplot as __plt\n"
    "    for __n in __plt.get_fignums():\n"
    "        __buf = __io.BytesIO()\n"
    "        __plt.figure(__n).savefig(__buf, format='png', dpi=100)\n"
    "        __prom_plots.append(__b64.b64encode(__buf.getvalue()).decode('ascii'))\n"
    "    __plt.close('all')\n"
    "except Exception:\n"
    "    __prom_plots = []\n"
)


def _dataframe_code(name: str, offset: int, limit: int) -> str:
    """A silent statement block setting `__prom_df` to a paged view of globals()[name].
    Duck-types pandas (.iloc/.columns), a list-of-dicts, a 2D list, else a scalar. NaN/±Inf
    cells become None (JSON.parse rejects bare NaN/Infinity); rows are ORDERED lists."""
    lit = json.dumps(name)
    off = int(offset)
    lim = max(1, min(int(limit), 1000))
    return (
        "import math as __m\n"
        "def __prom_clean(__v):\n"
        "    if isinstance(__v, float) and (__m.isnan(__v) or __m.isinf(__v)): return None\n"
        "    if __v is None or isinstance(__v, (str, int, float, bool)): return __v\n"
        "    try: return repr(__v)[:200]\n"
        "    except Exception: return '<unrepresentable>'\n"
        "def __prom_page(__name, __off, __lim):\n"
        "    if __name not in globals(): return {'found': False}\n"
        "    __o = globals()[__name]\n"
        "    if hasattr(__o, 'iloc') and hasattr(__o, 'columns'):\n"
        "        __cols = [str(__c) for __c in list(__o.columns)]\n"
        "        __sl = __o.iloc[__off:__off + __lim]\n"
        "        __rows = [[__prom_clean(__x) for __x in __r] "
        "for __r in __sl.itertuples(index=False, name=None)]\n"
        "        return {'found': True, 'columns': __cols, 'rows': __rows, 'totalRows': int(len(__o))}\n"
        "    if isinstance(__o, list) and __o and isinstance(__o[0], dict):\n"
        "        __cols = [str(__c) for __c in __o[0].keys()]\n"
        "        __keys = list(__o[0].keys())\n"
        "        __rows = [[__prom_clean(__d.get(__k)) for __k in __keys] "
        "for __d in __o[__off:__off + __lim]]\n"
        "        return {'found': True, 'columns': __cols, 'rows': __rows, 'totalRows': len(__o)}\n"
        "    if isinstance(__o, list) and __o and isinstance(__o[0], (list, tuple)):\n"
        "        __ncol = max((len(__r) for __r in __o), default=0)\n"
        "        __cols = [str(__i) for __i in range(__ncol)]\n"
        "        __rows = [[__prom_clean(__x) for __x in __r] for __r in __o[__off:__off + __lim]]\n"
        "        return {'found': True, 'columns': __cols, 'rows': __rows, 'totalRows': len(__o)}\n"
        "    return {'found': True, 'columns': ['value'], 'rows': [[__prom_clean(__o)]], 'totalRows': 1}\n"
        f"__prom_df = __prom_page({lit}, {off}, {lim})\n"
    )


def _inspect_expr(name: str) -> str:
    """Single eval expression returning JSON detail for ONE variable (or a not-found marker)."""
    lit = json.dumps(name)
    return (
        "__import__('json').dumps("
        f"{{'name':{lit},'found':({lit} in globals()),"
        f"'type':(type(globals()[{lit}]).__name__ if {lit} in globals() else None),"
        f"'repr':(repr(globals()[{lit}])[:2000] if {lit} in globals() else None),"
        f"'doc':((getattr(globals()[{lit}],'__doc__',None) or None) if {lit} in globals() else None)}})"
    )


def _decode_user_expression(reply_content: Dict[str, Any], key: str) -> Any:
    """Pull a `user_expressions[key]` text/plain repr out of a shell reply and JSON-decode it."""
    import ast

    ue = (reply_content or {}).get("user_expressions", {})
    entry = ue.get(key, {})
    if entry.get("status") != "ok":
        raise RuntimeError(str(entry.get("evalue") or entry.get("ename") or "expr failed"))
    text = entry.get("data", {}).get("text/plain", "")
    # text/plain is repr(json_string) → a quoted Python string literal; unwrap then parse.
    return json.loads(ast.literal_eval(text))


# --------------------------------------------------------------------------- #
# The live kernel supervisor (serve mode). jupyter_client is imported lazily.
# --------------------------------------------------------------------------- #


class KernelServer:
    def __init__(self, kernel_name: str, wall_cap_s: float) -> None:
        self._kernel_name = kernel_name
        self._wall_cap_s = wall_cap_s
        self._km: Any = None
        self._kc: Any = None
        self._shutdown = threading.Event()
        # interrupt requested for the CURRENTLY running cell (set by the reader thread).
        self._interrupt = threading.Event()
        self._exec_lock = threading.Lock()  # execute/restart/vars/inspect are serialized

    # -- lifecycle ---------------------------------------------------------- #

    def start(self) -> None:
        from jupyter_client import KernelManager  # lazy: runtime env dep

        self._km = KernelManager(kernel_name=self._kernel_name)
        self._km.start_kernel()
        self._kc = self._km.client()
        self._kc.start_channels()
        self._kc.wait_for_ready(timeout=READY_TIMEOUT_S)
        atexit.register(self._safe_shutdown)
        _event("ready", kernel=self._kernel_name, execution_count=1)

    def _safe_shutdown(self) -> None:
        km = self._km
        if km is None:
            return
        self._km = None
        try:
            if self._kc is not None:
                self._kc.stop_channels()
        except Exception:  # noqa: BLE001
            pass
        try:
            km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001 — shutdown is best-effort; we still want no orphan
            pass

    def shutdown(self) -> None:
        self._shutdown.set()
        self._safe_shutdown()

    # -- control ops (may be invoked from the reader thread mid-execute) ----- #

    def interrupt(self) -> None:
        """SIGINT to the KERNEL process (POSIX) / Windows interrupt event — NOT to us.

        The supervisor (this process) stays alive; only the running cell is aborted.
        """
        self._interrupt.set()
        km = self._km
        if km is not None:
            try:
                km.interrupt_kernel()
            except Exception as exc:  # noqa: BLE001
                log("interrupt failed:", exc)

    def restart(self) -> None:
        with self._exec_lock:
            km = self._km
            if km is None:
                return
            try:
                km.restart_kernel(now=True)
                self._kc.wait_for_ready(timeout=READY_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001
                _event("error", id=None, fatal=False, error=f"restart failed: {exc}")
                return
            self._interrupt.clear()
            _event("ready", kernel=self._kernel_name, execution_count=1)

    # -- execute ------------------------------------------------------------ #

    def execute(self, cell_id: Optional[str], code: str) -> None:
        with self._exec_lock:
            self._interrupt.clear()
            self._drain_stale_iopub()
            msg_id = self._kc.execute(code, allow_stdin=False)
            self._relay_cell(cell_id, msg_id)
            # APP-088 scientific mode: after every cell, refresh the Variables window and
            # collect any figures into SciView — no polling, one snapshot per execution.
            self._emit_vars()
            self._capture_plots(cell_id)

    def _drain_stale_iopub(self) -> None:
        """Discard any iopub backlog from a prior cell before starting a new one."""
        from queue import Empty

        while True:
            try:
                self._kc.get_iopub_msg(timeout=0)
            except Empty:
                return
            except Exception:  # noqa: BLE001
                return

    def _relay_cell(self, cell_id: Optional[str], msg_id: str) -> None:
        from queue import Empty

        deadline = time.monotonic() + self._wall_cap_s
        grace_added = False
        cell_bytes = 0
        cell_truncated = False
        ename = evalue = None
        traceback: Optional[List[str]] = None
        execution_count: Optional[int] = None
        aborted_by = None  # "interrupt" | "timeout"

        def note_bytes(n: int) -> bool:
            """Track cumulative cell bytes; emit ONE truncation notice at the ceiling."""
            nonlocal cell_bytes, cell_truncated
            if cell_truncated:
                return False
            cell_bytes += n
            if cell_bytes > MAX_CELL_BYTES:
                cell_truncated = True
                _event(
                    "stream",
                    id=cell_id,
                    name="stderr",
                    text=f"\n[output truncated: cell exceeded {MAX_CELL_BYTES // (1024 * 1024)} MiB]\n",
                )
                return False
            return True

        while True:
            if self._shutdown.is_set():
                break
            now = time.monotonic()
            if self._interrupt.is_set() and aborted_by is None:
                aborted_by = "interrupt"
            if now > deadline:
                if aborted_by is None:
                    aborted_by = "timeout"
                    self.interrupt()  # SIGINT the cell; give it a grace window to unwind
                if not grace_added:
                    grace_added = True
                    deadline = now + 5.0
                else:
                    break  # ignored the interrupt (tight C loop) → hard stop; caller may restart
            try:
                msg = self._kc.get_iopub_msg(timeout=0.2)
            except Empty:
                continue
            except Exception as exc:  # noqa: BLE001
                _event("error", id=cell_id, fatal=False, error=f"iopub read failed: {exc}")
                break

            parent = (msg.get("parent_header") or {}).get("msg_id")
            if parent != msg_id:
                continue  # a stray message from unrelated activity — filter by parent
            mtype = msg.get("msg_type")
            content = msg.get("content") or {}

            if mtype == "stream":
                text, cut = truncate_text(str(content.get("text", "")), MAX_MSG_BYTES)
                if note_bytes(len(text.encode("utf-8", "replace"))) or cut:
                    if not cell_truncated:
                        _event("stream", id=cell_id, name=content.get("name", "stdout"), text=text)
            elif mtype in ("execute_result", "display_data"):
                data = self._cap_mime_bundle(dict(content.get("data") or {}))
                if note_bytes(sum(len(str(v)) for v in data.values())):
                    _event(
                        mtype,
                        id=cell_id,
                        data=data,
                        execution_count=content.get("execution_count"),
                    )
            elif mtype == "error":
                ename = content.get("ename")
                evalue = content.get("evalue")
                traceback = content.get("traceback")
                _event(
                    "error",
                    id=cell_id,
                    fatal=False,
                    ename=ename,
                    evalue=evalue,
                    traceback=traceback,
                )
            elif mtype == "execute_input":
                execution_count = content.get("execution_count")
            elif mtype == "status" and content.get("execution_state") == "idle":
                break  # authoritative "cell done" — idle status whose parent is our msg_id

        # Authoritative status + execution_count come from the shell reply.
        status = "error" if ename else "ok"
        try:
            reply = self._get_shell_reply(msg_id, timeout=5.0)
            if reply is not None:
                rc = reply.get("content") or {}
                status = rc.get("status", status)
                execution_count = rc.get("execution_count", execution_count)
        except Exception:  # noqa: BLE001
            pass
        if aborted_by is not None:
            status = "aborted"
        _event(
            "done",
            id=cell_id,
            status=status,
            execution_count=execution_count,
            ename=ename,
            evalue=evalue,
            traceback=traceback,
            aborted_by=aborted_by,
            truncated=cell_truncated,
        )

    def _get_shell_reply(self, msg_id: str, timeout: float) -> Optional[Dict[str, Any]]:
        from queue import Empty

        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                reply = self._kc.get_shell_msg(timeout=max(0.05, end - time.monotonic()))
            except Empty:
                return None
            except Exception:  # noqa: BLE001
                return None
            if (reply.get("parent_header") or {}).get("msg_id") == msg_id:
                return reply
        return None

    def _cap_mime_bundle(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Size-cap each mime payload; images (already base64) pass through to a ceiling."""
        out: Dict[str, Any] = {}
        for mime, payload in data.items():
            if isinstance(payload, str) and mime.startswith("image/"):
                if len(payload) > MAX_IMAGE_B64_BYTES:
                    out["text/plain"] = f"[image {mime} dropped: {len(payload)} b64 bytes > cap]"
                    continue
                out[mime] = payload
            elif isinstance(payload, str):
                text, _cut = truncate_text(payload, MAX_MSG_BYTES)
                out[mime] = text
            else:
                out[mime] = payload
        return out

    # -- introspection ------------------------------------------------------ #

    def vars(self) -> None:
        with self._exec_lock:
            self._emit_vars()

    def _emit_vars(self) -> None:
        """Snapshot the user namespace → a `vars` event (NO lock — callers hold it)."""
        try:
            content = self._silent_code_expr(_VARS_CODE, {"vars": _VARS_READ})
            variables = _decode_user_expression(content, "vars")
        except Exception as exc:  # noqa: BLE001
            _event("error", id=None, fatal=False, error=f"vars failed: {exc}")
            return
        # server-side repr cap (defense in depth; the code block already caps at 200).
        for v in variables:
            if isinstance(v.get("repr"), str) and len(v["repr"]) > REPR_CAP:
                v["repr"] = v["repr"][: REPR_CAP - 1] + "…"
        _event("vars", vars=variables)

    def _capture_plots(self, cell_id: Optional[str]) -> None:
        """Emit any open matplotlib figures as base64 PNGs (SciView). NO lock — callers hold it."""
        try:
            content = self._silent_code_expr(
                _PLOT_CAPTURE_CODE, {"plots": "__import__('json').dumps(__prom_plots)"}
            )
            images = _decode_user_expression(content, "plots")
        except Exception:  # noqa: BLE001 — plot capture is best-effort, never fatal
            return
        images = [im for im in images if isinstance(im, str) and len(im) <= MAX_IMAGE_B64_BYTES]
        if images:
            _event("plots", id=cell_id, plots=images)

    def dataframe(self, name: str, offset: int, limit: int) -> None:
        """Page a DataFrame-like variable → a `dataframe` event (found/columns/rows/totalRows)."""
        with self._exec_lock:
            try:
                content = self._silent_code_expr(
                    _dataframe_code(name, offset, limit),
                    {"df": "__import__('json').dumps(__prom_df)"},
                )
                page = _decode_user_expression(content, "df")
            except Exception as exc:  # noqa: BLE001
                _event("error", id=None, fatal=False, error=f"dataframe failed: {exc}")
                return
            _event("dataframe", name=name, offset=offset, **page)

    def _silent_code_expr(self, code: str, exprs: Dict[str, str]) -> Dict[str, Any]:
        """Run `code` SILENTLY (defines helper globals) then eval `exprs` → the reply content."""
        msg_id = self._kc.execute(
            code, silent=True, store_history=False, allow_stdin=False, user_expressions=exprs
        )
        reply = self._get_shell_reply(msg_id, timeout=15.0)
        if reply is None:
            raise RuntimeError("no shell reply")
        return reply.get("content") or {}

    def inspect(self, name: str) -> None:
        with self._exec_lock:
            try:
                content = self._silent_user_expressions({"info": _inspect_expr(name)})
                detail = _decode_user_expression(content, "info")
            except Exception as exc:  # noqa: BLE001
                _event("error", id=None, fatal=False, error=f"inspect failed: {exc}")
                return
            _event("inspect", **detail)

    def _silent_user_expressions(self, exprs: Dict[str, str]) -> Dict[str, Any]:
        """A silent, history-less execute carrying `user_expressions` → the shell reply content."""
        msg_id = self._kc.execute(
            "", silent=True, store_history=False, allow_stdin=False, user_expressions=exprs
        )
        reply = self._get_shell_reply(msg_id, timeout=10.0)
        if reply is None:
            raise RuntimeError("no shell reply")
        return reply.get("content") or {}

    # -- request routing ---------------------------------------------------- #

    def handle(self, req: Dict[str, Any]) -> None:
        op = req.get("op")
        if op == "execute":
            self.execute(req.get("id"), str(req.get("code", "")))
        elif op == "restart":
            self.restart()
        elif op == "vars":
            self.vars()
        elif op == "inspect":
            self.inspect(str(req.get("name", "")))
        elif op == "dataframe":
            self.dataframe(
                str(req.get("name", "")), int(req.get("offset", 0) or 0), int(req.get("limit", 100) or 100)
            )
        elif op in ("interrupt", "shutdown"):
            pass  # handled inline by the reader thread; never reaches the work queue
        else:
            _event("error", id=req.get("id"), fatal=False, error=f"unknown op '{op}'")


# --------------------------------------------------------------------------- #
# serve driver: a reader thread (control ops act immediately) + a work loop.
# --------------------------------------------------------------------------- #


def _serve(argv: Sequence[str]) -> int:
    kernel_name = opt_value(argv, "--kernel") or "python3"
    wall_cap = DEFAULT_WALL_CAP_S
    raw_cap = opt_value(argv, "--wall-cap-s")
    if raw_cap:
        try:
            wall_cap = max(1.0, float(raw_cap))
        except ValueError:
            pass

    # Guard FIRST — before importing jupyter_client — so the refusal runs on a bare box.
    verdict = guard_verdict()
    if not verdict["allow"]:
        _event("error", id=None, fatal=True, error=verdict["reason"], guard=verdict)
        return 2

    # Lazy dep check: a missing runtime dep is a single fail-closed event + exit 2.
    try:
        import jupyter_client  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        _event(
            "error",
            id=None,
            fatal=True,
            error=f"jupyter_client is not installed in this Python — {_PIP_HINT}",
            detail=str(exc),
            hint=_PIP_HINT,
        )
        return 2

    server = KernelServer(kernel_name, wall_cap)
    try:
        server.start()
    except Exception as exc:  # noqa: BLE001
        _event("error", id=None, fatal=True, error=f"kernel failed to start: {exc}", hint=_PIP_HINT)
        server.shutdown()
        return 2

    # SIGTERM → clean shutdown (no orphan ipykernel survives the app).
    def _on_term(_signo: int, _frame: Any) -> None:
        server.shutdown()

    try:
        signal.signal(signal.SIGTERM, _on_term)
    except (ValueError, OSError):
        pass  # not on the main thread / unsupported — atexit still covers us

    from queue import Empty, Queue

    work: "Queue[Dict[str, Any]]" = Queue()

    def _reader() -> None:
        try:
            for line in sys.stdin:
                req = parse_request(line)
                if req is None:
                    continue
                op = req.get("op")
                if op == "interrupt":
                    server.interrupt()  # act NOW, even mid-execute
                    continue
                if op == "shutdown":
                    server.shutdown()
                    return
                work.put(req)
        except Exception as exc:  # noqa: BLE001
            log("reader thread error:", exc)
        finally:
            server.shutdown()  # stdin EOF == shutdown

    reader = threading.Thread(target=_reader, name="kernel-stdin-reader", daemon=True)
    reader.start()

    try:
        while not server._shutdown.is_set():  # noqa: SLF001 — driver owns the server
            try:
                req = work.get(timeout=0.25)
            except Empty:
                continue
            server.handle(req)
    finally:
        server.shutdown()
    return 0


# --------------------------------------------------------------------------- #
# probe: one-shot, stdlib-only capability report (classic single-envelope C7).
# --------------------------------------------------------------------------- #


def _probe(_argv: Sequence[str]) -> int:
    def _importable(mod: str) -> bool:
        try:
            __import__(mod)
            return True
        except Exception:  # noqa: BLE001 — a broken install counts as unavailable
            return False

    has_jc = _importable("jupyter_client")
    has_ipk = _importable("ipykernel")
    kernelspecs: List[str] = []
    if has_jc:
        try:
            from jupyter_client.kernelspec import KernelSpecManager

            kernelspecs = sorted(KernelSpecManager().find_kernel_specs().keys())
        except Exception as exc:  # noqa: BLE001
            log("kernelspec scan failed:", exc)
    ready = has_jc and has_ipk
    return emit(
        "kernel.probe",
        ready=ready,
        jupyter_client=has_jc,
        ipykernel=has_ipk,
        kernelspecs=kernelspecs,
        python_version=platform.python_version(),
        hint=None if ready else _PIP_HINT,
    )


def _guard(_argv: Sequence[str]) -> int:
    """Expose the launch-guard verdict as a one-shot envelope (diagnostics / pre-flight)."""
    v = guard_verdict()
    return emit("kernel.guard", **v)


def _version(_argv: Sequence[str]) -> int:
    return emit("version", version="1.0.0")


HANDLERS: Dict[str, Callable[[Sequence[str]], int]] = {
    "probe": _probe,
    "kernel.probe": _probe,
    "guard": _guard,
    "kernel.guard": _guard,
    "version": _version,
}


def main(argv: Sequence[str]) -> int:
    args = list(argv)
    if not args:
        return fail(PROG, "no verb given; expected one of: serve, probe, guard, version")
    verb = args[0]
    if verb in ("serve", "kernel.serve"):
        return _serve(args[1:])
    handler = HANDLERS.get(verb)
    if handler is None:
        return fail(verb, f"unknown verb '{verb}'; expected: serve, probe, guard, version")
    try:
        return handler(args[1:])
    except Exception as exc:  # noqa: BLE001 — fail-closed: always one envelope on stdout
        import traceback as _tb

        log("traceback:", _tb.format_exc())
        return fail(verb, f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
