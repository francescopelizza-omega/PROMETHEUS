/**
 * conversion.test.ts — the escape hatch, and the refusals that keep it honest.
 *
 * Two facts were verified live on 2026-09-29 and drive most of these cases: ollama 0.34.1's
 * `--quantize` help says "Quantize **safetensors** model to this level (e.g. **nvfp4**)", and
 * Homebrew's llama.cpp formula has **no Python dependency**, so it cannot be shipping
 * `convert_hf_to_gguf.py`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ConversionEnv,
  GGUF_IS_ONE_WAY,
  MLX_QUANT_TYPES,
  OLLAMA_GGUF_CONVERSION_REMOVED_IN,
  missingPrerequisites,
  ollamaConvertsGguf,
  planConversion,
  planIsReady,
} from "./conversion.js";

const mac: ConversionEnv = { has: {}, platform: "darwin", arch: "arm64" };
const linux: ConversionEnv = { has: {}, platform: "linux", arch: "x64" };
const equipped: ConversionEnv = {
  has: { "convert_hf_to_gguf.py": true, "llama-quantize": true, lms: true },
  platform: "linux",
  arch: "x64",
};

/* ─────────────────────── the version boundary ─────────────────────── */

test("ollama lost GGUF conversion at 0.34.1 — the boundary is exact", () => {
  /**
   * Commit 98acec40ae2b, "create: add server-side MLX imports and drop GGUF conversion".
   * v0.34.0 is the old world; v0.34.1 is the first new one. Verified against the installed
   * 0.34.1, whose help reads "Quantize safetensors model to this level (e.g. nvfp4)".
   */
  assert.equal(ollamaConvertsGguf("0.34.0"), true);
  assert.equal(ollamaConvertsGguf("0.33.9"), true);
  assert.equal(ollamaConvertsGguf(OLLAMA_GGUF_CONVERSION_REMOVED_IN), false);
  assert.equal(ollamaConvertsGguf("0.34.4"), false);
  assert.equal(ollamaConvertsGguf("1.0.0"), false);
});

test("an UNREADABLE ollama version is treated as `cannot`, deliberately", () => {
  /**
   * The asymmetry is the point. A needless `brew install llama.cpp` costs a few minutes; an
   * `ollama create -q q4_K_M` on a current daemon quietly does something else entirely.
   */
  assert.equal(ollamaConvertsGguf(undefined), false);
  assert.equal(ollamaConvertsGguf("not a version"), false);
});

/* ─────────────────────── the case that needs no conversion ─────────────────────── */

test("a repo that already publishes a GGUF needs NO conversion, and says so", () => {
  /**
   * The most important branch in the module. A conversion tool that does not first check
   * whether conversion is needed is how someone spends an hour reproducing a file that was
   * already there.
   */
  const plan = planConversion(
    {
      from: "safetensors",
      to: "ollama",
      repo: "bartowski/X-GGUF",
      ggufPublished: true,
      quant: "Q4_K_M",
    },
    linux,
  );
  assert.equal(plan.kind, "direct");
  assert.match(plan.kind === "direct" ? plan.why : "", /already publishes a GGUF/);
  assert.equal(
    plan.kind === "direct" ? plan.steps[0]?.command : "",
    "ollama pull hf.co/bartowski/X-GGUF:Q4_K_M",
  );
  assert.equal(planIsReady(plan), true, "nothing to install");
});

/* ─────────────────────── safetensors → GGUF ─────────────────────── */

test("REGRESSION: `brew install llama.cpp` does NOT provide the converter", () => {
  /**
   * The obvious advice, and wrong. Measured: the formula's build dependency is cmake alone and
   * its runtime dependencies are ggml and openssl@3 — no Python anywhere, so it cannot ship a
   * Python script. Someone following that advice gets `llama-quantize` and a missing converter.
   */
  const plan = planConversion({ from: "safetensors", to: "ollama", path: "/m" }, linux);
  assert.equal(plan.kind, "convert");
  const conv =
    plan.kind === "convert"
      ? plan.prerequisites.find((p) => p.id === "convert_hf_to_gguf.py")
      : undefined;
  assert.ok(conv);
  assert.match(conv?.install ?? "", /git clone/);
  assert.match(conv?.install ?? "", /requirements\.txt/);
  assert.match(conv?.note ?? "", /NOT included in `brew install llama\.cpp`/);
});

