# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_effort_python.py — the Python `/think` ladder, and its PARITY with TypeScript.

Phase 7 of the effort plan: `prometheus.py` sent one request body with no reasoning
fields at all, so `--effort` did not exist on the Python side and a local chat could
not ask a thinking model to think.

The point of these tests is not that the Python resolver runs — it is that it agrees
with the TypeScript one, model for model. Two implementations of one table is exactly
the drift this subsystem has been bitten by before (a private copy of the emulation
prompt map made `/think` misreport for months), so the table is authored once in TS,
published to JSON by `studio/scripts/emit-effort-rules.mjs`, and read by both. The
parity test below is what proves that actually holds rather than merely being intended.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load_prom():
    spec = importlib.util.spec_from_file_location("prom_effort", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prom_effort"] = mod
    spec.loader.exec_module(mod)
    return mod


prom = _load_prom()


# (model_id, runtime, probed_capabilities) — the cases that exercise each mechanism.
CASES = [
    ("qwen3.6:latest", "ollama", ["completion", "vision", "tools", "thinking"]),
    ("gemma4:12b", "ollama", ["completion", "vision", "audio", "tools", "thinking"]),
    ("gemma3:12b", "ollama", ["completion", "tools"]),
    ("qwen3.6:latest", "ollama", None),
    ("claude-opus-4-8", "anthropic", None),
    ("claude-sonnet-4-6", "anthropic", None),
    ("claude-haiku-4-5", "anthropic", None),
    ("claude-3-5-sonnet", "anthropic", None),
    ("claude-opus-4-8", "openai-compatible", None),
    ("gemini-2.5-pro", "gemini", None),
    ("gemini-2.5-flash", "gemini", None),
    ("gemini-3-pro", "gemini", None),
    ("gpt-5", "openai", None),
    ("gpt-4o", "openai", None),
    ("deepseek-r1", "unknown", None),
    ("qwen3:8b", "llamacpp", None),
    ("qwen3:8b", "lmstudio", None),
    ("qwen-3-coder-480b", "unknown", None),
    ("nemotron-4-340b", "unknown", None),
    ("glm-4-plus", "unknown", None),
    ("granite-3-8b", "unknown", None),
    ("gpt-oss:20b", "ollama", None),
]


def test_builtin_artifact_is_present_and_populated():
    """Python has no table of its own — a missing artifact means no effort control."""
    rules, notes = prom.effort_rules()
    assert notes == [], f"loading the builtin table reported problems: {notes}"
    assert len(rules) > 20, "the generated builtin table looks truncated"


def test_a_knobless_model_puts_NOTHING_on_the_wire():
    """The load-bearing guarantee: a forwarded parameter is a hard 400 on a
    GPT-4-class model, so a model with no knob must receive no new field."""
    _, cap = prom.effort_capability("gpt-4o", "openai", "cloud", None)
    for tier in prom.EFFORT_TIERS:
        res = prom.effort_resolve(tier, cap)
        assert res["patch"]["kind"] == "none"
        before = {"model": "m", "messages": []}
        assert prom.effort_apply(before, res) == before


def test_a_knobless_model_still_gets_the_tier_as_an_INSTRUCTION():
    """…and it is reported as emulated rather than as "not available", which was the
    misreport this whole feature exists to remove."""
    _, cap = prom.effort_capability("gpt-4o", "openai", "cloud", None)
    res = prom.effort_resolve("high", cap)
    assert res["applied"] == "high"
    assert res["degraded"]["reason"] == "emulated"
    msgs = prom.effort_apply_messages([{"role": "user", "content": "hi"}], res)
    assert msgs[0]["role"] == "system"
    assert "Think carefully" in msgs[0]["content"]


def test_off_on_a_knobless_model_is_silence_not_a_plea_to_think_less():
    _, cap = prom.effort_capability("gpt-4o", "openai", "cloud", None)
    res = prom.effort_resolve("off", cap)
    assert res["applied"] is None
    assert res["emulation"] is None


def test_a_probe_outranks_a_name_guess():
    """gemma3 has no reasoning mode by name; a runner reporting `thinking` for a model
    is authoritative over any name-based rule, which is why the probe exists."""
    _, named = prom.effort_capability("gemma3:12b", "ollama", "local", ["completion", "tools"])
    assert named["mechanism"] == "none"
    _, probed = prom.effort_capability("gemma3:12b", "ollama", "local",
                                       ["completion", "tools", "thinking"])
    assert probed["mechanism"] == "effort-enum"


def test_a_token_budget_is_clamped_under_max_tokens():
    """Anthropic 400s when budget_tokens >= max_tokens."""
    _, cap = prom.effort_capability("claude-haiku-4-5", "anthropic", "cloud", None)
    res = prom.effort_resolve("max", cap)
    body = prom.effort_apply({"max_tokens": 8000}, res)
    assert body["thinking"]["budget_tokens"] == 7999


def test_a_nested_patch_MERGES_and_never_replaces():
    """Gemini's field lives under generationConfig, where the wire has already put a
    temperature — creating a fresh object there would silently drop it."""
    _, cap = prom.effort_capability("gemini-3-pro", "gemini", "cloud", None)
    res = prom.effort_resolve("high", cap)
    body = prom.effort_apply({"generationConfig": {"temperature": 0.4}}, res)
    assert body["generationConfig"]["temperature"] == 0.4
    assert body["generationConfig"]["thinkingConfig"]["thinkingLevel"] == "high"


def test_temperature_is_dropped_where_the_provider_rejects_it():
    """Claude 4.7+ removed the sampling parameters — sending one is a 400, not a no-op."""
    _, cap = prom.effort_capability("claude-opus-4-8", "anthropic", "cloud", None)
    res = prom.effort_resolve("high", cap)
    body = prom.effort_apply({"model": "m", "temperature": 0.7}, res)
    assert "temperature" not in body
    assert body["output_config"]["effort"] == "high"


def test_a_trained_on_token_rides_the_USER_turn_not_the_body():
    _, cap = prom.effort_capability("qwen3:8b", "lmstudio", "local", None)
    res = prom.effort_resolve("high", cap)
    assert prom.effort_apply({"model": "q"}, res) == {"model": "q"}
    msgs = prom.effort_apply_messages([{"role": "user", "content": "hi"}], res)
    assert msgs[-1]["content"].endswith("/think")


def test_force_sends_the_knob_anyway_and_says_it_forced_it():
    _, cap = prom.effort_capability("gpt-4o", "openai", "cloud", None)
    res = prom.effort_resolve("high", cap, force=True)
    assert res["degraded"]["reason"] == "forced"
    assert prom.effort_apply({}, res) == {"reasoning_effort": "high"}


def test_workspace_overrides_layer_after_the_builtins(tmp_path, monkeypatch):
    """Later wins a specificity tie — that is the whole of the layering story."""
    d = tmp_path / "proj" / ".prometheus"
    d.mkdir(parents=True)
    (d / "effort-capabilities.json").write_text(json.dumps({"rules": [{
        "id": "pin-gemma3-here",
        "match": {"modelIdRegex": "(^|[/:_-])gemma-?3([^0-9]|$)"},
        "cap": {"mechanism": "effort-enum", "field": "reasoning_effort",
                "supported": ["low"], "enumMap": {"low": "low"},
                "note": "this repo pins gemma3"},
    }]}))
    monkeypatch.delenv("PROM_NO_PROJECT_CONFIG", raising=False)
    rules, notes = prom.effort_rules(cwd=tmp_path / "proj")
    assert notes == []
    rule, cap = prom.effort_capability("gemma3:12b", None, None, None, rules)
    assert rule["id"] == "pin-gemma3-here"
    assert cap["mechanism"] == "effort-enum"


def test_a_malformed_override_is_REPORTED_and_the_builtins_survive(tmp_path, monkeypatch):
    """A rule the user believes is in force but which vanished is worse than none."""
    d = tmp_path / "proj" / ".prometheus"
    d.mkdir(parents=True)
    (d / "effort-capabilities.json").write_text("{ not json")
    monkeypatch.delenv("PROM_NO_PROJECT_CONFIG", raising=False)
    rules, notes = prom.effort_rules(cwd=tmp_path / "proj")
    assert len(notes) == 1 and "not valid JSON" in notes[0]
    assert len(rules) > 20


# ── the parity gate ─────────────────────────────────────────────────────────────

def _ts_resolutions() -> dict:
    """Ask the TypeScript resolver the same questions, through its compiled output."""
    script = r"""
const E = await import(process.env.PROM_TS_MODULE);
const cases = JSON.parse(process.env.PROM_TS_CASES);
const out = {};
for (const [modelId, runtime, probed] of cases) {
  const lookup = { modelId, runtime, locality: runtime === "ollama" ? "local" : "cloud" };
  if (probed) lookup.probedCapabilities = probed;
  const { cap } = E.resolveCapability(lookup);
  const key = `${modelId}|${runtime}|${probed ? probed.join(",") : "-"}`;
  out[key] = {};
  for (const tier of E.EFFORT_TIERS) {
    const r = E.resolveEffort(tier, cap);
    out[key][tier] = {
      applied: r.applied, mechanism: r.mechanism, patch: r.patch,
      degraded: r.degraded ? r.degraded.reason : null,
      emulation: r.emulation ? r.emulation.text : null,
    };
  }
}
process.stdout.write(JSON.stringify(out));
"""
    mod = ROOT / "studio" / "packages" / "core" / "dist" / "ai" / "effort" / "index.js"
    if not mod.exists():
        pytest.skip("the TypeScript build is not present (run `tsc -b` in studio/)")
    import os
    env = {**os.environ, "PROM_TS_MODULE": mod.as_uri(), "PROM_TS_CASES": json.dumps(CASES)}
    res = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=ROOT, timeout=120, env=env,
    )
    assert res.returncode == 0, f"the TS resolver failed: {res.stderr[-800:]}"
    return json.loads(res.stdout)


