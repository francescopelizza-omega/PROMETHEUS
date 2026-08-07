/**
 * cli-profiles/schema.ts — the typed CONFIG schema + validation (CLI-045). PURE (no fs).
 *
 * `config.toml` (the S005 user config) is validated against this registry: an unknown key WARNS
 * (with the nearest valid key suggested) but is PRESERVED on disk for forward-compat; a KNOWN key
 * set to the wrong runtime type is a hard ERROR (refused at `set`, exit 2). Keys are ground-truthed
 * from real config reads across the codebase — today only `profile.active` (CLI-044) is consumed;
 * the registry is the single source the CLI `config list`/`set` and (later) the GUI settings tree
 * both read, so a new key is added HERE, once.
 */
import type { TomlTable, TomlValue } from "./toml.js";

export type ConfigType = "string" | "number" | "boolean" | "string[]";

export interface ConfigKeySpec {
  type: ConfigType;
  default: TomlValue;
  description: string;
}

/** Every KNOWN config key (dotted path → typed spec). Insertion order drives `config list` order. */
export const CONFIG_SCHEMA: Readonly<Record<string, ConfigKeySpec>> = {
  "profile.active": {
    type: "string",
    default: "",
    description: "The active profile name applied at startup (set by `prometheus profile use`).",
  },
};

/** The runtime type of a parsed TOML value (arrays of strings / empty arrays → "string[]"). */
export function valueType(v: TomlValue | undefined): ConfigType | "unknown" {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (Array.isArray(v)) {
    return v.every((x) => typeof x === "string") ? "string[]" : "unknown"; // [] is a valid string[]
  }
  return "unknown"; // a nested table is not a leaf value
}

/** Flatten a parsed config table into [dottedKey, leafValue] pairs (tables recurse; leaves emit). */
export function flattenConfig(table: TomlTable, prefix = ""): [string, TomlValue][] {
  const out: [string, TomlValue][] = [];
  for (const [k, v] of Object.entries(table)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenConfig(v as TomlTable, key));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

/** Levenshtein edit distance (iterative, O(n·m)) — for the "did you mean" suggestion. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] ?? 0;
}

/**
 * The nearest known key to `key`, or undefined when nothing is close enough. Compares the FLAT
 * dotted key (so `profile.activ`→`profile.active` scores 1) and caps the suggestion at edit
 * distance ≤ min(3, 40% of the key length) so an unrelated typo surfaces NO bogus "did you mean".
 */
export function nearestKey(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const k of known) {
    const d = levenshtein(key, k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best === undefined) return undefined;
  const cap = Math.max(1, Math.min(3, Math.floor(key.length * 0.4)));
  return bestD <= cap ? best : undefined;
}

export interface ConfigIssue {
  key: string;
  message: string;
}
export interface ConfigValidation {
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

/**
 * Validate a parsed config table against the schema. Unknown key → WARNING (+ nearest-key
 * suggestion); known key with the wrong runtime type → ERROR (naming expected vs actual). Never
 * throws; never mutates the table (the parser stays fail-soft, this is a separate pass).
 */
export function validateConfig(table: TomlTable): ConfigValidation {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const known = Object.keys(CONFIG_SCHEMA);
  for (const [key, value] of flattenConfig(table)) {
    const spec = CONFIG_SCHEMA[key];
    if (!spec) {
      const near = nearestKey(key, known);
      warnings.push({
        key,
        message: `unknown config key "${key}"${near ? ` — did you mean "${near}"?` : ""}`,
      });
      continue;
    }
    const actual = valueType(value);
    if (actual !== spec.type) {
      errors.push({ key, message: `key "${key}" expects ${spec.type}, got ${actual}` });
    }
  }
  return { errors, warnings };
}

export interface EffectiveEntry {
  key: string;
  value: TomlValue;
  source: "default" | "user";
}

/**
 * The effective merged config: every schema key (schema default unless the user set it), in schema
 * insertion order, then any unknown user keys appended sorted (each `source:"user"`). Stable order
 * so `--json` never churns between runs.
 */
export function effectiveConfig(user: TomlTable): EffectiveEntry[] {
  const out: EffectiveEntry[] = [];
  const userFlat = new Map(flattenConfig(user));
  for (const [key, spec] of Object.entries(CONFIG_SCHEMA)) {
    if (userFlat.has(key)) {
      out.push({ key, value: userFlat.get(key) as TomlValue, source: "user" });
      userFlat.delete(key);
    } else {
      out.push({ key, value: spec.default, source: "default" });
    }
  }
  for (const key of [...userFlat.keys()].sort()) {
    out.push({ key, value: userFlat.get(key) as TomlValue, source: "user" });
  }
  return out;
}
