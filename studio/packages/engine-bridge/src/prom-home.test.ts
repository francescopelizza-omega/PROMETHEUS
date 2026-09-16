/**
 * prom-home.test.ts — the LOCAL twin must not drift from core's canonical resolver.
 *
 * engine-bridge cannot import core (core depends on this package) and the detached watchdog runs
 * with no bundler, so `prometheusHome` exists twice on purpose. The duplication is only safe with
 * a test that pins the two together: three separate hand-rolled copies of the rule previously
 * skipped tilde expansion entirely, which split the start lock, the eviction log and
 * `<home>/state/model-activity.json` across two directories — one of them literally named `~`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

import { expandHomeValue, prometheusHome } from "./prom-home.js";

test("no override → ~/.prometheus", () => {
  assert.equal(prometheusHome({}), join(homedir(), ".prometheus"));
  assert.equal(prometheusHome({ PROMETHEUS_HOME: "" }), join(homedir(), ".prometheus"));
  assert.equal(prometheusHome({ PROMETHEUS_HOME: "   " }), join(homedir(), ".prometheus"));
});

test("a leading ~ is EXPANDED — path.resolve does not do this on its own", () => {
  assert.equal(prometheusHome({ PROMETHEUS_HOME: "~" }), homedir());
  assert.equal(prometheusHome({ PROMETHEUS_HOME: "~/sandbox" }), join(homedir(), "sandbox"));
  // a bare `~foo` is NOT a home reference — this follows core's canonical resolver, which
  // leaves it alone (cli-profiles/paths.ts's twin differs here, deliberately not copied).
  assert.match(prometheusHome({ PROMETHEUS_HOME: "~foo" }), /~foo$/);
});

test("a relative override is made absolute; an absolute one is preserved", () => {
  assert.equal(isAbsolute(prometheusHome({ PROMETHEUS_HOME: "rel/home" })), true);
  assert.equal(prometheusHome({ PROMETHEUS_HOME: "/tmp/sandbox" }), "/tmp/sandbox");
  // trailing whitespace is trimmed, so a stray shell space cannot fork the tree
  assert.equal(prometheusHome({ PROMETHEUS_HOME: " /tmp/sandbox " }), "/tmp/sandbox");
});

test("DRIFT GUARD: byte-identical to core's canonical resolver", () => {
  /**
   * Compared as SOURCE TEXT, not by importing core.
   *
   * engine-bridge declares no dependencies and core depends on THIS package, so importing it —
   * even in a test — would invert the layering and cannot resolve under the workspace's isolated
   * linker. Reading the file is how this repo already pins twins it is not allowed to import.
   */
  const core = readFileSync(
    new URL("../../core/src/agent/system/host/home.ts", import.meta.url),
    "utf8",
  );
  const mine = readFileSync(new URL("./prom-home.ts", import.meta.url), "utf8");
  const bodyOf = (src: string, name: string): string => {
    const i = src.indexOf(`export function ${name}(`);
    assert.notEqual(i, -1, `${name} not found`);
    const open = src.indexOf("{", i);
    const close = src.indexOf("\n}", open);
    assert.notEqual(close, -1, `${name} body not delimited`);
    return src
      .slice(open + 1, close)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))
      .join(" ");
  };
  assert.equal(
    bodyOf(mine, "prometheusHome"),
    bodyOf(core, "prometheusHome"),
    "the twin has drifted from core's resolver — every <home>/state file splits when it does",
  );
  // …and the tilde helper it depends on, which is where all three old copies went wrong.
  const tildeOf = (src: string): string => {
    const i = src.indexOf("function expandTilde(");
    assert.notEqual(i, -1, "expandTilde not found");
    const open = src.indexOf("{", i);
    const close = src.indexOf("\n}", open);
    return src
      .slice(open + 1, close)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))
      .join(" ");
  };
  assert.equal(tildeOf(mine), tildeOf(core), "expandTilde has drifted from core's");
});

test("expandHomeValue keeps ABSENT absent — the engine-resolution lane needs that", () => {
  // `prometheusHome()` defaults to ~/.prometheus; for locate.ts, no home must mean "fall through
  // to the sibling checkout / PATH", not "look under ~/.prometheus".
  assert.equal(expandHomeValue(undefined), undefined);
  assert.equal(expandHomeValue(""), undefined);
  assert.equal(expandHomeValue("  "), undefined);
  assert.equal(expandHomeValue("~/sandbox"), join(homedir(), "sandbox"));
  assert.equal(isAbsolute(expandHomeValue("rel") ?? ""), true);
});