def test_python_and_typescript_resolve_IDENTICALLY():
    """The whole justification for a generated artifact instead of a second table.

    Every mechanism, every tier, every model: same applied tier, same mechanism, same
    wire patch, same degrade reason, same emulation text. If this ever fails, the two
    implementations have drifted and one of them is lying to a user.
    """
    ts = _ts_resolutions()
    rules, _ = prom.effort_rules()
    mismatches = []
    for model_id, runtime, probed in CASES:
        locality = "local" if runtime == "ollama" else "cloud"
        _, cap = prom.effort_capability(model_id, runtime, locality, probed, rules)
        key = f"{model_id}|{runtime}|{','.join(probed) if probed else '-'}"
        for tier in prom.EFFORT_TIERS:
            py = prom.effort_resolve(tier, cap)
            exp = ts[key][tier]
            got = {
                "applied": py["applied"], "mechanism": py["mechanism"], "patch": py["patch"],
                "degraded": py["degraded"]["reason"] if py["degraded"] else None,
                "emulation": py["emulation"]["text"] if py["emulation"] else None,
            }
            if got != exp:
                mismatches.append(f"{key} @{tier}\n  py={got}\n  ts={exp}")
    assert not mismatches, "Python and TypeScript disagree:\n" + "\n".join(mismatches)


