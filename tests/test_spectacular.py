"""Robustness test suite for the SPECTACULAR POWER-UP (prometheus.py).

Goal: prove the engine FAILS CLOSED and never crashes on bad/abusive input across
config, the catalog registries, the catalog-card verbs, the terminal-chat argv
builder (injection safety), chat routing, and the argparse surface.

Run:  python3 -m unittest discover -s tests -v
  or: python3 tests/test_spectacular.py
Pure stdlib (unittest) — no pytest / no third-party deps.
"""
import os
import sys
import json
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import prometheus as p  # noqa: E402


KNOWN_INSTALL_METHODS = {
    "claude_plugin", "claude_marketplace", "git_clone", "git_clone_shell", "shell",
    "universal_skill", "shell_or_action", "documented_only", "gemini_extension",
    "cursor_mcp", "cursor_rule", "codex_prompt", "codex_mcp",
}


class TestConfig(unittest.TestCase):
    def setUp(self):
        # isolate PROM_DIR/PROM_CONFIG to a temp dir so we never touch real prefs
        self._tmp = tempfile.TemporaryDirectory()
        self._dir = Path(self._tmp.name)
        self._orig_dir, self._orig_cfg = p.PROM_DIR, p.PROM_CONFIG
        p.PROM_DIR = self._dir
        p.PROM_CONFIG = self._dir / "config.json"

    def tearDown(self):
        p.PROM_DIR, p.PROM_CONFIG = self._orig_dir, self._orig_cfg
        self._tmp.cleanup()

    def test_roundtrip(self):
        p.save_config({"models_root": "/tmp/x", "k": 1})
        self.assertEqual(p.load_config().get("k"), 1)

    def test_corrupt_file_never_raises(self):
        p.PROM_CONFIG.write_text("{ not valid json :::")
        self.assertEqual(p.load_config(), {})  # falls back, no exception

    def test_missing_file(self):
        self.assertEqual(p.load_config(), {})

    def test_default_models_root(self):
        self.assertEqual(p.get_models_root(), p.DEFAULT_MODELS_ROOT)

    def test_set_models_root_persists_and_creates(self):
        target = str(self._dir / "models-here")
        root = p.set_models_root(target)
        self.assertTrue(root.exists())
        self.assertEqual(p.get_models_root(), root)

    def test_set_models_root_rejects_empty(self):
        with self.assertRaises(RuntimeError):
            p.set_models_root("   ")

    def test_atomic_write_leaves_no_tmp(self):
        p.save_config({"a": 1})
        leftovers = list(self._dir.glob("*.tmp"))
        self.assertEqual(leftovers, [])


class TestRegistryIntegrity(unittest.TestCase):
    def test_model_tools_fields(self):
        for t in p.MODEL_TOOLS:
            self.assertTrue(t.id and t.name and t.category, f"bad ModelTool {t!r}")
            self.assertIn(t.category, {"library", "kernel", "local-app"}, f"{t.id} category")

    def test_repo_tools_fields(self):
        ids = set()
        for t in p.REPO_TOOLS:
            self.assertTrue(t.id and t.name and t.kind, f"bad RepoTool {t!r}")
            self.assertIn(t.kind, {"pip-venv", "docker-run", "compose", "npm"}, f"{t.id} kind")
            self.assertNotIn(t.id, ids, f"duplicate RepoTool id {t.id}")
            ids.add(t.id)
            if t.kind == "npm":   # npm tools build from the gated clone into an isolated prefix
                self.assertEqual(t.install_kind, "npm", f"{t.id} install_kind")
                self.assertTrue(t.clone_url, f"{t.id} npm needs clone_url (gated source)")

    def test_plugin_install_methods_valid(self):
        for pl in p.PLUGINS:
            self.assertTrue(pl.name and pl.targets, f"bad Plugin {pl!r}")
            for host, spec in pl.targets.items():
                self.assertIn(spec.method, KNOWN_INSTALL_METHODS,
                              f"{pl.name}@{host} has unknown method {spec.method}")

    def test_documented_only_have_ids(self):
        for d in p.DOCUMENTED_ONLY:
            self.assertTrue(d.get("id"), f"DOCUMENTED_ONLY entry missing id: {d}")

    def test_open_models_unique_ids(self):
        ids = [m.id for m in p.OPEN_MODELS]
        self.assertEqual(len(ids), len(set(ids)), "duplicate OpenModel ids")

    def test_no_id_collision_across_installables(self):
        # the same id must not be installable two different ways (ambiguous dispatch)
        seen: dict[str, str] = {}
        dups = []
        for label, items in (("plugin", [x.name for x in p.PLUGINS]),
                             ("model_tool", [x.id for x in p.MODEL_TOOLS]),
                             ("app", [x.id for x in p.REPO_TOOLS])):
            for i in items:
                if i in seen:
                    dups.append(f"{i}: {seen[i]} & {label}")
                seen[i] = label
        self.assertEqual(dups, [], f"id collisions: {dups}")

    def test_new_entries_present(self):
        mt = {t.id for t in p.MODEL_TOOLS}
        for i in ("ultralytics", "supervision", "crewai", "kronos", "openmythos",
                  "notebooklm-py", "turbovec", "firecrawl", "onyx", "lm-studio"):
            self.assertIn(i, mt, f"missing model_tool {i}")
        pn = {x.name for x in p.PLUGINS}
        for i in ("claude-blog", "andrej-karpathy-skills", "nvidia-skills",
                  "addyosmani-agent-skills", "obsidian-skills", "gitnexus", "agent-browser"):
            self.assertIn(i, pn, f"missing plugin {i}")
        docd = {d["id"] for d in p.DOCUMENTED_ONLY}
        for i in ("g0dm0d3", "cl4r1t4s", "free-claude-code"):
            self.assertIn(i, docd, f"missing excluded {i}")


