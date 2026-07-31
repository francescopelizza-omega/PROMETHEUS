/**
 * settings/schema.ts — the Studio settings shape + a lenient validator (file 09 §7.1).
 *
 * Settings are JSON. Known keys are typed; extensions contribute MORE keys via
 * `contributes.configuration` (§5.1), so the shape is OPEN (an index signature). The
 * validator sanitizes known keys (drops a known key with the wrong type) but passes
 * unknown extension keys through — strict for core, open for extensions.
 */

export interface Settings {
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
  /** extension-contributed keys (open) — also carries the `format.lang.<id>` booleans. */
  [key: string]: unknown;
}

/** The shipped defaults (lowest layer, §7.1). Per-language format flags default ON so
 *  the master toggle alone enables every language; a user opts a language OUT (APP-019). */
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  density: "comfortable",
  cloudModelsEnabled: true,
  defaultNetwork: "mcp-only",
  gateStrict: false,
  allowForce: true,
  autoApprove: false,
  telemetryEnabled: false, // §8: OFF by default — explicit, never upgraded by the validator
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
        if (typeof v === "boolean") out[key] = v;
        break;
      case "templates.user":
        // user templates persist as a JSON array (APP-020); a non-array is dropped, not
        // fatal. Per-entry validity is the renderer's job (sanitizeUserTemplates).
        if (Array.isArray(v)) out["templates.user"] = v;
        break;
      case "todoPatterns":
        // APP-096 — drop-don't-throw ELEMENT-wise: a non-array drops the key; within an array
        // a row missing a string name/regex (or a non-boolean caseSensitive) is dropped, the
        // rest kept. The renderer's compilePatterns still fail-softs any surviving-but-bad regex.
        if (Array.isArray(v)) out.todoPatterns = v.filter(isTodoPattern);
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