# ── the second parity gate: OVERRIDE PARSING ───────────────────────────────────

# Rules that `rule-store.ts` refuses. Python must refuse them too — the first parity
# test only ever fed both resolvers a table that was already valid, which is exactly
# how a laxer Python parser went unnoticed: it accepted all four of these silently,
# and an unknown mechanism falls through to an empty patch, so the tier read as
# APPLIED while nothing went on the wire.
MALFORMED = [
    {"id": "bad-mech", "match": {}, "cap": {"mechanism": "telepathy", "supported": ["high"]}},
    {"id": "bad-tier", "match": {},
     "cap": {"mechanism": "effort-enum", "field": "x", "supported": ["maximum"]}},
    {"id": "no-field", "match": {}, "cap": {"mechanism": "effort-enum", "supported": ["high"]}},
    {"id": "no-kwarg", "match": {}, "cap": {"mechanism": "template-kwarg", "supported": ["off"]}},
    {"id": "bad-regex", "match": {"modelIdRegex": "([unclosed"},
     "cap": {"mechanism": "none", "supported": []}},
    {"id": 42, "match": {}, "cap": {"mechanism": "none", "supported": []}},
    {"no_id": True},
]

GOOD_OVERRIDE = {
    "id": "my-model-v9",
    "match": {"modelIdRegex": "(^|[/:_-])my-model-v9"},
    "cap": {"mechanism": "effort-enum", "field": "reasoning_effort",
            "supported": ["off", "low", "high"],
            "enumMap": {"off": "none", "low": "low", "high": "high"}},
}


