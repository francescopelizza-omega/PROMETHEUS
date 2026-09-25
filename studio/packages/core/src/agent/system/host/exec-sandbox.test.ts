/**
 * exec-sandbox.test.ts — the exec confinement, tested against the REAL kernel where there is
 * one to test against.
 *
 * Two halves, deliberately:
 *
 *   1. Pure assertions on the PLAN (platform gating, fail-closed vs honest-absence, the
 *      rendered SBPL, the bwrap argv). Cheap, deterministic, and worth exactly as much as any
 *      test of a security control against a fake — which is to say, not enough on its own.
 *   2. LIVE checks that spawn real processes through `runParsedCommand` under a real
 *      `sandbox-exec` / real `bwrap`, and assert the KERNEL refused them. A sandbox that
 *      passes unit tests and does not actually block a write is the specific failure this
 *      project has shipped before, so these run the production path end to end: parse →
 *      runParsedCommand → the confinement driver → the command.
 *
 * WHERE EACH HALF IS EVIDENCE, stated so no one reads more into a green run than is there:
 *   • macOS: both halves run. The Seatbelt path is live-verified on the development machine.
 *   • Linux: only the plan half runs on a Mac. The `LIVE(linux)` cases skip unless the host is
 *     Linux with a USABLE bwrap — which is CI's `ubuntu-latest` job, where the workflow
 *     installs bubblewrap for exactly this reason. A green macOS run says nothing whatsoever
 *     about Linux enforcement.
 *   • Windows: no primitive exists, and the only assertion is that the module says so.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseCommand } from "../../exec/index.js";
import { runParsedCommand } from "./exec-runner.js";
import {
  BWRAP_CANDIDATES,
  SEATBELT_BIN,
  type SandboxPlan,
  type SandboxRequest,
  authAllowsNetwork,
  buildBwrapArgs,
  buildSeatbeltProfile,
  describeSandbox,
  planExecSandbox,
  sandboxArgv,
  sandboxHint,
} from "./exec-sandbox.js";

const darwin = process.platform === "darwin";
const live = darwin && existsSync(SEATBELT_BIN);

/**
 * Is there a USABLE bwrap on this host — installed AND able to create a namespace?
 *
 * Two different facts, and the split matters: Ubuntu 24.04 (which is what `ubuntu-latest` is)
 * restricts unprivileged user namespaces through AppArmor, so an installed bwrap that cannot
 * unshare would fail every live check for a reason that has nothing to do with this module.
 * Probing once with a trivial `/bin/true` distinguishes "no primitive here" from "the
 * primitive rejected our policy", and only the second is this file's business.
 *
 * On macOS this never runs (the platform check short-circuits), so the live Linux checks are
 * SKIPPED on the development machine — see the Linux section's note. They are real checks
 * against a real kernel wherever one is available; they are not evidence on a Mac.
 */
function usableBwrap(): string | null {
  if (process.platform !== "linux") return null;
  const bin = BWRAP_CANDIDATES.find((p) => existsSync(p));
  if (!bin) return null;
  const probe = spawnSync(bin, ["--ro-bind", "/", "/", "--", "/bin/true"], { encoding: "utf8" });
  if (probe.status === 0) return bin;
  console.log(`(live linux checks skipped: ${bin} cannot unshare here — ${probe.stderr?.trim()})`);
  return null;
}
const liveLinux = usableBwrap() !== null;

/**
 * A Linux plan built entirely from seams — no Linux kernel is involved, and none is available
 * on the machine this suite normally runs on. `exists` is the ONLY thing that decides whether
 * bwrap is "installed", which is precisely the fail-closed/honest-absence switch under test.
 */
const linuxReq = (over: Partial<SandboxRequest> = {}): SandboxPlan =>
  planExecSandbox({
    writableRoots: ["/work"],
    platform: "linux",
    exists: (p) => p === BWRAP_CANDIDATES[0],
    realpath: (p) => p,
    tmpDirs: ["/tmp"],
    home: "/home/u",
    authLevel: 1,
    ...over,
  });

/* ── the plan: platform gating and the fail-closed branches ──────────────────*/

test("a platform with no confinement primitive gets NO sandbox, and says so rather than pretending", () => {
  for (const platform of ["win32", "aix", "sunos"] as NodeJS.Platform[]) {
    const plan = planExecSandbox({ writableRoots: ["/some/root"], platform });
    assert.equal(plan.kind, "none");
    if (plan.kind !== "none") return;
    assert.match(plan.reason, new RegExp(platform));
  }
});

test("mode:off is an explicit, stated downgrade — never a silent one", () => {
  const plan = planExecSandbox({ writableRoots: ["/r"], platform: "darwin", mode: "off" });
  assert.equal(plan.kind, "none");
  assert.match(describeSandbox(plan), /unsandboxed/);
});