test("the converter step is offered, and a quantised target adds llama-quantize", () => {
  const plain = planConversion({ from: "safetensors", to: "llamacpp", path: "/m" }, linux);
  assert.equal(
    plain.kind === "convert" ? plain.prerequisites.length : 0,
    1,
    "f16 needs only the converter",
  );

  const quantised = planConversion(
    { from: "safetensors", to: "llamacpp", path: "/m", quant: "Q4_K_M" },
    linux,
  );
  assert.deepEqual(quantised.kind === "convert" ? quantised.prerequisites.map((p) => p.id) : [], [
    "convert_hf_to_gguf.py",
    "llama-quantize",
  ]);
  const cmds = quantised.kind === "convert" ? quantised.steps.map((s) => s.command) : [];
  assert.match(cmds[0] ?? "", /convert_hf_to_gguf\.py/);
  assert.match(cmds[1] ?? "", /llama-quantize .* Q4_K_M/);
});

test("the cost is stated up front, not discovered an hour in", () => {
  const plan = planConversion({ from: "safetensors", to: "ollama", path: "/m" }, linux);
  assert.match(plan.kind === "convert" ? (plan.warning ?? "") : "", /several GB/);
  assert.match(plan.kind === "convert" ? (plan.warning ?? "") : "", /already has a GGUF/);
});

test("prerequisites already present are not listed as missing", () => {
  const plan = planConversion(
    { from: "safetensors", to: "llamacpp", path: "/m", quant: "Q4_K_M" },
    equipped,
  );
  assert.deepEqual(missingPrerequisites(plan), []);
  assert.equal(planIsReady(plan), true);

  const bare = planConversion(
    { from: "safetensors", to: "llamacpp", path: "/m", quant: "Q4_K_M" },
    linux,
  );
  assert.equal(missingPrerequisites(bare).length, 2);
  assert.equal(planIsReady(bare), false);
});

test("REGRESSION: a repo source gets a DOWNLOAD step — a repo id is not a path", () => {
  /**
   * `FROM <dir>` in a Modelfile and `convert_hf_to_gguf.py <dir>` both take a LOCAL directory;
   * neither resolves a HuggingFace repo id. The first version emitted
   * `FROM Qwen/Qwen2.5-Coder-7B-Instruct`, which looks plausible and fails — and would have
   * failed AFTER the user installed several GB of Python for it.
   */
  const plan = planConversion(
    { from: "safetensors", to: "llamacpp", repo: "Qwen/Qwen2.5-Coder-7B-Instruct" },
    linux,
  );
  assert.equal(plan.kind, "convert");
  const steps = plan.kind === "convert" ? plan.steps : [];
  assert.match(
    steps[0]?.command ?? "",
    /^hf download Qwen\/Qwen2\.5-Coder-7B-Instruct --local-dir/,
  );
  assert.match(steps[0]?.what ?? "", /INPUT, not the result/);
  // …the converter then runs against the LOCAL directory, not the repo id.
  assert.match(steps[1]?.command ?? "", /convert_hf_to_gguf\.py \.\/Qwen2\.5-Coder-7B-Instruct/);
  assert.doesNotMatch(steps[1]?.command ?? "", /Qwen\/Qwen/);
  // …and `hf` joins the prerequisites, since nothing else in the plan can fetch the weights.
  assert.ok(plan.kind === "convert" && plan.prerequisites.some((p) => p.id === "hf"));
});

test("a LOCAL path needs no download step", () => {
  const plan = planConversion({ from: "safetensors", to: "llamacpp", path: "/models/x" }, linux);
  const steps = plan.kind === "convert" ? plan.steps : [];
  assert.doesNotMatch(steps[0]?.command ?? "", /hf download/);
  assert.match(steps[0]?.command ?? "", /convert_hf_to_gguf\.py \/models\/x/);
  assert.ok(plan.kind === "convert" && !plan.prerequisites.some((p) => p.id === "hf"));
});

test("the MLX route from a repo ALSO downloads first", () => {
  const plan = planConversion(
    { from: "safetensors", to: "ollama", repo: "Qwen/Qwen2.5-Coder-7B-Instruct" },
    mac,
  );
  const steps = plan.kind === "convert" ? plan.steps : [];
  assert.match(steps[0]?.command ?? "", /hf download/);
  assert.match(steps[1]?.command ?? "", /FROM/);
  assert.match(steps[1]?.what ?? "", /a repo id will not resolve/);
});

/* ─────────────────────── the Apple Silicon MLX route ─────────────────────── */

test("Apple Silicon gets the MLX route, and is TOLD it is not a GGUF", () => {
  /**
   * 0.34.1+ imports safetensors server-side through MLX. It needs no Python environment, which
   * is why it is preferred where it applies — but it produces an MLX model, and `--quantize`
   * there takes MLX levels. A user expecting a portable GGUF would be surprised later.
   */
  const plan = planConversion({ from: "safetensors", to: "ollama", path: "/m" }, mac);
  assert.equal(plan.kind, "convert");
  assert.equal(plan.kind === "convert" ? plan.prerequisites.length : -1, 0, "no Python needed");
  assert.match(plan.kind === "convert" ? (plan.warning ?? "") : "", /Apple Silicon only/);
  assert.match(plan.kind === "convert" ? (plan.warning ?? "") : "", /rather than a GGUF/);
  assert.match(plan.kind === "convert" ? (plan.steps[1]?.command ?? "") : "", /--quantize int4/);
});

