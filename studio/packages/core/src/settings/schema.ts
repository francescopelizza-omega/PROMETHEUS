/**
 * settings/schema.ts — the Studio settings shape + a lenient validator (file 09 §7.1).
 *
 * Settings are JSON. Known keys are typed; extensions contribute MORE keys via
 * `contributes.configuration` (§5.1), so the shape is OPEN (an index signature). The
 * validator sanitizes known keys (drops a known key with the wrong type) but passes
 * unknown extension keys through — strict for core, open for extensions.
 */
import { type HookSpec, validateHooks } from "../agent/hooks.js";
import { type EffortTier, isEffortTier } from "../ai/effort/types.js";

export type { HookSpec };

export interface Settings extends ExternalToolSettings, RemoteHostSettings, LanguageSettings {
  /** active profile id (§7.1). */
  profileId?: string;
  /** scheme id, or "system" to follow the OS (file 08 §6). */
  theme?: string;
  density?: "comfortable" | "compact";
  /** cloud models allowed (Local-only profile disables this). */
  cloudModelsEnabled?: boolean;
  /** default agent/extension egress policy (file 09 §4.4/§5). */
  defaultNetwork?: "none" | "mcp-only" | "allow";
  /** run nemesis with --strict (warn→block) — Security-strict profile. */
  gateStrict?: boolean;
  /** allow the deep-red --force override at all — Security-strict turns this off. */
  allowForce?: boolean;
  /** allow read-only tools to auto-approve — Security-strict turns this off. */
  autoApprove?: boolean;
  /** opt-in scrubbed-upload telemetry — OFF by default, never silently flipped (file 10 §8). */
  telemetryEnabled?: boolean;
  /** auto-update release channel (file 10 §5). */
  updateChannel?: "latest" | "beta" | "alpha";
  /** format-on-save master + organize-imports-on-save (APP-019); per-language flags
   *  live at `format.lang.<id>` and arrive via the open index signature below. */
  "format.onSave"?: boolean;
  "format.optimizeImportsOnSave"?: boolean;
  /** user-authored live/postfix/surround templates (APP-020) — a JSON array of
   *  LiveTemplateDef; bodies can carry `$`, backticks and newlines, so JSON (not a
   *  shell/env round-trip) is the only safe serialization. Validated as an array here;
   *  per-template validity is enforced by the renderer's `sanitizeUserTemplates`. */
  "templates.user"?: unknown[];
  /** user-configurable TODO marker patterns (APP-096) — beyond the builtin four. A RegExp is
   *  not JSON-serializable, so each carries a `regex` SOURCE string recompiled by the renderer;
   *  `caseSensitive:false` compiles with the `i` flag. Sanitized element-wise below (a single
   *  bad row drops that row, not the array), consistent with the lenient validator contract. */
  todoPatterns?: { name: string; regex: string; caseSensitive?: boolean }[];
  /**
   * SPEND CAPS for metered (cloud) turns — the desktop's half of the CLI's profile
   * `[budget]` table.
   *
   * These exist because the cap was previously a LABEL in the GUI: `AgentPane` rendered a
   * `SpendMeter` with a `capUsd` read from localStorage and nothing anywhere consulted it, so
   * an "auto-disable at cap" caption sat above a turn that would happily keep spending. The
   * CLI has enforced `session_usd`/`daily_usd` from its profile TOML for a while; settings is
   * where the desktop can read the same numbers, so both hosts refuse on the same rule.
   *
   * Absent (or both windows absent) ⇒ NO cap, and the accounting store is never even read —
   * the zero-config behaviour is unchanged.
   */
  "budget.sessionUsd"?: number;
  "budget.dailyUsd"?: number;
  /** warn once per window when spend crosses this % of a cap (default 80). */
  "budget.warnAtPercent"?: number;
  /**
   * What to do when a metered model has NO price entry: `"block"` (fail-closed, the default)
   * or `"warn"`. Most cloud providers have no price row, and counting an unpriced record as
   * $0 is what makes a cap silently inapplicable — see `budgetWindows.BudgetConfig`.
   */
  "budget.unpricedPolicy"?: "block" | "warn";
  /**
   * The reasoning-effort tier a session starts at — the `/think` ladder, shared with the CLI's
   * `[agent] effort`.
   *
   * Absent ⇒ the session starts UNSET, which is not the same as `"off"`: unset means no tier
   * was chosen, and the composer badge reads the model's own default rather than claiming one.
   */
  "ai.effort"?: EffortTier;
  /**
   * Send the effort knob even when `ai/effort/rules.ts` says this model has none.
   *
   * OFF by default. It re-opens exactly the failure that table exists to close — a forwarded
   * `reasoning_effort` is a hard 400 on a GPT-4-class model, not a no-op — so it is an explicit
   * choice for a model released after those rules were written, and every resolution it
   * produces is marked `degraded.reason: "forced"`.
   */
  "ai.effortForce"?: boolean;
  /**
   * LIFECYCLE HOOKS — user-authored shell commands bound to `PreToolUse` / `PostToolUse` /
   * `SessionStart` (see `agent/hooks.ts` for the semantics and the fail-soft contract).
   *
   * Settings-only, never a tool argument: the agent can neither author a hook nor reach this
   * key, which is what makes a PreToolUse veto meaningful rather than advisory.
   *
   * Sanitized ELEMENT-wise below (a malformed row drops that row, not every hook the user
   * configured) — the same lenient contract `todoPatterns` uses.
   */
  hooks?: HookSpec[];
  /**
   * Remember this project's top-20 most-used "@"-completed paths (by the CLI's `/tab-complete`
   * and the desktop's "@"-mention pickers alike) to rank them ahead of a plain fuzzy match —
   * OFF by default, same "never silently flipped" posture as `telemetryEnabled`.
   */
  "completion.pathFrecency"?: boolean;
  /** extension-contributed keys (open) — also carries the `format.lang.<id>` booleans. */
  [key: string]: unknown;
}