def _ts_parse(rules: list) -> dict:
    """Run the TypeScript override parser over the same input."""
    script = r"""
const M = await import(process.env.PROM_TS_MODULE);
const parsed = M.parseEffortRules({ rules: JSON.parse(process.env.PROM_TS_RULES) });
process.stdout.write(JSON.stringify({
  accepted: parsed.rules.map((r) => r.id), errors: parsed.errors.length,
}));
"""
    import os
    mod = ROOT / "studio" / "packages" / "core" / "dist" / "ai" / "effort" / "rule-store.js"
    if not mod.exists():
        pytest.skip("the TypeScript build is not present (run `tsc -b` in studio/)")
    env = {**os.environ, "PROM_TS_MODULE": mod.as_uri(), "PROM_TS_RULES": json.dumps(rules)}
    res = subprocess.run(["node", "--input-type=module", "-e", script],
                         capture_output=True, text=True, cwd=ROOT, timeout=120, env=env)
    assert res.returncode == 0, f"the TS parser failed: {res.stderr[-800:]}"
    return json.loads(res.stdout)


def _py_parse(tmp_path: Path, rules: list):
    f = tmp_path / "effort-capabilities.json"
    f.write_text(json.dumps({"rules": rules}))
    return prom._effort_read_rules(f)


def test_python_refuses_exactly_what_typescript_refuses(tmp_path):
    """Two parsers with different standards is worse than one: an override Studio
    rejects but the Python CLI accepts means `/think high` means different things on
    the same machine, from the same file."""
    ts = _ts_parse(MALFORMED)
    py_rules, py_notes = _py_parse(tmp_path, MALFORMED)
    assert ts["accepted"] == [], "the TS fixture is wrong — it should reject all of these"
    assert [r["id"] for r in py_rules] == [], (
        f"Python accepted rules TypeScript refuses: {[r.get('id') for r in py_rules]}"
    )
    assert len(py_notes) == len(MALFORMED) == ts["errors"], (
        f"different number of complaints: py={len(py_notes)} ts={ts['errors']}"
    )


def test_both_parsers_accept_a_GOOD_override(tmp_path):
    """The refusal test would also pass if Python refused everything."""
    ts = _ts_parse([GOOD_OVERRIDE])
    py_rules, py_notes = _py_parse(tmp_path, [GOOD_OVERRIDE])
    assert ts["accepted"] == ["my-model-v9"]
    assert [r["id"] for r in py_rules] == ["my-model-v9"]
    assert py_notes == []


def test_an_unknown_mechanism_can_never_report_a_tier_as_applied(tmp_path):
    """The concrete harm D15 allowed: `telepathy` is not a mechanism `_effort_build_patch`
    knows, so it emitted an empty patch — while `supported` was non-empty, so the tier
    resolved as APPLIED. Reported working, sent nothing."""
    rules, _ = _py_parse(tmp_path, [{
        "id": "silent", "match": {"modelIdRegex": "^victim$"},
        "cap": {"mechanism": "telepathy", "supported": ["high"]},
    }])
    assert rules == [], "the rule that causes a silent success was accepted"
    # …and with it refused, the model falls back to honest emulation.
    _, cap = prom.effort_capability("victim", None, None, None, rules)
    res = prom.effort_resolve("high", cap)
    assert res["patch"]["kind"] == "none"
    assert res["degraded"]["reason"] == "emulated"


