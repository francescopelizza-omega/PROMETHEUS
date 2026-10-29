"""test_local_runners_engine.py — the engine's local chat against Ollama AND LM Studio.

Real sockets, fake servers: nothing is loaded and no real runner is contacted. Every server
here binds 127.0.0.1 on a random port and answers the way the real one was measured to
(LM Studio app bundle `Bionic.app`, 2026-10-22).
"""
from __future__ import annotations

import http.server
import importlib.util
import json
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_prom():
    spec = importlib.util.spec_from_file_location("prom_local_runners", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prom_local_runners"] = mod
    spec.loader.exec_module(mod)
    return mod


prom = _load_prom()


class Server:
    """Routes `METHOD /path` → (status, body, content-type). Records what was POSTed."""

    def __init__(self, routes: dict):
        self.posted: list = []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def _answer(self, method: str):
                n = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(n) if n else b""
                if method == "POST":
                    outer.posted.append(json.loads(raw or b"{}"))
                key = f"{method} {self.path}"
                status, body, ctype = routes.get(
                    key,
                    (200, {"error": f"Unexpected endpoint or method. ({method} {self.path})"}, "application/json"),
                )
                payload = body if isinstance(body, (bytes, str)) else json.dumps(body)
                payload = payload.encode() if isinstance(payload, str) else payload
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):  # noqa: N802
                self._answer("GET")

            def do_POST(self):  # noqa: N802
                self._answer("POST")

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}/v1"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.srv.shutdown()


def sse(*frames: dict) -> str:
    return "".join(f"data: {json.dumps(f)}\n\n" for f in frames) + "data: [DONE]\n\n"


V1_MODELS = {"models": [
    {"type": "llm", "key": "nvidia/nemotron-3-nano-omni", "size_bytes": 26104736555,
     "loaded_instances": [], "max_context_length": 262144},
    {"type": "embedding", "key": "text-embedding-nomic-embed-text-v1.5", "size_bytes": 84106624,
     "loaded_instances": []},
]}


def run_chat(monkeypatch, capsys, runner: str, srv: Server, model: str, json_out: bool = True):
    monkeypatch.setitem(prom.CHAT_LOCAL_ENDPOINTS, runner, srv.base)
    monkeypatch.setattr(prom, "_ensure_ollama_daemon", lambda: True)
    monkeypatch.setattr(prom, "JSON_OUT", json_out)
    rc = prom.chat_local(model, "hi", runner=runner)
    out = capsys.readouterr().out
    return rc, (json.loads(out) if json_out and out.strip().startswith("{") else out)


def test_a_streamed_reply_is_read_and_lmstudio_gets_ttl_not_keep_alive(monkeypatch, capsys):
    reply = sse({"choices": [{"delta": {"content": "Hel"}}]},
                {"choices": [{"delta": {"content": "lo"}, "finish_reason": "stop"}]})
    with Server({"GET /api/v1/models": (200, V1_MODELS, "application/json"),
                 "POST /v1/chat/completions": (200, reply, "text/event-stream")}) as srv:
        monkeypatch.delenv("PROMETHEUS_LOCAL_KEEP_ALIVE", raising=False)
        rc, env = run_chat(monkeypatch, capsys, "lmstudio", srv, "nvidia/nemotron-3-nano-omni")
    assert rc == 0 and env["response"] == "Hello"
    sent = srv.posted[-1]
    assert sent["stream"] is True
    assert sent.get("ttl") == 60, "LM Studio's JIT model stayed resident for its 60-minute default"
    assert "keep_alive" not in sent


def test_ollama_keeps_keep_alive(monkeypatch, capsys):
    reply = sse({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]})
    with Server({"POST /v1/chat/completions": (200, reply, "text/event-stream")}) as srv:
        monkeypatch.delenv("PROMETHEUS_LOCAL_KEEP_ALIVE", raising=False)
        rc, _ = run_chat(monkeypatch, capsys, "ollama", srv, "qwen3.6:latest")
    assert rc == 0
    assert srv.posted[-1].get("keep_alive") == "60s" and "ttl" not in srv.posted[-1]


def test_a_non_streamed_body_from_a_server_that_ignores_stream_still_works(monkeypatch, capsys):
    body = {"choices": [{"message": {"content": "whole"}, "finish_reason": "stop"}]}
    with Server({"POST /v1/chat/completions": (200, body, "application/json")}) as srv:
        rc, env = run_chat(monkeypatch, capsys, "ollama", srv, "m")
    assert rc == 0 and env["response"] == "whole"


def test_the_JSON_error_says_WHAT_happened_not_unreachable(monkeypatch, capsys):
    overflow = {"error": "The number of tokens to keep from the initial prompt is greater than the context length"}
    with Server({"GET /api/v1/models": (200, V1_MODELS, "application/json"),
                 "POST /v1/chat/completions": (400, overflow, "application/json")}) as srv:
        rc, env = run_chat(monkeypatch, capsys, "lmstudio", srv, "nvidia/nemotron-3-nano-omni")
    assert rc == 1
    assert env["error_kind"] == "overflow"
    assert "context length" in env["error"]
    assert "unreachable" not in env["error"]


