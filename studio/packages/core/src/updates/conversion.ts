/**
 * updates/conversion.ts — getting a model into an engine that can run it, or saying why not.
 *
 * The escape hatch behind the catalogue. Almost every model a user wants already has a GGUF
 * someone else published, and `ollama pull hf.co/<repo>` fetches it with no conversion at all —
 * so this path is the exception, not the happy path, and it is built to say "you do not need
 * me" whenever that is true.
 *
 * ── OLLAMA 0.34.1 REMOVED GGUF CONVERSION, AND THIS MACHINE IS ON IT ────────────────────────
 *
 * Verified live against the installed 0.34.1:
 *
 *     -q, --quantize string   Quantize safetensors model to this level (e.g. nvfp4)
 *         --draft-quantize    Quantize safetensors draft model to this level
 *         --force             Continue local creation when MLX validation fails
 *
 * The word is **safetensors**, and the example is **nvfp4**. Before 0.34.1 the same flag read
 * "Quantize model to this level (e.g. q4_K_M)" and `ollama create` would convert and quantise
 * GGUF. Commit 98acec40ae2b — "create: add server-side MLX imports and drop GGUF conversion" —
 * is the boundary: v0.34.0 is the old world, v0.34.1 the new one.
 *
 * So on a current ollama, `ollama create -q q4_K_M` is NOT a GGUF quantiser. Anything written
 * against the old behaviour — including ollama.readthedocs.io, a stale third-party mirror that
 * still documents ADAPTER and q4_0 — produces a command that fails or does something else.
 *
 * ── AND `brew install llama.cpp` DOES NOT SHIP THE CONVERTER ────────────────────────────────
 *
 * The obvious advice for "convert safetensors to GGUF" is `brew install llama.cpp`. Measured:
 * the formula's build dependency is cmake alone and its runtime dependencies are ggml and
 * openssl@3 — **no Python at all**. It builds the C++ binaries, so you get `llama-quantize`; you
 * do not get `convert_hf_to_gguf.py`, which is a Python script needing torch and transformers.
 *
 * Those are two different jobs with two very different costs, and this module keeps them apart:
 * quantising an existing GGUF is one brew formula, while converting safetensors is a repo clone
 * and a multi-gigabyte Python environment.
 *
 * PURE: what you have and what you want, in; a plan or a refusal, out.
 */

import { compareVersions } from "./semver.js";

/** The shape a model is in. */
export type ModelFormat =
  /** the format ollama, llama.cpp and LM Studio all run. */
  | "gguf"
  /** HuggingFace's native weights. Needs conversion for a GGUF engine. */
  | "safetensors"
  /** Apple's MLX format. A one-way destination on this path. */
  | "mlx"
  | "unknown";

/** Where the user wants it to end up. */
export type TargetEngine = "ollama" | "lmstudio" | "llamacpp";

/** The ollama release that dropped GGUF conversion from `ollama create`. */
export const OLLAMA_GGUF_CONVERSION_REMOVED_IN = "0.34.1";

/**
 * Can this ollama still convert and quantise GGUF itself?
 *
 * `undefined` when the version could not be read — and that is treated as CANNOT, because
 * proposing a command that was removed is worse than proposing one extra prerequisite. The
 * asymmetry is deliberate: a needless `brew install llama.cpp` costs a few minutes, while
 * `ollama create -q q4_K_M` on a current daemon quietly means something else.
 */
export function ollamaConvertsGguf(ollamaVersion: string | undefined): boolean {
  if (!ollamaVersion) return false;
  const cmp = compareVersions(ollamaVersion, OLLAMA_GGUF_CONVERSION_REMOVED_IN);
  return cmp !== null && cmp < 0;
}

/** A tool the plan needs, and how to get it. */
export interface Prerequisite {
  /** the binary or file that must exist. */
  id: string;
  /** what it is for, in one line. */
  why: string;
  /** the exact command that installs it, when one exists. */
  install: string;
  /** true when it is already present on this machine. */
  present: boolean;
  /** an honest warning about the cost of getting it. */
  note?: string;
}