def test_runtime_classification_matches_typescript_including_the_DEFAULT(tmp_path):
    """A default that differs is still a divergence. Python defaulted `locality` to
    "local" while TypeScript treats an absent locality as "unknown", so the same URL
    classified differently on the two surfaces."""
    script = r"""
const M = await import(process.env.PROM_TS_MODULE);
const cases = JSON.parse(process.env.PROM_TS_CASES);
process.stdout.write(JSON.stringify(
  cases.map(([url, loc]) => (loc === null ? M.runtimeFromBaseUrl(url) : M.runtimeFromBaseUrl(url, loc)))
));
"""
    import os
    mod = ROOT / "studio" / "packages" / "core" / "dist" / "ai" / "effort" / "rules.js"
    if not mod.exists():
        pytest.skip("the TypeScript build is not present")
    cases = [
        ["http://127.0.0.1:11434/v1", None], ["http://127.0.0.1:11434/v1", "local"],
        ["http://localhost:1234/v1", None], ["http://127.0.0.1:8080", None],
        ["http://127.0.0.1:8000/v1", None], ["https://api.openai.com/v1", None],
        ["https://api.anthropic.com", None], ["https://generativelanguage.googleapis.com", None],
        ["https://api.example.com/v1", None], ["https://api.example.com/v1", "local"],
        ["https://api.example.com/v1", "cloud"],
    ]
    env = {**os.environ, "PROM_TS_MODULE": mod.as_uri(), "PROM_TS_CASES": json.dumps(cases)}
    res = subprocess.run(["node", "--input-type=module", "-e", script],
                         capture_output=True, text=True, cwd=ROOT, timeout=120, env=env)
    assert res.returncode == 0, res.stderr[-800:]
    ts = json.loads(res.stdout)
    py = [prom.effort_runtime_from_base_url(u) if loc is None
          else prom.effort_runtime_from_base_url(u, loc) for u, loc in cases]
    assert py == ts, f"runtime classification diverged:\n  py={py}\n  ts={ts}"


# ── crash-safety and the machine envelope ──────────────────────────────────────

def test_an_out_of_ladder_tier_REFUSES_it_does_not_raise():
    """`--effort` is argparse-restricted, but `effort_resolve` is importable and the FORCED
    path indexes a fixed vocabulary — so an unknown tier used to raise KeyError out of a
    function whose whole contract is that it never throws at a transport."""
    _, cap = prom.effort_capability("gpt-4o", "openai", "cloud", None)
    for force in (False, True):
        res = prom.effort_resolve("bogus", cap, force=force)
        assert res["applied"] is None
        assert res["patch"]["kind"] == "none"
        assert "not a reasoning-effort tier" in res["degraded"]["message"]


def test_the_machine_envelope_reports_what_ACTUALLY_happened():
    """The human path prints ":: think → high (emulated — …)". A `--json` consumer needs the
    same fact, or it cannot tell a working knob from an emulated one."""
    assert prom._effort_json_block(None, None) == {}, "no tier asked for ⇒ no effort key"

    _, working = prom.effort_capability("qwen3.6:latest", "ollama", "local",
                                        ["completion", "tools", "thinking"])
    block = prom._effort_json_block("high", prom.effort_resolve("high", working))["effort"]
    assert block["applied"] == "high" and block["mechanism"] == "effort-enum"
    assert block["wire"] == "body" and "degraded" not in block

    _, knobless = prom.effort_capability("gemma3:12b", "ollama", "local", ["completion", "tools"])
    emu = prom._effort_json_block("high", prom.effort_resolve("high", knobless))["effort"]
    assert emu["applied"] == "high", "an emulated tier IS in force"
    assert emu["wire"] == "none", "…but nothing went on the wire"
    assert emu["degraded"]["reason"] == "emulated"
    assert emu["emulated_via"] == "prompt-cot"


