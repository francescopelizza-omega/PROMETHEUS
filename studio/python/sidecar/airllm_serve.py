#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""airllm_serve.py — Prometheus's OpenAI-compatible server around AirLLM, on loopback only.

AirLLM (github.com/lyogavin/airllm) is a library: it runs a dense model one transformer layer
at a time from disk, so a model several times larger than RAM still answers — at seconds to
minutes per token. It has no server, so a Prometheus session could not adopt it. This file is
that server, started by the session (`runtime-argv --runtime airllm`) inside the gated AirLLM
venv, and nothing else.

Hard rules, each because of something AirLLM itself does (source read 2026-11-04, v4.0.0):
  * Offline before import. AirLLM downloads with `snapshot_download` when handed a repo id;
    it is only ever handed a local directory, and HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE are set
    before `airllm` is imported so nothing in it can reach the network.
  * No code, no auto_map, no pickles in the model directory. AirLLM loads its config and
    tokenizer with `trust_remote_code=True` unconditionally; with no Python file and no
    `auto_map` there is nothing for that flag to load. The directory is the nemesis-admitted
    snapshot (checked again by the session before start); this file re-checks it before load.
  * Loopback only, and a Host-header check against DNS rebinding.
  * One generation at a time (a second request waits): two concurrent layer sweeps would each
    page the whole model through RAM.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

for _k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
    os.environ[_k] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

_CODE_EXTS = (".py", ".pyc", ".so", ".dylib", ".dll", ".pyd", ".sh", ".exe")
_PICKLE_EXTS = (".bin", ".pt", ".pth", ".ckpt", ".pkl", ".pickle", ".joblib")
_LOOPBACK = ("127.0.0.1", "localhost", "::1")
_MAX_BODY = 8 * 1024 * 1024


def refusal(model_dir: Path, layers: Optional[Path] = None) -> Optional[str]:
    """Why this directory must not be loaded by AirLLM, or None. A consolidated snapshot (its
    weights freed into the layer split — the sidecar verified that split, signed, before it
    built this argv) has no .safetensors left; it is accepted only with a complete split."""
    if not model_dir.is_dir():
        return f"{model_dir} is not a directory"
    files = [p for p in model_dir.rglob("*") if p.is_file()]
    code = [p.name for p in files if p.suffix.lower() in _CODE_EXTS]
    if code:
        return f"the model directory ships code ({', '.join(code[:3])})"
    if any(p.suffix.lower() in _PICKLE_EXTS for p in files):
        return "the model directory holds pickle weights"
    if not any(p.suffix == ".safetensors" for p in files):
        consolidated = (layers is not None and (model_dir / "model.safetensors.index.json").is_file()
                        and bool(_layer_files(layers)) and layers_ok(layers))
        if not consolidated:
            return "no .safetensors weights in the model directory"
    for name in ("config.json", "tokenizer_config.json"):
        f = model_dir / name
        if not f.is_file():
            continue
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return f"{name} is unreadable"
        if isinstance(doc, dict) and doc.get("auto_map"):
            return f"{name} declares auto_map (custom model code)"
    return None


_LAYERS_RECORD = ".prometheus-layers.json"