class TestCatalogCard(unittest.TestCase):
    def test_index_covers_new_ids(self):
        idx = p._catalog_index()
        for i in ("crewai", "g0dm0d3", "ultralytics", "uptime-kuma", "claude-blog"):
            self.assertIn(i, idx, f"{i} missing from catalog index")

    def test_describe_known_and_unknown(self):
        ns = type("NS", (), {"id": "crewai"})()
        self.assertEqual(p.cmd_describe(ns, None), 0)
        ns_bad = type("NS", (), {"id": "definitely-not-a-real-id-xyz"})()
        self.assertEqual(p.cmd_describe(ns_bad, None), 2)  # graceful, not a crash

    def test_describe_no_arg(self):
        ns = type("NS", (), {"id": None})()
        self.assertEqual(p.cmd_describe(ns, None), 2)

    def test_methods_for_unknown_is_graceful(self):
        ns = type("NS", (), {"id": "nope-xyz"})()
        self.assertEqual(p.cmd_methods(ns, None), 2)


class TestTerminalCmd(unittest.TestCase):
    def test_each_cli_builds(self):
        for svc in ("claude", "codex", "gemini", "cursor", "opencode"):
            argv, env, notes = p.build_terminal_cmd(svc, prompt="hi")
            self.assertEqual(argv[0], p.CHAT_CLIS[svc]["bin"][0].split("/")[-1] or argv[0])
            self.assertIsInstance(argv, list)

    def test_unknown_cli_raises(self):
        with self.assertRaises(RuntimeError):
            p.build_terminal_cmd("not-a-cli")

    def test_prompt_is_single_token_injection_safe(self):
        payload = "rm -rf / ; echo $(whoami) && curl evil"
        argv, _, _ = p.build_terminal_cmd("claude", prompt=payload)
        self.assertEqual(argv[-1], payload)  # never split / interpolated
        self.assertEqual(sum(1 for a in argv if a == payload), 1)

    def test_claude_bypass_and_sysprompt(self):
        argv, env, _ = p.build_terminal_cmd("claude", bypass=True,
                                            system_prompt_file="/tmp/sp.md", prompt="x")
        self.assertIn("--dangerously-skip-permissions", argv)
        self.assertIn("--append-system-prompt-file", argv)

    def test_codex_bypass_is_global_before_exec(self):
        argv, _, _ = p.build_terminal_cmd("codex", bypass=True, prompt="x")
        self.assertLess(argv.index("never"), argv.index("exec"))  # approval set before subcmd

    def test_gemini_sysprompt_via_env(self):
        _, env, _ = p.build_terminal_cmd("gemini", system_prompt_file="/tmp/sp.md", prompt="x")
        self.assertEqual(env.get("GEMINI_SYSTEM_MD"), os.path.abspath("/tmp/sp.md"))

    def test_no_prompt_is_interactive(self):
        argv, _, _ = p.build_terminal_cmd("claude")  # no prompt
        self.assertNotIn("-p", argv)


