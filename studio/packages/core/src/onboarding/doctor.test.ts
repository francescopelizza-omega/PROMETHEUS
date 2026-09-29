/**
 * doctor.test.ts — the setup check, across the machine states a real user arrives in.
 *
 * The bug this file exists to prevent is not a crash. It is CONTRADICTORY ADVICE: a report that
 * tells someone to download a model in the same breath as telling them the program that
 * downloads models is missing. A beginner cannot tell a contradiction from their own
 * misunderstanding, so they conclude the tool is broken.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { translator } from "../i18n/index.js";
import {
  MIN_NODE_MAJOR,
  type MachineFacts,
  REQUIREMENTS,
  commandFor,
  diagnose,
  renderDoctor,
  renderGuide,
  stateOf,
  suggestModel,
} from "./index.js";

/** A machine with everything; each test subtracts what it is about. */
const ready = (over: Partial<MachineFacts> = {}): MachineFacts => ({
  platform: "darwin",
  manager: "brew",
  present: new Set(["ollama", "ripgrep", "git"] as const),
  runnerUp: true,
  modelCount: 2,
  availableBytes: 16e9,
  nodeMajor: 22,
  ...over,
});

const ids = (r: ReturnType<typeof diagnose>) => r.blockers.map((b) => b.requirement.id);

/* ── the states a user actually arrives in ─────────────────────────────────────────────────*/

test("a fully set-up machine is ready and lists nothing", () => {
  const r = diagnose(ready());
  assert.equal(r.ready, true);
  assert.deepEqual(ids(r), []);
});

test("a bare machine blocks on ollama and ripgrep — and DEFERS the model", () => {
  // The contradiction this guards: "download a model" printed directly beneath "Ollama is
  // missing", with the model's own text claiming Ollama is installed.
  const r = diagnose(ready({ present: new Set(), runnerUp: false, modelCount: 0 }));
  assert.deepEqual(ids(r), ["ollama", "ripgrep"]);
  const model = r.results.find((x) => x.requirement.id === "model");
  assert.equal(model?.deferred, true, "the model waits for its parent");
  assert.equal(model?.blocking, false);
  assert.ok(
    !r.optional.some((o) => o.requirement.id === "model"),
    "and it is not quietly demoted to 'optional' either — it belongs in neither list",
  );
});

test("ollama present but idle blocks on ollama, not on a reinstall", () => {
  const r = diagnose(ready({ runnerUp: false }));
  assert.deepEqual(ids(r), ["ollama"]);
  assert.equal(r.blockers[0]?.state, "idle", "installed-but-stopped is its own state");
});

test("ollama running with no model blocks on the model", () => {
  const r = diagnose(ready({ modelCount: 0 }));
  assert.deepEqual(ids(r), ["model"]);
});

test("a cloud key removes the LOCAL stack requirements but not PROMETHEUS's own", () => {
  // Someone with an API key does not need ollama or a download. They still need ripgrep and
  // Node — those are this program's dependencies, not the model's, and saying otherwise makes
  // the whole report look like it is guessing.
  const cloud = diagnose(
    ready({
      present: new Set(["ripgrep", "git"]),
      runnerUp: false,
      modelCount: 0,
      cloudConfigured: true,
    }),
  );
  assert.equal(cloud.ready, true);

  const noRg = diagnose(
    ready({ present: new Set(["git"]), runnerUp: false, modelCount: 0, cloudConfigured: true }),
  );
  assert.deepEqual(ids(noRg), ["ripgrep"], "ripgrep is still required with a cloud key");
});

test("an old Node blocks; a new one does not", () => {
  assert.deepEqual(ids(diagnose(ready({ nodeMajor: MIN_NODE_MAJOR - 1 }))), ["node"]);
  assert.deepEqual(ids(diagnose(ready({ nodeMajor: MIN_NODE_MAJOR }))), []);
});

test("git is optional — it is listed, never blocking", () => {
  const r = diagnose(ready({ present: new Set(["ollama", "ripgrep"]) }));
  assert.equal(r.ready, true, "a missing git must not stop a conversation");
  assert.ok(r.optional.some((o) => o.requirement.id === "git"));
});

/* ── failing to measure must never read as failing ─────────────────────────────────────────*/

test("an UNMEASURED fact is 'unknown' and never blocks", () => {
  // The same rule the memory gate follows: a probe that could not answer must not look like a
  // machine that failed the check.
  const r = diagnose(ready({ nodeMajor: undefined, modelCount: undefined }));
  assert.equal(stateOf(REQUIREMENTS[0] as never, ready({ nodeMajor: undefined })), "unknown");
  assert.equal(r.ready, true);
  assert.deepEqual(ids(r), []);
});

/* ── the model suggestion is sized to the machine ──────────────────────────────────────────*/

