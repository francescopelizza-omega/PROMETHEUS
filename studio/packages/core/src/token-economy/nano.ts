/**
 * token-economy/nano.ts — the HONEST Gemini Nano local-feasibility assessment (from a
 * dedicated research agent), as pure data so the CLI/GUI can surface it truthfully.
 *
 * Bottom line: running the ACTUAL Gemini Nano locally without a Google account is
 * PARTIAL — possible only via Chrome's own Built-in AI (a managed component, fragile),
 * never as portable open weights (Nano is proprietary; leaked dumps are ToS-unsafe).
 * For the user's real goal — an account-free, fully-local, legal ~4GB on-device LLM —
 * the answer is YES via an open model (Qwen3-4B / Gemma-3-4B / Phi-4-mini), which
 * Prometheus ships as the default.
 */

export type NanoFeasibility = "yes" | "partial" | "no";
export type NanoReliability = "robust" | "fragile" | "unsupported";

export interface NanoMethod {
  method: string;
  accountRequired: boolean;
  localOnly: boolean;
  reliability: NanoReliability;
  how: string;
  tosLegal: string;
  /** true = Prometheus may surface/use it; false = ToS-unsafe, never. */
  endorsed: boolean;
}

export interface NanoAssessment {
  feasible: NanoFeasibility;
  /** does ANY feasible local path require a Google account? */
  accountRequired: boolean;
  localOnly: boolean;
  /** are Nano weights legally redistributable? (No.) */
  weightsRedistributable: boolean;
  methods: readonly NanoMethod[];
  /** truly-open, account-free ~4GB on-device alternatives (catalog ids). */
  alternatives: readonly { id: string; label: string }[];
  recommendation: string;
}

export const GEMINI_NANO: NanoAssessment = Object.freeze<NanoAssessment>({
  feasible: "partial",
  accountRequired: false,
  localOnly: true,
  weightsRedistributable: false,
  methods: [
    {
      method: "Chrome Built-in AI / Prompt API (LanguageModel)",
      accountRequired: false,
      localOnly: true,
      reliability: "fragile",
      how: "Chrome 138+ auto-downloads Nano as a managed component; call LanguageModel.create()/prompt() in a local page, or drive it headlessly via CDP behind a localhost OpenAI-compatible shim. No account, no external calls after the one-time component fetch.",
      tosLegal:
        "Legitimate: a public, documented web-platform API on the user's own machine. Output is bound by Google's Generative AI Prohibited Use Policy. No weight extraction.",
      endorsed: true,
    },
    {
      method: "Android AICore (ML Kit GenAI)",
      accountRequired: false,
      localOnly: true,
      reliability: "robust",
      how: "First-party on-device Gemini Nano on Pixel/Android via the AICore system service. Mobile only — not a desktop path.",
      tosLegal: "Legitimate first-party API. You may NOT extract AICore weights for other use.",
      endorsed: true,
    },
    {
      method: "MediaPipe LLM Inference / LiteRT-LM",
      accountRequired: false,
      localOnly: true,
      reliability: "robust",
      how: "Apache-2.0 runtime that runs OPEN models (Gemma, etc.) on-device (WebGPU/Android/iOS) — NOT the Gemini Nano weights.",
      tosLegal:
        "Fully clean: runtime is Apache-2.0; the models carry their own permissive licenses. This is the open-alternative path.",
      endorsed: true,
    },
    {
      method: "Extracted/leaked Chrome Nano weights (.bin from the profile dir)",
      accountRequired: false,
      localOnly: true,
      reliability: "unsupported",
      how: "(documented for transparency only) Pulling the component weights out of Chrome's profile.",
      tosLegal:
        "NOT legitimate. Gemini Nano is NOT open-weight; Google publishes no Nano weights license or redistribution right. Leaked HF dumps are ToS-unsafe and takedown-prone. Prometheus will NOT do this.",
      endorsed: false,
    },
  ],
  alternatives: [
    { id: "qwen3-4b", label: "Qwen3 4B (Apache-2.0 — safest to redistribute)" },
    {
      id: "gemma3-4b",
      label: "Gemma 3 4B (Gemma license — closest to Nano's lineage, multimodal)",
    },
    { id: "phi4-mini", label: "Phi-4-mini 3.8B (MIT — strong small reasoner)" },
    { id: "gemma3-1b", label: "Gemma 3 1B (~1GB — very low-RAM, same LiteRT path)" },
  ],
  recommendation:
    "Prometheus's stance: use the truly-open default; treat actual-Nano as a documented (not-yet-wired) experimental path. (1) DOCUMENTED experimental path: a 'Gemini Nano via Chrome Built-in AI' connector WOULD detect a provisioned Chrome 138+ and drive it locally via CDP (no account, no external calls, no weight extraction) — Prometheus surfaces this ASSESSMENT + path here, but ships no Chrome connector yet (the flags churn + it needs a user gesture). (2) RECOMMENDED DEFAULT (selectable today): a truly-open ~4GB on-device model — Qwen3-4B / Gemma-3-4B / Phi-4-mini — installable via `prometheus model pull` / the Model Hub, account-free, license-clean, with full RAM/feasibility data. Prometheus NEVER downloads or redistributes proprietary Nano weights.",
});