class TestChatRouting(unittest.TestCase):
    def _ns(self, **kw):
        base = dict(local=None, cli=None, message=None, runner=None, model=None,
                    system_prompt=None, replace_system=False, bypass=False,
                    tmux=None, cwd=None, open=False)
        base.update(kw)
        return type("NS", (), base)()

    def test_paid_cli_rejected_as_local(self):
        self.assertEqual(p.cmd_chat(self._ns(local="claude"), None), 2)

    def test_no_args_shows_help(self):
        self.assertEqual(p.cmd_chat(self._ns(), None), 0)

    def test_terminal_preview_no_open_returns_0(self):
        # preview path (no --open) must not launch anything
        self.assertEqual(p.cmd_chat(self._ns(cli="claude", message=["hello"]), None), 0)

    def test_endpoints_known(self):
        self.assertIn("ollama", p.CHAT_LOCAL_ENDPOINTS)
        self.assertIn("lmstudio", p.CHAT_LOCAL_ENDPOINTS)


class TestArgparse(unittest.TestCase):
    def test_parser_builds(self):
        parser = p.build_parser()
        self.assertIsNotNone(parser)

    def test_subcommands_parse(self):
        parser = p.build_parser()
        for argv in (
            ["chat", "--local", "qwen3:8b", "hello"],
            ["chat", "--cli", "claude", "--bypass", "--tmux", "work", "--open", "do x"],
            ["describe", "crewai"],
            ["tutorial", "firecrawl"],
            ["methods", "ultralytics"],
            ["models", "config", "--show"],
            ["models", "install", "ultralytics", "--path", "/tmp/x"],
        ):
            ns = parser.parse_args(argv)  # must not raise
            self.assertTrue(ns.command)

    def test_empty_returns_help_zero(self):
        self.assertEqual(p.main([]), 0)


class TestCrashGuard(unittest.TestCase):
    def test_handler_exception_is_caught(self):
        # force a dispatched handler to raise; main() must return 1, not propagate
        import argparse
        orig = p.cmd_doctor
        try:
            p.cmd_doctor = lambda *a, **k: (_ for _ in ()).throw(ValueError("boom"))
            rc = p.main(["doctor"])
            self.assertEqual(rc, 1)  # global crash guard → clean nonzero
        finally:
            p.cmd_doctor = orig


def _run_main_json(argv):
    """Run p.main(['--json', *argv]) capturing stdout; return (rc, parsed_json|None).

    Handles both return-value commands and argparse's SystemExit (the JSON-aware
    parser still prints ONE json object to stdout before exiting)."""
    import io
    import contextlib
    buf = io.StringIO()
    rc = None
    with contextlib.redirect_stdout(buf):
        try:
            rc = p.main(["--json", *argv])
        except SystemExit as e:  # argparse usage errors
            rc = e.code
    out = buf.getvalue().strip()
    data = json.loads(out) if out else None
    return rc, data