def test_a_load_cut_short_is_named_not_just_rejected(monkeypatch, capsys):
    # the live 400 LM Studio sent when a memory watchdog unloaded the model mid-load (2026-10-29)
    aborted = {"error": 'Failed to load model "nvidia/nemotron-3-nano-omni". '
                        "Error: Engine protocol startup was aborted."}
    with Server({"GET /api/v1/models": (200, V1_MODELS, "application/json"),
                 "POST /v1/chat/completions": (400, aborted, "application/json")}) as srv:
        rc, env = run_chat(monkeypatch, capsys, "lmstudio", srv, "nvidia/nemotron-3-nano-omni")
    assert rc == 1
    assert env["error_kind"] == "load-failed"
    assert "memory" in prom._runner_hint("lmstudio", "m", "load-failed")


def test_a_reasoning_only_reply_is_not_a_failure(monkeypatch, capsys):
    reply = sse({"choices": [{"delta": {"reasoning_content": "thinking…"}}]},
                {"choices": [{"delta": {"content": None}, "finish_reason": "stop"}]})
    with Server({"POST /v1/chat/completions": (200, reply, "text/event-stream")}) as srv:
        rc, env = run_chat(monkeypatch, capsys, "ollama", srv, "m")
    assert rc == 0
    assert env["response"] == ""
    assert env.get("reasoning") == "thinking…"


def test_an_error_frame_mid_stream_is_reported(monkeypatch, capsys):
    reply = "data: " + json.dumps({"error": {"message": "model crashed"}}) + "\n\n"
    with Server({"POST /v1/chat/completions": (200, reply, "text/event-stream")}) as srv:
        rc, env = run_chat(monkeypatch, capsys, "ollama", srv, "m")
    assert rc == 1 and env["error"] == "model crashed"


def test_lmstudio_listing_knows_chat_vs_embedding_and_loaded(monkeypatch):
    loaded = json.loads(json.dumps(V1_MODELS))
    loaded["models"][0]["loaded_instances"] = [{"id": "nvidia/nemotron-3-nano-omni"}]
    with Server({"GET /api/v1/models": (200, loaded, "application/json")}) as srv:
        ms = prom._lmstudio_models(srv.base)
    assert [(m["id"], m["type"], m["loaded"]) for m in ms] == [
        ("nvidia/nemotron-3-nano-omni", "llm", True),
        ("text-embedding-nomic-embed-text-v1.5", "embedding", False),
    ]
    # an Ollama-route error body (HTTP 200) is NOT an LM Studio listing
    with Server({}) as srv:
        assert prom._lmstudio_models(srv.base) is None


def test_an_ollama_route_answered_by_lmstudio_is_not_ollama_up(monkeypatch):
    with Server({}) as srv:  # every route: HTTP 200 + "Unexpected endpoint"
        monkeypatch.setitem(prom.CHAT_LOCAL_ENDPOINTS, "ollama", srv.base)
        monkeypatch.setattr(prom.shutil, "which", lambda b: None)  # never spawn a real daemon
        assert prom._ensure_ollama_daemon() is False


def test_opencode_with_a_bare_model_id_gets_a_local_provider(monkeypatch):
    monkeypatch.setattr(prom.shutil, "which", lambda b: f"/usr/bin/{b}")
    argv, env, notes = prom.build_terminal_cmd("opencode", model="qwen3:8b", prompt="go")
    assert argv[argv.index("-m") + 1] == "prometheus-local/qwen3:8b"
    cfg = json.loads(env["OPENCODE_CONFIG_CONTENT"])
    assert cfg["provider"]["prometheus-local"]["options"]["baseURL"] == prom.CHAT_LOCAL_ENDPOINTS["ollama"]
    # a provider/model id is opencode's own, through its own login
    argv2, env2, _ = prom.build_terminal_cmd("opencode", model="anthropic/claude-sonnet-4", prompt="go")
    assert argv2[argv2.index("-m") + 1] == "anthropic/claude-sonnet-4" and not env2


def test_tmux_does_not_swallow_the_prompt():
    import argparse
    captured = {}

    def fake_terminal(args, *a, **k):
        captured["tmux"] = args.tmux
        captured["message"] = list(args.message)
        return 0

    ns = argparse.Namespace(message=["--open"], local=None, cli="claude", tmux="fix the bug",
                            effort=None, force_effort=False, model=None, system_prompt=None,
                            replace_system=False, bypass=False, cwd=None, open=False, runner=None)
    # only the rescue is under test: stop right after it
    orig = prom.CHAT_CLIS
    try:
        prom.cmd_chat.__globals__["CHAT_CLIS"] = {}
        prom.JSON_OUT = True
        prom.cmd_chat(ns, None)
    except Exception:  # noqa: BLE001 — the route after the rescue is not under test
        pass
    finally:
        prom.cmd_chat.__globals__["CHAT_CLIS"] = orig
    assert ns.tmux == ""
    assert ns.message[0] == "fix the bug"
    named = argparse.Namespace(message=[], tmux="work", local=None, cli=None)
    try:
        prom.cmd_chat(named, None)
    except Exception:  # noqa: BLE001
        pass
    assert named.tmux == "work", "a one-token name stays a name"


def test_the_docker_ollama_is_published_on_loopback_only():
    src = (ROOT / "prometheus.py").read_text()
    assert '"-p", "127.0.0.1:11434:11434"' in src
    assert '"-p", "11434:11434"' not in src