def _layer_files(layers: Path) -> List[Path]:
    return sorted(p for p in layers.rglob("*") if p.is_file() and p.name != _LAYERS_RECORD)


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def layers_ok(layers: Path) -> bool:
    """False when an existing layer split no longer matches the record written when it was
    made (True when there is no split yet: AirLLM will make one from the admitted snapshot)."""
    files = _layer_files(layers) if layers.is_dir() else []
    if not files:
        return True
    try:
        rec = json.loads((layers / _LAYERS_RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    want = rec.get("sha256") if isinstance(rec, dict) else None
    if not isinstance(want, dict) or len(want) != len(files):
        return False
    for p in files:
        rel = str(p.relative_to(layers))
        if want.get(rel) != _sha256(p):
            return False
    return True


def record_layers(layers: Path) -> None:
    files = _layer_files(layers)
    if not files:
        return
    rec = {"sha256": {str(p.relative_to(layers)): _sha256(p) for p in files}}
    (layers / _LAYERS_RECORD).write_text(json.dumps(rec), encoding="utf-8")


def prompt_text(tok: Any, messages: List[Dict[str, Any]]) -> str:
    """The chat template when the tokenizer has one; a plain transcript otherwise."""
    flat = []
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):  # OpenAI content parts: keep the text ones
            content = "".join(str(p.get("text", "")) for p in content if isinstance(p, dict))
        flat.append({"role": str(m.get("role", "user")), "content": str(content or "")})
    try:
        return tok.apply_chat_template(flat, add_generation_prompt=True, tokenize=False)
    except Exception:  # noqa: BLE001 — no template: fall back to a readable transcript
        return "".join(f"{m['role']}: {m['content']}\n" for m in flat) + "assistant: "


class Engine:
    def __init__(self, model_dir: Path, ctx: int, layers: Path) -> None:
        from airllm import AutoModel  # imported only after the offline env is set

        layers.mkdir(parents=True, exist_ok=True)
        self.model = AutoModel.from_pretrained(str(model_dir), max_seq_len=ctx,
                                               layer_shards_saving_path=str(layers))
        self.tok = self.model.tokenizer
        self.ctx = ctx
        self.mlx = "mlx" in type(self.model).__name__.lower()
        self.lock = threading.Lock()

    def generate(self, messages: List[Dict[str, Any]], max_new: int) -> Dict[str, Any]:
        text = prompt_text(self.tok, messages)
        with self.lock:
            if self.mlx:
                import mlx.core as mx  # AirLLM's Apple Silicon path takes an mx.array

                enc = self.tok([text], return_tensors="np")
                ids = enc["input_ids"]
                n_in = int(ids.shape[1])
                if n_in + max_new > self.ctx:
                    raise ValueError(f"prompt is {n_in} tokens; the window is {self.ctx}")
                out = self.model.generate(mx.array(ids), max_new_tokens=max_new, use_cache=True,
                                          return_dict_in_generate=True)
            else:
                enc = self.tok([text], return_tensors="pt", padding=False)
                ids = enc["input_ids"]
                n_in = int(ids.shape[1])
                if n_in + max_new > self.ctx:
                    raise ValueError(f"prompt is {n_in} tokens; the window is {self.ctx}")
                out = self.model.generate(ids, max_new_tokens=max_new, use_cache=True,
                                          return_dict_in_generate=True)
        if isinstance(out, str):
            answer = out
            n_out = len(self.tok(answer)["input_ids"]) if answer else 0
        else:
            seq = out.sequences[0] if hasattr(out, "sequences") else out[0]
            new = list(seq)[n_in:]
            answer = self.tok.decode(new, skip_special_tokens=True)
            n_out = len(new)
        return {"text": answer, "prompt_tokens": n_in, "completion_tokens": n_out}


def make_handler(engine: Engine, alias: str, port: int, max_new_cap: int):
    allowed_hosts = {f"{h}:{port}" for h in ("127.0.0.1", "localhost", "[::1]")}

    class Handler(BaseHTTPRequestHandler):
        server_version = "prometheus-airllm/1"

        def log_message(self, fmt: str, *args: Any) -> None:  # quiet: the session owns output
            return

        def _guard(self) -> bool:
            if self.headers.get("Host", "") not in allowed_hosts:
                self._json(403, {"error": {"message": "forbidden host", "type": "forbidden"}})
                return False
            return True

        def _json(self, code: int, body: Dict[str, Any]) -> None:
            raw = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            if not self._guard():
                return
            if self.path in ("/health", "/v1/health"):
                self._json(200, {"status": "ok", "model": alias})
            elif self.path == "/v1/models":
                self._json(200, {"object": "list", "data": [
                    {"id": alias, "object": "model", "owned_by": "airllm",
                     "context_length": engine.ctx}]})
            else:
                self._json(404, {"error": {"message": "not found", "type": "not_found"}})

        def do_POST(self) -> None:  # noqa: N802
            if not self._guard():
                return
            if self.path != "/v1/chat/completions":
                self._json(404, {"error": {"message": "not found", "type": "not_found"}})
                return
            try:
                n = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                n = -1
            if n <= 0 or n > _MAX_BODY:
                self._json(400, {"error": {"message": "bad request body", "type": "invalid_request"}})
                return
            try:
                req = json.loads(self.rfile.read(n).decode("utf-8"))
                messages = req["messages"]
                if not isinstance(messages, list) or not messages:
                    raise ValueError("messages must be a non-empty list")
            except (ValueError, KeyError, TypeError) as exc:
                self._json(400, {"error": {"message": f"bad request: {exc}", "type": "invalid_request"}})
                return
            want = req.get("max_tokens") or req.get("max_completion_tokens") or 256
            try:
                max_new = max(1, min(int(want), max_new_cap))
            except (TypeError, ValueError):
                max_new = 256
            cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
            created = int(time.time())
            if req.get("stream"):
                self._stream(cid, created, messages, max_new)
                return
            try:
                r = engine.generate(messages, max_new)
            except ValueError as exc:
                self._json(400, {"error": {"message": str(exc), "type": "context_length_exceeded"}})
                return
            except Exception as exc:  # noqa: BLE001 — report, never crash the server
                self._json(500, {"error": {"message": f"generation failed: {exc}", "type": "server_error"}})
                return
            self._json(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": alias,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": r["text"]}}],
                "usage": {"prompt_tokens": r["prompt_tokens"],
                          "completion_tokens": r["completion_tokens"],
                          "total_tokens": r["prompt_tokens"] + r["completion_tokens"]},
            })

        def _stream(self, cid: str, created: int, messages: List[Dict[str, Any]], max_new: int) -> None:
            """AirLLM returns the whole answer at once; a stream sends a comment every 10 s
            while it works, so the client knows the server is alive during a minutes-long turn."""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            def chunk(delta: Dict[str, Any], finish: Optional[str] = None) -> bytes:
                body = {"id": cid, "object": "chat.completion.chunk", "created": created,
                        "model": alias, "choices": [{"index": 0, "delta": delta,
                                                     "finish_reason": finish}]}
                return f"data: {json.dumps(body)}\n\n".encode("utf-8")

            result: Dict[str, Any] = {}

            def work() -> None:
                try:
                    result.update(engine.generate(messages, max_new))
                except Exception as exc:  # noqa: BLE001
                    result["error"] = str(exc)

            t = threading.Thread(target=work, daemon=True)
            try:
                self.wfile.write(chunk({"role": "assistant"}))
                self.wfile.flush()
                t.start()
                while t.is_alive():
                    t.join(10)
                    if t.is_alive():
                        self.wfile.write(b": generating\n\n")
                        self.wfile.flush()
                if "error" in result:
                    self.wfile.write(chunk({"content": f"[AirLLM error: {result['error']}]"}, "stop"))
                else:
                    self.wfile.write(chunk({"content": result.get("text", "")}))
                    self.wfile.write(chunk({}, "stop"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return  # the client gave up; the generation finishes and is discarded

    return Handler


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(prog="airllm_serve", description=__doc__.splitlines()[0])
    ap.add_argument("--model", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8094)
    ap.add_argument("--alias", required=True)
    ap.add_argument("--ctx", type=int, default=4096)
    ap.add_argument("--layers", required=True, help="where AirLLM writes its per-layer split")
    ap.add_argument("--max-new", type=int, default=1024)
    a = ap.parse_args(argv)
    if a.host not in _LOOPBACK:
        print("airllm_serve: refusing a non-loopback bind", file=sys.stderr)
        return 2
    model_dir = Path(a.model).expanduser().resolve()
    layers = Path(a.layers).expanduser().resolve()
    if model_dir == layers or model_dir in layers.parents:
        # the split must not land inside the admitted directory: it would change its files
        print("airllm_serve: --layers must be outside the model directory", file=sys.stderr)
        return 2
    why = refusal(model_dir, layers)
    if why:
        print(f"airllm_serve: refused — {why}", file=sys.stderr)
        return 2
    if not layers_ok(layers) and not any(model_dir.glob("*.safetensors")):
        print("airllm_serve: refused — the layer split changed and the original weights were "
              "already freed into it; download the model again", file=sys.stderr)
        return 2
    if not layers_ok(layers):
        # AirLLM reuses an existing split without checking it; a split that changed since it was
        # written is discarded and re-made from the admitted snapshot
        shutil.rmtree(layers, ignore_errors=True)
    engine = Engine(model_dir, a.ctx, layers)
    record_layers(layers)
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(engine, a.alias, a.port, a.max_new))
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