class TestSpectacularHardening(unittest.TestCase):
    """Covers the 2026-06-22 audit fixes: --json contract everywhere, crash/security
    fixes (serve_steps, dossier path-traversal), config validation, ruflo, opencode."""

    def setUp(self):
        # isolate prefs + remember globals the engine mutates under --json
        self._tmp = tempfile.TemporaryDirectory()
        self._dir = Path(self._tmp.name)
        self._orig = (p.PROM_DIR, p.PROM_CONFIG, p.JSON_OUT, p.DRY_RUN, p.Log.STREAM)
        p.PROM_DIR = self._dir
        p.PROM_CONFIG = self._dir / "config.json"

    def tearDown(self):
        (p.PROM_DIR, p.PROM_CONFIG, p.JSON_OUT, p.DRY_RUN, p.Log.STREAM) = self._orig
        self._tmp.cleanup()

    # ---- argparse JSON guard ------------------------------------------------
    def test_argparse_missing_arg_emits_json(self):
        rc, d = _run_main_json(["where"])  # missing required `name`
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])
        self.assertIn("argument error", d["error"])

    def test_argparse_unknown_command_emits_json(self):
        rc, d = _run_main_json(["zzz-not-a-command"])
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])

    # ---- describe / tutorial / methods JSON ---------------------------------
    def test_describe_json_success(self):
        rc, d = _run_main_json(["describe", "crewai"])
        self.assertEqual(rc, 0)
        self.assertTrue(d["ok"])
        self.assertEqual(d["kind"], "model_tool")
        self.assertTrue(d["installable"])
        self.assertIsInstance(d["has_tutorial"], bool)

    def test_describe_documented_not_installable(self):
        rc, d = _run_main_json(["describe", "g0dm0d3"])
        self.assertTrue(d["ok"])
        self.assertFalse(d["installable"])

    def test_tutorial_json_missing_id(self):
        rc, d = _run_main_json(["tutorial", ""])
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])

    def test_tutorial_json_ok(self):
        rc, d = _run_main_json(["tutorial", "ruflo"])
        self.assertEqual(rc, 0)
        self.assertTrue(d["ok"])
        self.assertIn("ruflo", d["text"].lower())

    def test_methods_json_missing_id(self):
        rc, d = _run_main_json(["methods", ""])
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])

    # ---- harden JSON --------------------------------------------------------
    def test_harden_json_structure(self):
        rc, d = _run_main_json(["harden"])
        self.assertTrue(d["ok"])
        self.assertIsInstance(d["findings"], list)
        self.assertIsInstance(d["warnings"], int)
        for f in d["findings"]:
            self.assertIn("severity", f)
            self.assertIn("message", f)

    # ---- chat JSON ----------------------------------------------------------
    def test_chat_json_no_args(self):
        rc, d = _run_main_json(["chat"])
        self.assertTrue(d["ok"])
        self.assertIn("modes", d)
        self.assertIn("clis", d)

    def test_chat_json_terminal_preview_has_cwd(self):
        rc, d = _run_main_json(["chat", "--cli", "claude", "hello"])
        self.assertTrue(d["ok"])
        self.assertEqual(d["mode"], "terminal")
        self.assertIn("cwd", d)
        self.assertIsInstance(d["argv"], list)

    def test_chat_json_paid_cli_as_local_rejected(self):
        rc, d = _run_main_json(["chat", "--local", "claude"])
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])

    # ---- dossier path-traversal (security) ----------------------------------
    def test_dossier_traversal_blocked(self):
        # a poisoned docs/dossier field must NOT escape DOSSIER_DIR
        evil = type("E", (), {"docs": "../prometheus.py"})()
        self.assertIsNone(p._dossier_for("whatever", evil))
        evil2 = {"dossier": "../../etc/passwd"}
        self.assertIsNone(p._dossier_for("whatever", evil2))

    def test_describe_traversal_id_graceful(self):
        rc, d = _run_main_json(["describe", "crewai/../../../etc/passwd"])
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])  # unknown id, no file read

    # ---- ruflo (the closed coverage gap) ------------------------------------
    def test_ruflo_entry_present_and_flagged(self):
        ruflo = next((x for x in p.PLUGINS if x.name == "ruflo"), None)
        self.assertIsNotNone(ruflo, "ruflo plugin missing")
        self.assertTrue(ruflo.targets)
        self.assertIn("dual-use", (ruflo.security_note or "").lower())

    # ---- build_terminal_cmd: opencode / cursor ------------------------------
    def test_opencode_run_subcommand(self):
        argv, _, _ = p.build_terminal_cmd("opencode", prompt="hi", model="gpt4")
        self.assertIn("run", argv)
        self.assertEqual(argv[0], "opencode")

    def test_cursor_sysprompt_is_a_note_not_a_flag(self):
        argv, _, notes = p.build_terminal_cmd("cursor", system_prompt_file="/tmp/sp.md", prompt="x")
        self.assertNotIn("--append-system-prompt-file", argv)
        self.assertTrue(any("cursor" in n.lower() for n in notes))

    # ---- RepoTool serve_steps crash fix -------------------------------------
    def test_repotool_has_serve_steps(self):
        for t in p.REPO_TOOLS:
            self.assertTrue(hasattr(t, "serve_steps"), f"{t.id} lacks serve_steps")

    def test_apps_install_dryrun_no_attribute_crash(self):
        import io
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            rc = p.main(["--dry-run", "apps", "install", "yt-dlp",
                         "--path", str(self._dir / "appwork")])
        self.assertEqual(rc, 0)  # AttributeError would have been crash-guarded → 1

    # ---- models config validation (JSON) ------------------------------------
    def test_models_config_empty_string_rejected(self):
        rc, d = _run_main_json(["models", "config", "--set-root", ""])
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])

    def test_models_config_file_path_rejected(self):
        f = self._dir / "afile"
        f.write_text("x")
        rc, d = _run_main_json(["models", "config", "--set-root", str(f)])
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])
        self.assertIn("not a directory", d["error"])

    def test_models_pull_json_no_ollama_is_graceful(self):
        rc, d = _run_main_json(["models", "pull", "qwen3:8b"])
        self.assertIsInstance(d, dict)
        self.assertEqual(d["command"], "models")

    # ---- save_config returns bool + surfaces failure ------------------------
    def test_save_config_returns_bool(self):
        self.assertIs(p.save_config({"a": 1}), True)

    # ---- interactive commands reject --json cleanly -------------------------
    def test_interactive_guards_emit_json(self):
        # CLI-081: purge/schedule/uninstall now return PLAN envelopes (rc 0) over --json — NOT a
        # reject — and provably mutate nothing. `wizard` stays interactive-only (out of scope).
        rc, d = _run_main_json(["schedule", "--list"])
        self.assertEqual(rc, 0)
        self.assertEqual(d["phase"], "list")

        # purge plan: spy on rmtree → assert-not-called (rc 0 + plan shape alone wouldn't catch a mutation).
        orig_rm, calls = p.shutil.rmtree, []
        p.shutil.rmtree = lambda *a, **k: calls.append(a)
        try:
            rc, d = _run_main_json(["purge", "claude"])
        finally:
            p.shutil.rmtree = orig_rm
        self.assertEqual(rc, 0)
        self.assertEqual(d["phase"], "plan")
        self.assertEqual(calls, [], "purge plan must remove nothing")

        # schedule --auto plan: spy on the install helper → assert-not-called.
        orig_inst, inst_calls = p._install_auto_schedule, []
        p._install_auto_schedule = lambda *a, **k: inst_calls.append(a) or {"ok": True}
        try:
            rc, d = _run_main_json(["schedule", "--auto"])
        finally:
            p._install_auto_schedule = orig_inst
        self.assertEqual(rc, 0)
        self.assertEqual(d["phase"], "plan")
        self.assertIn("--yes", d["requires"])
        self.assertEqual(inst_calls, [], "schedule plan must install nothing")

        rc, d = _run_main_json(["uninstall", "all"])
        self.assertEqual(rc, 0)
        self.assertEqual(d["phase"], "plan")

        rc, d = _run_main_json(["wizard"])  # out of scope → still an interactive reject
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])

    def test_purge_json_token_mismatch_refuses_no_mutation(self):
        # --yes with a WRONG --confirm token → refuse (rc 2), and prove no removal fired.
        orig_cfg, orig_rm, calls = p._agent_config_dir, p.shutil.rmtree, []
        p._agent_config_dir = lambda host: str(self._dir / "fake-cfg")
        p.shutil.rmtree = lambda *a, **k: calls.append(a)
        try:
            rc, d = _run_main_json(["--yes", "purge", "claude", "--confirm", "wrongname"])
        finally:
            p._agent_config_dir, p.shutil.rmtree = orig_cfg, orig_rm
        self.assertEqual(rc, 2)
        self.assertFalse(d["ok"])
        self.assertEqual(calls, [], "a token mismatch must remove nothing")

    def test_purge_json_matching_token_executes(self):
        fake = self._dir / "claude-cfg"
        fake.mkdir()
        (fake / "settings.json").write_text("{}")
        orig_cfg, orig_which, orig_pd = p._agent_config_dir, p.shutil.which, p.PURGE_DIR
        p._agent_config_dir = lambda host: str(fake)
        p.shutil.which = lambda *a, **k: None  # pretend the CLI binary is gone (no --force needed)
        p.PURGE_DIR = self._dir / "purge"
        try:
            rc, d = _run_main_json(["--yes", "purge", "claude", "--confirm", "claude"])
        finally:
            p._agent_config_dir, p.shutil.which, p.PURGE_DIR = orig_cfg, orig_which, orig_pd
        self.assertEqual(rc, 0)
        self.assertEqual(d["phase"], "executed")
        self.assertTrue(all(a["ok"] for a in d["actions"]))
        self.assertFalse(fake.exists(), "a matching-token purge removes the config dir")

    # ---- sync emits a JSON envelope (consumed by engine-bridge runPrometheus) ----
    def test_sync_emits_json(self):
        # an unknown skill → JSON error envelope (still valid JSON, command=sync)
        rc, d = _run_main_json(["sync", "definitely-not-a-real-skill-xyz"])
        self.assertEqual(d["command"], "sync")
        self.assertFalse(d["ok"])

    def test_catalog_reads_stay_human_text(self):
        # models/apps/worldsim/doctor are HUMAN-TABLE reads parsed as text by
        # engine-bridge catalog.ts — they must NOT emit a JSON object even under --json.
        # (localai NOW ships a v1 JSON envelope — CLI-026 — so it is intentionally excluded.)
        import io
        import contextlib
        for argv in (["models", "list"], ["apps", "list"], ["worldsim", "list"],
                     ["doctor"]):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                try:
                    p.main(["--json", *argv])
                except SystemExit:
                    pass
            out = buf.getvalue().strip()
            if out:
                with self.assertRaises(json.JSONDecodeError, msg=f"{argv} must stay human text"):
                    json.loads(out)

    # ---- _catalog_index robustness -----------------------------------------
    def test_catalog_index_builds_without_crash(self):
        idx = p._catalog_index()
        self.assertIn("ruflo", idx)
        self.assertGreater(len(idx), 50)


if __name__ == "__main__":
    unittest.main(verbosity=2)