export interface ConversionStep {
  /** the exact command, copyable. */
  command: string;
  /** what it does, in one line. */
  what: string;
}

export type ConversionPlan =
  /** nothing to do: the model can be installed directly. */
  | { kind: "direct"; steps: ConversionStep[]; why: string }
  /** a real conversion, with everything it needs. */
  | { kind: "convert"; steps: ConversionStep[]; prerequisites: Prerequisite[]; warning?: string }
  /** it cannot be done, and this says why rather than offering something that will fail. */
  | { kind: "refused"; why: string; alternative?: string };

/** What the caller knows about this machine. */
export interface ConversionEnv {
  /** the ollama daemon's version, when it could be read. */
  ollamaVersion?: string;
  /** binaries found on PATH. */
  has: Readonly<Record<string, boolean>>;
  platform: NodeJS.Platform;
  arch: string;
}

export interface ConversionRequest {
  from: ModelFormat;
  to: TargetEngine;
  /** a HuggingFace repo id, when the source is a repo. */
  repo?: string;
  /** a local path, when the source is a file or directory already on disk. */
  path?: string;
  /** the quantisation to produce, e.g. "Q4_K_M". */
  quant?: string;
  /** true when the source repo is known to publish a GGUF already. */
  ggufPublished?: boolean;
}

/**
 * GGUF quantisation types `llama-quantize` accepts, most useful first.
 *
 * Not the full 38 — the tail is legacy and experimental formats nobody should be steered toward
 * from a menu. Q4_K_M leads because it is what ollama resolves `hf.co/<repo>` to by default, so
 * choosing it keeps a converted model comparable with a pulled one.
 */
export const GGUF_QUANT_TYPES: readonly string[] = Object.freeze([
  "Q4_K_M",
  "Q4_K_S",
  "Q5_K_M",
  "Q5_K_S",
  "Q6_K",
  "Q8_0",
  "Q3_K_M",
  "Q2_K",
  "IQ4_XS",
  "F16",
]);

/**
 * Quantisation levels `ollama create --quantize` accepts on 0.34.1+.
 *
 * MLX types, not GGUF ones — which is the whole point of the version boundary. Passing `q4_K_M`
 * here does not produce a smaller GGUF; it is simply not one of the accepted values.
 */
export const MLX_QUANT_TYPES: readonly string[] = Object.freeze([
  "int4",
  "int8",
  "nvfp4",
  "mxfp4",
  "mxfp8",
]);

function prereq(
  id: string,
  why: string,
  install: string,
  env: ConversionEnv,
  note?: string,
): Prerequisite {
  return { id, why, install, present: env.has[id] === true, ...(note ? { note } : {}) };
}

/**
 * The llama.cpp SOURCE checkout, which is a different thing from the brew formula.
 *
 * Measured: the formula's only build dependency is cmake and its runtime dependencies are ggml
 * and openssl@3. No Python, so no `convert_hf_to_gguf.py`. Saying "brew install llama.cpp" for a
 * safetensors conversion sends someone to a tool that does not include the converter — they get
 * `llama-quantize` and a missing script.
 */
function converterPrereq(env: ConversionEnv): Prerequisite {
  return prereq(
    "convert_hf_to_gguf.py",
    "converts HuggingFace safetensors into GGUF (268 architectures)",
    "git clone https://github.com/ggml-org/llama.cpp && pip install -r llama.cpp/requirements.txt",
    env,
    "NOT included in `brew install llama.cpp` — that formula has no Python dependency at all. This is a repo clone plus torch and transformers, several GB.",
  );
}

function quantizePrereq(env: ConversionEnv): Prerequisite {
  return prereq(
    "llama-quantize",
    "re-quantises an existing GGUF to a smaller one",
    "brew install llama.cpp",
    env,
  );
}