def test_the_REPL_does_not_accumulate_the_effort_nudge_across_turns():
    """`effort_apply_messages` must not mutate the caller's history: the emulation nudge is
    prepended to a COPY each turn, so three turns produce one system message, not three."""
    _, cap = prom.effort_capability("gpt-4o", "openai", "cloud", None)
    res = prom.effort_resolve("high", cap)
    history = []
    sent = []
    for i in range(3):
        history.append({"role": "user", "content": f"msg{i}"})
        sent = prom.effort_apply_messages(history, res)
        history.append({"role": "assistant", "content": f"reply{i}"})
    assert [m["role"] for m in history] == ["user", "assistant"] * 3, "history was mutated"
    assert sum(1 for m in sent if m["role"] == "system") == 1


def test_a_soft_switch_token_lands_only_on_the_CURRENT_user_turn():
    _, cap = prom.effort_capability("qwen3:8b", "lmstudio", "local", None)
    res = prom.effort_resolve("high", cap)
    history = [{"role": "user", "content": "old"}, {"role": "assistant", "content": "a"},
               {"role": "user", "content": "new"}]
    sent = prom.effort_apply_messages(history, res)
    assert sent[0]["content"] == "old", "an earlier turn was rewritten"
    assert sent[-1]["content"] == "new /think"


def test_effort_in_TERMINAL_mode_is_refused_not_silently_ignored():
    """A terminal chat hands the conversation to another vendor's CLI, which owns its own
    reasoning settings and takes none of ours. Accepting `--effort` there and doing nothing
    with it is exactly the silent no-op this subsystem exists to eliminate."""
    import argparse
    args = argparse.Namespace(message=["hi"], local=None, cli="claude", effort="high",
                              force_effort=False, model=None, system_prompt=None,
                              replace_system=False, bypass=False, tmux=None, cwd=None,
                              open=False, runner=None)
    prom.JSON_OUT = False
    rc = prom.cmd_chat(args, prom.OSInfo.detect() if hasattr(prom.OSInfo, "detect") else None)
    assert rc == 2, "the flag was accepted and quietly dropped"


# ── the defects the adversarial sweep confirmed in the Python reader ────────────────────
#
# All four are the same shape: the code did something, reported something else, and no test
# could tell the difference because nothing drove the real socket.


class _Fake:
    """A one-response OpenAI-compatible server, on a real socket. The `ask()` path is all
    exception handling and stream shape, and neither can be exercised by a stub."""

    def __init__(self, status: int, body: dict | str):
        import http.server
        import json as _j
        import threading

        payload = (body if isinstance(body, str) else _j.dumps(body)).encode()

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):  # keep pytest output clean
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.srv.shutdown()


def _chat(monkeypatch, fake, model, **kw):
    """Point chat_local at the fake and run one turn, capturing what it printed."""
    monkeypatch.setitem(prom.CHAT_LOCAL_ENDPOINTS, "ollama", f"http://127.0.0.1:{fake.port}/v1")
    monkeypatch.setattr(prom, "_ensure_ollama_daemon", lambda: None)
    return prom.chat_local(model, "hi", runner="ollama", **kw)


def test_an_HTTP_error_from_a_REACHABLE_server_is_not_reported_as_unreachable(
    monkeypatch, capsys
):
    """`HTTPError` subclasses `URLError`, so every HTTP status landed in the "cannot reach
    the server" arm — telling a user whose server is running fine to go start it, and
    throwing away the response body that says what the server actually objected to."""
    with _Fake(404, {"error": {"message": "model 'ghost' not found"}}) as f:
        prom.JSON_OUT = False
        rc = _chat(monkeypatch, f, "ghost")
    out = capsys.readouterr()
    blob = out.out + out.err
    assert rc == 1
    assert "cannot reach" not in blob, "a running server was reported as unreachable"
    assert "HTTP 404" in blob
    assert "model 'ghost' not found" in blob, "the server's own explanation was discarded"


def test_inline_think_blocks_are_split_out_of_the_answer(monkeypatch, capsys):
    """The whole reason `reasoningTag` is in the table. Four TypeScript surfaces strip it;
    Python printed the deliberation as the answer and, in the REPL, fed it back as context."""
    body = {"choices": [{"message": {"content": "<think>2+2. Carry the one.</think>4"}}]}
    with _Fake(200, body) as f:
        prom.JSON_OUT = False
        rc = _chat(monkeypatch, f, "deepseek-r1:8b")
    out = capsys.readouterr().out
    assert rc == 0
    assert "Carry the one" not in out, "the model's thinking was printed as its answer"
    assert out.rstrip().endswith("4")