test("a missing sandbox-exec is an ERROR (the caller refuses), not a fallback to unconfined", () => {
  const plan = planExecSandbox({
    writableRoots: ["/r"],
    platform: "darwin",
    exists: () => false,
    realpath: (p) => p,
  });
  assert.equal(plan.kind, "error");
  if (plan.kind !== "error") return;
  assert.match(plan.error, /sandbox-exec is missing/);
});

test("a writable root that resolves to / is refused — that would confine nothing", () => {
  const plan = planExecSandbox({
    writableRoots: ["/"],
    platform: "darwin",
    exists: () => true,
    realpath: (p) => p,
  });
  assert.equal(plan.kind, "error");
  if (plan.kind !== "error") return;
  assert.match(plan.error, /filesystem root/);
});

test("roots that do not resolve are simply not granted (never a bare allow)", () => {
  const plan = planExecSandbox({
    writableRoots: ["/nope"],
    platform: "darwin",
    exists: () => true,
    realpath: () => {
      throw new Error("ENOENT");
    },
    tmpDirs: [],
    home: "/no/such/home",
  });
  assert.equal(plan.kind, "seatbelt");
  if (plan.kind !== "seatbelt") return;
  assert.deepEqual(plan.writable, []);
  // The one rendering bug that would silently disable the whole control.
  assert.doesNotMatch(plan.profile, /\(allow file-write\*\s*\)/);
  assert.match(plan.profile, /every filesystem write is denied/);
});

/* ── the toolchain caches, and the credential files they contain ─────────────*/

test("the named tool caches cover the toolchains that cannot build without them", () => {
  const plan = planExecSandbox({
    writableRoots: [],
    platform: "darwin",
    exists: () => true,
    realpath: (p) => p, // every path "resolves", so the whole list is granted
    tmpDirs: [],
    home: "/h",
  });
  assert.equal(plan.kind, "seatbelt");
  if (plan.kind !== "seatbelt") return;
  for (const c of [
    "/h/Library/Caches",
    "/h/.cache",
    "/h/.npm",
    "/h/.pnpm-store",
    "/h/.cargo",
    "/h/.rustup",
    "/h/.gradle",
    "/h/.m2",
    "/h/.bun/install/cache",
  ]) {
    assert.ok(plan.writable.includes(c), `${c} must be writable or that toolchain cannot run`);
  }
  // …and the two that are deliberately NOT granted, because they are on PATH rather than
  // build inputs: bun's install root and deno's install root.
  assert.ok(!plan.writable.includes("/h/.bun"), "~/.bun holds bin/ and must stay unwritable");
  assert.ok(!plan.writable.includes("/h/.deno"), "~/.deno is DENO_INSTALL_ROOT, not a cache");
});

test("granting a toolchain cache never grants the credential file inside it", () => {
  const plan = planExecSandbox({
    writableRoots: ["/h"], // the worst case: home IS the working set
    platform: "darwin",
    exists: () => true,
    realpath: (p) => p,
    tmpDirs: [],
    home: "/h",
  });
  assert.equal(plan.kind, "seatbelt");
  if (plan.kind !== "seatbelt") return;
  // The regression this guards: `.cargo`/`.m2`/`.gradle` became blanket-writable roots, and a
  // blanket root without these denies would hand a sandboxed command write access to registry
  // tokens it previously could not reach at all.
  for (const secret of [
    "/h/.cargo/credentials.toml",
    "/h/.cargo/credentials",
    "/h/.m2/settings.xml",
    "/h/.m2/settings-security.xml",
    "/h/.gradle/gradle.properties",
  ]) {
    assert.ok(plan.denied.includes(secret), `${secret} must be denied back`);
    // Denied as a FILE, never by denying its parent — denying `~/.cargo` outright would undo
    // the grant that made cargo work in the first place.
    assert.ok(!plan.denied.includes("/h/.cargo"), "the whole cache dir must NOT be denied");
    assert.ok(!plan.denied.includes("/h/.m2"), "the whole cache dir must NOT be denied");
  }
  // …and the ordering that makes the deny actually win: every deny param is rendered after
  // every write param, because SBPL is last-match-wins.
  const lastWrite = plan.params.lastIndexOf(
    plan.params.filter((p) => p.startsWith("PROM_W")).at(-1) as string,
  );
  const firstDeny = plan.params.findIndex((p) => p.startsWith("PROM_D"));
  assert.ok(firstDeny > lastWrite, "a deny rendered before the writes would not take effect");
});

/* ── the rendered profile ────────────────────────────────────────────────────*/

test("an empty writable set never renders an unfiltered (allow file-write*)", () => {
  const profile = buildSeatbeltProfile({ writeCount: 0, denyCount: 0, network: false });
  assert.doesNotMatch(profile, /\(allow file-write\*\s*\)/);
  assert.match(profile, /\(deny default\)/);
});

