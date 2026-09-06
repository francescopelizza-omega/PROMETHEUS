/**
 * scripts/check-broadcast-kill.mjs — the "no unguarded kill(2)" guard.
 *
 * WHY THIS EXISTS. On 2026-09-05/06 this machine appeared to hard-lock four times
 * (19:48:54 / 23:13:22 / 08:22:16 / 12:09:53, 147 / 211 / 140 / 64 processes killed each).
 * It was diagnosed as memory starvation for days. It was not. `model-server.test.ts` looped
 * `[-1, 0, NaN, 2**40]` into `signalPid`, which passed the value straight to `process.kill`:
 *
 *     for (const pid of [-1, 0, Number.NaN, 2 ** 40]) signalPid(pid, "SIGKILL");
 *
 * In kill(2) a non-positive pid is not a process, it is a BROADCAST:
 *     -1        every process this uid may signal   <- ends the logged-in session
 *      0        the caller's own process group
 *     < -1      process group |pid|
 * With SIGKILL the first one takes out Dock, Finder, the window server's clients and the
 * terminal running the suite. The assertion (`typeof r.ok === "boolean"`) still passed, and the
 * terminal that would have shown the damage was itself one of the victims — which is exactly
 * why it went unnoticed through four occurrences.
 *
 * THE RULE. Every `process.kill(...)` in source must have a pid guard within the preceding few
 * lines: `pid <= 1` / `pid > 1` / `Number.isInteger(pid)`. Three things are exempt:
 *   - a liveness probe, `process.kill(pid, 0)` — signal 0 delivers nothing,
 *   - a line carrying `// broadcast-kill-allow: <reason>`,
 *   - `node_modules` and build output.
 * TEST FILES ARE DELIBERATELY IN SCOPE. The defect lived in one, and excluding them would have
 * excluded the only file that ever caused this.
 *
 * It also refuses node-pty's `.open()`: node-pty 1.1.0's `UnixTerminal.open()` sets the pid
 * field to -1 and `UnixTerminal.prototype.kill()` does `process.kill(this.pid, ...)` with no
 * check, so a single `pty.open()` caller would reintroduce the same broadcast from a dependency
 * we do not control. There is no such caller today. Keep it that way.
 *
 * Run: node scripts/check-broadcast-kill.mjs   (wired into `pnpm lint`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN = ["packages", "apps"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "release",
  ".git",
  "coverage",
  ".vscode-test",
  "staging",
]);
const SOURCE = /\.(ts|tsx|mjs|js)$/;

/** How many lines back a guard may sit and still count as guarding the call. */
const GUARD_WINDOW = 10;
// Only a real magnitude/integer check counts. Deliberately NOT accepted as guards:
//   `pid == null`                  — null-safe, but -1 and 0 sail straight through
//   `typeof pid === "number"`      — NaN and -1 are both numbers
// The second of those is the exact check that made serve-host's state-file pid reachable, and
// the first is what sidecar-runner had. Accepting either would make this script rubber-stamp
// the very defect it exists to catch.
const GUARD = /pid\s*(<=|>=|>|<|===|!==)\s*-?\d|Number\.isInteger\s*\(/i;

const KILL = /process\.kill\s*\(/;
/** `process.kill(x, 0)` — signal 0 is a liveness probe, it delivers nothing. */
const PROBE = /process\.kill\s*\([^,)]+,\s*0\s*\)/;
const ALLOW = /broadcast-kill-allow/;
/** node-pty's openpty path, whose pid is hard-coded to -1. */
const PTY_OPEN = /\b(?:pty|Pty|PTY|UnixTerminal|WindowsTerminal)\w*\.open\s*\(/;

function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(join(dir, e.name), acc);
    } else if (SOURCE.test(e.name)) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

const files = [];
for (const r of SCAN) {
  try {
    if (statSync(join(ROOT, r)).isDirectory()) collect(join(ROOT, r), files);
  } catch {
    /* root may not exist */
  }
}

const violations = [];
for (const file of files.sort()) {
  let lines;
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    continue;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ALLOW.test(line)) continue;

    if (PTY_OPEN.test(line)) {
      violations.push({
        file,
        line: i + 1,
        text: line.trim(),
        why: "node-pty's .open() hard-codes pid -1; its kill() would broadcast",
      });
      continue;
    }
    if (!KILL.test(line) || PROBE.test(line)) continue;
    // A comment or a string mentioning process.kill is documentation, not a call.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    if (!KILL.test(code)) continue;

    const from = Math.max(0, i - GUARD_WINDOW);
    const window = lines.slice(from, i + 1).join("\n");
    // The marker is honoured anywhere in the window, not just on the call line: biome wraps long
    // calls, and the natural place to write the reason is the line above.
    if (ALLOW.test(window)) continue;
    if (GUARD.test(window)) continue;
    violations.push({
      file,
      line: i + 1,
      text: line.trim(),
      why: `no pid guard within ${GUARD_WINDOW} lines (need pid > 1 / Number.isInteger)`,
    });
  }
}

if (violations.length > 0) {
  console.error(`\ncheck-broadcast-kill: ${violations.length} unguarded kill(2) call site(s).\n`);
  for (const v of violations) {
    console.error(`  ${relative(ROOT, v.file)}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    ↳ ${v.why}\n`);
  }
  console.error(
    "Add a guard (`if (!Number.isInteger(pid) || pid <= 1) return;`) or, if the call is\n" +
      "genuinely safe, annotate the line with `// broadcast-kill-allow: <reason>`.\n",
  );
  process.exit(1);
}

console.error(`check-broadcast-kill: ${files.length} files scanned, no unguarded kill(2) calls.`);