def test_the_split_thinking_survives_into_the_JSON_envelope(monkeypatch, capsys):
    """Removed from `response`, not destroyed — otherwise the fix trades one silent loss
    for another."""
    body = {"choices": [{"message": {"content": "<think>deliberating</think>done"}}]}
    with _Fake(200, body) as f:
        prom.JSON_OUT = True
        try:
            _chat(monkeypatch, f, "deepseek-r1:8b")
        finally:
            prom.JSON_OUT = False
    env = json.loads(capsys.readouterr().out)
    assert env["response"] == "done"
    assert env["reasoning"] == "deliberating"


def test_a_model_with_NO_reasoning_tag_is_passed_through_untouched(monkeypatch, capsys):
    """The splitter must not invent structure: a `<think>` from a model the table says has
    no reasoning tag is ordinary text (it could be the answer to a question ABOUT tags)."""
    body = {"choices": [{"message": {"content": "<think>literal</think>x"}}]}
    with _Fake(200, body) as f:
        prom.JSON_OUT = False
        _chat(monkeypatch, f, "gemma3:12b")
    assert "literal" in capsys.readouterr().out


def test_an_unterminated_think_block_is_thinking_not_an_answer():
    """The non-obvious rule, and the one that matters most: a model cut off mid-thought was
    still thinking. Promoting a truncated deliberation to "the answer" is the failure."""
    vis, think = prom._effort_split_reasoning("<think>cut off mid-", "think")
    assert vis == ""
    assert think == "cut off mid-"
    # ...and it matches reasoning-tag.ts's `end()` on the same input.


def test_an_explicit_null_modelIdRegex_is_refused_exactly_as_TypeScript_refuses_it(tmp_path):
    """`.get(key)` collapsed "absent" and "present but null". The rule was then live with no
    id constraint, so one file meant two different things on two surfaces."""
    bad = {"id": "a", "match": {"runtime": "ollama", "modelIdRegex": None},
           "cap": {"mechanism": "none", "supported": []}}
    p = tmp_path / "effort-capabilities.json"
    p.write_text(json.dumps({"rules": [bad]}))
    rules, notes = prom._effort_read_rules(p)
    assert rules == [], "a rule TypeScript refuses was accepted here"
    assert any("modelIdRegex must be a string" in n for n in notes)


def test_a_JavaScript_named_group_compiles_on_both_sides():
    """`(?<n>…)` is JS; Python spells it `(?P<n>…)`. Untranslated, an override that works in
    Studio is refused by the engine — and lookbehind must NOT be caught by the translation."""
    assert prom._js_regex_to_py("(?<fam>qwen)3") == "(?P<fam>qwen)3"
    assert prom._js_regex_to_py("(?<=x)y") == "(?<=x)y"
    assert prom._js_regex_to_py("(?<!x)y") == "(?<!x)y"
    ok = {"id": "a", "match": {"modelIdRegex": "(?<fam>qwen)3"},
          "cap": {"mechanism": "none", "supported": []}}
    assert prom._effort_validate_rule(ok, 0) is None


def test_running_from_HOME_does_not_load_the_user_layer_twice(tmp_path, monkeypatch):
    """The project walk stops AT $HOME, so from $HOME the project candidate IS the user
    file — every rule and every diagnostic counted twice."""
    home = tmp_path / "home"
    (home / ".prometheus").mkdir(parents=True)
    (home / ".prometheus" / "effort-capabilities.json").write_text(
        json.dumps({"rules": [{"id": "mine", "match": {"runtime": "ollama"},
                               "cap": {"mechanism": "none", "supported": []}}]})
    )
    monkeypatch.setattr(prom, "HOME", home)
    monkeypatch.delenv("PROM_NO_PROJECT_CONFIG", raising=False)
    rules, _ = prom.effort_rules(cwd=home)
    assert [r["id"] for r in rules].count("mine") == 1