test("the deny block is rendered AFTER the allow block (SBPL is last-match-wins)", () => {
  const profile = buildSeatbeltProfile({ writeCount: 2, denyCount: 2, network: false });
  const allowAt = profile.indexOf('(subpath (param "PROM_W0"))');
  const denyAt = profile.indexOf('(subpath (param "PROM_D0"))');
  assert.ok(allowAt > 0 && denyAt > 0);
  assert.ok(denyAt > allowAt, "a deny rendered before its allow would not take effect");
});

test("network follows the ladder's own A5 `install` bit, not a second opinion", () => {
  for (let level = 0; level <= 4; level++) assert.equal(authAllowsNetwork(level), false);
  for (let level = 5; level <= 7; level++) assert.equal(authAllowsNetwork(level), true);
  assert.match(
    buildSeatbeltProfile({ writeCount: 1, denyCount: 0, network: false }),
    /\(deny network\*\)/,
  );
  assert.match(
    buildSeatbeltProfile({ writeCount: 1, denyCount: 0, network: true }),
    /\(allow network\*\)/,
  );
});

test("paths travel as -D parameters, so no path is ever concatenated into profile source", () => {
  const evil = '/tmp/x") (allow file-write* (subpath "/")) (;';
  const plan = planExecSandbox({
    writableRoots: [evil],
    platform: "darwin",
    exists: () => true,
    realpath: (p) => p,
    tmpDirs: [],
    home: "/h",
  });
  assert.equal(plan.kind, "seatbelt");
  if (plan.kind !== "seatbelt") return;
  assert.ok(!plan.profile.includes(evil), "the profile must not contain the path at all");
  assert.ok(plan.params.includes(`PROM_W0=${evil}`));
  assert.doesNotMatch(plan.profile, /\(subpath "\/"\)/);
});

/* ── argv wrapping ───────────────────────────────────────────────────────────*/

test("sandboxArgv wraps for a built plan and passes through for every other kind", () => {
  const plan = planExecSandbox({
    writableRoots: ["/r"],
    platform: "darwin",
    exists: () => true,
    realpath: (p) => p,
    tmpDirs: [],
    home: "/h",
  });
  assert.equal(plan.kind, "seatbelt");
  const wrapped = sandboxArgv(plan, ["ls", "-la"]);
  assert.equal(wrapped[0], SEATBELT_BIN);
  assert.equal(wrapped[1], "-p");
  assert.deepEqual(wrapped.slice(-2), ["ls", "-la"]);

  const none: SandboxPlan = { kind: "none", reason: "test" };
  assert.deepEqual(sandboxArgv(none, ["ls"]), ["ls"]);
  assert.deepEqual(sandboxArgv(undefined, ["ls"]), ["ls"]);
});

/* ── Linux / bubblewrap ──────────────────────────────────────────────────────
 *
 * UNIT-TESTED ONLY, and stated plainly rather than implied: every assertion below is about
 * the argv this module HANDS to bwrap. None of it proves the Linux kernel enforces anything,
 * because this suite's development machine is macOS and there is no Linux kernel here to ask.
 * The macOS half of this file is live because it CAN be; this half is not, and no test in it
 * should be read as evidence of enforcement. `.github/workflows/ci.yml` runs these same tests
 * on ubuntu-latest, where the live half of the story can eventually be told.
 */

test("Linux with no bwrap installed is HONEST ABSENCE (none), never a refusal", () => {
  const plan = linuxReq({ exists: () => false });
  assert.equal(plan.kind, "none");
  if (plan.kind !== "none") return;
  assert.match(plan.reason, /bubblewrap|bwrap/);
  // The distinction that matters: an absent optional package must not become a denial of
  // service. `none` is recorded in the audit; `error` would refuse the command outright.
  assert.match(describeSandbox(plan), /unsandboxed/);
});

test("Linux WITH bwrap installed but an unbuildable working set FAILS CLOSED", () => {
  // bwrap exists ⇒ this command was going to be confined ⇒ failing to confine it is a refusal.
  const plan = linuxReq({ writableRoots: ["/"] });
  assert.equal(plan.kind, "error");
  if (plan.kind !== "error") return;
  assert.match(plan.error, /filesystem root/);
});

test("…and the same broken working set with NO bwrap is still just absence", () => {
  // Ordering check, not a nicety: if the working set were built before the driver was looked
  // for, a machine that never had a sandbox would start refusing commands.
  const plan = linuxReq({ writableRoots: ["/"], exists: () => false });
  assert.equal(plan.kind, "none");
});

test("bwrap is found by absolute path, in order, and never through PATH", () => {
  const second = BWRAP_CANDIDATES[1] as string;
  const plan = linuxReq({ exists: (p) => p === second });
  assert.equal(plan.kind, "bwrap");
  if (plan.kind !== "bwrap") return;
  assert.equal(plan.bin, second);
  for (const c of BWRAP_CANDIDATES) assert.ok(c.startsWith("/"), "no relative/PATH lookup");
  // first-hit-wins when several are present
  const both = linuxReq({ exists: (p) => BWRAP_CANDIDATES.includes(p) });
  assert.equal(both.kind === "bwrap" && both.bin, BWRAP_CANDIDATES[0]);
});