test("the suggested first model is the biggest that FITS, with headroom", () => {
  assert.equal(suggestModel(16e9)?.tag, "qwen3:8b");
  // 6 GB free minus 2 GB headroom = 4 GB usable: the 5.2 GB model must not be suggested.
  assert.equal(suggestModel(6e9)?.tag, "llama3.2:3b");
  assert.equal(suggestModel(4e9)?.tag, "qwen3:1.7b");
});

test("a machine too small for anything gets an honest null, not the smallest model anyway", () => {
  assert.equal(suggestModel(2e9), null);
  assert.equal(suggestModel(0), null);
  assert.equal(suggestModel(undefined), null);
});

/* ── commands: per platform, and never invented ────────────────────────────────────────────*/

test("the install command follows the package manager", () => {
  const ollama = REQUIREMENTS.find((r) => r.id === "ollama") as never;
  assert.equal(commandFor(ollama, "brew"), "brew install ollama");
  assert.match(commandFor(ollama, "apt") ?? "", /ollama\.com\/install\.sh/);
  assert.equal(commandFor(ollama, "none"), null, "an unknown manager yields null, not a guess");
});

test("every required item can be installed on macOS and on Debian", () => {
  // A required item with no command on a mainstream platform is a dead end for that user.
  for (const r of REQUIREMENTS.filter((x) => x.tier === "required" && x.id !== "model")) {
    assert.ok(commandFor(r, "brew"), `${r.id} has no brew command`);
    assert.ok(commandFor(r, "apt"), `${r.id} has no apt command`);
  }
});

/* ── rendering ─────────────────────────────────────────────────────────────────────────────*/

test("the rendered report never translates a command", () => {
  // The rule the whole feature rests on: a localised `brew install ollama` does not run.
  const facts = ready({ present: new Set(), runnerUp: false, modelCount: 0 });
  const report = diagnose(facts);
  for (const loc of ["en", "it", "de", "pl"] as const) {
    const text = renderDoctor(report, translator(loc), facts).join("\n");
    assert.ok(text.includes("brew install ollama"), `${loc} lost the ollama command`);
    assert.ok(text.includes("brew install ripgrep"), `${loc} lost the ripgrep command`);
  }
});

test("the report states the WHY for everything it asks the user to install", () => {
  const facts = ready({ present: new Set(), runnerUp: false, modelCount: 0 });
  const text = renderDoctor(diagnose(facts), translator("en"), facts).join("\n");
  // A list of package names with no reasons is a list of things to distrust.
  assert.ok(text.includes("PROMETHEUS does not contain an AI model"));
  assert.ok(text.includes("Why:"));
  // And it says what PROMETHEUS will and will not do on the user's behalf.
  assert.ok(text.includes("never runs an install for you"));
  assert.ok(text.includes("scanned before it is allowed to run"));
});

test("a piped-to-shell command carries the network caveat; a sudo command carries the password one", () => {
  const facts = ready({
    platform: "linux",
    manager: "apt",
    present: new Set(),
    runnerUp: false,
    modelCount: 0,
  });
  const text = renderDoctor(diagnose(facts), translator("en"), facts).join("\n");
  assert.match(text, /ollama\.com\/install\.sh \| sh/);
  assert.ok(text.includes("downloads from the internet"), "a curl|sh needs saying so");
  assert.ok(text.includes("administrator rights"), "a sudo command needs saying so");
});

test("a ready machine renders the short, positive form", () => {
  const facts = ready();
  const text = renderDoctor(diagnose(facts), translator("en"), facts).join("\n");
  assert.ok(text.includes("You are ready to go"));
  // No install noise, and no cloud pitch, when nothing is wrong.
  assert.ok(!text.includes("Install:"));
  assert.ok(!text.includes("Or use a cloud provider"));
});

test("an unknown platform admits it instead of inventing a command", () => {
  const facts = ready({
    platform: "freebsd",
    manager: "none",
    present: new Set(),
    runnerUp: false,
    modelCount: 0,
  });
  const text = renderDoctor(diagnose(facts), translator("en"), facts).join("\n");
  assert.ok(text.includes("does not recognise this operating system"));
});

test("the guide renders all five steps in every language", () => {
  for (const loc of ["en", "it", "fr", "es", "de", "pt", "nl", "pl"] as const) {
    const lines = renderGuide(translator(loc));
    const text = lines.join("\n");
    assert.ok(lines.length > 10, `${loc} guide is too short`);
    assert.ok(!text.includes("⟨"), `${loc} guide has an unresolved key`);
    for (const cmd of ["/help", "/doctor", "/language", "/ram"]) {
      assert.ok(text.includes(cmd), `${loc} guide lost ${cmd}`);
    }
  }
});
