# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""tmux compatibility mode in the engine: `chat --cli X --open --tmux` without a usable tmux.

tmux is optional. Without it, the `--tmux` launch used to stop with "tmux not found — install
tmux or drop --tmux" (exit 2). It now opens the same engine-built argv in this terminal and
says why. Nothing here launches anything: `os.execvpe` and `_tmux_launch` are replaced, and the
replacement records the argv it would have run.
"""
from __future__ import annotations

import argparse
import subprocess
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load_prom():
    spec = importlib.util.spec_from_file_location("prom_tmux_compat", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prom_tmux_compat"] = mod
    spec.loader.exec_module(mod)
    return mod


prom = _load_prom()


class _Launched(Exception):
    """Raised by the fake exec so the test sees the launch without the process being replaced."""


def _args(**over) -> argparse.Namespace:
    base = dict(message=[], local=None, cli="claude", effort=None, force_effort=False, model=None,
                system_prompt=None, replace_system=False, bypass=False, tmux="", cwd=None,
                open=True, runner=None)
    base.update(over)
    return argparse.Namespace(**base)


@pytest.fixture
def no_launch(monkeypatch):
    seen: dict = {}

    def fake_exec(file, argv, env):
        seen["exec"] = list(argv)
        raise _Launched()

    def fake_tmux(session, argv, env):
        seen["tmux"] = (session, list(argv))
        raise _Launched()

    monkeypatch.setattr(prom.os, "execvpe", fake_exec)
    monkeypatch.setattr(prom, "_tmux_launch", fake_tmux)
    monkeypatch.setattr(prom, "JSON_OUT", False)
    monkeypatch.setattr(prom, "DRY_RUN", False)
    return seen


def test_reason_is_none_only_when_tmux_is_installed_allowed_and_not_nested(monkeypatch):
    monkeypatch.delenv("PROMETHEUS_NO_TMUX", raising=False)
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setattr(prom.shutil, "which", lambda b: "/usr/bin/tmux" if b == "tmux" else None)
    assert prom._tmux_compat_reason() is None

    monkeypatch.setenv("TMUX", "/tmp/tmux-501/default,1,0")
    assert "inside tmux" in prom._tmux_compat_reason()
    monkeypatch.delenv("TMUX")

    monkeypatch.setenv("PROMETHEUS_NO_TMUX", "1")
    assert "PROMETHEUS_NO_TMUX" in prom._tmux_compat_reason()
    monkeypatch.delenv("PROMETHEUS_NO_TMUX")

    monkeypatch.setattr(prom.shutil, "which", lambda b: None)
    assert "not installed" in prom._tmux_compat_reason()


def test_open_tmux_without_tmux_opens_the_chat_here_instead_of_refusing(monkeypatch, no_launch):
    monkeypatch.delenv("PROMETHEUS_NO_TMUX", raising=False)
    monkeypatch.delenv("TMUX", raising=False)
    real_which = prom.shutil.which
    monkeypatch.setattr(prom.shutil, "which", lambda b, *a, **k: None if b == "tmux" else real_which(b, *a, **k))
    with pytest.raises(_Launched):
        prom.cmd_chat(_args(), None)
    assert "tmux" not in no_launch, "tried to start tmux on a machine without it"
    expected, _, _ = prom.build_terminal_cmd("claude", model=None, system_prompt_file=None,
                                             replace_system=False, bypass=False, prompt=None, cwd=None)
    assert no_launch["exec"] == expected, "compatibility mode must run the SAME engine-built argv"


def test_open_tmux_with_tmux_still_uses_tmux(monkeypatch, no_launch):
    monkeypatch.delenv("PROMETHEUS_NO_TMUX", raising=False)
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setattr(prom.shutil, "which", lambda b, *a, **k: "/usr/bin/" + b)
    with pytest.raises(_Launched):
        prom.cmd_chat(_args(tmux="work"), None)
    assert no_launch.get("tmux", (None,))[0] == "work"
    assert "exec" not in no_launch


def test_no_tmux_flag_forces_compatibility_mode_even_with_tmux_installed(monkeypatch, no_launch):
    # `chat … --no-tmux` was an argparse error: the README promised it, only the env var existed.
    monkeypatch.delenv("PROMETHEUS_NO_TMUX", raising=False)  # restored after the test
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setattr(prom.shutil, "which", lambda b, *a, **k: "/usr/bin/" + b)
    with pytest.raises(_Launched):
        prom.cmd_chat(_args(tmux="work", no_tmux=True), None)
    assert "tmux" not in no_launch
    assert "exec" in no_launch
    assert prom.os.environ.get("PROMETHEUS_NO_TMUX") == "1", "children must see the same switch"


def test_the_parser_accepts_no_tmux():
    ns = prom.build_parser().parse_args(["chat", "--cli", "claude", "--open", "--tmux", "--no-tmux"])
    assert ns.no_tmux is True


def test_a_tmux_that_cannot_start_the_session_opens_the_chat_here(monkeypatch, no_launch):
    monkeypatch.delenv("PROMETHEUS_NO_TMUX", raising=False)
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setattr(prom.shutil, "which", lambda b, *a, **k: "/usr/bin/" + b)
    monkeypatch.setattr(prom, "_tmux_launch", lambda session, argv, env: None)
    with pytest.raises(_Launched):
        prom.cmd_chat(_args(tmux="work"), None)
    assert "exec" in no_launch, "a refused tmux must still open the chat"


def _tmux_world(monkeypatch, *, new_session_rc=0, attach_rc=0, attach_secs=0.0, exists=False):
    ran: list[list[str]] = []

    def fake_run_timed(cmd, *, timeout, **kw):
        ran.append(list(cmd))
        rc = 0
        if cmd[1] == "has-session":
            rc = 0 if exists else 1
        elif cmd[1] == "new-session":
            rc = new_session_rc
        return subprocess.CompletedProcess(cmd, rc, "", "no server" if rc else "")

    clock = iter([100.0, 100.0 + attach_secs])

    def fake_call(cmd):
        ran.append(list(cmd))
        return attach_rc

    monkeypatch.setattr(prom, "_run_timed", fake_run_timed)
    monkeypatch.setattr(prom.subprocess, "call", fake_call)
    monkeypatch.setattr(prom.time, "monotonic", lambda: next(clock))
    return ran


def test_tmux_launch_new_session_refused_returns_none_and_never_attaches(monkeypatch):
    ran = _tmux_world(monkeypatch, new_session_rc=1)
    assert prom._tmux_launch("work", ["claude"], {}) is None
    assert not any(c[:2] == ["tmux", "attach"] for c in ran)


def test_tmux_launch_attach_refused_at_once_kills_the_session_it_made(monkeypatch):
    ran = _tmux_world(monkeypatch, attach_rc=1, attach_secs=0.1)
    assert prom._tmux_launch("work", ["claude"], {}) is None
    assert ["tmux", "kill-session", "-t", "work"] in ran


def test_tmux_launch_a_session_that_ran_returns_its_code(monkeypatch):
    ran = _tmux_world(monkeypatch, attach_rc=1, attach_secs=120.0)
    assert prom._tmux_launch("work", ["claude"], {}) == 1
    assert ["tmux", "kill-session", "-t", "work"] not in ran


def test_tmux_launch_never_kills_a_session_it_did_not_create(monkeypatch):
    ran = _tmux_world(monkeypatch, exists=True, attach_rc=1, attach_secs=0.1)
    assert prom._tmux_launch("work", ["claude"], {}) is None
    assert ["tmux", "kill-session", "-t", "work"] not in ran
