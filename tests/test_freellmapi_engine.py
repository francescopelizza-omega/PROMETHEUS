"""test_freellmapi_engine.py — the FreeLLMAPI gateway and the external-services watch.

Nothing here reaches the network or the real FreeLLMAPI: the gate is a stub, the "repo" is a git
repository made in a temp folder, processes are `python -c sleep`, and every registry/quarantine
file lives under tmp_path. The live run these mirror (2026-10-30, v0.16.12) is in the comments.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load_prom():
    spec = importlib.util.spec_from_file_location("prom_freellmapi", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prom_freellmapi"] = mod
    spec.loader.exec_module(mod)
    return mod


prom = _load_prom()

CRIT = {"verdict": "block", "risk_score": 100, "severity_counts": {"CRITICAL": 2, "HIGH": 5},
        "top_findings": [
            {"severity": "CRITICAL", "path": "/x/package-lock.json",
             "snippet": "zod@3.25.76 CVE-2023-54404 (CRITICAL) fixed:4.6.6"},
            {"severity": "CRITICAL", "path": "/x/package-lock.json",
             "snippet": "zod@3.25.76 CVE-2023-54404 (CRITICAL) fixed:4.6.6"},
        ],
        "blocking_reasons": ["SCA-OSV-CRITICAL @ /x/package-lock.json"]}
WARN = {"verdict": "warn", "risk_score": 40, "severity_counts": {"CRITICAL": 0, "HIGH": 3},
        "top_findings": [{"severity": "HIGH", "snippet": "vite@8.2.2 CVE-x (HIGH)"}]}


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """Point every services path at tmp_path and keep the detached watcher from starting."""
    sv = tmp_path / "services"
    for name, val in {"SERVICES_DIR": sv, "SERVICES_REGISTRY": sv / "registry.json",
                      "SERVICES_QUARANTINE": sv / "quarantine.json", "SERVICES_CAPS": sv / "caps.json",
                      "SERVICES_WATCH_PID": sv / "watch.pid", "SERVICES_WATCH_LOG": sv / "watch.log",
                      "FREELLMAPI_ROOT": sv / "freellmapi"}.items():
        monkeypatch.setattr(prom, name, val)
    monkeypatch.setenv("PROMETHEUS_SERVICE_WATCH", "off")
    monkeypatch.delenv("PROMETHEUS_SERVICE_RAM_MB", raising=False)
    return tmp_path


# ── the strict gate ────────────────────────────────────────────────────────────────────

def test_any_critical_refuses_and_every_reading_is_one_line():
    ok, why, crit = prom._service_gate_decision(CRIT)
    assert ok is False and "CRITICAL" in why
    assert crit[0].startswith("zod@3.25.76 CVE-2023-54404") and len(crit) == 2   # deduped + "(+1 more)"
    assert "more CRITICAL" in crit[1]


def test_a_critical_refuses_even_when_the_verdict_itself_is_permissive():
    # stricter than nemesis's own verdict: a CRITICAL in a class nemesis only warns on still refuses
    ok, _, _ = prom._service_gate_decision({"verdict": "warn", "severity_counts": {"CRITICAL": 1}})
    assert ok is False


def test_an_unverifiable_scan_and_a_block_refuse_a_warn_installs():
    assert prom._service_gate_decision({"verdict": "error", "error": "timeout"})[0] is False
    assert prom._service_gate_decision({"verdict": "block", "blocking_reasons": ["EXFIL"]})[0] is False
    ok, why, crit = prom._service_gate_decision(WARN)
    assert ok is True and crit == [] and "HIGH" in why
    assert prom._service_gate_decision({"verdict": "allow"})[0] is True


def _tiny_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "upstream"
    (repo / "server" / "src" / "__tests__").mkdir(parents=True)
    (repo / "docs").mkdir()
    (repo / "cli").mkdir()
    (repo / "server" / "src" / "index.ts").write_text("export {};\n")
    (repo / "server" / "src" / "__tests__" / "a.test.ts").write_text("x\n")
    (repo / "docs" / "install.sh").write_text("curl -fsSL https://x.example | bash\n")
    (repo / "README.md").write_text("# x\n")
    (repo / "package-lock.json").write_text("{}\n")
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}
    for argv in (["git", "init", "-q"], ["git", "add", "-A"], ["git", "commit", "-qm", "x"],
                 ["git", "tag", "v9.9.9"]):
        subprocess.run(argv, cwd=repo, env=env, check=True, capture_output=True)
    return repo


def test_install_refusal_installs_nothing_and_no_gate_mode_skips_it(home, monkeypatch):
    repo = _tiny_repo(home)
    seen: list = []

    def gate(target, tier="default", stdin_text=None):
        tree = Path(target)
        seen.append(sorted(str(p.relative_to(tree)) for p in tree.rglob("*") if p.is_file()))
        return CRIT

    monkeypatch.setattr(prom, "nemesis_gate", gate)
    monkeypatch.setattr(prom, "GATE_MODE", "off")         # the global off-switch does NOT apply
    monkeypatch.setattr(prom, "FREELLMAPI_REPO", f"file://{repo}")
    monkeypatch.setattr(prom, "_freellmapi_check", lambda: {"ok": True, "node": "/x/node", "npm": "/x/npm",
                                                            "node_version": "v22.0.0"})
    monkeypatch.setattr(prom, "_gate_audit", lambda *a, **k: None)
    paths = prom._freellmapi_paths()
    res = prom._freellmapi_install("v9.9.9", paths)
    assert res["ok"] is False and res["stage"] == "gate"
    assert res["gate"]["critical"][0].startswith("zod@3.25.76")
    assert len(seen) == 1, "the gate must run exactly once, even with PROMETHEUS_GATE=off"
    # the gate saw exactly what would be installed: no docs, no tests, no CLI, no README
    assert seen[0] == ["package-lock.json", "server/src/index.ts"]
    assert not paths["app"].exists() and not paths["root"].exists()


# ── RAM watch: a spike never kills, a sustained overrun does ───────────────────────────

def test_ram_strikes_need_consecutive_overruns():
    s, stop = prom._ram_strike(900, 512, 0)
    assert (s, stop) == (1, False)
    s, stop = prom._ram_strike(100, 512, s)            # back under: the spike is forgotten
    assert (s, stop) == (0, False)
    for i in range(1, prom.SERVICE_RAM_STRIKES + 1):
        s, stop = prom._ram_strike(900, 512, s)
        assert stop is (i == prom.SERVICE_RAM_STRIKES)
    assert prom._ram_strike(10_000, 0, 5) == (0, False), "cap 0 = not RAM-watched"


def test_the_tree_rss_counts_workers_but_not_strangers():
    table = {100: (1, 1000), 101: (100, 500), 102: (101, 250), 200: (1, 9999)}
    assert prom._tree_rss_kb(100, table) == 1750


def test_stop_never_signals_pid_1_itself_or_a_recycled_pid(monkeypatch):
    sent: list = []
    monkeypatch.setattr(prom.os, "kill", lambda *a: sent.append(a))
    monkeypatch.setattr(prom.os, "killpg", lambda *a: sent.append(a))
    assert prom._svc_stop({"pid": 1, "stamp": "x"}, "t") is False
    assert prom._svc_stop({"pid": os.getpid(), "stamp": prom._proc_stamp(os.getpid())}, "t") is False
    # a pid whose start time no longer matches is someone else's process now
    assert prom._svc_stop({"pid": os.getppid(), "stamp": "Mon Jan  1 00:00:00 1990"}, "t") is False
    assert sent == []


def test_a_detached_service_is_registered_watched_and_stopped(home):
    log = home / "svc.log"
    rc = prom._run_detached([sys.executable, "-c", "import time; time.sleep(60)"], home, log,
                            service="demo", lockfiles=[home / "package-lock.json"])
    assert rc == 0
    e = prom._svc_read(prom.SERVICES_REGISTRY)["demo"]
    assert e["stamp"] and e["ram_cap_mb"] == prom.SERVICE_RAM_CAP_MB_DEFAULT
    assert prom._svc_alive(e)
    assert prom._svc_stop(e, "test") is True
    assert not prom._svc_alive(e)
    prom.watch_services(once=True)                     # a dead entry is forgotten, not signalled
    assert "demo" not in prom._svc_read(prom.SERVICES_REGISTRY)
    assert "GONE demo" in prom.SERVICES_WATCH_LOG.read_text()


def test_a_critical_advisory_quarantines_an_unverified_reading_does_nothing(home, monkeypatch):
    lock = home / "package-lock.json"
    lock.write_text("{}")
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
    try:
        prom.service_register("svc", p.pid, lockfiles=[lock])
        monkeypatch.setattr(prom, "nemesis_gate", lambda *a, **k: {"verdict": "error", "error": "boom"})
        prom.watch_services(once=True)
        assert p.poll() is None, "a scanner error must never kill a healthy service"
        assert prom.service_quarantine("svc") is None
        reg = prom._svc_read(prom.SERVICES_REGISTRY)
        reg["svc"]["advisory_checked_at"] = 0
        prom._svc_write(prom.SERVICES_REGISTRY, reg)
        monkeypatch.setattr(prom, "nemesis_gate", lambda *a, **k: CRIT)
        prom.watch_services(once=True)
        p.wait(timeout=15)
        q = prom.service_quarantine("svc")
        assert q and q["reason"] == "critical-advisory" and "zod" in q["details"][0]
    finally:
        if p.poll() is None:
            p.kill()


def test_caps_override_order(home, monkeypatch):
    assert prom._service_cap_mb("a") == prom.SERVICE_RAM_CAP_MB_DEFAULT
    assert prom._service_cap_mb("a", "docker") == prom.SERVICE_DOCKER_RAM_CAP_MB_DEFAULT
    assert prom._service_cap_mb("a", default=512) == 512
    monkeypatch.setenv("PROMETHEUS_SERVICE_RAM_MB", "3000")
    assert prom._service_cap_mb("a", default=512) == 3000
    prom._svc_write(prom.SERVICES_CAPS, {"a": 256})
    assert prom._service_cap_mb("a", default=512) == 256


# ── FreeLLMAPI specifics ───────────────────────────────────────────────────────────────

def _fake_node(d: Path, version: str) -> str:
    p = d / f"node-{version}"
    p.write_text(f"#!/bin/sh\necho {version}\n")
    p.chmod(0o755)
    return str(p)


def test_node_pick_prefers_22_and_respects_the_engines_range(tmp_path):
    cands = [_fake_node(tmp_path, v) for v in ("v26.10.0", "v25.0.0", "v24.1.0", "v22.23.3", "v20.17.0")]
    assert prom._freellmapi_node(cands) == (cands[3], "v22.23.3")
    assert prom._freellmapi_node([cands[0], cands[1], cands[4]]) is None, "26/25 refused, 20.17 < 20.18"
    assert prom._freellmapi_node([cands[2], cands[4]])[1] == "v24.1.0"


def test_env_file_is_private_and_the_key_is_never_rotated(home):
    paths = prom._freellmapi_paths()
    envp = prom._freellmapi_env_file(paths)
    assert stat.S_IMODE(envp.stat().st_mode) == 0o600
    assert stat.S_IMODE(paths["data"].stat().st_mode) == 0o700
    key1 = prom._read_env_file(envp)["ENCRYPTION_KEY"]
    assert len(key1) == 64 and int(key1, 16) >= 0
    prom._freellmapi_env_file(paths)
    assert prom._read_env_file(envp)["ENCRYPTION_KEY"] == key1


def test_the_server_always_binds_loopback_and_never_sees_the_users_secrets(home, monkeypatch):
    paths = prom._freellmapi_paths()
    prom._freellmapi_env_file(paths)
    with open(paths["env"], "a") as fh:
        fh.write("HOST=0.0.0.0\nPORT=80\n")             # a hand edit cannot widen the bind
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("NODE_ENV", "development")
    env = prom._freellmapi_server_env(paths, "/opt/x/bin/node")
    assert env["HOST"] == "127.0.0.1" and env["PORT"] == "3001" and env["NODE_ENV"] == "production"
    assert "OPENAI_API_KEY" not in env
    assert env["PATH"].startswith("/opt/x/bin" + os.pathsep)
    assert "ENCRYPTION_KEY" in env                      # its own key, from its own file


def test_loopback_check():
    assert prom._loopback_only(["127.0.0.1:3001", "[::1]:3001"])
    assert not prom._loopback_only(["*:3001"])
    assert not prom._loopback_only(["127.0.0.1:3001", "192.168.1.5:3001"])
    assert not prom._loopback_only([])


def test_key_summary_flags_anonymous_rows_and_several_accounts(home):
    paths = prom._freellmapi_paths()
    paths["data"].mkdir(parents=True)
    con = sqlite3.connect(paths["db"])
    con.execute("CREATE TABLE settings (key TEXT, value TEXT)")
    con.execute("INSERT INTO settings VALUES ('unified_api_key', 'freellmapi-abc')")
    con.execute("CREATE TABLE api_keys (platform TEXT, enabled INTEGER)")
    con.executemany("INSERT INTO api_keys VALUES (?, ?)",
                    [("groq", 1), ("groq", 1), ("cerebras", 1), ("kilo", 1), ("mistral", 0)])
    con.commit()
    con.close()
    assert prom._freellmapi_unified_key(paths) == "freellmapi-abc"
    s = prom._freellmapi_key_summary(paths)
    assert s["platforms"] == {"groq": 2, "cerebras": 1, "kilo": 1}
    assert s["anonymous"] == ["kilo"] and s["several_keys"] == ["groq"]


def test_quarantine_blocks_start_until_a_reinstall_clears_it(home):
    prom.quarantine_service("freellmapi", "critical-advisory", ["zod@3.25.76 CVE-2023-54404"])
    res = prom._freellmapi_start(prom._freellmapi_paths())
    assert res["ok"] is False and "quarantined" in res["error"] and "zod" in res["error"]
    prom.clear_quarantine("freellmapi")
    assert prom.service_quarantine("freellmapi") is None


def test_the_cli_surface():
    p = prom.build_parser()
    a = p.parse_args(["freellmapi", "setup", "--ref", "v1.2.3"])
    assert a.command == "freellmapi" and a.action == "setup" and a.ref == "v1.2.3"
    assert p.parse_args(["freellmapi"]).action == "status"
    s = p.parse_args(["services", "cap", "freellmapi", "768"])
    assert (s.action, s.name, s.mb) == ("cap", "freellmapi", "768")
    with pytest.raises(SystemExit):
        p.parse_args(["freellmapi", "force-install"])