test("a GGUF quantisation level is NOT passed to the MLX path", () => {
  // `q4_K_M` is not one of MLX's accepted values; silently forwarding it produces a command
  // that fails, and the default is used instead.
  const plan = planConversion(
    { from: "safetensors", to: "ollama", path: "/m", quant: "Q4_K_M" },
    mac,
  );
  const cmd = plan.kind === "convert" ? (plan.steps[1]?.command ?? "") : "";
  assert.doesNotMatch(cmd, /Q4_K_M/);
  assert.match(cmd, /--quantize int4/);
  // …and a real MLX level IS honoured.
  const nv = planConversion({ from: "safetensors", to: "ollama", path: "/m", quant: "nvfp4" }, mac);
  assert.match(nv.kind === "convert" ? (nv.steps[1]?.command ?? "") : "", /--quantize nvfp4/);
  assert.ok(MLX_QUANT_TYPES.includes("nvfp4"));
});

test("an Intel Mac does NOT get the MLX route", () => {
  // MLX is Apple Silicon only; offering it on x64 produces a failure at validation time.
  const plan = planConversion(
    { from: "safetensors", to: "ollama", path: "/m" },
    { has: {}, platform: "darwin", arch: "x64" },
  );
  assert.equal(
    plan.kind === "convert" ? plan.prerequisites.length : -1,
    1,
    "falls back to the converter",
  );
});

/* ─────────────────────── a GGUF already on disk ─────────────────────── */

test("importing a local GGUF into ollama is an IMPORT, and says so", () => {
  const plan = planConversion({ from: "gguf", to: "ollama", path: "/models/x.gguf" }, linux);
  assert.equal(plan.kind, "convert");
  assert.equal(plan.kind === "convert" ? plan.prerequisites.length : -1, 0);
  const steps = plan.kind === "convert" ? plan.steps : [];
  assert.match(steps[0]?.command ?? "", /FROM/);
  assert.match(steps[1]?.what ?? "", /nothing is converted/);
});

test("llama.cpp runs a GGUF as-is — no plan at all", () => {
  const plan = planConversion({ from: "gguf", to: "llamacpp", path: "/models/x.gguf" }, linux);
  assert.equal(plan.kind, "direct");
});

test("LM Studio takes a local GGUF through `lms import`", () => {
  const plan = planConversion({ from: "gguf", to: "lmstudio", path: "/models/x.gguf" }, linux);
  assert.equal(plan.kind === "convert" ? plan.steps[0]?.command : "", "lms import /models/x.gguf");
  assert.equal(plan.kind === "convert" ? plan.prerequisites[0]?.id : "", "lms");
});

test("a path with a space is quoted, so pasting it does not split", () => {
  const plan = planConversion({ from: "gguf", to: "lmstudio", path: "/My Models/x.gguf" }, linux);
  assert.equal(
    plan.kind === "convert" ? plan.steps[0]?.command : "",
    "lms import '/My Models/x.gguf'",
  );
});

/* ─────────────────────── the refusals ─────────────────────── */

test("MLX → GGUF is REFUSED, with the reason and an alternative", () => {
  const plan = planConversion({ from: "mlx", to: "ollama", path: "/m" }, mac);
  assert.equal(plan.kind, "refused");
  assert.match(plan.kind === "refused" ? plan.why : "", /no practical MLX → GGUF converter/);
  assert.match(plan.kind === "refused" ? (plan.alternative ?? "") : "", /HuggingFace/);
  assert.equal(planIsReady(plan), false);
});

test("an UNKNOWN format is refused rather than guessed", () => {
  /**
   * Guessing here produces a command that fails halfway through a multi-gigabyte download,
   * which is the most expensive possible moment to discover the format was wrong.
   */
  const plan = planConversion({ from: "unknown", to: "ollama", repo: "a/b" }, linux);
  assert.equal(plan.kind, "refused");
  assert.match(plan.kind === "refused" ? plan.why : "", /could not be determined/);
});

test("GGUF → safetensors has a real answer, not a silence", () => {
  // Asked often enough to deserve one: quantisation is lossy and there is no reverse converter.
  assert.match(GGUF_IS_ONE_WAY, /cannot be converted back/);
  assert.match(GGUF_IS_ONE_WAY, /no reverse converter/);
});
