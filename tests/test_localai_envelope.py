"""Contract tests for the `localai` v1 JSON envelope (CLI-026).

Asserts the `--json localai <sub>` schema per subcommand and that the human (non-json)
path stays a human table (no JSON leak onto stdout). The engine-bridge client + the core
typed view consume the SAME schema.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent / "prometheus.py"
sys.path.insert(0, str(HERE.parent))

import prometheus as p  # noqa: E402


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(ENGINE), *args],
        capture_output=True, text=True, timeout=120,
    )


class LocalaiEnvelope(unittest.TestCase):
    def _json(self, *args: str):
        proc = _run("--json", "localai", *args)
        return json.loads(proc.stdout.strip()), proc.returncode

    def test_audit_envelope_schema(self) -> None:
        e, code = self._json("audit")
        self.assertEqual(code, 0)
        self.assertEqual(e["command"], "localai")
        self.assertEqual(e["version"], 1)
        self.assertEqual(e["action"], "audit")
        self.assertTrue(e["ok"])
        self.assertTrue(e["tools"])
        for k in ("tool", "name", "track", "mode", "patchable", "recipe", "note"):
            self.assertIn(k, e["tools"][0])
        self.assertIsInstance(e["local_endpoints"], dict)
        self.assertEqual(set(e["summary"]), {"total", "paid", "patchable"})

    def test_models_envelope_schema(self) -> None:
        e, code = self._json("models")
        self.assertEqual(code, 0)
        self.assertEqual(e["action"], "models")
        self.assertTrue(e["models"])
        for k in ("id", "name", "license", "params", "local", "ollama", "served", "endpoints"):
            self.assertIn(k, e["models"][0])
        self.assertIsInstance(e["open_endpoints"], dict)

    def test_endpoints_envelope_schema(self) -> None:
        e, code = self._json("endpoints")
        self.assertEqual(code, 0)
        self.assertEqual(e["action"], "endpoints")
        self.assertIsInstance(e["local"], dict)
        self.assertIsInstance(e["open"], dict)
        self.assertIn("host_ollama", e)

    def test_show_and_model_envelopes(self) -> None:
        e, code = self._json("show", "ollama")
        self.assertEqual(code, 0)
        self.assertEqual(e["action"], "show")
        self.assertEqual(e["tool"]["tool"], "ollama")

    def test_unknown_tool_exits_2(self) -> None:
        e, code = self._json("show", "definitely-not-a-tool")
        self.assertEqual(code, 2)
        self.assertFalse(e["ok"])
        self.assertIn("error", e)

    def test_human_path_emits_no_json(self) -> None:
        # non-json human path: stdout is the human table, NEVER a JSON object.
        proc = _run("localai", "endpoints")
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(proc.stdout.lstrip().startswith("{"), "human path must not emit JSON")
        self.assertGreater(len(proc.stdout), 50)

    def test_json_channel_is_a_single_object_with_trailing_newline(self) -> None:
        # emit_json contract: exactly one JSON object + a trailing newline on stdout.
        proc = _run("--json", "localai", "audit")
        self.assertTrue(proc.stdout.endswith("\n"))
        obj = json.loads(proc.stdout)  # the whole stdout parses as one object
        self.assertEqual(obj["version"], 1)

    def test_envelope_helper_direct(self) -> None:
        # the pure helper is directly callable (in-process) for every action.
        for action in ("audit", "models", "endpoints"):
            e = p._localai_envelope(action, None)
            self.assertTrue(e["ok"])
            self.assertEqual(e["version"], 1)


if __name__ == "__main__":
    unittest.main()
