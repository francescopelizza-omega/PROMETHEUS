/**
 * requirements-cmd.test.ts — `prometheus requirements`, on machines it can only pretend to be.
 *
 * Every seam is a fake: no os-release is read, no gate runs sudo, nothing is installed. What is
 * asserted is what the human sees and what would run — and that root goes ONLY through the
 * privileged gate, one approved step at a time.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PrivilegedGate, PrivilegedRequest } from "@prometheus/core/agent-system-host";

import type { CliContext } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { type RequirementsDeps, runRequirements } from "./requirements-cmd.js";

setColorEnabled(false);

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';

function ctx(flags: Record<string, string | true> = {}, json = false): CliContext {
  const args: ParsedArgs = {
    command: ["requirements"],
    positionals: [],
    json,
    noColor: true,
    help: false,
    version: false,
    repl: false,
    dryRun: false,
    yes: false,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    flags,
  };
  return { client: {} as CliContext["client"], json, quiet: false, args };
}

function machine(opts: {
  platform?: NodeJS.Platform;
  osRelease?: string | null;
  bins: string[];
  interactive?: boolean;
  decide?: (req: PrivilegedRequest) => "approved" | "denied";
  confirm?: boolean;
  installScript?: string | null;
}) {
  const bins = new Set(opts.bins);
  const lines: string[] = [];
  const requests: PrivilegedRequest[] = [];
  const onTerminal: string[][] = [];
  let gateBuilt = 0;
  const gate = {
    async requestAndRun(req: PrivilegedRequest) {
      requests.push(req);
      const decision = opts.decide ? opts.decide(req) : "approved";
      if (decision === "approved" && req.argv[1] === "install") {
        // the install "worked": its packages' binaries now resolve
        for (const w of req.argv) if (w === "tmux" || w === "git") bins.add(w);
        if (req.argv.includes("bubblewrap")) bins.add("bwrap");
      }
      return {
        ok: decision === "approved",
        decision,
        commandLine: `sudo ${req.argv.join(" ")}`,
        exitCode: 0,
      };
    },
  } as unknown as PrivilegedGate;
  const deps: RequirementsDeps = {
    platform: opts.platform ?? "linux",
    osRelease: () => (opts.osRelease === undefined ? UBUNTU : opts.osRelease),
    which: (b) => (bins.has(b) ? `/usr/bin/${b}` : null),
    desktop: false,
    ostree: false,
    nodeVersion: "22.12.0",
    pythonVersion: async () => "3.12.3  /usr/bin/python3",
    bwrapBlocked: () => null,
    interactive: opts.interactive ?? true,
    write: (l) => lines.push(l),
    confirm: async () => opts.confirm ?? false,
    gate: () => {
      gateBuilt++;
      return gate;
    },
    runOnTerminal: async (argv) => {
      onTerminal.push([...argv]);
      for (const w of argv) if (w === "tmux") bins.add("tmux");
      return 0;
    },
    installScript: opts.installScript ?? null,
    onOutput: () => {},
  };
  return { deps, lines, requests, onTerminal, gateBuilt: () => gateBuilt };
}

test("blank Ubuntu: shows the one command, then runs each step through the privileged gate", async () => {
  const m = machine({ bins: ["apt-get", "rg"] });
  const out = await runRequirements(ctx(), m.deps);
  const said = m.lines.join("\n");
  assert.match(said, /Requirements — Ubuntu 24\.04\.1 LTS · apt-get/);
  assert.match(said, /missing\s+git/);
  assert.match(said, /optional\s+tmux .*compatibility mode/);
  assert.match(
    said,
    /sudo apt-get update && sudo apt-get install -y --no-install-recommends git ca-certificates tmux bubblewrap/,
  );
  assert.match(said, /sudo then asks for your password in this terminal/);
  assert.deepEqual(
    m.requests.map((r) => r.argv),
    [
      ["apt-get", "update"],
      [
        "apt-get",
        "install",
        "-y",
        "--no-install-recommends",
        "git",
        "ca-certificates",
        "tmux",
        "bubblewrap",
      ],
    ],
  );
  for (const r of m.requests) {
    assert.equal(r.surface, "cli");
    assert.equal(r.requester, "prometheus requirements");
    assert.notEqual(r.argv[0], "sudo", "the gate adds the elevator, never the caller");
  }
  assert.match(said, /✓ git, tmux and bubblewrap installed/);
  assert.equal(out.exitCode, 0);
});

test("a step the human denies stops everything after it", async () => {
  const m = machine({ bins: ["apt-get"], decide: () => "denied" });
  const out = await runRequirements(ctx(), m.deps);
  assert.equal(m.requests.length, 1, "nothing after the denied step was attempted");
  assert.match(m.lines.join("\n"), /not run \(denied\)/);
  assert.equal(out.exitCode, 1);
});

test("--check, or no terminal: the command is printed and nothing runs", async () => {
  for (const [flags, interactive] of [
    [{ check: true as const }, true],
    [{}, false],
  ] as const) {
    const m = machine({
      bins: ["dnf"],
      osRelease: 'ID=nobara\nPRETTY_NAME="Nobara Linux 41"\n',
      interactive,
    });
    const out = await runRequirements(ctx(flags), m.deps);
    assert.equal(m.gateBuilt(), 0, "the gate was not even built");
    assert.match(m.lines.join("\n"), /sudo dnf install -y git tmux bubblewrap/);
    assert.equal(out.exitCode, 0);
  }
});

test("macOS with Homebrew: brew needs no root — asked once, run on this terminal", async () => {
  const m = machine({ platform: "darwin", osRelease: null, bins: ["brew", "git"], confirm: true });
  const out = await runRequirements(ctx(), m.deps);
  assert.deepEqual(m.onTerminal, [["brew", "install", "tmux"]]);
  assert.equal(m.gateBuilt(), 0);
  assert.doesNotMatch(m.lines.join("\n"), /bubblewrap/);
  assert.equal(out.exitCode, 0);
});

test("macOS without Homebrew: says how to get it — and never runs its installer from here", async () => {
  const m = machine({
    platform: "darwin",
    osRelease: null,
    bins: [],
    confirm: true,
    installScript: "/Users/u/.prometheus/app/install.sh",
  });
  await runRequirements(ctx(), m.deps);
  const said = m.lines.join("\n");
  assert.match(said, /come from Homebrew, which is not installed/);
  assert.match(said, /sh \/Users\/u\/\.prometheus\/app\/install\.sh --deps/);
  assert.match(said, /brew install git tmux/);
  assert.deepEqual(m.onTerminal, []);
  assert.equal(m.gateBuilt(), 0);
});

test("a bubblewrap the kernel refuses is shown as blocked, not as fine", async () => {
  const m = machine({ bins: ["apt-get", "git", "tmux", "bwrap"] });
  m.deps.bwrapBlocked = () => "bwrap: setting up uid map: Permission denied";
  await runRequirements(ctx(), m.deps);
  const said = m.lines.join("\n");
  assert.match(said, /blocked\s+bubblewrap .*uid map: Permission denied/);
  assert.match(said, /AppArmor profile/);
});

test("--json: one envelope with the command, and nothing runs", async () => {
  const m = machine({ bins: ["apt-get"] });
  const out = await runRequirements(ctx({}, true), m.deps);
  assert.equal(m.gateBuilt(), 0);
  assert.equal(out.json?.ok, false);
  assert.deepEqual(out.json?.missing, ["git", "tmux", "bubblewrap"]);
  assert.match(String(out.json?.command), /^sudo apt-get update && /);
});