def test_the_models_envelope_accounts_for_every_rule_it_counts(monkeypatch, tmp_path):
    """`rules` counted all three layers; `provenance` bucketed only the builtins, so the
    numbers did not add up and a consumer could not tell missing from unlabelled."""
    home = tmp_path / "home"
    (home / ".prometheus").mkdir(parents=True)
    (home / ".prometheus" / "effort-capabilities.json").write_text(
        json.dumps({"rules": [{"id": "mine", "match": {"runtime": "ollama"},
                               "cap": {"mechanism": "none", "supported": []}}]})
    )
    monkeypatch.setattr(prom, "HOME", home)
    monkeypatch.setenv("PROM_NO_PROJECT_CONFIG", "1")
    env = prom._localai_envelope("models", None)
    eff = env["effort"]
    assert sum(eff["provenance"].values()) == eff["rules"]
    assert eff["provenance"]["unattributed"] == 1


def test_a_wedged_probe_cannot_crash_the_chat(monkeypatch):
    """`http.client.HTTPException` is not an `OSError`: `IncompleteRead`/`BadStatusLine`
    escaped every arm of a BEST-EFFORT probe and took the whole command with them."""
    import http.client
    import urllib.request

    def boom(*a, **k):
        raise http.client.IncompleteRead(b"")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    assert prom.effort_probe_capabilities("http://127.0.0.1:11434/v1", "x") is None


def test_off_is_a_mode_not_the_bottom_of_the_ladder():
    """A two-value switch puts `low` exactly one step from each end, and the plain downward
    tie-break resolved that to `off` — `/think low` DISABLED thinking. Mirrors the same fix in
    ai/effort/types.ts; the parity gate above proves the two agree on every table row."""
    assert prom._effort_nearest("low", ["off", "medium"]) == "medium"
    assert prom._effort_nearest("low", ["off", "high"]) == "high"
    assert prom._effort_nearest("off", ["off", "medium"]) == "off"
    assert prom._effort_nearest("high", ["off"]) == "off"
    # among degrees of thinking, distance still decides and ties still go downward
    assert prom._effort_nearest("medium", ["low", "high"]) == "low"


def test_a_rule_whose_map_cannot_express_its_own_supported_set_is_refused(tmp_path):
    """`field`/`kwarg` catch two shapes of the silent-success bug and no more. These three
    parse, resolve, report the tier as applied, and send nothing."""
    bad = [
        {"id": "e", "match": {"runtime": "ollama"},
         "cap": {"mechanism": "effort-enum", "field": "reasoning_effort", "supported": ["high"]}},
        {"id": "b", "match": {"runtime": "ollama"},
         "cap": {"mechanism": "token-budget", "field": "thinking.budget", "supported": ["high"]}},
        {"id": "p", "match": {"runtime": "ollama"},
         "cap": {"mechanism": "prompt-soft-switch", "supported": ["off", "medium"],
                 "promptMap": {"off": "x"}}},
    ]
    for r in bad:
        p = tmp_path / "effort-capabilities.json"
        p.write_text(json.dumps({"rules": [r]}))
        rules, notes = prom._effort_read_rules(p)
        assert rules == [], r["id"]
        assert any("produces nothing for" in n for n in notes), r["id"]


def test_a_file_that_declares_no_rules_key_is_an_empty_layer_not_a_complaint():
    """`parseEffortRules` draws the line at PRESENT-but-wrong-typed; a missing `rules` key is
    simply an empty layer. This warned instead, so `{"$comment": "..."}` was a clean config in
    Studio and a complaint in the engine — the same file, two verdicts."""
    import tempfile

    d = Path(tempfile.mkdtemp())
    (d / "a.json").write_text('{"$comment": "notes to self"}')
    assert prom._effort_read_rules(d / "a.json") == ([], [])
    # ...but a `rules` that IS there and is not an array is still refused, on both sides.
    (d / "b.json").write_text('{"rules": 5}')
    rules, notes = prom._effort_read_rules(d / "b.json")
    assert rules == [] and len(notes) == 1