/**
 * Work out how to get `from` into `to`, or why it cannot be done.
 *
 * The first branch is the one that matters most: if the repo already publishes a GGUF, there is
 * nothing to convert and the plan says so. A conversion tool that does not first check whether
 * conversion is needed is how people spend an hour on a download someone already did for them.
 */
export function planConversion(req: ConversionRequest, env: ConversionEnv): ConversionPlan {
  /* ── the case that makes this module unnecessary ── */
  if (req.ggufPublished && req.repo && req.to === "ollama") {
    return {
      kind: "direct",
      why: "this repo already publishes a GGUF, so nothing needs converting",
      steps: [
        {
          command: `ollama pull hf.co/${req.repo}${req.quant ? `:${req.quant}` : ""}`,
          what: "ollama fetches the published GGUF directly — officially supported",
        },
      ],
    };
  }

  /* ── a GGUF already on disk ── */
  if (req.from === "gguf" && req.path) {
    if (req.to === "lmstudio") {
      return {
        kind: "convert",
        prerequisites: [prereq("lms", "LM Studio's CLI", "install LM Studio, then `lms`", env)],
        steps: [
          { command: `lms import ${quote(req.path)}`, what: "registers the file with LM Studio" },
        ],
      };
    }
    if (req.to === "llamacpp") {
      return {
        kind: "direct",
        why: "llama.cpp runs GGUF as-is",
        steps: [{ command: `llama-cli -m ${quote(req.path)}`, what: "runs it directly" }],
      };
    }
    // ollama: an IMPORT, not a conversion — the file is already in the right format.
    return {
      kind: "convert",
      prerequisites: [],
      steps: [
        {
          command: `printf 'FROM %s\\n' ${quote(req.path)} > Modelfile`,
          what: "a one-line Modelfile pointing at the file",
        },
        {
          command: "ollama create my-model -f Modelfile",
          what: "registers it with ollama (an import — nothing is converted)",
        },
      ],
    };
  }

  /* ── safetensors, the real conversion ── */
  if (req.from === "safetensors") {
    /**
     * A REPO ID IS NOT A PATH, and both routes below need the weights on disk.
     *
     * `FROM <dir>` in a Modelfile and `convert_hf_to_gguf.py <dir>` both take a local
     * directory — neither resolves a HuggingFace repo id. The first version of this emitted
     * `FROM Qwen/Qwen2.5-Coder-7B-Instruct`, which looks plausible and fails, and would have
     * failed AFTER the user installed a multi-gigabyte Python environment for it.
     *
     * So a repo source gets an explicit download step first, and `hf` joins the prerequisites.
     */
    const fromRepo = req.path === undefined && req.repo !== undefined;
    const localDir = fromRepo
      ? `./${(req.repo as string).split("/").pop()}`
      : (req.path ?? "<model-dir>");
    const download: ConversionStep[] = fromRepo
      ? [
          {
            command: `hf download ${req.repo} --local-dir ${quote(localDir)}`,
            what: "downloads the safetensors weights — tens of GB, and they are the INPUT, not the result",
          },
        ]
      : [];
    const downloadPrereq: Prerequisite[] = fromRepo
      ? [
          prereq(
            "hf",
            "downloads the repo's weights before anything can convert them",
            "pipx install huggingface-hub   # or: pip install huggingface-hub",
            env,
          ),
        ]
      : [];
    const source = localDir;
    /**
     * Apple Silicon has a second route: 0.34.1+ imports safetensors server-side through MLX.
     * Offered FIRST where it applies because it needs no Python environment at all — but only
     * there, since MLX is Apple-only and `--force` exists precisely because its validation can
     * fail.
     */
    if (req.to === "ollama" && env.platform === "darwin" && env.arch === "arm64") {
      const q = req.quant && MLX_QUANT_TYPES.includes(req.quant) ? req.quant : "int4";
      return {
        kind: "convert",
        prerequisites: downloadPrereq,
        warning:
          "This is the MLX path: Apple Silicon only, and it produces an MLX model rather than a GGUF. `--quantize` here takes MLX levels (int4, int8, nvfp4, mxfp4, mxfp8) — a GGUF level like q4_K_M is not accepted.",
        steps: [
          ...download,
          {
            command: `printf 'FROM %s\\n' ${quote(source)} > Modelfile`,
            what: "point a Modelfile at the LOCAL safetensors directory (a repo id will not resolve)",
          },
          {
            command: `ollama create my-model -f Modelfile --quantize ${q}`,
            what: "ollama imports and quantises it through MLX",
          },
        ],
      };
    }
    // Everyone else: the llama.cpp converter.
    const prereqs = [...downloadPrereq, converterPrereq(env)];
    if (req.quant && req.quant.toUpperCase() !== "F16") prereqs.push(quantizePrereq(env));
    const steps: ConversionStep[] = [
      ...download,
      {
        command: `python3 convert_hf_to_gguf.py ${quote(source)} --outfile model-f16.gguf --outtype f16`,
        what: "converts the safetensors weights to an unquantised GGUF",
      },
    ];
    if (req.quant && req.quant.toUpperCase() !== "F16") {
      steps.push({
        command: `llama-quantize model-f16.gguf model-${req.quant.toLowerCase()}.gguf ${req.quant}`,
        what: `shrinks it to ${req.quant}`,
      });
    }
    if (req.to === "ollama") {
      steps.push({
        command:
          "printf 'FROM ./model-%s.gguf\\n' <quant> > Modelfile && ollama create my-model -f Modelfile",
        what: "imports the result into ollama",
      });
    }
    return {
      kind: "convert",
      prerequisites: prereqs,
      warning:
        "Expect an hour and several GB of Python dependencies. Almost every popular model already has a GGUF published by someone else — check the catalogue before starting this.",
      steps,
    };
  }

  /* ── quantising a GGUF you already have ── */
  if (req.from === "gguf" && req.quant) {
    return {
      kind: "convert",
      prerequisites: [quantizePrereq(env)],
      steps: [
        {
          command: `llama-quantize in.gguf out-${req.quant.toLowerCase()}.gguf ${req.quant}`,
          what: `re-quantises to ${req.quant}`,
        },
      ],
    };
  }

  /* ── the refusals ── */
  if (req.from === "mlx") {
    return {
      kind: "refused",
      why: "there is no practical MLX → GGUF converter. MLX is a destination on this path, not a source.",
      alternative:
        "Find a GGUF of the same model on HuggingFace, or convert from the original safetensors.",
    };
  }
  if (req.from === "unknown") {
    return {
      kind: "refused",
      why: "the model's format could not be determined, and guessing would produce a command that fails halfway through a large download.",
      alternative: "Check whether the repo contains .gguf or .safetensors files and say which.",
    };
  }
  return {
    kind: "refused",
    why: `no route from ${req.from} to ${req.to} is known to work.`,
  };
}

/**
 * Why converting GGUF back to safetensors is not offered.
 *
 * Asked often enough to deserve a real answer rather than silence. Quantisation is lossy and
 * the conversion scripts only run one way — the "convert back" scripts people link to are 404s.
 */
export const GGUF_IS_ONE_WAY =
  "GGUF cannot be converted back to safetensors: quantisation discards information, and llama.cpp ships no reverse converter. Download the original weights from HuggingFace instead.";

/** Shell-quote a path, because a model directory routinely has a space in it. */
function quote(p: string): string {
  return /^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

/** Everything still missing for a plan, so a caller can show one blocked list rather than N. */
export function missingPrerequisites(plan: ConversionPlan): Prerequisite[] {
  return plan.kind === "convert" ? plan.prerequisites.filter((p) => !p.present) : [];
}

/** Is the plan runnable right now? */
export function planIsReady(plan: ConversionPlan): boolean {
  if (plan.kind === "refused") return false;
  return missingPrerequisites(plan).length === 0;
}
