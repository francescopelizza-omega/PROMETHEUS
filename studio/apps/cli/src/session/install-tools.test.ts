/**
 * install-tools.test.ts — `/deps install <tool>`: staged, gated, and never a free-form name.
 *
 * The order of operations IS the security property: fetch (which installs nothing) → nemesis on
 * the bytes that landed → install from that same cache. A test that only checked the happy path
 * would pass just as well against an implementation that installed first and scanned after.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectPackageManager,
  findHostTool,
  installHostTool,
  verdictBlocks,
} from "./install-tools.js";

type Verdict = Parameters<typeof verdictBlocks>[0];
const allow = { verdict: "allow", target: "t", findings: [], riskScore: 0 } as unknown as Verdict;
const block = { verdict: "block", target: "t", findings: [], riskScore: 90 } as unknown as Verdict;
const errored = { verdict: "error", target: "t", findings: [], riskScore: 0 } as unknown as Verdict;

/** A fake host: which() answers from a set, spawn records argv and replies success. */
function fakeDeps(opts: {
  have?: string[];
  gate?: Verdict;
  fail?: string;
  isRoot?: boolean;
}) {
  const spawns: string[][] = [];
  const gated: string[] = [];
  const have = new Set(opts.have ?? ["brew"]);
  return {
    spawns,
    gated,
    deps: {
      spawn: async (cmd: string, args: string[]) => {
        spawns.push([cmd, ...args]);
        const line = [cmd, ...args].join(" ");
        if (opts.fail && line.includes(opts.fail)) {
          return { code: 1, stdout: "", stderr: "boom" };
        }
        return { code: 0, stdout: "/brew/cache/pkg.bottle.tar.gz\n", stderr: "" };
      },
      gate: async (target: string) => {
        gated.push(target);
        return opts.gate ?? allow;
      },
      which: (bin: string): string | null => (have.has(bin) ? `/usr/bin/${bin}` : null),
      ...(opts.isRoot !== undefined ? { isRoot: opts.isRoot } : {}),
    },
  };
}

test("a name outside the catalog never reaches a package manager", async () => {
  // The injection guard: `id` ends up in argv, so it is looked up, never interpolated.
  const f = fakeDeps({});
  const out = await installHostTool("evil; rm -rf ~", f.deps);
  assert.equal(out.kind, "refused");
  assert.match(out.kind === "refused" ? out.error : "", /unknown tool/);
  assert.deepEqual(f.spawns, [], "nothing was spawned for an unknown name");
});

test("an id may be the tool name or one of its binaries", () => {
  assert.equal(findHostTool("imagemagick")?.id, "imagemagick");
  assert.equal(findHostTool("magick")?.id, "imagemagick");
  assert.equal(findHostTool("  YT-DLP ")?.id, "yt-dlp");
  assert.equal(findHostTool("definitely-not-a-tool"), null);
});

test("an already-installed tool is a no-op, not a reinstall", async () => {
  const f = fakeDeps({ have: ["brew", "jq"] });
  const out = await installHostTool("jq", f.deps);
  assert.equal(out.kind, "already");
  assert.deepEqual(f.spawns, []);
});

test("brew: fetch, then GATE, then install — in that order", async () => {
  const f = fakeDeps({ have: ["brew"] });
  const out = await installHostTool("yt-dlp", f.deps);
  assert.equal(out.kind, "installed");
  const verbs = f.spawns.map((s) => s.slice(0, 2).join(" "));
  assert.deepEqual(verbs, ["brew fetch", "brew --cache", "brew install"]);
  assert.deepEqual(f.gated, ["/brew/cache/pkg.bottle.tar.gz"]);
  // the gate ran BEFORE the install, not after it
  const gateBeforeInstall = verbs.indexOf("brew install") === 2;
  assert.ok(gateBeforeInstall, "install must be the LAST step");
});

test("a blocking verdict refuses, and nothing is installed", async () => {
  const f = fakeDeps({ have: ["brew"], gate: block });
  const out = await installHostTool("yt-dlp", f.deps);
  assert.equal(out.kind, "refused");
  assert.match(out.kind === "refused" ? out.error : "", /nemesis block/);
  assert.ok(!f.spawns.some((s) => s[1] === "install"), "brew install must never have run");
});

test("verdict `error` blocks too — that is what fail-closed means", async () => {
  // A missing/timed-out/unparseable scanner is not permission to proceed.
  assert.equal(verdictBlocks(errored), true);
  assert.equal(verdictBlocks(block), true);
  assert.equal(verdictBlocks(allow), false);
  const f = fakeDeps({ have: ["brew"], gate: errored });
  assert.equal((await installHostTool("yt-dlp", f.deps)).kind, "refused");
  assert.ok(!f.spawns.some((s) => s[1] === "install"));
});

test("a failed fetch refuses before the gate is even consulted", async () => {
  const f = fakeDeps({ have: ["brew"], fail: "brew fetch" });
  const out = await installHostTool("pandoc", f.deps);
  assert.equal(out.kind, "refused");
  assert.deepEqual(f.gated, [], "nothing was downloaded, so there is nothing to scan");
});

test("linux without root PRINTS the sudo line rather than running it", async () => {
  // This repo refuses sudo at four layers; a command that shelled out to it would be a fifth
  // layer lying about the other four.
  const f = fakeDeps({ have: ["apt-get"], isRoot: false });
  const out = await installHostTool("ffmpeg", f.deps);
  assert.equal(out.kind, "manual");
  assert.match(out.kind === "manual" ? out.command : "", /^sudo apt-get install -y ffmpeg$/);
  assert.deepEqual(f.spawns, [], "nothing ran");
});

test("no package manager at all is a clear refusal", async () => {
  const f = fakeDeps({ have: [] });
  const out = await installHostTool("jq", f.deps);
  assert.match(out.kind === "refused" ? out.error : "", /no supported package manager/);
});

test("the manager is the first one actually on PATH", () => {
  const w = (set: string[]) => (b: string) => (set.includes(b) ? `/usr/bin/${b}` : null);
  assert.equal(detectPackageManager(w(["brew", "apt-get"])), "brew");
  assert.equal(detectPackageManager(w(["apt-get"])), "apt-get");
  assert.equal(detectPackageManager(w(["pacman"])), "pacman");
  assert.equal(detectPackageManager(w([])), null);
});