/** The shipped defaults (lowest layer, §7.1). Per-language format flags default ON so
 *  the master toggle alone enables every language; a user opts a language OUT (APP-019). */
/**
 * Per-tool defaults for the external tools (`agent/host-tools.ts`), FLAT dotted keys rather
 * than a nested `tools: { externalTools: {…} }` blob.
 *
 * Flat on purpose: the CLI's `saveSettings` in `apps/cli/src/home.ts` is a shallow
 * `{...loadSettings(), ...patch}` that rewrites the whole file, so writing one key of a nested
 * object from the terminal would silently drop its siblings.
 */
export interface ExternalToolSettings {
  "tools.externalTools.imageFormat"?: "png" | "jpg" | "webp";
  "tools.externalTools.imageQuality"?: number;
  "tools.externalTools.imageResizeFilter"?: "Lanczos" | "Mitchell" | "Triangle" | "Point";
  "tools.externalTools.pdfDpi"?: number;
  "tools.externalTools.ocrLang"?: string;
  "tools.externalTools.videoContainer"?: "mp4" | "mkv" | "webm";
  "tools.externalTools.videoMaxHeight"?: number;
  "tools.externalTools.ytdlpFormat"?: string;
}

/**
 * Self-hosted model servers on other machines (`ai/remote-hosts.ts`).
 *
 * Stored as a JSON string rather than a nested object for the same reason the external-tool
 * defaults are flat keys: the CLI's `saveSettings` is a shallow merge that rewrites the whole
 * file, so a nested structure written from the terminal would drop its siblings.
 */
export interface RemoteHostSettings {
  /** JSON array of `RemoteHost`. Empty/absent means no remote host is trusted. */
  "models.remoteHosts"?: string;
}

/**
 * The language PROMETHEUS speaks (`i18n/`).
 *
 * ABSENT IS MEANINGFUL and is not the same as `"en"`. Absent means "never asked", which is what
 * triggers the first-run language question; `"en"` means the user was asked and chose English.
 * Collapsing the two would re-ask an English speaker on every launch, or — worse — silently
 * adopt `$LANG` for someone who had deliberately chosen otherwise.
 *
 * `resolveLocale` consults the environment only when this is absent, and a value it does not
 * recognise is ignored rather than trusted: the settings file is hand-editable.
 */
export interface LanguageSettings {
  /** An i18n `Locale` code — "en", "it", "fr", "es", "de", "pt", "nl", "pl". */
  "ui.language"?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  density: "comfortable",
  cloudModelsEnabled: true,
  defaultNetwork: "mcp-only",
  gateStrict: false,
  allowForce: true,
  /**
   * TRUE by default, matching what the authorisation ladder actually does.
   *
   * The shipped default was `false` while the ladder's own default level (A1, "Auto-approve
   * reads/scans; ask before every change — the safe default") auto-approves reads. The
   * contradiction was invisible because NOTHING read this key: it was declared, defaulted,
   * validated and set by the Security-strict profile, and never consulted. Translating it into
   * the posture with the old default would have clamped every user to "ask before every action",
   * which is not what any of them chose. `true` here means "the ladder decides", and an explicit
   * `false` — which is what Security-strict sets — now genuinely means no auto-approval.
   */
  autoApprove: true,
  telemetryEnabled: false, // §8: OFF by default — explicit, never upgraded by the validator
  "completion.pathFrecency": false, // OFF by default — explicit, never upgraded by the validator
  updateChannel: "latest",
  "format.onSave": false,
  "format.optimizeImportsOnSave": false,
  "format.lang.python": true,
  "format.lang.typescript": true,
  "format.lang.javascript": true,
  "format.lang.json": true,
  "format.lang.rust": true,
  "format.lang.go": true,
  "templates.user": [], // APP-020 — user live/postfix/surround templates (empty by default)
  // APP-096 — the four historical builtin markers as SEPARATE patterns (not one alternation)
  // so the TODO panel's search prefilter derives a needle per marker (fixes the HACK/XXX miss).
  todoPatterns: [
    { name: "TODO", regex: "\\bTODO\\b" },
    { name: "FIXME", regex: "\\bFIXME\\b" },
    { name: "HACK", regex: "\\bHACK\\b" },
    { name: "XXX", regex: "\\bXXX\\b" },
  ],
};