test("Linux and macOS compute the SAME working set — one decision, two expressions", () => {
  const common = {
    writableRoots: ["/work"],
    exists: () => true,
    realpath: (p: string) => p,
    tmpDirs: ["/tmp"],
    home: "/home/u",
    authLevel: 1,
  };
  const mac = planExecSandbox({ ...common, platform: "darwin" });
  const lin = planExecSandbox({ ...common, platform: "linux" });
  assert.equal(mac.kind, "seatbelt");
  assert.equal(lin.kind, "bwrap");
  if (mac.kind !== "seatbelt" || lin.kind !== "bwrap") return;
  assert.deepEqual(lin.writable, mac.writable);
  assert.deepEqual(lin.denied, mac.denied);
  assert.equal(lin.network, mac.network);
});

test("the bwrap argv is ordered so the last mount wins, exactly like the SBPL deny block", () => {
  const args = buildBwrapArgs({
    writable: ["/work", "/home/u"],
    denied: ["/home/u/.ssh", "/home/u/.cargo/credentials.toml"],
    network: false,
  });
  const line = args.join(" ");
  const roRootAt = line.indexOf("--ro-bind / /");
  const writableAt = line.indexOf("--bind /home/u /home/u");
  const denyAt = line.indexOf("--ro-bind-try /home/u/.ssh /home/u/.ssh");
  assert.ok(roRootAt >= 0, "the whole filesystem must be bound read-only first");
  assert.ok(writableAt > roRootAt, "a writable bind before the ro root would be overwritten");
  assert.ok(denyAt > writableAt, "a deny applied before its writable root would not take effect");
  assert.ok(line.includes("--ro-bind-try /home/u/.cargo/credentials.toml"));
  // the isolation flags, and the terminator that stops bwrap parsing the command's own argv
  assert.ok(args.includes("--unshare-pid"));
  assert.ok(args.includes("--die-with-parent"));
  assert.ok(args.includes("--proc") && args.includes("--dev"));
  assert.equal(args.at(-1), "--");
});

test("the network flag follows the same A5 bit as the Seatbelt profile", () => {
  assert.ok(buildBwrapArgs({ writable: [], denied: [], network: false }).includes("--unshare-net"));
  assert.ok(!buildBwrapArgs({ writable: [], denied: [], network: true }).includes("--unshare-net"));
  const denied = linuxReq({ authLevel: 1 });
  const allowed = linuxReq({ authLevel: 5 });
  assert.equal(denied.kind === "bwrap" && denied.args.includes("--unshare-net"), true);
  assert.equal(allowed.kind === "bwrap" && allowed.args.includes("--unshare-net"), false);
});

test("an empty writable set produces NO writable bind at all (never a bare --bind / /)", () => {
  const args = buildBwrapArgs({ writable: [], denied: [], network: false });
  assert.equal(
    args.filter((a) => a === "--bind").length,
    0,
    "nothing writable must mean nothing bound writable",
  );
  assert.ok(args.join(" ").includes("--ro-bind / /"));
});

test("a path that looks like a bwrap option is an OPERAND, not an option", () => {
  const evil = "/tmp/--unshare-all";
  const args = buildBwrapArgs({ writable: [evil], denied: [], network: false });
  const at = args.indexOf(evil);
  assert.ok(at > 0);
  // it appears only ever directly after `--bind` (and once more as the destination), so bwrap
  // consumes it positionally; each path is its own argv element in a shell:false spawn.
  assert.equal(args[at - 1], "--bind");
  assert.equal(args[at + 1], evil);
  assert.equal(args.filter((a) => a === evil).length, 2);
});

test("sandboxArgv wraps a bwrap plan with the driver, the mounts, then the command", () => {
  const plan = linuxReq();
  assert.equal(plan.kind, "bwrap");
  if (plan.kind !== "bwrap") return;
  const wrapped = sandboxArgv(plan, ["ls", "-la"]);
  assert.equal(wrapped[0], plan.bin);
  assert.deepEqual(wrapped.slice(-2), ["ls", "-la"]);
  // the command sits strictly after the terminator — nothing in it can be read as a bwrap flag
  assert.ok(wrapped.lastIndexOf("--") < wrapped.length - 2);
  assert.match(describeSandbox(plan), /^bwrap: \d+ writable root\(s\), network denied$/);
});

test("sandboxHint speaks Linux errno too — EROFS is the same refusal as EPERM", () => {
  const plan = linuxReq();
  // A write outside the working set lands on a read-only bind, so the kernel says EROFS.
  assert.match(sandboxHint(plan, "touch: /etc/x: Read-only file system") ?? "", /add-dir/);
  assert.match(sandboxHint(plan, "curl: (6) Could not resolve host") ?? "", /level 5/);
  // bwrap failing to START is not the command failing — say so, or the model retries forever.
  assert.match(
    sandboxHint(plan, "bwrap: No permissions to creating new namespace") ?? "",
    /did not run at all/,
  );
  // …and an ordinary failure is still not blamed on the sandbox.
  assert.equal(sandboxHint(plan, "ls: nope: No such file or directory"), null);
});

