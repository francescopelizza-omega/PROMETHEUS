#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""test_privileged_tty_e2e.py — the privileged gate's password path on a REAL terminal.

A test cannot type the user's sudo password, so the elevator is a stand-in reached through the
gate's `resolveElevator` seam: a shell script that behaves like sudo on the terminal — prints the
prompt it was given with `-p`, reads a password from /dev/tty with echo off, and runs the command
only when it matches. Everything else is real: the gate from source, a real pty, real keystrokes.

What it pins:
  * the elevator gets the REAL terminal (sudo's prompt reaches the screen, the typed password
    reaches the elevator);
  * the password appears nowhere Prometheus can see it — not on screen (echo off), not in the
    gate's captured output, not in its result, not in the audit log;
  * `-k` and the Prometheus prompt are passed, so sudo asks every time;
  * a wrong password runs nothing and comes back as a failure.

The macOS askpass helper is checked by COMPILING its AppleScript with `osacompile` (it is never
run: that would put a real password dialog on the user's screen).

Run: python3 tests/test_privileged_tty_e2e.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_disk_space_e2e import NODE, REPO, Pty  # noqa: E402

HOST = REPO / "studio" / "packages" / "core" / "src" / "agent" / "system" / "host"
DEV_REGISTER = REPO / "studio" / "apps" / "cli" / "dev-register.mjs"
SECRET = "hunter2-e2e"

FAKE_SUDO = """#!/bin/sh
echo "$*" >> "$FAKE_SUDO_LOG"
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
  -k|-A) shift ;;
  -p) prompt=$2; shift 2 ;;
  --) shift; break ;;
  *) break ;;
  esac
done
printf '%s' "$prompt" >/dev/tty
stty -echo </dev/tty
IFS= read -r pw </dev/tty
stty echo </dev/tty
printf '\\n' >/dev/tty
[ "$pw" = "$FAKE_SUDO_PASSWORD" ] || { echo "sudo: 1 incorrect password attempt" >&2; exit 1; }
# the race the gate must survive: a process running as the user swaps the script AFTER the
# gate's last check, while sudo waits for the password, just before root opens it
if [ -n "${FAKE_SUDO_SWAP:-}" ]; then cp "$FAKE_SUDO_SWAP_WITH" "$FAKE_SUDO_SWAP"; fi
exec "$@"
"""

DRIVER = """
import {{ createPrivilegedGate }} from {gate};
const gate = createPrivilegedGate({{
  approver: async () => ({{ decision: "approve" }}),
  passwordVia: "tty",
  home: process.env.GATE_HOME,
  userHome: "/nonexistent-home",
  resolveElevator: () => process.env.FAKE_SUDO,
  // control knob for the race test: treat every script as root-owned (= run it as it is)
  ...(process.env.GATE_AS_IS ? {{ rootControlled: () => true }} : {{}}),
}});
const r = await gate.requestAndRun({{
  argv: JSON.parse(process.env.GATE_ARGV ?? '["/bin/echo", "ROOT-RAN"]'),
  cwd: process.env.GATE_CWD ?? "/tmp",
  why: "tty password e2e",
  surface: "tui",
  requester: "e2e",
}});
process.stdout.write("RESULT " + JSON.stringify(r) + "\\n");
"""


@unittest.skipUnless(NODE and (REPO / "studio" / "node_modules").is_dir(), "needs node and studio/node_modules")
class TtyPassword(unittest.TestCase):
    def run_gate(self, typed: str, extra_env: dict[str, str] | None = None,
                 tmp: Path | None = None) -> tuple[dict, str, Path, Path]:
        tmp = tmp or Path(tempfile.mkdtemp(prefix="prom-gate-e2e-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        sudo = tmp / "sudo"
        sudo.write_text(FAKE_SUDO)
        sudo.chmod(0o755)
        driver = tmp / "driver.ts"
        driver.write_text(DRIVER.format(gate=json.dumps(str(HOST / "privileged-gate.ts"))))
        log = tmp / "sudo-args.log"
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(tmp),
            "TERM": "xterm-256color",
            "GATE_HOME": str(tmp / "prom-home"),
            "FAKE_SUDO": str(sudo),
            "FAKE_SUDO_LOG": str(log),
            "FAKE_SUDO_PASSWORD": SECRET,
            **(extra_env or {}),
        }
        p = Pty([str(NODE), "--import", str(DEV_REGISTER), str(driver)], env, str(tmp))
        self.addCleanup(p.kill)
        self.assertTrue(p.expect(r"\[PROMETHEUS\] password for", 60), "no sudo prompt on the terminal:\n" + p.text())
        p.send(typed.encode() + b"\r")
        self.assertTrue(p.expect(r"RESULT \{", 30), p.text())
        p.wait(10)
        line = next(l for l in p.text().splitlines() if l.startswith("RESULT "))
        audit = (tmp / "prom-home" / "audit" / "sudo.log")
        return json.loads(line[len("RESULT "):]), p.text(), audit, log

    def test_the_password_goes_terminal_to_elevator_and_nowhere_else(self) -> None:
        r, screen, audit, log = self.run_gate(SECRET)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["stdout"].strip(), "ROOT-RAN")
        self.assertNotIn(SECRET, screen, "the password was echoed")
        self.assertNotIn(SECRET, json.dumps(r), "the password is in the gate's result")
        self.assertTrue(audit.exists())
        self.assertNotIn(SECRET, audit.read_text(), "the password is in the audit log")
        args = log.read_text()
        self.assertTrue(args.startswith("-k -p [PROMETHEUS] password for %u:  -- /bin/echo ROOT-RAN"), args)

    def swap_case(self, interpreter: str, original: str, swapped: str, name: str,
                  as_is: bool = False) -> dict:
        tmp = Path(tempfile.mkdtemp(prefix="prom-gate-e2e-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        script = tmp / name
        script.write_text(original)
        (tmp / "swap").write_text(swapped)
        r, _, _, _ = self.run_gate(SECRET, {
            "GATE_ARGV": json.dumps([interpreter, str(script)]),
            "GATE_CWD": str(tmp),
            "FAKE_SUDO_SWAP": str(script),
            "FAKE_SUDO_SWAP_WITH": str(tmp / "swap"),
            **({"GATE_AS_IS": "1"} if as_is else {}),
        }, tmp)
        return r

    def test_a_python_script_swapped_while_sudo_asks_never_runs_as_root(self) -> None:
        r = self.swap_case(sys.executable, "print('ORIGINAL-RAN')\n", "print('SWAPPED-RAN')\n", "t.py")
        self.assertNotIn("SWAPPED-RAN", r.get("stdout", ""), "root ran the swapped script")
        self.assertEqual(r.get("exitCode"), 126, r)
        self.assertIn("changed after you approved it", r.get("stderr", ""))

    def test_control_without_verification_the_swap_does_run(self) -> None:
        # proves the two tests around it detect the race: run as-is, the swap wins
        r = self.swap_case(sys.executable, "print('ORIGINAL-RAN')\n", "print('SWAPPED-RAN')\n",
                           "t.py", as_is=True)
        self.assertEqual(r.get("stdout", "").strip(), "SWAPPED-RAN")

    def test_a_shell_script_swapped_while_sudo_asks_still_runs_the_approved_bytes(self) -> None:
        r = self.swap_case("/bin/sh", "echo ORIGINAL-RAN\n", "echo SWAPPED-RAN\n", "t.sh")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["stdout"].strip(), "ORIGINAL-RAN")

    def test_a_wrong_password_runs_nothing(self) -> None:
        r, _, audit, _ = self.run_gate("not-the-password")
        self.assertFalse(r["ok"], r)
        self.assertNotIn("ROOT-RAN", r.get("stdout", ""))
        self.assertIn("incorrect password", r.get("stderr", ""))
        self.assertNotIn("not-the-password", audit.read_text())


FAKE_SUDO_ASKPASS = """#!/bin/sh
echo "$*" >> "$FAKE_SUDO_LOG"
askpass=0 prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
  -k) shift ;;
  -A) askpass=1; shift ;;
  -p) prompt=$2; shift 2 ;;
  --) shift; break ;;
  *) break ;;
  esac
done
[ "$askpass" = 1 ] || { echo "expected -A" >&2; exit 3; }
pw=$("$SUDO_ASKPASS" "$prompt")
[ "$pw" = "$FAKE_SUDO_PASSWORD" ] || { echo "sudo: 1 incorrect password attempt" >&2; exit 1; }
exec "$@"
"""

TERMINAL_DRIVER = """
import {{ createPrivilegedGate }} from {gate};
const gate = createPrivilegedGate({{
  approver: async () => ({{ decision: "approve" }}),
  passwordVia: "askpass",
  askpass: async () => process.env.FAKE_ASKPASS,
  home: process.env.GATE_HOME,
  userHome: "/nonexistent-home",
  resolveElevator: () => process.env.FAKE_SUDO,
}});
let screen = "";
const r = await gate.requestAndRun(
  {{ argv: ["/usr/bin/tty"], cwd: "/tmp", why: "terminal e2e", surface: "studio", requester: "e2e" }},
  {{
    onOutput: (s) => {{ screen += s; }},
    terminal: {{
      python: process.env.E2E_PYTHON,
      ptyHost: {pty_host},
      cols: 90,
      rows: 20,
      onStart: () => {{}},
    }},
  }},
);
process.stdout.write("RESULT " + JSON.stringify({{ ...r, screen }}) + "\\n");
"""


@unittest.skipUnless(NODE and (REPO / "studio" / "node_modules").is_dir(), "needs node and studio/node_modules")
class TerminalMode(unittest.TestCase):
    """Studio's "Open as administrator": gate → real pty_host.py → `sudo -A` → the program on a pty."""

    def test_the_program_gets_a_real_terminal_and_the_password_stays_out_of_the_stream(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="prom-gate-term-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        sudo = tmp / "sudo"
        sudo.write_text(FAKE_SUDO_ASKPASS)
        sudo.chmod(0o755)
        askpass = tmp / "askpass.sh"
        askpass.write_text(f"#!/bin/sh\nprintf '%s\\n' '{SECRET}'\n")
        askpass.chmod(0o700)
        driver = tmp / "driver.ts"
        driver.write_text(TERMINAL_DRIVER.format(
            gate=json.dumps(str(HOST / "privileged-gate.ts")),
            pty_host=json.dumps(str(REPO / "studio" / "python" / "tools" / "pty_host.py")),
        ))
        log = tmp / "sudo-args.log"
        env = {
            "PATH": "/usr/bin:/bin", "HOME": str(tmp), "GATE_HOME": str(tmp / "prom-home"),
            "FAKE_SUDO": str(sudo), "FAKE_SUDO_LOG": str(log), "FAKE_SUDO_PASSWORD": SECRET,
            "FAKE_ASKPASS": str(askpass), "E2E_PYTHON": sys.executable,
        }
        out = subprocess.run([str(NODE), "--import", str(DEV_REGISTER), str(driver)], env=env,
                             cwd=str(tmp), capture_output=True, text=True, timeout=90,
                             stdin=subprocess.DEVNULL)
        line = next((l for l in out.stdout.splitlines() if l.startswith("RESULT ")), None)
        self.assertIsNotNone(line, out.stdout + out.stderr)
        r = json.loads(line[len("RESULT "):])
        self.assertTrue(r["ok"], r)
        self.assertRegex(r["screen"], r"/dev/(ttys?\d+|pts/\d+)", "the program did not get a terminal")
        self.assertNotIn("not a tty", r["screen"])
        self.assertNotIn(SECRET, json.dumps(r))
        self.assertNotIn(SECRET, (tmp / "prom-home" / "audit" / "sudo.log").read_text())
        self.assertIn("-A", log.read_text().split())


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("osacompile"), "macOS only")
class MacAskpass(unittest.TestCase):
    def test_the_askpass_dialog_script_compiles(self) -> None:
        # the helper's exact AppleScript, taken from askpassScript() — compiled, never run
        out = subprocess.run(
            [str(NODE), "--import", str(DEV_REGISTER), "-e",
             f"import({json.dumps(str(HOST / 'askpass.ts'))}).then(m => process.stdout.write("
             "m.askpassScript({kind: 'osascript', path: '/usr/bin/osascript'})))"],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        exec_line = next(l for l in out.splitlines() if l.startswith("exec "))
        # every -e '<line>' of the exec line, in order
        parts = exec_line.split(" -e ")[1:]
        lines = [p.strip().split("' \"$1\"")[0].strip("'") for p in parts]
        with tempfile.TemporaryDirectory() as d:
            args = ["osacompile", "-o", os.path.join(d, "askpass.scpt")]
            for l in lines:
                args += ["-e", l]
            r = subprocess.run(args, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("with hidden answer", exec_line, "the password field must not echo")


if __name__ == "__main__":
    unittest.main()