const DENSITY = new Set(["comfortable", "compact"]);
const NETWORK = new Set(["none", "mcp-only", "allow"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A well-formed persisted TODO pattern row (APP-096): string name + string regex, and an
 *  optional boolean caseSensitive. Used to filter a `todoPatterns` array element-wise. */
function isTodoPattern(v: unknown): v is { name: string; regex: string; caseSensitive?: boolean } {
  return (
    isRecord(v) &&
    typeof v.name === "string" &&
    typeof v.regex === "string" &&
    (v.caseSensitive === undefined || typeof v.caseSensitive === "boolean")
  );
}

/**
 * Sanitize a parsed object into Settings: known keys are type-checked (a bad value
 * is DROPPED, not fatal); unknown (extension) keys pass through untouched. A
 * non-object input yields {} (never throws).
 */
export function validateSettings(value: unknown): Settings {
  if (!isRecord(value)) return {};
  const out: Settings = {};
  for (const [key, v] of Object.entries(value)) {
    switch (key) {
      case "profileId":
      case "theme":
        if (typeof v === "string") out[key] = v;
        break;
      case "density":
        if (typeof v === "string" && DENSITY.has(v)) out.density = v as Settings["density"];
        break;
      case "defaultNetwork":
        if (typeof v === "string" && NETWORK.has(v))
          out.defaultNetwork = v as Settings["defaultNetwork"];
        break;
      case "updateChannel":
        if (v === "latest" || v === "beta" || v === "alpha") out.updateChannel = v;
        break;
      case "cloudModelsEnabled":
      case "gateStrict":
      case "allowForce":
      case "autoApprove":
      case "telemetryEnabled":
      case "completion.pathFrecency":
        if (typeof v === "boolean") out[key] = v;
        break;
      case "templates.user":
        // user templates persist as a JSON array (APP-020); a non-array is dropped, not
        // fatal. Per-entry validity is the renderer's job (sanitizeUserTemplates).
        if (Array.isArray(v)) out["templates.user"] = v;
        break;
      case "budget.sessionUsd":
      case "budget.dailyUsd":
      case "budget.warnAtPercent":
        /**
         * A cap must be a finite, non-negative number or it is DROPPED — never coerced.
         *
         * Coercing here would be the dangerous direction: `"budget.dailyUsd": "ten"` becoming
         * `NaN` makes every comparison false, so the cap silently stops applying while the
         * settings file still reads as though it is set. Dropping the key means the gate sees
         * "no cap configured", which at least matches what is actually being enforced.
         */
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
        break;
      case "budget.unpricedPolicy":
        if (v === "block" || v === "warn") out["budget.unpricedPolicy"] = v;
        break;
      case "ai.effort":
        // Validated against the ladder: a typo'd tier that survived as a bare string would
        // fail every comparison downstream while the settings file still read as configured.
        //
        // `isEffortTier`, not a chain of `===`. The chain WAS the ladder spelled a second time,
        // so it silently rejected `xhigh` and `ultra` the moment the real one grew them.
        if (isEffortTier(v)) out["ai.effort"] = v;
        break;
      case "ai.effortForce":
        if (typeof v === "boolean") out["ai.effortForce"] = v;
        break;
      case "todoPatterns":
        // APP-096 — drop-don't-throw ELEMENT-wise: a non-array drops the key; within an array
        // a row missing a string name/regex (or a non-boolean caseSensitive) is dropped, the
        // rest kept. The renderer's compilePatterns still fail-softs any surviving-but-bad regex.
        if (Array.isArray(v)) out.todoPatterns = v.filter(isTodoPattern);
        break;
      case "hooks":
        /**
         * Element-wise, same as todoPatterns. A row with an unknown `event` or an empty
         * `command` is DROPPED rather than fatal — the alternative (throwing) would make a
         * single typo in a settings file brick every session that reads it, and hooks are
         * exactly the sort of key people hand-edit.
         */
        out.hooks = validateHooks(v);
        break;
      default:
        // format-on-save keys are strictly boolean (a corrupt value is dropped, not
        // leaked); other unknown (extension) keys pass through untouched (APP-019).
        if (key.startsWith("format.")) {
          if (typeof v === "boolean") out[key] = v;
        } else {
          out[key] = v; // extension-contributed key: pass through
        }
    }
  }
  return out;
}