/* ── the hint: say when the SANDBOX is what refused ──────────────────────────*/

test("sandboxHint names the sandbox as the cause, and only when it plausibly was", () => {
  const plan = planExecSandbox({
    writableRoots: ["/r"],
    platform: "darwin",
    exists: () => true,
    realpath: (p) => p,
    tmpDirs: [],
    home: "/h",
    authLevel: 1,
  });
  assert.match(
    sandboxHint(plan, "sandbox-exec: execvp() of '/bin/ps' failed: Operation not permitted") ?? "",
    /setuid/,
  );
  assert.match(sandboxHint(plan, "touch: /x: Operation not permitted") ?? "", /add-dir/);
  assert.match(sandboxHint(plan, "curl: (6) Could not resolve host") ?? "", /level 5/);
  // An ordinary failure is NOT blamed on the sandbox — that would send the model chasing a
  // permission problem that does not exist.
  assert.equal(sandboxHint(plan, "ls: nope: No such file or directory"), null);
  // …and nothing is blamed on a sandbox that was never applied.
  assert.equal(sandboxHint({ kind: "none", reason: "linux" }, "Operation not permitted"), null);
});

/* ── fail-closed at the runner ───────────────────────────────────────────────*/

const parsed = (line: string) => {
  const p = parseCommand(line, { vars: {} });
  assert.ok(p.ok, `parse failed for ${line}`);
  return p.command;
};

test("a REAL spawn with no sandbox decision is refused before anything is spawned", async () => {
  const r = await runParsedCommand(parsed("ls"), { cwd: process.cwd() });
  assert.equal(r.exitCode, 126);
  assert.deepEqual(r.argvExecuted, []);
  assert.match(r.stderr, /no sandbox decision/);
});

test("a FAILED sandbox plan is refused at the runner too, not silently run unconfined", async () => {
  const r = await runParsedCommand(parsed("ls"), {
    cwd: process.cwd(),
    sandbox: { kind: "error", error: "sandbox-exec is missing" },
  });
  assert.equal(r.exitCode, 126);
  assert.deepEqual(r.argvExecuted, []);
  assert.match(r.stderr, /could not be established/);
});

