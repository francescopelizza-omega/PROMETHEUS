/**
 * model-actions-cmd.test.ts — the two commands that change the machine, and the gates on them.
 *
 * Everything else in `updates/` proposes; these act. So the assertions are mostly about ORDER
 * and REFUSAL: the authorisation gate fires before the user is asked anything, the removal needs
 * the tag typed out, and nothing irreversible happens on a surface that cannot ask a question.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ModelActionDeps,
  authRefusal,
  gb,
  parseSubcommand,
  runPull,
  runRemove,
} from "./model-actions-cmd.js";

/** A deps object that records every line and every question, with nothing real behind it. */
function harness(
  over: Partial<ModelActionDeps> & { answers?: string[]; confirms?: boolean[] } = {},
) {
  const lines: string[] = [];
  const asked: string[] = [];
  const answers = [...(over.answers ?? [])];
  const confirms = [...(over.confirms ?? [])];
  const deps: ModelActionDeps = {
    write: (l) => lines.push(l),
    confirm: async (p) => {
      asked.push(p);
      return confirms.shift() ?? false;
    },
    ask: async (p) => {
      asked.push(p);
      return answers.shift() ?? "";
    },
    getAuthLevel: () => 7,
    pull: (async () => ({ ok: true, error: "", aborted: false })) as never,
    remove: (async () => ({ ok: true, error: "" })) as never,
    loaded: (async () => []) as never,
    localManifest: (() => [{ digest: "sha256:a", size: 3e9 }]) as never,
    allManifests: (() => []) as never,
    now: () => 0,
    ...over,
  };
  // `plain` strips the ANSI the renderer adds, so assertions read as the user sees them.
  const plain = () => lines.join("\n").replace(/\u001B\[[0-9;]*m/g, "");
  return { deps, lines, asked, plain };
}

/* ─────────────────────────── dispatch ─────────────────────────── */

test("an empty rest is the report; flags belong to the report too", () => {
  assert.deepEqual(parseSubcommand(""), { kind: "report" });
  assert.deepEqual(parseSubcommand("   "), { kind: "report" });
  assert.deepEqual(parseSubcommand("--json"), { kind: "report" });
});

test("pull and rm parse, with rm aliased to remove", () => {
  assert.deepEqual(parseSubcommand("pull qwen3.6:latest"), { kind: "pull", tag: "qwen3.6:latest" });
  assert.deepEqual(parseSubcommand("rm old:tag"), { kind: "remove", tag: "old:tag" });
  assert.deepEqual(parseSubcommand("REMOVE old:tag"), { kind: "remove", tag: "old:tag" });
});

test("an unknown verb is a USAGE error, never a silent fall-through to the report", () => {
  /**
   * `/updates pul qwen` running a six-second sweep instead would look like it had worked, and
   * the user would be left believing they had pulled something.
   */
  const r = parseSubcommand("pul qwen");
  assert.equal(r.kind, "usage");
  assert.match((r as { message: string }).message, /unknown: \/updates pul/);
});

/* ─────────────────────────── the auth gate ─────────────────────────── */

test("the refusal names the rung AND how to raise it", () => {
  // "not permitted" with no next step is a dead end.
  const msg = authRefusal(3, 5, "Downloading a model");
  assert.match(msg, /needs authorisation A5/);
  assert.match(msg, /at A3/);
  assert.match(msg, /\/authorisation 5/);
  assert.equal(authRefusal(5, 5, "x"), "");
  assert.equal(authRefusal(7, 5, "x"), "");
});

test("REFUSED BEFORE ASKING: a low level never reaches the confirmation", async () => {
  /**
   * Order matters. Asking first and refusing after teaches the user that the confirmation is
   * theatre — and it puts a "are you sure?" in front of something that was never going to run.
   */
  const h = harness({ getAuthLevel: () => 4, confirms: [true] });
  assert.equal(await runPull("qwen3.6:latest", h.deps), false);
  assert.deepEqual(h.asked, [], "nothing was asked");
  assert.match(h.plain(), /needs authorisation A5/);
});

test("a removal needs a HIGHER rung than a pull", async () => {
  // A5 may install; only A6 may destroy.
  const h = harness({ getAuthLevel: () => 5, answers: ["old:tag"] });
  assert.equal(await runRemove("old:tag", h.deps), false);
  assert.match(h.plain(), /needs authorisation A6/);
  assert.deepEqual(h.asked, []);
});

/* ─────────────────────────── pull ─────────────────────────── */

test("a declined confirmation does not pull", async () => {
  let called = false;
  const h = harness({
    confirms: [false],
    pull: (async () => {
      called = true;
      return { ok: true, error: "", aborted: false };
    }) as never,
  });
  assert.equal(await runPull("x:1", h.deps), false);
  assert.equal(called, false);
  assert.match(h.plain(), /cancelled/);
});

test("the prompt WARNS that pulling an installed tag is not a no-op", async () => {
  /**
   * Measured: `/api/pull` re-resolves the remote manifest and, if the tag has moved, downloads
   * the new layers. "I already have this one" can still spend 22 GB.
   */
  const h = harness({ confirms: [false] });
  await runPull("qwen3.6:latest", h.deps);
  assert.match(h.plain(), /re-resolves the tag/);
  assert.match(h.plain(), /already installed/);
});

test("progress is throttled and deduplicated, not one line per tick", async () => {
  /**
   * ollama emits a progress line per layer per tick. Forwarding every one floods a readline host
   * with thousands of lines and repaints the TUI continuously for the length of the download.
   */
  let t = 0;
  const h = harness({
    confirms: [true],
    now: () => t,
    pull: (async (_tag: string, o: { onEvent?: (e: unknown) => void }) => {
      for (let i = 0; i < 40; i++) {
        t += 50; // 50 ms apart — well under the 250 ms floor
        o.onEvent?.({
          kind: "progress",
          status: "pulling a",
          digest: "sha256:a",
          completed: i * 10,
          total: 1000,
        });
      }
      return { ok: true, error: "", aborted: false };
    }) as never,
  });
  assert.equal(await runPull("x:1", h.deps), true);
  const progressLines = h.lines.filter((l) => l.includes("pulling a"));
  assert.ok(progressLines.length > 0, "some progress is shown");
  assert.ok(progressLines.length <= 10, `throttled to ~4 Hz, got ${progressLines.length} of 40`);
});

test("a failed pull reports the daemon's message and does not claim success", async () => {
  const h = harness({
    confirms: [true],
    pull: (async () => ({
      ok: false,
      error: "pull model manifest: file does not exist",
      aborted: false,
    })) as never,
  });
  assert.equal(await runPull("nope:1", h.deps), false);
  assert.match(h.plain(), /pull failed: pull model manifest/);
  assert.doesNotMatch(h.plain(), /✓/);
});

test("a cancelled pull says it will RESUME, rather than reporting a failure", async () => {
  // ollama keeps a partial file and resumes from it; calling that a failure would be wrong.
  const h = harness({
    confirms: [true],
    pull: (async () => ({ ok: false, error: "cancelled", aborted: true })) as never,
  });
  assert.equal(await runPull("x:1", h.deps), false);
  assert.match(h.plain(), /resumes where this one stopped/);
  assert.doesNotMatch(h.plain(), /failed/);
});

test("an empty tag is a usage error, not a pull of everything", async () => {
  const h = harness({ confirms: [true] });
  assert.equal(await runPull("  ", h.deps), false);
  assert.match(h.plain(), /usage: \/updates pull/);
  assert.deepEqual(h.asked, []);
});

/* ─────────────────────────── remove ─────────────────────────── */

test("removal needs the TAG TYPED, not a y/N", async () => {
  /**
   * `y` is muscle memory and this is the one irreversible thing in the feature. The same typed
   * pattern guards branch removal elsewhere in the registry.
   */
  let removed = false;
  const h = harness({
    answers: ["y"],
    remove: (async () => {
      removed = true;
      return { ok: true, error: "" };
    }) as never,
  });
  assert.equal(await runRemove("old:tag", h.deps), false);
  assert.equal(removed, false, '"y" must not be enough');
  assert.match(h.asked.join(""), /type "old:tag" to confirm/);
});

test("the exact tag typed back DOES remove, and the freed bytes are reported", async () => {
  const h = harness({ answers: ["old:tag"] });
  assert.equal(await runRemove("old:tag", h.deps), true);
  assert.match(h.plain(), /frees 3\.0 GB/);
  assert.match(h.plain(), /✓ old:tag removed — 3\.0 GB freed/);
  assert.match(h.plain(), /cannot be undone/);
});

test("REFUSED: a LOADED model is not removed", async () => {
  /**
   * `GET /api/ps` is the only thing that knows, and it is re-read at the moment of acting —
   * the report may be six hours old and the model may have been loaded a minute ago.
   */
  const h = harness({ answers: ["old:tag"], loaded: (async () => ["old:tag"]) as never });
  assert.equal(await runRemove("old:tag", h.deps), false);
  assert.match(h.plain(), /is loaded right now/);
  assert.deepEqual(h.asked, [], "it never even asks");
});

test("REFUSED: every layer shared with a survivor means the removal frees nothing", async () => {
  const h = harness({
    answers: ["old:tag"],
    localManifest: (() => [{ digest: "sha256:shared", size: 5e9 }]) as never,
    allManifests: (() => [
      { tag: "keep:1", layers: [{ digest: "sha256:shared", size: 5e9 }] },
    ]) as never,
  });
  assert.equal(await runRemove("old:tag", h.deps), false);
  assert.match(h.plain(), /frees nothing/);
});

test("REFUSED: a model whose manifest cannot be read yields no claim at all", async () => {
  // Local layer digests exist in no HTTP endpoint, so an unreadable manifest means the saving
  // is unknowable — and an unknowable saving must not be advertised as zero.
  const h = harness({ answers: ["x:1"], localManifest: (() => null) as never });
  assert.equal(await runRemove("x:1", h.deps), false);
  assert.match(h.plain(), /not installed, or its manifest could not be read/);
});

test("only OTHER manifests count as survivors — the victim never protects itself", async () => {
  /**
   * If the victim's own manifest were left in the survivor set, every one of its layers would
   * look shared and the removal would always report "frees nothing".
   */
  const h = harness({
    answers: ["old:tag"],
    localManifest: (() => [{ digest: "sha256:a", size: 4e9 }]) as never,
    allManifests: (() => [
      { tag: "old:tag", layers: [{ digest: "sha256:a", size: 4e9 }] },
    ]) as never,
  });
  assert.equal(await runRemove("old:tag", h.deps), true);
  assert.match(h.plain(), /frees 4\.0 GB/);
});

test("a failed remove does not claim the space was freed", async () => {
  const h = harness({
    answers: ["old:tag"],
    remove: (async () => ({ ok: false, error: "model 'old:tag' not found" })) as never,
  });
  assert.equal(await runRemove("old:tag", h.deps), false);
  assert.match(h.plain(), /remove failed: model 'old:tag' not found/);
  assert.doesNotMatch(h.plain(), /freed/);
});

/* ─────────────────────────── formatting ─────────────────────────── */

test("bytes render with one decimal, so 22.6 GB does not read as 23 GB", () => {
  assert.equal(gb(22_621_314_161), "22.6 GB");
  assert.equal(gb(3e9), "3.0 GB");
  assert.equal(gb(0), "0.0 GB");
});
