#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_read_json_typesafe.py — `_read_json` must never hand a non-dict to its callers.

The annotation said `-> dict` and the body returned whatever `json.loads` produced. All ~18 call
sites then do `.get(...)`, `key in ...` or item assignment, so one malformed file became a raw
TypeError out of the middle of an install.

Found LIVE on a real machine: `~/.config/prometheus/trust.json` held the single token `0`, so
`is_trusted()` raised `TypeError: argument of type 'int' is not a container or iterable` and
`record_trust()` raised `'int' object does not support item assignment`. Every gate that reached
the WARN tier died with exit 1.

Pure stdlib (unittest). Run: python3 tests/test_read_json_typesafe.py."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_prometheus():
    spec = importlib.util.spec_from_file_location("prometheus_mod_readjson", ROOT / "prometheus.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


P = _load_prometheus()


class TestReadJsonTypeSafe(unittest.TestCase):
    def _write(self, text):
        d = Path(tempfile.mkdtemp(prefix="prom-readjson-"))
        f = d / "config.json"
        f.write_text(text)
        return f

    def test_a_non_object_json_value_is_discarded(self):
        # every one of these is valid JSON and none of them is a dict
        for raw in ["0", "null", "[]", '"a string"', "true", "3.14", '[{"a":1}]']:
            got = P._read_json(self._write(raw))
            self.assertEqual(got, {}, f"{raw!r} was passed through as {got!r}")
            self.assertIsInstance(got, dict)
            # the thing every caller actually does must not raise
            self.assertFalse("anything" in got)
            got["k"] = 1

    def test_a_real_object_still_round_trips(self):
        # self-validating: this must not have turned _read_json into a function that always
        # returns {}.
        payload = {"repo@claude#abc": {"verdict": "warn", "approvedBy": "user"}}
        self.assertEqual(P._read_json(self._write(json.dumps(payload))), payload)

    def test_missing_and_malformed_files_are_still_empty(self):
        self.assertEqual(P._read_json(Path("/no/such/file.json")), {})
        self.assertEqual(P._read_json(self._write("{not json")), {})
        # a DIRECTORY where a file was expected must not escape as an OSError either
        self.assertEqual(P._read_json(Path(tempfile.mkdtemp(prefix="prom-readjson-dir-"))), {})

    def test_the_trust_call_sites_survive_a_corrupt_store(self):
        """The exact pair that crashed on the real machine."""
        corrupt = self._write("0")
        original = P.TRUST_FILE
        try:
            P.TRUST_FILE = corrupt
            trust = P._load_trust()
            self.assertIsInstance(trust, dict)
            self.assertFalse("repo@claude#abc" in trust)  # is_trusted's operation
            trust["repo@claude#abc"] = {"verdict": "warn"}  # record_trust's operation
        finally:
            P.TRUST_FILE = original


if __name__ == "__main__":
    unittest.main()