test("a test fake is exempt — it cannot reach the kernel, so it needs no plan", async () => {
  let saw: string[] = [];
  const r = await runParsedCommand(parsed("ls -la"), {
    cwd: process.cwd(),
    spawnImpl: ((cmd: string, args: string[]) => {
      saw = [cmd, ...args];
      return {
        pid: 1234,
        stdout: { on: (_e: string, _cb: unknown) => undefined },
        stderr: { on: (_e: string, _cb: unknown) => undefined },
        stdin: { end: () => undefined, write: () => undefined },
        on: (e: string, cb: (a?: unknown) => void) => {
          if (e === "close") setTimeout(() => cb(0), 0);
        },
        kill: () => undefined,
      };
    }) as never,
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(saw, ["ls", "-la"], "an unsandboxed fake must still see the bare argv");
});

/* ── LIVE: the kernel actually enforces this ─────────────────────────────────*/

/** A scratch tree + a plan whose ONLY writable root is that tree. */
function liveFixture(opts: { network?: boolean; home?: string } = {}) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "prom-sbx-"));
  const inside = join(root, "inside");
  mkdirSync(inside);
  const plan = planExecSandbox({
    writableRoots: [inside],
    // the temp dirs are excluded so "outside" can be a sibling in /tmp — otherwise the
    // documented temp grant would (correctly) allow the write and prove nothing.
    tmpDirs: [],
    authLevel: opts.network ? 5 : 1,
    ...(opts.home ? { home: opts.home } : {}),
  });
  assert.equal(plan.kind, "seatbelt");
  return { root, inside, plan, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test(
  "LIVE: a write OUTSIDE the working set is refused by the kernel",
  { skip: !live },
  async () => {
    const f = liveFixture();
    try {
      const target = join(f.root, "escaped.txt");
      const r = await runParsedCommand(parsed(`touch ${target}`), {
        cwd: f.inside,
        sandbox: f.plan,
      });
      assert.notEqual(r.exitCode, 0, "the write must fail");
      assert.match(r.stderr, /Operation not permitted/i);
      assert.equal(existsSync(target), false, "and must not have created the file");
    } finally {
      f.cleanup();
    }
  },
);

test("LIVE: a write INSIDE the working set still succeeds", { skip: !live }, async () => {
  const f = liveFixture();
  try {
    const target = join(f.inside, "ok.txt");
    const r = await runParsedCommand(parsed(`touch ${target}`), {
      cwd: f.inside,
      sandbox: f.plan,
    });
    assert.equal(r.exitCode, 0, `expected success, got: ${r.stderr}`);
    assert.equal(existsSync(target), true);
  } finally {
    f.cleanup();
  }
});

test(
  "LIVE: a credential/persistence path is refused even INSIDE a writable root",
  { skip: !live },
  async () => {
    // The case this exists for: a session whose cwd is the home directory.
    const f = liveFixture({ home: undefined });
    try {
      const plan = planExecSandbox({
        writableRoots: [f.inside],
        tmpDirs: [],
        authLevel: 1,
        home: f.inside, // pretend this tree IS home
      });
      assert.equal(plan.kind, "seatbelt");
      const rc = await runParsedCommand(parsed(`touch ${join(f.inside, ".zshrc")}`), {
        cwd: f.inside,
        sandbox: plan,
      });
      assert.notEqual(rc.exitCode, 0);
      assert.match(rc.stderr, /Operation not permitted/i);
      // …while an ordinary file in the same directory is still writable.
      const ok = await runParsedCommand(parsed(`touch ${join(f.inside, "notes.txt")}`), {
        cwd: f.inside,
        sandbox: plan,
      });
      assert.equal(ok.exitCode, 0, ok.stderr);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "LIVE: a toolchain cache is writable, but the credential file inside it is not",
  { skip: !live },
  async () => {
    // The exact hazard introduced by making `~/.cargo` and `~/.m2` writable roots: the tokens
    // live directly inside them. Asserted against the real kernel, not against the profile
    // text — a deny that renders correctly and does not enforce is the failure mode that
    // matters.
    const root = mkdtempSync(join(realpathSync.native(tmpdir()), "prom-sbx-"));
    try {
      mkdirSync(join(root, ".cargo", "registry"), { recursive: true });
      mkdirSync(join(root, ".m2"), { recursive: true });
      const plan = planExecSandbox({
        writableRoots: [root],
        tmpDirs: [],
        authLevel: 1,
        home: root, // this tree IS home, so ~/.cargo and ~/.m2 are granted caches
      });
      assert.equal(plan.kind, "seatbelt");

      const denied = [
        join(root, ".cargo", "credentials.toml"),
        join(root, ".cargo", "credentials"), // the legacy name cargo still prefers when present
        join(root, ".m2", "settings.xml"),
        join(root, ".m2", "settings-security.xml"),
      ];
      for (const target of denied) {
        const r = await runParsedCommand(parsed(`touch ${target}`), { cwd: root, sandbox: plan });
        assert.notEqual(r.exitCode, 0, `${target} must not be writable`);
        assert.match(r.stderr, /Operation not permitted/i);
        assert.equal(existsSync(target), false, `${target} must not even be creatable`);
      }
      // …while the cache itself still works, which is the entire reason it was granted.
      for (const target of [
        join(root, ".cargo", "registry", "index.lock"),
        join(root, ".m2", "x"),
      ]) {
        const ok = await runParsedCommand(parsed(`touch ${target}`), { cwd: root, sandbox: plan });
        assert.equal(ok.exitCode, 0, ok.stderr);
        assert.equal(existsSync(target), true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "LIVE: a directory named like an SBPL injection cannot widen the policy",
  { skip: !live },
  async () => {
    const root = mkdtempSync(join(realpathSync.native(tmpdir()), "prom-sbx-"));
    const evil = join(root, 'w") (allow file-write* (subpath "-")) (;');
    mkdirSync(evil);
    try {
      const plan = planExecSandbox({ writableRoots: [evil], tmpDirs: [], authLevel: 1 });
      assert.equal(plan.kind, "seatbelt");
      const target = join(root, "escaped.txt");
      const r = await runParsedCommand(parsed(`touch ${target}`), { cwd: evil, sandbox: plan });
      assert.notEqual(r.exitCode, 0);
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("LIVE: ordinary allowed commands still work inside the sandbox", { skip: !live }, async () => {
  const f = liveFixture();
  try {
    writeFileSync(join(f.inside, "hello.txt"), "hello sandbox\n", "utf8");
    const ls = await runParsedCommand(parsed("ls -la"), { cwd: f.inside, sandbox: f.plan });
    assert.equal(ls.exitCode, 0, ls.stderr);
    assert.match(ls.stdout, /hello\.txt/);

    const cat = await runParsedCommand(parsed(`cat ${join(f.inside, "hello.txt")}`), {
      cwd: f.inside,
      sandbox: f.plan,
    });
    assert.equal(cat.exitCode, 0, cat.stderr);
    assert.match(cat.stdout, /hello sandbox/);

    // A pipeline, which is where the wrapping could plausibly break: every stage is wrapped
    // separately and the pipes are still ours.
    const piped = await runParsedCommand(parsed("ls | wc -l"), { cwd: f.inside, sandbox: f.plan });
    assert.equal(piped.exitCode, 0, piped.stderr);
    assert.match(piped.stdout.trim(), /^\d+$/);

    // Reads OUTSIDE the working set still work — the documented, deliberate non-restriction.
    const outside = await runParsedCommand(parsed("ls /usr/bin"), {
      cwd: f.inside,
      sandbox: f.plan,
    });
    assert.equal(outside.exitCode, 0, outside.stderr);
  } finally {
    f.cleanup();
  }
});

test("LIVE: the network is refused below A5", { skip: !live }, async () => {
  const f = liveFixture({ network: false });
  try {
    const r = await runParsedCommand(parsed("curl -s -m 10 https://example.com"), {
      cwd: f.inside,
      sandbox: f.plan,
    });
    assert.notEqual(r.exitCode, 0, "curl must not reach the network below A5");
  } finally {
    f.cleanup();
  }
});

test(
  "LIVE: the network is permitted at A5+, where the ladder already allows it",
  { skip: !live },
  async () => {
    const f = liveFixture({ network: true });
    try {
      const r = await runParsedCommand(parsed("curl -s -m 15 -o /dev/null https://example.com"), {
        cwd: f.inside,
        sandbox: f.plan,
      });
      // Offline machines are a fact of life; the assertion that matters is that the SANDBOX
      // is not what stopped it, so a network failure here is reported, not asserted on.
      if (r.exitCode !== 0) {
        console.log(`(skipped assertion: no connectivity — curl exited ${r.exitCode})`);
        return;
      }
      assert.equal(r.exitCode, 0);
    } finally {
      f.cleanup();
    }
  },
);

/* ── LIVE (Linux only): the kernel actually enforces the bwrap plan ───────────
 *
 * These SKIP on macOS, which is where this suite is normally developed — so on a Mac they
 * prove nothing and are not claimed to. They run for real on `ubuntu-latest` in CI, where the
 * workflow installs bubblewrap precisely so this half stops being hypothetical.
 */

/** A scratch tree that IS the fake home, plus a bwrap plan whose only writable root is it. */
function liveLinuxFixture(opts: { network?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "prom-bwrap-"));
  const inside = join(root, "inside");
  mkdirSync(inside);
  const plan = planExecSandbox({
    writableRoots: [inside],
    // excluded so "outside" can be a sibling in /tmp — a granted temp dir would (correctly)
    // allow the write and prove nothing.
    tmpDirs: [],
    authLevel: opts.network ? 5 : 1,
    home: inside,
  });
  assert.equal(plan.kind, "bwrap");
  return { root, inside, plan, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test(
  "LIVE(linux): a write OUTSIDE the working set is refused by the kernel",
  { skip: !liveLinux },
  async () => {
    const f = liveLinuxFixture();
    try {
      const target = join(f.root, "escaped.txt");
      const r = await runParsedCommand(parsed(`touch ${target}`), {
        cwd: f.inside,
        sandbox: f.plan,
      });
      assert.notEqual(r.exitCode, 0, "the write must fail");
      // EROFS, not EPERM — a read-only bind mount, which is why sandboxHint matches both.
      assert.match(r.stderr, /Read-only file system/i);
      assert.equal(existsSync(target), false, "and must not have created the file");
    } finally {
      f.cleanup();
    }
  },
);

test(
  "LIVE(linux): a write INSIDE the working set still succeeds",
  { skip: !liveLinux },
  async () => {
    const f = liveLinuxFixture();
    try {
      const target = join(f.inside, "ok.txt");
      const r = await runParsedCommand(parsed(`touch ${target}`), {
        cwd: f.inside,
        sandbox: f.plan,
      });
      assert.equal(r.exitCode, 0, `expected success, got: ${r.stderr}`);
      assert.equal(existsSync(target), true);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "LIVE(linux): an EXISTING credential file inside a writable root is read-only — and the documented gap is real",
  { skip: !liveLinux },
  async () => {
    const f = liveLinuxFixture();
    try {
      // The plan must be rebuilt AFTER the file exists: `--ro-bind-try` binds what is there.
      mkdirSync(join(f.inside, ".cargo"), { recursive: true });
      writeFileSync(join(f.inside, ".cargo", "credentials.toml"), '[registry]\ntoken="x"\n');
      writeFileSync(join(f.inside, ".zshrc"), "# existing\n");
      const plan = planExecSandbox({
        writableRoots: [f.inside],
        tmpDirs: [],
        authLevel: 1,
        home: f.inside,
      });
      assert.equal(plan.kind, "bwrap");

      for (const target of [
        join(f.inside, ".cargo", "credentials.toml"),
        join(f.inside, ".zshrc"),
      ]) {
        const r = await runParsedCommand(parsed(`touch ${target}`), {
          cwd: f.inside,
          sandbox: plan,
        });
        assert.notEqual(r.exitCode, 0, `${target} must not be writable`);
        assert.match(r.stderr, /Read-only file system/i);
      }
      // …while ordinary files in the same tree, and the cache around the credential file,
      // stay writable — the grant that made the toolchain work is intact.
      for (const target of [
        join(f.inside, "notes.txt"),
        join(f.inside, ".cargo", "registry.lock"),
      ]) {
        const ok = await runParsedCommand(parsed(`touch ${target}`), {
          cwd: f.inside,
          sandbox: plan,
        });
        assert.equal(ok.exitCode, 0, ok.stderr);
      }

      // THE DOCUMENTED GAP, asserted rather than merely written down: a deny path that does
      // NOT exist has nothing to bind read-only, so Linux does not prevent its creation the
      // way macOS's SBPL does. If this ever starts failing, the header is out of date and
      // Linux has become as strict as macOS — a good day, but the comment must change with it.
      const fresh = join(f.inside, ".bashrc");
      const created = await runParsedCommand(parsed(`touch ${fresh}`), {
        cwd: f.inside,
        sandbox: plan,
      });
      assert.equal(created.exitCode, 0, "bwrap has no deny primitive for a non-existent path");
    } finally {
      f.cleanup();
    }
  },
);

test("LIVE(linux): the network is refused below A5", { skip: !liveLinux }, async () => {
  const f = liveLinuxFixture({ network: false });
  try {
    const r = await runParsedCommand(parsed("curl -s -m 10 https://example.com"), {
      cwd: f.inside,
      sandbox: f.plan,
    });
    assert.notEqual(r.exitCode, 0, "curl must not reach the network below A5");
  } finally {
    f.cleanup();
  }
});

test("the persistence deny-list covers Prometheus's OWN state and agent hook configs", () => {
  /**
   * The list already denied every OTHER agent's persistence surface — shell rc files, macOS
   * LaunchAgents — but not the one belonging to the tool doing the sandboxing.
   * `~/.prometheus` holds the REMEMBERED GRANTS: a confined command that can write it grants
   * itself standing permission for every later session, a cleaner persistence primitive than
   * editing `.zshrc`. `~/.claude/settings.json` carries a `hooks` block that runs a shell
   * command on the next session start — arbitrary code execution on a delay.
   */
  const home = homedir();
  const plan = planExecSandbox({ writableRoots: [home], authLevel: 3 });
  const rendered = JSON.stringify(plan);
  for (const p of [
    ".prometheus",
    ".config/prometheus",
    ".claude/settings.json",
    // the pre-existing entries must not have been disturbed
    ".ssh",
    ".zshrc",
  ]) {
    assert.ok(
      rendered.includes(`${home}/${p}`),
      `~/${p} must appear in the sandbox plan's deny set when home is writable`,
    );
  }
});

/* ── the `/in` output folder (2026-09-24) ───────────────────────────────────
 * `/in <folder>` grants a directory in the working set so produced files — a download, a
 * converted image — can be written there. The sandbox is what makes that grant real, and
 * these are the two halves of the contract, verified live against `sandbox-exec` on
 * 2026-09-24 with a yt-dlp download: a write inside the folder succeeded, writes outside it
 * and into `~/.prometheus` were denied, and the network was reachable only at A5+.
 */

test("an /in folder is writable, and the network opens only at A5+", () => {
  const out = "/private/tmp/prom-in-demo-test";
  // seams, like every other plan test here: no real filesystem is involved.
  const req = {
    writableRoots: [out],
    platform: "darwin" as const,
    exists: () => true,
    realpath: (x: string) => x,
    tmpDirs: ["/tmp"],
    home: "/Users/x",
  };
  const a1 = planExecSandbox({ ...req, authLevel: 1 });
  const a5 = planExecSandbox({ ...req, authLevel: 5 });
  assert.equal(a1.kind, "seatbelt");
  assert.equal(a5.kind, "seatbelt");
  if (a1.kind !== "seatbelt" || a5.kind !== "seatbelt") return;

  // the granted folder is writable at BOTH levels — /in is a write grant, not a network one
  assert.ok(a1.writable.includes(out), "the /in folder must be writable");
  assert.ok(a5.writable.includes(out), "the /in folder must be writable");

  // …but only A5 may reach the network, which is why yt-dlp is registered at the `install`
  // tier: below A5 a download cannot work however it is approved at the app layer.
  assert.equal(a1.network, false, "A1 must not reach the network");
  assert.equal(a5.network, true, "A5 auto-approves `install`, so the network is open");
  assert.match(a5.profile, /\(allow network\*\)/);
  assert.doesNotMatch(a1.profile, /\(allow network\*\)/);
});

test("granting an /in folder does NOT make the grants file writable", () => {
  // The standing rule: a confined command that could write ~/.prometheus would grant itself
  // permission for every later session. Verified live — the write was denied.
  const plan = planExecSandbox({
    writableRoots: ["/private/tmp/prom-in-demo-test"],
    platform: "darwin",
    home: "/Users/x",
    authLevel: 5,
    exists: () => true,
    realpath: (x: string) => x,
  });
  assert.equal(plan.kind, "seatbelt");
  if (plan.kind !== "seatbelt") return;
  assert.ok(
    plan.denied.some((d) => d.endsWith("/.prometheus")),
    plan.denied.join(", "),
  );
});
