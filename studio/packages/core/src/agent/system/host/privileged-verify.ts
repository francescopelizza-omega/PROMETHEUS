import { createHash } from "node:crypto";
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/host/privileged-verify.ts — root runs EXACTLY the bytes the human approved.
 *
 * The privileged gate shows a script's SHA-256, binds the approval to it, and re-hashes it just
 * before sudo starts. But sudo then waits for the password, and the root interpreter opens the
 * file only after that — seconds later. Anything running as the user in that window (a parallel
 * agent writing in the workspace, say) could swap the file, and root would run the swap.
 *
 * `verifiedRun` rewrites the approved argv so the bytes root executes cannot differ from the
 * bytes that were approved:
 *
 *   - root-owned    the script's whole path is controlled by root: nobody else can change it,
 *                   so it runs as it is.
 *   - python-loader Python scripts run through PY_LOADER, a fixed loader passed with `-c`: ROOT
 *                   reads the file once, hashes those bytes, refuses (exit 126) unless they match
 *                   the approved hash, and executes the bytes it hashed — no second read.
 *   - shell-inline  sh/bash/zsh/dash/ksh scripts: the approved bytes themselves are passed with
 *                   `-c`, and `$0` is the script's path. The file is never read again.
 *
 * Anything else (perl, ruby, node, an unusual `#!` line, a script too large to pass inline) is
 * REFUSED with the way out: keep it where only root can write, or run it with sh or python.
 * Fail-closed, like the rest of the gate.
 *
 * Verifying the script is worthless if root runs something unverified FIRST, so the
 * interpreter's own start-up is closed too (`sudo` keeps the user's HOME on macOS):
 *
 *   - python      `-s` (no user site-packages: their `.pth` files run at start-up), and the
 *                 loader drops the current folder from `sys.path` BEFORE it imports anything —
 *                 `-c` puts it first, so a `hashlib.py` there ran as root ahead of the check.
 *   - zsh         `-f`: zsh reads `~/.zshenv` even for `-c`.
 *   - any shell   flags that read start-up files (`-i`, `-l`, `--login`, `--rcfile`, …) refuse.
 *   - interpreter one that lives where the agents write (the request's folder, a temp folder)
 *                 refuses: whoever can replace it decides what root runs.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

export type VerifyMode = "none" | "root-owned" | "python-loader" | "shell-inline";

export type VerifiedRun = { argv: string[]; mode: VerifyMode } | { refusal: string };

/**
 * The fixed loader. Run by root as `python [flags] -c PY_LOADER <sha256> <script> [args…]`.
 * It gives the script the world `python <script>` would: `__name__ == "__main__"`, `__file__`,
 * `sys.argv`, and the script's folder first on `sys.path` (unless `-I`/`-P` say otherwise).
 */
export const PY_LOADER = [
  "import sys",
  "def _prometheus_verified():",
  // `-c` put the CURRENT folder first on sys.path. Drop it before the first import that is not
  // built in: `hashlib` found there instead of in the standard library would run as root.
  "    cwd_first = bool(sys.path) and sys.path[0] == ''",
  "    if cwd_first:",
  "        del sys.path[0]",
  "    import hashlib, os",
  "    want, path = sys.argv[1], sys.argv[2]",
  "    with open(path, 'rb') as f:",
  "        code = f.read()",
  "    if hashlib.sha256(code).hexdigest() != want:",
  "        sys.stderr.write('prometheus: ' + path + ' changed after you approved it - not run\\n')",
  "        raise SystemExit(126)",
  "    sys.argv = sys.argv[2:]",
  // what `python script.py` would have put there: the script's folder (unless -I/-P said no)
  "    if cwd_first:",
  "        sys.path.insert(0, os.path.dirname(os.path.abspath(path)))",
  "    return compile(code, path, 'exec'), path",
  "_prometheus_code, __file__ = _prometheus_verified()",
  "del _prometheus_verified",
  "exec(_prometheus_code)",
].join("\n");

/** Linux refuses a single argument over 128 KiB (MAX_ARG_STRLEN); stay well under it. */
export const MAX_INLINE_BYTES = 100_000;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PYTHON = /^python(\d+(\.\d+)*)?$/;

/**
 * Programs that run a SCRIPT FILE named in their arguments. One list, shared with the gate's
 * script detection: a name missing here meant its script was never hashed at all and ran from
 * whatever bytes the file held when root opened it.
 */
export const SCRIPT_INTERPRETERS: ReadonlySet<string> = new Set([
  ...SHELLS,
  "python",
  "perl",
  "ruby",
  "node",
  "fish",
  "csh",
  "tcsh",
  "php",
  "lua",
  "luajit",
  "tclsh",
  "wish",
  "rscript",
  "pwsh",
  "osascript",
  "deno",
  "bun",
]);

/** `/usr/bin/python3.12` → `python`, `lua5.4` → `lua`: the program a path names, version-free. */
export function interpreterName(bin: string): string {
  return basename(bin)
    .toLowerCase()
    .replace(/[\d.]+$/, "");
}

function family(bin: string): "python" | "shell" | "other" {
  const name = basename(bin).toLowerCase();
  if (PYTHON.test(name)) return "python";
  if (SHELLS.has(name)) return "shell";
  return "other";
}

/** Shell flags that make the shell read start-up files (or a script from elsewhere) first. */
function unsafeShellFlag(flag: string): boolean {
  if (flag.startsWith("--")) return true;
  return /^[-+][A-Za-z]*[cils][A-Za-z]*$/.test(flag) || !/^[-+][A-Za-z]+$/.test(flag);
}

/** Python already told not to load the user's site-packages (`-s`, or `-I` which implies it). */
function pythonSkipsUserSite(flags: readonly string[]): boolean {
  return flags.some((f) => /^-[A-Za-z]*[sI][A-Za-z]*$/.test(f));
}

/** Root-owned, and writable by nobody but root (a fake elevator would harvest the password). */
export function trustedBinary(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * True when nobody but root can change what this path names: the file and every directory
 * above it — along the path as given AND along its resolved target — are root-owned and not
 * group/other-writable. (A symlink itself cannot be edited, only replaced in its directory,
 * which the directory check covers.)
 */
export function rootControlled(path: string): boolean {
  const chain = (start: string): string[] => {
    const out: string[] = [];
    let cur = start;
    for (;;) {
      out.push(cur);
      const up = dirname(cur);
      if (up === cur) return out;
      cur = up;
    }
  };
  try {
    for (const p of new Set([...chain(resolvePath(path)), ...chain(realpathSync(path))])) {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Temp folders every process of the user — every agent — may write. */
export function tempRoots(): string[] {
  const out: string[] = [];
  for (const d of [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/dev/shm"]) {
    try {
      const r = realpathSync(d);
      if (!out.includes(r)) out.push(r);
    } catch {
      /* not on this system */
    }
  }
  return out;
}

/**
 * True when `path` sits where the agents write: inside the request's folder (unless only root
 * can change that folder — `cwd: "/"` is not a workspace) or inside a temp folder. A program
 * there can be replaced after the human approved it, before root starts it.
 */
export function inAgentFolder(
  path: string,
  cwd: string,
  opts: { rootControlled?: (p: string) => boolean; temps?: readonly string[] } = {},
): boolean {
  // relative to the REQUEST's folder, and through symlinks (macOS: /var → /private/var) — of
  // the parent when the file itself is not there yet
  const abs = resolvePath(cwd, path);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    try {
      real = join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      real = abs;
    }
  }
  const isRoot = opts.rootControlled ?? rootControlled;
  const roots = [...(opts.temps ?? tempRoots())];
  try {
    const c = realpathSync(cwd);
    if (!isRoot(c)) roots.push(c);
  } catch {
    /* a cwd that does not exist names no folder */
  }
  return roots.some((r) => r !== "/" && (real === r || real.startsWith(`${r}/`)));
}

export interface VerifyDeps {
  rootControlled?: (path: string) => boolean;
  /** a trusted interpreter binary (for `#!/usr/bin/env NAME`) */
  trusted?: (path: string) => boolean;
  read?: (path: string) => Buffer;
  /** test seam: the temp folders (default: the real ones) */
  temps?: readonly string[];
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function refuseOther(what: string, path: string): VerifiedRun {
  return {
    refusal: `the ${what} script ${path} could be changed between your approval and the moment root reads it — keep it where only root can write (a root-owned directory), or run it with sh or python`,
  };
}

function rewrite(
  interp: string,
  inFlags: readonly string[],
  scriptPath: string,
  rest: readonly string[],
  bytes: Buffer,
  approvedSha: string,
): VerifiedRun {
  let flags: readonly string[] = inFlags;
  const fam = family(interp);
  if (fam === "python") {
    const site = pythonSkipsUserSite(flags) ? [] : ["-s"];
    return {
      argv: [interp, ...site, ...flags, "-c", PY_LOADER, approvedSha, scriptPath, ...rest],
      mode: "python-loader",
    };
  }
  if (fam === "shell") {
    const bad = flags.find(unsafeShellFlag);
    if (bad !== undefined) {
      return {
        refusal: `\`${basename(interp)} ${bad}\` makes the shell read start-up files (or other input) before the approved script — drop the flag`,
      };
    }
    // zsh reads ~/.zshenv even for `-c`, and sudo keeps the user's HOME: -f (NO_RCS) skips it
    const rcs = basename(interp) === "zsh" && !flags.includes("-f") ? ["-f"] : [];
    flags = [...rcs, ...flags];
    if (bytes.length > MAX_INLINE_BYTES) {
      return {
        refusal: `the shell script ${scriptPath} is too large to run from its approved bytes (${bytes.length} bytes, limit ${MAX_INLINE_BYTES}) — keep it where only root can write, or split it`,
      };
    }
    if (bytes.includes(0)) {
      return {
        refusal: `the shell script ${scriptPath} contains a NUL byte and cannot be passed as approved`,
      };
    }
    return {
      argv: [interp, ...flags, "-c", bytes.toString("utf8"), scriptPath, ...rest],
      mode: "shell-inline",
    };
  }
  return refuseOther(basename(interp), scriptPath);
}

/**
 * Rewrite an approved argv so root runs exactly the approved script bytes. `script` is what the
 * gate hashed and showed (null when the command runs no script).
 */
export function verifiedRun(
  argv: readonly string[],
  cwd: string,
  script: { path: string; sha256: string } | null,
  deps: VerifyDeps = {},
): VerifiedRun {
  if (!script) return { argv: [...argv], mode: "none" };
  const isRootControlled = deps.rootControlled ?? rootControlled;
  if (isRootControlled(script.path)) {
    // the script cannot change, but the interpreter's start-up still reads the user's files
    const head = argv[0] ?? "";
    const at = argv.findIndex((a, i) => i > 0 && !a.startsWith("-"));
    const flags = argv.slice(1, at < 0 ? argv.length : at);
    if (family(head) === "python" && !pythonSkipsUserSite(flags)) {
      return { argv: [head, "-s", ...argv.slice(1)], mode: "root-owned" };
    }
    if (family(head) === "shell") {
      const bad = flags.find(unsafeShellFlag);
      if (bad !== undefined) {
        return {
          refusal: `\`${basename(head)} ${bad}\` makes the shell read start-up files (or other input) before the approved script — drop the flag`,
        };
      }
      if (basename(head) === "zsh" && !flags.includes("-f")) {
        return { argv: [head, "-f", ...argv.slice(1)], mode: "root-owned" };
      }
    }
    return { argv: [...argv], mode: "root-owned" };
  }

  const read = deps.read ?? ((p: string) => readFileSync(p));
  let bytes: Buffer;
  try {
    bytes = read(script.path);
  } catch {
    return { refusal: `the script ${script.path} could not be read` };
  }
  if (sha256(bytes) !== script.sha256) {
    return { refusal: `the script ${script.path} changed after it was shown to you — not run` };
  }

  const head = argv[0] ?? "";
  if (SCRIPT_INTERPRETERS.has(interpreterName(head))) {
    // interpreter form: `python3 [flags] tool.py [args]`
    const at = argv.findIndex((a, i) => i > 0 && !a.startsWith("-"));
    if (at < 0 || resolvePath(cwd, argv[at] as string) !== script.path) {
      return { refusal: "could not tell which argument is the script — not run" };
    }
    return rewrite(head, argv.slice(1, at), script.path, argv.slice(at + 1), bytes, script.sha256);
  }

  // direct form: `./fix.sh [args]` — follow its #! line
  if (resolvePath(cwd, head) !== script.path) {
    return { refusal: "could not tell which argument is the script — not run" };
  }
  const first = bytes.subarray(0, Math.max(0, bytes.indexOf(10))).toString("utf8");
  if (!first.startsWith("#!")) return refuseOther("unknown", script.path);
  const tokens = first.slice(2).trim().split(/\s+/).filter(Boolean);
  let interp = tokens[0] ?? "";
  let args = tokens.slice(1);
  if (!isAbsolute(interp)) return refuseOther("unknown", script.path);
  if (basename(interp) === "env") {
    const name = args[0] ?? "";
    if (!name || name.startsWith("-") || name.includes("/")) {
      return refuseOther("unknown", script.path);
    }
    const trusted = deps.trusted ?? trustedBinary;
    const found = [`/usr/bin/${name}`, `/bin/${name}`].find(trusted);
    if (!found) return refuseOther(name, script.path);
    interp = found;
    args = args.slice(1);
  }
  if (args.length > 1) return refuseOther(basename(interp), script.path);
  if (
    inAgentFolder(interp, cwd, {
      rootControlled: isRootControlled,
      ...(deps.temps ? { temps: deps.temps } : {}),
    })
  ) {
    return {
      refusal: `the script's interpreter ${interp} is in a folder the agents can write — whoever replaces it decides what root runs. Use a system interpreter (#!/bin/sh, #!/usr/bin/python3)`,
    };
  }
  return rewrite(interp, args, script.path, argv.slice(1), bytes, script.sha256);
}
